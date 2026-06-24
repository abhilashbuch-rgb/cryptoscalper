const { db, FieldValue } = require('../lib/firebase-config');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = req.query?.action;

  if (action === 'subscribe' && req.method === 'POST') {
    const { email } = req.body || {};
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const key = email.toLowerCase().replace(/[^a-z0-9@._-]/g, '_');
    await db.collection('newsletter').doc(key).set({
      email: email.toLowerCase(),
      subscribed: FieldValue.serverTimestamp(),
    }, { merge: true });
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
};
