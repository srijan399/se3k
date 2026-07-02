# SE3K — Slack Org Brain

> _"Who actually knows this?" — not who's assigned to it._

A Slack agent for the **Slack Agent Builder Challenge**. It turns Slack
conversation history into a queryable knowledge graph and answers two questions
that neither Jira nor a plain summarizer can:

1. **Expertise routing** — _"who do I talk to about X?"_ → returns the person
   with the strongest **demonstrated** involvement (who debugged/fixed/reviewed
   it, recently), ranked by a weighted `INVOLVED_IN` edge — **not** the formal
   assignee. With sources.
2. **Decision provenance** — _"why did we decide X?"_ → returns the reasoning
   and dissent (who pushed back, who made the final call), not just the outcome.

## Architecture

```
Slack workspace
   │  messages / @mention / /ask-graph
   ▼
slack-bot/        Bolt.js (Socket Mode)  ── acts as an MCP client ──┐
                                                                     ▼
mcp-server/       MCP server (stdio): tools = ingest_messages, ask_graph,
                  get_graph_snapshot, seed_demo
                    ├─ llm/extract.ts   messages → entities/edges JSON (Groq)
                    ├─ llm/answer.ts    question → grounded, sourced answer
                    └─ graph/store.ts   in-memory graph, weighted INVOLVED_IN
                                            │ persists
                                            ▼
graph-store/graph.json   ← single source of truth →   web/  Next.js dashboard
                                                       (force-graph viz, /api/graph)
```

**Where each required tech lives:** MCP server integration = the whole
ingestion + query brain; Slack AI = the `/ask-graph` agent; history backfill =
`conversations.history` pulled automatically when the bot joins a channel.

## Run order

```bash
# 1. MCP server (the brain) — build it so the bot can spawn it
cd mcp-server
cp .env.example .env        # add GROQ_API_KEY for live extraction (optional)
pnpm install
pnpm build
pnpm seed                   # load the deterministic demo graph

# quick local sanity check (no Slack needed):
pnpm ask "who do I talk to about rate limiting?"
pnpm ask "why did we drop the redis rate limiter?"

# 2. Slack bot (needs SLACK_BOT_TOKEN / SLACK_APP_TOKEN / SLACK_SIGNING_SECRET in .env)
cd ../slack-bot
pnpm install
pnpm dev                    # spawns the built MCP server over stdio

# 3. Dashboard
cd ../../web
pnpm install
pnpm dev                    # http://localhost:3000  → live graph
```

Create the Slack app from `slack-bot/manifest.json` (Socket Mode + slash commands
+ the `member_joined_channel` event). Invite the bot to a channel — that's it.

## Ingestion & answering

**Ingestion is automatic.** When the bot is added to a channel it backfills
recent history (`conversations.history`); after that, new messages are buffered
per channel and flushed into the graph on a short inactivity timer (~20s) or once
a batch fills — no manual step. Display names are resolved via `users.info` so
`Person` nodes read "Priya Nair", not `U08…`; trivial messages (emoji/"+1"/the
bot's own replies) are filtered, and every message is de-duped by timestamp so
nothing is ingested twice.

**Big threads don't blow the context window.** `llm/extract.ts` splits any blob
into bounded chunks (`EXTRACT_MAX_LINES` / `EXTRACT_MAX_CHARS`, ~1.5k tokens
each), extracts each with a separate LLM call, and merges — the graph accumulates
weights, so chunk-then-merge is lossless for ranking.

**Answering resolves robustly.** `ask_graph` first routes the question to one
graph node using a *compact catalog* of node labels only (no message bodies —
cheap + accurate), then runs the deterministic ranking / provenance and phrases
the grounded facts with citations. **Each citation is a clickable permalink to
the exact Slack message** (the bot passes real message ts + permalink alongside
each `[mN]`-tagged line, so proof is one click away). Falls back to keyword
matching with no key.

**⚡ Semantic answer cache.** Before spending any tokens, `ask_graph` embeds the
question (via the [Jina](https://jina.ai/embeddings) API) and checks a cache of
previously-answered questions. A semantically-similar hit — _"who knows the
checkout timeouts?"_ vs _"who should I ping about checkout latency?"_ — is served
**instantly with zero LLM calls**. Entries are tagged with a graph content
signature, so any new ingestion silently invalidates them and answers never go
stale. Set `JINA_API_KEY` to enable; without it the cache is simply a no-op.

Manual controls (optional): `/se3k-ingest` flushes pending messages now;
`/se3k-backfill [count]` re-ingests recent history on demand.

## LLM provider

Provider-agnostic via an OpenAI-compatible endpoint, configured for **Groq** by
default (`GROQ_API_KEY`, `llama-3.1-8b-instant`). Override with `LLM_BASE_URL`
/ `LLM_MODEL`. Without a key, the demo still answers from the seeded graph (the
plan's insurance policy).

## Scope (frozen)

Nodes: `Person`, `Project`, `Decision` (+ `Channel` for citations).
Edges: `INVOLVED_IN` (weighted + timestamped — the core mechanism),
`RAISED_CONCERN`, `MADE_CALL`, `RELATES_TO`. Do not expand without flagging.

See [TESTING.md](./TESTING.md) for a step-by-step live test flow.
