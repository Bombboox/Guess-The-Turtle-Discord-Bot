// Curated scientific <-> common name handling, backed by turtle_names.json.
// This is our source of truth for which species the game uses and how guesses
// are matched.

const fs = require('fs');
const path = require('path');

const NAMES_PATH = path.join(__dirname, '..', 'turtle_names.json');

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/â€™|â€˜|â€œ|â€/g, "'")
    .replace(/[‘’`´]/g, "'")
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function addToSetMap(map, key, value) {
  if (!map[key]) map[key] = new Set();
  map[key].add(value);
}

const maps = {
  commonToScientific: {},
  scientificToCommon: {},
  commonDisplayByNormalized: {},
  scientificDisplayByNormalized: {},
};

function ingestPair(commonRaw, scientificRaw) {
  if (!commonRaw || !scientificRaw) return;
  const cNorm = normalizeName(commonRaw);
  const sNorm = normalizeName(scientificRaw);
  if (!cNorm || !sNorm) return;

  addToSetMap(maps.commonToScientific, cNorm, sNorm);
  addToSetMap(maps.scientificToCommon, sNorm, cNorm);

  if (!maps.commonDisplayByNormalized[cNorm]) {
    maps.commonDisplayByNormalized[cNorm] = String(commonRaw);
  }
  if (!maps.scientificDisplayByNormalized[sNorm]) {
    maps.scientificDisplayByNormalized[sNorm] = String(scientificRaw);
  }
}

try {
  const tn = JSON.parse(fs.readFileSync(NAMES_PATH, 'utf8'));

  if (Array.isArray(tn)) {
    tn.forEach((entry) => {
      const common = entry.common || entry.common_name || entry.commonName;
      const scientific = entry.scientific || entry.scientific_name || entry.scientificName;
      ingestPair(common, scientific);
    });
  } else if (tn && typeof tn === 'object') {
    Object.entries(tn).forEach(([commonRaw, scientificRaw]) => {
      const values = Array.isArray(scientificRaw) ? scientificRaw : [scientificRaw];
      values.forEach((scientific) => ingestPair(commonRaw, scientific));
    });
  }

  // Convert the Sets to arrays for stable iteration.
  for (const key of Object.keys(maps.commonToScientific)) {
    maps.commonToScientific[key] = Array.from(maps.commonToScientific[key]);
  }
  for (const key of Object.keys(maps.scientificToCommon)) {
    maps.scientificToCommon[key] = Array.from(maps.scientificToCommon[key]);
  }
} catch (err) {
  console.error('Failed to load turtle_names.json:', err.message);
}

// Every distinct scientific name we know a common name for. This is the pool
// the game draws from.
function getAllScientificNames() {
  return Object.values(maps.scientificDisplayByNormalized);
}

function getCommonNameFromScientific(scientificName) {
  const sNorm = normalizeName(scientificName);
  const commonSyns = maps.scientificToCommon[sNorm] || [];
  if (commonSyns.length === 0) return null;
  return maps.commonDisplayByNormalized[commonSyns[0]] || commonSyns[0];
}

// True if the player's free-text guess names the target species, either by its
// scientific name or any known common-name synonym.
function isSpeciesGuessMatch(guessText, scientificName) {
  if (!scientificName || !guessText) return false;

  const guessNorm = normalizeName(guessText);
  const sNorm = normalizeName(scientificName);
  if (!guessNorm || !sNorm) return false;

  if (guessNorm.includes(sNorm)) return true;

  const commonSyns = maps.scientificToCommon[sNorm] || [];
  for (const commonNorm of commonSyns) {
    if (guessNorm.includes(commonNorm)) return true;
  }

  // Match any contiguous phrase in the guess against the common->scientific map.
  const words = guessNorm.split(' ').filter(Boolean);
  for (let i = 0; i < words.length; i += 1) {
    for (let j = i; j < words.length; j += 1) {
      const phrase = words.slice(i, j + 1).join(' ');
      const mapped = maps.commonToScientific[phrase] || [];
      if (mapped.includes(sNorm)) return true;
    }
  }

  return false;
}

module.exports = {
  normalizeName,
  getAllScientificNames,
  getCommonNameFromScientific,
  isSpeciesGuessMatch,
};
