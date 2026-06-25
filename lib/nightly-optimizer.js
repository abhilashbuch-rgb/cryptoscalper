const { db } = require('./firebase-config');

async function runNightlyCalibration(userId) {
  console.log(`[OPTIMIZER] Initiating nightly calibration for user: ${userId}`);

  const userRef = db.collection('users').doc(userId);
  const lookbackTimestamp = Date.now() - (24 * 60 * 60 * 1000);

  const historySnapshot = await userRef.collection('polymarket_history')
    .where('timestamp', '>=', lookbackTimestamp)
    .get();

  if (historySnapshot.empty) {
    console.log('[OPTIMIZER] No trades found in lookback window. Skipping.');
    return;
  }

  let totalBrierVariance = 0;
  let totalSlippage = 0;
  let closedTradeCount = 0;
  let winningTrades = 0;
  let thinMarketSlippage = 0;
  let thinMarketCount = 0;
  let liquidMarketSlippage = 0;
  let liquidMarketCount = 0;

  historySnapshot.forEach(doc => {
    const trade = doc.data();

    if (trade.realizedPnl !== undefined) {
      closedTradeCount++;
      const outcomeBinary = trade.realizedPnl > 0 ? 1 : 0;
      if (outcomeBinary === 1) winningTrades++;
      const brierInstance = Math.pow((trade.confidenceAtExecution || 0.5) - outcomeBinary, 2);
      totalBrierVariance += brierInstance;
    }

    if (trade.slippage) {
      totalSlippage += trade.slippage;
      const vol = trade.bracketVolume || 0;
      if (vol < 50000) {
        thinMarketSlippage += trade.slippage;
        thinMarketCount++;
      } else {
        liquidMarketSlippage += trade.slippage;
        liquidMarketCount++;
      }
    }
  });

  const brierScore = closedTradeCount > 0 ? (totalBrierVariance / closedTradeCount) : 0.25;
  const winRate = closedTradeCount > 0 ? (winningTrades / closedTradeCount) : 0.0;
  const avgThinSlippage = thinMarketCount > 0 ? thinMarketSlippage / thinMarketCount : 0;
  const avgLiquidSlippage = liquidMarketCount > 0 ? liquidMarketSlippage / liquidMarketCount : 0;

  let hurdleRate = 1.03;
  let maxLegSize = 50;

  // Raise hurdle for thin markets if slippage is eating the edge
  if (avgThinSlippage > 0.02) {
    hurdleRate = 1.05;
    console.log(`[OPTIMIZER] Thin market slippage high (${avgThinSlippage.toFixed(4)}). Raising hurdle to 1.05.`);
  }

  // Expand size limits on liquid markets with good calibration
  if (brierScore < 0.15 && winRate > 0.6 && avgLiquidSlippage < 0.01) {
    maxLegSize = 75;
    console.log(`[OPTIMIZER] Strong calibration + low slippage. Expanding leg size to $75.`);
  }

  // Defensive mode if Brier score is poor
  if (brierScore > 0.25) {
    hurdleRate = 1.06;
    maxLegSize = 25;
    console.log(`[OPTIMIZER] High Brier variance (${brierScore.toFixed(4)}). Defensive mode.`);
  }

  const updatedConfig = {
    hurdleRate,
    maxLegSize,
    analyticsSnapshot: {
      brierScore: parseFloat(brierScore.toFixed(4)),
      winRate: parseFloat(winRate.toFixed(2)),
      totalSlippage: parseFloat(totalSlippage.toFixed(4)),
      avgThinSlippage: parseFloat(avgThinSlippage.toFixed(4)),
      avgLiquidSlippage: parseFloat(avgLiquidSlippage.toFixed(4)),
      processedCount: closedTradeCount,
    },
    lastOptimizationTimestamp: Date.now(),
  };

  await userRef.collection('config').doc('polymarket_preset').set(updatedConfig, { merge: true });

  await db.collection('config').doc('polymarket_metrics').set({
    brier_score: parseFloat(brierScore.toFixed(4)),
    resolved_predictions: closedTradeCount,
    avg_slippage: parseFloat((totalSlippage / Math.max(closedTradeCount, 1)).toFixed(4)),
    worst_slippage: parseFloat(Math.max(avgThinSlippage, avgLiquidSlippage).toFixed(4)),
    total_trades: closedTradeCount,
    markets_scanned: historySnapshot.size,
    consecutive_losses: 0,
  }, { merge: true });

  console.log(`[OPTIMIZER] Calibration complete. Hurdle: ${hurdleRate}, Leg: $${maxLegSize}`);
}

module.exports = { runNightlyCalibration };
