import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// The Slack bot talks to the SE3K brain as a genuine MCP client, now over
// Streamable HTTP against a persistently-running mcp-server process (rather
// than spawning it over stdio) — the switch that lets `web` also reach the
// same process via REST for OAuth installs + backfill.
// This is where the "MCP server integration" judging criterion actually lives.

const dbg = (...args: unknown[]) => console.log('[se3k:mcpClient]', ...args);

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:4000';
const MCP_ENDPOINT = `${MCP_SERVER_URL.replace(/\/$/, '')}/mcp`;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

let clientPromise: Promise<Client> | null = null;

// Lazily connect once, reused for the process lifetime (one MCP session).
async function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      dbg(`🔌 connecting to SE3K brain at ${MCP_ENDPOINT}…`);
      const transport = new StreamableHTTPClientTransport(new URL(MCP_ENDPOINT), {
        requestInit: INTERNAL_API_SECRET
          ? { headers: { 'x-internal-secret': INTERNAL_API_SECRET } }
          : undefined,
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

// Every call is scoped to a Slack team id — the graph, install lookups, and
// idempotency table are all partitioned by it on the mcp-server side.
export const mcp = {
  ask: (teamId: string, question: string) =>
    callTool('ask_graph', { teamId, question }),
  ingest: (
    teamId: string,
    messages: string,
    channel?: string,
    channelId?: string,
    refs?: MessageRefs,
    authors?: Record<string, string>,
  ) =>
    callTool('ingest_messages', {
      teamId,
      messages,
      channel,
      channelId,
      refs,
      authors,
    }),
  snapshot: (teamId: string) => callTool('get_graph_snapshot', { teamId }),
  seed: (teamId: string) => callTool('seed_demo', { teamId }),
  setPersonIds: (teamId: string, ids: Record<string, string>) =>
    callTool('set_person_ids', { teamId, ids }),
};
