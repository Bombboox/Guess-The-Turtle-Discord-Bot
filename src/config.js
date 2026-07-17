module.exports = {
  TOKEN: process.env.DISCORD_BOT_TOKEN,

  // Discord channels
  OFFICIAL_GAME_CHANNEL_ID: '1489014569220444251',
  UNOFFICIAL_GAME_CHANNEL_ID: '1502479312647880788',
  LEADERBOARD_CHANNEL_ID: '1502479349754888242',
  TURTLE_PICTURES_CHANNEL_ID: '1068714206129569873',

  // Daily schedule
  GAME_TIMEZONE: 'America/Los_Angeles',
  DAILY_GAME_TIME: '12:00 PM',
  LEADERBOARD_TIME: '1:05 PM',

  // Game tuning
  DEFAULT_GAME_DURATION_MS: 60 * 60 * 1000,
  MAX_PHOTOS: 4,
  SPECIES_FETCH_ATTEMPTS: 8,

  // Hints drop at these offsets (ms) after game start.
  HINT_1_DELAY_MS: 15 * 60 * 1000,  // 15 min: family name
  HINT_2_DELAY_MS: 30 * 60 * 1000,  // 30 min: first letter of common name

  // Chat commands
  START_COMMAND: '!startgame',
  LEADERBOARD_COMMAND: '!leaderboard',
  REDDIT_COMMAND: '!reddit',

  // Database
  DB: {
    user: process.env.DB_USER,
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'turtle_bot',
    password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT) || 5432,
  },

  INAT_USER_AGENT:
    process.env.INAT_USER_AGENT ||
    'Guess-The-Turtle-Discord-Bot (https://github.com/; contact via Discord)',
};
