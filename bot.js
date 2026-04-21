require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const cron = require('node-cron');
const fs = require('fs');

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/â€™|â€˜|â€œ|â€/g, "'")
    .replace(/[’‘`´]/g, "'")
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function addToSetMap(map, key, value) {
  if (!map[key]) map[key] = new Set();
  map[key].add(value);
}

// scientific/common name translations
let turtleNameMaps = {
  commonToScientific: {},
  scientificToCommon: {},
  commonDisplayByNormalized: {},
  scientificDisplayByNormalized: {}
};

try {
  const tnRaw = fs.readFileSync('turtle_names.json', 'utf8');
  const tn = JSON.parse(tnRaw);

  if (Array.isArray(tn)) {
    tn.forEach((entry) => {
      const common = entry.common || entry.common_name || entry.commonName;
      const scientific = entry.scientific || entry.scientific_name || entry.scientificName;
      if (!common || !scientific) return;

      const cNorm = normalizeName(common);
      const sNorm = normalizeName(scientific);
      if (!cNorm || !sNorm) return;

      addToSetMap(turtleNameMaps.commonToScientific, cNorm, sNorm);
      addToSetMap(turtleNameMaps.scientificToCommon, sNorm, cNorm);

      if (!turtleNameMaps.commonDisplayByNormalized[cNorm]) {
        turtleNameMaps.commonDisplayByNormalized[cNorm] = String(common);
      }
      if (!turtleNameMaps.scientificDisplayByNormalized[sNorm]) {
        turtleNameMaps.scientificDisplayByNormalized[sNorm] = String(scientific);
      }
    });
  } else if (tn && typeof tn === 'object') {
    Object.entries(tn).forEach(([commonRaw, scientificRaw]) => {
      const scientificValues = Array.isArray(scientificRaw) ? scientificRaw : [scientificRaw];
      scientificValues.forEach((scientific) => {
        if (!commonRaw || !scientific) return;

        const cNorm = normalizeName(commonRaw);
        const sNorm = normalizeName(scientific);
        if (!cNorm || !sNorm) return;

        addToSetMap(turtleNameMaps.commonToScientific, cNorm, sNorm);
        addToSetMap(turtleNameMaps.scientificToCommon, sNorm, cNorm);

        if (!turtleNameMaps.commonDisplayByNormalized[cNorm]) {
          turtleNameMaps.commonDisplayByNormalized[cNorm] = String(commonRaw);
        }
        if (!turtleNameMaps.scientificDisplayByNormalized[sNorm]) {
          turtleNameMaps.scientificDisplayByNormalized[sNorm] = String(scientific);
        }
      });
    });
  }

  Object.keys(turtleNameMaps.commonToScientific).forEach((key) => {
    turtleNameMaps.commonToScientific[key] = Array.from(turtleNameMaps.commonToScientific[key]);
  });

  Object.keys(turtleNameMaps.scientificToCommon).forEach((key) => {
    turtleNameMaps.scientificToCommon[key] = Array.from(turtleNameMaps.scientificToCommon[key]);
  });
} catch (err) {
  turtleNameMaps = {
    commonToScientific: {},
    scientificToCommon: {},
    commonDisplayByNormalized: {},
    scientificDisplayByNormalized: {}
  };
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = '1489014569220444251';

let gameState = {
  active: false,
  turtle: null,
  guessedSex: null,
  guessedSpecies: null
};

const fetch = (...args) => import('node-fetch').then(({ default: fetchFn }) => fetchFn(...args));

function timeStringToCron(timeString) {
  const timeRegex = /^(\d{1,2}):(\d{2})\s*(am|pm|AM|PM)?$/;
  const match = String(timeString || '').trim().match(timeRegex);

  if (!match) {
    throw new Error(`Invalid time format: "${timeString}". Use format like "2:52 PM" or "14:52"`);
  }

  let hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  const period = match[3] ? match[3].toUpperCase() : null;

  if (period) {
    if (period === 'PM' && hour !== 12) {
      hour += 12;
    } else if (period === 'AM' && hour === 12) {
      hour = 0;
    }
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error('Invalid time values: hour must be 0-23, minute must be 0-59');
  }

  return `${minute} ${hour} * * *`;
}

async function getObservationImages(observationId) {
  const apiUrl = `https://api.inaturalist.org/v1/observations/${observationId}?include=observation_photos`;
  const response = await fetch(apiUrl);
  if (!response.ok) throw new Error(`API request failed: ${response.status}`);

  const data = await response.json();
  const photos = data?.results?.[0]?.observation_photos || [];
  const imageUrls = photos
    .map((p) => p?.photo?.url)
    .filter(Boolean)
    .map((url) => url.replace('square', 'medium'));

  return imageUrls.slice(0, 4);
}

async function getObservationSex(observationId) {
  const apiUrl = `https://api.inaturalist.org/v1/observations/${observationId}`;
  const response = await fetch(apiUrl);
  if (!response.ok) throw new Error(`API request failed: ${response.status}`);

  const data = await response.json();
  const annotations = data?.results?.[0]?.annotations || [];

  function getSexFromAnnotations(annotationsArray, fallback = 'Unknown') {
    if (!Array.isArray(annotationsArray)) return fallback;

    const sexAnn = annotationsArray.find((a) => {
      if (!a) return false;
      const ca = a.controlled_attribute;
      if (ca && ca.label && typeof ca.label === 'string' && ca.label.toLowerCase() === 'sex') return true;
      if (typeof a.controlled_attribute_id !== 'undefined' && a.controlled_attribute_id === 9) return true;
      if (a.concatenated_attr_val && typeof a.concatenated_attr_val === 'string') {
        const parts = a.concatenated_attr_val.split('|');
        if (parts[0] === '9') return true;
      }
      return false;
    });

    if (!sexAnn) return fallback;
    if (sexAnn.controlled_value && sexAnn.controlled_value.label) return sexAnn.controlled_value.label;
    return fallback;
  }

  return getSexFromAnnotations(annotations, 'Unknown');
}

function getCommonNameFromSpecies(speciesName) {
  const speciesNorm = normalizeName(speciesName);
  const commonSyns = turtleNameMaps.scientificToCommon[speciesNorm] || [];
  if (commonSyns.length === 0) return null;

  const displayCommon = turtleNameMaps.commonDisplayByNormalized[commonSyns[0]];
  return displayCommon || commonSyns[0];
}

function isSpeciesGuessMatch(guessText, speciesName) {
  if (!speciesName || !guessText) return false;

  const guessTextNorm = normalizeName(guessText);
  const speciesNorm = normalizeName(speciesName);
  if (!guessTextNorm || !speciesNorm) return false;

  if (guessTextNorm.includes(speciesNorm)) return true;

  const commonSyns = turtleNameMaps.scientificToCommon[speciesNorm] || [];
  for (const commonNorm of commonSyns) {
    if (guessTextNorm.includes(commonNorm)) return true;
  }

  const guessWords = guessTextNorm.split(' ').filter(Boolean);
  for (let i = 0; i < guessWords.length; i += 1) {
    for (let j = i; j < guessWords.length; j += 1) {
      const phrase = guessWords.slice(i, j + 1).join(' ');
      const mappedSpecies = turtleNameMaps.commonToScientific[phrase] || [];
      if (mappedSpecies.includes(speciesNorm)) return true;
    }
  }

  return false;
}

async function endGame(channel) {
  if (!gameState.active || !gameState.turtle) return;

  const speciesDisplay = String(gameState.turtle.species || 'unknown species');
  const commonName = getCommonNameFromSpecies(speciesDisplay) || 'unknown turtle species';
  const sexDisplay = String(gameState.turtle.sex || 'Unknown').toLowerCase();

  let result = `Time's up!\nToday's turtle was a ${sexDisplay} ${commonName} (${speciesDisplay}).\n`;

  if (gameState.guessedSex) result += `Congrats to ${gameState.guessedSex} for guessing the sex!\n`;
  if (gameState.guessedSpecies) result += `Congrats to ${gameState.guessedSpecies} for guessing the species!\n`;

  await channel.send(result);

  gameState.active = false;
  gameState.turtle = null;
  gameState.guessedSex = null;
  gameState.guessedSpecies = null;
}

client.on('messageCreate', async (message) => {
  if (!gameState.active || message.author.bot) return;
  if (!message || !gameState.turtle) return;

  const guess = String(message.content || '');

  function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  if (!gameState.guessedSex) {
    const sexVal = normalizeName(gameState.turtle.sex || '');
    const guessNorm = normalizeName(guess);
    if (sexVal && sexVal !== 'unknown') {
      const sexRegex = new RegExp(`\\b${escapeRegExp(sexVal)}\\b`);
      if (sexRegex.test(guessNorm)) {
        gameState.guessedSex = message.author.username;
        await message.reply(`Correct! The sex is ${gameState.turtle.sex}`);
      }
    }
  }

  if (!gameState.guessedSpecies && isSpeciesGuessMatch(guess, gameState.turtle.species)) {
    gameState.guessedSpecies = message.author.username;
    const speciesDisplay = String(gameState.turtle.species || 'unknown species');
    const commonDisplay = getCommonNameFromSpecies(speciesDisplay) || 'unknown turtle species';
    await message.reply(`Correct! The species is ${commonDisplay} (${speciesDisplay}).`);
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  const rawdata = fs.readFileSync('turtles.json');
  const turtles = JSON.parse(rawdata);

  cron.schedule(timeStringToCron('12:00 PM'), async () => {
    const channel = await client.channels.fetch(CHANNEL_ID);

    // Pick a random turtle record.
    const turtle = turtles[Math.floor(Math.random() * turtles.length)];

    gameState = {
      active: true,
      turtle,
      guessedSex: null,
      guessedSpecies: null
    };

    let imageUrls = [];
    try {
      const occurrenceId = String(turtle.occurrenceID || '');
      const parts = occurrenceId.split('/');
      const id = parts[parts.length - 1];

      if (id) {
        imageUrls = await getObservationImages(id);

        if (!turtle.sex) {
          turtle.sex = await getObservationSex(id);
        }
      }
    } catch (err) {
      console.error('Failed to fetch images:', err);
    }

    await channel.send({
      content: 'What kind of turtle is this? (Species/Sex)',
      files: imageUrls
    });

    // 1 hour to end game.
    setTimeout(() => endGame(channel), 60 * 60 * 1000);
  }, {
    timezone: 'America/Los_Angeles'
  });
});

client.login(TOKEN);
