const admin = require('firebase-admin');
const { db } = require('../lib/firebase-config');
const { stripe } = require('../lib/stripe-config');

const PRICE_ID = process.env.STRIPE_PRICE_ID;
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
  const userData = userDoc.exists ? userDoc.data() : {};

  if (userData.stripeCustomerId) {
    const subs = await stripe.subscriptions.list({
      customer: userData.stripeCustomerId,
      status: 'active',
      limit: 1,
    });
    if (subs.data.length > 0) {
      return res.json({ alreadyActive: true, redirectUrl: `${FRONTEND_URL}/bot` });
    }
  }

  let customerId = userData.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: decoded.email,
      metadata: { firebaseUid: decoded.uid },
    });
    customerId = customer.id;
    await db.collection('users').doc(decoded.uid).set(
      { stripeCustomerId: customerId },
      { merge: true }
    );
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: PRICE_ID, quantity: 1 }],
    success_url: `${FRONTEND_URL}/bot?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${FRONTEND_URL}/?canceled=true`,
    metadata: { firebaseUid: decoded.uid },
    subscription_data: {
      metadata: { firebaseUid: decoded.uid },
    },
  });

  return res.json({ checkoutUrl: session.url });
};
