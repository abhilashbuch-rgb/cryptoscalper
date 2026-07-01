const { db, FieldValue } = require('./firebase-config');
const { submitMarketOrder, getCredentialsFromEnv } = require('./polymarket-clob');

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

const DEFAULT_HURDLE = 1.03;
const MIN_BALANCE = 500;
const DEFAULT_LEG_SIZE = 50;
const MAX_POSITION_PCT = 0.10;
const DRAWDOWN_BREAKER = 0.05;
const PLATFORM_FEE_PCT = 0;

// Gamma metadata cache — event structure doesn't change, only prices do
const METADATA_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let cachedMetadata = null;
let metadataCachedAt = 0;

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

  async executeBracketArbitrage(bracket, legSize, opts = {}) {
    const size = legSize || this.legSize;
    const results = [];

    if (this.mode === 'sandbox') {
      for (const token of bracket.tokens) {
        results.push({
          token: token.slug,
          side: 'BUY_NO',
          amount: size,
          simulated: true,
          price: 1 - token.currentYesPrice,
        });
      }
    } else {
      // Prefer user's own stored L2 credentials; fall back to platform env credentials
      let creds = getCredentialsFromEnv();
      try {
        const userSnap = await this.userRef.get();
        const ud = userSnap.exists ? userSnap.data() : {};
        if (ud.poly_api_key && ud.poly_api_secret && ud.poly_passphrase) {
          creds = {
            privateKey: ud.poly_private_key || creds.privateKey,
            apiKey:     ud.poly_api_key,
            apiSecret:  ud.poly_api_secret,
            passphrase: ud.poly_passphrase,
          };
        }
      } catch {}
      const hasL2 = creds.apiKey && creds.apiSecret && creds.passphrase;

      for (const token of bracket.tokens) {
        try {
          if (!hasL2) throw new Error('L2 API credentials not configured');
          const orderResult = await submitMarketOrder(token.noTokenId, 'BUY', size, creds);
          results.push({
            token: token.slug,
            side: 'BUY_NO',
            amount: size,
            live: true,
            orderId: orderResult.orderID || orderResult.id,
            status: orderResult.status || 'SUBMITTED',
            result: orderResult,
          });
        } catch (err) {
          results.push({
            token: token.slug,
            side: 'BUY_NO',
            amount: size,
            live: true,
            error: err.message,
            status: 'FAILED',
          });
        }
      }
    }

    const basketSum = bracket.tokens.reduce((s, t) => s + t.currentYesPrice, 0);
    const edge = basketSum - 1.00;
    const totalDeployed = results.length * size;
    const expectedProfit = edge * size;
    const platformFee = 0;
    const userProfit = expectedProfit;

    await this.userRef.collection('polymarket_history').add({
      bracketTitle: bracket.title,
      bracketId: bracket.id,
      legs: results.length,
      legSize: size,
      totalDeployed,
      basketSum,
      edge,
      expectedProfit,
      userProfit,
      mode: this.mode,
      timestamp: FieldValue.serverTimestamp(),
    });

    for (const token of bracket.tokens) {
      const leg = results.find(r => r.token === token.slug);
      if (leg && leg.status !== 'FAILED') {
        await this.userRef.collection('open_positions').add({
          tokenId: token.noTokenId,
          bracketTitle: bracket.title,
          bracketId: bracket.id,
          tokenSlug: token.slug,
          side: 'BUY_NO',
          entryPrice: 1 - token.currentYesPrice,
          size,
          status: 'OPEN',
          mode: this.mode,
          openedAt: FieldValue.serverTimestamp(),
          take_profit_pct: opts.take_profit_pct ?? null,
        });
      }
    }

    return { legs: results, expectedProfit, platformFee, userProfit };
  }

  async fetchBracketMetadata() {
    const now = Date.now();
    if (cachedMetadata && (now - metadataCachedAt) < METADATA_CACHE_TTL_MS) {
      return cachedMetadata;
    }

    const res = await fetch(`${GAMMA_API}/events?active=true&closed=false&limit=25`, {
      signal: AbortSignal.timeout(8000),
    });
    const events = await res.json();

    const brackets = [];
    for (const ev of events) {
      if (!ev.markets || ev.markets.length < 2) continue;

      const tokens = ev.markets
        .filter(m => m.clobTokenIds)
        .map(m => {
          const ids = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : (m.clobTokenIds || []);
          if (ids.length < 2) return null;
          return {
            slug: m.conditionId || m.slug || m.question,
            questionSlug: m.slug,
            yesTokenId: ids[0],
            noTokenId: ids[1],
            volume: parseFloat(m.volume || 0),
            question: m.question,
          };
        })
        .filter(Boolean);

      if (tokens.length >= 2) {
        brackets.push({ title: ev.title, id: ev.id, slug: ev.slug, tokens, endDate: ev.endDate || null });
      }
    }

    cachedMetadata = brackets;
    metadataCachedAt = now;
    return brackets;
  }

  async refreshClobPrices(brackets) {
    const tokenIds = [];
    for (const b of brackets) {
      for (const t of b.tokens) tokenIds.push(t.yesTokenId);
    }

    const priceMap = {};
    const batchSize = 50;
    const fetches = [];

    for (let i = 0; i < tokenIds.length; i += batchSize) {
      const batch = tokenIds.slice(i, i + batchSize);
      fetches.push(
        fetch(`${CLOB_API}/prices`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(batch.map(id => ({ token_id: id }))),
          signal: AbortSignal.timeout(4000),
        })
          .then(r => r.json())
          .then(data => {
            for (const [tokenId, val] of Object.entries(data)) {
              if (val && typeof val === 'object') {
                priceMap[tokenId] = parseFloat(val.SELL || val.BUY || 0);
              }
            }
          })
          .catch(() => {})
      );
    }

    await Promise.all(fetches);

    return brackets.map(b => ({
      ...b,
      tokens: b.tokens.map(t => ({
        ...t,
        currentYesPrice: priceMap[t.yesTokenId] || 0,
        currentNoPrice: 1 - (priceMap[t.yesTokenId] || 0),
      })),
      totalVolume: b.tokens.reduce((s, t) => s + t.volume, 0),
    }));
  }

  async fetchActiveNegRiskBrackets() {
    const metadata = await this.fetchBracketMetadata();
    return this.refreshClobPrices(metadata);
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

module.exports = { PolymarketAlphaEngine, DEFAULT_HURDLE, MIN_BALANCE, PLATFORM_FEE_PCT };
