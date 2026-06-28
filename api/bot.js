const admin = require('firebase-admin');
const { db, FieldValue } = require('../lib/firebase-config');
const { waitlistNotification, inviteRedeemedNotification, newUserLoginNotification, walletConnectedNotification, sendWelcomeEmail, syncResendContact } = require('../lib/notify-admin');

const STRATEGIES = [
  { id: 'negrisk_arb', name: 'NegRisk Arbitrage', description: 'Scans multi-outcome brackets for sum violations. Buys NO across all outcomes for locked mathematical profit. 80%+ win rate.', tier: 'free', risk: 'conservative', winRateGuide: '80–95%', locked: false },
  { id: 'catalyst',    name: 'Catalyst Hunter',   description: 'Matches breaking news to open contracts. Trades before the crowd reprices. Higher variance, bigger payoffs.', tier: 'free', risk: 'balanced', winRateGuide: '60–70%', locked: false },
  { id: 'sports',      name: 'Sports Edge',       description: 'Live score monitoring. Trades in-play sports markets when odds lag behind real-time results.', tier: 'pro', risk: 'aggressive', winRateGuide: '55–65%', locked: false },
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


  // ── Login notification ──
  if (action === 'login_notify') {
    const existingDoc = await userRef.get();
    const isFirstLogin = !existingDoc.exists || !existingDoc.data().first_login;

    await userRef.set({
      last_login: FieldValue.serverTimestamp(),
      email: decoded.email || '',
      ...(isFirstLogin ? { first_login: FieldValue.serverTimestamp() } : {}),
    }, { merge: true });

    newUserLoginNotification(email, uid).catch(() => {});

    if (isFirstLogin && email) {
      sendWelcomeEmail(email).catch(() => {});
      syncResendContact(email).catch(() => {});
    }

    return res.json({ ok: true });
  }

  // ── Generate invite codes (admin only) ──
  if (action === 'generate_codes' && req.method === 'POST') {
    const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase();
    if (email !== adminEmail) return res.status(403).json({ error: 'Admin only' });

    const count = Math.min(req.body?.count || 5, 20);
    const codes = [];
    const writes = [];
    for (let i = 0; i < count; i++) {
      const code = 'WICK-' + Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
      codes.push(code);
      writes.push(db.collection('invite_codes').doc(code).set({
        created_by: email,
        created_at: FieldValue.serverTimestamp(),
        used: false,
        seed: true,
      }));
    }
    await Promise.all(writes);
    return res.json({ ok: true, codes });
  }

  // ── Redeem invite code (adds user to allowlist + generates referral codes) ──
  if (action === 'redeem_code' && req.method === 'POST') {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Code required' });
    const clean = code.trim().toUpperCase();
    const codeRef = db.collection('invite_codes').doc(clean);
    const codeDoc = await codeRef.get();
    if (!codeDoc.exists) return res.status(403).json({ error: 'Invalid invite code' });
    const codeData = codeDoc.data();
    if (codeData.used) return res.status(403).json({ error: 'This code has already been used' });

    const referralCodes = [];
    for (let i = 0; i < 3; i++) {
      const rc = 'WICK-' + Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
      referralCodes.push(rc);
    }

    const writes = [
      codeRef.update({ used: true, used_by: email, used_by_uid: uid, used_at: FieldValue.serverTimestamp() }),
      db.collection('allowlist').doc(email).set({ uid, email, code: clean, granted: FieldValue.serverTimestamp() }),
      userRef.set({ invited: true, invite_code: clean, referral_codes: referralCodes, updated: FieldValue.serverTimestamp() }, { merge: true }),
    ];
    for (const rc of referralCodes) {
      writes.push(db.collection('invite_codes').doc(rc).set({
        created_by: email,
        created_by_uid: uid,
        created_at: FieldValue.serverTimestamp(),
        used: false,
      }));
    }
    await Promise.all(writes);

    inviteRedeemedNotification(email, clean).catch(() => {});
    return res.json({ ok: true, referralCodes });
  }

  // ── Waitlist ──
  if (action === 'waitlist') {
    const { platform } = req.body || {};
    await db.collection('waitlist').doc(`${uid}_${platform}`).set({
      uid, platform, email: decoded.email || '', joined: FieldValue.serverTimestamp(),
      joined_ms: Date.now(), auto_invited: false,
    });
    waitlistNotification(email, platform).catch(() => {});
    return res.json({ ok: true });
  }

  // ── Upgrade endpoint removed — revenue is % cut on profitable trades, not subscriptions ──

  // ── Connect wallet (Polymarket only) ──
  if (action === 'connect' && req.method === 'POST') {
    const body = req.body || {};
    const update = { broker: 'polymarket', configured: true, updated: FieldValue.serverTimestamp() };

    update.poly_private_key = body.poly_private_key;
    update.mode = body.mode || 'sandbox';
    if (body.poly_private_key) {
      const addr = '0x' + body.poly_private_key.slice(-40);
      update.wallet_address = addr;
      await userRef.set(update, { merge: true });
      walletConnectedNotification(email, addr, update.mode).catch(() => {});
      return res.json({ ok: true, address: addr, mode: update.mode });
    }

    await userRef.set(update, { merge: true });
    return res.json({ ok: true, mode: update.mode });
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
      if (body.take_profit_pct !== undefined) settings.take_profit_pct = body.take_profit_pct;
      if (body.stop_loss_pct !== undefined)   settings.stop_loss_pct = body.stop_loss_pct;
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
  const [doc, tradesSnap, actSnap] = await Promise.all([
    userRef.get(),
    db.collection('users').doc(uid).collection('trades')
      .orderBy('timestamp', 'desc').limit(20).get(),
    db.collection('users').doc(uid).collection('activity')
      .orderBy('timestamp', 'desc').limit(10).get(),
  ]);
  const data = doc.exists ? doc.data() : {};

  const recentTrades = tradesSnap.docs.map(d => {
    const t = d.data();
    return {
      symbol: t.symbol, side: t.side, price: t.price,
      pnl: t.pnl ?? null, won: t.pnl > 0, open: !!t.open,
      timestamp: t.timestamp?.toDate?.()?.toISOString() || null,
    };
  });

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
  fuel.referral_codes = data.referral_codes || [];

  const earnedBadges = data.badges_earned || [];

  const connected = !!data.wallet_address;

  return res.json({
    configured: !!data.configured,
    bot_active: !!data.bot_active,
    mode: data.mode || 'sandbox',
    broker: 'polymarket',
    wallet_address: data.wallet_address || null,
    connected,
    balance: data.balance || '10000.00',
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
    selected_strategy: data.settings?.strategy || 'negrisk_arb',
  });
};
