// Multi-workspace storage. Every table is partitioned by `teamId` (Slack
// team/workspace id) — see AGENTS.md / the multi-workspace plan before
// expanding this further.
import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const installations = pgTable('installations', {
  teamId: text('team_id').primaryKey(),
  teamName: text('team_name'),
  botToken: text('bot_token').notNull(),
  botUserId: text('bot_user_id'),
  scope: text('scope'),
  installedAt: timestamp('installed_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Mirrors GraphNode (src/graph/types.ts) with a team_id partition key.
export const graphNodes = pgTable(
  'graph_nodes',
  {
    teamId: text('team_id').notNull(),
    id: text('id').notNull(),
    type: text('type').notNull(),
    label: text('label').notNull(),
    slackUserId: text('slack_user_id'),
    meta: jsonb('meta').$type<Record<string, unknown>>(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.id] })],
);

// Mirrors GraphEdge. weight/last_active are real columns — never collapse
// INVOLVED_IN to a boolean (see AGENTS.md).
export const graphEdges = pgTable(
  'graph_edges',
  {
    teamId: text('team_id').notNull(),
    id: text('id').notNull(),
    type: text('type').notNull(),
    from: text('from_id').notNull(),
    to: text('to_id').notNull(),
    weight: integer('weight').notNull(),
    lastActive: text('last_active').notNull(),
    sources: jsonb('sources').$type<unknown[]>().notNull(),
    meta: jsonb('meta').$type<Record<string, unknown>>(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.id] })],
);

export const backfillJobs = pgTable('backfill_jobs', {
  id: serial('id').primaryKey(),
  teamId: text('team_id').notNull(),
  channelIds: jsonb('channel_ids').$type<string[] | null>(),
  status: text('status').notNull().default('pending'), // pending|running|done|failed
  messagesProcessed: integer('messages_processed').notNull().default(0),
  channelsTotal: integer('channels_total').notNull().default(0),
  channelsDone: integer('channels_done').notNull().default(0),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Idempotency: a Slack message is only ever extracted/ingested once, whether
// it arrives via live ingestion or a backfill job.
export const processedMessages = pgTable(
  'processed_messages',
  {
    teamId: text('team_id').notNull(),
    channelId: text('channel_id').notNull(),
    ts: text('ts').notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.channelId, t.ts] })],
);
