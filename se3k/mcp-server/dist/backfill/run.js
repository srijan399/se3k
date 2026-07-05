"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startBackfillJob = startBackfillJob;
const web_api_1 = require("@slack/web-api");
const drizzle_orm_1 = require("drizzle-orm");
const client_1 = require("../db/client");
const schema_1 = require("../db/schema");
const store_1 = require("../graph/store");
const dedupe_1 = require("../ingest/dedupe");
const extract_1 = require("../llm/extract");
const noise_1 = require("./noise");
const dbg = (...args) => console.error('[se3k:backfill]', ...args);
// Simple, hackathon-appropriate rate-limit backoff between paginated Slack
// calls — not tuned against real Tier limits, just enough to not get 429'd
// on a multi-thousand-message history pull.
const PAGE_DELAY_MS = 1200;
const BATCH_SIZE = 20; // messages per extraction batch
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function getInstallation(teamId) {
    const [row] = await client_1.db
        .select()
        .from(schema_1.installations)
        .where((0, drizzle_orm_1.eq)(schema_1.installations.teamId, teamId));
    if (!row)
        throw new Error(`no installation found for team ${teamId}`);
    return row;
}
async function setJob(jobId, patch) {
    await client_1.db
        .update(schema_1.backfillJobs)
        .set({ ...patch, updatedAt: new Date() })
        .where((0, drizzle_orm_1.eq)(schema_1.backfillJobs.id, jobId));
}
// Kicks off a backfill job asynchronously and returns its id immediately —
// callers (the REST layer) poll GET /internal/backfill/:jobId for progress.
async function startBackfillJob(teamId, channelIds, autoJoinPublic) {
    const [job] = await client_1.db
        .insert(schema_1.backfillJobs)
        .values({ teamId, channelIds: channelIds ?? null, status: 'pending' })
        .returning({ id: schema_1.backfillJobs.id });
    runBackfillJob(job.id, teamId, channelIds, autoJoinPublic).catch(async (err) => {
        dbg(`job ${job.id} failed:`, err);
        await setJob(job.id, {
            status: 'failed',
            error: String(err?.message || err),
        }).catch(() => { });
    });
    return job.id;
}
// Bots can only read history in channels they're a member of. Opt-in
// convenience for "backfill everything" — joins every public channel the
// bot isn't already in (needs the channels:join scope). Private channels
// still need a manual /invite; never auto-joined.
async function joinAllPublicChannels(client) {
    let cursor;
    do {
        const res = await client.conversations.list({
            types: 'public_channel',
            exclude_archived: true,
            limit: 200,
            cursor,
        });
        for (const c of res.channels || []) {
            if (c.id && !c.is_member) {
                try {
                    await client.conversations.join({ channel: c.id });
                }
                catch (err) {
                    dbg(`join failed for ${c.id}:`, err);
                }
            }
        }
        cursor = res.response_metadata?.next_cursor || undefined;
        if (cursor)
            await sleep(PAGE_DELAY_MS);
    } while (cursor);
}
// Public channels the bot is already a member of, or the explicit list the
// caller picked. Bots can't read history in channels they haven't joined —
// private channels need a manual /invite; public ones can be auto-joined by
// the caller (web UI) before calling this, via conversations.join.
async function listTargetChannels(client, channelIds) {
    if (channelIds && channelIds.length) {
        const out = [];
        for (const id of channelIds) {
            try {
                const res = await client.conversations.info({ channel: id });
                out.push({ id, name: res.channel?.name || id });
            }
            catch {
                out.push({ id, name: id });
            }
        }
        return out;
    }
    const out = [];
    let cursor;
    do {
        const res = await client.conversations.list({
            types: 'public_channel,private_channel',
            exclude_archived: true,
            limit: 200,
            cursor,
        });
        for (const c of res.channels || []) {
            if (c.is_member && c.id) {
                out.push({ id: c.id, name: c.name || c.id });
            }
        }
        cursor = res.response_metadata?.next_cursor || undefined;
        if (cursor)
            await sleep(PAGE_DELAY_MS);
    } while (cursor);
    return out;
}
const userNameCache = new Map();
async function resolveUserName(client, userId) {
    const cached = userNameCache.get(userId);
    if (cached)
        return cached;
    try {
        const res = await client.users.info({ user: userId });
        const u = res.user;
        const name = u?.profile?.real_name || u?.real_name || u?.name || userId;
        userNameCache.set(userId, name);
        return name;
    }
    catch {
        return userId;
    }
}
async function runBackfillJob(jobId, teamId, channelIds, autoJoinPublic) {
    await setJob(jobId, { status: 'running' });
    const install = await getInstallation(teamId);
    const client = new web_api_1.WebClient(install.botToken);
    if (!channelIds?.length && autoJoinPublic) {
        await joinAllPublicChannels(client);
    }
    const channels = await listTargetChannels(client, channelIds);
    await setJob(jobId, { channelsTotal: channels.length });
    dbg(`job ${jobId} · team ${teamId} · ${channels.length} channel(s)`);
    let totalMessages = 0;
    for (let i = 0; i < channels.length; i++) {
        totalMessages += await backfillChannel(teamId, client, channels[i]);
        await setJob(jobId, { channelsDone: i + 1, messagesProcessed: totalMessages });
    }
    await setJob(jobId, { status: 'done' });
    dbg(`job ${jobId} done · ${totalMessages} message(s) across ${channels.length} channel(s)`);
}
// Paginates a channel's full history (no BACKFILL_MAX cap — that constant is
// slack-bot's live-path safety valve, not appropriate here), batching
// messages into the same [mN]-tagged shape the live bot's flush() builds,
// and ingesting them directly (same process, no need to go through the MCP
// tool wrapper).
async function backfillChannel(teamId, client, channel) {
    let cursor;
    let buffer = [];
    let count = 0;
    const flush = async () => {
        if (!buffer.length)
            return;
        const entries = buffer;
        buffer = [];
        const refs = {};
        const authors = {};
        const lines = entries.map((e, i) => {
            const tag = `m${i + 1}`;
            refs[tag] = { ts: e.ts, text: e.text };
            authors[e.name] = e.userId;
            return `[${tag}] ${e.name}: ${e.text}`;
        });
        const deduped = await (0, dedupe_1.filterProcessed)(teamId, channel.id, lines, refs);
        if (!deduped.lines.length)
            return;
        const result = await (0, extract_1.extractGraph)(deduped.lines.join('\n'));
        const store = await store_1.GraphStore.forTeam(teamId);
        store.ingest(result, { channel: `#${channel.name}`, channelId: channel.id }, deduped.refs, authors);
        await store.saveTeam();
    };
    do {
        const res = await client.conversations.history({
            channel: channel.id,
            cursor,
            limit: 200,
        });
        const msgs = (res.messages || []);
        // Slack returns newest-first per page; process oldest-first within the
        // page so involvement timestamps stay chronological.
        for (const m of [...msgs].reverse()) {
            if (m.subtype || !m.user || !m.text || (0, noise_1.isNoise)(m.text))
                continue;
            const name = await resolveUserName(client, m.user);
            buffer.push({
                name,
                userId: m.user,
                text: m.text.replace(/\s+/g, ' ').trim(),
                ts: m.ts,
            });
            count++;
            if (buffer.length >= BATCH_SIZE)
                await flush();
        }
        cursor = res.response_metadata?.next_cursor || undefined;
        if (cursor)
            await sleep(PAGE_DELAY_MS);
    } while (cursor);
    await flush();
    return count;
}
