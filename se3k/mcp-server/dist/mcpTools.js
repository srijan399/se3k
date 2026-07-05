"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMcpServer = createMcpServer;
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const zod_1 = require("zod");
const store_1 = require("./graph/store");
const dedupe_1 = require("./ingest/dedupe");
const extract_1 = require("./llm/extract");
const answer_1 = require("./llm/answer");
const seed_1 = require("./seed");
const dbg = (...args) => console.error('[se3k:mcp]', ...args);
async function dedupeMessages(teamId, channelId, messages, refs) {
    const { lines, refs: keptRefs, skipped } = await (0, dedupe_1.filterProcessed)(teamId, channelId, messages.split('\n'), refs);
    return { messages: lines.join('\n'), refs: keptRefs, skipped };
}
// Builds a fresh McpServer with all SE3K tools registered. Called once per
// HTTP request in stateless Streamable HTTP mode (see src/index.ts) — cheap,
// since registration is just closures capturing `db`/GraphStore.
function createMcpServer() {
    const server = new mcp_js_1.McpServer({ name: 'se3k-mcp-server', version: '0.3.0' });
    server.registerTool('ping', {
        title: 'Ping',
        description: 'Returns pong. Verifies the MCP server is alive and callable.',
        inputSchema: { message: zod_1.z.string().optional() },
    }, async ({ message }) => {
        dbg('ping', message ?? '');
        return {
            content: [{ type: 'text', text: `pong${message ? `: ${message}` : ''}` }],
        };
    });
    server.registerTool('ingest_messages', {
        title: 'Ingest Slack messages',
        description: 'Run LLM extraction over a batch of Slack messages and merge the resulting people/projects/decisions and weighted INVOLVED_IN edges into the graph. Messages are one per line, each prefixed with a [mN] tag.',
        inputSchema: {
            teamId: zod_1.z.string().describe('Slack team/workspace id — every graph is partitioned by this'),
            messages: zod_1.z
                .string()
                .describe('Raw Slack messages, newline-separated, each prefixed with [mN]'),
            channel: zod_1.z
                .string()
                .optional()
                .describe('Human-readable channel name, e.g. #backend'),
            channelId: zod_1.z.string().optional(),
            refs: zod_1.z
                .record(zod_1.z.string(), zod_1.z.object({
                ts: zod_1.z.string().optional(),
                permalink: zod_1.z.string().optional(),
                text: zod_1.z.string().optional(),
            }))
                .optional()
                .describe('Map of [mN] tag → { ts, permalink, text } for exact-message citations'),
            authors: zod_1.z
                .record(zod_1.z.string(), zod_1.z.string())
                .optional()
                .describe('Map of display name → Slack user id, so Person nodes are @-mentionable'),
        },
    }, async ({ teamId, messages, channel, channelId, refs, authors }) => {
        dbg(`\n📨 ingest_messages · team ${teamId} · ${messages.split('\n').length} lines from ${channel || channelId || '?'}`);
        const deduped = await dedupeMessages(teamId, channelId, messages, refs);
        if (!deduped.messages.trim()) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `All ${deduped.skipped} message(s) were already ingested — nothing new.`,
                    },
                ],
            };
        }
        const result = await (0, extract_1.extractGraph)(deduped.messages);
        const store = await store_1.GraphStore.forTeam(teamId);
        store.ingest(result, { channel, channelId }, deduped.refs, authors);
        await store.saveTeam();
        const counts = {
            people: result.people?.length || 0,
            projects: result.projects?.length || 0,
            decisions: result.decisions?.length || 0,
            involvement: result.involvement?.length || 0,
            decisionEdges: result.decisionEdges?.length || 0,
        };
        const snap = store.snapshot();
        dbg(`🎉 ingest_messages done · ${snap.nodes.length} nodes · ${snap.edges.length} edges${deduped.skipped ? ` (skipped ${deduped.skipped} dup)` : ''}\n`);
        return {
            content: [
                {
                    type: 'text',
                    text: `Ingested. Extracted ${JSON.stringify(counts)}. Graph now has ${snap.nodes.length} nodes / ${snap.edges.length} edges.`,
                },
            ],
        };
    });
    server.registerTool('ask_graph', {
        title: 'Ask the knowledge graph',
        description: 'Answer a natural-language question. Handles expertise routing ("who do I talk to about X" — ranked by demonstrated involvement, not assignment) and decision provenance ("why did we decide X" — reasoning + dissent). Always returns sources.',
        inputSchema: { teamId: zod_1.z.string(), question: zod_1.z.string() },
    }, async ({ teamId, question }) => {
        dbg(`\n❓ ask_graph · team ${teamId} · "${question}"`);
        const store = await store_1.GraphStore.forTeam(teamId);
        const ans = await (0, answer_1.answerQuestion)(store, question);
        dbg(`💬 answered · ${ans.kind} · ${ans.sources.length} source(s)\n`);
        return {
            content: [
                { type: 'text', text: ans.text + (0, answer_1.formatSourcesForSlack)(ans.sources) },
            ],
        };
    });
    server.registerTool('get_graph_snapshot', {
        title: 'Get graph snapshot',
        description: 'Return the full graph (nodes + edges) as JSON, for the dashboard.',
        inputSchema: { teamId: zod_1.z.string() },
    }, async ({ teamId }) => {
        const store = await store_1.GraphStore.forTeam(teamId);
        const snap = store.snapshot();
        dbg(`get_graph_snapshot · team ${teamId} → ${snap.nodes.length} nodes / ${snap.edges.length} edges`);
        return { content: [{ type: 'text', text: JSON.stringify(snap) }] };
    });
    server.registerTool('set_person_ids', {
        title: 'Set person Slack ids',
        description: 'Backfill Slack user ids onto Person nodes by display name (from the bot workspace lookup), so answers can @-mention them. Only fills missing ids.',
        inputSchema: { teamId: zod_1.z.string(), ids: zod_1.z.record(zod_1.z.string(), zod_1.z.string()) },
    }, async ({ teamId, ids }) => {
        const store = await store_1.GraphStore.forTeam(teamId);
        const n = await store.setPersonIds(ids);
        dbg(`set_person_ids · team ${teamId} · patched ${n} person id(s)`);
        return { content: [{ type: 'text', text: `Patched ${n} person id(s).` }] };
    });
    server.registerTool('seed_demo', {
        title: 'Seed demo graph',
        description: 'Reset the graph to the deterministic demo scenario (no LLM needed).',
        inputSchema: { teamId: zod_1.z.string() },
    }, async ({ teamId }) => {
        dbg(`seed_demo · team ${teamId}`);
        const store = await store_1.GraphStore.forTeam(teamId);
        await (0, seed_1.seed)(store);
        return { content: [{ type: 'text', text: 'Demo graph seeded.' }] };
    });
    return server;
}
