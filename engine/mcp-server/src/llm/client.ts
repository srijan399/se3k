import OpenAI from 'openai';

// Provider-agnostic chat client. Configured for Groq's OpenAI-compatible
// endpoint by default, but any OpenAI-compatible base URL works via env.
// hackathon shortcut: single shared client, no retry/backoff tuning.

const apiKey = process.env.GROQ_API_KEY || process.env.LLM_API_KEY;
const baseURL = process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1';

export const LLM_MODEL = process.env.LLM_MODEL || 'llama-3.1-8b-instant';

export const llmEnabled = Boolean(apiKey);

const client = apiKey ? new OpenAI({ apiKey, baseURL }) : null;

export interface ChatOptions {
  system: string;
  user: string;
  json?: boolean; // request JSON object output
  temperature?: number;
}

export async function chat(opts: ChatOptions): Promise<string> {
  if (!client) {
    throw new Error(
      'LLM not configured: set GROQ_API_KEY (or LLM_API_KEY) in mcp-server/.env',
    );
  }
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
}
