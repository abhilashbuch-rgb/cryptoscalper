const { db, FieldValue } = require('./firebase-config');

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

// Minimum basket sum violation to consider (3% edge)
const DEFAULT_HURDLE = 1.03;
// Minimum balance to operate
const MIN_BALANCE = 500;
// Max per-leg size in USD
const DEFAULT_LEG_SIZE = 50;
// Max portfolio % per position
const MAX_POSITION_PCT = 0.10;
// Drawdown circuit breaker threshold
const DRAWDOWN_BREAKER = 0.05;

class PolymarketAlphaEngine {
  constructor(userId, opts = {}) {
    this.userId = userId;
    this.userRef = db.collection('users').doc(userId);
    this.hurdleRate = opts.hurdleRate || DEFAULT_HURDLE;
    this.legSize = opts.legSize || DEFAULT_LEG_SIZE;
    this.mode = opts.mode || 'sandbox';
  }

  async runArbitrageScan() {
    const telemetryRef = this.userRef.collection('telemetry').doc('polymarket');

    try {
      await telemetryRef.set({
        lastScanTimestamp: FieldValue.serverTimestamp(),
        status: 'SCANNING',
      }, { merge: true });

      const brackets = await this.fetchActiveNegRiskBrackets();
      const opportunities = [];

      for (const bracket of brackets) {
        const totalBasketCost = bracket.tokens.reduce((sum, t) => sum + t.currentYesPrice, 0);

        if (totalBasketCost > this.hurdleRate) {
          const edge = totalBasketCost - 1.00;
          const noCost = bracket.tokens.reduce((sum, t) => sum + (1 - t.currentYesPrice), 0);
          const profit = 1.00 - noCost;

          opportunities.push({
            bracket,
            basketSum: totalBasketCost,
            edge,
            edgePct: (edge * 100).toFixed(2),
            noCost,
            profit,
            profitPct: ((profit / noCost) * 100).toFixed(2),
            action: 'EXECUTE',
          });
        }
      }

      opportunities.sort((a, b) => b.edge - a.edge);

      await telemetryRef.set({
        lastScanTimestamp: FieldValue.serverTimestamp(),
        status: opportunities.length > 0 ? 'OPPORTUNITIES_FOUND' : 'NO_EDGE',
        bracketsScanned: brackets.length,
        opportunitiesFound: opportunities.length,
        bestEdge: opportunities[0]?.edgePct || '0',
      }, { merge: true });

      return {
        scanned: brackets.length,
        opportunities,
        timestamp: Date.now(),
      };

    } catch (err) {
      await telemetryRef.set({
        status: 'ERROR',
        lastError: err.message,
        lastScanTimestamp: FieldValue.serverTimestamp(),
      }, { merge: true });
      throw err;
    }
  }

  async executeBracketArbitrage(bracket, legSize) {
    const size = legSize || this.legSize;
    const results = [];

    for (const token of bracket.tokens) {
      const order = {
        tokenID: token.noTokenId,
        amount: size,
        side: 'BUY',
        type: 'MARKET',
      };

      if (this.mode === 'sandbox') {
        results.push({
          token: token.slug,
          side: 'BUY_NO',
          amount: size,
          simulated: true,
          price: 1 - token.currentYesPrice,
        });
      } else {
        results.push({
          token: token.slug,
          side: 'BUY_NO',
          amount: size,
          order,
          pending: true,
        });
      }
    }

    await this.userRef.collection('polymarket_history').add({
      bracketTitle: bracket.title,
      bracketId: bracket.id,
      legs: results.length,
      legSize: size,
      totalDeployed: results.length * size,
      basketSum: bracket.tokens.reduce((s, t) => s + t.currentYesPrice, 0),
      edge: bracket.tokens.reduce((s, t) => s + t.currentYesPrice, 0) - 1.00,
      mode: this.mode,
      timestamp: FieldValue.serverTimestamp(),
    });

    return results;
  }

  async fetchActiveNegRiskBrackets() {
    const res = await fetch(`${GAMMA_API}/events?active=true&closed=false&limit=25`, {
      signal: AbortSignal.timeout(8000),
    });
    const events = await res.json();

    const brackets = [];
    for (const ev of events) {
      if (!ev.markets || ev.markets.length < 2) continue;

      const tokens = ev.markets
        .filter(m => m.clobTokenIds && m.clobTokenIds.length >= 2 && m.outcomePrices)
        .map(m => ({
          slug: m.conditionId || m.slug || m.question,
          questionSlug: m.slug,
          yesTokenId: m.clobTokenIds[0],
          noTokenId: m.clobTokenIds[1],
          currentYesPrice: parseFloat(m.outcomePrices[0] || 0),
          currentNoPrice: parseFloat(m.outcomePrices[1] || 0),
          volume: parseFloat(m.volume || 0),
          question: m.question,
        }));

      if (tokens.length >= 2) {
        brackets.push({
          title: ev.title,
          id: ev.id,
          slug: ev.slug,
          tokens,
          totalVolume: tokens.reduce((s, t) => s + t.volume, 0),
        });
      }
    }

    return brackets;
  }

  async getPerformanceMetrics() {
    try {
      const histSnap = await this.userRef.collection('polymarket_history')
        .orderBy('timestamp', 'desc').limit(50).get();

      const trades = histSnap.docs.map(d => d.data());
      const totalTrades = trades.length;
      const totalDeployed = trades.reduce((s, t) => s + (t.totalDeployed || 0), 0);
      const avgEdge = trades.length > 0
        ? trades.reduce((s, t) => s + (t.edge || 0), 0) / trades.length
        : 0;

      return {
        totalTrades,
        totalDeployed,
        avgEdge: (avgEdge * 100).toFixed(2),
        mode: this.mode,
      };
    } catch {
      return { totalTrades: 0, totalDeployed: 0, avgEdge: '0', mode: this.mode };
    }
  }
}

module.exports = { PolymarketAlphaEngine, DEFAULT_HURDLE, MIN_BALANCE };
