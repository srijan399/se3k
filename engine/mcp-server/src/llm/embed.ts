// Question embeddings via the Jina API (https://jina.ai/embeddings) — used only
// by the semantic answer cache. No npm dependency: Node's global fetch is enough.
// STDOUT is the MCP JSON-RPC transport, so debug goes to stderr.
const dbg = (...args: unknown[]) => console.error('[se3k:embed]', ...args);

const JINA_API_KEY = process.env.JINA_API_KEY;
const JINA_URL = process.env.JINA_EMBED_URL || 'https://api.jina.ai/v1/embeddings';
const JINA_MODEL = process.env.JINA_EMBED_MODEL || 'jina-embeddings-v3';

export const embeddingsEnabled = Boolean(JINA_API_KEY);

// Embed one string → vector, or null if embeddings are unavailable/failed
// (callers treat null as "cache disabled", so answering still works).
export async function embed(text: string): Promise<number[] | null> {
  if (!JINA_API_KEY) return null;
  try {
    const res = await fetch(JINA_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${JINA_API_KEY}`,
      },
      body: JSON.stringify({
        model: JINA_MODEL,
        task: 'text-matching', // symmetric similarity between two questions
        input: [text],
      }),
    });
    if (!res.ok) {
      dbg(`Jina HTTP ${res.status}: ${await res.text()}`);
      return null;
    }
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const vec = json.data?.[0]?.embedding;
    return Array.isArray(vec) ? vec : null;
  } catch (err) {
    dbg('embed failed:', err);
    return null;
  }
}
