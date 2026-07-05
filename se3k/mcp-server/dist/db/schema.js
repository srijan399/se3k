"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processedMessages = exports.backfillJobs = exports.graphEdges = exports.graphNodes = exports.installations = void 0;
// Multi-workspace storage. Every table is partitioned by `teamId` (Slack
// team/workspace id) — see AGENTS.md / the multi-workspace plan before
// expanding this further.
const pg_core_1 = require("drizzle-orm/pg-core");
exports.installations = (0, pg_core_1.pgTable)('installations', {
    teamId: (0, pg_core_1.text)('team_id').primaryKey(),
    teamName: (0, pg_core_1.text)('team_name'),
    botToken: (0, pg_core_1.text)('bot_token').notNull(),
    botUserId: (0, pg_core_1.text)('bot_user_id'),
    scope: (0, pg_core_1.text)('scope'),
    installedAt: (0, pg_core_1.timestamp)('installed_at', { withTimezone: true })
        .defaultNow()
        .notNull(),
    updatedAt: (0, pg_core_1.timestamp)('updated_at', { withTimezone: true })
        .defaultNow()
        .notNull(),
});
// Mirrors GraphNode (src/graph/types.ts) with a team_id partition key.
exports.graphNodes = (0, pg_core_1.pgTable)('graph_nodes', {
    teamId: (0, pg_core_1.text)('team_id').notNull(),
    id: (0, pg_core_1.text)('id').notNull(),
    type: (0, pg_core_1.text)('type').notNull(),
    label: (0, pg_core_1.text)('label').notNull(),
    slackUserId: (0, pg_core_1.text)('slack_user_id'),
    meta: (0, pg_core_1.jsonb)('meta').$type(),
}, (t) => [(0, pg_core_1.primaryKey)({ columns: [t.teamId, t.id] })]);
// Mirrors GraphEdge. weight/last_active are real columns — never collapse
// INVOLVED_IN to a boolean (see AGENTS.md).
exports.graphEdges = (0, pg_core_1.pgTable)('graph_edges', {
    teamId: (0, pg_core_1.text)('team_id').notNull(),
    id: (0, pg_core_1.text)('id').notNull(),
    type: (0, pg_core_1.text)('type').notNull(),
    from: (0, pg_core_1.text)('from_id').notNull(),
    to: (0, pg_core_1.text)('to_id').notNull(),
    weight: (0, pg_core_1.integer)('weight').notNull(),
    lastActive: (0, pg_core_1.text)('last_active').notNull(),
    sources: (0, pg_core_1.jsonb)('sources').$type().notNull(),
    meta: (0, pg_core_1.jsonb)('meta').$type(),
}, (t) => [(0, pg_core_1.primaryKey)({ columns: [t.teamId, t.id] })]);
exports.backfillJobs = (0, pg_core_1.pgTable)('backfill_jobs', {
    id: (0, pg_core_1.serial)('id').primaryKey(),
    teamId: (0, pg_core_1.text)('team_id').notNull(),
    channelIds: (0, pg_core_1.jsonb)('channel_ids').$type(),
    status: (0, pg_core_1.text)('status').notNull().default('pending'), // pending|running|done|failed
    messagesProcessed: (0, pg_core_1.integer)('messages_processed').notNull().default(0),
    channelsTotal: (0, pg_core_1.integer)('channels_total').notNull().default(0),
    channelsDone: (0, pg_core_1.integer)('channels_done').notNull().default(0),
    error: (0, pg_core_1.text)('error'),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .defaultNow()
        .notNull(),
    updatedAt: (0, pg_core_1.timestamp)('updated_at', { withTimezone: true })
        .defaultNow()
        .notNull(),
});
// Idempotency: a Slack message is only ever extracted/ingested once, whether
// it arrives via live ingestion or a backfill job.
exports.processedMessages = (0, pg_core_1.pgTable)('processed_messages', {
    teamId: (0, pg_core_1.text)('team_id').notNull(),
    channelId: (0, pg_core_1.text)('channel_id').notNull(),
    ts: (0, pg_core_1.text)('ts').notNull(),
}, (t) => [(0, pg_core_1.primaryKey)({ columns: [t.teamId, t.channelId, t.ts] })]);
