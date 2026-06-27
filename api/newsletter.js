const { db, FieldValue } = require('../lib/firebase-config');
const { waitlistNotification, generateInviteCode, syncResendContact } = require('../lib/notify-admin');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = req.query?.action;

  if (action === 'subscribe' && req.method === 'POST') {
    const body = req.body || {};
    const email = body.email;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const key = email.toLowerCase().replace(/[^a-z0-9@._-]/g, '_');
    const data = {
      email: email.toLowerCase(),
      subscribed: FieldValue.serverTimestamp(),
    };

    if (body.newsletter !== undefined) data.newsletter = !!body.newsletter;
    if (body.waitlist)                 data.waitlist = true;
    if (body.agreed_terms)             data.agreed_terms = true;
    if (body.agreed_risk)              data.agreed_risk = true;
    if (body.agreed_at)                data.agreed_at = body.agreed_at;

    await db.collection('newsletter').doc(key).set(data, { merge: true });

    if (body.waitlist) {
      const inviteCode = generateInviteCode();
      const emailLower = email.toLowerCase();

      await Promise.all([
        db.collection('waitlist').doc(key).set({
          email: emailLower,
          newsletter: !!body.newsletter,
          agreed_terms: true,
          agreed_risk: true,
          agreed_at: body.agreed_at || new Date().toISOString(),
          invite_code: inviteCode,
          joined: FieldValue.serverTimestamp(),
        }, { merge: true }),
        db.collection('invite_codes').doc(inviteCode).set({
          active: false,
          used: false,
          generated_for: emailLower,
          created: FieldValue.serverTimestamp(),
        }),
      ]);

      waitlistNotification(emailLower, 'homepage').catch(() => {});
      syncResendContact(emailLower, inviteCode).catch(() => {});
    }

    return res.json({ ok: true });
  }

  if (action === 'count') {
    try {
      const snap = await db.collection('waitlist').count().get();
      return res.json({ count: snap.data().count || 0 });
    } catch {
      return res.json({ count: 0 });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
};
