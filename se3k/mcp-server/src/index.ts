import 'dotenv/config';
import { randomUUID } from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './mcpTools';
import { asyncHandler } from './http/asyncHandler';
import { requireInternalSecret } from './http/auth';
import { rest } from './http/rest';

const dbg = (...args: unknown[]) => console.error('[se3k:mcp]', ...args);

const app = express();
app.use(express.json());
app.use(requireInternalSecret);

// Session-managed Streamable HTTP (the standard MCP SDK pattern — see
// @modelcontextprotocol/sdk's examples/server/simpleStreamableHttp.js): a new
// McpServer + transport per session (slack-bot holds exactly one session for
// its whole process lifetime), reused across every subsequent tool call in
// that session via the Mcp-Session-Id header. This is what slack-bot now
// connects to over HTTP instead of spawning this process via stdio — the
// switch that lets `web` also reach this same persistently-running process
// via the REST routes mounted below.
const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.header('mcp-session-id');
  try {
    let transport: StreamableHTTPServerTransport;
    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          dbg(`session initialized: ${sid}`);
          transports[sid] = transport;
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          dbg(`session closed: ${sid}`);
          delete transports[sid];
        }
      };
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[se3k:mcp] error handling MCP request:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

app.get('/mcp', asyncHandler(handleSessionRequest));
app.delete('/mcp', asyncHandler(handleSessionRequest));

async function handleSessionRequest(req: Request, res: Response) {
  const sessionId = req.header('mcp-session-id');
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  await transports[sessionId].handleRequest(req, res);
}

app.use(rest);

// Last-resort net: without this, an async route handler's rejected promise
// is an unhandled rejection that crashes the whole process — one bad DB
// query would take down every workspace, not just fail one request.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[se3k:http] unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'internal server error' });
  }
});

const PORT = Number(process.env.MCP_PORT) || 4000;
app.listen(PORT, () => {
  dbg(`🧠 SE3K brain online · HTTP :${PORT} (MCP over Streamable HTTP + REST)`);
});
