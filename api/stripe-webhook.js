const { db, FieldValue } = require('../lib/firebase-config');
const { stripe, STRIPE_WEBHOOK_SECRET } = require('../lib/stripe-config');

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleOnrampCompleted(session) {
  const uid = session.metadata?.uid;
  const amount = parseFloat(session.destination_amount || 0);

  if (!uid || amount <= 0) {
    console.error('[STRIPE WEBHOOK] Missing uid or invalid amount');
    return;
  }

  const userRef = db.collection('users').doc(uid);
  const userDoc = await userRef.get();
  const currentBalance = userDoc.exists ? (userDoc.data().walletBalance || 0) : 0;
  const newBalance = currentBalance + amount;

  await userRef.set({
    walletBalance: newBalance,
    fueled: true,
    lastFuelAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await db.collection('fuel_transactions').add({
    uid,
    email: session.metadata?.email || '',
    amount,
    source: 'stripe_onramp',
    stripeSessionId: session.id,
    destinationCurrency: session.destination_currency,
    destinationNetwork: session.destination_network,
    timestamp: FieldValue.serverTimestamp(),
  });

  console.log(`[STRIPE WEBHOOK] Fueled $${amount} USDC to ${uid}. Balance: $${newBalance}`);
}

async function handlePaymentSucceeded(paymentIntent) {
  const uid = paymentIntent.metadata?.firebaseUid || paymentIntent.metadata?.uid;
  if (!uid) return;

  await db.collection('billing_events').add({
    uid,
    type: 'payment_intent.succeeded',
    amount: paymentIntent.amount,
    currency: paymentIntent.currency,
    paymentIntentId: paymentIntent.id,
    timestamp: FieldValue.serverTimestamp(),
  });

  console.log(`[STRIPE WEBHOOK] Payment succeeded for ${uid}: $${(paymentIntent.amount / 100).toFixed(2)}`);
}

async function handleCheckoutCompleted(session) {
  if (session.mode !== 'subscription') return;
  const uid = session.metadata?.uid;
  const email = session.metadata?.email || session.customer_email;
  if (!uid) return;

  await db.collection('users').doc(uid).set({
    premium: true,
    premium_since: FieldValue.serverTimestamp(),
    stripe_customer_id: session.customer,
    stripe_subscription_id: session.subscription,
  }, { merge: true });

  console.log(`[STRIPE WEBHOOK] Premium activated for ${email} (${uid})`);
}

async function handleSubscriptionDeleted(subscription) {
  const snap = await db.collection('users')
    .where('stripe_subscription_id', '==', subscription.id)
    .limit(1)
    .get();

  if (snap.empty) return;
  const userDoc = snap.docs[0];
  await userDoc.ref.set({ premium: false, premium_ended: FieldValue.serverTimestamp() }, { merge: true });
  console.log(`[STRIPE WEBHOOK] Premium cancelled for ${userDoc.id}`);
}

const EVENT_HANDLERS = {
  'crypto.onramp.session.completed': handleOnrampCompleted,
  'payment_intent.succeeded': handlePaymentSucceeded,
  'checkout.session.completed': handleCheckoutCompleted,
  'customer.subscription.deleted': handleSubscriptionDeleted,
};

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST required' });
  }

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[STRIPE WEBHOOK] Signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const eventHandler = EVENT_HANDLERS[event.type];
  if (eventHandler) {
    try {
      await eventHandler(event.data.object);
    } catch (err) {
      console.error(`[STRIPE WEBHOOK] Error handling ${event.type}:`, err.message);
      return res.status(500).json({ error: 'Handler failed' });
    }
  }

  res.json({ received: true });
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
