const SCAN_TIMEOUT = 2500;

let headlineCache = [];
let headlineCacheAt = 0;
const HEADLINE_CACHE_TTL = 10_000;
const seenHeadlines = new Set();
const SEEN_MAX = 500;

async function fetchGoogleNewsMulti() {
  const queries = [
    'breaking+news+when:1h',
    'federal+reserve+OR+inflation+OR+GDP+when:4h',
    'election+OR+Trump+OR+Biden+OR+vote+when:4h',
    'FDA+OR+SEC+OR+regulation+when:4h',
    'bitcoin+OR+crypto+OR+ethereum+when:4h',
  ];
  const fetches = queries.map(q =>
    fetch(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`, {
      headers: { 'User-Agent': 'WICK/1.0' },
      signal: AbortSignal.timeout(SCAN_TIMEOUT),
    })
      .then(r => r.text())
      .then(xml => {
        const titles = [];
        const re = /<title><!\[CDATA\[(.*?)\]\]><\/title>/g;
        let m;
        while ((m = re.exec(xml)) !== null && titles.length < 5) {
          titles.push({ headline: m[1], source: 'google_news', fetchedAt: Date.now() });
        }
        return titles;
      })
      .catch(() => [])
  );
  const results = await Promise.all(fetches);
  return results.flat();
}

async function fetchReddit() {
  const subs = ['worldnews', 'politics', 'cryptocurrency', 'economics'];
  const fetches = subs.map(sub =>
    fetch(`https://www.reddit.com/r/${sub}/new.json?limit=5`, {
      headers: { 'User-Agent': 'WICK/1.0' },
      signal: AbortSignal.timeout(SCAN_TIMEOUT),
    })
      .then(r => r.json())
      .then(data => {
        if (!data?.data?.children) return [];
        return data.data.children
          .filter(c => {
            const created = (c.data.created_utc || 0) * 1000;
            return Date.now() - created < 3600_000;
          })
          .map(c => ({
            headline: c.data.title,
            source: `reddit_${sub}`,
            upvotes: c.data.ups || 0,
            fetchedAt: Date.now(),
          }));
      })
      .catch(() => [])
  );
  const results = await Promise.all(fetches);
  return results.flat();
}

async function fetchESPN() {
  const leagues = [
    { url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard', tag: 'NFL' },
    { url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard', tag: 'NBA' },
    { url: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard', tag: 'MLB' },
    { url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard', tag: 'MLS' },
    { url: 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard', tag: 'UFC' },
  ];
  const fetches = leagues.map(({ url, tag }) =>
    fetch(url, { signal: AbortSignal.timeout(SCAN_TIMEOUT) })
      .then(r => r.json())
      .then(data => {
        const headlines = [];
        for (const ev of (data.events || [])) {
          const c = ev.competitions?.[0];
          if (!c) continue;
          const teams = c.competitors || [];
          const home = teams.find(t => t.homeAway === 'home');
          const away = teams.find(t => t.homeAway === 'away');
          const status = c.status?.type?.shortDetail || '';
          const completed = c.status?.type?.completed || false;
          const homeScore = parseInt(home?.score || 0);
          const awayScore = parseInt(away?.score || 0);
          const homeName = home?.team?.displayName || home?.team?.abbreviation || '?';
          const awayName = away?.team?.displayName || away?.team?.abbreviation || '?';

          headlines.push({
            headline: `${tag}: ${awayName} ${awayScore} @ ${homeName} ${homeScore} — ${status}`,
            source: `espn_${tag.toLowerCase()}`,
            sport: tag,
            completed,
            homeTeam: homeName,
            awayTeam: awayName,
            homeScore,
            awayScore,
            status,
            fetchedAt: Date.now(),
          });
        }
        return headlines;
      })
      .catch(() => [])
  );
  const results = await Promise.all(fetches);
  return results.flat();
}

async function fetchSECEdgar() {
  return fetch('https://efts.sec.gov/LATEST/search-index?q=%22enforcement%22+OR+%22settlement%22+OR+%22charges%22&dateRange=custom&startdt=' + new Date(Date.now() - 86400_000).toISOString().slice(0, 10) + '&enddt=' + new Date().toISOString().slice(0, 10), {
    headers: { 'User-Agent': 'WICK trading@wick.network' },
    signal: AbortSignal.timeout(SCAN_TIMEOUT),
  })
    .then(r => r.json())
    .then(data => {
      if (!data?.hits?.hits) return [];
      return data.hits.hits.slice(0, 5).map(h => ({
        headline: h._source?.file_description || h._source?.display_names?.[0] || 'SEC Filing',
        source: 'sec_edgar',
        fetchedAt: Date.now(),
      }));
    })
    .catch(() => []);
}

function dedup(headlines) {
  const unique = [];
  for (const h of headlines) {
    const key = h.headline.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (seenHeadlines.has(key)) continue;
    seenHeadlines.add(key);
    if (seenHeadlines.size > SEEN_MAX) {
      const first = seenHeadlines.values().next().value;
      seenHeadlines.delete(first);
    }
    unique.push(h);
  }
  return unique;
}

async function scanAllSources() {
  const now = Date.now();
  if (headlineCache.length > 0 && (now - headlineCacheAt) < HEADLINE_CACHE_TTL) {
    return headlineCache;
  }

  const [google, reddit, espn, sec] = await Promise.all([
    fetchGoogleNewsMulti(),
    fetchReddit(),
    fetchESPN(),
    fetchSECEdgar(),
  ]);

  const all = [...google, ...reddit, ...espn, ...sec];
  const unique = dedup(all);

  unique.sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0));

  headlineCache = unique;
  headlineCacheAt = now;

  return unique;
}

function resetCache() {
  headlineCache = [];
  headlineCacheAt = 0;
}

module.exports = { scanAllSources, resetCache };
