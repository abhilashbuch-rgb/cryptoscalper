const Anthropic = require('@anthropic-ai/sdk');
const { db, FieldValue } = require('./firebase-config');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const RISK_DESK_PROMPT = `## ROLE
You are the High-Agency Risk Desk and Portfolio Allocator for a high-frequency event-derivatives trading firm. Your objective is capital preservation and maximizing asymmetric returns on Negative Risk (NegRisk) structural arbitrage.

You do not execute trades in real-time. Instead, you sit asynchronous to the execution loop, performing macro scanning, risk sizing parameters, and dynamic market selection.

---

## ARCHITECTURAL BOUNDARIES
* **The Hot Path (0ms AI Latency):** Local server code executes structural arbitrage (Token_A + Token_B < $0.95) instantly via pure math. You never interfere with this loop.
* **The Warm Path (Your Domain):** You analyze incoming raw Gamma API dumps, macro sentiment, news alerts (e.g., ESPN feeds), and current capital balances to adjust the boundaries of what the Hot Path is allowed to trade.

---

## CORE MANDATES & LOGIC

### 1. Liquid Market Whitelisting (The "Hot-Watch" List)
Analyze the broad market dumps provided. Group and filter markets down to a refined "Hot-Watch" array of conditionIds for the local script to poll.
* **Criteria:** Volume > $50k, tight bid-ask spreads (< 2.5%), and structural complexity (multi-outcome brackets where NegRisk is mathematically probable).
* **Output:** A clean JSON array of approved IDs.

### 2. Contextual Risk Sizing (The Shock Absorber)
When a live news flash (e.g., severe injury report via ESPN API, sudden political dropout) intersects with an active market, determine if the risk profile has fundamentally altered.
* If a market becomes highly volatile/unpredictable, output instructions to **reduce maximum position size** or **temporarily blacklist** the asset to prevent getting caught on the wrong side of an order-book sweep.
* If conditions are highly stable and predictable, authorize **aggressive capital sizing** to exploit the arbitrage gap fully.

### 3. Collateral & Capital Allocation Guardrails
Prevent internal capital collision. Monitor current free pUSD collateral balances across multiple active brackets. If collateral drops below critical thresholds, rank active markets by velocity and output clear instructions on which brackets to prioritize or halt.

---

## OUTPUT PROTOCOL
You must output ONLY raw JSON with no wrapping prose, no conversational explanation, and no markdown formatting blocks. Follow this exact schema:

{
  "timestamp": <unix_seconds>,
  "action": "UPDATE_RISK_BOUNDARIES",
  "system_level": "NORMAL" | "CAUTION" | "HALT",
  "hot_watch_add": ["conditionId1", "conditionId2"],
  "hot_watch_remove": ["conditionId3"],
  "blacklist": ["conditionId4"],
  "max_allocation_pusd": 2500,
  "risk_multiplier": 1.0,
  "max_leg_size_pusd": 50,
  "reasoning_brief": "One sentence explaining the adjustment."
}`;

const riskBoundariesRef = db.collection('config').doc('risk_boundaries');

async function evaluateRiskBoundaries(payload) {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: RISK_DESK_PROMPT,
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
  });

  const text = msg.content.find(b => b.type === 'text')?.text || '';

  try {
    return JSON.parse(text);
  } catch {
    return {
      timestamp: Math.floor(Date.now() / 1000),
      action: 'UPDATE_RISK_BOUNDARIES',
      system_level: 'CAUTION',
      hot_watch_add: [],
      hot_watch_remove: [],
      blacklist: [],
      max_allocation_pusd: 2500,
      risk_multiplier: 1.0,
      max_leg_size_pusd: 50,
      reasoning_brief: 'Failed to parse risk desk response, reverting to conservative defaults.',
    };
  }
}

async function runRiskDeskCycle(markets, sports, headlines, walletBalance) {
  const payload = {
    walletBalance,
    activeMarkets: markets.map(m => ({
      id: m.id || m.conditionId,
      question: m.question,
      volume: parseFloat(m.volume || 0),
      outcomePrices: (m.outcomePrices || []).map(Number),
      spread: m.spread || null,
      outcomes: m.outcomes?.length || (m.outcomePrices || []).length,
    })),
    liveNews: headlines.slice(0, 8),
    liveSports: sports.filter(s => !s.decided).slice(0, 10),
    currentTimestamp: Math.floor(Date.now() / 1000),
  };

  const boundaries = await evaluateRiskBoundaries(payload);

  await riskBoundariesRef.set({
    ...boundaries,
    updatedAt: FieldValue.serverTimestamp(),
  });

  console.log(`[RISK DESK] ${boundaries.system_level} | multiplier=${boundaries.risk_multiplier} | max_leg=${boundaries.max_leg_size_pusd} | watch+${boundaries.hot_watch_add.length} -${boundaries.hot_watch_remove.length} | blacklist=${boundaries.blacklist.length}`);

  return boundaries;
}

async function getRiskBoundaries() {
  const doc = await riskBoundariesRef.get();
  if (!doc.exists) {
    return {
      system_level: 'NORMAL',
      hot_watch_add: [],
      hot_watch_remove: [],
      blacklist: [],
      max_allocation_pusd: 2500,
      risk_multiplier: 1.0,
      max_leg_size_pusd: 50,
    };
  }
  return doc.data();
}

module.exports = { evaluateRiskBoundaries, runRiskDeskCycle, getRiskBoundaries, RISK_DESK_PROMPT };
