const crypto = require('crypto');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'abhilash.buch@gmail.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID;
const FROM_EMAIL = process.env.NOTIFY_FROM_EMAIL || 'WICK <onboarding@resend.dev>';

async function notifyAdmin(subject, html) {
  if (!RESEND_API_KEY) return;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [ADMIN_EMAIL],
        subject: `[WICK] ${subject}`,
        html,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

function waitlistNotification(email, platform) {
  return notifyAdmin(
    'New Waitlist Signup',
    `<div style="font-family:monospace;background:#0B0E14;color:#e2e8f0;padding:24px;border-radius:8px">
      <h2 style="color:#00E676;margin:0 0 16px">New Waitlist Signup</h2>
      <table style="border-collapse:collapse">
        <tr><td style="color:#94a3b8;padding:4px 16px 4px 0">Email</td><td style="color:#fff;font-weight:bold">${email}</td></tr>
        <tr><td style="color:#94a3b8;padding:4px 16px 4px 0">Platform</td><td style="color:#fff">${platform || 'web'}</td></tr>
        <tr><td style="color:#94a3b8;padding:4px 16px 4px 0">Time</td><td style="color:#fff">${new Date().toUTCString()}</td></tr>
      </table>
    </div>`
  );
}

function inviteRedeemedNotification(email, code) {
  return notifyAdmin(
    `Invite Code Redeemed: ${code}`,
    `<div style="font-family:monospace;background:#0B0E14;color:#e2e8f0;padding:24px;border-radius:8px">
      <h2 style="color:#004BFF;margin:0 0 16px">Invite Code Redeemed</h2>
      <table style="border-collapse:collapse">
        <tr><td style="color:#94a3b8;padding:4px 16px 4px 0">Email</td><td style="color:#fff;font-weight:bold">${email}</td></tr>
        <tr><td style="color:#94a3b8;padding:4px 16px 4px 0">Code</td><td style="color:#00E676;font-weight:bold">${code}</td></tr>
        <tr><td style="color:#94a3b8;padding:4px 16px 4px 0">Time</td><td style="color:#fff">${new Date().toUTCString()}</td></tr>
      </table>
      <p style="color:#94a3b8;margin:16px 0 0">This user now has full access to WICK.</p>
    </div>`
  );
}

function newUserLoginNotification(email, uid) {
  return notifyAdmin(
    'New User Login',
    `<div style="font-family:monospace;background:#0B0E14;color:#e2e8f0;padding:24px;border-radius:8px">
      <h2 style="color:#f59e0b;margin:0 0 16px">New User Login</h2>
      <table style="border-collapse:collapse">
        <tr><td style="color:#94a3b8;padding:4px 16px 4px 0">Email</td><td style="color:#fff;font-weight:bold">${email}</td></tr>
        <tr><td style="color:#94a3b8;padding:4px 16px 4px 0">UID</td><td style="color:#fff;font-size:11px">${uid}</td></tr>
        <tr><td style="color:#94a3b8;padding:4px 16px 4px 0">Time</td><td style="color:#fff">${new Date().toUTCString()}</td></tr>
      </table>
    </div>`
  );
}

function walletConnectedNotification(email, address, mode) {
  return notifyAdmin(
    'Wallet Connected',
    `<div style="font-family:monospace;background:#0B0E14;color:#e2e8f0;padding:24px;border-radius:8px">
      <h2 style="color:#10b981;margin:0 0 16px">Wallet Connected</h2>
      <table style="border-collapse:collapse">
        <tr><td style="color:#94a3b8;padding:4px 16px 4px 0">Email</td><td style="color:#fff;font-weight:bold">${email}</td></tr>
        <tr><td style="color:#94a3b8;padding:4px 16px 4px 0">Address</td><td style="color:#00E676;font-size:11px">${address}</td></tr>
        <tr><td style="color:#94a3b8;padding:4px 16px 4px 0">Mode</td><td style="color:#fff">${mode}</td></tr>
        <tr><td style="color:#94a3b8;padding:4px 16px 4px 0">Time</td><td style="color:#fff">${new Date().toUTCString()}</td></tr>
      </table>
    </div>`
  );
}

async function sendWelcomeEmail(email) {
  if (!RESEND_API_KEY) return;

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;background:#0B0E14;color:#e2e8f0;border-radius:16px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#0B0E14 0%,#111a2e 100%);padding:40px 32px 32px;text-align:center;border-bottom:1px solid rgba(59,130,246,.15)">
        <div style="display:inline-block;background:#2962FF;color:#fff;font-weight:900;font-size:18px;width:44px;height:44px;line-height:44px;border-radius:10px;margin-bottom:16px">W</div>
        <h1 style="margin:0 0 4px;font-size:24px;font-weight:800;color:#fff">Welcome to WICK<span style="color:#3b82f6">.NETWORK</span></h1>
        <p style="margin:0;font-size:13px;color:#64748b">Your trading overlay for Polymarket</p>
      </div>

      <div style="padding:32px">
        <p style="font-size:14px;color:#94a3b8;line-height:1.7;margin:0 0 24px">
          You're in. WICK scans breaking news, matches it to Polymarket contracts, and surfaces mispricings before the market catches up. Here's how to get started:
        </p>

        <div style="background:rgba(59,130,246,.06);border:1px solid rgba(59,130,246,.12);border-radius:12px;padding:20px;margin-bottom:16px">
          <div style="font-size:11px;color:#3b82f6;font-weight:700;letter-spacing:.08em;margin-bottom:12px">STEP 1 — CONNECT YOUR WALLET</div>
          <p style="font-size:13px;color:#94a3b8;line-height:1.6;margin:0">Head to your dashboard and connect your Polymarket wallet. Same wallet, same funds — WICK places trades on the Polymarket CLOB on your behalf. We can never withdraw your funds.</p>
        </div>

        <div style="background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.12);border-radius:12px;padding:20px;margin-bottom:16px">
          <div style="font-size:11px;color:#10b981;font-weight:700;letter-spacing:.08em;margin-bottom:12px">STEP 2 — WATCH FOR ANOMALIES</div>
          <p style="font-size:13px;color:#94a3b8;line-height:1.6;margin:0">WICK continuously scans for three types of edges: <strong style="color:#e2e8f0">NegRisk Arbitrage</strong> (basket sum violations), <strong style="color:#e2e8f0">News-Lag</strong> (headlines the market hasn't priced in), and <strong style="color:#e2e8f0">Sports Edge</strong> (live score vs. stale odds). When one appears, you'll see it on your dashboard.</p>
        </div>

        <div style="background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.12);border-radius:12px;padding:20px;margin-bottom:24px">
          <div style="font-size:11px;color:#f59e0b;font-weight:700;letter-spacing:.08em;margin-bottom:12px">STEP 3 — STRIKE OR SKIP</div>
          <p style="font-size:13px;color:#94a3b8;line-height:1.6;margin:0">Every anomaly comes with a confidence score and a countdown timer. Hit <strong style="color:#e2e8f0">Strike</strong> to execute instantly at the lowest fee (20%), or let the timer run — the fee escalates to 35%, then 50%, then auto-executes. You're always in control.</p>
        </div>

        <div style="border-top:1px solid rgba(148,163,184,.08);padding-top:20px;margin-bottom:20px">
          <div style="font-size:11px;color:#64748b;font-weight:700;letter-spacing:.08em;margin-bottom:12px">HOW WICK MAKES MONEY</div>
          <p style="font-size:13px;color:#94a3b8;line-height:1.6;margin:0">We take <strong style="color:#e2e8f0">20% of profitable trades only</strong>. If you don't profit, you don't pay. No subscriptions, no hidden fees. Our incentives are aligned with yours.</p>
        </div>

        <a href="https://wick.network/bot" style="display:block;text-align:center;background:#2962FF;color:#fff;font-weight:700;font-size:14px;padding:14px 24px;border-radius:10px;text-decoration:none;margin-bottom:8px">Open Dashboard</a>
      </div>

      <div style="padding:20px 32px;border-top:1px solid rgba(148,163,184,.06);text-align:center">
        <p style="font-size:11px;color:#475569;line-height:1.6;margin:0">
          Trading involves substantial risk of loss. Past performance does not guarantee future results. Only trade what you can afford to lose. WICK is not a financial advisor and is not registered with any financial regulatory authority.
        </p>
        <p style="font-size:10px;color:#334155;margin:12px 0 0">
          &copy; 2026 WICK.NETWORK &mdash; <a href="https://wick.network/terms" style="color:#475569">Terms</a> &middot; <a href="https://wick.network/privacy" style="color:#475569">Privacy</a>
        </p>
      </div>
    </div>`;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [email],
        subject: 'Welcome to WICK.Network — your Polymarket edge starts now',
        html,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

function generateInviteCode() {
  return 'WICK-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

async function syncResendContact(email, inviteCode) {
  if (!RESEND_API_KEY || !RESEND_AUDIENCE_ID) return null;

  try {
    const r = await fetch(`https://api.resend.com/audiences/${RESEND_AUDIENCE_ID}/contacts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        unsubscribed: false,
      }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await r.json();
    return data?.id || null;
  } catch {
    return null;
  }
}

module.exports = {
  notifyAdmin,
  waitlistNotification,
  inviteRedeemedNotification,
  newUserLoginNotification,
  walletConnectedNotification,
  sendWelcomeEmail,
  generateInviteCode,
  syncResendContact,
};
