const { getStrip, matchHeadline, ENTITY_ALIASES } = require('../lib/market-strip');
const { PLATFORM_FEE_PCT } = require('../lib/polymarket-alpha');

const ANOMALY_TTL_MS = 15_000;
const MAX_LIVE_ANOMALIES = 6;
const HURDLE_EDGE = 0.03;
const DEFAULT_LEG_SIZE = 50;
const COOLDOWN_MS = 30_000;

const ALIAS_INDEX = new Map();
for (const [category, aliases] of Object.entries(ENTITY_ALIASES)) {
  for (const alias of aliases) ALIAS_INDEX.set(alias, category);
}

class AnomalyDetector {
  constructor(db, FieldValue) {
    this.db = db;
    this.FieldValue = FieldValue;
    this.strip = null;
    this.brackets = [];
    this.totalDetected = 0;
    this.lastDetectionAt = null;
    this.marketCount = 0;
    this.recentAnomalies = new Map();
    this.headlineBuffer = [];
  }

  getTrackedConditionIds() {
    if (!this.strip) return [];
    const ids = [];
    for (const [, market] of this.strip.marketById) {
      if (market.yesTokenId) ids.push(market.yesTokenId);
      if (market.noTokenId) ids.push(market.noTokenId);
    }
    for (const bracket of this.brackets) {
      for (const t of bracket.tokens) {
        if (t.yesTokenId) ids.push(t.yesTokenId);
        if (t.noTokenId) ids.push(t.noTokenId);
      }
    }
    return [...new Set(ids)];
  }

  async loadMarketStrip() {
    try {
      this.strip = await getStrip();
      this.brackets = this.strip.brackets || [];
      this.marketCount = this.strip.marketCount || 0;
      console.log(`[DETECTOR] Strip refreshed: ${this.marketCount} markets, ${this.brackets.length} brackets`);
    } catch (err) {
      console.error('[DETECTOR] Failed to load strip:', err.message);
    }
  }

  onPriceUpdate(assetId, newPrice, oldPrice) {
    if (!this.strip) return;

    for (const bracket of this.brackets) {
      const token = bracket.tokens.find(t => t.yesTokenId === assetId || t.noTokenId === assetId);
      if (!token) continue;

      if (token.yesTokenId === assetId) {
        token.currentYesPrice = newPrice;
      } else {
        token.currentNoPrice = newPrice;
        token.currentYesPrice = 1 - newPrice;
      }

      const basketSum = bracket.tokens.reduce((s, t) => s + (t.currentYesPrice || 0), 0);
      const edge = basketSum - 1.00;

      if (edge >= HURDLE_EDGE) {
        this.emitAnomaly({
          type: 'NEGRISK_ARB',
          bracket,
          basketSum,
          edge,
          signal: `Basket sum ${basketSum.toFixed(3)} > 1.00 — mathematical arbitrage`,
          triggerSource: 'clob_ws',
        });
      }
    }
  }

  onSportsEvent(event) {
    if (!this.strip) return;

    const matches = matchHeadline(event.headline, this.strip);
    for (const m of matches) {
      if (m.score < 3) continue;
      const categories = [...new Set(m.matchedKeys.map(k => ALIAS_INDEX.get(k)).filter(Boolean))];

      this.emitAnomaly({
        type: 'NEWS_LAG',
        bracket: m.market,
        edge: 0.03,
        signal: event.headline,
        newsSource: event.source,
        matchScore: m.score,
        matchedKeys: m.matchedKeys.slice(0, 5),
        categories,
        triggerSource: 'sports_live',
        priority: event.type === 'SCORE_CHANGE' ? 'HIGH' : 'NORMAL',
      });
    }
  }

  onHeadline(headline) {
    if (!this.strip) return;

    const matches = matchHeadline(headline.headline, this.strip);
    for (const m of matches) {
      if (m.score < 3) continue;
      const categories = [...new Set(m.matchedKeys.map(k => ALIAS_INDEX.get(k)).filter(Boolean))];

      this.emitAnomaly({
        type: 'NEWS_LAG',
        bracket: m.market,
        edge: 0.02,
        signal: headline.headline,
        newsSource: headline.source,
        matchScore: m.score,
        matchedKeys: m.matchedKeys.slice(0, 5),
        categories,
        triggerSource: 'news_scan',
        priority: (headline.upvotes || 0) > 50 ? 'HIGH' : 'NORMAL',
      });
    }
  }

  emitAnomaly(anomaly) {
    const bracket = anomaly.bracket;
    const bracketId = bracket.id || bracket.slug || 'unknown';

    if (this.recentAnomalies.has(bracketId)) {
      const prev = this.recentAnomalies.get(bracketId);
      if (Date.now() - prev.detectedAt < COOLDOWN_MS) return;
    }

    const isBracket = !!bracket.tokens;
    let confidence, mktPrice, evtProb;

    if (anomaly.type === 'NEGRISK_ARB') {
      confidence = Math.min(99, Math.round(
        50 + (anomaly.edge * 100) * 5
          + (bracket.tokens?.length >= 3 ? 10 : 0)
          + (anomaly.edge >= 0.05 ? 15 : 0)
          + (bracket.totalVolume > 100000 ? 5 : 0)
      ));
      mktPrice = parseFloat((1 / (bracket.tokens?.length || 1)).toFixed(4));
      evtProb = parseFloat((mktPrice + anomaly.edge).toFixed(4));
    } else {
      confidence = Math.min(95, Math.round(
        35 + (anomaly.matchScore || 0) * 5
          + (anomaly.priority === 'HIGH' ? 15 : 0)
          + (anomaly.triggerSource === 'sports_live' ? 12 : 0)
          + (anomaly.newsSource?.startsWith('espn') ? 10 : 0)
      ));
      if (isBracket) {
        const basketSum = bracket.tokens.reduce((s, t) => s + (t.currentYesPrice || 0), 0);
        anomaly.edge = Math.max(0.01, basketSum - 1.00);
        mktPrice = parseFloat((1 / bracket.tokens.length).toFixed(4));
      } else {
        const yp = bracket.yesPrice || 0.5;
        mktPrice = parseFloat(yp.toFixed(4));
      }
      evtProb = parseFloat(Math.min(0.99, mktPrice + anomaly.edge).toFixed(4));
    }

    const categories = anomaly.categories || [];
    const isWorldCup = categories.includes('WORLD_CUP');
    const expectedProfit = parseFloat((anomaly.edge * DEFAULT_LEG_SIZE).toFixed(4));
    const platformFee = parseFloat((expectedProfit * PLATFORM_FEE_PCT).toFixed(4));
    const userProfit = parseFloat((expectedProfit - platformFee).toFixed(4));

    const anomalyId = `live_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const doc = {
      anomalyId,
      anomalyType: anomaly.type,
      bracketId,
      bracket: bracket.title || bracket.slug || bracketId,
      signal: anomaly.signal,
      newsSource: anomaly.newsSource || null,
      categories,
      marketPrice: mktPrice,
      eventProb: evtProb,
      edge: anomaly.edge,
      edgePct: (anomaly.edge * 100).toFixed(2),
      confidence,
      expectedProfit,
      platformFee,
      userProfit,
      triggerSource: anomaly.triggerSource,
      priority: anomaly.priority || 'NORMAL',
      isWorldCup,
      ttlSeconds: 15,
      platform: 'Polymarket',
      status: 'LIVE',
      detectedAt: this.FieldValue.serverTimestamp(),
      expiresAt: Date.now() + ANOMALY_TTL_MS,
    };

    if (bracket.tokens) {
      doc.legs = bracket.tokens.map(t => ({
        slug: t.slug,
        yesPrice: t.currentYesPrice || 0,
        noPrice: 1 - (t.currentYesPrice || 0),
      }));
      doc.totalDeployed = bracket.tokens.length * DEFAULT_LEG_SIZE;
    }

    this.db.collection('live_anomalies').doc(anomalyId).set(doc).catch(err => {
      console.error('[DETECTOR] Firestore write failed:', err.message);
    });

    this.recentAnomalies.set(bracketId, { detectedAt: Date.now(), anomalyId });

    this.totalDetected++;
    this.lastDetectionAt = new Date().toISOString();

    const src = anomaly.triggerSource === 'clob_ws' ? 'WS' : anomaly.triggerSource === 'sports_live' ? 'ESPN' : 'NEWS';
    console.log(`[ANOMALY] ${anomaly.type} | ${src} | ${confidence}% | ${(anomaly.edge * 100).toFixed(1)}% edge | ${(bracket.title || bracketId).slice(0, 50)}`);

    this.pruneExpired();
  }

  async pruneExpired() {
    try {
      const expired = await this.db.collection('live_anomalies')
        .where('expiresAt', '<', Date.now())
        .limit(20)
        .get();

      if (expired.empty) return;

      const batch = this.db.batch();
      expired.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    } catch {}
  }
}

module.exports = { AnomalyDetector };
