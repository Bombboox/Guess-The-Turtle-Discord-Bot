const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const {
  DEFAULT_GAME_DURATION_MS,
  SPECIES_FETCH_ATTEMPTS,
  HINT_1_DELAY_MS,
  HINT_2_DELAY_MS,
} = require('./config');
const names = require('./names');
const { fetchRandomLivingObservation } = require('./inaturalist');
const { updateLeaderboardForUser } = require('./leaderboard');

// ── state ───────────────────────────────────────────────────────────────────

const gameStates = {
  official: newGameState(),
  unofficial: newGameState(),
};

function newGameState() {
  return {
    active: false,
    turtle: null, // { scientific, family, sex, photos, observationUrl }
    guessedSex: null,
    guessedSpecies: null,
    gameEndTimer: null,
    hintTimers: [],
    startedAt: null,
  };
}

// ── time parsing ────────────────────────────────────────────────────────────

function timeStringToCron(timeString) {
  const match = String(timeString || '').trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!match) throw new Error(`Invalid time format: "${timeString}". Use "2:52 PM" or "14:52".`);

  let hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  const period = match[3] ? match[3].toUpperCase() : null;

  if (period === 'PM' && hour !== 12) hour += 12;
  else if (period === 'AM' && hour === 12) hour = 0;

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error('Invalid time values: hour 0-23, minute 0-59.');
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
    return new Date(now.getTime() + mins * 60 * 1000);
  }

  const durationMatch = input.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i);
  if (durationMatch) {
    const amount = Number.parseInt(durationMatch[1], 10);
    if (amount <= 0) throw new Error('Duration must be greater than 0.');
    const isHours = /^(h|hr|hrs|hour|hours)$/i.test(durationMatch[2]);
    return new Date(now.getTime() + amount * (isHours ? 3600 : 60) * 1000);
  }

  const timeMatch = input.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
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
    if (endAt <= now) endAt.setDate(endAt.getDate() + 1);
    return endAt;
  }

  throw new Error('Invalid end time. Use minutes (45), duration (45m/2h), or clock time (3:30 PM / 15:30).');
}

// ── timers ──────────────────────────────────────────────────────────────────

function clearTimers(gameType) {
  const state = gameStates[gameType];
  if (state.gameEndTimer) {
    clearTimeout(state.gameEndTimer);
    state.gameEndTimer = null;
  }
  for (const t of state.hintTimers) clearTimeout(t);
  state.hintTimers = [];
}

function scheduleGameEnd(channel, endAt, gameType) {
  clearTimers(gameType);
  const delayMs = Math.max(1000, endAt.getTime() - Date.now());
  gameStates[gameType].gameEndTimer = setTimeout(() => {
    endGame(channel, gameType).catch((err) => console.error('Failed to end game:', err));
  }, delayMs);
}

function scheduleHints(channel, gameType) {
  const state = gameStates[gameType];
  if (!state.turtle) return;

  const commonName = names.getCommonNameFromScientific(state.turtle.scientific);

  // Hint 1: family name after 15 min.
  if (state.turtle.family) {
    state.hintTimers.push(setTimeout(async () => {
      if (!state.active || state.guessedSpecies) return;
      const embed = new EmbedBuilder()
        .setTitle('💡 Hint #1')
        .setDescription(`This turtle belongs to the **${state.turtle.family}** family.`)
        .setColor(0xf1c40f);
      await channel.send({ embeds: [embed] });
    }, HINT_1_DELAY_MS));
  }

  // Hint 2: first letter of common name after 30 min.
  if (commonName) {
    state.hintTimers.push(setTimeout(async () => {
      if (!state.active || state.guessedSpecies) return;
      const firstLetter = commonName.charAt(0).toUpperCase();
      const embed = new EmbedBuilder()
        .setTitle('💡 Hint #2')
        .setDescription(`The common name starts with **${firstLetter}**.`)
        .setColor(0xe67e22);
      await channel.send({ embeds: [embed] });
    }, HINT_2_DELAY_MS));
  }
}

// ── sex buttons ─────────────────────────────────────────────────────────────

function makeSexButtons(gameType) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sex_male_${gameType}`)
      .setLabel('♂ Male')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`sex_female_${gameType}`)
      .setLabel('♀ Female')
      .setStyle(ButtonStyle.Primary),
  );
}

function disabledSexButtons(gameType) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sex_male_${gameType}`)
      .setLabel('♂ Male')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`sex_female_${gameType}`)
      .setLabel('♀ Female')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );
}

// Handle a button click for sex guess.
async function handleSexButton(interaction, gameType) {
  const state = gameStates[gameType];
  if (!state.active || !state.turtle) {
    await interaction.reply({ content: 'No game is active right now.', ephemeral: true });
    return;
  }
  if (state.guessedSex) {
    await interaction.reply({ content: 'The sex has already been guessed!', ephemeral: true });
    return;
  }

  const sexVal = (state.turtle.sex || '').toLowerCase();
  if (sexVal === 'unknown') {
    await interaction.reply({ content: "This turtle's sex is unknown — no points for this one!", ephemeral: true });
    return;
  }

  const guessedMale = interaction.customId.startsWith('sex_male');
  const correct = (guessedMale && sexVal === 'male') || (!guessedMale && sexVal === 'female');

  if (!correct) {
    await interaction.reply({ content: `Not quite! That's not the right sex.`, ephemeral: true });
    return;
  }

  state.guessedSex = interaction.user.username;

  const embed = new EmbedBuilder()
    .setDescription(`✅ **${interaction.user.username}** guessed the sex — **${state.turtle.sex}**!`)
    .setColor(0x2ecc71);
  await interaction.reply({ embeds: [embed] });

  // Disable the buttons on the original message.
  try {
    await interaction.message.edit({ components: [disabledSexButtons(gameType)] });
  } catch (_) { /* might fail if message is old */ }

  if (isRoundComplete(state)) {
    await endGame(interaction.channel || interaction.message.channel, gameType, true);
  }
}

// ── start / end ─────────────────────────────────────────────────────────────

async function pickLivingTurtle() {
  const pool = names.getAllScientificNames();
  if (pool.length === 0) return null;

  for (let attempt = 0; attempt < SPECIES_FETCH_ATTEMPTS; attempt += 1) {
    const scientific = pool[Math.floor(Math.random() * pool.length)];
    const turtle = await fetchRandomLivingObservation(scientific);
    if (turtle) return turtle;
  }
  return null;
}

async function startGame(channel, endAt, gameType) {
  const state = gameStates[gameType];
  if (state.active) {
    await channel.send('A game is already active. Please wait for it to end before starting another.');
    return false;
  }

  const loadingEmbed = new EmbedBuilder()
    .setTitle('🐢 Finding a turtle...')
    .setDescription('Searching iNaturalist for a living turtle with photos. Hang tight!')
    .setColor(0x3498db);
  const loadingMsg = await channel.send({ embeds: [loadingEmbed] });

  const turtle = await pickLivingTurtle();
  if (!turtle) {
    await loadingMsg.edit({
      embeds: [loadingEmbed.setTitle('❌ Could not find a turtle').setDescription('Please try again in a moment.').setColor(0xe74c3c)],
    });
    return false;
  }

  gameStates[gameType] = {
    ...newGameState(),
    active: true,
    turtle,
    startedAt: Date.now(),
  };

  const actualEndAt = endAt instanceof Date ? endAt : new Date(Date.now() + DEFAULT_GAME_DURATION_MS);
  scheduleGameEnd(channel, actualEndAt, gameType);
  scheduleHints(channel, gameType);

  const sexKnown = turtle.sex && turtle.sex.toLowerCase() !== 'unknown';

  const embed = new EmbedBuilder()
    .setTitle('🐢 Guess the Turtle!')
    .setDescription(
      `Can you identify this turtle?\n\n` +
      `🔬 **Species** — type your guess in chat\n` +
      (sexKnown ? `⚥ **Sex** — use the buttons below\n` : '') +
      `\n⏰ Game ends <t:${Math.floor(actualEndAt.getTime() / 1000)}:R>`
    )
    .setImage(turtle.photos[0])
    .setColor(0x1abc9c)
    .setFooter({ text: 'Hints will appear at 15 and 30 minutes' });

  const components = sexKnown ? [makeSexButtons(gameType)] : [];

  await loadingMsg.edit({ embeds: [embed], components });

  // Send additional photos as a follow-up if there are more than one.
  if (turtle.photos.length > 1) {
    const extraEmbeds = turtle.photos.slice(1).map((url) =>
      new EmbedBuilder().setImage(url).setColor(0x1abc9c)
    );
    await channel.send({ embeds: extraEmbeds });
  }

  return true;
}

function isRoundComplete(state) {
  const sexKnown = state.turtle.sex && state.turtle.sex.toLowerCase() !== 'unknown';
  return Boolean(state.guessedSpecies) && (Boolean(state.guessedSex) || !sexKnown);
}

async function endGame(channel, gameType, endedEarly = false) {
  const state = gameStates[gameType];
  if (!state.active || !state.turtle) return;
  clearTimers(gameType);

  const speciesDisplay = state.turtle.scientific || 'Unknown';
  const commonName = names.getCommonNameFromScientific(speciesDisplay) || 'Unknown';
  const sexDisplay = (state.turtle.sex || 'Unknown').toLowerCase();

  const elapsed = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : null;
  const timeStr = elapsed
    ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
    : null;

  const embed = new EmbedBuilder()
    .setTitle(endedEarly ? '🎉 Round Complete!' : "⏰ Time's Up!")
    .setColor(endedEarly ? 0x2ecc71 : 0xe74c3c)
    .setThumbnail(state.turtle.photos[0]);

  let desc = `**${commonName}** (*${speciesDisplay}*)`;
  if (sexDisplay !== 'unknown') desc += `\nSex: **${sexDisplay}**`;
  if (state.turtle.family) desc += `\nFamily: *${state.turtle.family}*`;
  if (timeStr && endedEarly) desc += `\nSolved in **${timeStr}**`;
  desc += '\n';

  if (state.guessedSpecies) desc += `\n🔬 Species guessed by **${state.guessedSpecies}**`;
  if (state.guessedSex) desc += `\n⚥ Sex guessed by **${state.guessedSex}**`;
  if (!state.guessedSpecies && !endedEarly) desc += `\nNobody guessed the species this time.`;

  if (state.turtle.observationUrl) {
    desc += `\n\n🔗 [View on iNaturalist](${state.turtle.observationUrl})`;
  }

  embed.setDescription(desc);
  await channel.send({ embeds: [embed] });

  gameStates[gameType] = newGameState();
}

// ── guessing (text for species) ─────────────────────────────────────────────

async function handleGuess(message, gameType) {
  const state = gameStates[gameType];
  if (!state.active || !state.turtle) return;

  const guess = String(message.content || '').trim();
  if (!guess) return;

  if (!state.guessedSpecies && names.isSpeciesGuessMatch(guess, state.turtle.scientific)) {
    state.guessedSpecies = message.author.username;
    const speciesDisplay = state.turtle.scientific || 'unknown species';
    const commonDisplay = names.getCommonNameFromScientific(speciesDisplay) || 'unknown turtle species';

    const { current_streak } = await updateLeaderboardForUser(message.author.id, message.author.username);

    const embed = new EmbedBuilder()
      .setDescription(
        `✅ **${message.author.username}** got the species!\n` +
        `**${commonDisplay}** (*${speciesDisplay}*)`
      )
      .setColor(0x2ecc71);

    if (current_streak > 1) {
      embed.setFooter({ text: `🔥 ${current_streak} correct in a row!` });
    }

    await message.reply({ embeds: [embed] });

    if (isRoundComplete(state)) {
      await endGame(message.channel, gameType, true);
    }
  }
}

module.exports = {
  startGame,
  endGame,
  handleGuess,
  handleSexButton,
  timeStringToCron,
  parseGameEndTimeInput,
};
