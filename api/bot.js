const admin = require('firebase-admin');
const { db, FieldValue } = require('../lib/firebase-config');

const STRATEGIES = [
  { id: 'brilliant', name: 'WICK Scalper', description: 'Momentum-based scalper. Buys dips, sells rips. 2-minute cadence with 12-signal scoring.', tier: 'free', risk: 'balanced', winRateGuide: '58–64%', locked: false },
  { id: 'turtle',    name: 'Turtle Trend', description: 'Slow and steady trend follower. Wider stops, longer holds. Better for volatile markets.', tier: 'free', risk: 'conservative', winRateGuide: '52–58%', locked: false },
  { id: 'sniper',    name: 'Sniper',       description: 'High-conviction only. Waits for extreme confluence before entering. Fewer trades, bigger wins.', tier: 'pro', risk: 'aggressive', winRateGuide: '45–55%', locked: false },
  { id: 'grid',      name: 'Grid Trader',  description: 'Places layered limit orders across a price range. Captures chop. Best in sideways markets.', tier: 'pro', risk: 'balanced', winRateGuide: '60–70%', locked: true },
];

const BADGE_CATALOG = [
  { id: 'first_trade',  name: 'First Blood',     tier: 'bronze',   crest: '⚔️', category: 'Trading', desc: 'Execute your first trade' },
  { id: 'ten_trades',   name: 'Market Regular',   tier: 'bronze',   crest: '📊', category: 'Trading', desc: 'Complete 10 trades' },
  { id: 'first_win',    name: 'Green Candle',     tier: 'bronze',   crest: '🟢', category: 'Trading', desc: 'Win your first trade' },
  { id: 'win_streak_5', name: 'Hot Streak',       tier: 'silver',   crest: '🔥', category: 'Trading', desc: '5 consecutive winning trades' },
  { id: 'pnl_100',      name: 'Centurion',        tier: 'silver',   crest: '💰', category: 'Profit',  desc: 'Earn $100 total P&L' },
  { id: 'pnl_1000',     name: 'Grand Master',     tier: 'gold',     crest: '👑', category: 'Profit',  desc: 'Earn $1,000 total P&L' },
  { id: 'multi_broker',  name: 'Multi-Broker',    tier: 'gold',     crest: '🔗', category: 'Setup',   desc: 'Connect 2+ brokers' },
  { id: 'live_trader',   name: 'Live Wire',       tier: 'platinum', crest: '⚡', category: 'Setup',   desc: 'Execute a live trade with real money' },
  { id: 'month_active',  name: 'Iron Hands',      tier: 'diamond',  crest: '💎', category: 'Loyalty', desc: 'Stay active for 30 days' },
];

async function verifyToken(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  try {
    return await admin.auth().verifyIdToken(auth.split('Bearer ')[1]);
  } catch {
    return null;
  }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
}

async function isAllowed(email, uid) {
  // Check env var allowlist first (comma-separated emails)
  const envList = process.env.ALLOWED_EMAILS;
  if (envList) {
    const emails = envList.split(',').map(e => e.trim().toLowerCase());
    if (emails.includes(email)) return true;
  }

  // Check Firestore allowlist collection
  try {
    const doc = await db.collection('allowlist').doc(email).get();
    if (doc.exists) return true;
    // Also check by UID
    const uidDoc = await db.collection('allowlist').doc(uid).get();
    if (uidDoc.exists) return true;
  } catch {}

  return false;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = req.query?.action;

  // Public endpoint — no auth required
  if (action === 'live_feed') {
    try {
      const snap = await db.collection('live_trades').orderBy('timestamp', 'desc').limit(15).get();
      const trades = snap.docs.map(d => {
        const t = d.data();
        const ago = Math.floor((Date.now() - (t.timestamp?.toMillis?.() || Date.now())) / 1000);
        return { symbol: t.symbol, pnl: t.pnl || 0, ago };
      });
      return res.json({ trades });
    } catch {
      return res.json({ trades: [] });
    }
  }

  const decoded = await verifyToken(req);
  if (!decoded) return res.status(401).json({ error: 'Unauthorized' });
  const uid = decoded.uid;
  const email = (decoded.email || '').toLowerCase();
  const userRef = db.collection('users').doc(uid);

  // ── Invite-only gate ──
  const allowed = await isAllowed(email, uid);
  if (!allowed && action !== 'login_notify' && action !== 'waitlist' && action !== 'redeem_code') {
    return res.status(403).json({ error: 'invite_only', message: 'WICK is currently invite-only. You have been added to the waitlist.' });
  }

  // ── Login notification ──
  if (action === 'login_notify') {
    await userRef.set({ last_login: FieldValue.serverTimestamp(), email: decoded.email || '' }, { merge: true });
    return res.json({ ok: true });
  }

  // ── Redeem invite code (adds user to allowlist) ──
  if (action === 'redeem_code' && req.method === 'POST') {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Code required' });
    const clean = code.trim().toUpperCase();
    const codeRef = db.collection('invite_codes').doc(clean);
    const codeDoc = await codeRef.get();
    if (!codeDoc.exists) return res.status(403).json({ error: 'Invalid invite code' });
    const codeData = codeDoc.data();
    if (codeData.used) return res.status(403).json({ error: 'This code has already been used' });
    if (codeData.active === false) return res.status(403).json({ error: 'This code is no longer active' });

    await codeRef.update({ used: true, used_by: email, used_by_uid: uid, used_at: FieldValue.serverTimestamp() });
    await db.collection('allowlist').doc(email).set({ uid, email, code: clean, granted: FieldValue.serverTimestamp() });
    await userRef.set({ invited: true, invite_code: clean, updated: FieldValue.serverTimestamp() }, { merge: true });
    return res.json({ ok: true });
  }

  // ── Waitlist ──
  if (action === 'waitlist') {
    const { platform } = req.body || {};
    await db.collection('waitlist').doc(`${uid}_${platform}`).set({
      uid, platform, email: decoded.email || '', joined: FieldValue.serverTimestamp(),
    });
    return res.json({ ok: true });
  }

  // ── Connect broker ──
  if (action === 'connect' && req.method === 'POST') {
    const body = req.body || {};
    const broker = body.broker;
    const update = { broker, configured: true, updated: FieldValue.serverTimestamp() };

    if (broker === 'alpaca') {
      update.alpaca_key_id = body.alpaca_key_id;
      update.alpaca_secret_key = body.alpaca_secret_key;
      update.mode = body.mode || 'paper';

      // Validate with Alpaca
      try {
        const base = (body.mode === 'live') ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
        const acctRes = await fetch(`${base}/v2/account`, {
          headers: { 'APCA-API-KEY-ID': body.alpaca_key_id, 'APCA-API-SECRET-KEY': body.alpaca_secret_key },
        });
        if (!acctRes.ok) throw new Error('Invalid Alpaca credentials');
        const acct = await acctRes.json();
        update.portfolio_value = acct.portfolio_value;
        update.buying_power = acct.buying_power;
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      await userRef.set(update, { merge: true });
      return res.json({ ok: true, portfolio_value: update.portfolio_value, buying_power: update.buying_power, mode: update.mode });
    }

    if (broker === 'robinhood') {
      update.rh_api_key_id = body.rh_api_key_id;
      update.rh_private_key = body.rh_private_key;
      update.mode = 'live';
      await userRef.set(update, { merge: true });
      return res.json({ ok: true, key_preview: body.rh_api_key_id?.slice(0, 8) + '…' });
    }

    if (broker === 'coinbase') {
      update.cb_key_name = body.cb_key_name;
      update.cb_private_key = body.cb_private_key;
      update.mode = 'live';
      await userRef.set(update, { merge: true });
      return res.json({ ok: true, key_preview: body.cb_key_name?.slice(0, 12) + '…' });
    }

    if (broker === 'kraken') {
      update.kr_api_key = body.kr_api_key;
      update.kr_api_secret = body.kr_api_secret;
      update.mode = 'live';
      await userRef.set(update, { merge: true });
      return res.json({ ok: true, key_preview: body.kr_api_key?.slice(0, 8) + '…' });
    }

    if (broker === 'polymarket') {
      update.poly_private_key = body.poly_private_key;
      update.mode = 'live';
      const addr = '0x' + body.poly_private_key?.slice(-40) || '0x0000';
      await userRef.set(update, { merge: true });
      return res.json({ ok: true, address: addr });
    }

    return res.status(400).json({ error: 'Unknown broker' });
  }

  // ── Settings ──
  if (action === 'settings') {
    if (req.method === 'POST') {
      const body = req.body || {};
      const settings = {};
      if (body.strategy !== undefined)         settings.strategy = body.strategy;
      if (body.risk_level !== undefined)       settings.risk_level = body.risk_level;
      if (body.max_position_pct !== undefined) settings.max_position_pct = body.max_position_pct;
      if (body.daily_goal_pct !== undefined)   settings.daily_goal_pct = body.daily_goal_pct;
      if (body.bot_type !== undefined)         settings.bot_type = body.bot_type;
      await userRef.set({ settings, updated: FieldValue.serverTimestamp() }, { merge: true });
      return res.json({ ok: true });
    }
    const doc = await userRef.get();
    return res.json(doc.exists ? doc.data().settings || {} : {});
  }

  // ── Toggle ──
  if (action === 'toggle' && req.method === 'POST') {
    const { active } = req.body || {};
    const newState = active !== undefined ? !!active : true;
    await userRef.set({ bot_active: newState, updated: FieldValue.serverTimestamp() }, { merge: true });
    return res.json({ ok: true, bot_active: newState });
  }

  // ── Default: return full dashboard status ──
  const doc = await userRef.get();
  const data = doc.exists ? doc.data() : {};

  const tradesSnap = await db.collection('users').doc(uid).collection('trades')
    .orderBy('timestamp', 'desc').limit(20).get();
  const recentTrades = tradesSnap.docs.map(d => {
    const t = d.data();
    return {
      symbol: t.symbol, side: t.side, price: t.price,
      pnl: t.pnl ?? null, won: t.pnl > 0, open: !!t.open,
      timestamp: t.timestamp?.toDate?.()?.toISOString() || null,
    };
  });

  const actSnap = await db.collection('users').doc(uid).collection('activity')
    .orderBy('timestamp', 'desc').limit(10).get();
  const recentActivity = actSnap.docs.map(d => {
    const a = d.data();
    return {
      type: a.type, symbol: a.symbol, reason: a.reason,
      confidence: a.confidence, broker: a.broker, strategy: a.strategy,
      time: a.timestamp?.toDate?.()?.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) || '',
    };
  });

  const wins = recentTrades.filter(t => !t.open && t.won).length;
  const closed = recentTrades.filter(t => !t.open).length;
  const totalPnl = recentTrades.reduce((s, t) => s + (t.pnl || 0), 0);

  const fuel = data.fuel || {
    balance: 0, tier_label: 'Free', fee_pct: 20,
    high_water_mark: 0, total_fees_paid: 0,
    cumulative_profit: 0, referral_code: uid.slice(0, 8),
    paused_reason: null,
  };

  const earnedBadges = data.badges_earned || [];

  return res.json({
    configured: !!data.configured,
    bot_active: !!data.bot_active,
    mode: data.mode || 'paper',
    broker: data.broker || 'alpaca',
    subscribed: !!data.subscribed,
    portfolio_value: data.portfolio_value || '100000.00',
    buying_power: data.buying_power || '100000.00',
    stats: {
      win_rate_pct: closed > 0 ? Math.round((wins / closed) * 100) : 0,
      total_trades: closed,
      total_pnl: Math.round(totalPnl * 100) / 100,
    },
    recent_trades: recentTrades,
    recent_activity: recentActivity,
    fuel,
    badges: { earned: earnedBadges, catalog: BADGE_CATALOG },
    settings: data.settings || {},
    available_strategies: STRATEGIES,
    selected_strategy: data.settings?.strategy || 'brilliant',
  });
};
