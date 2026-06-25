const { db, FieldValue } = require('./firebase-config');
const { PolymarketAlphaEngine, MIN_BALANCE } = require('./polymarket-alpha');
const { evaluateArbitrage, buildMarketPayload } = require('./research-desk');

class PolymarketV2Engine {
  constructor(userId) {
    this.userId = userId;
    this.alphaEngine = new PolymarketAlphaEngine(userId, { mode: 'live' });
    this.userRef = db.collection('users').doc(userId);
    this.telemetryRef = this.userRef.collection('telemetry').doc('polymarket');
  }

  async getWalletBalance() {
    const doc = await this.userRef.collection('config').doc('polymarket_preset').get();
    const config = doc.exists ? doc.data() : {};
    return config.walletBalance || 0;
  }

  async executePurePolymarketCycle() {
    const cycleStart = Date.now();

    await this.telemetryRef.set({
      lastCycleStart: FieldValue.serverTimestamp(),
      status: 'SCANNING',
    }, { merge: true });

    const brackets = await this.alphaEngine.fetchActiveNegRiskBrackets();
    const walletBalance = await this.getWalletBalance();

    if (walletBalance < MIN_BALANCE) {
      console.log(`[V2 ENGINE] CRITICAL_STANDBY — Balance ${walletBalance} pUSD below ${MIN_BALANCE} floor`);
      await this.telemetryRef.set({
        status: 'CRITICAL_STANDBY',
        walletBalance,
        lastCycleMs: Date.now() - cycleStart,
      }, { merge: true });
      return { verdict: 'CRITICAL_STANDBY', walletBalance };
    }

    let bestOpportunity = null;

    for (const bracket of brackets) {
      const basketSum = bracket.tokens.reduce((s, t) => s + t.currentYesPrice, 0);
      const edge = basketSum - 1.00;

      if (edge < 0.03) continue;

      const payload = buildMarketPayload(bracket, walletBalance);
      const verdict = await evaluateArbitrage(payload);

      console.log(`[V2 ENGINE] ${bracket.title} | sum=${basketSum.toFixed(4)} | edge=${(edge * 100).toFixed(2)}% | verdict=${verdict.verdict}`);

      if (verdict.verdict === 'APPROVED_FOR_EXECUTION') {
        if (!bestOpportunity || edge > bestOpportunity.edge) {
          bestOpportunity = { bracket, edge, verdict };
        }
      }
    }

    if (bestOpportunity) {
      console.log(`[V2 ENGINE] EXECUTING: ${bestOpportunity.bracket.title} | edge=${(bestOpportunity.edge * 100).toFixed(2)}%`);

      const legs = await this.alphaEngine.executeBracketArbitrage(bestOpportunity.bracket);

      await this.telemetryRef.set({
        status: 'EXECUTED',
        lastExecution: FieldValue.serverTimestamp(),
        lastBracket: bestOpportunity.bracket.title,
        lastEdge: (bestOpportunity.edge * 100).toFixed(2),
        lastCycleMs: Date.now() - cycleStart,
        bracketsScanned: brackets.length,
      }, { merge: true });

      return { verdict: 'EXECUTED', bracket: bestOpportunity.bracket.title, legs };
    }

    await this.telemetryRef.set({
      status: 'NO_EDGE',
      lastCycleMs: Date.now() - cycleStart,
      bracketsScanned: brackets.length,
      lastScanTimestamp: FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log(`[V2 ENGINE] Cycle complete — ${brackets.length} brackets scanned, no edge above hurdle`);
    return { verdict: 'NO_EDGE', scanned: brackets.length };
  }
}

module.exports = { PolymarketV2Engine };
