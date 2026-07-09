import 'dotenv/config';
import http from 'node:http';
import { App, LogLevel } from '@slack/bolt';
import type { types as slack } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { mcp, AskResult } from './mcpClient';

interface BoltContext {
  teamId?: string;
  botUserId?: string;
}
type Say = (msg: {
  text: string;
  blocks?: unknown[];
  thread_ts?: string;
}) => Promise<unknown>;

const dbg = (...args: unknown[]) => console.log('[se3k:bot]', ...args);

const { SLACK_APP_TOKEN, SLACK_SIGNING_SECRET } = process.env;

const REQUIRED_ENV = ['SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET'] as const;
const RECOMMENDED_ENV = ['MCP_SERVER_URL', 'INTERNAL_API_SECRET'] as const;

const missingRequired = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingRequired.length > 0) {
  throw new Error(`Missing required env var(s): ${missingRequired.join(', ')}`);
}
const missingRecommended = RECOMMENDED_ENV.filter((k) => !process.env[k]);
if (missingRecommended.length > 0) {
  console.warn(
    `[se3k:bot] ⚠️  missing recommended env var(s): ${missingRecommended.join(', ')} — ` +
      'falling back to defaults / degraded behavior',
  );
}

const MCP_HTTP_BASE = (
  process.env.MCP_SERVER_URL || 'http://localhost:4000'
).replace(/\/$/, '');
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

// ---- Multi-workspace install lookup ----------------------------------------
// Installations (bot token per team) live in mcp-server's Postgres, written
// there by web's OAuth callback. We resolve per-team here via `authorize`
// instead of a single static SLACK_BOT_TOKEN — this is what lets one running
// bot process serve every workspace that installs the app (Socket Mode +
// `authorize` is a supported multi-team Bolt pattern; no ExpressReceiver
// needed since `web` owns the actual OAuth UI).
interface Installation {
  teamId: string;
  teamName: string | null;
  botToken: string;
  botUserId: string | null;
}

const installationCache = new Map<
  string,
  { install: Installation; fetchedAt: number }
>();
const INSTALL_CACHE_TTL_MS = 60_000;

async function fetchInstallation(teamId: string): Promise<Installation> {
  const cached = installationCache.get(teamId);
  if (cached && Date.now() - cached.fetchedAt < INSTALL_CACHE_TTL_MS) {
    return cached.install;
  }
  const res = await fetch(
    `${MCP_HTTP_BASE}/internal/installations/${encodeURIComponent(teamId)}`,
    {
      headers: INTERNAL_API_SECRET
        ? { 'x-internal-secret': INTERNAL_API_SECRET }
        : undefined,
    },
  );
  if (!res.ok) {
    throw new Error(
      `no installation found for team ${teamId} (HTTP ${res.status})`,
    );
  }
  const install = (await res.json()) as Installation;
  installationCache.set(teamId, { install, fetchedAt: Date.now() });
  return install;
}

const app = new App({
  appToken: SLACK_APP_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  socketMode: true,
  logLevel: LogLevel.INFO,
  authorize: async ({ teamId }: { teamId?: string }) => {
    if (!teamId) throw new Error('authorize called without a teamId');
    const install = await fetchInstallation(teamId);
    return {
      botToken: install.botToken,
      botUserId: install.botUserId || undefined,
      teamId,
    };
  },
});

// ---- Tunables --------------------------------------------------------------
const BATCH_SIZE = 12;
const FLUSH_DEBOUNCE_MS = 20_000;
const BACKFILL_LIMIT = 50;
const BACKFILL_MAX = 200;

type BufEntry = {
  name: string;
  userId: string;
  text: string;
  ts?: string;
  permalink?: string;
};

// Per-workspace state — everything used to be a bare channelId/userId-keyed
// map, which would collide the moment a second team installed the bot.
interface TeamState {
  teamUrl?: string; // e.g. https://myteam.slack.com/ — for permalinks
  bootstrapped: boolean;
  buffers: Map<string, BufEntry[]>; // channelId -> buffered messages
  flushTimers: Map<string, NodeJS.Timeout>; // channelId -> debounce timer
  channelNames: Map<string, string>; // channelId -> #name (cache)
  userNames: Map<string, string>; // userId -> display name (cache)
  backfilledChannels: Set<string>; // channels already backfilled this session
  processedTs: Set<string>; // `${channelId}:${ts}` — fast-path dedupe only; the
  // authoritative check now lives server-side (mcp-server's processed_messages
  // table), since this in-memory set is wiped on restart and not shared with
  // a separate backfill job.
}

const teams = new Map<string, TeamState>();

function stateFor(teamId: string): TeamState {
  let s = teams.get(teamId);
  if (!s) {
    s = {
      bootstrapped: false,
      buffers: new Map(),
      flushTimers: new Map(),
      channelNames: new Map(),
      userNames: new Map(),
      backfilledChannels: new Set(),
      processedTs: new Set(),
    };
    teams.set(teamId, s);
  }
  return s;
}

// One-time-per-team setup: resolve the workspace URL (for permalinks) and
// warm Person nodes with real Slack user ids. Runs lazily on the first event
// we see from a team, since there's no single global app.start() bootstrap
// anymore.
async function ensureBootstrapped(
  client: WebClient,
  teamId: string,
): Promise<void> {
  const state = stateFor(teamId);
  if (state.bootstrapped) return;
  state.bootstrapped = true;

  try {
    const auth = await client.auth.test();
    state.teamUrl = auth.url as string;
    dbg(`🔐 bootstrapped team ${teamId} @ ${state.teamUrl}`);
  } catch (err) {
    console.error('[se3k:bot] auth.test failed for team', teamId, err);
  }

  try {
    const res = await client.users.list({ limit: 500 });
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
      state.userNames.set(u.id, name || u.id);
    }
    const out = await mcp.setPersonIds(teamId, ids);
    dbg(`👥 team ${teamId} · ${out}`);
  } catch (err) {
    console.error(
      '[se3k:bot] users.list / setPersonIds failed for team',
      teamId,
      err,
    );
  }
}

// Resolve a Slack user id to a display name so the graph reads "Priya Nair",
// not "U08ABC". Cached per team; falls back to the id on error.
async function resolveUserName(
  client: WebClient,
  teamId: string,
  userId: string,
): Promise<string> {
  const state = stateFor(teamId);
  const cached = state.userNames.get(userId);
  if (cached) return cached;
  try {
    const res = await client.users.info({ user: userId });
    const u = res.user as {
      profile?: { real_name?: string };
      real_name?: string;
      name?: string;
    };
    const name = u?.profile?.real_name || u?.real_name || u?.name || userId;
    state.userNames.set(userId, name);
    dbg(`resolved user ${userId} → "${name}"`);
    return name;
  } catch {
    return userId;
  }
}

// Resolve a channel id to its #name (cached per team; falls back to the id).
async function resolveChannelName(
  client: WebClient,
  teamId: string,
  channelId: string,
): Promise<string> {
  const state = stateFor(teamId);
  const cached = state.channelNames.get(channelId);
  if (cached) return cached;
  try {
    const res = await client.conversations.info({ channel: channelId });
    const name = (res.channel as { name?: string })?.name || channelId;
    state.channelNames.set(channelId, name);
    return name;
  } catch {
    return channelId;
  }
}

// Build a direct link to the exact Slack message (the proof behind a citation).
function permalinkFor(
  teamId: string,
  channelId: string,
  ts?: string,
): string | undefined {
  const teamUrl = stateFor(teamId).teamUrl;
  if (!teamUrl || !ts) return undefined;
  return `${teamUrl}archives/${channelId}/p${ts.replace('.', '')}`;
}

// Bare key-gated URL to this workspace's graph in the web dashboard (or null if
// no DASHBOARD_KEY). Used for the Block Kit "View live graph" button.
function dashboardUrl(teamId: string): string | null {
  const key = process.env.DASHBOARD_KEY;
  if (!key) return null;
  const base = (process.env.GATEWAY_URL || 'http://localhost:3000').replace(
    /\/$/,
    '',
  );
  return `${base}/g/${key}?team=${encodeURIComponent(teamId)}`;
}

// Key-gated link to this workspace's graph in the web dashboard.
function dashboardLink(teamId: string): string {
  const url = dashboardUrl(teamId);
  return url ? `\n🔗 View the live graph: ${url}` : '';
}

// Build a Block Kit message for an answer: optional question echo (ask-graph),
// the answer in a section, then sources as small grey context blocks. Always
// returns a top-level `text` fallback for notifications + screen readers.
function buildAnswerBlocks(opts: {
  answerText: string;
  sources: string[];
  askerId?: string;
  question?: string;
}): { blocks: unknown[]; text: string } {
  const { answerText, sources, askerId, question } = opts;
  const blocks: unknown[] = [];

  if (askerId && question) {
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `<@${askerId}> asked: *${question}*` },
      ],
    });
  }

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: answerText },
  });

  if (sources.length) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '📎 *Sources*' }],
    });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: sources.join('\n') }],
    });
  }

  return { blocks, text: answerText };
}

// Drop lines with no expertise signal before they ever hit the LLM.
function isNoise(
  text: string,
  userId: string | undefined,
  botUserId: string | undefined,
): boolean {
  if (!text) return true;
  if (userId && botUserId && userId === botUserId) return true; // our own replies
  const t = text.trim();
  if (t.length < 2) return true;
  if (/^\+\d+$/.test(t)) return true; // "+1"
  if (!/[a-z0-9]/i.test(t.replace(/:[a-z0-9_+-]+:/gi, ''))) return true; // emoji/reaction only
  return false;
}

// (Re)arm the per-channel inactivity timer that flushes the buffer.
function armFlush(client: WebClient, teamId: string, channelId: string) {
  const state = stateFor(teamId);
  const prev = state.flushTimers.get(channelId);
  if (prev) clearTimeout(prev);
  state.flushTimers.set(
    channelId,
    setTimeout(() => void flush(client, teamId, channelId), FLUSH_DEBOUNCE_MS),
  );
}

// Flush a channel's buffered messages to the MCP extraction tool. Each line is
// tagged [mN] and paired with a refs map (real ts + permalink) so extracted
// citations can link back to the exact message.
async function flush(client: WebClient, teamId: string, channelId: string) {
  const state = stateFor(teamId);
  const timer = state.flushTimers.get(channelId);
  if (timer) {
    clearTimeout(timer);
    state.flushTimers.delete(channelId);
  }
  const entries = state.buffers.get(channelId);
  if (!entries || entries.length === 0) return;
  state.buffers.set(channelId, []);
  const channel = await resolveChannelName(client, teamId, channelId);
  const refs: Record<
    string,
    { ts?: string; permalink?: string; text?: string }
  > = {};
  const authors: Record<string, string> = {}; // display name → Slack id, for @-mentions
  const lines = entries.map((e, i) => {
    const tag = `m${i + 1}`;
    refs[tag] = { ts: e.ts, permalink: e.permalink, text: e.text };
    authors[e.name] = e.userId;
    return `[${tag}] ${e.name}: ${e.text}`;
  });
  dbg(
    `📤 flushing ${entries.length} msgs from #${channel} (team ${teamId}) → brain`,
  );
  try {
    await mcp.ingest(
      teamId,
      lines.join('\n'),
      `#${channel}`,
      channelId,
      refs,
      authors,
    );
    dbg(`📥 ingested ${entries.length} msgs from #${channel}`);
  } catch (err) {
    console.error('[se3k:bot] ingest failed (re-queuing):', err);
    state.buffers.set(channelId, [
      ...entries,
      ...(state.buffers.get(channelId) || []),
    ]);
  }
}

// Buffer one message (fast-path deduped by ts), then flush by size or arm the
// timer. Authoritative dedupe against a separate backfill job happens
// server-side in mcp-server's ingest_messages handler.
async function bufferMessage(
  client: WebClient,
  teamId: string,
  channelId: string,
  userId: string,
  text: string,
  ts?: string,
) {
  const state = stateFor(teamId);
  if (ts) {
    const key = `${channelId}:${ts}`;
    if (state.processedTs.has(key)) return;
    state.processedTs.add(key);
  }
  const name = await resolveUserName(client, teamId, userId);
  const buf = state.buffers.get(channelId) || [];
  buf.push({
    name,
    userId,
    text: text.replace(/\s+/g, ' ').trim(),
    ts,
    permalink: permalinkFor(teamId, channelId, ts),
  });
  state.buffers.set(channelId, buf);
  dbg(`   ✍️  buffered [${buf.length}] ${name}: ${text.slice(0, 60)}`);
  if (buf.length >= BATCH_SIZE) await flush(client, teamId, channelId);
  else armFlush(client, teamId, channelId);
}

// Pull recent channel history (the "backfill on join" behavior — capped and
// quick; the full-history backfill job lives in mcp-server, triggered from
// the web dashboard for workspaces with years of history).
async function backfill(
  client: WebClient,
  teamId: string,
  channelId: string,
  limit = BACKFILL_LIMIT,
): Promise<number> {
  dbg(
    `🕓 backfill · pulling up to ${limit} msgs from ${channelId} (team ${teamId})`,
  );
  try {
    const oldest = await mcp.lastProcessedTs(teamId, channelId);
    if (oldest) dbg(`   ↳ resuming from oldest=${oldest}`);
    const res = await client.conversations.history({
      channel: channelId,
      limit: Math.min(limit, BACKFILL_MAX),
      oldest,
      inclusive: false,
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
      if (m.subtype || !m.user || !m.text || isNoise(m.text, m.user, undefined))
        continue;
      await bufferMessage(client, teamId, channelId, m.user, m.text, m.ts);
      n++;
    }
    await flush(client, teamId, channelId);
    dbg(`🕓 backfill done · ${n} msgs from ${channelId}`);
    return n;
  } catch (err) {
    console.error('[se3k:bot] backfill failed:', err);
    return 0;
  }
}

// Route a question through the MCP ask_graph tool.
async function answer(teamId: string, question: string): Promise<AskResult> {
  if (!question.trim()) {
    return {
      text: 'Ask me *who actually knows about X* (expertise routing) or *why we decided X* (decision provenance). Example: `/ask-graph who do I talk to about the checkout timeouts?`',
      sources: [],
      kind: 'unknown',
    };
  }
  dbg(`❓ team ${teamId} · "${question}"`);
  try {
    const reply = await mcp.ask(teamId, question);
    dbg('💬 got reply from brain');
    return reply;
  } catch (err) {
    console.error('[se3k:bot] ask failed:', err);
    return {
      text: "Sorry — I couldn't reach the knowledge graph just now.",
      sources: [],
      kind: 'unknown',
    };
  }
}

// ---- Events ----------------------------------------------------------------

app.message(
  async ({
    message,
    context,
    client,
  }: {
    message: unknown;
    context: BoltContext;
    client: WebClient;
  }) => {
    const teamId = context.teamId;
    if (!teamId) return;
    const m = message as {
      subtype?: string;
      user?: string;
      text?: string;
      channel?: string;
      ts?: string;
    };
    if (m.subtype || !m.user || !m.text || !m.channel) return;
    if (context.botUserId && m.text.includes(`<@${context.botUserId}>`)) return; // question to the bot, not content
    if (isNoise(m.text, m.user, context.botUserId as string | undefined))
      return;

    // Await: permalinkFor() (called during buffering below) needs state.teamUrl,
    // which ensureBootstrapped sets. Fire-and-forget here means the first
    // messages get buffered with no permalink → unlinked citations.
    await ensureBootstrapped(client, teamId);

    // First time we see a channel, lazily backfill its history (covers channels
    // the bot was already in before member_joined_channel was subscribed).
    const state = stateFor(teamId);
    if (!state.backfilledChannels.has(m.channel)) {
      state.backfilledChannels.add(m.channel);
      dbg(
        `first message seen in ${m.channel} (team ${teamId}) → lazy backfill`,
      );
      void backfill(client, teamId, m.channel);
    }
    await bufferMessage(client, teamId, m.channel, m.user, m.text, m.ts);
  },
);

app.event(
  'member_joined_channel',
  async ({
    event,
    context,
    client,
  }: {
    event: unknown;
    context: BoltContext;
    client: WebClient;
  }) => {
    const teamId = context.teamId;
    if (!teamId) return;
    const e = event as { user?: string; channel?: string };
    if (!e.channel || e.user !== context.botUserId) return; // only react to the bot's own join
    const state = stateFor(teamId);
    if (state.backfilledChannels.has(e.channel)) return;
    dbg(`bot joined ${e.channel} (team ${teamId}) → backfilling`);
    state.backfilledChannels.add(e.channel);
    await ensureBootstrapped(client, teamId); // must finish first so permalinks resolve
    await backfill(client, teamId, e.channel);
  },
);

app.command(
  '/ask-graph',
  async ({ command, ack, respond, context, client }) => {
    await ack();
    const teamId = context.teamId!;
    void ensureBootstrapped(client, teamId);
    dbg(`⌨️  /ask-graph · team ${teamId} · "${command.text}"`);
    const reply = await answer(teamId, command.text);
    // Slack hides the slash-command invocation, so echo the question back (as a
    // context block) — the channel only sees our reply otherwise.
    const question = command.text.trim();
    const { blocks, text } = buildAnswerBlocks({
      answerText: reply.text,
      sources: reply.sources,
      askerId: question ? command.user_id : undefined,
      question: question || undefined,
    });
    await respond({
      blocks: blocks as slack.KnownBlock[],
      text,
      response_type: 'in_channel',
    });
  },
);

app.command(
  '/se3k-ingest',
  async ({ command, ack, respond, context, client }) => {
    await ack();
    const teamId = context.teamId!;
    dbg(`/se3k-ingest · team ${teamId} · ${command.channel_id}`);
    await flush(client, teamId, command.channel_id);
    const flushedText = '✅ Flushed pending messages into the knowledge graph.';
    await respond({
      text: flushedText,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: flushedText } },
      ],
      response_type: 'ephemeral',
    });
  },
);

app.command(
  '/se3k-backfill',
  async ({ command, ack, respond, context, client }) => {
    await ack();
    const teamId = context.teamId!;
    const count = parseInt(command.text.trim(), 10) || BACKFILL_LIMIT;
    dbg(`⌨️  /se3k-backfill ${count} · team ${teamId} · ${command.channel_id}`);
    // Without this, a backfill triggered before any other event means teamUrl is
    // unset → every backfilled message gets an unlinked citation.
    await ensureBootstrapped(client, teamId);
    stateFor(teamId).backfilledChannels.add(command.channel_id);
    const n = await backfill(client, teamId, command.channel_id, count);
    const backfillText = `🕓 Backfilled ${n} messages from this channel into the graph.`;
    const url = dashboardUrl(teamId);
    const blocks: unknown[] = [
      { type: 'section', text: { type: 'mrkdwn', text: `*${backfillText}*` } },
    ];
    if (url) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '📊 View live graph',
              emoji: true,
            },
            url,
            action_id: 'view_graph',
          },
        ],
      });
    }
    await respond({
      text: `${backfillText}${dashboardLink(teamId)}`,
      blocks: blocks as slack.KnownBlock[],
      response_type: 'ephemeral',
    });
  },
);

app.event(
  'app_mention',
  async ({
    event,
    say,
    context,
    client,
  }: {
    event: unknown;
    say: Say;
    context: BoltContext;
    client: WebClient;
  }) => {
    const teamId = context.teamId;
    if (!teamId) return;
    void ensureBootstrapped(client, teamId);
    const botUserId = context.botUserId as string | undefined;
    const e = event as { text?: string; ts?: string; thread_ts?: string };
    // Strip only OUR mention — keep any other <@user> mentions so the brain can
    // answer person-scoped questions like "what is @Rahul working on?".
    const raw = e.text || '';
    const text = (
      botUserId
        ? raw.split(`<@${botUserId}>`).join(' ')
        : raw.replace(/^\s*<@[^>]+>/, '')
    )
      .replace(/\s+/g, ' ')
      .trim();
    dbg(`📣 @se3k · team ${teamId} · "${text}"`);
    const reply = await answer(teamId, text);
    const { blocks, text: fallback } = buildAnswerBlocks({
      answerText: reply.text,
      sources: reply.sources,
    });
    await say({ text: fallback, blocks, thread_ts: e.thread_ts || e.ts });
  },
);

// ---- Health endpoint --------------------------------------------------------
// The bot itself talks to Slack over Socket Mode (outbound only), so it has no
// inbound HTTP surface of its own. Render's web-service health check still
// expects something listening on $PORT — without this, deploys get stuck
// "waiting for open port" and restart-loop. This server exists only to
// satisfy that check.
const PORT = Number(process.env.PORT) || 3001;
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// URL buttons still deliver a block_actions payload that must be acked, or Slack
// shows the user a "this app isn't responding" warning. The link opens client-side.
app.action('view_graph', async ({ ack }: { ack: () => Promise<void> }) => {
  await ack();
});

(async () => {
  healthServer.listen(PORT, () => {
    dbg(`🩺 health check listening on :${PORT}`);
  });
  await app.start();
  dbg('⚡️ SE3K bot online · Socket Mode · multi-workspace\n');
})();
