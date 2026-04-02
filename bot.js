const { Client, GatewayIntentBits } = require('discord.js');
const cron = require('node-cron');
const fs = require('fs');
// scientific/commonn name translations
let turtleNameMaps = { commonToScientific: {}, scientificToCommon: {} };
try {
  const tnRaw = fs.readFileSync('turtle_names.json', 'utf8');
  const tn = JSON.parse(tnRaw);

  if (Array.isArray(tn)) {
    tn.forEach(entry => {
      const common = entry.common || entry.common_name || entry.commonName;
      const scientific = entry.scientific || entry.scientific_name || entry.scientificName;
      if (common && scientific) {
        const c = common.toLowerCase();
        const s = scientific.toLowerCase();
        turtleNameMaps.commonToScientific[c] = turtleNameMaps.commonToScientific[c] || new Set();
        turtleNameMaps.commonToScientific[c].add(s);
        turtleNameMaps.scientificToCommon[s] = turtleNameMaps.scientificToCommon[s] || new Set();
        turtleNameMaps.scientificToCommon[s].add(c);
      }
    });
  } else if (tn && typeof tn === 'object') {
    Object.entries(tn).forEach(([k, v]) => {
      const common = k;
      const scientific = v;
      if (common && scientific) {
        const c = String(common).toLowerCase();
        const s = String(scientific).toLowerCase();
        turtleNameMaps.commonToScientific[c] = turtleNameMaps.commonToScientific[c] || new Set();
        turtleNameMaps.commonToScientific[c].add(s);
        turtleNameMaps.scientificToCommon[s] = turtleNameMaps.scientificToCommon[s] || new Set();
        turtleNameMaps.scientificToCommon[s].add(c);
      }
    });
  }

  Object.keys(turtleNameMaps.commonToScientific).forEach(k => {
    turtleNameMaps.commonToScientific[k] = Array.from(turtleNameMaps.commonToScientific[k]);
  });
  Object.keys(turtleNameMaps.scientificToCommon).forEach(k => {
    turtleNameMaps.scientificToCommon[k] = Array.from(turtleNameMaps.scientificToCommon[k]);
  });
} catch (err) {

  turtleNameMaps = { commonToScientific: {}, scientificToCommon: {} };
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = "1489014569220444251";

let gameState = {
  active: false,
  turtle: null,
  guessedSex: null,
  guessedSpecies: null
};

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

async function getObservationImages(observationId) {
  const apiUrl = `https://api.inaturalist.org/v1/observations/${observationId}?include=observation_photos`;
  const response = await fetch(apiUrl);
  if (!response.ok) throw new Error(`API request failed: ${response.status}`);
  const data = await response.json();
  const photos = data.results[0].observation_photos;
  const imageUrls = photos.map(p => p.photo.url.replace("square", "medium")); // up to medium quality
  return imageUrls.slice(0, 4); // max 4 images
}

async function getObservationSex(observationId) {
  const apiUrl = `https://api.inaturalist.org/v1/observations/${observationId}`;
  const response = await fetch(apiUrl);
  if (!response.ok) throw new Error(`API request failed: ${response.status}`);
  const data = await response.json();
  const annotations = data.results[0].annotations;

  function getSexFromAnnotations(annotationsArray, fallback = 'Unknown') {
    if (!Array.isArray(annotationsArray)) return fallback;

    const sexAnn = annotationsArray.find(a => {
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

async function endGame(channel) {
  if (!gameState.active) return;

  let result = `⏰ Time's up!\nToday's turtle was a ${gameState.turtle.sex} ${gameState.turtle.species}.\n`;

  if (gameState.guessedSex) result += `🎉 Congrats to ${gameState.guessedSex} for guessing the sex!\n`;
  if (gameState.guessedSpecies) result += `🎉 Congrats to ${gameState.guessedSpecies} for guessing the species!\n`;

  await channel.send(result);

  gameState.active = false;
  gameState.turtle = null;
  gameState.guessedSex = null;
  gameState.guessedSpecies = null;
}

client.on('messageCreate', async (message) => {
  if (!gameState.active || message.author.bot) return;
  if(!message) return;

  const guess = message.content.toLowerCase();

  function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  if (!gameState.guessedSex) {
    const sexVal = (gameState.turtle.sex || '').toLowerCase();
    if (sexVal && sexVal !== 'unknown') {
      const sexRegex = new RegExp(`\\b${escapeRegExp(sexVal)}\\b`);
      if (sexRegex.test(guess)) {
        gameState.guessedSex = message.author.username;
        message.reply(`✅ Correct! The sex is ${gameState.turtle.sex}`);
      }
    }
  }

  function isSpeciesGuessMatch(guessText, speciesName) {
    if (!speciesName || !guessText) return false;
    const s = speciesName.toLowerCase();

    if (guessText.includes(s)) return true;

    const commonSyns = turtleNameMaps.scientificToCommon[s] || [];
    for (const c of commonSyns) {
      if (guessText.includes(c)) return true;
    }

    const sciSyns = turtleNameMaps.commonToScientific[s] || [];
    for (const sc of sciSyns) {
      if (guessText.includes(sc)) return true;
    }

    return false;
  }

  if (!gameState.guessedSpecies && isSpeciesGuessMatch(guess, gameState.turtle.species)) {
    gameState.guessedSpecies = message.author.username;
    message.reply(`✅ Correct! The species is ${gameState.turtle.species}`);
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  const rawdata = fs.readFileSync('turtles.json');
  const turtles = JSON.parse(rawdata);

  cron.schedule('0 12 * * *', async () => {
    const channel = await client.channels.fetch(CHANNEL_ID);

    // pick random turt :3
    const turtle = turtles[Math.floor(Math.random() * turtles.length)];

    gameState = {
      active: true,
      turtle,
      guessedSex: null,
      guessedSpecies: null
    };

    let imageUrls = [];
    try {
      const parts = turtle.occurrenceID.split('/');
      const id = parts[parts.length - 1];
      imageUrls = await getObservationImages(id);

      if(!turtle.sex) {
        turtle.sex = await getObservationSex(id);
      }
    } catch (err) {
      console.error("Failed to fetch images:", err);
    }

    await channel.send({
      content: "🐢 What kind of turtle is this? (Species/Sex)",
      files: imageUrls
    });

    // 1 hour to end game
    setTimeout(() => endGame(channel), 60 * 60 * 1000);
  }, {
    timezone: "America/Los_Angeles" // PST
  });
});

client.login(TOKEN);