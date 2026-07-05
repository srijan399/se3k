"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const crypto_1 = require("crypto");
const express_1 = __importDefault(require("express"));
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const mcpTools_1 = require("./mcpTools");
const asyncHandler_1 = require("./http/asyncHandler");
const auth_1 = require("./http/auth");
const rest_1 = require("./http/rest");
const dbg = (...args) => console.error('[se3k:mcp]', ...args);
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.use(auth_1.requireInternalSecret);
// Session-managed Streamable HTTP (the standard MCP SDK pattern — see
// @modelcontextprotocol/sdk's examples/server/simpleStreamableHttp.js): a new
// McpServer + transport per session (slack-bot holds exactly one session for
// its whole process lifetime), reused across every subsequent tool call in
// that session via the Mcp-Session-Id header. This is what slack-bot now
// connects to over HTTP instead of spawning this process via stdio — the
// switch that lets `web` also reach this same persistently-running process
// via the REST routes mounted below.
const transports = {};
app.post('/mcp', async (req, res) => {
    const sessionId = req.header('mcp-session-id');
    try {
        let transport;
        if (sessionId && transports[sessionId]) {
            transport = transports[sessionId];
        }
        else if (!sessionId && (0, types_js_1.isInitializeRequest)(req.body)) {
            transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
                sessionIdGenerator: () => (0, crypto_1.randomUUID)(),
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
            const server = (0, mcpTools_1.createMcpServer)();
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            return;
        }
        else {
            res.status(400).json({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
                id: null,
            });
            return;
        }
        await transport.handleRequest(req, res, req.body);
    }
    catch (err) {
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
app.get('/mcp', (0, asyncHandler_1.asyncHandler)(handleSessionRequest));
app.delete('/mcp', (0, asyncHandler_1.asyncHandler)(handleSessionRequest));
async function handleSessionRequest(req, res) {
    const sessionId = req.header('mcp-session-id');
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }
    await transports[sessionId].handleRequest(req, res);
}
app.use(rest_1.rest);
// Last-resort net: without this, an async route handler's rejected promise
// is an unhandled rejection that crashes the whole process — one bad DB
// query would take down every workspace, not just fail one request.
app.use((err, _req, res, _next) => {
    console.error('[se3k:http] unhandled error:', err);
    if (!res.headersSent) {
        res.status(500).json({ error: 'internal server error' });
    }
});
const PORT = Number(process.env.MCP_PORT) || 4000;
app.listen(PORT, () => {
    dbg(`🧠 SE3K brain online · HTTP :${PORT} (MCP over Streamable HTTP + REST)`);
});
