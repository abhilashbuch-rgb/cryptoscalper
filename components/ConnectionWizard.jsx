import { useState } from 'react';
import { ClobClient } from "@polymarket/clob-client-v2";

export default function ConnectionWizard({ userId, onConnectionSuccess }) {
  const [privateKey, setPrivateKey] = useState('');
  const [proxyAddress, setProxyAddress] = useState('');
  const [status, setStatus] = useState('IDLE');
  const [errorMessage, setErrorMessage] = useState('');

  const handleConnectPolymarket = async (e) => {
    e.preventDefault();
    if (!privateKey.startsWith('0x') || privateKey.length !== 66) {
      setErrorMessage("Invalid EVM Key Format. Must begin with 0x and equal 66 characters.");
      setStatus('ERROR');
      return;
    }

    setStatus('DERIVING');
    try {
      const tempClient = new ClobClient({
        host: "https://clob.polymarket.com",
        chainId: 137,
        secret: privateKey
      });

      console.log("[WIZARD] Triggering EIP-712 API credential derivation sync...");
      const apiCreds = await tempClient.createOrDeriveApiKey();

      const payload = {
        POLYMARKET_PROXY_ADDRESS: proxyAddress,
        POLYMARKET_API_KEY: apiCreds.apiKey,
        POLYMARKET_API_SECRET: apiCreds.secret,
        POLYMARKET_API_PASSPHRASE: apiCreds.passphrase,
        isConnected: true,
        activatedAt: Date.now()
      };

      await fetch(`/api/user/save-credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, credentials: payload })
      });

      setStatus('SUCCESS');
      if (onConnectionSuccess) onConnectionSuccess();
    } catch (err) {
      setErrorMessage(`Authentication Deficit: ${err.message}`);
      setStatus('ERROR');
    }
  };

  return (
    <div className="p-6 bg-[#0a0b0e] border border-[#1e293b] rounded-xl max-w-md mx-auto text-white">
      <h3 className="text-xl font-bold mb-2 flex items-center gap-2">
        <span className="w-3 h-3 rounded-full bg-[#00f2fe] animate-pulse"></span>
        Polymarket CLOB V2 Connection Wizard
      </h3>
      <p className="text-xs text-slate-400 mb-6">
        Wick requires direct interaction with the Polymarket matching engine layer.
        Export your account proxy private key from your cash profile dashboard to hook up the bot.
      </p>

      {status === 'SUCCESS' ? (
        <div className="p-4 bg-emerald-950/40 border border-emerald-500 rounded-lg text-center">
          <p className="text-emerald-400 font-medium">Engine Pipeline Fully Initialized</p>
          <p className="text-xs text-slate-400 mt-1">L1/L2 security paths successfully deployed to Coolify.</p>
        </div>
      ) : (
        <form onSubmit={handleConnectPolymarket} className="space-y-4">
          <div>
            <label className="block text-xs uppercase tracking-wider text-slate-400 font-semibold mb-1">Proxy Wallet Address</label>
            <input
              type="text"
              value={proxyAddress}
              onChange={(e) => setProxyAddress(e.target.value)}
              placeholder="0x..."
              required
              className="w-full px-3 py-2 bg-[#121318] border border-slate-800 rounded text-sm focus:outline-none focus:border-[#00f2fe]"
            />
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wider text-slate-400 font-semibold mb-1">Exported EVM Private Key</label>
            <input
              type="password"
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="0xabc123..."
              required
              className="w-full px-3 py-2 bg-[#121318] border border-slate-800 rounded text-sm focus:outline-none focus:border-[#00f2fe] font-mono"
            />
          </div>

          {status === 'ERROR' && <p className="text-xs text-rose-500 font-medium">{errorMessage}</p>}

          <button
            type="submit"
            disabled={status === 'DERIVING'}
            className="w-full py-2 bg-[#0066ff] hover:bg-[#0055ff] text-white text-sm font-semibold rounded transition disabled:bg-slate-800 disabled:text-slate-500"
          >
            {status === 'DERIVING' ? 'Deriving API Keys...' : 'Authenticate & Wake Engine'}
          </button>
        </form>
      )}
    </div>
  );
}
