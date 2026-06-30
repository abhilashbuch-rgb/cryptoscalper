const { db, FieldValue } = require('./firebase-config');
const { PolymarketAlphaEngine, MIN_BALANCE } = require('./polymarket-alpha');
const { evaluateArbitrage, buildMarketPayload } = require('./research-desk');
const { getRiskBoundaries } = require('./risk-desk');

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

    const [brackets, walletBalance, riskBounds] = await Promise.all([
      this.alphaEngine.fetchActiveNegRiskBrackets(),
      this.getWalletBalance(),
      getRiskBoundaries(),
    ]);

    // Risk desk HALT check
    if (riskBounds.system_level === 'HALT') {
      console.log('[V2 ENGINE] HALTED by risk desk');
      await this.telemetryRef.set({
        status: 'RISK_HALT',
        lastCycleMs: Date.now() - cycleStart,
      }, { merge: true });
      return { verdict: 'RISK_HALT', reason: riskBounds.reasoning_brief };
    }

    if (walletBalance < MIN_BALANCE) {
      console.log(`[V2 ENGINE] CRITICAL_STANDBY — Balance ${walletBalance} pUSD below ${MIN_BALANCE} floor`);
      await this.telemetryRef.set({
        status: 'CRITICAL_STANDBY',
        walletBalance,
        lastCycleMs: Date.now() - cycleStart,
      }, { merge: true });
      return { verdict: 'CRITICAL_STANDBY', walletBalance };
    }

    // Capital ceiling from risk desk
    const maxAllocation = riskBounds.max_allocation_pusd || 2500;
    if (walletBalance > maxAllocation) {
      console.log(`[V2 ENGINE] Wallet ${walletBalance} exceeds risk ceiling ${maxAllocation}, capping deployment`);
    }
    const effectiveBalance = Math.min(walletBalance, maxAllocation);

    // Blacklist filtering
    const blacklist = new Set(riskBounds.blacklist || []);
    const hotWatch = new Set(riskBounds.hot_watch_add || []);
    const removedWatch = new Set(riskBounds.hot_watch_remove || []);

    const eligibleBrackets = brackets.filter(b => {
      const tokenIds = b.tokens.map(t => t.slug);
      if (tokenIds.some(id => blacklist.has(id))) return false;
      if (removedWatch.size > 0 && tokenIds.some(id => removedWatch.has(id))) return false;
      return true;
    });

    // Phase 1: Local math filter — pure in-memory, no API calls
    const candidates = [];
    for (const bracket of eligibleBrackets) {
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
        bracketsEligible: eligibleBrackets.length,
        candidatesFiltered: 0,
        riskLevel: riskBounds.system_level,
        lastScanTimestamp: FieldValue.serverTimestamp(),
      }, { merge: true });
      console.log(`[V2 ENGINE] Cycle complete — ${brackets.length} scanned, ${eligibleBrackets.length} eligible, 0 above hurdle | ${Date.now() - cycleStart}ms`);
      return { verdict: 'NO_EDGE', scanned: brackets.length, eligible: eligibleBrackets.length };
    }

    // Phase 2: Parallel Claude evaluation — all candidates simultaneously
    console.log(`[V2 ENGINE] ${candidates.length} candidates above hurdle, firing parallel Claude evaluation`);

    const verdicts = await Promise.all(
      candidates.map(async ({ bracket, edge }) => {
        const payload = buildMarketPayload(bracket, effectiveBalance);
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

      // Dynamic leg sizing from risk desk
      const riskMultiplier = riskBounds.risk_multiplier || 1.0;
      const maxLeg = riskBounds.max_leg_size_pusd || 50;
      const effectiveLegSize = Math.round(maxLeg * riskMultiplier);

      console.log(`[V2 ENGINE] EXECUTING: ${best.bracket.title} | edge=${(best.edge * 100).toFixed(2)}% | leg=$${effectiveLegSize} (${riskMultiplier}x) | ${approved.length} approved`);

      const result = await this.alphaEngine.executeBracketArbitrage(best.bracket, effectiveLegSize);

      console.log(`[V2 ENGINE] Fee: $${result.platformFee} (10%) | User profit: $${result.userProfit}`);

      await this.telemetryRef.set({
        status: 'EXECUTED',
        lastExecution: FieldValue.serverTimestamp(),
        lastBracket: best.bracket.title,
        lastEdge: (best.edge * 100).toFixed(2),
        lastLegSize: effectiveLegSize,
        lastPlatformFee: result.platformFee,
        lastUserProfit: result.userProfit,
        lastCycleMs: Date.now() - cycleStart,
        bracketsScanned: brackets.length,
        bracketsEligible: eligibleBrackets.length,
        candidatesFiltered: candidates.length,
        approvedCount: approved.length,
        riskLevel: riskBounds.system_level,
        riskMultiplier,
      }, { merge: true });

      return { verdict: 'EXECUTED', bracket: best.bracket.title, ...result, legSize: effectiveLegSize };
    }

    await this.telemetryRef.set({
      status: 'NO_EDGE',
      lastCycleMs: Date.now() - cycleStart,
      bracketsScanned: brackets.length,
      bracketsEligible: eligibleBrackets.length,
      candidatesFiltered: candidates.length,
      approvedCount: 0,
      riskLevel: riskBounds.system_level,
      lastScanTimestamp: FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log(`[V2 ENGINE] Cycle complete — ${brackets.length} scanned, ${eligibleBrackets.length} eligible, ${candidates.length} filtered, 0 approved | ${Date.now() - cycleStart}ms`);
    return { verdict: 'NO_EDGE', scanned: brackets.length, eligible: eligibleBrackets.length, filtered: candidates.length };
  }
}

module.exports = { PolymarketV2Engine };
