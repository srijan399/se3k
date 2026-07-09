import { WebClient } from '@slack/web-api';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { backfillJobs, installations } from '../db/schema';
import { GraphStore } from '../graph/store';
import {
  filterProcessed,
  lastProcessedTs,
  markProcessed,
} from '../ingest/dedupe';
import { extractGraph } from '../llm/extract';
import { isNoise } from './noise';

const dbg = (...args: unknown[]) => console.error('[se3k:backfill]', ...args);

const PAGE_DELAY_MS = 1200;
const BATCH_SIZE = 20; // messages per extraction batch

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function permalinkFor(
  teamUrl: string | undefined,
  channelId: string,
  ts?: string,
): string | undefined {
  if (!teamUrl || !ts) return undefined;
  const base = teamUrl.endsWith('/') ? teamUrl : `${teamUrl}/`;
  return `${base}archives/${channelId}/p${ts.replace('.', '')}`;
}

async function getInstallation(teamId: string) {
  const [row] = await db
    .select()
    .from(installations)
    .where(eq(installations.teamId, teamId));
  if (!row) throw new Error(`no installation found for team ${teamId}`);
  return row;
}

async function setJob(jobId: number, patch: Record<string, unknown>) {
  await db
    .update(backfillJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(backfillJobs.id, jobId));
}

// Kicks off a backfill job asynchronously and returns its id immediately —
// callers (the REST layer) poll GET /internal/backfill/:jobId for progress.
export async function startBackfillJob(
  teamId: string,
  channelIds?: string[],
  autoJoinPublic?: boolean,
): Promise<number> {
  const [job] = await db
    .insert(backfillJobs)
    .values({ teamId, channelIds: channelIds ?? null, status: 'pending' })
    .returning({ id: backfillJobs.id });

  runBackfillJob(job.id, teamId, channelIds, autoJoinPublic).catch(
    async (err) => {
      dbg(`job ${job.id} failed:`, err);
      await setJob(job.id, {
        status: 'failed',
        error: String((err as Error)?.message || err),
      }).catch(() => {});
    },
  );

  return job.id;
}

async function joinAllPublicChannels(client: WebClient): Promise<void> {
  let cursor: string | undefined;
  do {
    const res = await client.conversations.list({
      types: 'public_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    for (const c of res.channels || []) {
      if (c.id && !(c as { is_member?: boolean }).is_member) {
        try {
          await client.conversations.join({ channel: c.id });
        } catch (err) {
          dbg(`join failed for ${c.id}:`, err);
        }
      }
    }
    cursor = res.response_metadata?.next_cursor || undefined;
    if (cursor) await sleep(PAGE_DELAY_MS);
  } while (cursor);
}

interface Channel {
  id: string;
  name: string;
}

// Public channels the bot is already a member of, or the explicit list the
// caller picked. Bots can't read history in channels they haven't joined —
// private channels need a manual /invite; public ones can be auto-joined by
// the caller (web UI) before calling this, via conversations.join.
async function listTargetChannels(
  client: WebClient,
  channelIds?: string[],
): Promise<Channel[]> {
  if (channelIds && channelIds.length) {
    const out: Channel[] = [];
    for (const id of channelIds) {
      try {
        const res = await client.conversations.info({ channel: id });
        out.push({ id, name: (res.channel as { name?: string })?.name || id });
      } catch {
        out.push({ id, name: id });
      }
    }
    return out;
  }
  const out: Channel[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    for (const c of res.channels || []) {
      if ((c as { is_member?: boolean }).is_member && c.id) {
        out.push({ id: c.id, name: c.name || c.id });
      }
    }
    cursor = res.response_metadata?.next_cursor || undefined;
    if (cursor) await sleep(PAGE_DELAY_MS);
  } while (cursor);
  return out;
}

const userNameCache = new Map<string, string>();

async function resolveUserName(
  client: WebClient,
  userId: string,
): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;
  try {
    const res = await client.users.info({ user: userId });
    const u = res.user as {
      profile?: { real_name?: string };
      real_name?: string;
      name?: string;
    };
    const name = u?.profile?.real_name || u?.real_name || u?.name || userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

async function runBackfillJob(
  jobId: number,
  teamId: string,
  channelIds?: string[],
  autoJoinPublic?: boolean,
): Promise<void> {
  await setJob(jobId, { status: 'running' });
  const install = await getInstallation(teamId);
  const client = new WebClient(install.botToken);

  let teamUrl: string | undefined;
  try {
    teamUrl = (await client.auth.test()).url as string;
  } catch {
    /* no permalinks if this fails — citations still render as plain text */
  }

  if (!channelIds?.length && autoJoinPublic) {
    await joinAllPublicChannels(client);
  }

  const channels = await listTargetChannels(client, channelIds);
  await setJob(jobId, { channelsTotal: channels.length });
  dbg(`job ${jobId} · team ${teamId} · ${channels.length} channel(s)`);

  let totalMessages = 0;
  const skipped: string[] = [];
  for (let i = 0; i < channels.length; i++) {
    try {
      totalMessages += await backfillChannel(
        teamId,
        client,
        channels[i],
        teamUrl,
      );
    } catch (err) {
      const msg = (err as Error)?.message || String(err);
      const cause = (err as { cause?: { message?: string } })?.cause?.message;
      dbg(`channel #${channels[i].name} skipped:`, cause || msg);
      const blob = `${msg} ${cause || ''}`;
      const reason = /not_in_channel/.test(blob)
        ? 'invite the bot first'
        : /rate_limit|429/i.test(blob)
          ? 'rate-limited, try again shortly'
          : 'ingest error';
      skipped.push(`#${channels[i].name} (${reason})`);
    }
    await setJob(jobId, {
      channelsDone: i + 1,
      messagesProcessed: totalMessages,
    });
  }

  const note = skipped.length
    ? `Skipped ${skipped.length}: ${skipped.join(', ')}`
    : null;
  const allFailed = skipped.length > 0 && skipped.length === channels.length;
  await setJob(jobId, { status: allFailed ? 'failed' : 'done', error: note });
  dbg(
    `job ${jobId} ${allFailed ? 'failed' : 'done'} · ${totalMessages} message(s) across ` +
      `${channels.length - skipped.length}/${channels.length} channel(s)` +
      (skipped.length ? ` · skipped ${skipped.length}` : ''),
  );
}

interface BufEntry {
  name: string;
  userId: string;
  text: string;
  ts?: string;
}

async function backfillChannel(
  teamId: string,
  client: WebClient,
  channel: Channel,
  teamUrl: string | undefined,
): Promise<number> {
  try {
    await client.conversations.join({ channel: channel.id });
  } catch {}

  const oldest = await lastProcessedTs(teamId, channel.id);
  if (oldest) dbg(`#${channel.name} · resuming from oldest=${oldest}`);

  let cursor: string | undefined;
  let buffer: BufEntry[] = [];
  let count = 0;

  const flush = async () => {
    if (!buffer.length) return;
    const entries = buffer;
    buffer = [];
    const refs: Record<
      string,
      { ts?: string; text?: string; permalink?: string }
    > = {};
    const authors: Record<string, string> = {};
    const lines = entries.map((e, i) => {
      const tag = `m${i + 1}`;
      refs[tag] = {
        ts: e.ts,
        text: e.text,
        permalink: permalinkFor(teamUrl, channel.id, e.ts),
      };
      authors[e.name] = e.userId;
      return `[${tag}] ${e.name}: ${e.text}`;
    });
    const deduped = await filterProcessed(teamId, channel.id, lines, refs);
    if (!deduped.lines.length) return;
    const result = await extractGraph(deduped.lines.join('\n'));
    const store = await GraphStore.forTeam(teamId);
    store.ingest(
      result,
      { channel: `#${channel.name}`, channelId: channel.id },
      deduped.refs,
      authors,
    );
    await store.saveTeam();
    await markProcessed(teamId, channel.id, deduped.tsToMark);
  };

  do {
    const res = await client.conversations.history({
      channel: channel.id,
      cursor,
      limit: 200,
      oldest,
      inclusive: false,
    });
    const msgs = (res.messages || []) as Array<{
      subtype?: string;
      user?: string;
      text?: string;
      ts?: string;
    }>;
    for (const m of [...msgs].reverse()) {
      if (m.subtype || !m.user || !m.text || isNoise(m.text)) continue;
      const name = await resolveUserName(client, m.user);
      buffer.push({
        name,
        userId: m.user,
        text: m.text.replace(/\s+/g, ' ').trim(),
        ts: m.ts,
      });
      count++;
      if (buffer.length >= BATCH_SIZE) await flush();
    }
    cursor = res.response_metadata?.next_cursor || undefined;
    if (cursor) await sleep(PAGE_DELAY_MS);
  } while (cursor);

  await flush();
  return count;
}
