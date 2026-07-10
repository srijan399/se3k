import OpenAI from 'openai';

// Provider-agnostic chat client. Configured for Groq's OpenAI-compatible
// endpoint by default, but any OpenAI-compatible base URL works via env.

const baseURL = process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1';

export const LLM_MODEL = process.env.LLM_MODEL || 'llama-3.1-8b-instant';

// GROQ_API_KEY can be a single key, or a pool for rotation across multiple
// keys' rate limits: "[key1,key2,key3]" or plain "key1,key2".
function parseKeyPool(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  const inner =
    trimmed.startsWith('[') && trimmed.endsWith(']')
      ? trimmed.slice(1, -1)
      : trimmed;
  return inner
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

const keyPool = parseKeyPool(process.env.GROQ_API_KEY || process.env.LLM_API_KEY);

export const llmEnabled = keyPool.length > 0;

// One client per key, so each key's own rate-limit state stays isolated.
const clients = keyPool.map((apiKey) => new OpenAI({ apiKey, baseURL, maxRetries: 0 }));

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

// Picks a random key not yet tried this call (resets once every key has
// been tried, so a subsequent wait-and-retry round can reuse any of them).
function pickUntried(tried: Set<number>): number {
  if (tried.size >= clients.length) tried.clear();
  const remaining = clients.map((_, i) => i).filter((i) => !tried.has(i));
  const index = remaining[Math.floor(Math.random() * remaining.length)];
  tried.add(index);
  return index;
}

export async function chat(opts: ChatOptions): Promise<string> {
  if (clients.length === 0) {
    throw new Error(
      'LLM not configured: set GROQ_API_KEY (or LLM_API_KEY) in mcp-server/.env',
    );
  }
  const tried = new Set<number>();
  for (let waitAttempt = 0; ; ) {
    const index = pickUntried(tried);
    try {
      const res = await clients[index].chat.completions.create({
        model: LLM_MODEL,
        temperature: opts.temperature ?? 0.1,
        max_tokens: 4096,
        response_format: opts.json ? { type: 'json_object' } : undefined,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
      });
      return res.choices[0]?.message?.content ?? '';
    } catch (err) {
      const waitMs = rateLimitWaitMs(err);
      if (waitMs == null) throw err;
      if (tried.size < clients.length) {
        // other keys in the pool haven't been tried yet this call — rotate
        // to one of them immediately, no backoff needed.
        console.error(
          `[se3k:llm] 429 on key ${index + 1}/${clients.length} — rotating to another key`,
        );
        continue;
      }
      // every key is currently rate-limited — fall back to waiting.
      if (waitAttempt >= MAX_RATE_LIMIT_RETRIES) throw err;
      const capped = Math.min(waitMs, MAX_WAIT_MS);
      console.error(
        `[se3k:llm] all ${clients.length} key(s) rate-limited — retry ${waitAttempt + 1}/${MAX_RATE_LIMIT_RETRIES} in ${Math.round(
          capped / 1000,
        )}s`,
      );
      await sleep(capped);
      waitAttempt++;
      tried.clear();
    }
  }
}
