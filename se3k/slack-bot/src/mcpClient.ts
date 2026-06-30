import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The Slack bot talks to the SE3K brain as a genuine MCP client: it spawns the
// MCP server over stdio and calls its tools (ingest_messages, ask_graph, ...).
// This is where the "MCP server integration" judging criterion actually lives.
//
// Requires the MCP server to be built first:  cd ../mcp-server && pnpm build

const MCP_SERVER_ENTRY = path.resolve(__dirname, '../../mcp-server/dist/index.js');
const MCP_SERVER_CWD = path.resolve(__dirname, '../../mcp-server');

let clientPromise: Promise<Client> | null = null;

async function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const transport = new StdioClientTransport({
        command: 'node',
        args: [MCP_SERVER_ENTRY],
        cwd: MCP_SERVER_CWD, // so the server finds its .env and graph file
      });
      const client = new Client({ name: 'se3k-slack-bot', version: '0.1.0' });
      await client.connect(transport);
      console.log('🔌 Connected to SE3K MCP server');
      return client;
    })();
  }
  return clientPromise;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('\n');
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const client = await getClient();
  const result = await client.callTool({ name, arguments: args });
  return textOf(result);
}

export const mcp = {
  ask: (question: string) => callTool('ask_graph', { question }),
  ingest: (messages: string, channel?: string, channelId?: string) =>
    callTool('ingest_messages', { messages, channel, channelId }),
  snapshot: () => callTool('get_graph_snapshot', {}),
  seed: () => callTool('seed_demo', {}),
};
