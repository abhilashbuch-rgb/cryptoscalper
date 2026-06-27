const WebSocket = require('ws');

const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const RECONNECT_DELAY_MS = 3000;
const PING_INTERVAL_MS = 30_000;

class ClobStream {
  constructor(detector) {
    this.detector = detector;
    this.ws = null;
    this.connected = false;
    this.subscribedMarkets = new Set();
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.priceCache = new Map();
  }

  isConnected() { return this.connected; }

  connect() {
    if (this.ws) return;
    console.log('[CLOB-WS] Connecting to', CLOB_WS_URL);

    this.ws = new WebSocket(CLOB_WS_URL);

    this.ws.on('open', () => {
      this.connected = true;
      console.log('[CLOB-WS] Connected');
      this.subscribeAll();
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, PING_INTERVAL_MS);
    });

    this.ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        this.handleMessage(data);
      } catch {}
    });

    this.ws.on('close', (code) => {
      console.log(`[CLOB-WS] Disconnected (code ${code}). Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
      this.cleanup();
      this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    });

    this.ws.on('error', (err) => {
      console.error('[CLOB-WS] Error:', err.message);
    });
  }

  disconnect() {
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  cleanup() {
    this.connected = false;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.ws = null;
  }

  subscribeAll() {
    const markets = this.detector.getTrackedConditionIds();
    if (markets.length === 0) {
      console.log('[CLOB-WS] No markets to subscribe to yet');
      return;
    }

    const batchSize = 20;
    for (let i = 0; i < markets.length; i += batchSize) {
      const batch = markets.slice(i, i + batchSize);
      const msg = JSON.stringify({
        type: 'subscribe',
        channel: 'market',
        assets_id: batch,
      });
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(msg);
      }
      batch.forEach(id => this.subscribedMarkets.add(id));
    }

    console.log(`[CLOB-WS] Subscribed to ${markets.length} market assets`);
  }

  resubscribe() {
    if (!this.connected) return;
    this.subscribedMarkets.clear();
    this.subscribeAll();
  }

  handleMessage(data) {
    if (!data || data.type === 'pong') return;

    if (Array.isArray(data)) {
      for (const item of data) this.processUpdate(item);
    } else {
      this.processUpdate(data);
    }
  }

  processUpdate(update) {
    const assetId = update.asset_id;
    if (!assetId) return;

    const price = parseFloat(update.price || update.best_ask || 0);
    if (!price || price <= 0) return;

    const prevPrice = this.priceCache.get(assetId) || 0;
    this.priceCache.set(assetId, price);

    if (prevPrice > 0 && Math.abs(price - prevPrice) > 0.005) {
      this.detector.onPriceUpdate(assetId, price, prevPrice);
    }
  }
}

module.exports = { ClobStream };
