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

const store = new GraphStore();

const server = new McpServer({
  name: 'se3k-mcp-server',
  version: '0.2.0',
});

server.registerTool(
  'ping',
  {
    title: 'Ping',
    description: 'Returns pong. Verifies the MCP server is alive and callable.',
    inputSchema: { message: z.string().optional() },
  },
  async ({ message }) => ({
    content: [{ type: 'text', text: `pong${message ? `: ${message}` : ''}` }],
  }),
);

server.registerTool(
  'ingest_messages',
  {
    title: 'Ingest Slack messages',
    description:
      'Run LLM extraction over a batch of Slack messages and merge the resulting people/projects/decisions and weighted INVOLVED_IN edges into the graph. Pass the messages as a single text blob (one per line, ideally "Name [channel @ ts]: text").',
    inputSchema: {
      messages: z.string().describe('Raw Slack messages, newline-separated'),
      channel: z
        .string()
        .optional()
        .describe('Human-readable channel name, e.g. #backend'),
      channelId: z.string().optional(),
    },
  },
  async ({ messages, channel, channelId }) => {
    const result = await extractGraph(messages);
    store.ingest(result, { channel, channelId });
    store.save();
    const counts = {
      people: result.people?.length || 0,
      projects: result.projects?.length || 0,
      decisions: result.decisions?.length || 0,
      involvement: result.involvement?.length || 0,
      decisionEdges: result.decisionEdges?.length || 0,
    };
    return {
      content: [
        {
          type: 'text',
          text: `Ingested. Extracted ${JSON.stringify(counts)}. Graph now has ${
            store.snapshot().nodes.length
          } nodes / ${store.snapshot().edges.length} edges.`,
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
      'Answer a natural-language question. Handles two behaviors: expertise routing ("who do I talk to about X" — ranked by demonstrated involvement, not assignment) and decision provenance ("why did we decide X" — reasoning + dissent). Always returns sources.',
    inputSchema: { question: z.string() },
  },
  async ({ question }) => {
    store.load();
    const ans = await answerQuestion(store, question);
    return {
      content: [
        { type: 'text', text: ans.text + formatSourcesForSlack(ans.sources) },
      ],
    };
  },
);

server.registerTool(
  'get_graph_snapshot',
  {
    title: 'Get graph snapshot',
    description:
      'Return the full graph (nodes + edges) as JSON, for the dashboard.',
    inputSchema: {},
  },
  async () => {
    store.load();
    return {
      content: [{ type: 'text', text: JSON.stringify(store.snapshot()) }],
    };
  },
);

server.registerTool(
  'seed_demo',
  {
    title: 'Seed demo graph',
    description:
      'Reset the graph to the deterministic demo scenario (no LLM needed).',
    inputSchema: {},
  },
  async () => {
    seed(store);
    return { content: [{ type: 'text', text: 'Demo graph seeded.' }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('SE3K MCP server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error starting MCP server:', err);
  process.exit(1);
});
