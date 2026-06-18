require('dotenv').config();
const RobinhoodClient = require('./lib/robinhood');
const { decide } = require('./lib/agent');

const DRY_RUN = process.env.DRY_RUN !== 'false';
const SYMBOLS = (process.env.SYMBOLS || 'BTC,ETH,DOGE,SOL').split(',');
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000');
const HISTORY_LEN = 10; // ticks to keep for momentum calc

const config = {
  maxPositionUsd: parseFloat(process.env.MAX_POSITION_USD || '100'),
  takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || '1.5'),
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || '0.5'),
};

const IS_BACKTEST = process.argv.includes('--backtest');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function runBacktest() {
  log('Running backtest with synthetic price data...');
  const results = { trades: 0, wins: 0, losses: 0, pnl: 0 };

  // Simulate 50 ticks of BTC prices around $65k with noise
  const fakePrices = Array.from({ length: 50 }, (_, i) => {
    const trend = Math.sin(i / 5) * 200;
    const noise = (Math.random() - 0.5) * 100;
    return 65000 + trend + noise;
  });

  let cash = 1000;
  let position = null;

  for (let i = HISTORY_LEN; i < fakePrices.length; i++) {
    const history = fakePrices.slice(i - HISTORY_LEN, i);
    const price = fakePrices[i];
    const movePct = ((price - history[0]) / history[0]) * 100;

    if (!position && movePct > 0.5 && cash >= config.maxPositionUsd) {
      position = { price, size: config.maxPositionUsd };
      cash -= config.maxPositionUsd;
      results.trades++;
      log(`  [BUY]  BTC @ $${price.toFixed(2)} (momentum ${movePct.toFixed(2)}%)`);
    } else if (position) {
      const pnlPct = ((price - position.price) / position.price) * 100;
      if (pnlPct >= config.takeProfitPct || pnlPct <= -config.stopLossPct) {
        const pnl = position.size * (pnlPct / 100);
        cash += position.size + pnl;
        results.pnl += pnl;
        pnlPct > 0 ? results.wins++ : results.losses++;
        log(`  [${pnlPct > 0 ? 'WIN' : 'LOSS'}] BTC @ $${price.toFixed(2)} | P&L: $${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`);
        position = null;
      }
    }
  }

  log(`\nBacktest complete — ${results.trades} trades | ${results.wins}W / ${results.losses}L | Net P&L: $${results.pnl.toFixed(2)}`);
  return results;
}

async function runLive() {
  if (!process.env.RH_ACCESS_TOKEN) {
    console.error('RH_ACCESS_TOKEN not set. Copy it from the Authorization header on robinhood.com');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set.');
    process.exit(1);
  }

  const rh = new RobinhoodClient(process.env.RH_ACCESS_TOKEN);
  const priceHistory = Object.fromEntries(SYMBOLS.map(s => [s, []]));

  log(`Starting agentic crypto scalper — symbols: ${SYMBOLS.join(', ')} | ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  async function tick() {
    try {
      const [prices, portfolio, holdings] = await Promise.all([
        rh.getCryptoPrices(SYMBOLS),
        rh.getPortfolio(),
        rh.getCryptoHoldings(),
      ]);

      for (const sym of SYMBOLS) {
        if (prices[sym]) {
          priceHistory[sym].push(prices[sym].price);
          if (priceHistory[sym].length > HISTORY_LEN) priceHistory[sym].shift();
        }
      }

      // Need at least 3 ticks before trading
      const minHistory = Math.min(...SYMBOLS.map(s => priceHistory[s].length));
      if (minHistory < 3) {
        log(`Warming up (${minHistory}/${HISTORY_LEN} ticks)...`);
        return;
      }

      const { action, params } = await decide({ prices, priceHistory, portfolio, holdings, config });

      if (action === 'hold') {
        log(`HOLD — ${params.reason}`);
        return;
      }

      const side = action; // 'buy' or 'sell'
      log(`${side.toUpperCase()} ${params.symbol} $${params.amount_usd} — ${params.reason}`);

      if (!DRY_RUN) {
        const order = await rh.placeCryptoOrder({
          symbol: params.symbol,
          side,
          amountUsd: params.amount_usd,
        });
        log(`Order placed: ${order.id}`);
      } else {
        log('(dry run — order not sent)');
      }
    } catch (err) {
      log(`ERROR: ${err.message}`);
    }
  }

  await tick();
  setInterval(tick, POLL_MS);
}

if (IS_BACKTEST) {
  runBacktest().catch(console.error);
} else {
  runLive().catch(console.error);
}
