const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TOOLS = [
  {
    name: 'buy',
    description: 'Place a market buy order for a crypto asset',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'e.g. BTC, ETH, DOGE' },
        amount_usd: { type: 'number', description: 'Dollar amount to spend' },
        reason: { type: 'string', description: 'Brief rationale' },
      },
      required: ['symbol', 'amount_usd', 'reason'],
    },
  },
  {
    name: 'sell',
    description: 'Place a market sell order for a crypto asset',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'e.g. BTC, ETH, DOGE' },
        amount_usd: { type: 'number', description: 'Dollar value to sell' },
        reason: { type: 'string', description: 'Brief rationale' },
      },
      required: ['symbol', 'amount_usd', 'reason'],
    },
  },
  {
    name: 'hold',
    description: 'Skip this cycle — no trade',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why holding' },
      },
      required: ['reason'],
    },
  },
];

async function decide({ prices, priceHistory, portfolio, holdings, config }) {
  const holdingsSummary = holdings.map(h => {
    const currentPrice = prices[h.symbol]?.price || 0;
    const currentValue = h.quantity * currentPrice;
    const pnlPct = h.costBasis > 0
      ? ((currentValue - h.costBasis) / h.costBasis) * 100
      : 0;
    return { ...h, currentValue: currentValue.toFixed(2), pnlPct: pnlPct.toFixed(2) };
  });

  const prompt = `You are an aggressive crypto scalper. Make a single trading decision RIGHT NOW.

## Current Prices
${Object.entries(prices).map(([sym, d]) => `${sym}: $${d.price} (bid $${d.bid}, ask $${d.ask})`).join('\n')}

## Price History (last ${Object.values(priceHistory)[0]?.length || 0} ticks, newest last)
${Object.entries(priceHistory).map(([sym, h]) => {
  const pct = h.length > 1 ? (((h[h.length-1] - h[0]) / h[0]) * 100).toFixed(2) : '0.00';
  return `${sym}: [${h.map(p => p.toFixed(2)).join(', ')}] → ${pct}% move`;
}).join('\n')}

## Portfolio
Cash: $${portfolio.cash.toFixed(2)}
Holdings: ${holdingsSummary.length === 0 ? 'none' : JSON.stringify(holdingsSummary, null, 2)}

## Rules
- Max position size: $${config.maxPositionUsd}
- Take profit: ${config.takeProfitPct}% gain
- Stop loss: ${config.stopLossPct}% drawdown
- Only trade coins with clear short-term momentum (>0.5% move in recent ticks)
- Sell any position that hit take-profit or stop-loss
- Never go below $10 cash reserve

Call exactly one tool: buy, sell, or hold.`;

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 512,
    tools: TOOLS,
    tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: prompt }],
  });

  const toolUse = response.content.find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('Agent returned no tool call');
  return { action: toolUse.name, params: toolUse.input };
}

module.exports = { decide };
