// @polymarket/clob-client is published as a pure ESM package ("type": "module").
// Vercel's serverless Node runtime doesn't support require()-ing ESM modules,
// which throws ERR_REQUIRE_ESM and crashes the whole function at cold start.
// Dynamic import() works from CommonJS on every supported Node version, so we
// lazy-load the package instead of requiring it at module scope.
let _clobModulePromise = null;
function loadClobModule() {
  if (!_clobModulePromise) _clobModulePromise = import('@polymarket/clob-client');
  return _clobModulePromise;
}

const CLOB_HOST = 'https://clob.polymarket.com';

async function createClient(credentials) {
  const { ClobClient, Chain } = await loadClobModule();
  const { privateKey, apiKey, apiSecret, passphrase, funder } = credentials;

  if (!privateKey) throw new Error('POLYMARKET_PRIVATE_KEY required');

  const opts = {
    signer: privateKey,
  };

  if (apiKey && apiSecret && passphrase) {
    opts.creds = { key: apiKey, secret: apiSecret, passphrase };
  }

  if (funder) {
    opts.funder = funder;
  }

  return new ClobClient(CLOB_HOST, Chain.POLYGON, opts.signer, opts.creds, undefined, opts.funder);
}

function getCredentialsFromEnv() {
  return {
    privateKey: process.env.POLYMARKET_PRIVATE_KEY || null,
    apiKey: process.env.POLYMARKET_API_KEY || null,
    apiSecret: process.env.POLYMARKET_API_SECRET || null,
    passphrase: process.env.POLYMARKET_PASSPHRASE || null,
    funder: process.env.POLYMARKET_FUNDER_ADDRESS || null,
  };
}

async function verifyConnection() {
  const checks = {
    timestamp: new Date().toISOString(),
    l1_configured: false,
    l2_configured: false,
    funder_configured: false,
    heartbeat: null,
    server_time: null,
    balance_allowance: null,
    api_keys_valid: false,
    errors: [],
  };

  const creds = getCredentialsFromEnv();

  checks.l1_configured = !!creds.privateKey;
  checks.l2_configured = !!(creds.apiKey && creds.apiSecret && creds.passphrase);
  checks.funder_configured = !!creds.funder;

  if (!creds.privateKey) {
    checks.errors.push('POLYMARKET_PRIVATE_KEY not set — L1 signing unavailable');
    return checks;
  }

  let client;
  try {
    client = await createClient(creds);
  } catch (err) {
    checks.errors.push(`Client init failed: ${err.message}`);
    return checks;
  }

  // 1. Heartbeat — unauthenticated
  try {
    const ok = await client.getOk();
    checks.heartbeat = ok;
  } catch (err) {
    checks.heartbeat = false;
    checks.errors.push(`Heartbeat failed: ${err.message}`);
  }

  // 2. Server time — unauthenticated
  try {
    const time = await client.getServerTime();
    checks.server_time = time;
  } catch (err) {
    checks.errors.push(`Server time failed: ${err.message}`);
  }

  // 3. L1 auth check
  try {
    checks.can_l1_auth = client.canL1Auth();
  } catch {
    checks.can_l1_auth = false;
  }

  // 4. L2 auth — requires API credentials
  if (checks.l2_configured) {
    try {
      checks.can_l2_auth = client.canL2Auth();
    } catch {
      checks.can_l2_auth = false;
    }

    // Balance/allowance check (requires L2 auth)
    try {
      const ba = await client.getBalanceAllowance();
      checks.balance_allowance = ba;
      checks.api_keys_valid = true;
    } catch (err) {
      checks.errors.push(`Balance/allowance check failed: ${err.message}`);
    }

    // Open orders check (lightweight L2 validation)
    try {
      const orders = await client.getOpenOrders();
      checks.open_orders_count = Array.isArray(orders) ? orders.length : 0;
    } catch (err) {
      checks.errors.push(`Open orders check failed: ${err.message}`);
    }
  } else {
    checks.errors.push('L2 credentials not set — derive them by signing with your L1 key at clob.polymarket.com');
  }

  // 5. Derive API key if L2 not configured but L1 is available
  if (!checks.l2_configured && checks.can_l1_auth) {
    checks.derive_hint = 'Run POST /api/polymarket-engine?action=derive_api_key to generate L2 credentials from your L1 wallet';
  }

  checks.status = checks.errors.length === 0 ? 'OPERATIONAL' : 'DEGRADED';
  return checks;
}

async function deriveApiCredentials() {
  const creds = getCredentialsFromEnv();
  if (!creds.privateKey) throw new Error('POLYMARKET_PRIVATE_KEY required to derive API credentials');

  const client = await createClient(creds);
  const derived = await client.createOrDeriveApiKey();
  return derived;
}

async function submitMarketOrder(tokenId, side, amount) {
  const creds = getCredentialsFromEnv();
  if (!creds.apiKey || !creds.apiSecret || !creds.passphrase) {
    throw new Error('L2 API credentials required for order submission');
  }

  const { Side } = await loadClobModule();
  const client = await createClient(creds);
  const orderSide = side === 'BUY' ? Side.BUY : Side.SELL;
  const result = await client.createAndPostMarketOrder({ tokenID: tokenId, side: orderSide, amount });
  return result;
}

module.exports = { createClient, getCredentialsFromEnv, verifyConnection, deriveApiCredentials, submitMarketOrder };
