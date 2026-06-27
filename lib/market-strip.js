const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

const STRIP_TTL_MS = 60 * 1000;

let strip = null;
let stripBuiltAt = 0;
let building = null;

function extractEntityKeys(text) {
  if (!text) return [];
  const normalized = text.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ');
  const tokens = normalized.split(/\s+/).filter(t => t.length > 2);

  const entities = new Set(tokens);

  const bigrams = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.push(tokens[i] + '_' + tokens[i + 1]);
  }
  bigrams.forEach(b => entities.add(b));

  return [...entities];
}

const ENTITY_ALIASES = {
  FEDERAL_RESERVE: ['FED', 'FOMC', 'RATE_CUT', 'RATE_HIKE', 'INTEREST_RATE', 'POWELL', 'FEDERAL_RESERVE'],
  FDA: ['FDA', 'DRUG_APPROVAL', 'BIOGEN', 'PFIZER', 'MODERNA', 'MERCK', 'NOVARTIS'],
  ELECTION: ['ELECTION', 'TRUMP', 'BIDEN', 'HARRIS', 'PRESIDENT', 'ELECTORAL', 'VOTE', 'POLL'],
  CRYPTO: ['BITCOIN', 'BTC', 'ETHEREUM', 'ETH', 'CRYPTO', 'SEC_CRYPTO', 'SPOT_ETF'],
  GEOPOLITICS: ['UKRAINE', 'RUSSIA', 'CHINA', 'TAIWAN', 'NATO', 'CEASEFIRE', 'SANCTIONS', 'WAR'],
  SPORTS: ['NBA', 'NFL', 'MLB', 'NHL', 'UFC', 'FINALS', 'CHAMPIONSHIP', 'SUPER_BOWL', 'WORLD_SERIES'],
  WORLD_CUP: [
    'FIFA', 'WORLD_CUP', 'FIFA_WC', 'WORLD_CUP_2026',
    'ARGENTINA', 'BRAZIL', 'FRANCE', 'GERMANY', 'SPAIN', 'ENGLAND',
    'PORTUGAL', 'NETHERLANDS', 'BELGIUM', 'ITALY', 'CROATIA',
    'URUGUAY', 'COLOMBIA', 'MEXICO', 'USA', 'JAPAN', 'SENEGAL',
    'MOROCCO', 'SAUDI_ARABIA', 'IRAN', 'EGYPT', 'NORWAY',
    'MESSI', 'MBAPPE', 'HAALAND', 'VINICIUS', 'BELLINGHAM',
    'KANE', 'SALAH', 'NEYMAR', 'RONALDO', 'LEWANDOWSKI',
    'GROUP_STAGE', 'ROUND_OF_16', 'QUARTER_FINAL', 'SEMI_FINAL',
    'KNOCKOUT', 'PENALTY', 'RED_CARD', 'GOAL', 'UPSET', 'ELIMINATED',
  ],
  FOOTBALL: [
    'EPL', 'PREMIER_LEAGUE', 'LALIGA', 'BUNDESLIGA', 'SERIE_A', 'LIGUE1',
    'CHAMPIONS_LEAGUE', 'UCL', 'EUROPA_LEAGUE', 'COPA_AMERICA', 'EURO',
    'MANCHESTER', 'LIVERPOOL', 'ARSENAL', 'CHELSEA', 'BARCELONA',
    'REAL_MADRID', 'BAYERN', 'PSG', 'JUVENTUS', 'INTER_MILAN',
    'TRANSFER', 'INJURY', 'SUSPENDED', 'MANAGER', 'SACKED',
  ],
  TECH: ['APPLE', 'GOOGLE', 'META', 'NVIDIA', 'OPENAI', 'AI', 'ARTIFICIAL_INTELLIGENCE'],
  ECONOMY: ['GDP', 'INFLATION', 'CPI', 'RECESSION', 'UNEMPLOYMENT', 'JOBS_REPORT', 'TARIFF'],
};

function buildAliasIndex() {
  const idx = new Map();
  for (const [category, aliases] of Object.entries(ENTITY_ALIASES)) {
    for (const alias of aliases) {
      idx.set(alias, category);
    }
  }
  return idx;
}

const ALIAS_INDEX = buildAliasIndex();

async function buildStrip() {
  const [eventsRes, marketsRes] = await Promise.all([
    fetch(`${GAMMA_API}/events?active=true&closed=false&limit=50`, {
      signal: AbortSignal.timeout(4000),
    }).then(r => r.json()),
    fetch(`${GAMMA_API}/markets?active=true&closed=false&limit=100&order=volume&ascending=false`, {
      signal: AbortSignal.timeout(4000),
    }).then(r => r.json()),
  ]);

  const entityIndex = new Map();
  const marketById = new Map();
  const allTokenIds = [];

  for (const market of marketsRes) {
    if (!market.clobTokenIds || market.clobTokenIds.length < 2) continue;

    const entry = {
      id: market.conditionId || market.id,
      question: market.question,
      slug: market.slug,
      yesTokenId: market.clobTokenIds[0],
      noTokenId: market.clobTokenIds[1],
      volume: parseFloat(market.volume || 0),
      eventId: market.eventId,
      active: market.active,
      yesPrice: 0,
      noPrice: 0,
    };

    marketById.set(entry.id, entry);
    allTokenIds.push(entry.yesTokenId);

    const keys = extractEntityKeys(market.question);
    for (const key of keys) {
      if (!entityIndex.has(key)) entityIndex.set(key, []);
      entityIndex.get(key).push(entry);
    }

    const aliasKeys = keys.filter(k => ALIAS_INDEX.has(k));
    for (const ak of aliasKeys) {
      const category = ALIAS_INDEX.get(ak);
      if (!entityIndex.has(category)) entityIndex.set(category, []);
      entityIndex.get(category).push(entry);
    }
  }

  const brackets = [];
  for (const ev of eventsRes) {
    if (!ev.markets || ev.markets.length < 2) continue;
    const tokens = ev.markets
      .filter(m => m.clobTokenIds && m.clobTokenIds.length >= 2)
      .map(m => ({
        slug: m.conditionId || m.slug || m.question,
        questionSlug: m.slug,
        yesTokenId: m.clobTokenIds[0],
        noTokenId: m.clobTokenIds[1],
        volume: parseFloat(m.volume || 0),
        question: m.question,
      }));
    if (tokens.length >= 2) {
      const bracket = { title: ev.title, id: ev.id, slug: ev.slug, tokens };
      brackets.push(bracket);

      const bracketKeys = extractEntityKeys(ev.title);
      for (const key of bracketKeys) {
        if (!entityIndex.has(key)) entityIndex.set(key, []);
        entityIndex.get(key).push(bracket);
      }
    }
  }

  const priceMap = {};
  const batchSize = 50;
  const priceFetches = [];
  for (let i = 0; i < allTokenIds.length; i += batchSize) {
    const batch = allTokenIds.slice(i, i + batchSize);
    const params = batch.map(id => `token_ids=${id}`).join('&');
    priceFetches.push(
      fetch(`${CLOB_API}/prices?${params}`, { signal: AbortSignal.timeout(3000) })
        .then(r => r.json())
        .then(data => { Object.assign(priceMap, data); })
        .catch(() => {})
    );
  }
  await Promise.all(priceFetches);

  for (const [, market] of marketById) {
    market.yesPrice = parseFloat(priceMap[market.yesTokenId] || 0);
    market.noPrice = 1 - market.yesPrice;
  }

  for (const bracket of brackets) {
    for (const t of bracket.tokens) {
      t.currentYesPrice = parseFloat(priceMap[t.yesTokenId] || 0);
      t.currentNoPrice = 1 - t.currentYesPrice;
    }
    bracket.totalVolume = bracket.tokens.reduce((s, t) => s + t.volume, 0);
  }

  return { entityIndex, marketById, brackets, builtAt: Date.now(), marketCount: marketById.size };
}

async function getStrip() {
  const now = Date.now();
  if (strip && (now - stripBuiltAt) < STRIP_TTL_MS) return strip;

  if (building) return building;

  building = buildStrip().then(s => {
    strip = s;
    stripBuiltAt = Date.now();
    building = null;
    return s;
  }).catch(err => {
    building = null;
    if (strip) return strip;
    throw err;
  });

  return building;
}

function matchHeadline(headline, stripData) {
  const keys = extractEntityKeys(headline);
  const hits = new Map();
  let maxScore = 0;

  for (const key of keys) {
    const category = ALIAS_INDEX.get(key);
    const lookups = [key];
    if (category) lookups.push(category);

    for (const lookup of lookups) {
      const matches = stripData.entityIndex.get(lookup);
      if (!matches) continue;

      for (const match of matches) {
        const id = match.id;
        if (!hits.has(id)) {
          hits.set(id, { market: match, score: 0, matchedKeys: [] });
        }
        const entry = hits.get(id);
        entry.score += (category ? 3 : 1);
        entry.matchedKeys.push(lookup);
        if (entry.score > maxScore) maxScore = entry.score;
      }
    }
  }

  if (hits.size === 0) return [];

  const results = [...hits.values()]
    .filter(h => h.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return results;
}

function invalidateStrip() {
  strip = null;
  stripBuiltAt = 0;
}

module.exports = { getStrip, matchHeadline, extractEntityKeys, invalidateStrip, ENTITY_ALIASES };
