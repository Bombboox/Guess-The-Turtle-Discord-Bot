require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const cron = require('node-cron');
const fs = require('fs');
const { Pool } = require('pg');
const { scrapeRedditTopPosts } = require('./app');

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'turtle_bot',
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
});

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/â€™|â€˜|â€œ|â€/g, "'")
    .replace(/[\u2018\u2019`\u00B4]/g, "'")
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
const OFFICIAL_GAME_CHANNEL_ID = '1489014569220444251';
const UNOFFICIAL_GAME_CHANNEL_ID = '1502479312647880788';
const LEADERBOARD_CHANNEL_ID = '1502479349754888242';
const REDDIT_CHANNEL_ID = '1068714206129569873';
const GAME_TIMEZONE = 'America/Los_Angeles';
const DAILY_GAME_TIME = '12:00 PM';
const LEADERBOARD_TIME = '1:05 PM';
const REDDIT_POST_TIME = '8:00 AM';
const DEFAULT_GAME_DURATION_MS = 60 * 60 * 1000;
const START_COMMAND = '!startgame';
const LEADERBOARD_COMMAND = '!leaderboard';
const REDDIT_COMMAND = '!reddit';

// Reddit command settings
const REDDIT_COMMAND_ENABLED = true;

let turtles = [];

let gameStates = {
  official: {
    active: false,
    turtle: null,
    guessedSex: null,
    guessedSpecies: null,
    gameEndTimer: null
  },
  unofficial: {
    active: false,
    turtle: null,
    guessedSex: null,
    guessedSpecies: null,
    gameEndTimer: null
  }
};

const fetch = (...args) => import('node-fetch').then(({ default: fetchFn }) => fetchFn(...args));

// Database initialization
async function initializeDatabase() {
  try {
    const dbCheck = await pool.query('SELECT current_database(), current_user');
    console.log('Connected to:', dbCheck.rows[0]);

    const rows = await pool.query('SELECT * FROM leaderboard');
    console.log('Leaderboard rows:', rows.rows);
  } catch (err) {
    console.error('Error initializing database:', err);
  }
}

// Leaderboard operations
async function updateLeaderboardForUser(userId, username) {
  try {
    const userExists = await pool.query(
      'SELECT * FROM leaderboard WHERE discord_user_id = $1',
      [userId]
    );

    if (userExists.rows.length === 0) {
      // Create new entry
      await pool.query(
        'INSERT INTO leaderboard (discord_user_id, username, turtles_guessed) VALUES ($1, $2, $3)',
        [userId, username, 1]
      );
    } else {
      // Update existing entry
      await pool.query(
        'UPDATE leaderboard SET turtles_guessed = turtles_guessed + 1, username = $1, updated_at = CURRENT_TIMESTAMP WHERE discord_user_id = $2',
        [username, userId]
      );
    }
  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
}

async function getLeaderboard() {
  try {
    const result = await pool.query(
      'SELECT username, turtles_guessed FROM leaderboard ORDER BY turtles_guessed DESC LIMIT 10'
    );
    return result.rows;
  } catch (err) {
    console.error('Error fetching leaderboard:', err);
    return [];
  }
}

async function formatLeaderboardMessage() {
  const leaderboard = await getLeaderboard();
  if (leaderboard.length === 0) {
    return 'No leaderboard entries yet!';
  }

  let message = '🐢 **TURTLE LEADERBOARD** 🐢\n\n';
  leaderboard.forEach((entry, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
    message += `${medal} **${entry.username}** - ${entry.turtles_guessed} turtles guessed\n`;
  });

  return message;
}

function normalizeUrl(url) {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  return `https://reddit.com${url}`;
}

async function postDailyRedditPost(channel) {
  try {
    const posts = await scrapeRedditTopPosts();  

    if (!posts || posts.length === 0) {
      await channel.send('Could not fetch Reddit posts at this time.');
      return;
    }

    const topPost = posts[0];

    if (!topPost || !topPost.title) {
      await channel.send('Invalid Reddit post data.');
      return;
    }

    const postUrl = normalizeUrl(topPost.url);

    let messageContent = `🐢 **Turtle Post of the Day** 🐢\n\n` +
      `**${topPost.title}** ~ ${topPost.author || 'unknown'}`;

    // VIDEO CASE
    if (topPost.video && topPost.video.src) {
      await channel.send({ content: messageContent });
      await channel.send({ content: topPost.video.src }); // plain URL on its own = Discord embeds it
      return;
    }
    // IMAGE CASE
    else if (topPost.images && topPost.images.length > 0) {
      console.log('Reddit post has images:', topPost.images);

      // Send header first
      await channel.send({ content: messageContent });

      const imagesToUse = topPost.images.slice(0, 4);

      for (const img of imagesToUse) {
        if (img) {
          await channel.send({ content: img }); // send each image separately
        }
      }
    }
    // NEITHER
    else {
      if (postUrl) {
        messageContent += `\n\n🔗 [Post Link](${postUrl})`;
      }
      await channel.send({
        content: messageContent
      });
    }
  } catch (err) {
    console.error('Error posting daily Reddit post:', err);

    try {
      await channel.send(
        `Error fetching today's top Reddit post. Please try again later.\n\`${err.message}\``
      );
    } catch (sendErr) {
      console.error('Error sending error message:', sendErr);
    }
  }
}


function timeStringToCron(timeString) {
  const timeRegex = /^(\d{1,2}):(\d{2})\s*(am|pm|AM|PM)?$/;
  const match = String(timeString || '').trim().match(timeRegex);

  if (!match) {
    throw new Error(`Invalid time format: "${timeString}". Use format like "2:52 PM" or "14:52"`);
  }

  let hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
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

function parseGameEndTimeInput(rawInput) {
  const now = new Date();
  const input = String(rawInput || '').trim();

  if (!input) return new Date(now.getTime() + DEFAULT_GAME_DURATION_MS);

  if (/^\d+$/.test(input)) {
    const mins = Number.parseInt(input, 10);
    if (mins <= 0) throw new Error('Minutes must be greater than 0.');
    return new Date(now.getTime() + (mins * 60 * 1000));
  }

  const durationMatch = input.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i);
  if (durationMatch) {
    const amount = Number.parseInt(durationMatch[1], 10);
    const unit = durationMatch[2].toLowerCase();
    if (amount <= 0) throw new Error('Duration must be greater than 0.');
    const isHours = ['h', 'hr', 'hrs', 'hour', 'hours'].includes(unit);
    const ms = isHours ? amount * 60 * 60 * 1000 : amount * 60 * 1000;
    return new Date(now.getTime() + ms);
  }

  const timeMatch = input.match(/^(\d{1,2}):(\d{2})\s*(am|pm|AM|PM)?$/);
  if (timeMatch) {
    let hour = Number.parseInt(timeMatch[1], 10);
    const minute = Number.parseInt(timeMatch[2], 10);
    const meridiem = timeMatch[3] ? timeMatch[3].toUpperCase() : null;

    if (meridiem) {
      if (hour < 1 || hour > 12) throw new Error('12-hour time must use an hour from 1 to 12.');
      if (meridiem === 'PM' && hour !== 12) hour += 12;
      if (meridiem === 'AM' && hour === 12) hour = 0;
    } else if (hour < 0 || hour > 23) {
      throw new Error('24-hour time must use an hour from 0 to 23.');
    }

    if (minute < 0 || minute > 59) throw new Error('Minutes must be between 0 and 59.');

    const endAt = new Date(now);
    endAt.setHours(hour, minute, 0, 0);
    if (endAt <= now) {
      endAt.setDate(endAt.getDate() + 1);
    }
    return endAt;
  }

  throw new Error('Invalid end time. Use minutes (45), duration (45m/2h), or clock time (3:30 PM or 15:30).');
}

function clearGameEndTimer(gameType) {
  if (gameStates[gameType].gameEndTimer) {
    clearTimeout(gameStates[gameType].gameEndTimer);
    gameStates[gameType].gameEndTimer = null;
  }
}

function scheduleGameEnd(channel, endAt, gameType) {
  clearGameEndTimer(gameType);
  const delayMs = Math.max(1000, endAt.getTime() - Date.now());
  gameStates[gameType].gameEndTimer = setTimeout(() => {
    endGame(channel, gameType).catch((err) => console.error('Failed to end game:', err));
  }, delayMs);
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

async function endGame(channel, gameType) {
  if (!gameStates[gameType].active || !gameStates[gameType].turtle) return;
  clearGameEndTimer(gameType);

  const speciesDisplay = String(gameStates[gameType].turtle.species || 'unknown species');
  const commonName = getCommonNameFromSpecies(speciesDisplay) || 'unknown turtle species';
  const sexDisplay = String(gameStates[gameType].turtle.sex || 'Unknown').toLowerCase();

  let result = `Time's up!\nToday's turtle was a ${sexDisplay} ${commonName} (${speciesDisplay}).\n`;

  if (gameStates[gameType].guessedSex) result += `Congrats to ${gameStates[gameType].guessedSex} for guessing the sex!\n`;
  if (gameStates[gameType].guessedSpecies) result += `Congrats to ${gameStates[gameType].guessedSpecies} for guessing the species!\n`;

  await channel.send(result);

  gameStates[gameType].active = false;
  gameStates[gameType].turtle = null;
  gameStates[gameType].guessedSex = null;
  gameStates[gameType].guessedSpecies = null;
}

async function startGame(channel, endAt, gameType) {
  if (gameStates[gameType].active) {
    await channel.send('A game is already active. Please wait for it to end before starting another.');
    return false;
  }

  if (!Array.isArray(turtles) || turtles.length === 0) {
    await channel.send('Unable to start game: turtle data is not loaded.');
    return false;
  }

  const turtle = turtles[Math.floor(Math.random() * turtles.length)];

  gameStates[gameType] = {
    active: true,
    turtle,
    guessedSex: null,
    guessedSpecies: null,
    gameEndTimer: null
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

  const actualEndAt = endAt instanceof Date ? endAt : new Date(Date.now() + DEFAULT_GAME_DURATION_MS);
  scheduleGameEnd(channel, actualEndAt, gameType);

  await channel.send({
    content: `What kind of turtle is this? (Species/Sex)\nGame ends at ${actualEndAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`,
    files: imageUrls
  });

  return true;
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message) return;

  const rawContent = String(message.content || '').trim();
  const lowerContent = rawContent.toLowerCase();

  // Handle leaderboard command
  if (lowerContent.startsWith(LEADERBOARD_COMMAND)) {
    const leaderboardMessage = await formatLeaderboardMessage();
    await message.reply(leaderboardMessage);
    return;
  }

  // Handle reddit command - for testing
  if (lowerContent.startsWith(REDDIT_COMMAND)) {
    if (!REDDIT_COMMAND_ENABLED) {
      await message.reply('Reddit command is currently disabled.');
      return;
    }

    try {
      const channel = await client.channels.fetch(REDDIT_CHANNEL_ID);
      await postDailyRedditPost(channel);
    } catch (err) {
      console.error('Error handling reddit command:', err);
      await message.reply('Error fetching Reddit post. Please try again later.');
    }
    return;
  }

  // Handle startgame command - only in unofficial channel
  if (lowerContent.startsWith(START_COMMAND)) {
    if (message.channelId !== UNOFFICIAL_GAME_CHANNEL_ID) {
      await message.reply('Please start games in the unofficial turtle game channel.');
      return;
    }

    const param = rawContent.slice(START_COMMAND.length).trim();

    let endAt;
    try {
      endAt = parseGameEndTimeInput(param);
    } catch (err) {
      await message.reply(`Could not parse end time: ${err.message}`);
      return;
    }

    const started = await startGame(message.channel, endAt, 'unofficial');
    return;
  }

  // Handle guesses for both official and unofficial games
  const gameType = message.channelId === OFFICIAL_GAME_CHANNEL_ID ? 'official' : 
                   message.channelId === UNOFFICIAL_GAME_CHANNEL_ID ? 'unofficial' : null;

  if (!gameType || !gameStates[gameType].active || !gameStates[gameType].turtle) return;

  const guess = rawContent;

  function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  if (!gameStates[gameType].guessedSex) {
    const sexVal = normalizeName(gameStates[gameType].turtle.sex || '');
    const guessNorm = normalizeName(guess);
    if (sexVal && sexVal !== 'unknown') {
      const sexRegex = new RegExp(`\\b${escapeRegExp(sexVal)}\\b`);
      if (sexRegex.test(guessNorm)) {
        gameStates[gameType].guessedSex = message.author.username;
        await message.reply(`Correct! The sex is ${gameStates[gameType].turtle.sex}`);
      }
    }
  }

  if (!gameStates[gameType].guessedSpecies && isSpeciesGuessMatch(guess, gameStates[gameType].turtle.species)) {
    gameStates[gameType].guessedSpecies = message.author.username;
    const speciesDisplay = String(gameStates[gameType].turtle.species || 'unknown species');
    const commonDisplay = getCommonNameFromSpecies(speciesDisplay) || 'unknown turtle species';
    
    // Update leaderboard when species is guessed
    await updateLeaderboardForUser(message.author.id, message.author.username);
    
    await message.reply(`Correct! The species is ${commonDisplay} (${speciesDisplay}).`);
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  // Initialize database
  await initializeDatabase();

  const rawdata = fs.readFileSync('turtles.json');
  turtles = JSON.parse(rawdata);

  // Daily official game at 12 PM
  cron.schedule(timeStringToCron(DAILY_GAME_TIME), async () => {
    try {
      const channel = await client.channels.fetch(OFFICIAL_GAME_CHANNEL_ID);
      await startGame(channel, new Date(Date.now() + DEFAULT_GAME_DURATION_MS), 'official');
    } catch (err) {
      console.error('Error starting official game:', err);
    }
  }, {
    timezone: GAME_TIMEZONE
  });

  // Daily leaderboard display at 1:05 PM
  cron.schedule(timeStringToCron(LEADERBOARD_TIME), async () => {
    try {
      const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
      const leaderboardMessage = await formatLeaderboardMessage();
      await channel.send(leaderboardMessage);
    } catch (err) {
      console.error('Error sending leaderboard:', err);
    }
  }, {
    timezone: GAME_TIMEZONE
  });

  // Daily Reddit post at 8 PM
  cron.schedule(timeStringToCron(REDDIT_POST_TIME), async () => {
    try {
      const channel = await client.channels.fetch(REDDIT_CHANNEL_ID);
      await postDailyRedditPost(channel);
    } catch (err) {
      console.error('Error posting daily Reddit post:', err);
    }
  }, {
    timezone: GAME_TIMEZONE
  });
});

client.login(TOKEN);
