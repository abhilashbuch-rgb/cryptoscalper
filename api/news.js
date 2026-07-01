const axios = require('axios');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function fetchScores() {
  const leagues = [
    { name: 'NBA', url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard' },
    { name: 'MLB', url: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard' },
    { name: 'NFL', url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard' },
    { name: 'NHL', url: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard' },
    { name: 'MLS', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard' },
    { name: 'EPL', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard' },
    { name: 'UCL', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard' },
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
              home: home.team?.abbreviation || home.team?.shortDisplayName || '?',
              away: away.team?.abbreviation || away.team?.shortDisplayName || '?',
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

function extractRssTitles(xml, excludeTerms = []) {
  // Match both plain and CDATA-wrapped titles, strip HTML entities
  const titles = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/gm)]
    .map(m => m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#\d+;/g, '').trim())
    .filter(t => t.length > 10 && !excludeTerms.some(ex => t.toLowerCase().includes(ex)));
  return [...new Set(titles)]; // deduplicate
}

async function fetchNews() {
  const sources = [
    { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', exclude: ['bbc news', 'bbc sport'] },
    { url: 'https://feeds.bbci.co.uk/news/rss.xml', exclude: ['bbc news', 'bbc sport'] },
    { url: 'https://www.theguardian.com/world/rss', exclude: ['the guardian'] },
    { url: 'https://feeds.npr.org/1001/rss.xml', exclude: ['npr'] },
    { url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', exclude: ['nytimes', 'new york times'] },
    { url: 'https://feeds.reuters.com/reuters/topNews', exclude: ['reuters'] },
  ];

  const allTitles = [];
  await Promise.allSettled(
    sources.map(async ({ url, exclude }) => {
      try {
        const { data } = await axios.get(url, {
          timeout: 4000,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WICK/1.0)' },
        });
        const titles = extractRssTitles(data, exclude).slice(0, 8);
        allTitles.push(...titles);
      } catch {
        // skip failed source
      }
    })
  );

  // Deduplicate, shuffle slightly (interleave sources), take top 15
  const unique = [...new Set(allTitles)].filter(t => t.length > 15).slice(0, 15);
  return unique;
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
