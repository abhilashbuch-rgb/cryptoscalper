module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const r = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=30&order=volume&ascending=false');
    const markets = await r.json();
    return res.json({ markets });
  } catch {
    return res.json({ markets: [] });
  }
};
