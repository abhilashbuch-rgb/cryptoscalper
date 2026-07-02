const admin = require('firebase-admin');
const { db, FieldValue } = require('../lib/firebase-config');
const { submitMarketOrder, getCredentialsFromEnv } = require('../lib/polymarket-clob');
const { collectFee } = require('../lib/fee-collector');
const { isVip } = require('../lib/vip-accounts');
const CLOB_API = 'https://clob.polymarket.com';
const PLATFORM_FEE_PCT = 0.10;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
}

async function verifyToken(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  try {
    return await admin.auth().verifyIdToken(auth.split('Bearer ')[1]);
  } catch {
    return null;
  }
}

async function fetchCurrentPrices(tokenIds) {
  const priceMap = {};
  const batchSize = 50;

  for (let i = 0; i < tokenIds.length; i += batchSize) {
    const batch = tokenIds.slice(i, i + batchSize);
    const params = batch.map(id => `token_ids=${id}`).join('&');
    try {
      const r = await fetch(`${CLOB_API}/prices?${params}`, { signal: AbortSignal.timeout(4000) });
      const data = await r.json();
      Object.assign(priceMap, data);
    } catch {}
  }

  return priceMap;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = req.query?.action;

  // ── Cron: scan all users' open positions and auto-exit ──
  if (action === 'cron_check') {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization;
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const usersSnap = await db.collectionGroup('open_positions')
        .where('status', '==', 'OPEN')
        .limit(200)
        .get();

      if (usersSnap.empty) return res.json({ checked: 0, exited: 0 });

      const positionsByUser = {};
      const allTokenIds = new Set();

      usersSnap.docs.forEach(doc => {
        const data = doc.data();
        const uid = doc.ref.parent.parent.id;
        if (!positionsByUser[uid]) positionsByUser[uid] = [];
        positionsByUser[uid].push({ ref: doc.ref, ...data });
        if (data.tokenId) allTokenIds.add(data.tokenId);
      });

      const prices = await fetchCurrentPrices([...allTokenIds]);

      let exited = 0;

      for (const [uid, positions] of Object.entries(positionsByUser)) {
        const userDoc = await db.collection('users').doc(uid).get();
        const userData = userDoc.exists ? userDoc.data() : {};
        const settings = userData.settings || {};
        const mode = userData.mode || 'sandbox';

        const globalTP = settings.take_profit_pct ?? 20;
        const globalSL = settings.stop_loss_pct ?? null;

        for (const pos of positions) {
          const currentPrice = prices[pos.tokenId] ? parseFloat(prices[pos.tokenId]) : null;
          if (currentPrice === null) continue;

          const entryPrice = pos.entryPrice;
          const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;

          const tp = pos.take_profit_pct ?? globalTP;
          const sl = pos.stop_loss_pct ?? globalSL;

          let exitReason = null;

          if (tp !== null && pnlPct >= tp) {
            exitReason = 'TAKE_PROFIT';
          } else if (sl !== null && pnlPct <= -sl) {
            exitReason = 'STOP_LOSS';
          }

          if (!exitReason) {
            await pos.ref.update({
              currentPrice,
              pnlPct: Math.round(pnlPct * 100) / 100,
              lastChecked: FieldValue.serverTimestamp(),
            });
            continue;
          }

          const profit = (currentPrice - entryPrice) * pos.size;
          const platformFee = (mode !== 'live' || profit <= 0)
            ? 0
            : profit * PLATFORM_FEE_PCT;
          const userProfit = profit - platformFee;

          if (mode === 'live') {
            try {
              const creds = getCredentialsFromEnv();
              if (creds.apiKey && creds.apiSecret && creds.passphrase) {
                await submitMarketOrder(pos.tokenId, 'SELL', pos.size);
              }
            } catch (err) {
              await pos.ref.update({
                lastExitError: err.message,
                lastChecked: FieldValue.serverTimestamp(),
              });
              continue;
            }
            if (platformFee > 0 && userData.poly_private_key) {
              collectFee(userData.poly_private_key, platformFee).catch(err =>
                console.error('[FEE] auto-exit collectFee failed:', err.message)
              );
            }
          }

          await pos.ref.update({
            status: 'CLOSED',
            exitReason,
            exitPrice: currentPrice,
            pnlPct: Math.round(pnlPct * 100) / 100,
            profit,
            platformFee,
            userProfit,
            closedAt: FieldValue.serverTimestamp(),
          });

          await db.collection('users').doc(uid).collection('polymarket_history').add({
            type: 'AUTO_EXIT',
            exitReason,
            bracketTitle: pos.bracketTitle || '',
            tokenSlug: pos.tokenSlug || '',
            side: 'SELL',
            entryPrice,
            exitPrice: currentPrice,
            size: pos.size,
            pnlPct: Math.round(pnlPct * 100) / 100,
            profit,
            userProfit,
            mode,
            timestamp: FieldValue.serverTimestamp(),
          });

          exited++;
        }
      }

      return res.json({ checked: usersSnap.size, exited });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Authenticated endpoints ──
  const decoded = await verifyToken(req);
  if (!decoded) return res.status(401).json({ error: 'Unauthorized' });
  const uid = decoded.uid;

  // ── Get open positions with live P&L ──
  if (action === 'positions') {
    try {
      const snap = await db.collection('users').doc(uid).collection('open_positions')
        .where('status', '==', 'OPEN')
        .orderBy('openedAt', 'desc')
        .limit(20)
        .get();

      if (snap.empty) return res.json({ positions: [] });

      const tokenIds = [];
      const positions = snap.docs.map(d => {
        const data = d.data();
        if (data.tokenId) tokenIds.push(data.tokenId);
        return { id: d.id, ...data };
      });

      const prices = await fetchCurrentPrices(tokenIds);

      const enriched = positions.map(pos => {
        const currentPrice = prices[pos.tokenId] ? parseFloat(prices[pos.tokenId]) : pos.entryPrice;
        const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const profit = (currentPrice - pos.entryPrice) * pos.size;
        return {
          id: pos.id,
          bracketTitle: pos.bracketTitle,
          tokenSlug: pos.tokenSlug,
          side: pos.side,
          entryPrice: pos.entryPrice,
          currentPrice,
          size: pos.size,
          pnlPct: Math.round(pnlPct * 100) / 100,
          profit: Math.round(profit * 100) / 100,
          take_profit_pct: pos.take_profit_pct ?? null,
          stop_loss_pct: pos.stop_loss_pct ?? null,
          openedAt: pos.openedAt?.toDate?.()?.toISOString() || null,
          mode: pos.mode,
        };
      });

      return res.json({ positions: enriched });
    } catch (err) {
      return res.json({ positions: [] });
    }
  }

  // ── Update exit rules for a specific position ──
  if (action === 'set_exit' && req.method === 'POST') {
    const { positionId, take_profit_pct, stop_loss_pct } = req.body || {};
    if (!positionId) return res.status(400).json({ error: 'positionId required' });

    const posRef = db.collection('users').doc(uid).collection('open_positions').doc(positionId);
    const update = {};
    if (take_profit_pct !== undefined) update.take_profit_pct = take_profit_pct;
    if (stop_loss_pct !== undefined) update.stop_loss_pct = stop_loss_pct;

    await posRef.update(update);
    return res.json({ ok: true });
  }

  // ── Manual exit (sell now) ──
  if (action === 'exit_now' && req.method === 'POST') {
    const { positionId } = req.body || {};
    if (!positionId) return res.status(400).json({ error: 'positionId required' });

    const posRef = db.collection('users').doc(uid).collection('open_positions').doc(positionId);
    const posDoc = await posRef.get();
    if (!posDoc.exists) return res.status(404).json({ error: 'Position not found' });
    const pos = posDoc.data();
    if (pos.status !== 'OPEN') return res.status(409).json({ error: 'Position already closed' });

    const userDoc = await db.collection('users').doc(uid).get();
    const mode = userDoc.exists ? (userDoc.data().mode || 'sandbox') : 'sandbox';

    const prices = await fetchCurrentPrices([pos.tokenId]);
    const currentPrice = prices[pos.tokenId] ? parseFloat(prices[pos.tokenId]) : pos.entryPrice;
    const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const profit = (currentPrice - pos.entryPrice) * pos.size;
    const feeExempt = isVip(decoded.email);
    const platformFee = (feeExempt || mode !== 'live' || profit <= 0)
      ? 0
      : profit * PLATFORM_FEE_PCT;
    const userProfit = profit - platformFee;

    if (mode === 'live') {
      try {
        // Use user's own L2 credentials if available; fall back to platform credentials
        const userData = userDoc.exists ? userDoc.data() : {};
        let creds = getCredentialsFromEnv();
        if (userData.poly_api_key && userData.poly_api_secret && userData.poly_passphrase) {
          creds = {
            privateKey: userData.poly_private_key || creds.privateKey,
            apiKey:     userData.poly_api_key,
            apiSecret:  userData.poly_api_secret,
            passphrase: userData.poly_passphrase,
          };
        }
        if (creds.apiKey && creds.apiSecret && creds.passphrase) {
          await submitMarketOrder(pos.tokenId, 'SELL', pos.size, creds);
        }
        if (platformFee > 0 && userData.poly_private_key) {
          collectFee(userData.poly_private_key, platformFee).catch(err =>
            console.error('[FEE] manual-exit collectFee failed:', err.message)
          );
        }
      } catch (err) {
        return res.status(500).json({ error: `Exit failed: ${err.message}` });
      }
    }

    await posRef.update({
      status: 'CLOSED',
      exitReason: 'MANUAL',
      exitPrice: currentPrice,
      pnlPct: Math.round(pnlPct * 100) / 100,
      profit,
      platformFee,
      userProfit,
      closedAt: FieldValue.serverTimestamp(),
    });

    await db.collection('users').doc(uid).collection('polymarket_history').add({
      type: 'MANUAL_EXIT',
      exitReason: 'MANUAL',
      bracketTitle: pos.bracketTitle || '',
      tokenSlug: pos.tokenSlug || '',
      side: 'SELL',
      entryPrice: pos.entryPrice,
      exitPrice: currentPrice,
      size: pos.size,
      pnlPct: Math.round(pnlPct * 100) / 100,
      profit,
      userProfit,
      mode,
      timestamp: FieldValue.serverTimestamp(),
    });

    return res.json({
      ok: true,
      exitPrice: currentPrice,
      pnlPct: Math.round(pnlPct * 100) / 100,
      profit,
      userProfit,
    });
  }

  // ── Closed positions history ──
  if (action === 'history') {
    try {
      const snap = await db.collection('users').doc(uid).collection('polymarket_history')
        .orderBy('timestamp', 'desc')
        .limit(20)
        .get();

      const positions = snap.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          bracketTitle: data.bracketTitle,
          tokenSlug: data.tokenSlug,
          exitReason: data.exitReason || data.type,
          entryPrice: data.entryPrice,
          exitPrice: data.exitPrice,
          size: data.size,
          pnlPct: data.pnlPct,
          profit: data.profit,
          userProfit: data.userProfit,
          platformFee: data.platformFee,
          mode: data.mode,
          closedAt: data.timestamp?.toDate?.()?.toISOString() || null,
        };
      });

      return res.json({ positions });
    } catch {
      return res.json({ positions: [] });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
};
