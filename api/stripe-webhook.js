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

async function handleCheckoutCompleted(session) {
  const uid = session.metadata?.firebaseUid;
  if (!uid) return;

  if (session.mode === 'subscription') {
    await db.collection('users').doc(uid).set({
      accessGranted: true,
      stripeSubscriptionId: session.subscription,
      stripeCustomerId: session.customer,
      accessGrantedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log(`[STRIPE] Access granted to ${uid} via subscription ${session.subscription}`);
  }
}

async function handleInvoicePaid(invoice) {
  const uid = invoice.subscription_details?.metadata?.firebaseUid
    || invoice.metadata?.firebaseUid;
  if (!uid) return;

  await db.collection('users').doc(uid).set({
    accessGranted: true,
    lastPaymentAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await db.collection('billing_events').add({
    uid,
    type: 'invoice.paid',
    amountPaid: invoice.amount_paid,
    currency: invoice.currency,
    invoiceId: invoice.id,
    subscriptionId: invoice.subscription,
    timestamp: FieldValue.serverTimestamp(),
  });

  console.log(`[STRIPE] Invoice paid for ${uid}: $${(invoice.amount_paid / 100).toFixed(2)}`);
}

async function handleSubscriptionUpdated(subscription) {
  const uid = subscription.metadata?.firebaseUid;
  if (!uid) return;

  const isActive = ['active', 'trialing'].includes(subscription.status);

  await db.collection('users').doc(uid).set({
    accessGranted: isActive,
    subscriptionStatus: subscription.status,
    subscriptionCurrentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
  }, { merge: true });

  console.log(`[STRIPE] Subscription ${subscription.id} for ${uid} → ${subscription.status}`);
}

async function handleSubscriptionDeleted(subscription) {
  const uid = subscription.metadata?.firebaseUid;
  if (!uid) return;

  await db.collection('users').doc(uid).set({
    accessGranted: false,
    subscriptionStatus: 'canceled',
    accessRevokedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  console.log(`[STRIPE] Access revoked for ${uid} — subscription canceled`);
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

  console.log(`[STRIPE WEBHOOK] Credited $${amount} USDC to ${uid}. Balance: $${newBalance}`);
}

const EVENT_HANDLERS = {
  'checkout.session.completed': handleCheckoutCompleted,
  'invoice.paid': handleInvoicePaid,
  'customer.subscription.updated': handleSubscriptionUpdated,
  'customer.subscription.deleted': handleSubscriptionDeleted,
  'crypto.onramp.session.completed': handleOnrampCompleted,
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

  const handler = EVENT_HANDLERS[event.type];
  if (handler) {
    try {
      await handler(event.data.object);
    } catch (err) {
      console.error(`[STRIPE WEBHOOK] Error handling ${event.type}:`, err.message);
      return res.status(500).json({ error: 'Handler failed' });
    }
  }

  res.json({ received: true });
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
