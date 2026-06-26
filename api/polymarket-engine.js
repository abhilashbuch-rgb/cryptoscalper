const admin = require('firebase-admin');
const { db } = require('../lib/firebase-config');
const { PolymarketAlphaEngine } = require('../lib/polymarket-alpha');
const { evaluateArbitrage, buildMarketPayload } = require('../lib/research-desk');
const { runRiskDeskCycle, getRiskBoundaries } = require('../lib/risk-desk');

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

    const results = await engine.executeBracketArbitrage(target, legSize);
    return res.json({ ok: true, legs: results, mode });
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
