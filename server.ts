import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import axios from "axios";
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, GuildMember, Guild, ColorResolvable } from "discord.js";
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, StreamType, entersState } from "@discordjs/voice";
import ffmpeg from "ffmpeg-static";
import dotenv from "dotenv";

if (ffmpeg) {
  process.env.FFMPEG_PATH = ffmpeg;
}

dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID; // Optional, we can get it from client.user.id

// Bot State
let botStatus = "offline";
let botServers = 0;
let botUptime = 0;
let startTime = Date.now();
let lastError = "";

process.on("unhandledRejection", (reason, promise) => {
  console.error("[CRITICAL] Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[CRITICAL] Uncaught Exception:", error);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const commands = [
  new SlashCommandBuilder()
    .setName("pomodoro")
    .setDescription("Start a focus cycle with custom study and break times")
    .addStringOption(option =>
      option.setName("study")
        .setDescription("Study duration in hh:mm:ss (default: 00:25:00)")
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName("break")
        .setDescription("Break duration in hh:mm:ss (default: 00:05:00)")
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName("task")
        .setDescription("What are you working on?")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("todo")
    .setDescription("Manage your study todo list")
    .addSubcommand(subcommand =>
      subcommand.setName("add")
        .setDescription("Add a task")
        .addStringOption(option => option.setName("task").setDescription("The task").setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand.setName("list")
        .setDescription("List your tasks")
    )
    .addSubcommand(subcommand =>
      subcommand.setName("complete")
        .setDescription("Complete a task")
        .addIntegerOption(option => option.setName("index").setDescription("Task number").setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand.setName("remove")
        .setDescription("Remove a task without completing it")
        .addIntegerOption(option => option.setName("index").setDescription("Task number").setRequired(true))
    ),
  new SlashCommandBuilder()
    .setName("break")
    .setDescription("Start a break timer")
    .addIntegerOption(option => option.setName("hours").setDescription("Duration in hours").setRequired(false))
    .addIntegerOption(option => option.setName("minutes").setDescription("Duration in minutes").setRequired(false))
    .addIntegerOption(option => option.setName("seconds").setDescription("Duration in seconds").setRequired(false)),
  new SlashCommandBuilder()
    .setName("note")
    .setDescription("Add a note to your study journal")
    .addStringOption(option => option.setName("text").setDescription("The note content").setRequired(true)),
  new SlashCommandBuilder()
    .setName("journal")
    .setDescription("View your study journal"),
  new SlashCommandBuilder()
    .setName("study")
    .setDescription("Get a motivational study quote"),
  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause your current focus session"),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop your current focus session"),
  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Check your current study level and XP"),
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("See the top focusers in the server"),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Check Nova's current health and uptime"),
  new SlashCommandBuilder()
    .setName("theme")
    .setDescription("Change Nova's aesthetic theme")
    .addStringOption(option =>
      option.setName("choice")
        .setDescription("Pick a theme")
        .setRequired(true)
        .addChoices(
          { name: "🌸 Sakura Blossom", value: "sakura" },
          { name: "🌿 Deep Forest", value: "forest" },
          { name: "🌊 Ocean Breeze", value: "ocean" },
          { name: "🌙 Midnight Sky", value: "midnight" },
          { name: "☕ Coffee Shop", value: "coffee" }
        )
    ),
  new SlashCommandBuilder()
    .setName("group")
    .setDescription("Manage study groups and collective goals")
    .addSubcommand(subcommand =>
      subcommand.setName("create")
        .setDescription("Create a new study group")
        .addStringOption(option => option.setName("name").setDescription("Group name").setRequired(true))
        .addIntegerOption(option => option.setName("goal").setDescription("Study goal in hours").setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand.setName("join")
        .setDescription("Join a study group by ID")
        .addStringOption(option => option.setName("id").setDescription("Group ID").setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand.setName("invite")
        .setDescription("Invite a user to your current group")
        .addUserOption(option => option.setName("user").setDescription("User to invite").setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand.setName("stats")
        .setDescription("View your group's progress and members")
    )
    .addSubcommand(subcommand =>
      subcommand.setName("leave")
        .setDescription("Leave your current study group")
    ),
  new SlashCommandBuilder()
    .setName("test-summary")
    .setDescription("Test the monthly aesthetic summary DM"),
  new SlashCommandBuilder()
    .setName("test-pomodoro")
    .setDescription("Start a 10-second focus session to test linking"),
  new SlashCommandBuilder()
    .setName("test-xp")
    .setDescription("Set your XP to a specific level for testing")
    .addIntegerOption(option => 
      option.setName("level")
        .setDescription("The level to set (e.g. 2, 10, 25)")
        .setRequired(true)
    ),
];

// In-memory store for todos (user_id -> string[])
const userTodos = new Map<string, string[]>();

interface StudyGroup {
  id: string;
  name: string;
  ownerId: string;
  members: string[];
  goalSeconds: number;
  totalSecondsFocused: number;
  createdAt: number;
}
const studyGroups = new Map<string, StudyGroup>();

// Pomodoro Sessions
interface PomodoroSession {
  userId: string;
  channelId: string;
  guildId: string | null;
  remainingSeconds: number;
  totalSeconds: number;
  task: string;
  startTime: number;
  endTime: number;
  isPaused: boolean;
  isBreak: boolean;
  participants: string[];
  groupId: string | null;
  messageId: string | null;
}
const activeSessions = new Map<string, PomodoroSession>();

// Global Timer Manager
setInterval(async () => {
  const now = Date.now();
  for (const [userId, session] of activeSessions.entries()) {
    if (session.isPaused) continue;

    const remaining = Math.max(0, Math.floor((session.endTime - now) / 1000));
    session.remainingSeconds = remaining;

    // Update the embed every 10 seconds (or on completion)
    if (remaining % 10 === 0 || remaining === 0) {
      try {
        const channel = await client.channels.fetch(session.channelId);
        if (channel?.isTextBased() && session.messageId) {
          const message = await channel.messages.fetch(session.messageId);
          if (message) {
            const isFinished = remaining === 0;
            const embed = createPomodoroEmbed(
              session.totalSeconds, 
              remaining, 
              session.task, 
              isFinished, 
              session.isPaused, 
              session.isBreak, 
              userId, 
              session.participants
            );
            
            await message.edit({ 
              embeds: [embed],
              components: isFinished ? [] : [createControlRow(userId, session.isPaused)]
            });
          }
        }
      } catch (e) {
        // Silently fail if message/channel is gone, but keep timer running
      }
    }

    if (remaining === 0) {
      // Session Finished!
      activeSessions.delete(userId);
      await handleSessionCompletion(session);
    }
  }
}, 1000);

async function handleSessionCompletion(session: PomodoroSession) {
  const { userId, isBreak, totalSeconds, participants, groupId, channelId, guildId } = session;
  
  if (!isBreak) {
    const stats = getUserStats(userId);
    stats.xp += 10;
    stats.totalFocusTime += totalSeconds;
    stats.level = Math.floor(stats.xp / 100) + 1;

    // Sync Roles
    if (guildId) {
      try {
        const guild = await client.guilds.fetch(guildId);
        const member = await guild.members.fetch(userId);
        if (guild && member) await syncUserRoles(guild, member, stats);
      } catch (e) { console.error("[ROLES] Sync failed:", e); }
    }

    // Group Stats
    if (groupId) {
      const group = studyGroups.get(groupId);
      if (group) group.totalSecondsFocused += totalSeconds;
    }
  }

  // Send Completion Message & Pings
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.isTextBased()) {
      const pings = participants.map(id => `<@${id}>`).join(" ");
      const stats = getUserStats(userId);
      const tip = ["Stretching", "Drinking Water", "Deep Breaths", "Looking Away"][Math.floor(Math.random() * 4)];
      
      const endEmbed = createSessionEndEmbed(isBreak, tip, stats);
      const nextButton = new ButtonBuilder()
        .setCustomId(isBreak ? `start_focus_${userId}` : `start_break_${userId}`)
        .setLabel(isBreak ? `Start Focus` : `Start Break`)
        .setStyle(ButtonStyle.Success);

      const msg = await (channel as any).send({
        content: `🔔 **Session Complete!** ${pings}`,
        embeds: [endEmbed],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(nextButton)],
        allowedMentions: { users: participants }
      });

      // Automatic Transition in 10 seconds
      setTimeout(async () => {
        if (!activeSessions.has(userId)) {
          console.log(`[TRANSITION] Auto-starting next session for ${userId}`);
          // We don't have an interaction here, so we pass a mock one or refactor startSession
          // For now, let's create a minimal interaction-like object for startSession
          const mockInteraction = {
            channelId,
            guildId,
            user: { id: userId, username: "User" },
            replied: true,
            deferred: false,
            followUp: async (opts: any) => {
              const ch = await client.channels.fetch(channelId);
              if (ch?.isTextBased()) return await (ch as any).send(opts);
            }
          };
          if (isBreak) {
            await startSession(mockInteraction, userId, 0, 0, stats.studyPreferenceSeconds, "General Study", false);
          } else {
            await startSession(mockInteraction, userId, 0, 0, stats.breakPreferenceSeconds, "Break", true);
          }
        }
      }, 10000);

      // Voice Beep
      if (guildId) {
        try {
          const guild = await client.guilds.fetch(guildId);
          const member = await guild.members.fetch(userId);
          if (member?.voice.channel) {
            const connection = joinVoiceChannel({
              channelId: member.voice.channel.id,
              guildId: guild.id,
              adapterCreator: guild.voiceAdapterCreator,
            });
            await entersState(connection, VoiceConnectionStatus.Ready, 5000);
            const player = createAudioPlayer();
            const response = await axios.get('https://actions.google.com/sounds/v1/alarms/beep_short.ogg', { responseType: 'stream' });
            const resource = createAudioResource(response.data, { inputType: StreamType.OggOpus });
            connection.subscribe(player);
            player.play(resource);
            player.on(AudioPlayerStatus.Idle, () => connection.destroy());
          }
        } catch (e) { /* voice fail is non-critical */ }
      }
    }
  } catch (e) { console.error("[COMPLETION] Error:", e); }
}

interface UserStats {
  xp: number;
  level: number;
  streak: number;
  lastStudyDate: string | null;
  totalFocusTime: number; // in seconds
  notes: string[];
  studyPreferenceSeconds: number;
  breakPreferenceSeconds: number;
  theme: string;
  groupId: string | null;
}

const THEMES: Record<string, { color: ColorResolvable, emoji: string, barFull: string, barEmpty: string, name: string }> = {
  sakura: { color: "#fe9494", emoji: "🌸", barFull: "🌸", barEmpty: "🤍", name: "Sakura Blossom" },
  forest: { color: "#2d5a27", emoji: "🌿", barFull: "🌿", barEmpty: "🍃", name: "Deep Forest" },
  ocean: { color: "#0077be", emoji: "🌊", barFull: "🌊", barEmpty: "💧", name: "Ocean Breeze" },
  midnight: { color: "#2c003e", emoji: "🌙", barFull: "🌙", barEmpty: "⭐", name: "Midnight Sky" },
  coffee: { color: "#6f4e37", emoji: "☕", barFull: "☕", barEmpty: "🍪", name: "Coffee Shop" },
};

const userStats = new Map<string, UserStats>();

const getUserStats = (userId: string): UserStats => {
  if (!userStats.has(userId)) {
    userStats.set(userId, {
      xp: 0,
      level: 1,
      streak: 0,
      lastStudyDate: null,
      totalFocusTime: 0,
      notes: [],
      studyPreferenceSeconds: 25 * 60,
      breakPreferenceSeconds: 5 * 60,
      theme: "sakura",
      groupId: null
    });
  }
  return userStats.get(userId)!;
};

const parseDuration = (str: string | null, defaultSeconds: number): number => {
  if (!str) return defaultSeconds;
  const parts = str.split(':').map(Number);
  if (parts.length === 3) {
    return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  } else if (parts.length === 2) {
    return (parts[0] * 60) + parts[1];
  } else if (parts.length === 1 && !isNaN(parts[0])) {
    return parts[0] * 60;
  }
  return defaultSeconds;
};

const formatDuration = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

const createSessionEndEmbed = (isBreak: boolean, tip: string, stats: UserStats) => {
  const embed = new EmbedBuilder()
    .setTitle(isBreak ? "🌸 Break Finished!" : "⏰ Focus Finished!")
    .setColor("#fe9494")
    .setDescription(isBreak 
      ? "Your break has ended. Ready for another focus session? ✨" 
      : `Great job! Now it's time for a well-deserved break. 🎀\n\n**Nova's Tip:** Try **${tip}** to refresh your mind!`)
    .addFields(
      { name: "Next Session", value: isBreak ? "Focus Session" : "Break", inline: true },
      { name: "Duration", value: isBreak ? formatDuration(stats.studyPreferenceSeconds) : formatDuration(stats.breakPreferenceSeconds), inline: true }
    )
    .setTimestamp();
  return embed;
};

const updateStreak = (userId: string) => {
  // Streak system removed
};

const ROLE_REWARDS = [
  { name: "Supernova", level: 25, color: "#ff8800" }, // Vibrant Orange
  { name: "Comet", level: 10, color: "#00aaff" },    // Deep Sky Blue
  { name: "Stardust", level: 2, color: "#ffffff" }    // Pure White
];

const syncUserRoles = async (guild: Guild, member: GuildMember, stats: UserStats) => {
  try {
    // Ensure roles exist
    for (const roleData of ROLE_REWARDS) {
      let role = guild.roles.cache.find(r => r.name === roleData.name);
      if (!role) {
        console.log(`[ROLES] Creating missing role: ${roleData.name}`);
        role = await guild.roles.create({
          name: roleData.name,
          color: roleData.color as ColorResolvable,
          reason: "Nova Level Reward System"
        });
      }
    }

    // Determine which role the user should have
    const eligibleRole = ROLE_REWARDS.find(r => stats.level >= r.level);
    
    // Remove other level roles and add the correct one
    const rolesToRemove = ROLE_REWARDS.filter(r => r.name !== eligibleRole?.name);
    
    for (const r of rolesToRemove) {
      const roleObj = guild.roles.cache.find(role => role.name === r.name);
      if (roleObj && member.roles.cache.has(roleObj.id)) {
        await member.roles.remove(roleObj);
      }
    }

    if (eligibleRole) {
      const roleObj = guild.roles.cache.find(role => role.name === eligibleRole.name);
      if (roleObj && !member.roles.cache.has(roleObj.id)) {
        await member.roles.add(roleObj);
        console.log(`[ROLES] Assigned ${eligibleRole.name} to ${member.user.tag}`);
      }
    }
  } catch (error) {
    console.error("[ROLES] Error syncing roles:", error);
  }
};

const getDisplayName = (userId: string, username: string) => {
  return username;
};

const createPomodoroEmbed = (totalSeconds: number, remaining: number, task: string, isFinished = false, isPaused = false, isBreak = false, userId?: string, participants: string[] = []) => {
  const stats = userId ? getUserStats(userId) : null;
  const themeKey = stats?.theme || "sakura";
  const theme = THEMES[themeKey] || THEMES.sakura;

  const elapsed = totalSeconds - remaining;
  const barLength = 15;
  const progress = Math.min(Math.floor((elapsed / totalSeconds) * barLength), barLength);
  
  // Create a more visual progress bar using theme emojis
  const progressBar = `${theme.barFull.repeat(progress)}${theme.barEmpty.repeat(barLength - progress)}`;
  
  const formatTime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  const timeLeftStr = isFinished ? "00:00:00" : formatTime(remaining);
  const timeElapsedStr = formatTime(elapsed);

  let statusEmoji = isBreak ? "☕ Taking a Break" : `${theme.emoji} Studying`;
  if (isFinished) statusEmoji = "✅ Completed";
  else if (isPaused) statusEmoji = "⏸️ Paused";

  const title = isBreak ? `⏱️ Nova Break Session` : `⏱️ Nova Focus Session`;
  const percentage = Math.floor((elapsed / totalSeconds) * 100);

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(theme.color)
    .setDescription(`**Progress: ${percentage}%**\n${progressBar}`)
    .addFields(
      { name: "Status", value: statusEmoji, inline: true },
      { name: "Time Left", value: `\`${timeLeftStr}\``, inline: true },
      { name: "Elapsed", value: `\`${timeElapsedStr}\``, inline: true },
      { name: "Task", value: isBreak ? "Relaxing" : task, inline: false }
    )
    .setTimestamp()
    .setFooter({ text: `Theme: ${theme.name} • Stay focused! ✨` });

  if (participants.length > 1) {
    embed.addFields({ name: "👥 Study Buddies", value: participants.map(id => `<@${id}>`).join(", "), inline: false });
  }

  if (stats?.groupId) {
    const group = studyGroups.get(stats.groupId);
    if (group) {
      const groupProgress = Math.min(Math.floor((group.totalSecondsFocused / group.goalSeconds) * 100), 100);
      embed.addFields({ name: `🏆 Group Goal: ${group.name}`, value: `Progress: **${groupProgress}%** toward ${Math.floor(group.goalSeconds / 3600)}h goal`, inline: false });
    }
  }

  return embed;
};

// Heartbeat to keep the process alive and monitor health
setInterval(() => {
  const sessionCount = activeSessions.size;
  console.log(`[HEARTBEAT] Nova is alive. Active Pomodoro sessions: ${sessionCount}. Uptime: ${Math.floor((Date.now() - startTime) / 1000)}s`);
}, 60000);

client.on("ready", async () => {
  console.log(`Logged in as ${client.user?.tag}!`);
  botStatus = "online";
  botServers = client.guilds.cache.size;
  startTime = Date.now();

  try {
    if (DISCORD_TOKEN && client.user) {
      const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
      
      console.log(`[SYNC] Cleaning up duplicates and syncing ${commands.length} commands...`);
      
      // 1. CLEAR Global Commands (This removes the duplicates)
      await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: [] }
      );
      console.log("[SYNC] Global commands cleared.");

      // 2. Register to ALL guilds the bot is currently in (Instant updates)
      const guildPromises = client.guilds.cache.map(guild => {
        return rest.put(
          Routes.applicationGuildCommands(client.user!.id, guild.id),
          { body: commands.map(c => c.toJSON()) }
        ).then(() => console.log(`[SYNC] Registered to guild: ${guild.name}`))
         .catch(e => console.error(`[SYNC] Failed to register to guild ${guild.name}:`, e));
      });
      
      // 3. Register to the specific GUILD_ID if it's not in the cache
      if (GUILD_ID && !client.guilds.cache.has(GUILD_ID)) {
        guildPromises.push(
          rest.put(
            Routes.applicationGuildCommands(client.user!.id, GUILD_ID),
            { body: commands.map(c => c.toJSON()) }
          ).then(() => console.log(`[SYNC] Registered to specific GUILD_ID: ${GUILD_ID}`))
           .catch(e => console.error(`[SYNC] Failed to register to specific GUILD_ID:`, e))
        );
      }

      await Promise.all(guildPromises);
      console.log("[SYNC] Successfully synced all guild commands!");
    }
  } catch (error) {
    console.error("Error registering commands:", error);
  }
});

const createControlRow = (userId: string, isPaused: boolean) => {
  const pauseResumeButton = new ButtonBuilder()
    .setCustomId(isPaused ? `resume_session_${userId}` : `pause_session_${userId}`)
    .setLabel(isPaused ? "▶️ Resume" : "⏸️ Pause")
    .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Secondary);

  const stopButton = new ButtonBuilder()
    .setCustomId(`stop_session_${userId}`)
    .setLabel("⏹️ Stop")
    .setStyle(ButtonStyle.Danger);

  const joinButton = new ButtonBuilder()
    .setCustomId(`join_session_${userId}`)
    .setLabel("🤝 Join")
    .setStyle(ButtonStyle.Primary);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(pauseResumeButton, stopButton, joinButton);
};

const startSession = async (interaction: any, userId: string, hours: number, minutes: number, seconds: number, task: string, isBreak: boolean) => {
  // Clear existing session
  if (activeSessions.has(userId)) {
    activeSessions.delete(userId);
  }

  let totalSeconds = (hours * 3600) + (minutes * 60) + seconds;
  if (totalSeconds <= 0) totalSeconds = (isBreak ? 5 : 25) * 60;

  const now = Date.now();
  const endTime = now + (totalSeconds * 1000);

  const initialEmbed = createPomodoroEmbed(totalSeconds, totalSeconds, task, false, false, isBreak, userId, [userId]);
  const controlRow = createControlRow(userId, false);

  const replyOptions = { 
    content: `🌸 **${getDisplayName(userId, interaction.user.username || interaction.user.tag)}** started a ${isBreak ? "break" : "focus"} session!`,
    embeds: [initialEmbed], 
    components: [controlRow],
    fetchReply: true 
  };

  let message;
  if (interaction.replied || interaction.deferred) {
    message = await interaction.followUp(replyOptions);
  } else {
    message = await interaction.reply(replyOptions);
    if (!message) message = await interaction.fetchReply();
  }

  const session: PomodoroSession = {
    userId,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    remainingSeconds: totalSeconds,
    totalSeconds,
    task,
    startTime: now,
    endTime,
    isPaused: false,
    isBreak,
    participants: [userId],
    groupId: getUserStats(userId).groupId,
    messageId: message.id
  };

  activeSessions.set(userId, session);
  console.log(`[TIMER] Bulletproof session started for ${userId} in ${interaction.channelId}`);
};

client.on("interactionCreate", async interaction => {
  if (interaction.isButton()) {
    if (interaction.customId.startsWith("join_session_")) {
      const hostId = interaction.customId.replace("join_session_", "");
      const session = activeSessions.get(hostId);
      if (session && !session.participants.includes(interaction.user.id)) {
        session.participants.push(interaction.user.id);
        await interaction.reply({ content: `🤝 <@${interaction.user.id}> joined the session! Nova will ping all participants when it's over.`, ephemeral: false });
      } else {
        await interaction.reply({ content: "You're already in this session or it has ended.", ephemeral: true });
      }
    } else if (interaction.customId.startsWith("start_break_")) {
      const userId = interaction.customId.replace("start_break_", "");
      if (interaction.user.id !== userId) return interaction.reply({ content: "Only the session host can start the break!", ephemeral: true });
      const stats = getUserStats(userId);
      await startSession(interaction, userId, 0, 0, stats.breakPreferenceSeconds, "Break", true);
    } else if (interaction.customId.startsWith("start_focus_")) {
      const userId = interaction.customId.replace("start_focus_", "");
      if (interaction.user.id !== userId) return interaction.reply({ content: "Only the session host can start the focus session!", ephemeral: true });
      const stats = getUserStats(userId);
      await startSession(interaction, userId, 0, 0, stats.studyPreferenceSeconds, "General Study", false);
    } else if (interaction.customId.startsWith("pause_session_")) {
      const userId = interaction.customId.replace("pause_session_", "");
      if (interaction.user.id !== userId) return interaction.reply({ content: "Only the host can pause the session!", ephemeral: true });
      const session = activeSessions.get(userId);
      if (session) {
        session.isPaused = true;
        await interaction.update({ 
          embeds: [createPomodoroEmbed(session.totalSeconds, session.remainingSeconds, session.task, false, true, session.isBreak, userId, session.participants)],
          components: [createControlRow(userId, true)]
        });
      }
    } else if (interaction.customId.startsWith("resume_session_")) {
      const userId = interaction.customId.replace("resume_session_", "");
      if (interaction.user.id !== userId) return interaction.reply({ content: "Only the host can resume the session!", ephemeral: true });
      const session = activeSessions.get(userId);
      if (session) {
        session.isPaused = false;
        session.endTime = Date.now() + (session.remainingSeconds * 1000);
        await interaction.update({ 
          embeds: [createPomodoroEmbed(session.totalSeconds, session.remainingSeconds, session.task, false, false, session.isBreak, userId, session.participants)],
          components: [createControlRow(userId, false)]
        });
      }
    } else if (interaction.customId.startsWith("stop_session_")) {
      const userId = interaction.customId.replace("stop_session_", "");
      if (interaction.user.id !== userId) return interaction.reply({ content: "Only the host can stop the session!", ephemeral: true });
      const session = activeSessions.get(userId);
      if (session) {
        activeSessions.delete(userId);
        await interaction.update({ 
          content: "⏹️ Session stopped manually.",
          embeds: [createPomodoroEmbed(session.totalSeconds, session.remainingSeconds, session.task, true, false, session.isBreak, userId, session.participants)],
          components: []
        });
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === "pomodoro") {
    const userId = interaction.user.id;
    const stats = getUserStats(userId);
    
    const studyStr = interaction.options.getString("study");
    const breakStr = interaction.options.getString("break");
    const task = interaction.options.getString("task") || "General Study";

    const studySeconds = parseDuration(studyStr, 25 * 60);
    const breakSeconds = parseDuration(breakStr, 5 * 60);

    // Save preferences
    stats.studyPreferenceSeconds = studySeconds;
    stats.breakPreferenceSeconds = breakSeconds;
    
    await startSession(interaction, userId, 0, 0, studySeconds, task, false);

  } else if (commandName === "break") {
    const userId = interaction.user.id;
    const hours = interaction.options.getInteger("hours") || 0;
    const minutes = interaction.options.getInteger("minutes") || 5;
    const seconds = interaction.options.getInteger("seconds") || 0;
    
    await startSession(interaction, userId, hours, minutes, seconds, "Break", true);

  } else if (commandName === "note") {
    const text = interaction.options.getString("text")!;
    const stats = getUserStats(interaction.user.id);
    stats.notes.push(`${new Date().toLocaleTimeString()}: ${text}`);
    await interaction.reply({ content: "📝 Note saved to your study journal!", ephemeral: true });

  } else if (commandName === "journal") {
    const stats = getUserStats(interaction.user.id);
    if (stats.notes.length === 0) return interaction.reply("Your journal is empty.");
    const embed = new EmbedBuilder()
      .setTitle("📓 Your Study Journal")
      .setDescription(stats.notes.join("\n"))
      .setColor("#fe9494");
    await interaction.reply({ embeds: [embed], ephemeral: true });

  } else if (commandName === "pause") {
    const userId = interaction.user.id;
    const session = activeSessions.get(userId);

    if (!session) {
      return interaction.reply({ content: "You don't have an active focus session to pause!", ephemeral: true });
    }

    session.isPaused = !session.isPaused;
    
    if (session.isPaused) {
      // Store how much time was left when paused
      session.remainingSeconds = Math.max(0, Math.floor((session.endTime - Date.now()) / 1000));
      await interaction.reply({ content: "⏸️ Timer paused.", ephemeral: true });
    } else {
      // Recalculate endTime based on remaining time
      session.endTime = Date.now() + (session.remainingSeconds * 1000);
      await interaction.reply({ content: "▶️ Timer resumed.", ephemeral: true });
    }

    try {
      const channel = await client.channels.fetch(session.channelId);
      if (channel?.isTextBased() && session.messageId) {
        const message = await channel.messages.fetch(session.messageId);
        if (message) {
          await message.edit({ embeds: [createPomodoroEmbed(session.totalSeconds, session.remainingSeconds, session.task, false, session.isPaused, session.isBreak, userId, session.participants)] });
        }
      }
    } catch (e) {}

  } else if (commandName === "stop") {
    const userId = interaction.user.id;
    const session = activeSessions.get(userId);

    if (!session) {
      return interaction.reply({ content: "You don't have an active focus session to stop!", ephemeral: true });
    }

    activeSessions.delete(userId);

    const stopEmbed = new EmbedBuilder()
      .setTitle("⏱️ Nova Focus Session")
      .setColor("#fe9494")
      .setDescription("Session stopped.")
      .addFields(
        { name: "Status", value: "🛑 Stopped", inline: true },
        { name: "Time Left", value: "Cancelled", inline: true },
        { name: "Task", value: session.task, inline: true }
      )
      .setTimestamp();

    try {
      const channel = await client.channels.fetch(session.channelId);
      if (channel?.isTextBased() && session.messageId) {
        const message = await channel.messages.fetch(session.messageId);
        if (message) await message.edit({ embeds: [stopEmbed], components: [] });
      }
    } catch (e) {}

    await interaction.reply({ content: "🛑 Focus session stopped.", ephemeral: true });

  } else if (commandName === "todo") {
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    
    if (!userTodos.has(userId)) {
      userTodos.set(userId, []);
    }
    const todos = userTodos.get(userId)!;

    if (subcommand === "add") {
      const task = interaction.options.getString("task")!;
      todos.push(task);
      await interaction.reply(`✅ Added task: **${task}**`);
    } else if (subcommand === "list") {
      if (todos.length === 0) {
        await interaction.reply("📝 Your todo list is empty. Great job!");
      } else {
        const list = todos.map((t, i) => `${i + 1}. ${t}`).join("\n");
        const embed = new EmbedBuilder()
          .setTitle("📝 Your Todo List")
          .setDescription(list)
          .setColor("#fe9494");
        await interaction.reply({ embeds: [embed] });
      }
    } else if (subcommand === "complete") {
      const index = interaction.options.getInteger("index")! - 1;
      if (index >= 0 && index < todos.length) {
        const removed = todos.splice(index, 1)[0];
        await interaction.reply(`🎉 Completed task: **${removed}**`);
      } else {
        await interaction.reply("❌ Invalid task number.");
      }
    } else if (subcommand === "remove") {
      const index = interaction.options.getInteger("index")! - 1;
      if (index >= 0 && index < todos.length) {
        const removed = todos.splice(index, 1)[0];
        await interaction.reply(`🗑️ Removed task: **${removed}**`);
      } else {
        await interaction.reply("❌ Invalid task number.");
      }
    }
  } else if (commandName === "study") {
    const quotes = [
      "The secret of getting ahead is getting started. - Mark Twain",
      "It always seems impossible until it's done. - Nelson Mandela",
      "Don't watch the clock; do what it does. Keep going. - Sam Levenson",
      "Success is the sum of small efforts, repeated day in and day out. - Robert Collier"
    ];
    const quote = quotes[Math.floor(Math.random() * quotes.length)];
    const embed = new EmbedBuilder()
      .setTitle("📚 Study Motivation")
      .setDescription(`*${quote}*`)
      .setColor("#fe9494");
    await interaction.reply({ embeds: [embed] });
  } else if (commandName === "rank") {
    const stats = getUserStats(interaction.user.id);
    const theme = THEMES[stats.theme] || THEMES.sakura;
    const progress = Math.floor((stats.xp % 100) / 10);
    const progressBar = `${theme.barFull.repeat(progress)}${theme.barEmpty.repeat(10 - progress)}`;

    const currentRole = ROLE_REWARDS.find(r => stats.level >= r.level)?.name || "None";

    const embed = new EmbedBuilder()
      .setTitle(`${theme.emoji} ${getDisplayName(interaction.user.id, interaction.user.username)}'s Stats`)
      .setColor(theme.color)
      .setThumbnail(interaction.user.displayAvatarURL())
      .addFields(
        { name: "Level", value: `${stats.level}`, inline: true },
        { name: "Total XP", value: `${stats.xp} XP`, inline: true },
        { name: "Level Role", value: `✨ ${currentRole}`, inline: true },
        { name: "Focus Time", value: `${Math.floor(stats.totalFocusTime / 3600)}h ${Math.floor((stats.totalFocusTime % 3600) / 60)}m`, inline: true },
        { name: "Progress", value: `${progressBar} **${stats.xp % 100}/100 XP**` }
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } else if (commandName === "test-summary") {
    const stats = getUserStats(interaction.user.id);
    const hours = Math.floor(stats.totalFocusTime / 3600);
    const embed = new EmbedBuilder()
      .setTitle("🎀 Your Monthly Study Journey (Test)")
      .setDescription(`This month, you were focused for **${hours} hours**! You are a superstar. 🌸`)
      .setColor("#fe9494")
      .setFooter({ text: "This is a test of the monthly summary feature." })
      .setTimestamp();
    
    try {
      await interaction.user.send({ embeds: [embed] });
      await interaction.reply({ content: "✅ I've sent the test summary to your DMs!", ephemeral: true });
    } catch (e) {
      await interaction.reply({ content: "❌ I couldn't send you a DM. Please check your privacy settings!", ephemeral: true });
    }

  } else if (commandName === "test-pomodoro") {
    const userId = interaction.user.id;
    await startSession(interaction, userId, 0, 0, 10, "Test Session", false);

  } else if (commandName === "test-xp") {
    const userId = interaction.user.id;
    const level = interaction.options.getInteger("level")!;
    const stats = getUserStats(userId);
    
    stats.level = level;
    stats.xp = (level - 1) * 100;
    
    const member = interaction.member as GuildMember;
    if (member && member.guild) {
      await syncUserRoles(member.guild, member, stats);
    }
    
    await interaction.reply({ content: `✨ Your level has been set to **${level}** and roles have been synced!`, ephemeral: true });

  } else if (commandName === "leaderboard") {
    const sortedStats = Array.from(userStats.entries())
      .sort((a, b) => b[1].xp - a[1].xp)
      .slice(0, 10);

    if (sortedStats.length === 0) {
      return interaction.reply("🏆 The leaderboard is currently empty. Start studying to be the first!");
    }

    let description = "";
    for (let i = 0; i < sortedStats.length; i++) {
      const [uId, stats] = sortedStats[i];
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "✨";
      description += `${medal} <@${uId}> - **Level ${stats.level}** (${stats.xp} XP)\n`;
    }

    const embed = new EmbedBuilder()
      .setTitle("🏆 Top Focusers Leaderboard")
      .setColor("#fe9494")
      .setDescription(description)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } else if (commandName === "status") {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = uptime % 60;

    const embed = new EmbedBuilder()
      .setTitle("💓 Nova's Heartbeat")
      .setColor("#fe9494")
      .addFields(
        { name: "Status", value: "✨ Healthy & Focused", inline: true },
        { name: "Uptime", value: `${h}h ${m}m ${s}s`, inline: true },
        { name: "Servers", value: `${client.guilds.cache.size}`, inline: true },
        { name: "Memory Usage", value: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`, inline: true }
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } else if (commandName === "theme") {
    const choice = interaction.options.getString("choice")!;
    const stats = getUserStats(interaction.user.id);
    stats.theme = choice;
    const theme = THEMES[choice];

    const embed = new EmbedBuilder()
      .setTitle("✨ Aesthetic Theme Updated")
      .setColor(theme.color)
      .setDescription(`Your theme has been set to **${theme.name}** ${theme.emoji}!\n\nYour next focus session will use this aesthetic.`)
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } else if (commandName === "group") {
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const stats = getUserStats(userId);

    if (subcommand === "create") {
      const name = interaction.options.getString("name")!;
      const goalHours = interaction.options.getInteger("goal")!;
      
      if (stats.groupId) {
        return interaction.reply({ content: "❌ You are already in a study group! Leave your current group first.", ephemeral: true });
      }

      const groupId = Math.random().toString(36).substring(2, 9).toUpperCase();
      const newGroup: StudyGroup = {
        id: groupId,
        name,
        ownerId: userId,
        members: [userId],
        goalSeconds: goalHours * 3600,
        totalSecondsFocused: 0,
        createdAt: Date.now()
      };

      studyGroups.set(groupId, newGroup);
      stats.groupId = groupId;

      const embed = new EmbedBuilder()
        .setTitle("🤝 New Study Group Created!")
        .setColor("#fe9494")
        .setDescription(`Group **${name}** has been formed!\n\n**Group ID:** \`${groupId}\`\n**Goal:** ${goalHours} hours\n\nShare the ID with your friends so they can join!`)
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });

    } else if (subcommand === "join") {
      const groupId = interaction.options.getString("id")!.toUpperCase();
      const group = studyGroups.get(groupId);

      if (!group) {
        return interaction.reply({ content: "❌ Study group not found. Check the ID and try again.", ephemeral: true });
      }

      if (stats.groupId) {
        return interaction.reply({ content: "❌ You are already in a study group! Leave your current group first.", ephemeral: true });
      }

      group.members.push(userId);
      stats.groupId = groupId;

      await interaction.reply({ content: `✅ You've joined the study group: **${group.name}**!`, ephemeral: true });

    } else if (subcommand === "invite") {
      if (!stats.groupId) {
        return interaction.reply({ content: "❌ You aren't in a study group! Create one first.", ephemeral: true });
      }
      const group = studyGroups.get(stats.groupId)!;
      const targetUser = interaction.options.getUser("user")!;

      const embed = new EmbedBuilder()
        .setTitle("💌 Study Group Invitation")
        .setColor("#fe9494")
        .setDescription(`<@${userId}> has invited you to join their study group: **${group.name}**!\n\n**Group ID:** \`${group.id}\`\n\nUse \`/group join id:${group.id}\` to join!`)
        .setTimestamp();

      await interaction.reply({ content: `Invitation sent to <@${targetUser.id}>!`, ephemeral: true });
      try {
        await targetUser.send({ embeds: [embed] });
      } catch (e) {
        await interaction.followUp({ content: "⚠️ I couldn't send a DM to that user, but I've posted the invite here.", ephemeral: true });
      }

    } else if (subcommand === "stats") {
      if (!stats.groupId) {
        return interaction.reply({ content: "❌ You aren't in a study group.", ephemeral: true });
      }
      const group = studyGroups.get(stats.groupId)!;
      const progress = Math.min(Math.floor((group.totalSecondsFocused / group.goalSeconds) * 100), 100);
      
      const barLength = 15;
      const filled = Math.floor((progress / 100) * barLength);
      const progressBar = "▉".repeat(filled) + "▒".repeat(barLength - filled);

      const embed = new EmbedBuilder()
        .setTitle(`📊 Group Stats: ${group.name}`)
        .setColor("#fe9494")
        .setDescription(`**Group ID:** \`${group.id}\`\n**Goal Progress: ${progress}%**\n\`${progressBar}\``)
        .addFields(
          { name: "Goal", value: `${Math.floor(group.goalSeconds / 3600)}h`, inline: true },
          { name: "Focused", value: `${Math.floor(group.totalSecondsFocused / 3600)}h ${Math.floor((group.totalSecondsFocused % 3600) / 60)}m`, inline: true },
          { name: "Members", value: group.members.map(id => `<@${id}>`).join(", ") || "None" }
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });

    } else if (subcommand === "leave") {
      if (!stats.groupId) {
        return interaction.reply({ content: "❌ You aren't in a study group.", ephemeral: true });
      }
      const group = studyGroups.get(stats.groupId)!;
      group.members = group.members.filter(id => id !== userId);
      stats.groupId = null;

      if (group.members.length === 0) {
        studyGroups.delete(group.id);
        await interaction.reply({ content: `👋 You left and the group **${group.name}** has been disbanded as it was empty.`, ephemeral: true });
      } else {
        await interaction.reply({ content: `👋 You left the study group: **${group.name}**.`, ephemeral: true });
      }
    }
  }
});

async function startServer() {
  console.log("[SERVER] Starting Express server...");
  const app = express();
  const PORT = 3000;

  // API routes FIRST
  app.get("/api/bot-status", (req, res) => {
    res.json({
      status: botStatus,
      servers: client.guilds.cache?.size || 0,
      uptime: botStatus === "online" ? Math.floor((Date.now() - startTime) / 1000) : 0,
      hasToken: !!DISCORD_TOKEN,
      hasGuildId: !!GUILD_ID,
      error: lastError
    });
  });

  // Start listening immediately so the API is available
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[SERVER] Express server running on http://0.0.0.0:${PORT}`);
    
    // Now attempt Discord login
    if (DISCORD_TOKEN) {
      console.log("[DISCORD] Attempting to login...");
      client.login(DISCORD_TOKEN).catch(err => {
        console.error("[DISCORD] Failed to login:", err);
        botStatus = "error";
        lastError = err.message || String(err);
      });
    } else {
      console.log("[DISCORD] No DISCORD_TOKEN provided. Bot will not start.");
      botStatus = "missing_token";
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    try {
      console.log("[VITE] Initializing Vite in middleware mode...");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
      console.log("[VITE] Vite middleware initialized.");
    } catch (viteError) {
      console.error("[VITE] Failed to initialize Vite:", viteError);
    }
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Monthly Aesthetic Summary (Runs on the 1st of every month)
  setInterval(async () => {
    const now = new Date();
    if (now.getDate() === 1 && now.getHours() === 9 && now.getMinutes() === 0) {
      console.log("[CRON] Running monthly aesthetic summary...");
      for (const [userId, stats] of userStats.entries()) {
        try {
          const user = await client.users.fetch(userId);
          const hours = Math.floor(stats.totalFocusTime / 3600);
          const embed = new EmbedBuilder()
            .setTitle("🎀 Your Monthly Study Journey")
            .setDescription(`This month, you were focused for **${hours} hours**! You are a superstar. 🌸`)
            .setColor("#fe9494")
            .setTimestamp();
          await user.send({ embeds: [embed] });
        } catch (e) { console.error(`[CRON] Failed to send monthly DM to ${userId}:`, e); }
      }
    }
  }, 60000);
}

startServer();
