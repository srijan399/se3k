import { AnswerResult } from '../llm/answer';
import { embed, embeddingsEnabled } from '../llm/embed';

// Semantic answer cache: if a semantically-similar question was already answered
// against the CURRENT graph, return that answer with zero LLM calls. In-memory,
// lives for the MCP server process (which the bot spawns once).
// STDOUT is the MCP JSON-RPC transport, so debug goes to stderr.
const dbg = (...args: unknown[]) => console.error('[se3k:cache]', ...args);

// 0.72 empirically separates rewordings of the same question (~0.76-0.81 with
// jina-embeddings-v3 text-matching) from different topics (≤ ~0.58) — see the
// verification notes. Tune via env if your questions cluster differently.
const THRESHOLD = Number(process.env.SEMANTIC_CACHE_THRESHOLD) || 0.72;
const MAX = Number(process.env.SEMANTIC_CACHE_MAX) || 200;

interface Entry {
  vec: number[];
  question: string;
  result: AnswerResult;
  version: string; // graph content signature this answer was computed against
}

const entries: Entry[] = [];

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Look for a cached answer to a semantically-similar question at this graph
// version. Returns the hit (if any) plus the question's embedding, so the caller
// can hand it back to store() on a miss without embedding twice.
export async function lookup(
  question: string,
  version: string,
): Promise<{ result: AnswerResult | null; embedding: number[] | null }> {
  if (!embeddingsEnabled) return { result: null, embedding: null };
  const vec = await embed(question);
  if (!vec) return { result: null, embedding: null };

  let best: { entry: Entry; score: number } | null = null;
  for (const e of entries) {
    if (e.version !== version) continue; // stale (graph changed) — ignore
    const score = cosine(vec, e.vec);
    if (!best || score > best.score) best = { entry: e, score };
  }
  if (best && best.score >= THRESHOLD) {
    dbg(`HIT (${best.score.toFixed(3)}) "${question}" ↦ "${best.entry.question}"`);
    return { result: best.entry.result, embedding: vec };
  }
  dbg(`MISS${best ? ` (best ${best.score.toFixed(3)})` : ''} "${question}"`);
  return { result: null, embedding: vec };
}

// Remember an answer. Reuses the embedding computed during lookup when provided.
export async function store(
  question: string,
  result: AnswerResult,
  version: string,
  embedding: number[] | null,
): Promise<void> {
  if (!embeddingsEnabled) return;
  const vec = embedding || (await embed(question));
  if (!vec) return;
  entries.push({ vec, question, result, version });
  if (entries.length > MAX) entries.splice(0, entries.length - MAX); // drop oldest
  dbg(`stored "${question}" (${entries.length}/${MAX})`);
}
