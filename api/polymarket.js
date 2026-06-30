module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const r = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&order=volume&ascending=false');
    const raw = await r.json();

    const markets = (Array.isArray(raw) ? raw : [])
      .filter(m => m.active && !m.closed && m.outcomePrices)
      .slice(0, 15)
      .map(m => {
        let yesProb = 0.5;
        try {
          const prices = JSON.parse(m.outcomePrices);
          yesProb = parseFloat(prices[0]) || 0.5;
        } catch {}
        const sentiment = yesProb >= 0.65 ? 'bullish' : yesProb <= 0.35 ? 'bearish' : 'neutral';
        return {
          question: m.question,
          yes_prob: yesProb,
          sentiment,
          volume24h: m.volume24hr || 0,
        };
      });

    return res.json({ markets });
  } catch {
    return res.json({ markets: [] });
  }
};
