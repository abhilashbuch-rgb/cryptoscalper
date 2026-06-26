const admin = require('firebase-admin');
const { db } = require('../lib/firebase-config');

async function verifyToken(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  try {
    return await admin.auth().verifyIdToken(auth.split('Bearer ')[1]);
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET required' });
  }

  const decoded = await verifyToken(req);
  if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

  const userDoc = await db.collection('users').doc(decoded.uid).get();
  const data = userDoc.exists ? userDoc.data() : {};

  return res.json({
    accessGranted: data.accessGranted === true,
    subscriptionStatus: data.subscriptionStatus || null,
    periodEnd: data.subscriptionCurrentPeriodEnd || null,
  });
};
