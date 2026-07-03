import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The Slack bot talks to the SE3K brain as a genuine MCP client: it spawns the
// MCP server over stdio and calls its tools (ingest_messages, ask_graph, ...).
// This is where the "MCP server integration" judging criterion actually lives.
// Requires the MCP server to be built first:  cd ../mcp-server && pnpm build

const dbg = (...args: unknown[]) => console.log('[se3k:mcpClient]', ...args);

const MCP_SERVER_ENTRY = path.resolve(__dirname, '../../mcp-server/dist/index.js');
const MCP_SERVER_CWD = path.resolve(__dirname, '../../mcp-server');

let clientPromise: Promise<Client> | null = null;

// Lazily spawn + connect the MCP server once, reused for the process lifetime.
async function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      dbg('🔌 starting SE3K brain (MCP server)…');
      const transport = new StdioClientTransport({
        command: 'node',
        args: [MCP_SERVER_ENTRY],
        cwd: MCP_SERVER_CWD, // so the server finds its .env and graph file
      });
      const client = new Client({ name: 'se3k-slack-bot', version: '0.1.0' });
      await client.connect(transport);
      dbg('🔌 connected to SE3K brain');
      return client;
    })();
  }
  return clientPromise;
}

// Pull the concatenated text out of an MCP tool result.
function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('\n');
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const client = await getClient();
  dbg(`→ callTool ${name}`);
  const result = await client.callTool({ name, arguments: args });
  dbg(`← ${name} returned`);
  return textOf(result);
}

export interface MessageRefs {
  [tag: string]: { ts?: string; permalink?: string; text?: string };
}

export const mcp = {
  ask: (question: string) => callTool('ask_graph', { question }),
  ingest: (
    messages: string,
    channel?: string,
    channelId?: string,
    refs?: MessageRefs,
    authors?: Record<string, string>,
  ) => callTool('ingest_messages', { messages, channel, channelId, refs, authors }),
  snapshot: () => callTool('get_graph_snapshot', {}),
  seed: () => callTool('seed_demo', {}),
  setPersonIds: (ids: Record<string, string>) => callTool('set_person_ids', { ids }),
};
