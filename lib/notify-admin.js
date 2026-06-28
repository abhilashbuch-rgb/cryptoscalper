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
          You're in. WICK is a trading overlay that plugs into Polymarket and surfaces mathematical mispricings before the market catches up. You pick the trades — WICK handles the exits.
        </p>

        <div style="background:rgba(59,130,246,.06);border:1px solid rgba(59,130,246,.12);border-radius:12px;padding:20px;margin-bottom:16px">
          <div style="font-size:11px;color:#3b82f6;font-weight:700;letter-spacing:.08em;margin-bottom:12px">STEP 1 — CONNECT YOUR WALLET</div>
          <p style="font-size:13px;color:#94a3b8;line-height:1.6;margin:0">Head to your dashboard and connect your Polymarket wallet, or start in sandbox with $10,000 simulated funds. WICK places trades on the Polymarket CLOB on your behalf — <strong style="color:#e2e8f0">non-custodial, we can never withdraw your funds</strong>.</p>
        </div>

        <div style="background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.12);border-radius:12px;padding:20px;margin-bottom:16px">
          <div style="font-size:11px;color:#10b981;font-weight:700;letter-spacing:.08em;margin-bottom:12px">STEP 2 — BROWSE THE ANOMALY FEED</div>
          <p style="font-size:13px;color:#94a3b8;line-height:1.6;margin:0">Your command center has a live anomaly feed on the left. WICK continuously scans multi-outcome brackets for sum violations — when total implied probability exceeds 100%, there's guaranteed profit. Anomalies stream in with edge %, confidence scores, and one-click BUY buttons.</p>
        </div>

        <div style="background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.12);border-radius:12px;padding:20px;margin-bottom:16px">
          <div style="font-size:11px;color:#f59e0b;font-weight:700;letter-spacing:.08em;margin-bottom:12px">STEP 3 — HIT BUY AND KEEP PLAYING</div>
          <p style="font-size:13px;color:#94a3b8;line-height:1.6;margin:0">See an anomaly you like? Choose your strike size ($25–$250) and hit BUY. WICK executes instantly on Polymarket's CLOB. Your trades and positions show up in the right panel in real time.</p>
        </div>

        <div style="background:rgba(139,92,246,.06);border:1px solid rgba(139,92,246,.12);border-radius:12px;padding:20px;margin-bottom:24px">
          <div style="font-size:11px;color:#8b5cf6;font-weight:700;letter-spacing:.08em;margin-bottom:12px">STEP 4 — AUTO-EXIT LOCKS IN PROFITS</div>
          <p style="font-size:13px;color:#94a3b8;line-height:1.6;margin:0">Toggle on Auto-Exit and WICK monitors your positions every 10 seconds. When a position hits your profit target (default <strong style="color:#e2e8f0">+20%</strong>), WICK sells automatically. No watching charts, no manual closes. You get the profit, minus our cut — and you never had to stop playing.</p>
        </div>

        <div style="border-top:1px solid rgba(148,163,184,.08);padding-top:20px;margin-bottom:12px">
          <div style="font-size:11px;color:#64748b;font-weight:700;letter-spacing:.08em;margin-bottom:12px">HOW WICK MAKES MONEY</div>
          <p style="font-size:13px;color:#94a3b8;line-height:1.6;margin:0">We take <strong style="color:#e2e8f0">20% of profitable trades only</strong>. If you don't profit, you don't pay. No subscriptions, no monthly fees, no hidden charges. Our incentives are 100% aligned with yours.</p>
        </div>

        <div style="background:rgba(16,185,129,.04);border:1px solid rgba(16,185,129,.1);border-radius:8px;padding:14px 16px;margin-bottom:24px">
          <p style="font-size:12px;color:#94a3b8;line-height:1.6;margin:0"><strong style="color:#10b981">Start free.</strong> Sandbox mode gives you $10,000 in simulated funds to test strategies. When you're ready, connect your wallet for live trading. Zero risk to try.</p>
        </div>

        <a href="https://wick.network/bot" style="display:block;text-align:center;background:#2962FF;color:#fff;font-weight:700;font-size:14px;padding:14px 24px;border-radius:10px;text-decoration:none;margin-bottom:8px">Open Your Command Center</a>
      </div>

      <div style="padding:20px 32px;border-top:1px solid rgba(148,163,184,.06);text-align:center">
        <p style="font-size:11px;color:#475569;line-height:1.6;margin:0">
          Prediction market trading involves substantial risk of loss. Past performance does not guarantee future results. WICK finds mathematical mispricings — it does not predict outcomes. Markets can move against any position. Only trade with funds you can afford to lose entirely. WICK is not registered with any financial regulatory authority. Not financial advice.
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
