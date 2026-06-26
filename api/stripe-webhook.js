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

const EVENT_HANDLERS = {
  'crypto.onramp.session.completed': handleOnrampCompleted,
  'payment_intent.succeeded': handlePaymentSucceeded,
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
