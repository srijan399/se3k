import { WebClient } from '@slack/web-api';
import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { startBackfillJob } from '../backfill/run';
import { db } from '../db/client';
import {
  backfillJobs,
  graphEdges,
  graphNodes,
  installations,
  processedMessages,
} from '../db/schema';
import { GraphStore } from '../graph/store';
import * as cache from '../cache/semanticCache';
import { asyncHandler } from './asyncHandler';
import { requireInternalSecret } from './auth';

const dbg = (...args: unknown[]) => console.error('[se3k:rest]', ...args);

export const rest = Router();

rest.use(requireInternalSecret);

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

// Uninstall (data side): delete every team-partitioned row we hold. The Slack-
// side removal (apps.uninstall) is done by the web route, which is the only
// place with the client_id/client_secret needed for it — the brain just purges.
rest.delete(
  '/internal/installations/:teamId',
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const [install] = await db
      .select()
      .from(installations)
      .where(eq(installations.teamId, teamId));
    if (!install) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    await db.transaction(async (tx) => {
      await tx.delete(graphEdges).where(eq(graphEdges.teamId, teamId));
      await tx.delete(graphNodes).where(eq(graphNodes.teamId, teamId));
      await tx
        .delete(processedMessages)
        .where(eq(processedMessages.teamId, teamId));
      await tx.delete(backfillJobs).where(eq(backfillJobs.teamId, teamId));
      await tx.delete(installations).where(eq(installations.teamId, teamId));
    });
    dbg(
      `uninstalled · team ${teamId} (${install.teamName || '?'}) · purged graph + jobs + dedupe`,
    );
    res.json({ ok: true });
  }),
);

// Clear the in-memory semantic answer cache (e.g. after re-seeding, so old
// answers can't be replayed). The cache is also version-keyed, so a graph
// change already invalidates it — this is the explicit escape hatch.
rest.post(
  '/internal/cache/clear',
  asyncHandler(async (_req, res) => {
    const cleared = cache.clear();
    res.json({ ok: true, cleared });
  }),
);

rest.post(
  '/internal/reset-graph/:teamId',
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const counts = await db.transaction(async (tx) => {
      const e = await tx
        .delete(graphEdges)
        .where(eq(graphEdges.teamId, teamId));
      const n = await tx
        .delete(graphNodes)
        .where(eq(graphNodes.teamId, teamId));
      const p = await tx
        .delete(processedMessages)
        .where(eq(processedMessages.teamId, teamId));
      const j = await tx
        .delete(backfillJobs)
        .where(eq(backfillJobs.teamId, teamId));
      return {
        nodes: n.rowCount ?? 0,
        edges: e.rowCount ?? 0,
        processed: p.rowCount ?? 0,
        jobs: j.rowCount ?? 0,
      };
    });
    cache.clear();
    dbg(
      `reset-graph · team ${teamId} · ${JSON.stringify(counts)} (install kept)`,
    );
    res.json({ ok: true, ...counts });
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
      // team_id required — see the comment on joinAllPublicChannels in
      // backfill/run.ts for why this bot token needs it even though it's a
      // single-workspace install.
      const r = await client.conversations.list({
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 200,
        cursor,
        team_id: teamId,
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
    // jobId is a raw auto-increment int — a caller scoped to one team must
    // not be able to probe another team's job by guessing adjacent ids.
    const teamId = req.query.teamId as string | undefined;
    if (!job || (teamId && job.teamId !== teamId)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(job);
  }),
);
