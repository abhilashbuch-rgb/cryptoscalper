const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'abhilash.buch@gmail.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
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

module.exports = {
  notifyAdmin,
  waitlistNotification,
  inviteRedeemedNotification,
  newUserLoginNotification,
  walletConnectedNotification,
};
