import fs from "fs";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import axios from "axios";
import { Readable } from "stream";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  GuildMember,
  Guild,
  ColorResolvable,
  PermissionFlagsBits
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState,
  getVoiceConnection
} from "@discordjs/voice";
import ffmpeg from "ffmpeg-static";
import dotenv from "dotenv";

if (ffmpeg) {
  process.env.FFMPEG_PATH = ffmpeg;
}

dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const BEEP_URL = "https://actions.google.com/sounds/v1/alarms/bugle_tune.ogg";

// Bot State
let botStatus = "offline";
let cachedBeepBuffer: Buffer | null = null;
let botServers = 0;
let botUptime = 0;
let startTime = Date.now();
let lastError = "";

import prism from "prism-media";

/**
 * Nova's Bulletproof V1 Engine (Safety Build)
 * Uses the working V1 logic but adds a mandatory "Hard-Kill" 
 * safety timer to ensure the bot ALWAYS leaves the channel.
 */
class SoundBoardEngine {
  private players = new Map<string, any>();

  async playSound(guild: Guild, channelId: string) {
    console.log(`[V1-SAFETY] Triggered for ${guild.id}`);
    
    // 1. Force Clean Slate
    let connection = getVoiceConnection(guild.id);
    if (connection) {
      console.log("[V1-SAFETY] Force-cleaning existing session...");
      connection.destroy();
      this.players.delete(guild.id);
    }

    connection = joinVoiceChannel({
      channelId: channelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    // 2. The Hard-Kill Safety Timer (30 seconds)
    const safetyTimer = setTimeout(() => {
      console.log(`[V1-SAFETY] Safety trigger: Session for ${guild.id} exceeded 30s limit. Force leaving.`);
      const activeConn = getVoiceConnection(guild.id);
      if (activeConn) activeConn.destroy();
      this.players.get(guild.id)?.stop();
      this.players.delete(guild.id);
    }, 30000);

    const cleanup = () => {
      clearTimeout(safetyTimer);
      const activeConn = getVoiceConnection(guild.id);
      if (activeConn) {
        console.log("[V1-SAFETY] Standard cleanup: Leaving channel.");
        activeConn.destroy();
      }
      this.players.delete(guild.id);
    };

    try {
      console.log("[V1-SAFETY] Waiting for connection ready...");
      await entersState(connection, VoiceConnectionStatus.Ready, 10000);
      
      // Warmup delay (Discord voice stability ✨)
      await new Promise(r => setTimeout(r, 1500));
      
      const player = createAudioPlayer();
      connection.subscribe(player);
      this.players.set(guild.id, player);

      console.log("[V1-SAFETY] Opening bugle audio stream (Fresh Download)...");
      const response = await axios.get(BEEP_URL, { 
        responseType: 'stream',
        timeout: 10000 
      });

      const resource = createAudioResource(response.data, { 
        inputType: StreamType.Arbitrary,
        inlineVolume: true 
      });
      
      if (resource.volume) {
        resource.volume.setVolume(1.0);
      }
      
      console.log("[V1-SAFETY] Playing bugle notification...");
      player.play(resource);

      player.on('stateChange', (oldState, newState) => {
        console.log(`[V1-SAFETY] Player state changed from ${oldState.status} to ${newState.status}`);
      });

      // Standard Finish
      player.once(AudioPlayerStatus.Idle, () => {
        console.log("[V1-SAFETY] Audio finished. Cleanup in 3s.");
        setTimeout(cleanup, 3000);
      });

      // Error Finish
      player.on('error', (err: any) => {
        console.error("[V1-SAFETY] Player Level Error:", err.message);
        cleanup();
      });

      connection.on(VoiceConnectionStatus.Disconnected, () => {
        console.log("[V1-SAFETY] Gateway disconnected. Wiping state.");
        this.players.delete(guild.id);
        clearTimeout(safetyTimer);
      });

    } catch (err) {
      console.error("[V1-SAFETY] Setup failed:", err);
      cleanup();
    }
  }
}

const NovaSoundBoard = new SoundBoardEngine();

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
    // GatewayIntentBits.GuildMembers, // Requires manual enablement in Discord Developer Portal
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
    .setDescription("Check your current study level and XP")
    .addUserOption(option => 
      option.setName("user")
        .setDescription("View another student's focus stats")
        .setRequired(false)
    ),
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
    )
    .addSubcommand(subcommand =>
      subcommand.setName("leaderboard")
        .setDescription("View the top focus study groups")
    ),
  new SlashCommandBuilder()
    .setName("admin-set-stats")
    .setDescription("ADMIN: Set stats for a student")
    .addUserOption(option => option.setName("user").setDescription("The student").setRequired(true))
    .addIntegerOption(option => option.setName("xp").setDescription("Exact XP amount").setRequired(false))
    .addIntegerOption(option => option.setName("hours").setDescription("Exact total focus hours").setRequired(false)),
  new SlashCommandBuilder()
    .setName("test-summary")
    .setDescription("Test the monthly aesthetic summary DM"),
  new SlashCommandBuilder()
    .setName("test-pomodoro")
    .setDescription("Start a 10-second focus session to test linking"),
  new SlashCommandBuilder()
    .setName("test-voice")
    .setDescription("Test the focus completion sound in your voice channel"),
  new SlashCommandBuilder()
    .setName("check-nova")
    .setDescription("Check Nova's permissions and audio health"),
  new SlashCommandBuilder()
    .setName("test-xp")
    .setDescription("Set your XP to a specific level for testing")
    .addIntegerOption(option => 
      option.setName("level")
        .setDescription("The level to set (e.g. 2, 10, 25)")
        .setRequired(true)
    ),
];

// Study Groups interface
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

    // Optimization: Update the embed every 5 seconds to avoid Discord rate limits.
    // However, if it's finished, update immediately.
    const shouldUpdate = remaining === 0 || remaining % 5 === 0;

    if (shouldUpdate) {
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
              session.participants,
              session.endTime
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
  const { userId, isBreak, totalSeconds, participants, groupId, channelId, guildId, messageId } = session;
  
  // Try to mark the original timer message as Finished 🏁
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.isTextBased() && messageId) {
      const message = await (channel as any).messages.fetch(messageId);
      if (message) {
        const finishedEmbed = createPomodoroEmbed(totalSeconds, 0, session.task, true, false, isBreak, userId, participants, session.endTime);
        await message.edit({ 
          content: `✅ **${isBreak ? "Break" : "Focus"} Completed!** ✨`,
          embeds: [finishedEmbed], 
          components: [] 
        });
      }
    }
  } catch (e) {
    console.warn(`[TIMER] Could not update closing embed for ${userId}`);
  }

  if (!isBreak) {
    // Award XP to ALL participants
    for (const pId of participants) {
      const stats = getUserStats(pId);
      stats.xp += 10;
      stats.totalFocusTime += totalSeconds;
      stats.level = Math.floor(stats.xp / 100) + 1;
      saveUserStats(pId, stats);

      // Sync Roles for each participant
      if (guildId) {
        try {
          const guild = await client.guilds.fetch(guildId);
          const member = await guild.members.fetch(pId);
          if (member) await syncUserRoles(guild, member, stats);
        } catch (e) { /* ignore individual role sync errors */ }
      }
    }

    // Group Stats
    if (groupId) {
      const group = studyGroups.get(groupId);
      if (group) {
        group.totalSecondsFocused += totalSeconds;
        saveStudyGroup(groupId, group);
      }
    }
  }

  // Send Completion Message & Pings
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.isTextBased()) {
      const pingString = participants.map(id => `<@${id}>`).join(" ");
      const hostStats = getUserStats(userId);
      const tip = ["Stretching", "Drinking Water", "Looking Away", "Deep Breaths"][Math.floor(Math.random() * 4)];
      
      const endEmbed = createSessionEndEmbed(isBreak, tip, hostStats);
      const actionRow = new ActionRowBuilder<ButtonBuilder>();
      
      const nextButton = new ButtonBuilder()
        .setCustomId(isBreak ? `start_focus_${userId}` : `start_break_${userId}`)
        .setLabel(isBreak ? `Start Focus` : `Start Break`)
        .setStyle(ButtonStyle.Success);
      
      actionRow.addComponents(nextButton);

      // Skip Break Option ✨
      if (!isBreak) {
        const skipButton = new ButtonBuilder()
          .setCustomId(`skip_break_${userId}`)
          .setLabel(`Skip Break ⏭️`)
          .setStyle(ButtonStyle.Secondary);
        actionRow.addComponents(skipButton);
      }

      const msg = await (channel as any).send({
        content: `🔔 **${isBreak ? "Break" : "Focus"} Finished!** ${pingString}`,
        embeds: [endEmbed],
        components: [actionRow],
        allowedMentions: { users: participants }
      });

      // Voice Notification (Soundboard Engine)
      if (guildId) {
        try {
          const guild = await client.guilds.fetch(guildId);
          const member = await guild.members.fetch(userId);
          const channel = member?.voice.channel;
          
          if (channel) {
            await NovaSoundBoard.playSound(guild, channel.id);
          }
        } catch (e) {
          console.error("[VOICE] Soundboard trigger failed:", e);
        }
      }
    }
  } catch (e) { console.error("[COMPLETION] CRITICAL:", e); }
}

interface UserStats {
  xp: number;
  level: number;
  streak: number;
  lastStudyDate: string | null;
  totalFocusTime: number; // in seconds
  notes: string[];
  todos: string[];
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
const STUDY_GROUP_DATA_DIR = path.join(process.cwd(), "user_data", "groups");
const USER_DATA_DIR = path.join(process.cwd(), "user_data", "users");

// Ensure data folders exist
[USER_DATA_DIR, STUDY_GROUP_DATA_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const saveUserStats = (userId: string, stats: UserStats) => {
  try {
    userStats.set(userId, stats); // Update memory cache ✨
    const filePath = path.join(USER_DATA_DIR, `${userId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(stats, null, 2));
  } catch (e) {
    console.error(`[STORAGE] Error saving stats for ${userId}:`, e);
  }
};

const saveStudyGroup = (groupId: string, group: StudyGroup) => {
  try {
    const filePath = path.join(STUDY_GROUP_DATA_DIR, `${groupId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(group, null, 2));
  } catch (e) {
    console.error(`[STORAGE] Error saving group ${groupId}:`, e);
  }
};

// Load existing study groups on startup
try {
  if (fs.existsSync(STUDY_GROUP_DATA_DIR)) {
    const files = fs.readdirSync(STUDY_GROUP_DATA_DIR);
    files.forEach(file => {
      if (file.endsWith(".json")) {
        try {
          const data = fs.readFileSync(path.join(STUDY_GROUP_DATA_DIR, file), "utf-8");
          if (data.trim()) {
            const group: StudyGroup = JSON.parse(data);
            studyGroups.set(group.id, group);
          }
        } catch (innerError) {
          console.error(`[STORAGE] Failed to load group file ${file}:`, innerError);
        }
      }
    });
    console.log(`[STORAGE] Loaded ${studyGroups.size} study groups.`);
  }
} catch (e) {
  console.error("[STORAGE] Global error loading study groups:", e);
}

const getUserStats = (userId: string): UserStats => {
  const filePath = path.join(USER_DATA_DIR, `${userId}.json`);
  
  // If we have it in memory, return it
  if (userStats.has(userId)) return userStats.get(userId)!;

  // Otherwise, fallback to disk
  let stats: UserStats;

  if (fs.existsSync(filePath)) {
    try {
      const data = fs.readFileSync(filePath, "utf-8");
      stats = JSON.parse(data);
      // Ensure all fields exist (migration/defaults)
      stats = {
        xp: stats.xp ?? 0,
        level: stats.level ?? 1,
        streak: stats.streak ?? 0,
        lastStudyDate: stats.lastStudyDate ?? null,
        totalFocusTime: stats.totalFocusTime ?? 0,
        notes: stats.notes ?? [],
        todos: stats.todos ?? [],
        studyPreferenceSeconds: stats.studyPreferenceSeconds ?? 25 * 60,
        breakPreferenceSeconds: stats.breakPreferenceSeconds ?? 5 * 60,
        theme: stats.theme ?? "sakura",
        groupId: stats.groupId ?? null
      };
      userStats.set(userId, stats);
      return stats;
    } catch (e) {
      console.error(`[STORAGE] Error loading stats for ${userId}:`, e);
    }
  }

  // Default if file doesn't exist or error loading
  stats = {
    xp: 0,
    level: 1,
    streak: 0,
    lastStudyDate: null,
    totalFocusTime: 0,
    notes: [],
    todos: [],
    studyPreferenceSeconds: 25 * 60,
    breakPreferenceSeconds: 5 * 60,
    theme: "sakura",
    groupId: null
  };
  
  userStats.set(userId, stats);
  saveUserStats(userId, stats); // Write the JSON code to the file immediately! 🪄
  return stats;
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

const createPomodoroEmbed = (totalSeconds: number, remaining: number, task: string, isFinished = false, isPaused = false, isBreak = false, userId?: string, participants: string[] = [], endTime?: number) => {
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

  // If remaining is 0 or less, it is finished.
  const finished = isFinished || remaining <= 0;
  
  const timeLeftStr = finished ? "00:00:00" : formatTime(remaining);
  
  let statusEmoji = isBreak ? "☕ Taking a Break" : `${theme.emoji} Studying`;
  if (finished) statusEmoji = "✅ Completed";
  else if (isPaused) statusEmoji = "⏸️ Paused";

  const title = isBreak ? `⏱️ Nova Break Session` : `⏱️ Nova Focus Session`;
  const percentage = Math.floor((elapsed / totalSeconds) * 100);

  // Using Discord native timestamps for bulletproof accuracy
  const discordTimestamp = endTime && !isPaused && !finished
    ? `<t:${Math.floor(endTime / 1000)}:R>` 
    : isPaused ? "`⏸️ Paused`" : "`🏁 Finished`";

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(theme.color)
    .setDescription(`**Progress: ${percentage}%**\n${progressBar}`)
    .addFields(
      { name: "Status", value: statusEmoji, inline: true },
      { name: "Time Remaining", value: discordTimestamp, inline: true },
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
      
      console.log(`[SYNC] Syncing ${commands.length} commands globally...`);
      const isSnowflake = (id: string) => /^\d{17,19}$/.test(id);
      
      // 1. Register Global Commands
      await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: commands.map(c => c.toJSON()) }
      );
      console.log("[SYNC] Global commands registered.");

      // 2. Clear all Guild-specific commands to prevent duplicates
      const guilds = await client.guilds.fetch();
      console.log(`[SYNC] Clearing guild commands for ${guilds.size} servers to prevent duplicates...`);
      
      const clearPromises = guilds.map(g => {
        return rest.put(
          Routes.applicationGuildCommands(client.user!.id, g.id),
          { body: [] }
        ).catch(e => console.warn(`[SYNC] Could not clear commands in guild ${g.id}: ${e.message}`));
      });
      
      await Promise.all(clearPromises);
      console.log("[SYNC] All guild commands cleared. (Global commands may take up to 1 hour to appear everywhere)");

      // 3. (Optional) Re-sync to specific developer guild for instant updates
      if (GUILD_ID && isSnowflake(GUILD_ID)) {
        console.log(`[SYNC] Applying instant sync to dev GUILD_ID: ${GUILD_ID}`);
        await rest.put(
          Routes.applicationGuildCommands(client.user!.id, GUILD_ID),
          { body: commands.map(c => c.toJSON()) }
        ).catch(e => console.error(`[SYNC] Failed instant sync to ${GUILD_ID}`));
      }
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

  const initialEmbed = createPomodoroEmbed(totalSeconds, totalSeconds, task, false, false, isBreak, userId, [userId], endTime);
  const controlRow = createControlRow(userId, false);

  const replyOptions: any = { 
    content: `🌸 <@${userId}> started a ${isBreak ? "break" : "focus"} session!`,
    embeds: [initialEmbed], 
    components: [controlRow],
    allowedMentions: { users: [userId] }
  };

  let message;
  if (interaction.replied || interaction.deferred) {
    message = await interaction.editReply(replyOptions);
  } else {
    message = await interaction.reply({ ...replyOptions, fetchReply: true });
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
  try {
    if (interaction.isButton()) {
      const customId = interaction.customId;

      if (customId.startsWith("join_session_")) {
        const hostId = customId.replace("join_session_", "");
        const session = activeSessions.get(hostId);
        if (session && !session.participants.includes(interaction.user.id)) {
          session.participants.push(interaction.user.id);
          await interaction.reply({ content: `🤝 <@${interaction.user.id}> joined the session! Nova will ping all participants when it's over.`, ephemeral: false });
        } else {
          await interaction.reply({ content: "You're already in this session or it has ended.", ephemeral: true });
        }
      } else if (customId.startsWith("start_break_")) {
        const userId = customId.replace("start_break_", "");
        if (interaction.user.id !== userId) return interaction.reply({ content: "Only the session host can start the break!", ephemeral: true });
        
        await interaction.deferReply(); // Acknowledge early ✨
        const stats = getUserStats(userId);
        await startSession(interaction, userId, 0, 0, stats.breakPreferenceSeconds, "Break", true);
      } else if (customId.startsWith("start_focus_") || customId.startsWith("skip_break_")) {
        const isSkip = customId.startsWith("skip_break_");
        const prefix = isSkip ? "skip_break_" : "start_focus_";
        const userId = customId.replace(prefix, "");
        if (interaction.user.id !== userId) return interaction.reply({ content: `Only the session host can ${isSkip ? "skip the break" : "start the focus session"}!`, ephemeral: true });
        
        await interaction.deferReply(); // Acknowledge early ✨
        const stats = getUserStats(userId);
        await startSession(interaction, userId, 0, 0, stats.studyPreferenceSeconds, "General Study", false);
      } else if (customId.startsWith("pause_session_")) {
        const userId = customId.replace("pause_session_", "");
        if (interaction.user.id !== userId) return interaction.reply({ content: "Only the host can pause the session!", ephemeral: true });
        const session = activeSessions.get(userId);
        if (session) {
          session.isPaused = true;
          await interaction.update({ 
            embeds: [createPomodoroEmbed(session.totalSeconds, session.remainingSeconds, session.task, false, true, session.isBreak, userId, session.participants, session.endTime)],
            components: [createControlRow(userId, true)]
          });
        } else {
          await interaction.reply({ content: "⚠️ Session no longer active or bot has restarted.", ephemeral: true });
        }
      } else if (customId.startsWith("resume_session_")) {
        const userId = customId.replace("resume_session_", "");
        if (interaction.user.id !== userId) return interaction.reply({ content: "Only the host can resume the session!", ephemeral: true });
        const session = activeSessions.get(userId);
        if (session) {
          session.isPaused = false;
          session.endTime = Date.now() + (session.remainingSeconds * 1000);
          await interaction.update({ 
            embeds: [createPomodoroEmbed(session.totalSeconds, session.remainingSeconds, session.task, false, false, session.isBreak, userId, session.participants, session.endTime)],
            components: [createControlRow(userId, false)]
          });
        } else {
          await interaction.reply({ content: "⚠️ Session no longer active or bot has restarted.", ephemeral: true });
        }
      } else if (customId.startsWith("stop_session_")) {
        const userId = customId.replace("stop_session_", "");
        if (interaction.user.id !== userId) return interaction.reply({ content: "Only the host can stop the session!", ephemeral: true });
        const session = activeSessions.get(userId);
        if (session) {
          activeSessions.delete(userId);
          await interaction.update({ 
            content: "⏹️ Session stopped manually.",
            embeds: [createPomodoroEmbed(session.totalSeconds, session.remainingSeconds, session.task, true, false, session.isBreak, userId, session.participants, session.endTime)],
            components: []
          });
        } else {
          // Fallback: If session not found, update the embed safely
          const currentEmbeds = interaction.message.embeds.map(e => EmbedBuilder.from(e));
          if (currentEmbeds.length > 0) {
            const embed = currentEmbeds[0];
            // Remove the relative timestamp field and add a static one
            embed.setFields(
              embed.data.fields?.map(f => {
                if (f.name === "Time Remaining") {
                  return { name: "Time Remaining", value: "`🏁 Finished` (State Lost)", inline: true };
                }
                if (f.name === "Status") {
                  return { name: "Status", value: "✅ Completed", inline: true };
                }
                return f;
              }) || []
            );
          }

          await interaction.update({ 
            content: "⏹️ Session was closed or bot state lost.", 
            embeds: currentEmbeds,
            components: [] 
          });
        }
      }
    } else if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;
      console.log(`[COMMAND] ${commandName} triggered by ${interaction.user.tag}`);

  // Defer by default for all commands that might take a moment
  // Fast commands can just reply directly, but deferring is safer for "No Response" issues.
  const ephemeralCommands = ["journal", "theme", "check-nova", "note", "todo"];
  const isEphemeral = ephemeralCommands.includes(commandName);

  if (commandName === "pomodoro") {
    await interaction.deferReply();
    const userId = interaction.user.id;
    const stats = getUserStats(userId);
      
      const studyStr = interaction.options.getString("study");
      const breakStr = interaction.options.getString("break");
      const task = interaction.options.getString("task") || "General Study";

      const studySeconds = parseDuration(studyStr, 25 * 60);
      const breakSeconds = parseDuration(breakStr, 5 * 60);

      stats.studyPreferenceSeconds = studySeconds;
      stats.breakPreferenceSeconds = breakSeconds;
      saveUserStats(userId, stats);
      
      await startSession(interaction, userId, 0, 0, studySeconds, task, false);

    } else if (commandName === "break") {
      await interaction.deferReply();
      const userId = interaction.user.id;
      const hours = interaction.options.getInteger("hours") || 0;
      const minutes = interaction.options.getInteger("minutes") || 5;
      const seconds = interaction.options.getInteger("seconds") || 0;
      
      await startSession(interaction, userId, hours, minutes, seconds, "Break", true);

    } else if (commandName === "note") {
      const text = interaction.options.getString("text")!;
      const stats = getUserStats(interaction.user.id);
      stats.notes.push(`${new Date().toLocaleTimeString()}: ${text}`);
      saveUserStats(interaction.user.id, stats);
      await interaction.reply({ content: "📝 Note saved to your study journal!", ephemeral: true });

    } else if (commandName === "journal") {
      const stats = getUserStats(interaction.user.id);
      if (stats.notes.length === 0) return interaction.reply({ content: "Your journal is empty.", ephemeral: true });
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
        session.remainingSeconds = Math.max(0, Math.floor((session.endTime - Date.now()) / 1000));
        await interaction.reply({ content: "⏸️ Timer paused.", ephemeral: true });
      } else {
        session.endTime = Date.now() + (session.remainingSeconds * 1000);
        await interaction.reply({ content: "▶️ Timer resumed.", ephemeral: true });
      }

      try {
        const channel = await client.channels.fetch(session.channelId);
        if (channel?.isTextBased() && session.messageId) {
          const message = await channel.messages.fetch(session.messageId);
          if (message) {
            await message.edit({ embeds: [createPomodoroEmbed(session.totalSeconds, session.remainingSeconds, session.task, false, session.isPaused, session.isBreak, userId, session.participants, session.endTime)] });
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
      const stats = getUserStats(userId);
      const todos = stats.todos;

      if (subcommand === "add") {
        const task = interaction.options.getString("task")!;
        todos.push(task);
        saveUserStats(userId, stats);
        await interaction.reply({ content: `✅ Added task: **${task}**`, ephemeral: true });
      } else if (subcommand === "list") {
        if (todos.length === 0) {
          await interaction.reply({ content: "📝 Your todo list is empty. Great job!", ephemeral: true });
        } else {
          const list = todos.map((t, i) => `${i + 1}. ${t}`).join("\n");
          const embed = new EmbedBuilder()
            .setTitle("📝 Your Todo List")
            .setDescription(list)
            .setColor("#fe9494");
          await interaction.reply({ embeds: [embed], ephemeral: true });
        }
      } else if (subcommand === "complete") {
        const index = interaction.options.getInteger("index")! - 1;
        if (index >= 0 && index < todos.length) {
          const removed = todos.splice(index, 1)[0];
          saveUserStats(userId, stats);
          await interaction.reply({ content: `🎉 Completed task: **${removed}**`, ephemeral: true });
        } else {
          await interaction.reply({ content: "❌ Invalid task number.", ephemeral: true });
        }
      } else if (subcommand === "remove") {
        const index = interaction.options.getInteger("index")! - 1;
        if (index >= 0 && index < todos.length) {
          const removed = todos.splice(index, 1)[0];
          saveUserStats(userId, stats);
          await interaction.reply({ content: `🗑️ Removed task: **${removed}**`, ephemeral: true });
        } else {
          await interaction.reply({ content: "❌ Invalid task number.", ephemeral: true });
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
      const targetUser = interaction.options.getUser("user") || interaction.user;
      const stats = getUserStats(targetUser.id);
      const theme = THEMES[stats.theme] || THEMES.sakura;
      const progress = Math.floor((stats.xp % 100) / 10);
      const progressBar = `${theme.barFull.repeat(progress)}${theme.barEmpty.repeat(10 - progress)}`;

      const currentRole = ROLE_REWARDS.find(r => stats.level >= r.level)?.name || "None";

      const embed = new EmbedBuilder()
        .setTitle(`${theme.emoji} ${targetUser.username}'s Stats`)
        .setColor(theme.color)
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
          { name: "Level", value: `${stats.level}`, inline: true },
          { name: "Total XP", value: `${stats.xp.toLocaleString()} XP`, inline: true },
          { name: "Level Role", value: `✨ ${currentRole}`, inline: true },
          { name: "Focus Time", value: `${Math.floor(stats.totalFocusTime / 3600)}h ${Math.floor((stats.totalFocusTime % 3600) / 60)}m`, inline: true },
          { name: "Progress", value: `${progressBar} **${stats.xp % 100}/100 XP**` }
        )
        .setFooter({ text: "Nova Focus System • Continuous improvement ✨" })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    } else if (commandName === "leaderboard") {
      if (!interaction.guild) return interaction.reply("Only works in servers!");
      
      await interaction.deferReply();

      try {
        if (interaction.guild.members.cache.size < (interaction.guild.memberCount || 0)) {
          await interaction.guild.members.fetch({ time: 5000 }).catch(() => {
            console.warn("[LEADERBOARD] Partial member fetch timed out.");
          });
        }
      } catch (e) {
        console.warn("[LEADERBOARD] Member cache prep failed.");
      }

      const guildMembers = interaction.guild.members.cache;
      
      // Collect IDs from Memory + Guild + Disk 📂
      const diskIds = fs.readdirSync(USER_DATA_DIR)
        .filter(f => f.endsWith(".json"))
        .map(f => f.replace(".json", ""));

      const allKnownIds = new Set([...guildMembers.keys(), ...userStats.keys(), ...diskIds]);

      const combinedStats = Array.from(allKnownIds)
        .map(id => {
          const stats = getUserStats(id);
          const member = guildMembers.get(id);
          return { 
            id, 
            username: member ? member.user.username : `Explorer-${id.substring(0, 4)}`, 
            xp: stats.xp,
            level: stats.level,
            totalFocusTime: stats.totalFocusTime,
            inGuild: !!member
          };
        })
        .filter(u => u.inGuild && u.id !== client.user?.id)
        .sort((a, b) => b.xp - a.xp)
        .slice(0, 10);

      if (combinedStats.length === 0) {
        return interaction.editReply("🏆 The leaderboard is currently empty.");
      }

      let description = "The top students striving for excellence! ✨\n\n";
      for (let i = 0; i < combinedStats.length; i++) {
        const stats = combinedStats[i];
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "🔹";
        const studyTime = formatDuration(stats.totalFocusTime);
        
        description += `${medal} **Rank #${i + 1}** • <@${stats.id}>\n`;
        description += `╰ Level **${stats.level}** | **${stats.xp.toLocaleString()}** XP | Focus: **${studyTime}**\n\n`;
      }

      const embed = new EmbedBuilder()
        .setTitle("🏆 Focus Excellence Leaderboard")
        .setColor("#fe9494")
        .setDescription(description)
        .setFooter({ text: "Nova Focus System • Keep pushing your limits! ✨" })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } else if (commandName === "test-xp") {
      const level = interaction.options.getInteger("level")!;
      const stats = getUserStats(interaction.user.id);
      stats.level = level;
      stats.xp = (level - 1) * 100;
      saveUserStats(interaction.user.id, stats);
      await interaction.reply({ content: `✨ Your level has been set to **${level}** for testing!`, ephemeral: true });
    } else if (commandName === "admin-set-stats") {
      const targetUser = interaction.options.getUser("user")!;
      const xp = interaction.options.getInteger("xp");
      const hours = interaction.options.getInteger("hours");
      const stats = getUserStats(targetUser.id);
      
      if (xp !== null) {
        stats.xp = xp;
        stats.level = Math.floor(stats.xp / 100) + 1;
      }
      
      if (hours !== null) {
        stats.totalFocusTime = hours * 3600;
      }

      saveUserStats(targetUser.id, stats);
      
      await interaction.reply({ 
        content: `🎁 Updated stats for <@${targetUser.id}>!\n✨ **XP:** ${stats.xp} (Level ${stats.level})\n⏰ **Focus Time:** ${hours ?? Math.floor(stats.totalFocusTime / 3600)}h`,
        ephemeral: false 
      });
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
        { name: "Ping", value: `${client.ws.ping}ms`, inline: true },
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
      saveUserStats(interaction.user.id, stats);
      const theme = THEMES[choice];

      await interaction.reply({ 
        content: `✨ Aesthetic theme updated to **${theme.name}**!`, 
        ephemeral: true 
      });

    } else if (commandName === "check-nova") {
      await interaction.deferReply({ ephemeral: true });
      const member = interaction.member as GuildMember;
      const channel = member.voice.channel;
      
      if (!channel) return interaction.editReply("Join a voice channel first!");

      const me = interaction.guild!.members.me!;
      const perms = channel.permissionsFor(me);
      
      const embed = new EmbedBuilder()
        .setTitle("🛡️ Nova Health Check")
        .setColor(perms.has(PermissionFlagsBits.Speak) ? "#fe9494" : "#ff0000")
        .addFields(
          { name: "Connect", value: perms.has(PermissionFlagsBits.Connect) ? "✅" : "❌", inline: true },
          { name: "Speak", value: perms.has(PermissionFlagsBits.Speak) ? "✅" : "❌", inline: true },
          { name: "Bot Name", value: client.user!.username, inline: true }
        );

      await interaction.editReply({ embeds: [embed] });
    } else if (commandName === "group") {
      await interaction.deferReply({ ephemeral: true });
      const subcommand = interaction.options.getSubcommand();
      const userId = interaction.user.id;
      const stats = getUserStats(userId);

      if (subcommand === "create") {
        const name = interaction.options.getString("name")!;
        const goalHours = interaction.options.getInteger("goal")!;
        
        if (stats.groupId) {
          return interaction.editReply({ content: "❌ You are already in a study group! Leave your current group first." });
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
        saveStudyGroup(groupId, newGroup);
        stats.groupId = groupId;
        saveUserStats(userId, stats);

        const embed = new EmbedBuilder()
          .setTitle("🤝 New Study Group Created!")
          .setColor("#fe9494")
          .setDescription(`Group **${name}** has been formed!\n\n**Group ID:** \`${groupId}\`\n**Goal:** ${goalHours} hours\n\nShare the ID with your friends so they can join!`)
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

      } else if (subcommand === "join") {
        const groupId = interaction.options.getString("id")!.toUpperCase();
        const group = studyGroups.get(groupId);

        if (!group) {
          return interaction.editReply({ content: "❌ Study group not found. Check the ID and try again." });
        }

        if (stats.groupId) {
          return interaction.editReply({ content: "❌ You are already in a study group! Leave your current group first." });
        }

        if (group.members.includes(userId)) {
          return interaction.editReply({ content: "❌ You are already a member of this group!" });
        }

        group.members.push(userId);
        saveStudyGroup(groupId, group);
        stats.groupId = groupId;
        saveUserStats(userId, stats);

        await interaction.editReply({ content: `✅ You've joined the study group: **${group.name}**!` });

      } else if (subcommand === "invite") {
        if (!stats.groupId) {
          return interaction.editReply({ content: "❌ You aren't in a study group! Create one first." });
        }
        const group = studyGroups.get(stats.groupId)!;
        const targetUser = interaction.options.getUser("user")!;

        const embed = new EmbedBuilder()
          .setTitle("💌 Study Group Invitation")
          .setColor("#fe9494")
          .setDescription(`<@${userId}> has invited you to join their study group: **${group.name}**!\n\n**Group ID:** \`${group.id}\`\n\nUse \`/group join id:${group.id}\` to join!`)
          .setTimestamp();

        await interaction.editReply({ content: `Invitation sent to <@${targetUser.id}>!` });
        try {
          await targetUser.send({ embeds: [embed] });
        } catch (e) {
          await interaction.followUp({ content: "⚠️ I couldn't send a DM to that user, but I've posted the invite here.", ephemeral: true });
        }

      } else if (subcommand === "stats") {
        if (!stats.groupId) {
          return interaction.editReply({ content: "❌ You aren't in a study group." });
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

        await interaction.editReply({ embeds: [embed] });

      } else if (subcommand === "leave") {
        if (!stats.groupId) {
          return interaction.editReply({ content: "❌ You aren't in a study group." });
        }
        const group = studyGroups.get(stats.groupId)!;
        group.members = group.members.filter(id => id !== userId);
        saveStudyGroup(group.id, group);
        stats.groupId = null;
        saveUserStats(userId, stats);

        if (group.members.length === 0) {
          studyGroups.delete(group.id);
          try {
            fs.unlinkSync(path.join(STUDY_GROUP_DATA_DIR, `${group.id}.json`));
          } catch (e) {}
          await interaction.editReply({ content: `👋 You left and the group **${group.name}** has been disbanded as it was empty.` });
        } else {
          await interaction.editReply({ content: `👋 You left the study group: **${group.name}**.` });
        }
      } else if (subcommand === "leaderboard") {
        const sortedGroups = Array.from(studyGroups.values())
          .sort((a, b) => b.totalSecondsFocused - a.totalSecondsFocused)
          .slice(0, 10);

        if (sortedGroups.length === 0) {
          return interaction.editReply("🏆 No study groups have been formed yet. Be the first to start one!");
        }

        let description = "Our most dedicated study collectives! 🤝\n\n";
        for (let i = 0; i < sortedGroups.length; i++) {
          const group = sortedGroups[i];
          const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "👥";
          const focusTime = `${Math.floor(group.totalSecondsFocused / 3600)}h ${Math.floor((group.totalSecondsFocused % 3600) / 60)}m`;
          const progress = Math.min(Math.floor((group.totalSecondsFocused / group.goalSeconds) * 100), 100);
          
          description += `${medal} **Rank #${i + 1}** • **${group.name}**\n`;
          description += `╰ Focused: **${focusTime}** | Goal Progress: **${progress}%**\n\n`;
        }

        const embed = new EmbedBuilder()
          .setTitle("🏆 Focus Group Leaderboard")
          .setColor("#fe9494")
          .setDescription(description)
          .setTimestamp()
          .setFooter({ text: "Nova Focus System • Stronger together ✨" });

        await interaction.editReply({ embeds: [embed] });
      }
    }
  }
} catch (error: any) {
  // Suppress "Unknown Interaction" errors as they usually mean the token expired correctly
  if (error.code === 10062) {
    return console.warn("[INTERACTION] Suppressed Unknown Interaction (Token expired/Cleaned up).");
  }

  console.error("[CRITICAL ERROR] Interaction failed:", error);
  try {
    const repliable = interaction as any;
    if (typeof repliable.reply === 'function') {
      if (!repliable.replied && !repliable.deferred) {
        await repliable.reply({ content: "🎀 Nova encountered a small glitch! Please try that again. ✨", ephemeral: true });
      } else if (typeof repliable.followUp === 'function') {
        await repliable.followUp({ content: "🎀 Nova encountered a small glitch! Please try that again. ✨", ephemeral: true });
      }
    }
  } catch (e) {}
}
});

async function startServer() {
  console.log("[SERVER] Initializing Nova server...");
  const app = express();
  const PORT = 3000;

  // 🛡️ API Health & Status Routes (Defined first to be resilient)
  app.get("/api/bot-status", (req, res) => {
    try {
      res.json({
        status: botStatus,
        servers: client.guilds?.cache?.size || 0,
        uptime: botStatus === "online" ? Math.floor((Date.now() - startTime) / 1000) : 0,
        hasToken: !!DISCORD_TOKEN,
        hasGuildId: !!GUILD_ID,
        error: lastError
      });
    } catch (routeError) {
      res.status(500).json({ error: "Internal route error" });
    }
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", bot: botStatus });
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

  // Start listening after all middleware is set up
  const server = app.listen(PORT, "0.0.0.0", async () => {
    console.log(`[SERVER] Nova v1.0.1 (Hard Restart) running on http://0.0.0.0:${PORT}`);
    console.log(`[SERVER] Restart Timestamp: ${new Date().toISOString()}`);
    
    // Pre-cache the beep sound
    try {
      console.log("[SERVER] Pre-caching notification sound...");
      const response = await axios.get(BEEP_URL, { responseType: 'arraybuffer' });
      cachedBeepBuffer = Buffer.from(response.data);
      console.log("[SERVER] Notification sound cached successfully.");
    } catch (e) {
      console.error("[SERVER] Failed to pre-cache sound:", e);
    }

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

  server.on("error", (err) => {
    console.error("[SERVER] Server error:", err);
    lastError = err.message;
  });
}

startServer();
