"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
// One-time migration: load the legacy graph-store/graph.json (single-workspace
// era) into Postgres under one team_id, so the seeded sandbox demo survives
// the move to multi-workspace storage.
//
// Usage:
//   pnpm db:migrate-json <teamId>
//   # or, to have it look the team id up via Slack:
//   SLACK_BOT_TOKEN=xoxb-... pnpm db:migrate-json
require("dotenv/config");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const web_api_1 = require("@slack/web-api");
const client_1 = require("./client");
const schema_1 = require("./schema");
const dbg = (...args) => console.error('[se3k:migrate]', ...args);
const GRAPH_PATH = process.env.GRAPH_STORE_PATH ||
    path.resolve(__dirname, '../../../graph-store/graph.json');
async function resolveTeamId() {
    const arg = process.argv[2];
    if (arg)
        return arg;
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
        throw new Error('Pass a team id as an argument, or set SLACK_BOT_TOKEN so it can be looked up via auth.test.\n' +
            'Usage: pnpm db:migrate-json <teamId>');
    }
    const auth = await new web_api_1.WebClient(token).auth.test();
    if (!auth.team_id)
        throw new Error('auth.test did not return a team_id');
    return auth.team_id;
}
async function main() {
    const teamId = await resolveTeamId();
    dbg(`migrating ${GRAPH_PATH} → team ${teamId}`);
    const raw = fs.readFileSync(GRAPH_PATH, 'utf-8');
    const snap = JSON.parse(raw);
    await client_1.db.transaction(async (tx) => {
        if (snap.nodes.length) {
            await tx
                .insert(schema_1.graphNodes)
                .values(snap.nodes.map((n) => ({
                teamId,
                id: n.id,
                type: n.type,
                label: n.label,
                slackUserId: n.slackUserId ?? null,
                meta: n.meta ?? null,
            })))
                .onConflictDoNothing();
        }
        if (snap.edges.length) {
            await tx
                .insert(schema_1.graphEdges)
                .values(snap.edges.map((e) => ({
                teamId,
                id: e.id,
                type: e.type,
                from: e.from,
                to: e.to,
                weight: e.weight,
                lastActive: e.last_active,
                sources: e.sources,
                meta: e.meta ?? null,
            })))
                .onConflictDoNothing();
        }
    });
    dbg(`✅ migrated ${snap.nodes.length} node(s) · ${snap.edges.length} edge(s) into team ${teamId}`);
    process.exit(0);
}
main().catch((err) => {
    console.error('[se3k:migrate] failed:', err);
    process.exit(1);
});
