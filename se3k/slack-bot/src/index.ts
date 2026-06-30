import { App, LogLevel } from '@slack/bolt';
import dotenv from 'dotenv';
import { mcp } from './mcpClient';

dotenv.config();

const { SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET } = process.env;

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN || !SLACK_SIGNING_SECRET) {
  throw new Error(
    'Missing one or more required env vars: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET',
  );
}

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

// ---------------------------------------------------------------------------
// Ingestion: buffer real-time messages per channel and flush them to the MCP
// extraction tool in batches (cheaper + better extraction context than 1-by-1).
// hackathon shortcut: in-memory buffer, lost on restart — fine for a demo.
// ---------------------------------------------------------------------------

const BATCH_SIZE = 6;
const buffers = new Map<string, string[]>(); // channelId -> formatted lines
const channelNames = new Map<string, string>();

async function flush(channelId: string) {
  const lines = buffers.get(channelId);
  if (!lines || lines.length === 0) return;
  buffers.set(channelId, []);
  const channel = channelNames.get(channelId) || channelId;
  try {
    const res = await mcp.ingest(lines.join('\n'), `#${channel}`, channelId);
    console.log(`📥 ingested ${lines.length} msgs from #${channel}: ${res}`);
  } catch (err) {
    console.error('ingest failed:', err);
  }
}

app.message(async ({ message }) => {
  const m = message as {
    type?: string;
    subtype?: string;
    user?: string;
    text?: string;
    channel?: string;
    ts?: string;
  };
  if (m.subtype || !m.user || !m.text || !m.channel) return;

  const line = `${m.user} [${new Date(Number(m.ts) * 1000).toISOString()}]: ${m.text}`;
  const buf = buffers.get(m.channel) || [];
  buf.push(line);
  buffers.set(m.channel, buf);
  if (buf.length >= BATCH_SIZE) await flush(m.channel);
});

// ---------------------------------------------------------------------------
// Querying: slash command + @mention both route to ask_graph.
// ---------------------------------------------------------------------------

async function answer(question: string): Promise<string> {
  if (!question.trim()) {
    return 'Ask me *who actually knows about X* (expertise routing) or *why we decided X* (decision provenance). Example: `/ask-graph who do I talk to about rate limiting?`';
  }
  try {
    return await mcp.ask(question);
  } catch (err) {
    console.error('ask failed:', err);
    return "Sorry — I couldn't reach the knowledge graph just now.";
  }
}

app.command('/ask-graph', async ({ command, ack, respond }) => {
  await ack();
  const reply = await answer(command.text);
  await respond({ text: reply, response_type: 'in_channel' });
});

// Manual flush helper for the demo ("watch the graph update").
app.command('/se3k-ingest', async ({ command, ack, respond }) => {
  await ack();
  await flush(command.channel_id);
  await respond({
    text: '✅ Flushed pending messages into the knowledge graph.',
    response_type: 'ephemeral',
  });
});

app.event('app_mention', async ({ event, say }) => {
  const text = (event.text || '').replace(/<@[^>]+>/g, '').trim();
  const reply = await answer(text);
  await say({ text: reply, thread_ts: event.thread_ts || event.ts });
});

(async () => {
  await app.start();
  console.log('⚡️ SE3K bot is running in Socket Mode');
})();
