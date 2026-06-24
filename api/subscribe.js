const { db, FieldValue } = require('../lib/firebase-config');

module.exports = async (req, res) => {
  const { fuel, uid, email } = req.query || {};

  if (!uid || !fuel) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const amount = parseFloat(fuel);
  if (isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid fuel amount' });
  }

  const tiers = [
    { min: 500, label: 'Diamond', fee: 7 },
    { min: 200, label: 'Gold',    fee: 10 },
    { min: 100, label: 'Silver',  fee: 12 },
    { min: 50,  label: 'Bronze',  fee: 15 },
    { min: 0,   label: 'Free',    fee: 20 },
  ];

  const userRef = db.collection('users').doc(uid);
  const doc = await userRef.get();
  const existing = doc.exists ? doc.data().fuel || {} : {};
  const newBalance = (existing.balance || 0) + amount;
  const tier = tiers.find(t => newBalance >= t.min) || tiers[tiers.length - 1];

  await userRef.set({
    fuel: {
      balance: newBalance,
      tier_label: tier.label,
      fee_pct: tier.fee,
      high_water_mark: existing.high_water_mark || 0,
      total_fees_paid: existing.total_fees_paid || 0,
      cumulative_profit: existing.cumulative_profit || 0,
      referral_code: existing.referral_code || uid.slice(0, 8),
      paused_reason: null,
    },
    updated: FieldValue.serverTimestamp(),
  }, { merge: true });

  await db.collection('fuel_transactions').add({
    uid, email: email || '', amount, timestamp: FieldValue.serverTimestamp(),
  });

  // Redirect back to dashboard
  res.writeHead(302, { Location: '/bot' });
  res.end();
};
