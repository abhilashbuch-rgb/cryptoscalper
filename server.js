require('dotenv').config();
const http = require('http');
const { db } = require('./lib/firebase-config');
const { PolymarketV2Engine } = require('./lib/polymarket-v2-core');

const THROTTLE_DELAY_MS = parseInt(process.env.SCAN_INTERVAL_MS || '5000');
const HEALTH_PORT = parseInt(process.env.PORT || '3000');
let activeWorkerInstance = null;
let daemonStatus = 'STANDBY';
let lastCycleAt = null;
let cycleCount = 0;

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      daemon: daemonStatus,
      uptime: process.uptime(),
      cycles: cycleCount,
      lastCycle: lastCycleAt,
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.listen(HEALTH_PORT, () => {
  console.log(`[HEALTH] Listening on :${HEALTH_PORT}/health`);
});

async function startWickDaemon() {
  console.log("[DAEMON] Wick Core Process Engine initialized. Awaiting user connectivity profiles...");

  db.collection('users').doc('global_operator').collection('config').doc('polymarket_preset')
    .onSnapshot(async (snapshot) => {
      const config = snapshot.data();

      if (!config || !config.isConnected) {
        console.log("[DAEMON] Status: STANDBY. Connection wizard credentials missing or inactive.");
        daemonStatus = 'STANDBY';
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

      daemonStatus = 'ACTIVE';
      const liveEngine = new PolymarketV2Engine('global_operator');

      activeWorkerInstance = setInterval(async () => {
        try {
          await liveEngine.executePurePolymarketCycle();
          cycleCount++;
          lastCycleAt = new Date().toISOString();
        } catch (error) {
          console.error("[CYCLE ERROR] Operational fault caught during arbitrage step:", error.message);
        }
      }, THROTTLE_DELAY_MS);
    });
}

startWickDaemon();
