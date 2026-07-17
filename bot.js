require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const cron = require('node-cron');

const config = require('./src/config');
const { initializeDatabase, formatLeaderboardEmbed } = require('./src/leaderboard');
const game = require('./src/game');
const { fetchTopTurtlePost } = require('./src/reddit');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── button interactions (sex guess) ─────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const id = interaction.customId;
  if (id.startsWith('sex_male_') || id.startsWith('sex_female_')) {
    const gameType = id.endsWith('_unofficial') ? 'unofficial'
                   : id.endsWith('_official') ? 'official'
                   : null;
    if (!gameType) return;
    await game.handleSexButton(interaction, gameType);
  }
});

// ── text commands & species guesses ─────────────────────────────────────────

client.on('messageCreate', async (message) => {
  if (!message || message.author.bot) return;

  const rawContent = String(message.content || '').trim();
  const lowerContent = rawContent.toLowerCase();

  // !leaderboard
  if (lowerContent.startsWith(config.LEADERBOARD_COMMAND)) {
    const embed = await formatLeaderboardEmbed();
    await message.reply({ embeds: [embed] });
    return;
  }

  // !reddit — post today's top r/turtle post in the turtle pictures channel.
  if (lowerContent.startsWith(config.REDDIT_COMMAND)) {
    try {
      const post = await fetchTopTurtlePost();
      if (!post) {
        await message.reply('No posts found on r/turtle in the last 24 hours.');
        return;
      }

      const channel = await client.channels.fetch(config.TURTLE_PICTURES_CHANNEL_ID);

      const embeds = [
        new EmbedBuilder()
          .setTitle(post.title.slice(0, 256))
          .setURL(post.link)
          .setColor(0xff4500)
          .setFooter({ text: "Today's top post on r/turtle" }),
      ];
      if (post.images.length) embeds[0].setImage(post.images[0]);
      for (const url of post.images.slice(1, 10)) {
        embeds.push(new EmbedBuilder().setImage(url).setColor(0xff4500));
      }

      await channel.send({ embeds });

      // Videos can't go in embeds — send the links so Discord embeds them.
      if (post.videos.length) {
        await channel.send(post.videos.join('\n'));
      }

      if (message.channelId !== config.TURTLE_PICTURES_CHANNEL_ID) {
        await message.reply(`Posted in <#${config.TURTLE_PICTURES_CHANNEL_ID}>!`);
      }
    } catch (err) {
      console.error('Error fetching r/turtle post:', err);
      await message.reply(`Could not fetch the top r/turtle post: ${err.message}`);
    }
    return;
  }

  // !startgame (unofficial channel only)
  if (lowerContent.startsWith(config.START_COMMAND)) {
    if (message.channelId !== config.UNOFFICIAL_GAME_CHANNEL_ID) {
      await message.reply('Please start games in the unofficial turtle game channel.');
      return;
    }
    const param = rawContent.slice(config.START_COMMAND.length).trim();
    let endAt;
    try {
      endAt = game.parseGameEndTimeInput(param);
    } catch (err) {
      await message.reply(`Could not parse end time: ${err.message}`);
      return;
    }
    await game.startGame(message.channel, endAt, 'unofficial');
    return;
  }

  // Otherwise treat as a species guess in whichever game channel it landed in.
  const gameType =
    message.channelId === config.OFFICIAL_GAME_CHANNEL_ID ? 'official' :
    message.channelId === config.UNOFFICIAL_GAME_CHANNEL_ID ? 'unofficial' : null;

  if (gameType) await game.handleGuess(message, gameType);
});

// ── startup & cron ──────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  await initializeDatabase();

  // Daily official game.
  cron.schedule(game.timeStringToCron(config.DAILY_GAME_TIME), async () => {
    try {
      const channel = await client.channels.fetch(config.OFFICIAL_GAME_CHANNEL_ID);
      await game.startGame(channel, new Date(Date.now() + config.DEFAULT_GAME_DURATION_MS), 'official');
    } catch (err) {
      console.error('Error starting official game:', err);
    }
  }, { timezone: config.GAME_TIMEZONE });

  // Daily leaderboard.
  cron.schedule(game.timeStringToCron(config.LEADERBOARD_TIME), async () => {
    try {
      const channel = await client.channels.fetch(config.LEADERBOARD_CHANNEL_ID);
      const embed = await formatLeaderboardEmbed();
      await channel.send({ embeds: [embed] });
    } catch (err) {
      console.error('Error sending leaderboard:', err);
    }
  }, { timezone: config.GAME_TIMEZONE });
});

client.login(config.TOKEN);
