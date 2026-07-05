// One-time migration: load the legacy graph-store/graph.json (single-workspace
// era) into Postgres under one team_id, so the seeded sandbox demo survives
// the move to multi-workspace storage.
//
// Usage:
//   pnpm db:migrate-json <teamId>
//   # or, to have it look the team id up via Slack:
//   SLACK_BOT_TOKEN=xoxb-... pnpm db:migrate-json
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { WebClient } from '@slack/web-api';
import { db } from './client';
import { graphNodes, graphEdges } from './schema';
import { GraphSnapshot } from '../graph/types';

const dbg = (...args: unknown[]) => console.error('[se3k:migrate]', ...args);

const GRAPH_PATH =
  process.env.GRAPH_STORE_PATH ||
  path.resolve(__dirname, '../../../graph-store/graph.json');

async function resolveTeamId(): Promise<string> {
  const arg = process.argv[2];
  if (arg) return arg;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error(
      'Pass a team id as an argument, or set SLACK_BOT_TOKEN so it can be looked up via auth.test.\n' +
        'Usage: pnpm db:migrate-json <teamId>',
    );
  }
  const auth = await new WebClient(token).auth.test();
  if (!auth.team_id) throw new Error('auth.test did not return a team_id');
  return auth.team_id as string;
}

async function main() {
  const teamId = await resolveTeamId();
  dbg(`migrating ${GRAPH_PATH} → team ${teamId}`);

  const raw = fs.readFileSync(GRAPH_PATH, 'utf-8');
  const snap = JSON.parse(raw) as GraphSnapshot;

  await db.transaction(async (tx) => {
    if (snap.nodes.length) {
      await tx
        .insert(graphNodes)
        .values(
          snap.nodes.map((n) => ({
            teamId,
            id: n.id,
            type: n.type,
            label: n.label,
            slackUserId: n.slackUserId ?? null,
            meta: n.meta ?? null,
          })),
        )
        .onConflictDoNothing();
    }
    if (snap.edges.length) {
      await tx
        .insert(graphEdges)
        .values(
          snap.edges.map((e) => ({
            teamId,
            id: e.id,
            type: e.type,
            from: e.from,
            to: e.to,
            weight: e.weight,
            lastActive: e.last_active,
            sources: e.sources,
            meta: e.meta ?? null,
          })),
        )
        .onConflictDoNothing();
    }
  });

  dbg(
    `✅ migrated ${snap.nodes.length} node(s) · ${snap.edges.length} edge(s) into team ${teamId}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[se3k:migrate] failed:', err);
  process.exit(1);
});
