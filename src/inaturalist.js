// iNaturalist API client.
//
// This replaces the 35MB static GBIF dump. Given a scientific name we fetch a
// random *living* (Alive/Dead annotation = Alive), research-grade, photographed
// observation directly from iNaturalist. That single response carries the
// photos and the sex annotation, so no second round-trip is needed.

const { INAT_USER_AGENT, MAX_PHOTOS } = require('./config');

const API = 'https://api.inaturalist.org/v1';

// iNaturalist controlled-term IDs (stable, documented values).
const TERM_ALIVE_OR_DEAD = 17;
const VALUE_ALIVE = 18;
const TERM_SEX = 9;
const VALUE_FEMALE = 10;
const VALUE_MALE = 11;

// Node 18+ ships a global fetch; fall back to node-fetch otherwise.
const fetchFn = typeof fetch === 'function'
  ? fetch
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

async function getJson(url) {
  const res = await fetchFn(url, {
    headers: { 'User-Agent': INAT_USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`iNaturalist request failed: ${res.status}`);
  return res.json();
}

// Resolve a scientific name to { id, familyName }, cached for the process lifetime.
const taxonCache = new Map();
async function resolveTaxon(scientificName) {
  const key = String(scientificName).toLowerCase();
  if (taxonCache.has(key)) return taxonCache.get(key);

  const url = `${API}/taxa?${new URLSearchParams({
    q: scientificName,
    rank: 'species',
    per_page: '1',
  })}`;
  let result = { id: null, familyName: null };
  try {
    const data = await getJson(url);
    const taxon = data?.results?.[0];
    if (taxon) {
      result.id = taxon.id;
      // The search endpoint omits ancestors; fetch the detail to get them.
      try {
        const detail = await getJson(`${API}/taxa/${taxon.id}`);
        const fullTaxon = detail?.results?.[0];
        const family = (fullTaxon?.ancestors || []).find((a) => a.rank === 'family');
        result.familyName = family?.name || null;
      } catch (_) { /* family is nice-to-have, not critical */ }
    }
  } catch (err) {
    console.error(`Could not resolve taxon "${scientificName}":`, err.message);
  }
  taxonCache.set(key, result);
  return result;
}

function extractPhotos(obs) {
  const raw = obs.photos || (obs.observation_photos || []).map((p) => p.photo) || [];
  return raw
    .map((p) => p && p.url)
    .filter(Boolean)
    // The API returns "square" thumbnails; swap for a larger size.
    .map((url) => url.replace('square', 'large'))
    .slice(0, MAX_PHOTOS);
}

function extractSex(obs) {
  const ann = obs.annotations || [];
  const sex = ann.find((a) => a && a.controlled_attribute_id === TERM_SEX);
  if (!sex) return 'Unknown';
  if (sex.controlled_value_id === VALUE_FEMALE) return 'Female';
  if (sex.controlled_value_id === VALUE_MALE) return 'Male';
  return 'Unknown';
}

// Fetch a random living, photographed, research-grade observation for a species.
// Returns { scientific, sex, photos, observationUrl } or null if none exist.
async function fetchRandomLivingObservation(scientificName) {
  const taxon = await resolveTaxon(scientificName);
  if (!taxon.id) return null;
  const taxonId = taxon.id;

  const params = new URLSearchParams({
    taxon_id: String(taxonId),
    quality_grade: 'research',
    photos: 'true',
    term_id: String(TERM_ALIVE_OR_DEAD),
    term_value_id: String(VALUE_ALIVE),
    per_page: '1',
  });

  try {
    // First, how many living observations exist for this species?
    const countParams = new URLSearchParams(params);
    countParams.set('per_page', '0');
    const countData = await getJson(`${API}/observations?${countParams}`);
    // iNaturalist caps deep paging at page*per_page <= 10000.
    const total = Math.min(Number(countData?.total_results || 0), 10000);
    if (total === 0) return null;

    // Then grab one at a random offset.
    const offset = Math.floor(Math.random() * total);
    params.set('page', String(offset + 1));
    const data = await getJson(`${API}/observations?${params}`);
    const obs = data?.results?.[0];
    if (!obs) return null;

    const photos = extractPhotos(obs);
    if (photos.length === 0) return null;

    return {
      scientific: scientificName,
      family: taxon.familyName,
      sex: extractSex(obs),
      photos,
      observationUrl: `https://www.inaturalist.org/observations/${obs.id}`,
    };
  } catch (err) {
    console.error(`Observation fetch failed for "${scientificName}":`, err.message);
    return null;
  }
}

module.exports = { fetchRandomLivingObservation, resolveTaxon };
