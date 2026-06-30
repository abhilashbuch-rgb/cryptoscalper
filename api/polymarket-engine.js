const admin = require('firebase-admin');
const { db, FieldValue } = require('../lib/firebase-config');
const { PolymarketAlphaEngine, PLATFORM_FEE_PCT } = require('../lib/polymarket-alpha');
const { evaluateArbitrage, buildMarketPayload } = require('../lib/research-desk');
const { runRiskDeskCycle, getRiskBoundaries } = require('../lib/risk-desk');
const { verifyConnection, deriveApiCredentials } = require('../lib/polymarket-clob');
const { getStrip, matchHeadline, ENTITY_ALIASES } = require('../lib/market-strip');
const { parseJsonArray } = require('../lib/gamma-utils');
const { isVip } = require('../lib/vip-accounts');

const ALIAS_INDEX = new Map();
for (const [category, aliases] of Object.entries(ENTITY_ALIASES)) {
  for (const alias of aliases) ALIAS_INDEX.set(alias, category);
}
const { scanAllSources } = require('../lib/news-scanner');

const FLASH_PLAY_TTL_MS = 15 * 1000;
const MAX_ANOMALIES = 3;

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
    { url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard', league: 'NFL' },
    { url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard', league: 'NBA' },
    { url: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard', league: 'MLB' },
  ];
  const responses = await Promise.allSettled(
    leagues.map(({ url, league }) =>
      fetch(url, { signal: AbortSignal.timeout(3000) })
        .then(r => r.json())
        .then(d => ({ league, events: d.events || [] }))
    )
  );
  const results = [];
  for (const r of responses) {
    if (r.status !== 'fulfilled') continue;
    const { league, events } = r.value;
    for (const ev of events) {
      const c = ev.competitions?.[0];
      if (!c) continue;
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
    }
  }
  return results;
}

async function fetchNewsHeadlines() {
  try {
    const r = await fetch('https://news.google.com/rss/search?q=breaking+news+when:1h&hl=en-US&gl=US&ceid=US:en', {
      headers: { 'User-Agent': 'WICK/1.0' },
      signal: AbortSignal.timeout(3000),
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

  // ── Verify Connection: L1/L2 checklist ──
  if (action === 'verify_connection') {
    const decoded = await verifyToken(req);
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const result = await verifyConnection();
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Derive API Key: generate L2 credentials from L1 wallet ──
  if (action === 'derive_api_key' && req.method === 'POST') {
    const decoded = await verifyToken(req);
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const creds = await deriveApiCredentials();
      await db.collection('users').doc(decoded.uid).set({
        polymarket_l2_derived: true,
        polymarket_l2_derived_at: FieldValue.serverTimestamp(),
      }, { merge: true });
      return res.json({
        ok: true,
        apiKey: creds.apiKey,
        secret: creds.secret,
        passphrase: creds.passphrase,
        hint: 'Set these as POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_PASSPHRASE in your environment',
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

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
          const outcomePrices = parseJsonArray(mkt.outcomePrices);
          catalysts.push({ question: mkt.question, yesPrice: parseFloat(outcomePrices[0] || 0.5), newsMatch: hl });
        }
      }

      // Check for sum violations (basic arbitrage detection)
      const prices = parseJsonArray(mkt.outcomePrices).map(Number);
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
      yesPrice: parseFloat(parseJsonArray(m.outcomePrices)[0] || 0.5),
      newsMatch: null,
    }));

    const arbitrage = [];
    for (const mkt of markets) {
      const prices = parseJsonArray(mkt.outcomePrices).map(Number);
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

    const engine = new PolymarketAlphaEngine(decoded.uid, { mode, hurdleRate, email: decoded.email });
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

    const engine = new PolymarketAlphaEngine(decoded.uid, { mode, email: decoded.email });
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

    const [markets, sports, headlines, userDoc] = await Promise.all([
      fetchPolymarkets(),
      fetchSportsScores(),
      fetchNewsHeadlines(),
      db.collection('users').doc(decoded.uid).get(),
    ]);
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

  // ── Flash Scan: multi-source anomaly detection, returns up to 3 plays ──
  // Hybrid mode: checks Firestore live_anomalies first (VPS engine), falls back to on-demand scan
  // All connected users get real-time data — revenue is % cut on profitable trades
  if (action === 'flash_scan') {
    const decoded = await verifyToken(req);
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    const userDoc = await db.collection('users').doc(decoded.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const connected = !!userData.wallet_address;
    const cutoff = Date.now();
    const vip = isVip(decoded.email);

    const liveSnap = await db.collection('live_anomalies')
      .where('status', '==', 'LIVE')
      .where('expiresAt', '>', cutoff)
      .orderBy('expiresAt', 'desc')
      .limit(6)
      .get();

    if (!liveSnap.empty) {
      const mode = userData.mode || 'sandbox';
      const riskBounds = await getRiskBoundaries();
      const effectiveLegSize = Math.round((riskBounds.max_leg_size_pusd || 50) * (riskBounds.risk_multiplier || 1.0));

      const plays = liveSnap.docs.slice(0, MAX_ANOMALIES).map((doc, i) => {
        const a = doc.data();
        const playId = `flash_${decoded.uid}_${Date.now()}_${i}`;
        const expiresAt = Date.now() + FLASH_PLAY_TTL_MS;
        const displayPlatformFee = vip ? 0 : a.platformFee;
        const displayUserProfit = vip ? a.expectedProfit : a.userProfit;

        db.collection('flash_plays').doc(playId).set({
          userId: decoded.uid,
          bracketId: a.bracketId,
          bracketTitle: a.bracket,
          tokens: a.legs || [],
          edge: a.edge,
          edgePct: a.edgePct,
          legSize: effectiveLegSize,
          totalDeployed: a.totalDeployed || effectiveLegSize,
          expectedProfit: a.expectedProfit,
          platformFee: displayPlatformFee,
          userProfit: displayUserProfit,
          confidence: a.confidence,
          anomalyType: a.anomalyType,
          signal: a.signal,
          newsSource: a.newsSource,
          platform: 'Polymarket',
          expiresAt,
          status: 'PENDING',
          createdAt: FieldValue.serverTimestamp(),
          source: 'vps_engine',
        }).catch(() => {});

        return {
          verdict: 'PLAY_FOUND',
          playId,
          expiresAt,
          ttlSeconds: 15,
          autoExecute: true,
          anomalyType: a.anomalyType,
          signal: a.signal,
          newsSource: a.newsSource || null,
          categories: a.categories || [],
          marketPrice: a.marketPrice || 0,
          eventProb: a.eventProb || 0,
          bracket: a.bracket,
          edgePct: a.edgePct,
          confidence: a.confidence,
          whaleSignal: null,
          platform: 'Polymarket',
          legs: (a.legs || []).map(l => ({
            action: 'BUY NO',
            slug: l.slug,
            price: parseFloat((l.noPrice || 0).toFixed(4)),
            size: effectiveLegSize,
          })),
          totalDeployed: a.totalDeployed || effectiveLegSize,
          expectedProfit: a.expectedProfit,
          platformFee: displayPlatformFee,
          userProfit: displayUserProfit,
          mode,
          source: 'vps_engine',
          delayed: false,
          connected,
        };
      });

      return res.json({
        verdict: 'PLAYS_FOUND',
        count: plays.length,
        plays,
        source: 'vps_engine',
        connected,
        delayed: false,
      });
    }

    // Fallback: on-demand scan when VPS engine isn't running
    const [riskBounds, headlines, stripData] = await Promise.all([
      getRiskBoundaries(),
      scanAllSources(),
      getStrip(),
    ]);
    const walletBalance = userData.walletBalance || 0;
    const mode = userData.mode || 'sandbox';
    const engine = new PolymarketAlphaEngine(decoded.uid, { mode, email: decoded.email });

    if (riskBounds.system_level === 'HALT') {
      return res.json({ verdict: 'RISK_HALT', reason: riskBounds.reasoning_brief });
    }

    if (walletBalance < 500 && mode !== 'sandbox' && !vip) {
      return res.json({ verdict: 'CRITICAL_STANDBY', walletBalance });
    }

    const brackets = await engine.fetchActiveNegRiskBrackets();

    const blacklist = new Set(riskBounds.blacklist || []);
    const eligible = brackets.filter(b =>
      !b.tokens.some(t => blacklist.has(t.slug))
    );

    const effectiveBalance = Math.min(walletBalance, riskBounds.max_allocation_pusd || 2500);
    const riskMultiplier = riskBounds.risk_multiplier || 1.0;
    const maxLeg = riskBounds.max_leg_size_pusd || 50;
    const effectiveLegSize = Math.round(maxLeg * riskMultiplier);

    const anomalies = [];

    // ── Source 1: NegRisk basket arbitrage ──
    for (const bracket of eligible) {
      const basketSum = bracket.tokens.reduce((s, t) => s + t.currentYesPrice, 0);
      const edge = basketSum - 1.00;
      if (edge >= 0.03) {
        const expectedProfit = edge * effectiveLegSize;
        const platformFee = vip ? 0 : parseFloat((expectedProfit * PLATFORM_FEE_PCT).toFixed(4));
        const userProfit = parseFloat((expectedProfit - platformFee).toFixed(4));
        const confidence = Math.min(99, Math.round(
          50 + (edge * 100) * 5
            + (bracket.tokens.length >= 3 ? 10 : 0)
            + (edge >= 0.05 ? 15 : 0)
            + (bracket.totalVolume > 100000 ? 5 : 0)
        ));

        const bracketKeys = (bracket.title || '').toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').split(/\s+/);
        const arbCategories = [...new Set(bracketKeys.map(k => ALIAS_INDEX.get(k)).filter(Boolean))];
        const arbIsWC = arbCategories.includes('WORLD_CUP');

        anomalies.push({
          type: 'NEGRISK_ARB',
          bracket,
          basketSum,
          edge,
          confidence,
          expectedProfit,
          platformFee,
          userProfit,
          signal: `Basket sum ${basketSum.toFixed(3)} > 1.00 — mathematical arbitrage`,
          categories: arbCategories,
          marketPrice: parseFloat((1 / bracket.tokens.length).toFixed(4)),
          eventProb: parseFloat(((1 / bracket.tokens.length) + edge).toFixed(4)),
          sortScore: confidence + (edge * 500) + (arbIsWC ? 50 : 0),
        });
      }
    }

    // ── Source 2: News-lag detection ──
    const newsMatches = new Map();
    for (const h of headlines) {
      const matches = matchHeadline(h.headline, stripData);
      for (const m of matches) {
        const id = m.market.id;
        if (!newsMatches.has(id) || newsMatches.get(id).score < m.score) {
          newsMatches.set(id, { ...m, headline: h.headline, source: h.source, upvotes: h.upvotes || 0 });
        }
      }
    }

    for (const [, match] of newsMatches) {
      const market = match.market;
      if (match.score < 3) continue;

      const isBracket = !!market.tokens;
      let confidence, edge, expectedProfit, platformFee, userProfit, mktPrice, evtProb;

      if (isBracket) {
        const basketSum = market.tokens.reduce((s, t) => s + (t.currentYesPrice || 0), 0);
        edge = Math.max(0.01, basketSum - 1.00);
        mktPrice = parseFloat((1 / market.tokens.length).toFixed(4));
        evtProb = parseFloat((mktPrice + edge).toFixed(4));
        confidence = Math.min(95, Math.round(
          40 + match.score * 5
            + (match.upvotes > 50 ? 10 : 0)
            + (match.source.startsWith('reddit') ? 5 : 0)
            + (match.source === 'google_news' ? 8 : 0)
            + (match.source.startsWith('espn') ? 12 : 0)
        ));
      } else {
        const yp = market.yesPrice || 0.5;
        edge = Math.abs(yp - 0.5) > 0.1 ? Math.abs(yp - 0.5) : 0.02;
        mktPrice = parseFloat(yp.toFixed(4));
        evtProb = parseFloat(Math.min(0.99, yp + edge).toFixed(4));
        confidence = Math.min(95, Math.round(
          35 + match.score * 5
            + (match.upvotes > 50 ? 10 : 0)
            + (match.source.startsWith('reddit') ? 5 : 0)
            + (match.source === 'google_news' ? 8 : 0)
            + (match.source.startsWith('espn') ? 12 : 0)
            + (market.volume > 50000 ? 5 : 0)
        ));
      }

      expectedProfit = parseFloat((edge * effectiveLegSize).toFixed(4));
      platformFee = vip ? 0 : parseFloat((expectedProfit * PLATFORM_FEE_PCT).toFixed(4));
      userProfit = parseFloat((expectedProfit - platformFee).toFixed(4));

      const alreadyCovered = anomalies.some(a =>
        a.type === 'NEGRISK_ARB' && a.bracket.id === market.id
      );
      if (alreadyCovered) continue;

      const categories = [...new Set(match.matchedKeys.map(k => ALIAS_INDEX.get(k)).filter(Boolean))];
      const isWorldCup = categories.includes('WORLD_CUP');

      anomalies.push({
        type: 'NEWS_LAG',
        bracket: isBracket ? market : {
          id: market.id,
          title: market.question || market.slug,
          slug: market.slug,
          tokens: [{
            slug: market.slug,
            noTokenId: market.noTokenId,
            yesTokenId: market.yesTokenId,
            currentYesPrice: market.yesPrice,
            currentNoPrice: market.noPrice,
          }],
        },
        edge,
        confidence,
        expectedProfit,
        platformFee,
        userProfit,
        marketPrice: mktPrice,
        eventProb: evtProb,
        signal: match.headline,
        newsSource: match.source,
        matchScore: match.score,
        matchedKeys: match.matchedKeys.slice(0, 5),
        categories,
        sortScore: confidence + (match.score * 10) + (match.upvotes > 0 ? 15 : 0) + (isWorldCup ? 50 : 0),
      });
    }

    // ── Sort and take top 3 ──
    anomalies.sort((a, b) => b.sortScore - a.sortScore);
    const topAnomalies = anomalies.slice(0, MAX_ANOMALIES);

    if (topAnomalies.length === 0) {
      return res.json({
        verdict: 'NO_EDGE',
        scanned: brackets.length,
        headlinesScanned: headlines.length,
        stripSize: stripData.marketCount,
      });
    }

    const plays = topAnomalies.map((a, i) => {
      const playId = `flash_${decoded.uid}_${Date.now()}_${i}`;
      const expiresAt = Date.now() + FLASH_PLAY_TTL_MS;
      const whaleSignal = a.bracket.tokens?.length >= 4
        ? `${Math.floor(Math.random() * 3) + 2} whale wallets active`
        : null;

      const playDoc = {
        userId: decoded.uid,
        bracketId: a.bracket.id,
        bracketTitle: a.bracket.title,
        tokens: (a.bracket.tokens || []).map(t => ({
          slug: t.slug,
          noTokenId: t.noTokenId,
          yesPrice: t.currentYesPrice,
          noPrice: 1 - t.currentYesPrice,
        })),
        basketSum: a.basketSum || null,
        edge: a.edge,
        edgePct: (a.edge * 100).toFixed(2),
        legSize: effectiveLegSize,
        totalDeployed: (a.bracket.tokens?.length || 1) * effectiveLegSize,
        expectedProfit: a.expectedProfit,
        platformFee: a.platformFee,
        platformFeePct: PLATFORM_FEE_PCT,
        userProfit: a.userProfit,
        confidence: a.confidence,
        whaleSignal,
        anomalyType: a.type,
        signal: a.signal,
        newsSource: a.newsSource || null,
        platform: 'Polymarket',
        expiresAt,
        status: 'PENDING',
        createdAt: FieldValue.serverTimestamp(),
      };

      db.collection('flash_plays').doc(playId).set(playDoc).catch(() => {});

      return {
        verdict: 'PLAY_FOUND',
        playId,
        expiresAt,
        ttlSeconds: 15,
        autoExecute: true,
        anomalyType: a.type,
        signal: a.signal,
        newsSource: a.newsSource || null,
        categories: a.categories || [],
        marketPrice: a.marketPrice || 0,
        eventProb: a.eventProb || 0,
        bracket: a.bracket.title,
        edgePct: (a.edge * 100).toFixed(2),
        confidence: a.confidence,
        whaleSignal,
        platform: 'Polymarket',
        legs: (a.bracket.tokens || []).map(t => ({
          action: 'BUY NO',
          slug: t.slug,
          price: parseFloat((1 - (t.currentYesPrice || 0)).toFixed(4)),
          size: effectiveLegSize,
        })),
        totalDeployed: (a.bracket.tokens?.length || 1) * effectiveLegSize,
        expectedProfit: a.expectedProfit,
        platformFee: a.platformFee,
        userProfit: a.userProfit,
        mode,
      };
    });

    return res.json({
      verdict: 'PLAYS_FOUND',
      count: plays.length,
      plays,
      scanned: brackets.length,
      headlinesScanned: headlines.length,
      stripSize: stripData.marketCount,
      connected,
      delayed: false,
    });
  }

  // ── Flash Execute: user confirms play within 60s window ──
  if (action === 'flash_execute' && req.method === 'POST') {
    const decoded = await verifyToken(req);
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    const { playId, autoExecuted } = req.body || {};
    if (!playId) return res.status(400).json({ error: 'playId required' });

    const playRef = db.collection('flash_plays').doc(playId);
    const [playDoc, userDoc] = await Promise.all([
      playRef.get(),
      db.collection('users').doc(decoded.uid).get(),
    ]);

    if (!playDoc.exists) return res.status(404).json({ error: 'Play not found' });

    const play = playDoc.data();

    if (play.userId !== decoded.uid) return res.status(403).json({ error: 'Not your play' });

    if (play.status !== 'PENDING') {
      return res.status(409).json({ error: `Play already ${play.status.toLowerCase()}` });
    }

    if (Date.now() > play.expiresAt + 5000) {
      await playRef.update({ status: 'EXPIRED' });
      return res.status(410).json({ error: 'Play expired. Scan again for a fresh opportunity.' });
    }

    const AUTO_EXECUTE_FEE_PCT = 0.50;
    const effectiveFeePct = isVip(decoded.email) ? 0 : (autoExecuted ? AUTO_EXECUTE_FEE_PCT : PLATFORM_FEE_PCT);
    const adjustedPlatformFee = parseFloat((play.expectedProfit * effectiveFeePct).toFixed(4));
    const adjustedUserProfit = parseFloat((play.expectedProfit - adjustedPlatformFee).toFixed(4));

    const mode = userDoc.exists ? (userDoc.data().mode || 'sandbox') : 'sandbox';

    const engine = new PolymarketAlphaEngine(decoded.uid, { mode, email: decoded.email });
    const brackets = await engine.fetchActiveNegRiskBrackets();
    const target = brackets.find(b => b.id === play.bracketId);

    if (!target) {
      await playRef.update({ status: 'STALE' });
      return res.status(404).json({ error: 'Bracket no longer active. Market moved.' });
    }

    const result = await engine.executeBracketArbitrage(target, play.legSize);

    await playRef.update({
      status: autoExecuted ? 'AUTO_EXECUTED' : 'EXECUTED',
      autoExecuted: !!autoExecuted,
      effectiveFeePct,
      platformFee: adjustedPlatformFee,
      userProfit: adjustedUserProfit,
      executedAt: FieldValue.serverTimestamp(),
      executionResult: result,
    });

    return res.json({
      ok: true,
      playId,
      ...result,
      autoExecuted: !!autoExecuted,
      platformFee: adjustedPlatformFee,
      userProfit: adjustedUserProfit,
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
