/**
 * Cron: runs every 2 minutes, scans for NegRisk arbitrage + news-lag anomalies,
 * writes live results to Firestore `live_anomalies` so flash_scan always has
 * fresh data to serve without doing an expensive on-demand scan.
 */
const { db, FieldValue } = require('../../lib/firebase-config');
const { PolymarketAlphaEngine, PLATFORM_FEE_PCT } = require('../../lib/polymarket-alpha');
const { scanAllSources } = require('../../lib/news-scanner');
const { getStrip, matchHeadline, ENTITY_ALIASES } = require('../../lib/market-strip');
const { getRiskBoundaries } = require('../../lib/risk-desk');

const ALIAS_INDEX = new Map();
for (const [category, aliases] of Object.entries(ENTITY_ALIASES)) {
  for (const alias of aliases) ALIAS_INDEX.set(alias, category);
}

const MAX_ANOMALIES = 3;
const LIVE_TTL_MS  = 2.5 * 60 * 1000; // 2.5 minutes — outlasts the 2-min cron interval

module.exports = async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const start = Date.now();
  try {
    const [riskBounds, headlines, stripData] = await Promise.all([
      getRiskBoundaries(),
      scanAllSources(),
      getStrip(),
    ]);

    if (riskBounds.system_level === 'HALT') {
      return res.json({ ok: true, skipped: true, reason: 'risk_halt' });
    }

    // Use a placeholder userId — engine only needs it for userRef (not needed here)
    const engine = new PolymarketAlphaEngine('_cron', { mode: 'live' });
    const brackets = await engine.fetchActiveNegRiskBrackets();

    const blacklist = new Set(riskBounds.blacklist || []);
    const eligible  = brackets.filter(b => !b.tokens.some(t => blacklist.has(t.slug)));

    const anomalies = [];

    // ── NegRisk basket arbitrage ──
    for (const bracket of eligible) {
      const basketSum = bracket.tokens.reduce((s, t) => s + t.currentYesPrice, 0);
      const edge = basketSum - 1.00;
      if (edge >= 0.01) {
        const expectedProfit = edge * 50; // base at $50/leg default
        const platformFee    = parseFloat((expectedProfit * PLATFORM_FEE_PCT).toFixed(4));
        const userProfit     = parseFloat((expectedProfit - platformFee).toFixed(4));
        const confidence     = Math.min(99, Math.round(
          50 + (edge * 100) * 5
            + (bracket.tokens.length >= 3 ? 10 : 0)
            + (edge >= 0.05 ? 15 : 0)
            + (bracket.totalVolume > 100000 ? 5 : 0)
        ));

        const bracketKeys = (bracket.title || '').toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').split(/\s+/);
        const categories  = [...new Set(bracketKeys.map(k => ALIAS_INDEX.get(k)).filter(Boolean))];

        anomalies.push({
          anomalyType:    'NEGRISK_ARB',
          bracketId:      bracket.id,
          bracket:        bracket.title,
          legs:           bracket.tokens.map(t => ({ slug: t.slug, noPrice: 1 - t.currentYesPrice })),
          basketSum,
          edge,
          edgePct:        (edge * 100).toFixed(2),
          confidence,
          expectedProfit,
          platformFee,
          userProfit,
          totalDeployed:  bracket.tokens.length * 50,
          signal:         `Basket sum ${basketSum.toFixed(3)} > 1.00 — mathematical arbitrage`,
          categories,
          marketPrice:    parseFloat((1 / bracket.tokens.length).toFixed(4)),
          eventProb:      parseFloat(((1 / bracket.tokens.length) + edge).toFixed(4)),
          newsSource:     null,
          sortScore:      confidence + (edge * 500) + (categories.includes('WORLD_CUP') ? 50 : 0),
        });
      }
    }

    // ── News-lag detection ──
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
      if (match.score < 2) continue;
      const market    = match.market;
      const isBracket = !!market.tokens;
      let edge, mktPrice, evtProb, confidence;

      if (isBracket) {
        const sum = market.tokens.reduce((s, t) => s + (t.currentYesPrice || 0), 0);
        edge     = Math.max(0.01, sum - 1.00);
        mktPrice = parseFloat((1 / market.tokens.length).toFixed(4));
        evtProb  = parseFloat((mktPrice + edge).toFixed(4));
        confidence = Math.min(95, Math.round(
          40 + match.score * 5
            + (match.upvotes > 50 ? 10 : 0)
            + (match.source.startsWith('reddit') ? 5 : 0)
            + (match.source === 'google_news' ? 8 : 0)
            + (match.source.startsWith('espn') ? 12 : 0)
        ));
      } else {
        const probability = market.yesPrice || 0.5;
        mktPrice   = probability;
        edge       = Math.max(0.01, Math.abs(probability - 0.5));
        evtProb    = probability > 0.5 ? probability : 1 - probability;
        confidence = Math.min(90, Math.round(
          35 + match.score * 8 + (match.upvotes > 100 ? 15 : 0)
        ));
      }

      const expectedProfit = edge * 50;
      const platformFee    = parseFloat((expectedProfit * PLATFORM_FEE_PCT).toFixed(4));
      const userProfit     = parseFloat((expectedProfit - platformFee).toFixed(4));

      const bracketKeys = ((market.title || market.question || '')).toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').split(/\s+/);
      const categories  = [...new Set(bracketKeys.map(k => ALIAS_INDEX.get(k)).filter(Boolean))];

      anomalies.push({
        anomalyType:    'NEWS_LAG',
        bracketId:      market.id || `news_${Date.now()}`,
        bracket:        market.title || market.question || 'News-matched market',
        legs:           isBracket
          ? market.tokens.map(t => ({ slug: t.slug, noPrice: 1 - (t.currentYesPrice || 0) }))
          : [{ slug: market.conditionId || market.id, noPrice: 1 - (market.yesPrice || 0.5) }],
        edge,
        edgePct:        (edge * 100).toFixed(2),
        confidence,
        expectedProfit,
        platformFee,
        userProfit,
        totalDeployed:  50,
        signal:         match.headline,
        newsSource:     match.source,
        categories,
        marketPrice:    mktPrice,
        eventProb:      evtProb,
        sortScore:      confidence + (match.score * 10) + (match.upvotes > 0 ? 15 : 0) + (categories.includes('WORLD_CUP') ? 50 : 0),
      });
    }

    // ── Closing soon: markets ending within 48h with ≥5% NegRisk edge ──
    const CLOSING_SOON_MS = 48 * 60 * 60 * 1000;
    const now = Date.now();
    for (const bracket of eligible) {
      if (!bracket.endDate) continue;
      const endTs = new Date(bracket.endDate).getTime();
      if (isNaN(endTs) || endTs <= now || endTs > now + CLOSING_SOON_MS) continue;
      const basketSum = bracket.tokens.reduce((s, t) => s + t.currentYesPrice, 0);
      const edge = basketSum - 1.00;
      if (edge < 0.05) continue; // require 5%+ edge for closing-soon
      const expectedProfit = edge * 50;
      const platformFee    = parseFloat((expectedProfit * PLATFORM_FEE_PCT).toFixed(4));
      const userProfit     = parseFloat((expectedProfit - platformFee).toFixed(4));
      const hoursLeft      = Math.round((endTs - now) / 3600000);
      const confidence     = Math.min(99, Math.round(
        60 + (edge * 100) * 4 + (hoursLeft < 12 ? 15 : hoursLeft < 24 ? 8 : 0)
      ));
      const bracketKeys = (bracket.title || '').toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').split(/\s+/);
      const categories  = [...new Set(bracketKeys.map(k => ALIAS_INDEX.get(k)).filter(Boolean))];
      anomalies.push({
        anomalyType:    'CLOSING_SOON',
        bracketId:      bracket.id,
        bracket:        bracket.title,
        legs:           bracket.tokens.map(t => ({ slug: t.slug, noPrice: 1 - t.currentYesPrice })),
        basketSum,
        edge,
        edgePct:        (edge * 100).toFixed(2),
        confidence,
        expectedProfit,
        platformFee,
        userProfit,
        totalDeployed:  bracket.tokens.length * 50,
        signal:         `Closes in ${hoursLeft}h — basket ${basketSum.toFixed(3)} > 1.05 — auto-exits at 5%`,
        categories,
        marketPrice:    parseFloat((1 / bracket.tokens.length).toFixed(4)),
        eventProb:      parseFloat(((1 / bracket.tokens.length) + edge).toFixed(4)),
        newsSource:     null,
        endDate:        bracket.endDate,
        sortScore:      confidence + (edge * 500) + (hoursLeft < 12 ? 40 : 20),
      });
    }

    // Sort and take top MAX_ANOMALIES
    anomalies.sort((a, b) => b.sortScore - a.sortScore);
    const top = anomalies.slice(0, MAX_ANOMALIES);

    // Expire existing live docs first
    const expireSnap = await db.collection('live_anomalies')
      .where('status', '==', 'LIVE')
      .where('source', '==', 'cron')
      .get();
    const batch = db.batch();
    expireSnap.forEach(doc => batch.update(doc.ref, { status: 'EXPIRED' }));
    await batch.commit();

    // Write fresh docs
    const expiresAt   = Date.now() + LIVE_TTL_MS;
    const writeBatch  = db.batch();
    for (const a of top) {
      const ref = db.collection('live_anomalies').doc();
      writeBatch.set(ref, {
        ...a,
        status:     'LIVE',
        expiresAt,
        source:     'cron',
        detectedAt: FieldValue.serverTimestamp(),
      });
    }
    await writeBatch.commit();

    const elapsed = Date.now() - start;
    res.json({ ok: true, anomalies: top.length, elapsed_ms: elapsed, brackets: brackets.length });
  } catch (err) {
    console.error('[anomaly-scan cron]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
