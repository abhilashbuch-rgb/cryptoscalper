require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const { db, FieldValue } = require('../lib/firebase-config');
const { ClobStream } = require('./clob-stream');
const { SportsStream } = require('./sports-stream');
const { AnomalyDetector } = require('./detector');

const HEALTH_PORT = parseInt(process.env.ENGINE_PORT || '3001', 10);

async function main() {
  console.log('[ENGINE] WICK Ingestion Engine starting...');
  console.log('[ENGINE] Firebase project:', process.env.FIREBASE_PROJECT_ID);

  const detector = new AnomalyDetector(db, FieldValue);
  const clobStream = new ClobStream(detector);
  const sportsStream = new SportsStream(detector);

  await detector.loadMarketStrip();
  console.log('[ENGINE] Market strip loaded');

  clobStream.connect();
  sportsStream.start();

  setInterval(() => detector.loadMarketStrip(), 60_000);

  const http = require('http');
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        uptime: process.uptime(),
        clobConnected: clobStream.isConnected(),
        sportsPolling: sportsStream.isRunning(),
        anomaliesDetected: detector.totalDetected,
        lastDetection: detector.lastDetectionAt,
        marketsTracked: detector.marketCount,
      }));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(HEALTH_PORT, () => {
    console.log(`[ENGINE] Health endpoint on :${HEALTH_PORT}/health`);
  });

  await db.collection('engine_status').doc('ingestion').set({
    status: 'RUNNING',
    startedAt: FieldValue.serverTimestamp(),
    pid: process.pid,
    hostname: require('os').hostname(),
  }, { merge: true });

  console.log('[ENGINE] All systems online. Scanning continuously.');

  process.on('SIGINT', async () => {
    console.log('[ENGINE] Shutting down...');
    clobStream.disconnect();
    sportsStream.stop();
    await db.collection('engine_status').doc('ingestion').set({
      status: 'STOPPED',
      stoppedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[ENGINE] Fatal error:', err);
  process.exit(1);
});
