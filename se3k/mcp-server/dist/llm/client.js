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
// Groq counts requested tokens as prompt + reserved completion against the TPM
// limit. Without a cap it reserves the model's full max output (~8k) and a tiny
// prompt can 413 on the free tier. Keep this bounded; callers override as needed.
const DEFAULT_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS) || 2048;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function chat(opts) {
    if (!client) {
        throw new Error('LLM not configured: set GROQ_API_KEY (or LLM_API_KEY) in mcp-server/.env');
    }
    // Groq's free tier is per-minute (TPM). When we hit it the API returns 429
    // with a Retry-After header — wait it out and retry instead of failing the
    // whole ingest. The max_tokens cap above prevents the separate 413 case.
    const MAX_ATTEMPTS = 6;
    for (let attempt = 1;; attempt++) {
        try {
            const res = await client.chat.completions.create({
                model: exports.LLM_MODEL,
                temperature: opts.temperature ?? 0.1,
                max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
                response_format: opts.json ? { type: 'json_object' } : undefined,
                messages: [
                    { role: 'system', content: opts.system },
                    { role: 'user', content: opts.user },
                ],
            });
            return res.choices[0]?.message?.content ?? '';
        }
        catch (err) {
            const status = err?.status ?? err?.response?.status;
            if (status !== 429 || attempt >= MAX_ATTEMPTS)
                throw err;
            // Honor Retry-After (seconds) when present; else exponential backoff.
            const hdr = Number(err?.headers?.['retry-after']);
            const waitMs = Number.isFinite(hdr) && hdr > 0
                ? hdr * 1000 + 500
                : Math.min(2 ** attempt * 1000, 30000);
            console.error(`chat: rate limited (429), waiting ${Math.round(waitMs / 1000)}s then retry ${attempt}/${MAX_ATTEMPTS - 1}`);
            await sleep(waitMs);
        }
    }
}
