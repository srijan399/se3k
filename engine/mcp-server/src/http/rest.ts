import { WebClient } from '@slack/web-api';
import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { startBackfillJob } from '../backfill/run';
import { db } from '../db/client';
import { backfillJobs, installations } from '../db/schema';
import { GraphStore } from '../graph/store';
import { asyncHandler } from './asyncHandler';
import { requireInternalSecret } from './auth';

const dbg = (...args: unknown[]) => console.error('[se3k:rest]', ...args);

export const rest = Router();

rest.use(requireInternalSecret);

// ---- Installations (web's OAuth callback + workspace picker) --------------

rest.get(
  '/internal/installations',
  asyncHandler(async (_req, res) => {
    const rows = await db
      .select({
        teamId: installations.teamId,
        teamName: installations.teamName,
        botUserId: installations.botUserId,
        installedAt: installations.installedAt,
      })
      .from(installations);
    res.json(rows);
  }),
);

rest.get(
  '/internal/installations/:teamId',
  asyncHandler(async (req, res) => {
    const [row] = await db
      .select()
      .from(installations)
      .where(eq(installations.teamId, req.params.teamId));
    if (!row) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(row);
  }),
);

rest.post(
  '/internal/installations',
  asyncHandler(async (req, res) => {
    const { teamId, teamName, botToken, botUserId, scope } = req.body || {};
    if (!teamId || !botToken) {
      res.status(400).json({ error: 'teamId and botToken are required' });
      return;
    }
    await db
      .insert(installations)
      .values({ teamId, teamName, botToken, botUserId, scope })
      .onConflictDoUpdate({
        target: installations.teamId,
        set: { teamName, botToken, botUserId, scope, updatedAt: new Date() },
      });
    dbg(`installed · team ${teamId} (${teamName || '?'})`);
    res.status(201).json({ ok: true });
  }),
);

// ---- Graph (replaces web's raw fs.readFile of graph.json) -----------------

rest.get(
  '/graph',
  asyncHandler(async (req, res) => {
    const teamId = req.query.teamId as string | undefined;
    if (!teamId) {
      res.status(400).json({ error: 'teamId query param required' });
      return;
    }
    const store = await GraphStore.forTeam(teamId);
    res.json(store.snapshot());
  }),
);

// ---- Channels (for the "pick channels to backfill" UI) ---------------------

rest.get(
  '/internal/channels',
  asyncHandler(async (req, res) => {
    const teamId = req.query.teamId as string | undefined;
    if (!teamId) {
      res.status(400).json({ error: 'teamId query param required' });
      return;
    }
    const [install] = await db
      .select()
      .from(installations)
      .where(eq(installations.teamId, teamId));
    if (!install) {
      res.status(404).json({ error: 'installation not found' });
      return;
    }
    const client = new WebClient(install.botToken);
    const channels: Array<{
      id: string;
      name: string;
      isMember: boolean;
      isPrivate: boolean;
    }> = [];
    let cursor: string | undefined;
    do {
      const r = await client.conversations.list({
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      for (const c of r.channels || []) {
        if (!c.id) continue;
        channels.push({
          id: c.id,
          name: c.name || c.id,
          isMember: !!(c as { is_member?: boolean }).is_member,
          isPrivate: !!(c as { is_private?: boolean }).is_private,
        });
      }
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);
    res.json(channels);
  }),
);

// ---- Backfill ---------------------------------------------------------------

rest.post(
  '/internal/backfill',
  asyncHandler(async (req, res) => {
    const { teamId, channelIds, autoJoinPublic } = req.body || {};
    if (!teamId) {
      res.status(400).json({ error: 'teamId is required' });
      return;
    }
    const jobId = await startBackfillJob(teamId, channelIds, !!autoJoinPublic);
    res.status(202).json({ jobId });
  }),
);

rest.get(
  '/internal/backfill/:jobId',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.jobId);
    const [job] = await db
      .select()
      .from(backfillJobs)
      .where(eq(backfillJobs.id, id));
    if (!job) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(job);
  }),
);
