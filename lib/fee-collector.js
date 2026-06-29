const { ethers } = require('ethers');

const POLYGON_RPC = 'https://polygon-rpc.com';
const USDC_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // USDC on Polygon
const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
];

const TREASURY_ADDRESS = process.env.WICK_TREASURY_ADDRESS;

async function collectFee(userPrivateKey, feeAmountUsd) {
  if (!TREASURY_ADDRESS) {
    console.warn('[FEE] WICK_TREASURY_ADDRESS not set — skipping fee collection');
    return { collected: false, reason: 'no_treasury' };
  }

  if (!userPrivateKey || feeAmountUsd <= 0) {
    return { collected: false, reason: feeAmountUsd <= 0 ? 'no_profit' : 'no_key' };
  }

  try {
    const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
    const wallet = new ethers.Wallet(userPrivateKey, provider);
    const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, wallet);

    // USDC has 6 decimals
    const feeAmount = BigInt(Math.floor(feeAmountUsd * 1e6));

    const balance = await usdc.balanceOf(wallet.address);
    if (balance < feeAmount) {
      console.warn(`[FEE] Insufficient USDC: has ${balance}, needs ${feeAmount}`);
      return { collected: false, reason: 'insufficient_balance', balance: Number(balance) / 1e6 };
    }

    const tx = await usdc.transfer(TREASURY_ADDRESS, feeAmount);
    const receipt = await tx.wait();

    console.log(`[FEE] Collected $${feeAmountUsd.toFixed(4)} USDC → ${TREASURY_ADDRESS} (tx: ${receipt.hash})`);
    return {
      collected: true,
      amount: feeAmountUsd,
      txHash: receipt.hash,
      from: wallet.address,
      to: TREASURY_ADDRESS,
    };
  } catch (err) {
    console.error('[FEE] Collection failed:', err.message);
    return { collected: false, reason: 'tx_failed', error: err.message };
  }
}

module.exports = { collectFee, TREASURY_ADDRESS };
