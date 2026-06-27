const SPORTS_POLL_MS = 5_000;
const NEWS_POLL_MS = 30_000;
const SCAN_TIMEOUT = 3000;

const ESPN_FEEDS = [
  { url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard', tag: 'FIFA_WC' },
  { url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard', tag: 'UCL' },
  { url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard', tag: 'EPL' },
  { url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard', tag: 'LALIGA' },
  { url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard', tag: 'BUNDESLIGA' },
  { url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard', tag: 'SERIE_A' },
  { url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard', tag: 'LIGUE1' },
  { url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/conmebol.america/scoreboard', tag: 'COPA' },
  { url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.euro/scoreboard', tag: 'EURO' },
  { url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard', tag: 'NFL' },
  { url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard', tag: 'NBA' },
  { url: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard', tag: 'MLB' },
  { url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard', tag: 'MLS' },
  { url: 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard', tag: 'UFC' },
];

const NEWS_QUERIES = [
  'breaking+news+when:1h',
  'federal+reserve+OR+inflation+when:4h',
  'election+OR+Trump+OR+Biden+when:4h',
  'FDA+OR+SEC+OR+regulation+when:4h',
  'bitcoin+OR+crypto+OR+ethereum+when:4h',
  'FIFA+World+Cup+2026+when:4h',
  'World+Cup+football+OR+soccer+goal+OR+upset+when:2h',
];

class SportsStream {
  constructor(detector) {
    this.detector = detector;
    this.sportsTimer = null;
    this.newsTimer = null;
    this.running = false;
    this.lastScores = new Map();
    this.seenHeadlines = new Set();
  }

  isRunning() { return this.running; }

  start() {
    if (this.running) return;
    this.running = true;
    console.log(`[SPORTS] Polling ESPN every ${SPORTS_POLL_MS / 1000}s, news every ${NEWS_POLL_MS / 1000}s`);

    this.pollSports();
    this.sportsTimer = setInterval(() => this.pollSports(), SPORTS_POLL_MS);

    this.pollNews();
    this.newsTimer = setInterval(() => this.pollNews(), NEWS_POLL_MS);
  }

  stop() {
    this.running = false;
    if (this.sportsTimer) { clearInterval(this.sportsTimer); this.sportsTimer = null; }
    if (this.newsTimer) { clearInterval(this.newsTimer); this.newsTimer = null; }
    console.log('[SPORTS] Stopped');
  }

  async pollSports() {
    const fetches = ESPN_FEEDS.map(({ url, tag }) =>
      fetch(url, { signal: AbortSignal.timeout(SCAN_TIMEOUT) })
        .then(r => r.json())
        .then(data => this.processSportsData(data, tag))
        .catch(() => {})
    );
    await Promise.allSettled(fetches);
  }

  processSportsData(data, tag) {
    if (!data?.events) return;

    for (const ev of data.events) {
      const c = ev.competitions?.[0];
      if (!c) continue;
      const teams = c.competitors || [];
      const home = teams.find(t => t.homeAway === 'home');
      const away = teams.find(t => t.homeAway === 'away');
      const homeScore = parseInt(home?.score || 0);
      const awayScore = parseInt(away?.score || 0);
      const homeName = home?.team?.displayName || home?.team?.abbreviation || '?';
      const awayName = away?.team?.displayName || away?.team?.abbreviation || '?';
      const status = c.status?.type?.shortDetail || '';
      const completed = c.status?.type?.completed || false;
      const inProgress = c.status?.type?.state === 'in';

      const matchKey = `${tag}_${ev.id}`;
      const scoreKey = `${awayScore}-${homeScore}`;
      const prevScore = this.lastScores.get(matchKey);

      if (prevScore && prevScore !== scoreKey) {
        console.log(`[SPORTS] SCORE CHANGE: ${tag} ${awayName} ${prevScore} → ${scoreKey} vs ${homeName}`);
        this.detector.onSportsEvent({
          type: 'SCORE_CHANGE',
          tag,
          headline: `${tag}: ${awayName} ${awayScore} @ ${homeName} ${homeScore} — ${status}`,
          source: `espn_${tag.toLowerCase()}`,
          sport: tag,
          homeTeam: homeName,
          awayTeam: awayName,
          homeScore,
          awayScore,
          status,
          completed,
          inProgress,
          prevScore,
          newScore: scoreKey,
          timestamp: Date.now(),
        });
      }

      this.lastScores.set(matchKey, scoreKey);

      if (inProgress || completed) {
        this.detector.onHeadline({
          headline: `${tag}: ${awayName} ${awayScore} @ ${homeName} ${homeScore} — ${status}`,
          source: `espn_${tag.toLowerCase()}`,
          sport: tag,
          fetchedAt: Date.now(),
        });
      }
    }
  }

  async pollNews() {
    const [google, reddit] = await Promise.all([
      this.fetchGoogleNews(),
      this.fetchReddit(),
    ]);

    for (const h of [...google, ...reddit]) {
      const key = h.headline.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
      if (this.seenHeadlines.has(key)) continue;
      this.seenHeadlines.add(key);
      if (this.seenHeadlines.size > 1000) {
        const first = this.seenHeadlines.values().next().value;
        this.seenHeadlines.delete(first);
      }
      this.detector.onHeadline(h);
    }
  }

  async fetchGoogleNews() {
    const fetches = NEWS_QUERIES.map(q =>
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
    return (await Promise.all(fetches)).flat();
  }

  async fetchReddit() {
    const subs = ['worldnews', 'politics', 'cryptocurrency', 'economics', 'soccer'];
    const fetches = subs.map(sub =>
      fetch(`https://www.reddit.com/r/${sub}/new.json?limit=5`, {
        headers: { 'User-Agent': 'WICK/1.0' },
        signal: AbortSignal.timeout(SCAN_TIMEOUT),
      })
        .then(r => r.json())
        .then(data => {
          if (!data?.data?.children) return [];
          return data.data.children
            .filter(c => Date.now() - (c.data.created_utc || 0) * 1000 < 3600_000)
            .map(c => ({
              headline: c.data.title,
              source: `reddit_${sub}`,
              upvotes: c.data.ups || 0,
              fetchedAt: Date.now(),
            }));
        })
        .catch(() => [])
    );
    return (await Promise.all(fetches)).flat();
  }
}

module.exports = { SportsStream };
