\*# SE3K — Slack Org Brain

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
ingestion + query brain; Slack AI = the `/ask-graph` agent; Real-Time Search =
channel-join backfill (wire into `ingest_messages`).

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

Create the Slack app from `slack-bot/manifest.json` (Socket Mode + the two slash
commands). Invite the bot to a channel; messages buffer and auto-flush into the
graph every few messages (or `/se3k-ingest` to flush on demand).

## LLM provider

Provider-agnostic via an OpenAI-compatible endpoint, configured for **Groq** by
default (`GROQ_API_KEY`, `llama-3.3-70b-versatile`). Override with `LLM_BASE_URL`
/ `LLM_MODEL`. Without a key, the demo still answers from the seeded graph (the
plan's insurance policy).

## Scope (frozen)

Nodes: `Person`, `Project`, `Decision` (+ `Channel` for citations).
Edges: `INVOLVED_IN` (weighted + timestamped — the core mechanism),
`RAISED_CONCERN`, `MADE_CALL`, `RELATES_TO`. Do not expand without flagging.

-
