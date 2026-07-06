import OpenAI from 'openai';

// Provider-agnostic chat client. Configured for Groq's OpenAI-compatible
// endpoint by default, but any OpenAI-compatible base URL works via env.

const apiKey = process.env.GROQ_API_KEY || process.env.LLM_API_KEY;
const baseURL = process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1';

export const LLM_MODEL = process.env.LLM_MODEL || 'llama-3.1-8b-instant';

export const llmEnabled = Boolean(apiKey);

const client = apiKey ? new OpenAI({ apiKey, baseURL, maxRetries: 0 }) : null;

export interface ChatOptions {
  system: string;
  user: string;
  json?: boolean; // request JSON object output
  temperature?: number;
}

function rateLimitWaitMs(err: unknown): number | null {
  const e = err as { status?: number; headers?: Record<string, string> };
  if (e?.status !== 429) return null;
  const ra = e.headers?.['retry-after'];
  const secs = ra != null ? Number(ra) : NaN;
  if (!Number.isNaN(secs)) return Math.ceil(secs * 1000) + 500; // small buffer
  return 5000;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_RATE_LIMIT_RETRIES = 4;
const MAX_WAIT_MS = 35_000; // never hang a single call absurdly long

export async function chat(opts: ChatOptions): Promise<string> {
  if (!client) {
    throw new Error(
      'LLM not configured: set GROQ_API_KEY (or LLM_API_KEY) in mcp-server/.env',
    );
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await client.chat.completions.create({
        model: LLM_MODEL,
        temperature: opts.temperature ?? 0.1,
        response_format: opts.json ? { type: 'json_object' } : undefined,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
      });
      return res.choices[0]?.message?.content ?? '';
    } catch (err) {
      const waitMs = rateLimitWaitMs(err);
      if (waitMs == null || attempt >= MAX_RATE_LIMIT_RETRIES) throw err;
      const capped = Math.min(waitMs, MAX_WAIT_MS);
      console.error(
        `[se3k:llm] 429 rate-limited — retry ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES} in ${Math.round(
          capped / 1000,
        )}s`,
      );
      await sleep(capped);
    }
  }
}
