"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rest = void 0;
const web_api_1 = require("@slack/web-api");
const drizzle_orm_1 = require("drizzle-orm");
const express_1 = require("express");
const run_1 = require("../backfill/run");
const client_1 = require("../db/client");
const schema_1 = require("../db/schema");
const store_1 = require("../graph/store");
const asyncHandler_1 = require("./asyncHandler");
const auth_1 = require("./auth");
const dbg = (...args) => console.error('[se3k:rest]', ...args);
exports.rest = (0, express_1.Router)();
exports.rest.use(auth_1.requireInternalSecret);
// ---- Installations (web's OAuth callback + workspace picker) --------------
exports.rest.get('/internal/installations', (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    const rows = await client_1.db
        .select({
        teamId: schema_1.installations.teamId,
        teamName: schema_1.installations.teamName,
        botUserId: schema_1.installations.botUserId,
        installedAt: schema_1.installations.installedAt,
    })
        .from(schema_1.installations);
    res.json(rows);
}));
exports.rest.get('/internal/installations/:teamId', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const [row] = await client_1.db
        .select()
        .from(schema_1.installations)
        .where((0, drizzle_orm_1.eq)(schema_1.installations.teamId, req.params.teamId));
    if (!row) {
        res.status(404).json({ error: 'not found' });
        return;
    }
    res.json(row);
}));
exports.rest.post('/internal/installations', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { teamId, teamName, botToken, botUserId, scope } = req.body || {};
    if (!teamId || !botToken) {
        res.status(400).json({ error: 'teamId and botToken are required' });
        return;
    }
    await client_1.db
        .insert(schema_1.installations)
        .values({ teamId, teamName, botToken, botUserId, scope })
        .onConflictDoUpdate({
        target: schema_1.installations.teamId,
        set: { teamName, botToken, botUserId, scope, updatedAt: new Date() },
    });
    dbg(`installed · team ${teamId} (${teamName || '?'})`);
    res.status(201).json({ ok: true });
}));
// ---- Graph (replaces web's raw fs.readFile of graph.json) -----------------
exports.rest.get('/graph', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const teamId = req.query.teamId;
    if (!teamId) {
        res.status(400).json({ error: 'teamId query param required' });
        return;
    }
    const store = await store_1.GraphStore.forTeam(teamId);
    res.json(store.snapshot());
}));
// ---- Channels (for the "pick channels to backfill" UI) ---------------------
exports.rest.get('/internal/channels', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const teamId = req.query.teamId;
    if (!teamId) {
        res.status(400).json({ error: 'teamId query param required' });
        return;
    }
    const [install] = await client_1.db
        .select()
        .from(schema_1.installations)
        .where((0, drizzle_orm_1.eq)(schema_1.installations.teamId, teamId));
    if (!install) {
        res.status(404).json({ error: 'installation not found' });
        return;
    }
    const client = new web_api_1.WebClient(install.botToken);
    const channels = [];
    let cursor;
    do {
        const r = await client.conversations.list({
            types: 'public_channel,private_channel',
            exclude_archived: true,
            limit: 200,
            cursor,
        });
        for (const c of r.channels || []) {
            if (!c.id)
                continue;
            channels.push({
                id: c.id,
                name: c.name || c.id,
                isMember: !!c.is_member,
                isPrivate: !!c.is_private,
            });
        }
        cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);
    res.json(channels);
}));
// ---- Backfill ---------------------------------------------------------------
exports.rest.post('/internal/backfill', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { teamId, channelIds, autoJoinPublic } = req.body || {};
    if (!teamId) {
        res.status(400).json({ error: 'teamId is required' });
        return;
    }
    const jobId = await (0, run_1.startBackfillJob)(teamId, channelIds, !!autoJoinPublic);
    res.status(202).json({ jobId });
}));
exports.rest.get('/internal/backfill/:jobId', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = Number(req.params.jobId);
    const [job] = await client_1.db
        .select()
        .from(schema_1.backfillJobs)
        .where((0, drizzle_orm_1.eq)(schema_1.backfillJobs.id, id));
    if (!job) {
        res.status(404).json({ error: 'not found' });
        return;
    }
    res.json(job);
}));
