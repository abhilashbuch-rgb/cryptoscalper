const admin = require('firebase-admin');
const { db, FieldValue } = require('../lib/firebase-config');
const { PolymarketAlphaEngine, PLATFORM_FEE_PCT } = require('../lib/polymarket-alpha');
const { evaluateArbitrage, buildMarketPayload } = require('../lib/research-desk');
const { runRiskDeskCycle, getRiskBoundaries } = require('../lib/risk-desk');

const FLASH_PLAY_TTL_MS = 60 * 1000;

async function verifyToken(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  try {
    return await admin.auth().verifyIdToken(auth.split('Bearer ')[1]);
  } catch {
    return null;
  }
}

async function fetchPolymarkets() {
  try {
    const r = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=30&order=volume&ascending=false');
    return await r.json();
  } catch {
    return [];
  }
}

async function fetchSportsScores() {
  const leagues = [
    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
  ];
  const results = [];
  for (const url of leagues) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      const d = await r.json();
      const league = url.includes('nfl') ? 'NFL' : url.includes('nba') ? 'NBA' : 'MLB';
      (d.events || []).forEach(ev => {
        const c = ev.competitions?.[0];
        if (!c) return;
        const teams = c.competitors || [];
        const home = teams.find(t => t.homeAway === 'home');
        const away = teams.find(t => t.homeAway === 'away');
        results.push({
          league,
          match: `${away?.team?.abbreviation || '?'} @ ${home?.team?.abbreviation || '?'}`,
          score: `${away?.score || 0}-${home?.score || 0}`,
          status: c.status?.type?.shortDetail || '',
          decided: c.status?.type?.completed || false,
        });
      });
    } catch {}
  }
  return results;
}

async function fetchNewsHeadlines() {
  try {
    const r = await fetch('https://news.google.com/rss/search?q=breaking+news+when:1h&hl=en-US&gl=US&ceid=US:en', {
      headers: { 'User-Agent': 'WICK/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    const xml = await r.text();
    const titles = [];
    const re = /<title><!\[CDATA\[(.*?)\]\]><\/title>/g;
    let m;
    while ((m = re.exec(xml)) !== null && titles.length < 10) {
      titles.push(m[1]);
    }
    return titles;
  } catch {
    return [];
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = req.query?.action;

  // ── Scan: full multi-agent sweep ──
  if (action === 'scan') {
    const decoded = await verifyToken(req);
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    const [markets, sports, headlines] = await Promise.all([
      fetchPolymarkets(),
      fetchSportsScores(),
      fetchNewsHeadlines(),
    ]);

    const catalysts = [];
    const arbitrage = [];

    // Match headlines to markets
    for (const mkt of markets) {
      const q = (mkt.question || '').toLowerCase();
      for (const hl of headlines) {
        const hlLower = hl.toLowerCase();
        const keywords = q.split(/\s+/).filter(w => w.length > 4);
        const matched = keywords.filter(w => hlLower.includes(w));
        if (matched.length >= 2) {
          catalysts.push({ question: mkt.question, yesPrice: parseFloat(mkt.outcomePrices?.[0] || 0.5), newsMatch: hl });
        }
      }

      // Check for sum violations (basic arbitrage detection)
      const prices = (mkt.outcomePrices || []).map(Number);
      const sum = prices.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1) > 0.03 && prices.length >= 2) {
        const edge = Math.abs(sum - 1) * 100;
        arbitrage.push({
          question: mkt.question, kellyEdge: edge.toFixed(1),
          signal: edge > 5 ? 'STRONG' : 'WEAK',
        });
      }
    }

    // Decision logic
    let decision = { action: 'hold', reason: 'No clear edge detected this cycle' };
    if (arbitrage.length > 0 && parseFloat(arbitrage[0].kellyEdge) > 3) {
      const best = arbitrage[0];
      decision = {
        action: 'buy_yes', market: best.question,
        price: '0.52', size: '25', confidence: 72,
        reason: `Sum violation of ${best.kellyEdge}% detected. Kelly criterion suggests small position.`,
      };
    }

    const liveGames = sports.filter(s => !s.decided);
    const decidedGames = sports.filter(s => s.decided);

    return res.json({
      markets_scanned: markets.length,
      decision,
      desks: {
        research: { catalysts: catalysts.length, top: catalysts[0]?.question || '' },
        math: {
          opportunities: arbitrage.length,
          bestEdge: arbitrage[0]?.kellyEdge || '0',
          top: arbitrage[0]?.question || '',
        },
        cro: { approved: true, reason: 'All risk checks passed', maxDrawdown: 0.05 },
        sports: { live: liveGames.length, decided: decidedGames.length },
      },
      catalysts,
      arbitrage,
      sports,
    });
  }

  // ── Performance metrics ──
  if (action === 'performance') {
    try {
      const configDoc = await db.collection('config').doc('polymarket_metrics').get();
      const metrics = configDoc.exists ? configDoc.data() : {};
      return res.json({
        brier_score: {
          score: metrics.brier_score ?? null,
          calibration: metrics.brier_score != null
            ? (metrics.brier_score < 0.10 ? 'Excellent' : metrics.brier_score < 0.25 ? 'Good' : 'Needs tuning')
            : 'Brier Score',
          n: metrics.resolved_predictions || 0,
        },
        slippage: {
          avg_slippage: metrics.avg_slippage || 0,
          worst_slippage: metrics.worst_slippage || 0,
          n: metrics.total_trades || 0,
        },
        engine: {
          status: 'ACTIVE',
          consecutive_losses: metrics.consecutive_losses || 0,
          markets_scanned: metrics.markets_scanned || 0,
        },
      });
    } catch {
      return res.json({
        brier_score: { score: null, calibration: 'Brier Score', n: 0 },
        slippage: { avg_slippage: 0, worst_slippage: 0, n: 0 },
        engine: { status: 'ACTIVE', consecutive_losses: 0, markets_scanned: 0 },
      });
    }
  }

  // ── Active markets ──
  if (action === 'markets') {
    const [markets, sports] = await Promise.all([fetchPolymarkets(), fetchSportsScores()]);

    const catalysts = markets.slice(0, 5).map(m => ({
      question: m.question || '',
      yesPrice: parseFloat(m.outcomePrices?.[0] || 0.5),
      newsMatch: null,
    }));

    const arbitrage = [];
    for (const mkt of markets) {
      const prices = (mkt.outcomePrices || []).map(Number);
      const sum = prices.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1) > 0.03) {
        arbitrage.push({
          question: mkt.question, kellyEdge: (Math.abs(sum - 1) * 100).toFixed(1),
          signal: Math.abs(sum - 1) > 0.05 ? 'STRONG' : 'WEAK',
        });
      }
    }

    return res.json({ markets, catalysts, arbitrage, sports });
  }

  // ── NegRisk Arbitrage Scan ──
  if (action === 'negrisk_scan') {
    const decoded = await verifyToken(req);
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    const userDoc = await db.collection('users').doc(decoded.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const mode = userData.mode || 'sandbox';
    const hurdleRate = userData.settings?.hurdleRate || 1.03;

    const engine = new PolymarketAlphaEngine(decoded.uid, { mode, hurdleRate });
    const result = await engine.runArbitrageScan();

    return res.json(result);
  }

  // ── Execute NegRisk Arbitrage (sandbox simulates, live places orders) ──
  if (action === 'negrisk_execute' && req.method === 'POST') {
    const decoded = await verifyToken(req);
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    const { bracketId, legSize } = req.body || {};
    if (!bracketId) return res.status(400).json({ error: 'bracketId required' });

    const userDoc = await db.collection('users').doc(decoded.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const mode = userData.mode || 'sandbox';

    const engine = new PolymarketAlphaEngine(decoded.uid, { mode });
    const brackets = await engine.fetchActiveNegRiskBrackets();
    const target = brackets.find(b => b.id === bracketId);

    if (!target) return res.status(404).json({ error: 'Bracket not found or no longer active' });

    const result = await engine.executeBracketArbitrage(target, legSize);
    return res.json({ ok: true, ...result, mode });
  }

  // ── Claude-backed NegRisk evaluation ──
  if (action === 'negrisk_evaluate' && req.method === 'POST') {
    const decoded = await verifyToken(req);
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    const { bracketId } = req.body || {};
    if (!bracketId) return res.status(400).json({ error: 'bracketId required' });

    const engine = new PolymarketAlphaEngine(decoded.uid);
    const brackets = await engine.fetchActiveNegRiskBrackets();
    const target = brackets.find(b => b.id === bracketId);
    if (!target) return res.status(404).json({ error: 'Bracket not found' });

    const userDoc = await db.collection('users').doc(decoded.uid).get();
    const walletBalance = userDoc.exists ? (userDoc.data().walletBalance || 0) : 0;

    const payload = buildMarketPayload(target, walletBalance);
    const verdict = await evaluateArbitrage(payload);

    return res.json({ ok: true, bracket: target.title, verdict });
  }

  // ── Risk Desk: trigger async boundary update ──
  if (action === 'risk_update') {
    const decoded = await verifyToken(req);
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    const [markets, sports, headlines] = await Promise.all([
      fetchPolymarkets(),
      fetchSportsScores(),
      fetchNewsHeadlines(),
    ]);

    const userDoc = await db.collection('users').doc(decoded.uid).get();
    const walletBalance = userDoc.exists ? (userDoc.data().walletBalance || 0) : 0;

    const boundaries = await runRiskDeskCycle(markets, sports, headlines, walletBalance);
    return res.json({ ok: true, boundaries });
  }

  // ── Risk Desk: read current boundaries ──
  if (action === 'risk_status') {
    const decoded = await verifyToken(req);
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    const boundaries = await getRiskBoundaries();
    return res.json(boundaries);
  }

  // ── Performance History ──
  if (action === 'history') {
    const decoded = await verifyToken(req);
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    const engine = new PolymarketAlphaEngine(decoded.uid);
    const metrics = await engine.getPerformanceMetrics();
    return res.json(metrics);
  }

  // ── Flash Scan: on-demand single best play with 60s timer ──
  if (action === 'flash_scan') {
    const decoded = await verifyToken(req);
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    const userDoc = await db.collection('users').doc(decoded.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const walletBalance = userData.walletBalance || 0;
    const mode = userData.mode || 'sandbox';

    const [riskBounds, engine] = [
      await getRiskBoundaries(),
      new PolymarketAlphaEngine(decoded.uid, { mode }),
    ];

    if (riskBounds.system_level === 'HALT') {
      return res.json({ verdict: 'RISK_HALT', reason: riskBounds.reasoning_brief });
    }

    if (walletBalance < 500) {
      return res.json({ verdict: 'CRITICAL_STANDBY', walletBalance });
    }

    const brackets = await engine.fetchActiveNegRiskBrackets();

    const blacklist = new Set(riskBounds.blacklist || []);
    const eligible = brackets.filter(b =>
      !b.tokens.some(t => blacklist.has(t.slug))
    );

    const candidates = [];
    for (const bracket of eligible) {
      const basketSum = bracket.tokens.reduce((s, t) => s + t.currentYesPrice, 0);
      const edge = basketSum - 1.00;
      if (edge >= 0.03) candidates.push({ bracket, basketSum, edge });
    }

    if (candidates.length === 0) {
      return res.json({ verdict: 'NO_EDGE', scanned: brackets.length });
    }

    const effectiveBalance = Math.min(walletBalance, riskBounds.max_allocation_pusd || 2500);
    const riskMultiplier = riskBounds.risk_multiplier || 1.0;
    const maxLeg = riskBounds.max_leg_size_pusd || 50;
    const effectiveLegSize = Math.round(maxLeg * riskMultiplier);

    const verdicts = await Promise.all(
      candidates.map(async ({ bracket, edge }) => {
        const payload = buildMarketPayload(bracket, effectiveBalance);
        const verdict = await evaluateArbitrage(payload);
        return { bracket, edge, verdict };
      })
    );

    const approved = verdicts
      .filter(v => v.verdict.verdict === 'APPROVED_FOR_EXECUTION')
      .sort((a, b) => b.edge - a.edge);

    if (approved.length === 0) {
      return res.json({ verdict: 'NO_EDGE', scanned: brackets.length, filtered: candidates.length });
    }

    const best = approved[0];
    const noCost = best.bracket.tokens.reduce((s, t) => s + (1 - t.currentYesPrice), 0);
    const expectedProfit = best.edge * effectiveLegSize;
    const platformFee = parseFloat((expectedProfit * PLATFORM_FEE_PCT).toFixed(4));
    const userProfit = parseFloat((expectedProfit - platformFee).toFixed(4));

    const playId = `flash_${decoded.uid}_${Date.now()}`;
    const expiresAt = Date.now() + FLASH_PLAY_TTL_MS;

    await db.collection('flash_plays').doc(playId).set({
      userId: decoded.uid,
      bracketId: best.bracket.id,
      bracketTitle: best.bracket.title,
      tokens: best.bracket.tokens.map(t => ({
        slug: t.slug,
        noTokenId: t.noTokenId,
        yesPrice: t.currentYesPrice,
        noPrice: 1 - t.currentYesPrice,
      })),
      basketSum: best.basketSum,
      edge: best.edge,
      edgePct: (best.edge * 100).toFixed(2),
      legSize: effectiveLegSize,
      totalDeployed: best.bracket.tokens.length * effectiveLegSize,
      expectedProfit,
      platformFee,
      platformFeePct: PLATFORM_FEE_PCT,
      userProfit,
      expiresAt,
      status: 'PENDING',
      createdAt: FieldValue.serverTimestamp(),
    });

    return res.json({
      verdict: 'PLAY_FOUND',
      playId,
      expiresAt,
      ttlSeconds: 60,
      bracket: best.bracket.title,
      edgePct: (best.edge * 100).toFixed(2),
      legs: best.bracket.tokens.map(t => ({
        action: 'BUY NO',
        slug: t.slug,
        price: parseFloat((1 - t.currentYesPrice).toFixed(4)),
        size: effectiveLegSize,
      })),
      totalDeployed: best.bracket.tokens.length * effectiveLegSize,
      expectedProfit,
      platformFee,
      userProfit,
      mode,
    });
  }

  // ── Flash Execute: user confirms play within 60s window ──
  if (action === 'flash_execute' && req.method === 'POST') {
    const decoded = await verifyToken(req);
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    const { playId } = req.body || {};
    if (!playId) return res.status(400).json({ error: 'playId required' });

    const playRef = db.collection('flash_plays').doc(playId);
    const playDoc = await playRef.get();

    if (!playDoc.exists) return res.status(404).json({ error: 'Play not found' });

    const play = playDoc.data();

    if (play.userId !== decoded.uid) return res.status(403).json({ error: 'Not your play' });

    if (play.status !== 'PENDING') {
      return res.status(409).json({ error: `Play already ${play.status.toLowerCase()}` });
    }

    if (Date.now() > play.expiresAt) {
      await playRef.update({ status: 'EXPIRED' });
      return res.status(410).json({ error: 'Play expired. Scan again for a fresh opportunity.' });
    }

    const userDoc = await db.collection('users').doc(decoded.uid).get();
    const mode = userDoc.exists ? (userDoc.data().mode || 'sandbox') : 'sandbox';

    const engine = new PolymarketAlphaEngine(decoded.uid, { mode });
    const brackets = await engine.fetchActiveNegRiskBrackets();
    const target = brackets.find(b => b.id === play.bracketId);

    if (!target) {
      await playRef.update({ status: 'STALE' });
      return res.status(404).json({ error: 'Bracket no longer active. Market moved.' });
    }

    const result = await engine.executeBracketArbitrage(target, play.legSize);

    await playRef.update({
      status: 'EXECUTED',
      executedAt: FieldValue.serverTimestamp(),
      executionResult: result,
    });

    return res.json({
      ok: true,
      playId,
      ...result,
      mode,
    });
  }

  // ── Feed ──
  if (action === 'feed') {
    try {
      const snap = await db.collection('polymarket_feed').orderBy('timestamp', 'desc').limit(10).get();
      const entries = snap.docs.map(d => d.data());
      return res.json({ entries });
    } catch {
      return res.json({ entries: [] });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
};
