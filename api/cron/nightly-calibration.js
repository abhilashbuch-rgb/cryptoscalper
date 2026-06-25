const { runNightlyCalibration } = require('../../lib/nightly-optimizer');

module.exports = async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const userId = process.env.DEFAULT_USER_ID;
  if (!userId) {
    return res.status(500).json({ error: 'DEFAULT_USER_ID not configured' });
  }

  try {
    await runNightlyCalibration(userId);
    res.status(200).json({ status: 'calibration_complete', timestamp: Date.now() });
  } catch (err) {
    console.error('[CRON ERROR]', err);
    res.status(500).json({ error: err.message });
  }
};
