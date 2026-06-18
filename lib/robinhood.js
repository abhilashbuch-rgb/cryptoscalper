const axios = require('axios');

const BASE = 'https://api.robinhood.com';
const NUMMUS = 'https://nummus.robinhood.com';

class RobinhoodClient {
  constructor(accessToken) {
    this.headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
    };
  }

  async getCryptoPrices(symbols) {
    const pairs = symbols.map(s => `${s}-USD`).join(',');
    const res = await axios.get(`${BASE}/marketdata/forex/quotes/`, {
      params: { symbols: pairs },
      headers: this.headers,
    });
    const results = {};
    for (const q of res.data.results) {
      const sym = q.symbol.replace('-USD', '');
      results[sym] = {
        price: parseFloat(q.mark_price),
        bid: parseFloat(q.bid_price),
        ask: parseFloat(q.ask_price),
        updatedAt: q.updated_at,
      };
    }
    return results;
  }

  async getCryptoHoldings() {
    const res = await axios.get(`${NUMMUS}/holdings/`, { headers: this.headers });
    return res.data.results.map(h => ({
      symbol: h.currency.code,
      quantity: parseFloat(h.quantity),
      costBasis: parseFloat(h.cost_bases?.[0]?.direct_cost_basis || 0),
    }));
  }

  async getPortfolio() {
    const res = await axios.get(`${BASE}/accounts/`, { headers: this.headers });
    const account = res.data.results[0];
    return {
      cash: parseFloat(account.portfolio_cash || account.buying_power),
      portfolioValue: parseFloat(account.portfolio_value || 0),
    };
  }

  async placeCryptoOrder({ symbol, side, amountUsd }) {
    const payload = {
      account_id: await this._getAccountId(),
      currency_pair_id: await this._getCurrencyPairId(symbol),
      side,
      type: 'market',
      time_in_force: 'ioc',
      dollar_amount: amountUsd.toFixed(2),
      ref_id: crypto.randomUUID(),
    };
    const res = await axios.post(`${NUMMUS}/orders/`, payload, { headers: this.headers });
    return res.data;
  }

  async _getAccountId() {
    if (this._accountId) return this._accountId;
    const res = await axios.get(`${NUMMUS}/accounts/`, { headers: this.headers });
    this._accountId = res.data.results[0].id;
    return this._accountId;
  }

  async _getCurrencyPairId(symbol) {
    if (!this._pairCache) this._pairCache = {};
    if (this._pairCache[symbol]) return this._pairCache[symbol];
    const res = await axios.get(`${BASE}/currency_pairs/`, { headers: this.headers });
    for (const pair of res.data.results) {
      if (pair.asset_currency.code === symbol) {
        this._pairCache[symbol] = pair.id;
        return pair.id;
      }
    }
    throw new Error(`Currency pair not found for ${symbol}`);
  }
}

module.exports = RobinhoodClient;
