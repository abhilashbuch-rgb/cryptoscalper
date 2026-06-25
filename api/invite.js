const { db, FieldValue } = require('../lib/firebase-config');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { code } = req.body || {};
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Invite code required' });
  }

  const clean = code.trim().toUpperCase();
  const ref = db.collection('invite_codes').doc(clean);
  const doc = await ref.get();

  if (!doc.exists) {
    return res.status(403).json({ error: 'Invalid invite code' });
  }

  const data = doc.data();
  if (data.used) {
    return res.status(403).json({ error: 'This code has already been used' });
  }
  if (data.active === false) {
    return res.status(403).json({ error: 'This code is no longer active' });
  }

  return res.json({ ok: true, code: clean });
};
