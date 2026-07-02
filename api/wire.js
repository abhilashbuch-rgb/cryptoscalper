const crypto = require('crypto');
const { db, FieldValue } = require('../lib/firebase-config');
const { getStrip, matchHeadline } = require('../lib/market-strip');
const { submitMarketOrder, getCredentialsFromEnv } = require('../lib/polymarket-clob');

const WIRE_SECRET = process.env.WIRE_WEBHOOK_SECRET;
const WIRE_LEG_SIZE = parseInt(process.env.WIRE_LEG_SIZE || '25', 10);
const WIRE_MIN_SCORE = parseInt(process.env.WIRE_MIN_SCORE || '3', 10);
const PLATFORM_FEE_PCT = 0.10;

function verifySignature(req) {
  if (!WIRE_SECRET) return true;
  const sig = req.headers['x-wire-signature'] || req.headers['x-webhook-signature'] || '';
  if (!sig) return false;
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', WIRE_SECRET).update(body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function extractHeadline(body) {
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return body.slice(0, 500); }
  }

  if (!body || typeof body !== 'object') return null;

  return body.headline
    || body.title
    || body.text
    || body.content
    || body.message
    || body.summary
    || (body.items && body.items[0] && (body.items[0].title || body.items[0].headline))
    || (body.articles && body.articles[0] && body.articles[0].title)
    || null;
}

module.exports = async (req, res) => {
  const entryTime = process.hrtime.bigint();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Wire-Signature,X-Webhook-Signature,Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!verifySignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const headline = extractHeadline(req.body);
  if (!headline) {
    return res.status(400).json({ error: 'No headline found in payload' });
  }

  const matchStart = process.hrtime.bigint();

  let stripData;
  try {
    stripData = await getStrip();
  } catch (err) {
    return res.status(503).json({ error: 'Strip unavailable', detail: err.message });
  }

  const matches = matchHeadline(headline, stripData);
  const matchElapsed = Number(process.hrtime.bigint() - matchStart) / 1e6;

  if (matches.length === 0) {
    const totalElapsed = Number(process.hrtime.bigint() - entryTime) / 1e6;
    return res.status(200).json({
      action: 'NO_MATCH',
      headline,
      matchMs: matchElapsed.toFixed(2),
      totalMs: totalElapsed.toFixed(2),
      stripSize: stripData.marketCount,
    });
  }

  const best = matches[0];
  const mode = process.env.WIRE_MODE || 'sandbox';

  const wireId = `wire_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  const wireDoc = {
    wireId,
    headline,
    source: req.headers['x-wire-source'] || 'unknown',
    matchScore: best.score,
    matchedKeys: best.matchedKeys,
    matchedMarketId: best.market.id,
    matchedQuestion: best.market.question || best.market.title || null,
    mode,
    matchMs: matchElapsed.toFixed(2),
    createdAt: FieldValue.serverTimestamp(),
  };

  if (best.score < WIRE_MIN_SCORE) {
    wireDoc.action = 'LOW_CONFIDENCE';
    wireDoc.threshold = WIRE_MIN_SCORE;

    db.collection('wire_events').doc(wireId).set(wireDoc).catch(() => {});

    const totalElapsed = Number(process.hrtime.bigint() - entryTime) / 1e6;
    return res.status(200).json({
      action: 'LOW_CONFIDENCE',
      wireId,
      headline,
      score: best.score,
      threshold: WIRE_MIN_SCORE,
      matchMs: matchElapsed.toFixed(2),
      totalMs: totalElapsed.toFixed(2),
    });
  }

  // High-signal match — fire execution non-blocking, respond immediately
  const totalElapsed = Number(process.hrtime.bigint() - entryTime) / 1e6;

  res.status(202).json({
    action: 'TRIGGERED',
    wireId,
    headline,
    matchedMarket: best.market.question || best.market.title,
    score: best.score,
    matchedKeys: best.matchedKeys,
    mode,
    matchMs: matchElapsed.toFixed(2),
    totalMs: totalElapsed.toFixed(2),
  });

  // ── Non-blocking execution after response ──
  executeWireTrade(wireId, wireDoc, best, mode).catch(err => {
    console.error(`[WIRE] Execution failed for ${wireId}:`, err.message);
  });
};

async function executeWireTrade(wireId, wireDoc, match, mode) {
  const market = match.market;
  const execStart = process.hrtime.bigint();

  if (mode === 'sandbox') {
    const simResult = {
      tokenId: market.noTokenId || market.tokens?.[0]?.noTokenId,
      side: 'BUY_NO',
      amount: WIRE_LEG_SIZE,
      simulated: true,
      price: market.noPrice || (market.tokens?.[0]?.currentNoPrice) || 0.5,
    };

    wireDoc.action = 'EXECUTED_SANDBOX';
    wireDoc.execution = simResult;
    wireDoc.execMs = (Number(process.hrtime.bigint() - execStart) / 1e6).toFixed(2);

    await db.collection('wire_events').doc(wireId).set(wireDoc);
    return;
  }

  // Live mode
  const creds = getCredentialsFromEnv();
  if (!creds.apiKey || !creds.apiSecret || !creds.passphrase) {
    wireDoc.action = 'EXECUTION_FAILED';
    wireDoc.error = 'L2 credentials not configured';
    await db.collection('wire_events').doc(wireId).set(wireDoc);
    return;
  }

  try {
    const tokenId = market.noTokenId || market.tokens?.[0]?.noTokenId;
    if (!tokenId) throw new Error('No token ID available for execution');

    const orderResult = await submitMarketOrder(tokenId, 'BUY', WIRE_LEG_SIZE);

    const yesPrice = market.yesPrice || market.tokens?.[0]?.currentYesPrice || 0;
    const edge = yesPrice > 0.5 ? yesPrice - 0.5 : 0;
    const expectedProfit = edge * WIRE_LEG_SIZE;

    const platformFee = expectedProfit > 0 ? expectedProfit * PLATFORM_FEE_PCT : 0;

    wireDoc.action = 'EXECUTED_LIVE';
    wireDoc.execution = {
      tokenId,
      side: 'BUY_NO',
      amount: WIRE_LEG_SIZE,
      orderId: orderResult.orderID || orderResult.id,
      status: orderResult.status || 'SUBMITTED',
    };
    wireDoc.expectedProfit = expectedProfit;
    wireDoc.platformFee = platformFee;
    wireDoc.execMs = (Number(process.hrtime.bigint() - execStart) / 1e6).toFixed(2);

    await db.collection('wire_events').doc(wireId).set(wireDoc);

    if (platformFee > 0) {
      db.collection('platform_revenue').add({
        source: 'wire',
        wireId,
        amount: platformFee,
        timestamp: FieldValue.serverTimestamp(),
      }).catch(() => {});
    }

  } catch (err) {
    wireDoc.action = 'EXECUTION_FAILED';
    wireDoc.error = err.message;
    wireDoc.execMs = (Number(process.hrtime.bigint() - execStart) / 1e6).toFixed(2);
    await db.collection('wire_events').doc(wireId).set(wireDoc);
  }
}
