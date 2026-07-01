const axios = require('axios');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function fetchScores() {
  const leagues = [
    { name: 'NFL', url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard' },
    { name: 'NBA', url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard' },
    { name: 'MLB', url: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard' },
    { name: 'NHL', url: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard' },
    { name: 'MLS', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard' },
  ];

  const games = [];
  await Promise.allSettled(
    leagues.map(async ({ name, url }) => {
      try {
        const { data } = await axios.get(url, { timeout: 5000 });
        (data.events || []).forEach(e => {
          const comp = e.competitions?.[0];
          if (!comp) return;
          const teams = comp.competitors || [];
          const home = teams.find(t => t.homeAway === 'home');
          const away = teams.find(t => t.homeAway === 'away');
          if (home && away) {
            games.push({
              league: name,
              home: home.team?.abbreviation || '?',
              away: away.team?.abbreviation || '?',
              homeScore: home.score || '0',
              awayScore: away.score || '0',
              status: comp.status?.type?.shortDetail || 'Scheduled',
            });
          }
        });
      } catch {
        // silently skip unavailable leagues
      }
    })
  );
  return games;
}

async function fetchNews() {
  const sources = [
    'https://feeds.bbci.co.uk/news/world/rss.xml',
    'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',
  ];

  for (const url of sources) {
    try {
      const { data } = await axios.get(url, {
        timeout: 5000,
        headers: { 'User-Agent': 'WICK/1.0' },
      });
      const titles = [...data.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g)]
        .map(m => m[1].trim())
        .filter(t => t && !t.toLowerCase().includes('bbc') && !t.toLowerCase().includes('nytimes'))
        .slice(0, 12);
      if (titles.length >= 3) return titles;
    } catch {
      // try next source
    }
  }
  return [];
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const [scores, headlines] = await Promise.all([fetchScores(), fetchNews()]);
    res.json({ ok: true, scores, headlines, ts: Date.now() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
