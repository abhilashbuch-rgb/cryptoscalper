const { db, FieldValue } = require('../../lib/firebase-config');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.NOTIFY_FROM_EMAIL || 'WICK <onboarding@resend.dev>';
const INVITE_DELAY_MS = 2 * 24 * 60 * 60 * 1000; // 2 days
const BATCH_SIZE = 10;

function generateCode() {
  return 'WICK-' + Array.from({ length: 8 }, () =>
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]
  ).join('');
}

async function sendInviteEmail(email, code) {
  if (!RESEND_API_KEY) return false;

  const html = `
    <div style="font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:0 auto;background:#0B0E14;color:#e2e8f0;padding:32px;border-radius:12px">
      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:28px;font-weight:800;color:#fff;letter-spacing:-.02em">WICK</div>
        <div style="font-size:11px;color:#64748b;letter-spacing:.2em;text-transform:uppercase;margin-top:4px">NETWORK</div>
      </div>
      <h2 style="color:#00E676;margin:0 0 16px;font-size:18px">You're in.</h2>
      <p style="color:#94a3b8;line-height:1.6;margin:0 0 20px">Your spot on WICK is ready. Use the code below to unlock your dashboard and start trading.</p>
      <div style="background:rgba(41,98,255,.08);border:1px solid rgba(41,98,255,.2);border-radius:8px;padding:16px;text-align:center;margin-bottom:20px">
        <div style="font-size:11px;color:#64748b;letter-spacing:.15em;text-transform:uppercase;margin-bottom:8px">Your Invite Code</div>
        <div style="font-size:24px;font-weight:800;color:#2962FF;letter-spacing:.08em;font-family:monospace">${code}</div>
      </div>
      <div style="text-align:center;margin-bottom:24px">
        <a href="https://wick.network/bot" style="display:inline-block;background:#2962FF;color:#fff;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:700;font-size:14px;letter-spacing:.04em">Open WICK</a>
      </div>
      <p style="color:#475569;font-size:12px;line-height:1.5;margin:0">
        WICK is an agentic prediction market engine. It scans breaking news, detects mispricing on Polymarket, and surfaces trades before the market catches up.
      </p>
    </div>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM_EMAIL, to: [email], subject: 'Your WICK invite is ready', html }),
      signal: AbortSignal.timeout(10000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

module.exports = async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const cutoff = Date.now() - INVITE_DELAY_MS;

  const snap = await db.collection('waitlist')
    .where('auto_invited', '==', false)
    .limit(BATCH_SIZE)
    .get();

  const pending = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    const joinedMs = data.joined?._seconds ? data.joined._seconds * 1000 : (data.joined_ms || Date.now());
    if (joinedMs <= cutoff && data.email) {
      pending.push({ ref: doc.ref, email: data.email, uid: data.uid });
    }
  }

  if (pending.length === 0) {
    const uninitSnap = await db.collection('waitlist')
      .where('auto_invited', '==', null)
      .limit(50)
      .get();

    if (!uninitSnap.empty) {
      const batch = db.batch();
      uninitSnap.docs.forEach(doc => batch.update(doc.ref, { auto_invited: false }));
      await batch.commit();
      return res.json({ ok: true, backfilled: uninitSnap.size, invited: 0 });
    }

    return res.json({ ok: true, invited: 0 });
  }

  let invited = 0;
  for (const entry of pending) {
    const code = generateCode();

    await db.collection('invite_codes').doc(code).set({
      created_by: 'auto_invite_cron',
      created_for: entry.email,
      created_at: FieldValue.serverTimestamp(),
      used: false,
    });

    const sent = await sendInviteEmail(entry.email, code);

    await entry.ref.update({
      auto_invited: true,
      auto_invite_code: code,
      auto_invited_at: FieldValue.serverTimestamp(),
      email_sent: sent,
    });

    if (sent) invited++;
  }

  console.log(`[AUTO-INVITE] Processed ${pending.length}, sent ${invited} emails`);
  return res.json({ ok: true, processed: pending.length, invited });
};
