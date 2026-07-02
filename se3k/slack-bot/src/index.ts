import { App, LogLevel } from '@slack/bolt';
import dotenv from 'dotenv';
import { mcp } from './mcpClient';

dotenv.config();

// The bot's stdout is a normal terminal (unlike the MCP server), so console.log
// is fine here. One prefixed helper keeps the terminal output scannable.
const dbg = (...args: unknown[]) => console.log('[se3k:bot]', ...args);

const { SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET } = process.env;

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN || !SLACK_SIGNING_SECRET) {
  throw new Error(
    'Missing one or more required env vars: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET',
  );
}

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

// ---- Tunables --------------------------------------------------------------
const BATCH_SIZE = 12; // flush a channel's buffer at this many lines…
const FLUSH_DEBOUNCE_MS = 20_000; // …or after this much quiet, whichever first
const BACKFILL_LIMIT = 50; // messages pulled when the bot joins a channel
const BACKFILL_MAX = 200;

// ---- In-memory state (hackathon shortcut: fine to lose on restart) ---------
let botUserId: string | undefined;
let teamUrl: string | undefined; // e.g. https://myteam.slack.com/ — for permalinks
type BufEntry = { name: string; userId: string; text: string; ts?: string; permalink?: string };
const buffers = new Map<string, BufEntry[]>(); // channelId -> buffered messages
const flushTimers = new Map<string, NodeJS.Timeout>(); // channelId -> debounce timer
const channelNames = new Map<string, string>(); // channelId -> #name (cache)
const userNames = new Map<string, string>(); // userId -> display name (cache)
const backfilledChannels = new Set<string>(); // channels already backfilled this session
const processedTs = new Set<string>(); // `${channelId}:${ts}` — never re-ingest a message

// Resolve a Slack user id to a display name so the graph reads "Priya Nair",
// not "U08ABC". Cached; falls back to the id on error.
async function resolveUserName(userId: string): Promise<string> {
  const cached = userNames.get(userId);
  if (cached) return cached;
  try {
    const res = await app.client.users.info({ user: userId });
    const u = res.user as { profile?: { real_name?: string }; real_name?: string; name?: string };
    const name = u?.profile?.real_name || u?.real_name || u?.name || userId;
    userNames.set(userId, name);
    dbg(`resolved user ${userId} → "${name}"`);
    return name;
  } catch {
    return userId;
  }
}

// Resolve a channel id to its #name (cached; falls back to the id).
async function resolveChannelName(channelId: string): Promise<string> {
  const cached = channelNames.get(channelId);
  if (cached) return cached;
  try {
    const res = await app.client.conversations.info({ channel: channelId });
    const name = (res.channel as { name?: string })?.name || channelId;
    channelNames.set(channelId, name);
    return name;
  } catch {
    return channelId;
  }
}

// Build a direct link to the exact Slack message (the proof behind a citation).
function permalinkFor(channelId: string, ts?: string): string | undefined {
  if (!teamUrl || !ts) return undefined;
  return `${teamUrl}archives/${channelId}/p${ts.replace('.', '')}`;
}

// Drop lines with no expertise signal before they ever hit the LLM.
function isNoise(text: string, userId?: string): boolean {
  if (!text) return true;
  if (userId && botUserId && userId === botUserId) return true; // our own replies
  const t = text.trim();
  if (t.length < 2) return true;
  if (/^\+\d+$/.test(t)) return true; // "+1"
  if (!/[a-z0-9]/i.test(t.replace(/:[a-z0-9_+-]+:/gi, ''))) return true; // emoji/reaction only
  return false;
}

// (Re)arm the per-channel inactivity timer that flushes the buffer.
function armFlush(channelId: string) {
  const prev = flushTimers.get(channelId);
  if (prev) clearTimeout(prev);
  flushTimers.set(channelId, setTimeout(() => void flush(channelId), FLUSH_DEBOUNCE_MS));
}

// Flush a channel's buffered messages to the MCP extraction tool. Each line is
// tagged [mN] and paired with a refs map (real ts + permalink) so extracted
// citations can link back to the exact message.
async function flush(channelId: string) {
  const timer = flushTimers.get(channelId);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(channelId);
  }
  const entries = buffers.get(channelId);
  if (!entries || entries.length === 0) return;
  buffers.set(channelId, []);
  const channel = await resolveChannelName(channelId);
  const refs: Record<string, { ts?: string; permalink?: string; text?: string }> = {};
  const authors: Record<string, string> = {}; // display name → Slack id, for @-mentions
  const lines = entries.map((e, i) => {
    const tag = `m${i + 1}`;
    refs[tag] = { ts: e.ts, permalink: e.permalink, text: e.text };
    authors[e.name] = e.userId;
    return `[${tag}] ${e.name}: ${e.text}`;
  });
  dbg(`flushing ${entries.length} msgs from #${channel} → MCP ingest_messages`);
  try {
    const res = await mcp.ingest(lines.join('\n'), `#${channel}`, channelId, refs, authors);
    dbg(`📥 ingested ${entries.length} msgs from #${channel}: ${res}`);
  } catch (err) {
    console.error('[se3k:bot] ingest failed (re-queuing):', err);
    buffers.set(channelId, [...entries, ...(buffers.get(channelId) || [])]);
  }
}

// Buffer one message (deduped by ts), then flush by size or arm the timer.
async function bufferMessage(channelId: string, userId: string, text: string, ts?: string) {
  if (ts) {
    const key = `${channelId}:${ts}`;
    if (processedTs.has(key)) return; // dedupe across live + backfill + re-backfill
    processedTs.add(key);
  }
  const name = await resolveUserName(userId);
  const buf = buffers.get(channelId) || [];
  buf.push({ name, userId, text: text.replace(/\s+/g, ' ').trim(), ts, permalink: permalinkFor(channelId, ts) });
  buffers.set(channelId, buf);
  dbg(`buffered [${buf.length}] #${channelId} ${name}: ${text.slice(0, 60)}`);
  if (buf.length >= BATCH_SIZE) await flush(channelId);
  else armFlush(channelId);
}

// Pull recent channel history (the "backfill on join" behavior).
async function backfill(channelId: string, limit = BACKFILL_LIMIT): Promise<number> {
  dbg(`backfill: pulling up to ${limit} msgs from ${channelId}`);
  try {
    const res = await app.client.conversations.history({
      channel: channelId,
      limit: Math.min(limit, BACKFILL_MAX),
    });
    const msgs = (res.messages || []) as Array<{
      subtype?: string;
      user?: string;
      text?: string;
      ts?: string;
    }>;
    let n = 0;
    for (const m of msgs.reverse()) {
      // oldest first
      if (m.subtype || !m.user || !m.text || isNoise(m.text, m.user)) continue;
      await bufferMessage(channelId, m.user, m.text, m.ts);
      n++;
    }
    await flush(channelId);
    dbg(`🕓 backfilled ${n} msgs from ${channelId}`);
    return n;
  } catch (err) {
    console.error('[se3k:bot] backfill failed:', err);
    return 0;
  }
}

// Route a question through the MCP ask_graph tool.
async function answer(question: string): Promise<string> {
  if (!question.trim()) {
    return 'Ask me *who actually knows about X* (expertise routing) or *why we decided X* (decision provenance). Example: `/ask-graph who do I talk to about the checkout timeouts?`';
  }
  dbg(`answer: "${question}"`);
  try {
    const reply = await mcp.ask(question);
    dbg('answer: got reply from MCP');
    return reply;
  } catch (err) {
    console.error('[se3k:bot] ask failed:', err);
    return "Sorry — I couldn't reach the knowledge graph just now.";
  }
}

// ---- Events ----------------------------------------------------------------

app.message(async ({ message }) => {
  const m = message as {
    subtype?: string;
    user?: string;
    text?: string;
    channel?: string;
    ts?: string;
  };
  if (m.subtype || !m.user || !m.text || !m.channel) return;
  if (botUserId && m.text.includes(`<@${botUserId}>`)) return; // question to the bot, not content
  if (isNoise(m.text, m.user)) return;

  // First time we see a channel, lazily backfill its history (covers channels
  // the bot was already in before member_joined_channel was subscribed).
  if (!backfilledChannels.has(m.channel)) {
    backfilledChannels.add(m.channel);
    dbg(`first message seen in ${m.channel} → lazy backfill`);
    void backfill(m.channel);
  }
  await bufferMessage(m.channel, m.user, m.text, m.ts);
});

app.event('member_joined_channel', async ({ event }) => {
  const e = event as { user?: string; channel?: string };
  if (!e.channel || e.user !== botUserId) return; // only react to the bot's own join
  if (backfilledChannels.has(e.channel)) return;
  dbg(`bot joined ${e.channel} → backfilling`);
  backfilledChannels.add(e.channel);
  await backfill(e.channel);
});

app.command('/ask-graph', async ({ command, ack, respond }) => {
  await ack();
  dbg(`/ask-graph from ${command.user_id}: "${command.text}"`);
  const reply = await answer(command.text);
  // Slack hides the slash-command invocation, so echo the question back — the
  // channel only sees our reply otherwise.
  const question = command.text.trim();
  const text = question ? `> <@${command.user_id}> asked: *${question}*\n\n${reply}` : reply;
  await respond({ text, response_type: 'in_channel' });
});

app.command('/se3k-ingest', async ({ command, ack, respond }) => {
  await ack();
  dbg(`/se3k-ingest in ${command.channel_id}`);
  await flush(command.channel_id);
  await respond({
    text: '✅ Flushed pending messages into the knowledge graph.',
    response_type: 'ephemeral',
  });
});

app.command('/se3k-backfill', async ({ command, ack, respond }) => {
  await ack();
  const count = parseInt(command.text.trim(), 10) || BACKFILL_LIMIT;
  dbg(`/se3k-backfill ${count} in ${command.channel_id}`);
  backfilledChannels.add(command.channel_id);
  const n = await backfill(command.channel_id, count);
  await respond({
    text: `🕓 Backfilled ${n} messages from this channel into the graph.`,
    response_type: 'ephemeral',
  });
});

app.event('app_mention', async ({ event, say }) => {
  const e = event as { text?: string; ts?: string; thread_ts?: string };
  // Strip only OUR mention — keep any other <@user> mentions so the brain can
  // answer person-scoped questions like "what is @Rahul working on?".
  const raw = e.text || '';
  const text = (
    botUserId ? raw.split(`<@${botUserId}>`).join(' ') : raw.replace(/^\s*<@[^>]+>/, '')
  )
    .replace(/\s+/g, ' ')
    .trim();
  dbg(`app_mention: "${text}"`);
  const reply = await answer(text);
  await say({ text: reply, thread_ts: e.thread_ts || e.ts });
});

(async () => {
  await app.start();
  try {
    const auth = await app.client.auth.test();
    botUserId = auth.user_id as string;
    teamUrl = auth.url as string; // e.g. https://myteam.slack.com/
    dbg(`authed as ${botUserId} on ${teamUrl}`);
  } catch (err) {
    console.error('[se3k:bot] auth.test failed (self-join detection disabled):', err);
  }

  // Patch Slack user ids onto graph people by name, so even seeded/older nodes
  // become @-mentionable in answers.
  try {
    const res = await app.client.users.list({ limit: 500 });
    const ids: Record<string, string> = {};
    for (const u of (res.members || []) as Array<{
      id?: string;
      real_name?: string;
      name?: string;
      is_bot?: boolean;
      deleted?: boolean;
      profile?: { real_name?: string };
    }>) {
      if (u.is_bot || u.deleted || !u.id) continue;
      const name = u.profile?.real_name || u.real_name || u.name;
      if (name) ids[name] = u.id;
      userNames.set(u.id, name || u.id); // warm the name cache too
    }
    const out = await mcp.setPersonIds(ids);
    dbg(`patched person ids from workspace: ${out}`);
  } catch (err) {
    console.error('[se3k:bot] users.list / setPersonIds failed:', err);
  }

  dbg('⚡️ SE3K bot is running in Socket Mode');
})();
