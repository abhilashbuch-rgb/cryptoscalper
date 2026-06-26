const admin = require('firebase-admin');
const { db } = require('../lib/firebase-config');
const { stripe, STRIPE_PUBLISHABLE_KEY } = require('../lib/stripe-config');

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
  const walletAddress = req.body?.walletAddress || userData.walletAddress;

  if (!walletAddress) {
    return res.status(400).json({ error: 'No wallet address. Connect your wallet first.' });
  }

  try {
    const session = await stripe.crypto.onrampSessions.create({
      wallet_addresses: { polygon: walletAddress },
      destination_currencies: ['usdc'],
      destination_networks: ['polygon'],
      metadata: {
        uid: decoded.uid,
        email: decoded.email || '',
      },
    });

    return res.json({
      clientSecret: session.client_secret,
      publishableKey: STRIPE_PUBLISHABLE_KEY,
    });
  } catch (err) {
    console.error('[STRIPE ONRAMP]', err.message);
    return res.status(500).json({ error: 'Failed to create onramp session' });
  }
};
