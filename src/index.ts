#!/usr/bin/env bun
/**
 * Earth — Discord music bot (YouTube via Lavalink)
 *
 * ONE bot does everything: slash commands, the player panel, typed song requests and the voice
 * connection itself (Lavalink streams the audio, so nothing is decoded in this process).
 * No speech recognition, no listening to voice channels, no spoken replies.
 *
 * Slash commands (owner-only, see DC_OWNER_IDS — except /earth join, which anyone can use
 * for the voice channel they are sitting in; the channel-id option stays owner-only):
 *   /earth join [channel-id]  — join the caller's voice channel
 *   /earth leave              — leave (stops music)
 *   /earth stop               — stop the current song
 *   /earth status             — voice channel, now playing, queue length
 *   /earth stay [hours]       — disable auto-leave for a while (max 24h)
 *   /earth unstay             — re-enable auto-leave
 *   /earth setup [channel-id] — set the music room (default: the channel you type it in)
 *   /earth unsetup            — remove the music room
 *
 * Music room (/earth setup [channel-id]):
 *   - typing a song name (or a YouTube link / playlist link) in that text channel plays it, or
 *     queues it if something is playing — no prefix, no wake word. Needs the Message Content intent.
 *   - the player panel is kept in that channel instead of QUEUE_CHANNEL_ID, as ONE permanent
 *     message that is edited — it flips to an idle panel when nothing is playing.
 *   - /earth unsetup removes it. Saved in DATA_DIR/setup.json (survives restarts).
 *
 * Player panel: a Components V2 message — one container holding the blurred-cover card
 *   (music/nowPlayingCard.ts, attached as a file), the text, a queue dropdown and two rows of
 *   buttons (music/controls.ts): 🔀 shuffle · ⏮ previous · ⏯ pause · ⏭ next · 🔁 loop /
 *   📋 queue · 🔉 vol− · ⏹ stop · 🔊 vol+ · 🕘 history. Buttons only work for people in Earth's
 *   voice channel (or owners).
 *
 * Auto-leave: as soon as no human is left in the channel, Earth leaves
 * (after a short grace, ALONE_LEAVE_DELAY_MS) — unless /earth stay is on.
 *
 * Run:
 *   bun src/index.ts          (foreground)
 *   bun --watch src/index.ts  (dev)
 */
import path from "node:path";
import {
  AttachmentBuilder,
  Client,
  ContainerBuilder,
  Events,
  GatewayIntentBits,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  PermissionsBitField,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type ButtonInteraction,
  type Message,
  type StringSelectMenuInteraction,
  type VoiceState,
  type ChatInputCommandInteraction,
  type GuildMember,
  type VoiceBasedChannel,
} from "discord.js";
import { YOI_BASE_NAMES, ALIAS_TO_SUBCOMMAND } from "./commands.ts";
import { LavalinkMusic } from "./music/lavalink.ts";
import { MusicHistory, type HistorySort } from "./music/history.ts";
import { buildPlayerSections, buildQueueListText, clip as clipText, escapeMd as escapeMdText } from "./music/queue.ts";
import { renderIdleCard, renderNowPlaying } from "./music/nowPlayingCard.ts";
import {
  CONTROL_ID,
  CONTROL_PREFIX,
  HISTORY_DEFAULT_SORT,
  HISTORY_PAGE_SIZE,
  HISTORY_PREFIX,
  QUEUE_ID,
  QUEUE_PREFIX,
  VOLUME_STEP,
  buildControlRows,
  buildHistoryItemPanel,
  buildHistoryPanel,
  buildQueueItemPanel,
  buildQueueNotice,
  buildQueueSelectRow,
  clampHistoryPage,
  historyPageCount,
  parseHistoryId,
  queueItemId,
} from "./music/controls.ts";
import { parseSongRequest } from "./music/request.ts";
import { SetupStore } from "./setup-store.ts";
import { inspectDataDir } from "./data-dir.ts";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("[earth] DISCORD_TOKEN missing in .env");
  process.exit(1);
}

const OWNER_IDS = new Set(
  (process.env.DC_OWNER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
if (OWNER_IDS.size === 0) {
  console.warn(
    "[earth] ⚠️ DC_OWNER_IDS is empty — owner-only slash commands (everything except /earth join) will be ignored for ALL users",
  );
}

/**
 * Slash subcommands anyone can run. Everything else is owner-only.
 * Non-owners get a restricted /earth join (see handleJoin): only in a server, only into the
 * voice channel they are sitting in — never a channel picked by id.
 */
const PUBLIC_SUBCOMMANDS = new Set(["join"]);

const AUTO_LEAVE_ALONE_MS = Number(process.env.AUTO_LEAVE_ALONE_MS) || 5 * 60 * 1000;
// Leave this long after the last human leaves the channel (small grace so a
// quick channel switch / reconnect does not make Earth bounce). 0 = instantly.
const ALONE_LEAVE_DELAY_MS = Number(process.env.ALONE_LEAVE_DELAY_MS ?? 2000);
// Text channel for the live player panel when no music room is set up with /earth setup
// (the bot needs View Channel + Send Messages + Embed Links there). Empty = no panel outside a music room.
const QUEUE_CHANNEL_ID = process.env.QUEUE_CHANNEL_ID ?? "";
const MEMORY_REPORT_MS = Number(process.env.MEMORY_REPORT_MS) || 10 * 60 * 1000;
const STAY_MAX_HOURS = Number(process.env.STAY_MAX_HOURS) || 24;

const client = new Client({
  // GuildVoiceStates: needed by the voice connection and by auto-leave.
  // GuildMessages + MessageContent: read song names typed in the /earth setup channel.
  // MessageContent is a PRIVILEGED intent — enable "Message Content Intent" for this bot in the
  // Discord Developer Portal (Bot tab), otherwise login fails with "Used disallowed intents".
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// Music rooms set with /earth setup (guildId → channel + persistent panel message).
// Where setup.json + music-history.db live: DATA_DIR → the Railway Volume mount → ./data (see data-dir.ts).
const dataDir = inspectDataDir();
console.log(`[data] folder: ${path.resolve(dataDir.dir)}${dataDir.volume ? ` (Railway Volume ${dataDir.volume})` : ""}`);
if (dataDir.warning) console.warn(`[data] ⚠️ ${dataDir.warning}`);
const setupStore = new SetupStore(path.join(dataDir.dir, "setup.json"));
setupStore.load();
// Delete the typed request after handling it, so the player panel stays at the bottom.
// Needs Manage Messages in the setup channel; set SETUP_DELETE_MESSAGES=false to keep them.
const SETUP_DELETE_MESSAGES = process.env.SETUP_DELETE_MESSAGES !== "false";

// Song history (SQLite in DATA_DIR/music-history.db): remembers what was played so repeat requests
// pick the same video. Set MUSIC_HISTORY=false to turn it off. Never fatal — without it the bot
// just searches YouTube every time.
let musicHistory: MusicHistory | null = null;
if (process.env.MUSIC_HISTORY !== "false") {
  try {
    musicHistory = new MusicHistory(path.join(dataDir.dir, "music-history.db"));
    // After a restart this should still show the old numbers. 0 on every boot = the data folder is not persistent.
    console.log(`[history] opened — ${musicHistory.countAll()} plays saved so far`);
  } catch (e: any) {
    console.warn("[history] could not open the song history database — continuing without it:", e?.message ?? e);
  }
}
const music = new LavalinkMusic(client, musicHistory);
const aloneSince = new Map<string, number>(); // guildId → ms when bot became alone
/** /earth stay: guildId → epoch ms until which auto-leave is skipped. */
const stayUntil = new Map<string, number>();

const FALLBACK_GUILD_ID = process.env.DISCORD_GUILD_ID;

/**
 * Resolve which guild to act on for non-join commands:
 *   1. interaction.guildId (when called from a guild channel)
 *   2. The first guild the bot is currently in a voice channel of
 *   3. DISCORD_GUILD_ID fallback (single-guild default)
 */
function resolveActiveGuildId(interaction: ChatInputCommandInteraction): string | null {
  if (interaction.guildId) return interaction.guildId;
  for (const gid of client.guilds.cache.keys()) {
    if (music.channelId(gid)) return gid;
  }
  return FALLBACK_GUILD_ID ?? null;
}

function isStaying(guildId: string): boolean {
  const until = stayUntil.get(guildId) ?? 0;
  return until > 0 && Date.now() < until;
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

client.once(Events.ClientReady, (c) => {
  console.log(`[earth] Earth ready — logged in as ${c.user.tag} (id=${c.user.id})`);
  console.log(`[earth] In ${c.guilds.cache.size} guild(s); slash commands handled per-guild`);
  console.log(`[earth] config: auto-leave-alone=${AUTO_LEAVE_ALONE_MS}ms`);
  startAutoLeaveWatcher();
  startStayCapWatcher();
  startMemoryReporter();
  startCardTicker();
  // After a restart nothing is playing: bring every music room's panel back to "idle"
  // (or re-create it if someone deleted it while the bot was offline).
  for (const gid of setupStore.guildIds()) {
    void runQueueUi(gid, () => refreshQueueEmbed(gid));
  }
});

// ─── Live queue embed ────────────────────────────────────────────────────────
// One embed message per guild in QUEUE_CHANNEL_ID. Created when music starts,
// edited on every queue / now-playing change, deleted when nothing is left.
const queueMessages = new Map<string, Message>();
const queueRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const queueUiChains = new Map<string, Promise<void>>();
const setupChains = new Map<string, Promise<void>>();

/** Run `fn` strictly after the previous job with the same key. Never rejects (errors are logged). */
function serial(
  chains: Map<string, Promise<void>>,
  key: string,
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn).catch((e: any) => {
    console.warn(`[earth] ${label}:`, e?.message ?? e);
  });
  chains.set(key, next);
  return next;
}

/** Run embed work for a guild strictly one at a time (so we never post two embeds). */
function runQueueUi(guildId: string, fn: () => Promise<void>): Promise<void> {
  return serial(queueUiChains, guildId, "queue embed update failed", fn);
}

/** Coalesce bursts of changes (play + advance + ...) into one embed update. */
function scheduleQueueRefresh(guildId: string): void {
  if (queueRefreshTimers.has(guildId)) return;
  queueRefreshTimers.set(
    guildId,
    setTimeout(() => {
      queueRefreshTimers.delete(guildId);
      void runQueueUi(guildId, () => refreshQueueEmbed(guildId));
    }, 250),
  );
}

/** Where the player panel goes: the /earth setup channel if there is one, else QUEUE_CHANNEL_ID ("" = nowhere). */
function embedChannelId(guildId: string): string {
  return setupStore.get(guildId)?.channelId ?? QUEUE_CHANNEL_ID;
}

async function getQueueChannel(guildId: string) {
  const id = embedChannelId(guildId);
  if (!id) return null; // no music room and no QUEUE_CHANNEL_ID → no panel
  const ch = await client.channels.fetch(id).catch((e: any) => {
    console.warn(`[earth] cannot fetch queue channel ${id}:`, e?.message ?? e);
    return null;
  });
  if (!ch || !ch.isSendable()) {
    console.warn(`[earth] queue channel ${id} is missing or not a text channel`);
    return null;
  }
  return ch;
}

/** Remember a freshly posted embed (and, in a music room, its message id for after a restart). */
function trackEmbed(guildId: string, msg: Message): void {
  queueMessages.set(guildId, msg);
  const entry = setupStore.get(guildId);
  if (entry && entry.messageId !== msg.id) {
    setupStore.set(guildId, { channelId: entry.channelId, messageId: msg.id });
  }
}

/** The live embed message: the cached one, or (music room) the one saved before a restart. */
async function findEmbedMessage(guildId: string): Promise<Message | null> {
  const cached = queueMessages.get(guildId);
  if (cached) return cached;
  const savedId = setupStore.get(guildId)?.messageId;
  if (!savedId) return null;
  const ch = await getQueueChannel(guildId);
  if (!ch) return null;
  const msg = await ch.messages.fetch(savedId).catch(() => null); // deleted meanwhile → null
  if (msg) queueMessages.set(guildId, msg);
  return msg;
}

async function deleteQueueEmbed(guildId: string): Promise<void> {
  const msg = await findEmbedMessage(guildId);
  queueMessages.delete(guildId);
  const entry = setupStore.get(guildId);
  if (entry?.messageId) setupStore.set(guildId, { channelId: entry.channelId });
  if (!msg) return;
  await msg.delete().catch(() => {}); // already gone / no permission → nothing to do
}

async function queuePayload(guildId: string) {
  const np = music.nowPlaying(guildId);
  const paused = music.isPaused(guildId);
  const loop = music.getLoop(guildId);

  // Blurred-cover card, rendered from the song's artwork. If rendering fails the message
  // is still sent, just without the picture (no embed to fall back on, either way).
  // A NEW file name for every render: each edit deletes the old attachment and uploads a new one, and
  // when both carry the same name Discord / the app can keep pointing at the deleted one
  // ("Image failed to load"). The name must match the attachment:// URL of the gallery below.
  const cardName = `nowplaying-${Date.now().toString(36)}.png`;
  const files: AttachmentBuilder[] = [];
  try {
    // Nothing playing → the static "Waiting for a song…" card instead.
    const card = np
      ? await renderNowPlaying(np, music.positionMs(guildId) ?? 0, { paused })
      : await renderIdleCard();
    files.push(new AttachmentBuilder(card, { name: cardName }));
  } catch (e: any) {
    console.warn("[earth] now-playing card render failed:", e?.message ?? e);
  }

  // "ขอเพลง โดย @user ใน 🔊 ห้อง" — the room is the voice channel the bot is sitting in.
  let shown = np;
  if (np) {
    const name = client.guilds.cache.get(guildId)?.members.me?.voice.channel?.name;
    if (name) shown = { ...np, voiceChannelName: name };
  }

  const sections = buildPlayerSections(shown, music.getQueue(guildId), {
    volumePct: music.getVolume(guildId),
    loop,
    paused,
    setupChannel: setupStore.get(guildId) !== undefined,
  });

  // Components V2 layout: ONE container holding the text, the card picture and the buttons.
  // No accent colour is set, so there is no colour strip on any theme.
  // (V2 messages can't carry `content` / `embeds`; the IsComponentsV2 flag is mandatory.)
  const container = new ContainerBuilder();

  // Text in sections with a real Separator line between them (instead of a row of "─" characters).
  sections.forEach((text, idx) => {
    if (idx > 0) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      );
    }
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  });

  if (files.length > 0) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(`attachment://${cardName}`),
      ),
    );
  }

  // Thin divider between the card picture and the button rows.
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
  );

  // Queue as a Dropdown Menu: pick a song → ▶ เล่นเลย / 🗑 ลบ (handleQueueSelect / handleQueueButton).
  // Greyed out while the queue is empty, like the buttons below.
  container.addActionRowComponents(buildQueueSelectRow(music.getQueue(guildId)));

  // Buttons are always shown; with nothing playing they are all greyed out / unclickable.
  container.addActionRowComponents(
    ...buildControlRows({ paused, loop, disabled: !np, history: !!musicHistory }),
  );

  return {
    components: [container],
    files,
    // `as const` keeps the literal type — discord.js only accepts these flags on create/edit.
    flags: MessageFlags.IsComponentsV2 as const,
    allowedMentions: { parse: [] as never[] },
  };
}

/**
 * Make the embed match the current music state.
 *  - normal channel (QUEUE_CHANNEL_ID): create / edit / delete when nothing is left
 *  - music room (/earth setup): one permanent message — create / edit, never delete;
 *    it shows an idle panel when nothing is playing
 */
async function refreshQueueEmbed(guildId: string): Promise<void> {
  const inMusicRoom = setupStore.get(guildId) !== undefined;
  const idle = !music.nowPlaying(guildId) && music.getQueue(guildId).length === 0;
  if (idle && !inMusicRoom) {
    await deleteQueueEmbed(guildId); // nothing playing, nothing queued
    return;
  }

  const existing = await findEmbedMessage(guildId);
  if (existing) {
    try {
      // attachments: [] clears the old card first — otherwise edit() keeps the previous
      // file around and a same-named new one isn't guaranteed to replace it.
      await existing.edit({ ...(await queuePayload(guildId)), attachments: [] });
      return;
    } catch (e: any) {
      // 10008 = message was deleted by someone → re-post.
      // 50035 = an old (pre-V2) panel message can't be edited into a Components V2 one →
      //         delete it and post a fresh one.
      if (e?.code !== 10008 && e?.code !== 50035) throw e;
      if (e?.code === 50035) await existing.delete().catch(() => {});
      queueMessages.delete(guildId);
    }
  }
  const ch = await getQueueChannel(guildId);
  if (!ch) return;
  trackEmbed(guildId, await ch.send(await queuePayload(guildId)));
}

/** "แสดงคิว": move the embed to the bottom of the channel (fresh message). */
async function repostQueueEmbed(guildId: string): Promise<void> {
  await deleteQueueEmbed(guildId);
  const ch = await getQueueChannel(guildId);
  if (!ch) return;
  const msg = await ch.send(await queuePayload(guildId));
  // Outside a music room, with nothing playing/queued the embed is a one-off answer, not a live one.
  if (
    setupStore.get(guildId) ||
    music.nowPlaying(guildId) ||
    music.getQueue(guildId).length > 0
  ) {
    trackEmbed(guildId, msg);
  }
}

music.onChange = (guildId) => scheduleQueueRefresh(guildId);

// ─── Player buttons ──────────────────────────────────────────────────────────
// The buttons under the player panel (see music/controls.ts). Like typed requests in the
// music room, they only work for people sitting in Earth's voice channel (owners always).
// Everything except 📋 is answered with deferUpdate(): the music state change fires
// music.onChange, which re-renders the panel (new card, new button states) on its own.
/**
 * Who may use the player's buttons / queue dropdown: people sitting in Earth's voice channel
 * (owners always). Replies with the reason (ephemeral) and returns null when not allowed.
 */
async function requirePlayerAccess(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<{ guildId: string } | null> {
  const guildId = interaction.guildId;
  if (!guildId) return null;

  const roomId = music.channelId(guildId);
  const userVc = interaction.guild?.voiceStates.cache.get(interaction.user.id)?.channelId ?? null;
  if (!OWNER_IDS.has(interaction.user.id) && !(roomId && userVc === roomId)) {
    await interaction.reply({
      content: roomId
        ? `ต้องอยู่ voice channel เดียวกับเอิร์ธ (<#${roomId}>) ถึงจะกดปุ่มได้ครับ`
        : "เอิร์ธยังไม่ได้อยู่ในห้องเสียงครับ",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  return { guildId };
}

/**
 * Access check for 🕘 history. Unlike the other player buttons it works while nothing plays (the
 * first song of a session can come from the history), so it can't rely on Earth already being in a
 * room. Rules (same as typed requests in the music room):
 *  - Earth is in a room → the clicker must sit in that same channel (owners always).
 *  - Earth is not in a room → the clicker must be in a voice channel, and only owners may call
 *    Earth in; that channel is returned so playing / queueing can join it.
 * Replies with the reason (ephemeral) and returns null when not allowed.
 */
async function requireHistoryAccess(
  interaction: ButtonInteraction,
): Promise<{
  guildId: string;
  /** True when Earth is already in a voice channel. */
  inRoom: boolean;
  /** Where the song should play: Earth's current room, or the clicker's channel when Earth must join. */
  voiceChannelId: string;
} | null> {
  const guildId = interaction.guildId;
  if (!guildId) return null;
  const deny = async (content: string) => {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    return null;
  };

  const roomId = music.channelId(guildId);
  const isOwner = OWNER_IDS.has(interaction.user.id);
  const userVc = interaction.guild?.voiceStates.cache.get(interaction.user.id)?.channelId ?? null;

  if (roomId) {
    if (!isOwner && userVc !== roomId) {
      return deny(`ต้องอยู่ voice channel เดียวกับเอิร์ธ (<#${roomId}>) ถึงจะใช้ประวัติเพลงได้ครับ`);
    }
    return { guildId, inRoom: true, voiceChannelId: roomId };
  }

  // Earth is not in a room yet.
  if (!userVc) return deny("เข้า voice channel ก่อนนะครับ แล้วกดปุ่มประวัติเพลงอีกครั้ง");
  if (!isOwner) return deny("เอิร์ธยังไม่ได้เข้าห้องเสียง — ให้เจ้าของเรียกเอิร์ธเข้าห้องก่อนนะครับ");
  return { guildId, inRoom: false, voiceChannelId: userVc };
}

/**
 * Join `voiceChannelId` (shared by /earth join and the history panel). Runs on the same
 * per-guild chain as typed music-room requests, so two people can't make Earth connect twice.
 * Returns an error text for the user, or null when Earth is now in that room.
 */
async function ensureJoined(guildId: string, voiceChannelId: string): Promise<string | null> {
  let problem: string | null = "เข้าห้องเสียงไม่ได้ครับ";
  await serial(setupChains, guildId, "join voice failed", async () => {
    // Someone else may have called Earth in while we were waiting for our turn.
    const current = music.channelId(guildId);
    if (current) {
      problem =
        current === voiceChannelId ? null : `ต้องอยู่ voice channel เดียวกับเอิร์ธ (<#${current}>) ครับ`;
      return;
    }
    const channel = client.guilds.cache.get(guildId)?.channels.cache.get(voiceChannelId);
    if (!channel || !channel.isVoiceBased()) {
      problem = "ไม่พบห้องเสียงของคุณครับ";
      return;
    }
    try {
      await music.join(guildId, voiceChannelId);
      problem = null;
      checkAloneNow(guildId);
    } catch (e: any) {
      console.warn("[earth] could not join voice:", e?.message ?? e);
      problem = `เข้าห้องเสียงไม่ได้: ${e?.message ?? "unknown"}`;
    }
  });
  return problem;
}

async function handleControlButton(interaction: ButtonInteraction): Promise<void> {
  const id = interaction.customId;
  if (!id.startsWith(CONTROL_PREFIX)) return;

  // 🕘 history stays clickable while nothing plays, so it has its own access check.
  if (id === CONTROL_ID.history) {
    if (!interaction.guildId) return;
    if (!musicHistory) {
      await interaction.reply({
        content: "ประวัติเพลงปิดอยู่ครับ (MUSIC_HISTORY=false)",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!(await requireHistoryAccess(interaction))) return;
    await interaction.reply({
      components: [historyPanelFor(interaction.guildId, 0, HISTORY_DEFAULT_SORT)],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
    return;
  }

  const access = await requirePlayerAccess(interaction);
  if (!access) return;
  const { guildId } = access;

  if (id === CONTROL_ID.queue) {
    const text = buildQueueListText(music.nowPlaying(guildId), music.getQueue(guildId));
    await interaction.reply({
      components: [
        new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(text)),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate(); // acknowledge within Discord's 3 s window
  const say = (content: string) =>
    interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  const userTag = `user=${interaction.user.id}`;

  try {
    switch (id) {
      case CONTROL_ID.pause:
        await music.togglePause(guildId);
        break;
      case CONTROL_ID.next: {
        const r = await music.skip(guildId);
        console.log(`[earth] ⏭️ button ${userTag}: skip → ${r.skipped ? "skipped" : "nothing playing"}`);
        break;
      }
      case CONTROL_ID.previous:
        if (!(await music.previous(guildId))) await say("ยังไม่มีเพลงก่อนหน้าครับ");
        break;
      case CONTROL_ID.shuffle:
        if (!music.shuffleQueue(guildId)) await say("ต้องมีเพลงในคิวอย่างน้อย 2 เพลง ถึงจะสลับลำดับได้ครับ");
        break;
      case CONTROL_ID.loop:
        music.cycleLoop(guildId);
        break;
      case CONTROL_ID.volumeDown:
        await music.changeVolume(guildId, -VOLUME_STEP);
        break;
      case CONTROL_ID.volumeUp:
        await music.changeVolume(guildId, VOLUME_STEP);
        break;
      case CONTROL_ID.stop: {
        await music.stop(guildId);
        console.log(`[earth] ⏹️ button ${userTag}: stop`);
        break;
      }
    }
  } catch (e: any) {
    console.warn(`[earth] button ${id} failed:`, e?.message ?? e);
    await say(`ทำไม่สำเร็จ: ${e?.message ?? "unknown"}`);
  }
}

// ─── Queue dropdown ──────────────────────────────────────────────────────────
// The Dropdown Menu in the player panel lists the queue (see music/controls.ts). Picking a song
// opens an ephemeral Components V2 panel with two buttons: ▶ เล่นเลย (play it now) and
// 🗑 ลบออกจากคิว. Songs are found again by their id (queueItemId) at click time, because the
// queue may have been reordered / played / deleted since the dropdown was drawn.

/** 1-based queue position of the song with this id, or 0 when it is not in the queue any more. */
function queuePositionOf(guildId: string, itemId: string): number {
  return music.getQueue(guildId).findIndex((t) => queueItemId(t) === itemId) + 1;
}

const QUEUE_GONE = "เพลงนี้ไม่อยู่ในคิวแล้วครับ (ถูกเล่นหรือลบไปแล้ว)";

/** Dropdown → show the picked song with its ▶ / 🗑 buttons. */
async function handleQueueSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (interaction.customId !== QUEUE_ID.select) return;
  const access = await requirePlayerAccess(interaction);
  if (!access) return;
  const { guildId } = access;

  // deferUpdate() leaves the shared panel untouched and resets the dropdown, so the same song can be picked again.
  await interaction.deferUpdate();
  const position = queuePositionOf(guildId, interaction.values[0] ?? "");
  const track = position > 0 ? music.getQueue(guildId)[position - 1] : undefined;
  if (!track) {
    await interaction.followUp({ content: QUEUE_GONE, flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  await interaction
    .followUp({
      components: [buildQueueItemPanel(track, position)],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    })
    .catch((e: any) => console.warn("[earth] queue item panel failed:", e?.message ?? e));
}

/** ▶ เล่นเลย / 🗑 ลบออกจากคิว, from the ephemeral panel of a picked song. */
async function handleQueueButton(interaction: ButtonInteraction): Promise<void> {
  const id = interaction.customId;
  const isPlay = id.startsWith(QUEUE_ID.playPrefix);
  const isDelete = id.startsWith(QUEUE_ID.deletePrefix);
  if (!isPlay && !isDelete) return;
  const access = await requirePlayerAccess(interaction);
  if (!access) return;
  const { guildId } = access;
  const userTag = `user=${interaction.user.id}`;

  const itemId = id.slice((isPlay ? QUEUE_ID.playPrefix : QUEUE_ID.deletePrefix).length);
  const position = queuePositionOf(guildId, itemId);
  const track = position > 0 ? music.getQueue(guildId)[position - 1] : undefined;
  if (!track) {
    await interaction.update({
      components: [buildQueueNotice(`⚠️ ${QUEUE_GONE}`)],
      flags: MessageFlags.IsComponentsV2,
    });
    return;
  }
  const title = escapeMdText(track.title);

  if (isDelete) {
    const removed = music.removeFromQueue(guildId, position); // fires onChange → the panel redraws itself
    console.log(`[earth] 🗑️ queue dropdown ${userTag}: remove #${position} → ${removed ? `"${removed.title}"` : "no such item"}`);
    await interaction.update({
      components: [buildQueueNotice(removed ? `🗑️ ลบ **${title}** ออกจากคิวแล้ว` : `⚠️ ${QUEUE_GONE}`)],
      flags: MessageFlags.IsComponentsV2,
    });
    return;
  }

  // ▶ เล่นเลย — starting a song can take a moment (Lavalink), so acknowledge first.
  await interaction.deferUpdate();
  try {
    const playing = await music.playFromQueue(guildId, position);
    console.log(`[earth] ▶️ queue dropdown ${userTag}: play #${position} → ${playing ? `"${playing.title}"` : "failed"}`);
    await interaction.editReply({
      components: [buildQueueNotice(playing ? `<:4767voiceevent:1569242043107115118> กำลังเล่น **${title}**` : `⚠️ ${QUEUE_GONE}`)],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (e: any) {
    console.warn("[earth] queue dropdown play failed:", e?.message ?? e);
    await interaction
      .editReply({
        components: [buildQueueNotice(`⚠️ เล่นไม่สำเร็จ: ${e?.message ?? "unknown"}`)],
        flags: MessageFlags.IsComponentsV2,
      })
      .catch(() => {});
  }
}

// ─── History dropdown (🕘 button) ────────────────────────────────────────────
// 🕘 opens an ephemeral Components V2 panel (one per person) with every song this server has ever
// played, 25 per page: a dropdown + ⏮ ◀ 2/5 ▶ ⏭ page buttons + [เปิดล่าสุด] [เปิดบ่อยสุด] sort buttons
// (see music/controls.ts).
// Picking a song turns the same message into the song's panel with [เล่นเลย] [เพิ่มเข้าคิว]
// [กลับไปรายการ]; after playing / queueing it goes back to the list with a one-line result.
// The sort order and page number travel in every customId, so nothing is stored here. Paging and picking only
// read the database; playing / queueing needs the same access as the other player buttons.

const HISTORY_GONE = "ไม่พบเพลงนี้ในประวัติของเซิร์ฟเวอร์นี้แล้วครับ";

/** The history panel for `page` of `sort` (clamped — the history may have grown or shrunk since it was drawn). */
function historyPanelFor(guildId: string, page: number, sort: HistorySort, notice?: string): ContainerBuilder {
  const total = musicHistory?.countTracks(guildId) ?? 0;
  const pages = historyPageCount(total);
  const p = clampHistoryPage(page, pages);
  const entries = musicHistory?.listTracks(guildId, HISTORY_PAGE_SIZE, p * HISTORY_PAGE_SIZE, sort) ?? [];
  return buildHistoryPanel({ entries, sort, page: p, pages, total, notice });
}

/** Dropdown → show the picked song with its [เล่นเลย] / [เพิ่มเข้าคิว] / [กลับไปรายการ] buttons. */
async function handleHistorySelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const act = parseHistoryId(interaction.customId);
  if (!act || act.kind !== "pick") return;
  const guildId = interaction.guildId;
  if (!guildId || !musicHistory) return;
  const entry = musicHistory.getTrack(guildId, interaction.values[0] ?? "");
  await interaction.update({
    components: [
      entry
        ? buildHistoryItemPanel(entry, act.page, act.sort)
        : historyPanelFor(guildId, act.page, act.sort, `⚠️ ${HISTORY_GONE}`),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

/** Page buttons, and [เล่นเลย] / [เพิ่มเข้าคิว] of a picked song. */
async function handleHistoryButton(interaction: ButtonInteraction): Promise<void> {
  const act = parseHistoryId(interaction.customId);
  if (!act || act.kind === "pick") return;
  const guildId = interaction.guildId;
  if (!guildId) return;
  if (!musicHistory) {
    await interaction.update({
      components: [buildQueueNotice("⚠️ ประวัติเพลงปิดอยู่ครับ (MUSIC_HISTORY=false)")],
      flags: MessageFlags.IsComponentsV2,
    });
    return;
  }

  if (act.kind === "page") {
    await interaction.update({
      components: [historyPanelFor(guildId, act.page, act.sort)],
      flags: MessageFlags.IsComponentsV2,
    });
    return;
  }

  // play / add
  const access = await requireHistoryAccess(interaction);
  if (!access) return;
  const { inRoom, voiceChannelId } = access;
  const back = (notice: string) =>
    ({ components: [historyPanelFor(guildId, act.page, act.sort, notice)], flags: MessageFlags.IsComponentsV2 }) as const;

  const entry = musicHistory.getTrack(guildId, act.videoId ?? "");
  if (!entry) {
    await interaction.update(back(`⚠️ ${HISTORY_GONE}`));
    return;
  }

  // Starting a song can take a moment (Lavalink loads the video again), so acknowledge first.
  await interaction.deferUpdate();
  const userTag = `user=${interaction.user.id}`;
  // Nothing was playing and Earth wasn't in a room: join the clicker's voice channel first, so the
  // very first song of a session can be started from the history.
  const channelId = voiceChannelId;
  if (!inRoom) {
    const problem = await ensureJoined(guildId, channelId);
    if (problem) {
      await interaction.editReply(back(`⚠️ ${problem}`)).catch(() => {});
      return;
    }
  }
  const title = escapeMdText(clipText(entry.title, 100));
  // The link makes Lavalink load exactly this video (no search, no guessing by title).
  const url = `https://www.youtube.com/watch?v=${entry.videoId}`;
  try {
    let notice: string;
    if (act.kind === "play") {
      const track = await music.play(guildId, channelId, url, interaction.user.id); // replaces the current song
      console.log(`[earth] 🕘 history dropdown ${userTag}: play "${entry.title}" → ${track ? "ok" : "failed"}`);
      notice = track
        ? `<:4767voiceevent:1569242043107115118> กำลังเล่น **${title}**`
        : "⚠️ เล่นเพลงนี้ไม่ได้ครับ (วิดีโอถูกลบ เล่นไม่ได้ หรือยาวเกินกำหนด)";
    } else {
      const r = await music.enqueue(guildId, channelId, url, interaction.user.id); // nothing playing → plays now
      console.log(
        `[earth] 🕘 history dropdown ${userTag}: queue "${entry.title}" → ${r ? `#${r.position}` : "failed"}`,
      );
      notice = !r
        ? "⚠️ เพิ่มเพลงนี้ไม่ได้ครับ (วิดีโอเล่นไม่ได้ ยาวเกินกำหนด หรือคิวเต็ม)"
        : r.position === 0
          ? `<:4767voiceevent:1569242043107115118> กำลังเล่น **${title}**`
          : `➕ เพิ่ม **${title}** เข้าคิวแล้ว (คิวที่ ${r.position})`;
    }
    await interaction.editReply(back(notice));
  } catch (e: any) {
    console.warn("[earth] history dropdown play failed:", e?.message ?? e);
    await interaction.editReply(back(`⚠️ เล่นไม่สำเร็จ: ${e?.message ?? "unknown"}`)).catch(() => {});
  }
}

// ─── Slash commands ──────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isStringSelectMenu()) {
    const handler = interaction.customId.startsWith(HISTORY_PREFIX) ? handleHistorySelect : handleQueueSelect;
    handler(interaction).catch((e: any) =>
      console.warn("[earth] dropdown failed:", e?.message ?? e),
    );
    return;
  }
  if (interaction.isButton()) {
    const id = interaction.customId;
    const handler = id.startsWith(QUEUE_PREFIX)
      ? handleQueueButton
      : id.startsWith(HISTORY_PREFIX)
        ? handleHistoryButton
        : handleControlButton;
    handler(interaction).catch((e: any) =>
      console.warn("[earth] player button failed:", e?.message ?? e),
    );
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  const cmdName = interaction.commandName;
  const isBase = YOI_BASE_NAMES.has(cmdName);
  const aliasSub = ALIAS_TO_SUBCOMMAND[cmdName];
  if (!isBase && !aliasSub) return;

  const sub = isBase ? interaction.options.getSubcommand() : aliasSub!;

  // Owner-only gate: silent ignore for anyone not in DC_OWNER_IDS
  // (no refusal message — avoids leaking the rule). Only PUBLIC_SUBCOMMANDS are open to everyone.
  const isOwner = OWNER_IDS.has(interaction.user.id);
  if (!isOwner && !PUBLIC_SUBCOMMANDS.has(sub)) {
    console.log(
      `[earth] ignored /${cmdName} (${sub}) from non-owner user=${interaction.user.id} (${interaction.user.username})`,
    );
    return;
  }

  try {
    switch (sub) {
      case "help":
        await handleHelp(interaction);
        break;
      case "join":
        await handleJoin(interaction, isOwner);
        break;
      case "leave":
        await handleLeave(interaction);
        break;
      case "stop":
        await handleStop(interaction);
        break;
      case "status":
        await handleStatus(interaction);
        break;
      case "stay":
        await handleStay(interaction);
        break;
      case "unstay":
        await handleUnstay(interaction);
        break;
      case "setup":
        await handleSetup(interaction);
        break;
      case "unsetup":
        await handleUnsetup(interaction);
        break;
      default:
        await interaction.reply({
          content: `ไม่รู้จัก subcommand \`${sub}\` ครับ`,
          flags: MessageFlags.Ephemeral,
        });
    }
  } catch (e: any) {
    console.error(`[earth] interaction error /earth ${sub}:`, e?.message || e);
    const errMsg = `เกิดข้อผิดพลาด: ${e?.message ?? "unknown"}`;
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: errMsg, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: errMsg, flags: MessageFlags.Ephemeral });
      }
    } catch (e2: any) {
      console.warn("[earth] could not send error reply:", e2?.message ?? e2);
    }
  }
});

async function handleHelp(interaction: ChatInputCommandInteraction) {
  const helpGuildId = resolveActiveGuildId(interaction);
  const embedChannel = helpGuildId ? embedChannelId(helpGuildId) : QUEUE_CHANNEL_ID;
  const help =
    `**เอิร์ธ — บอทเปิดเพลง YouTube**\n\n` +
    `**🎵 วิธีขอเพลง**\n` +
    `พิมพ์ชื่อเพลง (หรือวางลิงก์ YouTube / เพลย์ลิสต์) ในห้องเพลงที่ตั้งด้วย \`/earth setup\` — ไม่ต้องมี prefix\n` +
    `ไม่มีเพลงเล่นอยู่ = เล่นทันที, มีเพลงเล่นอยู่ = ต่อคิว (ต้องอยู่ voice channel เดียวกับเอิร์ธ)\n` +
    `ควบคุมได้ด้วยปุ่มและเมนูคิวใต้ตัวเล่น${embedChannel ? ` (อยู่ในห้อง <#${embedChannel}>)` : ""}\n\n` +
    `**📋 คำสั่ง (slash)**\n` +
    `\`/earth help\` — โชว์ help นี้\n` +
    `\`/earth join [channel-id]\` — เอิร์ธเข้า voice channel\n` +
    `   • ใน guild: ไม่ต้องใส่ id (ตามคนสั่ง)  • ใน DM: ต้องใส่ \`channel-id\`\n` +
    `\`/earth leave\` — ออกจากห้อง (หยุดเพลงด้วย)\n` +
    `\`/earth stop\` — หยุดเพลง (ยังอยู่ในห้อง)\n` +
    `\`/earth status\` — ดูห้องเสียง, เพลงที่เล่นอยู่, คิว\n` +
    `\`/earth stay [hours]\` — ไม่ auto-leave (สูงสุด ${STAY_MAX_HOURS} ชม.)\n` +
    `\`/earth unstay\` — กลับมา auto-leave ตามปกติ\n` +
    `\`/earth setup [channel-id]\` — ตั้งห้องเพลง: พิมพ์ชื่อเพลงในห้องนั้นได้เลย + ตัวเล่นอยู่ห้องนั้น\n` +
    `\`/earth unsetup\` — ยกเลิกห้องเพลง\n\n` +
    `**⚙️ ค่า auto:**\n` +
    `• ออกทันทีเมื่อในห้องไม่เหลือคนจริง ๆ (ไม่นับบอท) — ยกเว้นเปิด \`/earth stay\`\n` +
    `• auto-leave ถ้าอยู่คนเดียวเกิน ${Math.floor(AUTO_LEAVE_ALONE_MS / 60000)} นาที\n`;

  await interaction.reply({ content: help, flags: MessageFlags.Ephemeral });
}

async function handleJoin(interaction: ChatInputCommandInteraction, isOwner: boolean) {
  const explicitChannelId = interaction.options.getString("channel-id");
  let voiceChannel: VoiceBasedChannel | null = null;
  let guildId: string | null = null;

  // Non-owners: only "join the voice channel I am in", inside a server the bot is in.
  // A channel-id (or a DM) would let anyone pull Earth into a channel they can't even see.
  if (!isOwner) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        content: "ใช้ได้เฉพาะในเซิร์ฟเวอร์ครับ — เข้า voice channel แล้วพิมพ์ `/earth join`",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (explicitChannelId) {
      await interaction.reply({
        content: "เข้า voice channel ที่ต้องการแล้วพิมพ์ `/earth join` เฉยๆ ครับ (ไม่ต้องใส่ channel-id)",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  if (explicitChannelId) {
    // DM path, or a guild user overriding their current voice channel
    try {
      const ch = await client.channels.fetch(explicitChannelId);
      if (!ch || !ch.isVoiceBased() || !("guildId" in ch) || !ch.guildId) {
        await interaction.reply({
          content: `\`${explicitChannelId}\` ไม่ใช่ voice channel ครับ`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      voiceChannel = ch as VoiceBasedChannel;
      guildId = ch.guildId;
    } catch (e: any) {
      await interaction.reply({
        content: `fetch channel ล้มเหลว: ${e?.message ?? e}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } else if (interaction.guildId) {
    guildId = interaction.guildId;
    const member = interaction.member as GuildMember | null;
    voiceChannel = member?.voice.channel ?? null;
    if (!voiceChannel) {
      await interaction.reply({
        content: "ต้องอยู่ใน voice channel ก่อนครับ`",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } else {
    await interaction.reply({
      content:
        "ใน DM ต้องใส่ `channel-id` ครับ — เช่น `/earth join channel-id:123456789012345678`",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const currentId = music.channelId(guildId);
  if (currentId) {
    await interaction.reply({
      content: `เอิร์ธอยู่ใน <#${currentId}> อยู่แล้วครับ\nใช้ \`/earth leave\` ก่อนถ้าจะย้าย`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const problem = await ensureJoined(guildId, voiceChannel.id);
  if (problem) {
    await interaction.editReply(problem);
    return;
  }
  await interaction.editReply(
    `เอิร์ธเข้า **${voiceChannel.name}** แล้วครับ\n` +
      `_(auto-leave ถ้าคนเดียวเกิน ${Math.floor(AUTO_LEAVE_ALONE_MS / 60000)} นาที)_`,
  );
  console.log(
    `[earth] joined channel=${voiceChannel.id} (${voiceChannel.name}) in guild=${guildId} via=${interaction.guildId ? "guild" : "DM"}`,
  );
}

async function replyNoGuild(interaction: ChatInputCommandInteraction) {
  await interaction.reply({
    content: "หาไม่เจอว่า guild ไหนครับ — ยังไม่ได้อยู่ในห้องเสียง + ไม่ได้ตั้ง DISCORD_GUILD_ID",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleLeave(interaction: ChatInputCommandInteraction) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);

  const channelId = music.channelId(guildId);
  if (!channelId) {
    await interaction.reply({
      content: "เอิร์ธไม่ได้อยู่ใน voice channel ครับ",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channelName = client.guilds.cache.get(guildId)?.channels.cache.get(channelId)?.name;
  await leaveRoom(guildId);
  await interaction.reply({
    content: `เอิร์ธออกจาก **${channelName ?? "voice channel"}** แล้วครับ`,
    flags: MessageFlags.Ephemeral,
  });
  console.log(`[earth] left guild=${guildId} channel=${channelName ?? channelId}`);
}

async function handleStop(interaction: ChatInputCommandInteraction) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);
  if (!music.channelId(guildId)) {
    await interaction.reply({
      content: "เอิร์ธไม่ได้อยู่ใน voice channel ครับ",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const was = music.nowPlaying(guildId);
  await music.stop(guildId);
  await interaction.reply({
    content: was ? `หยุดเพลง **${was.title}** แล้วครับ` : "ตอนนี้ไม่ได้เล่นเพลงอยู่ครับ",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleStatus(interaction: ChatInputCommandInteraction) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);

  const channelId = music.channelId(guildId);
  if (!channelId) {
    await interaction.reply({
      content: "**สถานะเอิร์ธ**\n- ยังไม่ join voice channel ครับ",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channelName = client.guilds.cache.get(guildId)?.channels.cache.get(channelId)?.name;
  const np = music.nowPlaying(guildId);
  const until = stayUntil.get(guildId) ?? 0;

  await interaction.reply({
    content:
      `**สถานะเอิร์ธ**\n` +
      `- Channel: **${channelName ?? "?"}** (id=${channelId})\n` +
      `- Now playing: ${np ? `${np.title}${np.uri ? ` (${np.uri})` : ""}` : "—"}\n` +
      `- Queue: ${music.getQueue(guildId).length} เพลง\n` +
      `- Stay: ${isStaying(guildId) ? `ON (อีก ${formatDuration(until - Date.now())})` : "OFF"}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleStay(interaction: ChatInputCommandInteraction) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);
  const channelId = music.channelId(guildId);
  if (!channelId) {
    await interaction.reply({
      content: "ต้อง `/earth join` ก่อนถึงจะ `/earth stay` ได้ครับ",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const requested = interaction.options.getNumber("hours") ?? STAY_MAX_HOURS;
  const hours = Math.min(Math.max(requested, 0.1), STAY_MAX_HOURS);
  const ms = Math.floor(hours * 3_600_000);
  stayUntil.set(guildId, Date.now() + ms);
  const until = new Date(Date.now() + ms);
  const hh = String(until.getHours()).padStart(2, "0");
  const mm = String(until.getMinutes()).padStart(2, "0");
  await interaction.reply({
    content:
      `stay ON ใน <#${channelId}> — ${hours} ชม. (อยู่จนถึง ~${hh}:${mm})\n` +
      `_auto-leave-alone ถูกข้าม จนกว่าจะหมดเวลาหรือ \`/earth unstay\`_`,
    flags: MessageFlags.Ephemeral,
  });
  console.log(`[earth] stay ON guild=${guildId} for ${hours}h (until ${until.toISOString()})`);
}

async function handleUnstay(interaction: ChatInputCommandInteraction) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);
  if (!music.channelId(guildId)) {
    await interaction.reply({
      content: "ไม่ได้อยู่ใน voice channel ครับ",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const was = isStaying(guildId);
  stayUntil.delete(guildId);
  checkAloneNow(guildId); // channel already empty? leave now
  await interaction.reply({
    content: was
      ? `stay OFF — auto-leave กลับมาทำงานปกติแล้วนะครับ`
      : `ตอนนี้ไม่ได้อยู่ใน stay mode อยู่แล้วครับ`,
    flags: MessageFlags.Ephemeral,
  });
  console.log(`[earth] stay OFF guild=${guildId} (was=${was})`);
}

// ─── Music room: /earth setup ────────────────────────────────────────────────
async function handleSetup(interaction: ChatInputCommandInteraction) {
  const channelId = interaction.options.getString("channel-id")?.trim() || interaction.channelId;
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch || ch.isDMBased() || !ch.isTextBased()) {
    await interaction.reply({
      content: `\`${channelId}\` ไม่ใช่ text channel ใน server ครับ (ใน DM ต้องใส่ \`channel-id\` ของห้องข้อความ)`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // The bot posts/edits the panel and reads the typed requests → check it can.
  const me = ch.guild.members.me ?? (await ch.guild.members.fetchMe().catch(() => null));
  const perms = me ? ch.permissionsFor(me) : null;
  const missing = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
  ].filter((flag) => !perms?.has(flag));
  if (missing.length > 0) {
    await interaction.reply({
      content:
        `บอทยังขาดสิทธิ์ใน <#${ch.id}> ครับ: ${new PermissionsBitField(missing).toArray().join(", ")}\n` +
        `เพิ่มสิทธิ์แล้วลอง \`/earth setup\` ใหม่`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const canDelete = perms?.has(PermissionFlagsBits.ManageMessages) ?? false;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = ch.guildId;
  await runQueueUi(guildId, async () => {
    await deleteQueueEmbed(guildId); // the old room's embed (if the room moved)
    setupStore.set(guildId, { channelId: ch.id });
    await refreshQueueEmbed(guildId); // post the panel in the new room
  });
  const posted = queueMessages.has(guildId);

  let reply =
    `✅ ตั้งห้องเพลงเป็น <#${ch.id}> แล้วครับ\n` +
    `• พิมพ์ชื่อเพลงในห้องนั้นได้เลย (ไม่ต้องมี prefix) — ต้องอยู่ voice channel เดียวกับเอิร์ธ\n` +
    `• ตัวเล่น/คิวเพลงจะอยู่ในห้องนั้นที่เดียว`;
  if (SETUP_DELETE_MESSAGES && !canDelete) {
    reply +=
      `\n⚠️ บอทไม่มีสิทธิ์ Manage Messages — ข้อความที่พิมพ์ขอเพลงจะไม่ถูกลบ ` +
      `(ตัวเล่นจะค่อย ๆ เลื่อนขึ้น ใช้ \`/earth setup\` ใหม่เพื่อดึงกลับลงมาได้)`;
  }
  if (!posted) reply += `\n⚠️ ส่ง embed ลงห้องไม่สำเร็จ — ดู log ของบอท`;
  await interaction.editReply(reply);
  console.log(`[earth] setup: guild=${guildId} music room=${ch.id}`);
}

async function handleUnsetup(interaction: ChatInputCommandInteraction) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);
  const entry = setupStore.get(guildId);
  if (!entry) {
    await interaction.reply({
      content: "ยังไม่ได้ตั้งห้องเพลงครับ (ใช้ `/earth setup`)",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await runQueueUi(guildId, async () => {
    await deleteQueueEmbed(guildId);
    setupStore.delete(guildId);
    await refreshQueueEmbed(guildId); // back to the normal embed channel (only if something is playing)
  });
  await interaction.editReply(`ยกเลิกห้องเพลง <#${entry.channelId}> แล้วครับ`);
  console.log(`[earth] unsetup: guild=${guildId} (was ${entry.channelId})`);
}

// Typed song requests in the music room: the whole message is the song name.
client.on(Events.MessageCreate, (message) => {
  handleSetupMessage(message).catch((e: any) =>
    console.warn("[earth] music-room message failed:", e?.message ?? e),
  );
});

async function handleSetupMessage(message: Message): Promise<void> {
  if (message.author.bot || !message.inGuild()) return;
  const guildId = message.guildId;
  if (setupStore.get(guildId)?.channelId !== message.channelId) return;

  const query = parseSongRequest(message.content);
  if (!query) return;

  // One request at a time per server: two people typing together must not both see
  // "nothing is playing" and fight over the same slot.
  await serial(setupChains, guildId, "music-room request failed", () =>
    processSetupRequest(message, guildId, query),
  );
}

async function processSetupRequest(message: Message<true>, guildId: string, query: string) {
  const reject = async (text: string) => {
    await tempReply(message, text);
    await removeRequest(message);
  };

  const voiceChannel = message.member?.voice.channel ?? null;
  if (!voiceChannel) return reject("เข้า voice channel ก่อนนะครับ แล้วพิมพ์ชื่อเพลงใหม่");

  const roomId = music.channelId(guildId);
  if (roomId) {
    if (voiceChannel.id !== roomId) {
      return reject(`ต้องอยู่ voice channel เดียวกับเอิร์ธ (<#${roomId}>) ครับ`);
    }
  } else if (!OWNER_IDS.has(message.author.id)) {
    // Earth isn't in any room yet: only owners may call it in (same rule as /earth join).
    // (music.enqueue below joins the requester's voice channel by itself.)
    return reject("เอิร์ธยังไม่ได้เข้าห้องเสียง — ให้เจ้าของเรียกเอิร์ธเข้าห้องก่อนนะครับ");
  }

  console.log(
    `[earth] 💬 music room request from user=${message.author.id}: "${query}"`,
  );
  let result: Awaited<ReturnType<typeof music.enqueue>>;
  try {
    // nothing playing → plays now; otherwise it goes to the end of the queue
    result = await music.enqueue(guildId, voiceChannel.id, query, message.author.id);
  } catch (e: any) {
    console.warn(`[earth] music room enqueue failed for "${query}":`, e?.message ?? e);
    return reject(`เล่นไม่ได้: ${e?.message ?? "unknown"}`);
  }
  // null = not found / queue full.
  if (!result) {
    const shown = query.length > 60 ? `${query.slice(0, 59)}…` : query;
    return reject(`หาเพลง "${shown}" ไม่เจอ หรือคิวเต็มครับ`);
  }
  checkAloneNow(guildId); // Earth may just have joined a channel the requester already left
  if (result.playlist) {
    const pl = result.playlist;
    const name = pl.name ? ` "${pl.name.length > 40 ? `${pl.name.slice(0, 39)}…` : pl.name}"` : "";
    let text = `เพิ่มเพลย์ลิสต์${name} ${pl.added} เพลงแล้วครับ`;
    if (pl.dropped > 0) text += ` (คิวเต็ม เหลืออีก ${pl.dropped} เพลงที่ไม่ได้เพิ่ม)`;
    if (pl.skipped > 0) text += ` (ข้าม ${pl.skipped} คลิปที่เล่นไม่ได้หรือยาวเกินกำหนด)`;
    await tempReply(message, text);
  }
  await removeRequest(message);
}

/** Short-lived reply in the music room (the request message is removed, so mention the author). */
async function tempReply(message: Message, text: string, ms = 8000): Promise<void> {
  if (!message.channel.isSendable()) return;
  const sent = await message.channel
    .send({
      content: `<@${message.author.id}> ${text}`,
      allowedMentions: { users: [message.author.id] },
    })
    .catch(() => null);
  if (sent) setTimeout(() => void sent.delete().catch(() => {}), ms);
}

async function removeRequest(message: Message): Promise<void> {
  if (SETUP_DELETE_MESSAGES) await message.delete().catch(() => {});
}

// If the music room is deleted, forget it (the embed falls back to QUEUE_CHANNEL_ID).
client.on(Events.ChannelDelete, (channel) => {
  const gid = setupStore.guildForChannel(channel.id);
  if (!gid) return;
  console.log(`[earth] music room ${channel.id} was deleted — setup removed for guild=${gid}`);
  queueMessages.delete(gid);
  setupStore.delete(gid);
});

/** Stop the music, clear the queue and leave the voice channel. */
async function leaveRoom(guildId: string): Promise<void> {
  const timer = aloneTimers.get(guildId);
  if (timer) clearTimeout(timer);
  aloneTimers.delete(guildId);
  aloneSince.delete(guildId);
  stayUntil.delete(guildId);
  await music.leave(guildId);
}

// === Instant leave when no human is left in the channel ===
const aloneTimers = new Map<string, ReturnType<typeof setTimeout>>(); // guildId → pending leave

function humansInChannel(guildId: string, channelId: string): number {
  const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
  if (!channel || !channel.isVoiceBased()) return -1;
  return (channel as VoiceBasedChannel).members.filter((m) => !m.user.bot).size;
}

function checkAloneNow(guildId: string): void {
  const pending = aloneTimers.get(guildId);

  const cancel = () => {
    if (pending) {
      clearTimeout(pending);
      aloneTimers.delete(guildId);
    }
  };

  const channelId = music.channelId(guildId);
  if (!channelId) return cancel();
  const humans = humansInChannel(guildId, channelId);
  // Someone is (back) in the channel, or channel unknown → don't leave.
  if (humans !== 0) return cancel();
  // /earth stay keeps Earth in the room even when empty.
  if (isStaying(guildId)) return cancel();
  if (pending) return; // countdown already running

  aloneTimers.set(
    guildId,
    setTimeout(() => {
      aloneTimers.delete(guildId);
      const cid = music.channelId(guildId);
      if (!cid) return;
      // Re-check: someone may have joined during the grace period.
      if (humansInChannel(guildId, cid) !== 0 || isStaying(guildId)) return;
      autoLeave(guildId, "no humans left in voice channel").catch((e) =>
        console.warn("[earth] auto-leave (no humans) failed:", e),
      );
    }, Math.max(0, ALONE_LEAVE_DELAY_MS)),
  );
}

client.on(Events.VoiceStateUpdate, (oldState: VoiceState, newState: VoiceState) => {
  const gid = oldState.guild.id;

  // The bot itself: disconnected by someone / channel deleted → clean up; moved → follow.
  if (newState.id === client.user?.id) {
    if (!newState.channelId) {
      if (music.channelId(gid)) {
        console.log(`[earth] bot was disconnected from voice in guild=${gid} — cleaning up`);
        leaveRoom(gid).catch((e) => console.warn("[earth] cleanup after disconnect failed:", e));
      }
      return;
    }
    music.noteMoved(gid, newState.channelId);
  }

  // A human left / switched channel, or the bot itself was moved.
  if (!music.channelId(gid)) return;
  checkAloneNow(gid);
});

// === Auto-leave (alone / stay expiry) ===
async function autoLeave(guildId: string, reason: string): Promise<void> {
  const channelId = music.channelId(guildId);
  if (!channelId) return;
  const name = client.guilds.cache.get(guildId)?.channels.cache.get(channelId)?.name ?? channelId;
  console.log(`[earth] auto-leaving ${name} (${reason})`);
  await leaveRoom(guildId);
  console.log(`[earth] auto-left ${name}`);
}

function startAutoLeaveWatcher() {
  if (AUTO_LEAVE_ALONE_MS <= 0) {
    console.log("[earth] auto-leave-when-alone disabled");
    return;
  }
  setInterval(async () => {
    for (const guildId of client.guilds.cache.keys()) {
      const channelId = music.channelId(guildId);
      if (!channelId) {
        aloneSince.delete(guildId);
        continue;
      }
      const humans = humansInChannel(guildId, channelId);
      if (humans < 0) continue; // channel not in cache
      if (humans === 0) {
        // /earth stay overrides alone auto-leave.
        if (isStaying(guildId)) {
          aloneSince.delete(guildId);
          continue;
        }
        if (!aloneSince.has(guildId)) {
          aloneSince.set(guildId, Date.now());
          console.log(`[earth] alone in ${channelId} (guild ${guildId}) — countdown started`);
        } else if (Date.now() - aloneSince.get(guildId)! > AUTO_LEAVE_ALONE_MS) {
          aloneSince.delete(guildId);
          await autoLeave(guildId, `alone > ${AUTO_LEAVE_ALONE_MS}ms`).catch((e) =>
            console.warn("[earth] auto-leave (alone) failed:", e),
          );
        }
      } else {
        aloneSince.delete(guildId);
      }
    }
  }, 30_000);
}

// /earth stay is time-limited: when the window ends, go back to normal auto-leave rules
// (and leave right away if the channel is empty by then).
function startStayCapWatcher() {
  setInterval(() => {
    const now = Date.now();
    for (const [gid, until] of [...stayUntil]) {
      if (until > 0 && now >= until) {
        stayUntil.delete(gid);
        console.log(`[earth] stay expired in guild=${gid}`);
        checkAloneNow(gid);
      }
    }
  }, 60_000);
}

// The card is a still picture, so its elapsed / total time only moves when the panel is
// re-rendered. While a song is playing, refresh the panel every CARD_TICK_MS so the time
// and bar follow the real position. Paused / streams / no panel → nothing to update.
const CARD_TICK_MS = 10_000;
function startCardTicker() {
  setInterval(() => {
    for (const gid of client.guilds.cache.keys()) {
      const np = music.nowPlaying(gid);
      if (!np || np.isStream || !(np.lengthMs > 0) || music.isPaused(gid)) continue;
      if (!queueMessages.has(gid)) continue; // don't re-create a panel someone deleted
      scheduleQueueRefresh(gid);
    }
  }, CARD_TICK_MS);
}

function startMemoryReporter() {
  if (MEMORY_REPORT_MS <= 0) {
    console.log("[earth] memory reporter disabled");
    return;
  }
  setInterval(() => {
    const m = process.memoryUsage();
    const fmt = (b: number) => `${(b / 1024 / 1024).toFixed(1)}MB`;
    console.log(
      `[earth] mem rss=${fmt(m.rss)} heap=${fmt(m.heapUsed)}/${fmt(m.heapTotal)} ext=${fmt(m.external)}`,
    );
  }, MEMORY_REPORT_MS);
}

client.on(Events.Error, (e) => {
  console.error("[earth] client error:", e);
});

process.on("unhandledRejection", (e) => {
  console.error("[earth] unhandled rejection:", e);
});
process.on("uncaughtException", (e) => {
  console.error("[earth] uncaught exception:", e);
});

// Graceful shutdown: leave every voice channel (stops the music).
let shuttingDown = false;
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[earth] received ${sig}, disconnecting...`);
    for (const gid of client.guilds.cache.keys()) {
      if (!music.channelId(gid)) continue;
      try {
        await leaveRoom(gid);
        console.log(`[earth] disconnected guild=${gid}`);
      } catch (e) {
        console.warn(`[earth] disconnect failed for guild=${gid}:`, e);
      }
    }
    for (const gid of [...queueMessages.keys()]) {
      // A music room keeps its panel (flipped to idle); the normal panel is deleted.
      if (setupStore.get(gid)) await refreshQueueEmbed(gid).catch(() => {});
      else await deleteQueueEmbed(gid);
    }
    music.shutdown();
    musicHistory?.close(); // flushes the SQLite write-ahead log into the .db file
    client.destroy();
    process.exit(0);
  });
}

console.log("[earth] starting...");
await client.login(token);
