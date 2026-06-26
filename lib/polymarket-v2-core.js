const { db, FieldValue } = require('./firebase-config');
const { PolymarketAlphaEngine, MIN_BALANCE } = require('./polymarket-alpha');
const { evaluateArbitrage, buildMarketPayload } = require('./research-desk');

const HURDLE_FLOOR = 0.03;

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

    const [brackets, walletBalance] = await Promise.all([
      this.alphaEngine.fetchActiveNegRiskBrackets(),
      this.getWalletBalance(),
    ]);

    if (walletBalance < MIN_BALANCE) {
      console.log(`[V2 ENGINE] CRITICAL_STANDBY — Balance ${walletBalance} pUSD below ${MIN_BALANCE} floor`);
      await this.telemetryRef.set({
        status: 'CRITICAL_STANDBY',
        walletBalance,
        lastCycleMs: Date.now() - cycleStart,
      }, { merge: true });
      return { verdict: 'CRITICAL_STANDBY', walletBalance };
    }

    // Phase 1: Local math filter — pure in-memory, no API calls
    const candidates = [];
    for (const bracket of brackets) {
      const basketSum = bracket.tokens.reduce((s, t) => s + t.currentYesPrice, 0);
      const edge = basketSum - 1.00;
      if (edge >= HURDLE_FLOOR) {
        candidates.push({ bracket, basketSum, edge });
      }
    }

    if (candidates.length === 0) {
      await this.telemetryRef.set({
        status: 'NO_EDGE',
        lastCycleMs: Date.now() - cycleStart,
        bracketsScanned: brackets.length,
        candidatesFiltered: 0,
        lastScanTimestamp: FieldValue.serverTimestamp(),
      }, { merge: true });
      console.log(`[V2 ENGINE] Cycle complete — ${brackets.length} brackets scanned, 0 above hurdle | ${Date.now() - cycleStart}ms`);
      return { verdict: 'NO_EDGE', scanned: brackets.length };
    }

    // Phase 2: Parallel Claude evaluation — all candidates simultaneously
    console.log(`[V2 ENGINE] ${candidates.length} candidates above hurdle, firing parallel Claude evaluation`);

    const verdicts = await Promise.all(
      candidates.map(async ({ bracket, edge }) => {
        const payload = buildMarketPayload(bracket, walletBalance);
        const verdict = await evaluateArbitrage(payload);
        console.log(`[V2 ENGINE] ${bracket.title} | edge=${(edge * 100).toFixed(2)}% | verdict=${verdict.verdict}`);
        return { bracket, edge, verdict };
      })
    );

    // Phase 3: Pick the best approved opportunity
    const approved = verdicts
      .filter(v => v.verdict.verdict === 'APPROVED_FOR_EXECUTION')
      .sort((a, b) => b.edge - a.edge);

    if (approved.length > 0) {
      const best = approved[0];
      console.log(`[V2 ENGINE] EXECUTING: ${best.bracket.title} | edge=${(best.edge * 100).toFixed(2)}% | ${approved.length} approved, picking best`);

      const legs = await this.alphaEngine.executeBracketArbitrage(best.bracket);

      await this.telemetryRef.set({
        status: 'EXECUTED',
        lastExecution: FieldValue.serverTimestamp(),
        lastBracket: best.bracket.title,
        lastEdge: (best.edge * 100).toFixed(2),
        lastCycleMs: Date.now() - cycleStart,
        bracketsScanned: brackets.length,
        candidatesFiltered: candidates.length,
        approvedCount: approved.length,
      }, { merge: true });

      return { verdict: 'EXECUTED', bracket: best.bracket.title, legs };
    }

    await this.telemetryRef.set({
      status: 'NO_EDGE',
      lastCycleMs: Date.now() - cycleStart,
      bracketsScanned: brackets.length,
      candidatesFiltered: candidates.length,
      approvedCount: 0,
      lastScanTimestamp: FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log(`[V2 ENGINE] Cycle complete — ${brackets.length} scanned, ${candidates.length} filtered, 0 approved | ${Date.now() - cycleStart}ms`);
    return { verdict: 'NO_EDGE', scanned: brackets.length, filtered: candidates.length };
  }
}

module.exports = { PolymarketV2Engine };
