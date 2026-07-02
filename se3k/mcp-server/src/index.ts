import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { GraphStore } from './graph/store';
import { extractGraph } from './llm/extract';
import { answerQuestion, formatSourcesForSlack } from './llm/answer';
import { seed } from './seed';

// SE3K MCP server — the "brain". Owns the graph and exposes the tools the Slack
// bot calls: ingest messages, ask the graph, get a snapshot, (re)seed the demo.
//
// STDOUT is the JSON-RPC transport, so every log MUST go to stderr (console.error).
const dbg = (...args: unknown[]) => console.error('[se3k:mcp]', ...args);

const store = new GraphStore();

const server = new McpServer({ name: 'se3k-mcp-server', version: '0.2.0' });

server.registerTool(
  'ping',
  {
    title: 'Ping',
    description: 'Returns pong. Verifies the MCP server is alive and callable.',
    inputSchema: { message: z.string().optional() },
  },
  async ({ message }) => {
    dbg('ping', message ?? '');
    return { content: [{ type: 'text', text: `pong${message ? `: ${message}` : ''}` }] };
  },
);

server.registerTool(
  'ingest_messages',
  {
    title: 'Ingest Slack messages',
    description:
      'Run LLM extraction over a batch of Slack messages and merge the resulting people/projects/decisions and weighted INVOLVED_IN edges into the graph. Messages are one per line, each prefixed with a [mN] tag.',
    inputSchema: {
      messages: z.string().describe('Raw Slack messages, newline-separated, each prefixed with [mN]'),
      channel: z.string().optional().describe('Human-readable channel name, e.g. #backend'),
      channelId: z.string().optional(),
      refs: z
        .record(
          z.string(),
          z.object({
            ts: z.string().optional(),
            permalink: z.string().optional(),
            text: z.string().optional(),
          }),
        )
        .optional()
        .describe('Map of [mN] tag → { ts, permalink, text } for exact-message citations'),
      authors: z
        .record(z.string(), z.string())
        .optional()
        .describe('Map of display name → Slack user id, so Person nodes are @-mentionable'),
    },
  },
  async ({ messages, channel, channelId, refs, authors }) => {
    dbg(`ingest_messages: ${messages.split('\n').length} lines from ${channel || channelId || '?'}`);
    const result = await extractGraph(messages);
    store.ingest(result, { channel, channelId }, refs, authors);
    store.save();
    const counts = {
      people: result.people?.length || 0,
      projects: result.projects?.length || 0,
      decisions: result.decisions?.length || 0,
      involvement: result.involvement?.length || 0,
      decisionEdges: result.decisionEdges?.length || 0,
    };
    const snap = store.snapshot();
    dbg('ingest_messages done', counts, `→ ${snap.nodes.length} nodes / ${snap.edges.length} edges`);
    return {
      content: [
        {
          type: 'text',
          text: `Ingested. Extracted ${JSON.stringify(counts)}. Graph now has ${snap.nodes.length} nodes / ${snap.edges.length} edges.`,
        },
      ],
    };
  },
);

server.registerTool(
  'ask_graph',
  {
    title: 'Ask the knowledge graph',
    description:
      'Answer a natural-language question. Handles expertise routing ("who do I talk to about X" — ranked by demonstrated involvement, not assignment) and decision provenance ("why did we decide X" — reasoning + dissent). Always returns sources.',
    inputSchema: { question: z.string() },
  },
  async ({ question }) => {
    dbg(`ask_graph: "${question}"`);
    store.load(); // pick up writes from other processes
    const ans = await answerQuestion(store, question);
    dbg(`ask_graph → kind=${ans.kind}, ${ans.sources.length} source(s)`);
    return {
      content: [{ type: 'text', text: ans.text + formatSourcesForSlack(ans.sources) }],
    };
  },
);

server.registerTool(
  'get_graph_snapshot',
  {
    title: 'Get graph snapshot',
    description: 'Return the full graph (nodes + edges) as JSON, for the dashboard.',
    inputSchema: {},
  },
  async () => {
    store.load();
    const snap = store.snapshot();
    dbg(`get_graph_snapshot → ${snap.nodes.length} nodes / ${snap.edges.length} edges`);
    return { content: [{ type: 'text', text: JSON.stringify(snap) }] };
  },
);

server.registerTool(
  'set_person_ids',
  {
    title: 'Set person Slack ids',
    description:
      'Backfill Slack user ids onto Person nodes by display name (from the bot workspace lookup), so answers can @-mention them. Only fills missing ids.',
    inputSchema: { ids: z.record(z.string(), z.string()) },
  },
  async ({ ids }) => {
    store.load();
    const n = store.setPersonIds(ids);
    dbg(`set_person_ids: patched ${n} person id(s)`);
    return { content: [{ type: 'text', text: `Patched ${n} person id(s).` }] };
  },
);

server.registerTool(
  'seed_demo',
  {
    title: 'Seed demo graph',
    description: 'Reset the graph to the deterministic demo scenario (no LLM needed).',
    inputSchema: {},
  },
  async () => {
    dbg('seed_demo');
    seed(store);
    return { content: [{ type: 'text', text: 'Demo graph seeded.' }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  dbg('SE3K MCP server running on stdio');
}

main().catch((err) => {
  console.error('[se3k:mcp] Fatal error starting MCP server:', err);
  process.exit(1);
});
