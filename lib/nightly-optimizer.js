/**
 * Wick Platform - Nightly Crowbot Calibration Optimization Engine
 * Calculates Brier scoring metrics and writes adaptive configuration variables to Firestore.
 */
const { db } = require('./firebase-config');

async function runNightlyCalibration(userId) {
  console.log(`[OPTIMIZER] Initiating nightly calibration matrix for user: ${userId}`);

  const userRef = db.collection('users').doc(userId);
  const lookbackTimestamp = Date.now() - (24 * 60 * 60 * 1000);

  const historySnapshot = await userRef.collection('crowbot_history')
    .where('timestamp', '>=', lookbackTimestamp)
    .get();

  if (historySnapshot.empty) {
    console.log('[OPTIMIZER] No trades found in lookback window. Skipping configuration adjustment.');
    return;
  }

  let totalBrierVariance = 0;
  let totalSlippagePaid = 0;
  let closedTradeCount = 0;
  let winningTrades = 0;

  const brokerMetrics = {
    POLYMARKET: { slippage: 0, count: 0 },
    COINBASE: { slippage: 0, count: 0 },
    ALPACA: { slippage: 0, count: 0 },
  };

  historySnapshot.forEach(doc => {
    const trade = doc.data();

    if (trade.realizedPnl !== undefined) {
      closedTradeCount++;
      const outcomeBinary = trade.realizedPnl > 0 ? 1 : 0;
      if (outcomeBinary === 1) winningTrades++;

      const brierInstance = Math.pow(trade.confidenceAtExecution - outcomeBinary, 2);
      totalBrierVariance += brierInstance;
    }

    if (trade.slippagePaid) {
      totalSlippagePaid += trade.slippagePaid;
      if (brokerMetrics[trade.broker]) {
        brokerMetrics[trade.broker].slippage += trade.slippagePaid;
        brokerMetrics[trade.broker].count++;
      }
    }
  });

  const currentBrierScore = closedTradeCount > 0 ? (totalBrierVariance / closedTradeCount) : 0.25;
  const currentWinRate = closedTradeCount > 0 ? (winningTrades / closedTradeCount) : 0.0;

  let targetConfidenceThreshold = 0.70;
  let targetMaxAllocationSize = 1.0;

  if (currentBrierScore > 0.25) {
    targetConfidenceThreshold = 0.82;
    targetMaxAllocationSize = 0.50;
    console.log(`[OPTIMIZER WARN] High Brier Variance (${currentBrierScore.toFixed(4)}). Defensive throttling engaged.`);
  } else if (currentBrierScore < 0.15 && currentWinRate > 0.55) {
    targetConfidenceThreshold = 0.65;
    targetMaxAllocationSize = 1.25;
    console.log(`[OPTIMIZER INFO] Optimal Brier Calibration detected (${currentBrierScore.toFixed(4)}). Expanding parameters.`);
  }

  const updatedConfig = {
    confidenceGate: targetConfidenceThreshold,
    allocationMultiplier: targetMaxAllocationSize,
    analyticsSnapshot: {
      calculatedBrier: parseFloat(currentBrierScore.toFixed(4)),
      twentyFourHourWinRate: parseFloat(currentWinRate.toFixed(2)),
      aggregateSlippagePaid: parseFloat(totalSlippagePaid.toFixed(2)),
      processedCount: closedTradeCount,
    },
    lastOptimizationTimestamp: Date.now(),
  };

  await userRef.collection('config').doc('crowbot_preset').set(updatedConfig, { merge: true });
  console.log(`[OPTIMIZER COMPLETE] New execution boundaries committed for user ${userId}.`);
}

module.exports = { runNightlyCalibration };
