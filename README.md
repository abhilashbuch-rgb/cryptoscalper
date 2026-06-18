# CryptoScalper

Agentic 24/7 crypto scalping bot powered by Claude AI + Robinhood.

Claude analyzes price momentum every 30 seconds and decides whether to buy, sell, or hold. Paper trading mode is on by default — no real money moves until you explicitly opt in.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env — add your ANTHROPIC_API_KEY and RH_ACCESS_TOKEN
```

### Getting your Robinhood token

1. Log into [robinhood.com](https://robinhood.com) in a browser
2. Open DevTools → Network tab
3. Filter for `api.robinhood.com`
4. Copy the `Authorization: Bearer <token>` header value from any request
5. Paste the token (without "Bearer ") into `RH_ACCESS_TOKEN` in `.env`

## Usage

```bash
# Backtest (synthetic data, no credentials needed)
node trader.js --backtest

# Paper trading (live prices, no real orders)
node trader.js

# Live trading
DRY_RUN=false node trader.js
```

## Config (`.env`)

| Variable | Default | Description |
|---|---|---|
| `DRY_RUN` | `true` | Paper trade mode |
| `SYMBOLS` | `BTC,ETH,DOGE,SOL` | Coins to watch |
| `POLL_INTERVAL_MS` | `30000` | Price check interval |
| `MAX_POSITION_USD` | `100` | Max $ per trade |
| `TAKE_PROFIT_PCT` | `1.5` | Exit at +1.5% |
| `STOP_LOSS_PCT` | `0.5` | Exit at -0.5% |

## Strategy

Claude receives the last 10 price ticks for each symbol and current portfolio state. It decides to:
- **Buy** when a coin shows >0.5% momentum in recent ticks and cash is available
- **Sell** any position that hits take-profit or stop-loss
- **Hold** when there's no clear signal

## Warning

Crypto trading carries significant risk. Always paper trade first and understand the strategy before enabling live trading.
