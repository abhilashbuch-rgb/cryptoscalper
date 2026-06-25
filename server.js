require('dotenv').config();
const { db } = require('./lib/firebase-config');
const { PolymarketV2Engine } = require('./lib/polymarket-v2-core');

const THROTTLE_DELAY_MS = parseInt(process.env.SCAN_INTERVAL_MS || '5000');
let activeWorkerInstance = null;

async function startWickDaemon() {
  console.log("[DAEMON] Wick Core Process Engine initialized. Awaiting user connectivity profiles...");

  db.collection('users').doc('global_operator').collection('config').doc('polymarket_preset')
    .onSnapshot(async (snapshot) => {
      const config = snapshot.data();

      if (!config || !config.isConnected) {
        console.log("[DAEMON] Status: STANDBY. Connection wizard credentials missing or inactive.");
        if (activeWorkerInstance) {
          clearInterval(activeWorkerInstance);
          activeWorkerInstance = null;
        }
        return;
      }

      if (activeWorkerInstance) return;

      console.log("==========================================================");
      console.log("POLYMARKET ENGINE ACTIVATION DETECTED FROM CONNECTION WIZARD");
      console.log(`Proxy Target Address: ${config.POLYMARKET_PROXY_ADDRESS}`);
      console.log("Launching 24/7 Arbitrage Data Loop...");
      console.log("==========================================================");

      const liveEngine = new PolymarketV2Engine('global_operator');

      activeWorkerInstance = setInterval(async () => {
        try {
          await liveEngine.executePurePolymarketCycle();
        } catch (error) {
          console.error("[CYCLE ERROR] Operational fault caught during arbitrage step:", error.message);
        }
      }, THROTTLE_DELAY_MS);
    });
}

startWickDaemon();
