const { Pool } = require('pg');
const { DB } = require('./config');

const pool = new Pool(DB);

async function initializeDatabase() {
  try {
    const info = await pool.query('SELECT current_database(), current_user');
    console.log('Connected to:', info.rows[0]);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS leaderboard (
        discord_user_id TEXT PRIMARY KEY,
        username        TEXT,
        turtles_guessed INTEGER NOT NULL DEFAULT 0,
        current_streak  INTEGER NOT NULL DEFAULT 0,
        best_streak     INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Migrate: add streak columns if they don't exist yet.
    await pool.query(`
      ALTER TABLE leaderboard
        ADD COLUMN IF NOT EXISTS current_streak INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS best_streak    INTEGER NOT NULL DEFAULT 0
    `);
  } catch (err) {
    console.error('Error initializing database:', err);
  }
}

async function updateLeaderboardForUser(userId, username) {
  try {
    const res = await pool.query(
      `INSERT INTO leaderboard (discord_user_id, username, turtles_guessed, current_streak, best_streak)
       VALUES ($1, $2, 1, 1, 1)
       ON CONFLICT (discord_user_id)
       DO UPDATE SET
         turtles_guessed = leaderboard.turtles_guessed + 1,
         current_streak  = leaderboard.current_streak + 1,
         best_streak     = GREATEST(leaderboard.best_streak, leaderboard.current_streak + 1),
         username        = EXCLUDED.username
       RETURNING current_streak, best_streak`,
      [userId, username]
    );
    return res.rows[0];
  } catch (err) {
    console.error('Error updating leaderboard:', err);
    return { current_streak: 0, best_streak: 0 };
  }
}

// Call this for every player who participated but did NOT guess the species,
// so their streak resets.
async function resetStreak(userId) {
  try {
    await pool.query(
      'UPDATE leaderboard SET current_streak = 0 WHERE discord_user_id = $1',
      [userId]
    );
  } catch (err) {
    console.error('Error resetting streak:', err);
  }
}

async function getLeaderboard() {
  try {
    const result = await pool.query(
      `SELECT username, turtles_guessed, current_streak, best_streak
       FROM leaderboard ORDER BY turtles_guessed DESC LIMIT 10`
    );
    return result.rows;
  } catch (err) {
    console.error('Error fetching leaderboard:', err);
    return [];
  }
}

async function formatLeaderboardEmbed() {
  const { EmbedBuilder } = require('discord.js');
  const leaderboard = await getLeaderboard();

  const embed = new EmbedBuilder()
    .setTitle('🐢 Turtle Leaderboard 🐢')
    .setColor(0x2ecc71);

  if (leaderboard.length === 0) {
    embed.setDescription('No leaderboard entries yet!');
    return embed;
  }

  const lines = leaderboard.map((entry, i) => {
    const medal = ['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`;
    const streak = entry.current_streak > 1 ? ` (🔥 ${entry.current_streak} streak)` : '';
    return `${medal} **${entry.username}** — ${entry.turtles_guessed} correct${streak}`;
  });

  embed.setDescription(lines.join('\n'));
  return embed;
}

module.exports = {
  initializeDatabase,
  updateLeaderboardForUser,
  resetStreak,
  getLeaderboard,
  formatLeaderboardEmbed,
};
