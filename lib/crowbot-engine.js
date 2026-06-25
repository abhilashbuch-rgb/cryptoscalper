/**
 * Wick Platform - Advanced Crowbot Simulation Engine
 * Implements Volatility Regime Tracking and Automated Drawdown Circuit Breakers.
 */
const { db, FieldValue } = require('./firebase-config');

class CrowbotEngine {
  constructor(userId) {
    this.userId = userId;
    this.metricsRef = db.collection('users').doc(userId).collection('crowbot_metrics').doc('summary');
    this.historyRef = db.collection('users').doc(userId).collection('crowbot_history');
  }

  /**
   * Addresses Reddit Law 1: Dynamic Market Regimes
   */
  calculateRegimeMultiplier(currentVolatilityIndex) {
    if (currentVolatilityIndex === 'NORMAL') return 1.0;

    if (currentVolatilityIndex === 'HIGH_VARIANCE') {
      console.log('[CROWBOT RISK] High Variance detected. Scaling back allocation sizes.');
      return 0.5;
    }

    return 1.0;
  }

  /**
   * Addresses Reddit Law 2: Managing Peak Drawdown Panics
   */
  async executeGuardedSimulatedOrder(symbol, side, currentPrice, baseSize, marketRegime) {
    const metricsSnap = await this.metricsRef.get();
    const metrics = metricsSnap.data();

    if (!metrics) return null;

    const currentDrawdown = ((metrics.peakPortfolioValue - metrics.portfolioValue) / metrics.peakPortfolioValue) * 100;

    if (currentDrawdown > 5.0) {
      console.log(`[CROWBOT CIRCUIT BREAKER] 5% Drawdown Limit Tripped (${currentDrawdown.toFixed(2)}%). Safe Mode Enabled.`);
      baseSize = baseSize * 0.20;
    }

    const regimeMultiplier = this.calculateRegimeMultiplier(marketRegime);
    const finalizedSize = baseSize * regimeMultiplier;

    if (finalizedSize <= 0) {
      console.log('[CROWBOT] Order skipped: Size adjusted to 0 by risk engine.');
      return null;
    }

    const frictionPercentage = marketRegime === 'HIGH_VARIANCE' ? 0.0015 : 0.0004;
    const executionPrice = side === 'BUY' ? currentPrice * (1 + frictionPercentage) : currentPrice * (1 - frictionPercentage);
    const totalCost = executionPrice * finalizedSize;

    const batch = db.batch();

    const tradePayload = {
      symbol,
      side,
      executionPrice: parseFloat(executionPrice.toFixed(4)),
      size: finalizedSize,
      notional: parseFloat(totalCost.toFixed(2)),
      timestamp: Date.now(),
      marketRegimeActive: marketRegime,
      realizedDrawdownAtExecution: parseFloat(currentDrawdown.toFixed(2)),
    };

    batch.set(this.historyRef.doc(), tradePayload);

    const newPortfolioValue = side === 'BUY'
      ? metrics.portfolioValue
      : metrics.portfolioValue + (executionPrice - currentPrice) * finalizedSize;
    const newPeakValue = Math.max(metrics.peakPortfolioValue || metrics.portfolioValue, newPortfolioValue);

    batch.update(this.metricsRef, {
      portfolioValue: parseFloat(newPortfolioValue.toFixed(2)),
      peakPortfolioValue: parseFloat(newPeakValue.toFixed(2)),
      totalTrades: FieldValue.increment(1),
      lastUpdated: Date.now(),
    });

    await batch.commit();
    return tradePayload;
  }
}

module.exports = { CrowbotEngine };
