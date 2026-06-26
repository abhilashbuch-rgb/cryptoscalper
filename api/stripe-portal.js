const admin = require('firebase-admin');
const { db } = require('../lib/firebase-config');
const { stripe } = require('../lib/stripe-config');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://wick.network';

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
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST required' });
  }

  const decoded = await verifyToken(req);
  if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

  const userDoc = await db.collection('users').doc(decoded.uid).get();
  const customerId = userDoc.exists ? userDoc.data().stripeCustomerId : null;

  if (!customerId) {
    return res.status(400).json({ error: 'No billing account found' });
  }

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${FRONTEND_URL}/bot`,
  });

  return res.json({ portalUrl: portalSession.url });
};
