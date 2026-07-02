"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.llmEnabled = exports.LLM_MODEL = void 0;
exports.chat = chat;
const openai_1 = __importDefault(require("openai"));
// Provider-agnostic chat client. Configured for Groq's OpenAI-compatible
// endpoint by default, but any OpenAI-compatible base URL works via env.
// hackathon shortcut: single shared client, no retry/backoff tuning.
const apiKey = process.env.GROQ_API_KEY || process.env.LLM_API_KEY;
const baseURL = process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1';
exports.LLM_MODEL = process.env.LLM_MODEL || 'llama-3.1-8b-instant';
exports.llmEnabled = Boolean(apiKey);
const client = apiKey ? new openai_1.default({ apiKey, baseURL }) : null;
async function chat(opts) {
    if (!client) {
        throw new Error('LLM not configured: set GROQ_API_KEY (or LLM_API_KEY) in mcp-server/.env');
    }
    const res = await client.chat.completions.create({
        model: exports.LLM_MODEL,
        temperature: opts.temperature ?? 0.1,
        response_format: opts.json ? { type: 'json_object' } : undefined,
        messages: [
            { role: 'system', content: opts.system },
            { role: 'user', content: opts.user },
        ],
    });
    return res.choices[0]?.message?.content ?? '';
}
