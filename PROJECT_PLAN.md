# SE3K — Knowledge Graph Agent

### Hackathon Build Plan (Slack Agent Builder Challenge)

_"Who actually knows this?" — not who's assigned to it._

**Track:** Slack Agent for Organizations (fallback: New Slack Agent)
**Stack:** Next.js (frontend/dashboard), Node/TypeScript MCP server, Neo4j (or in-memory graph), Slack Bolt SDK, Claude/LLM for entity extraction
**Goal:** Build an agent that turns Slack conversation history into a queryable knowledge graph of people, projects, decisions, and channels — and lets users ask natural-language questions about "who knows what" and "what happened when."

## The Core Behavior (read this before building anything)

This project is anchored on ONE primary behavior. Every phase below should be evaluated against whether it serves this behavior — if a feature doesn't move the demo closer to this, deprioritize it.

**Primary behavior — Expertise Routing:** Given a question like _"who do I talk to about X?"_, the agent does NOT return the formally assigned owner (that's what Jira already does). It traces actual conversational involvement across channels and time — who replied the most, who posted the fix, who reviewed it last — and returns the person with the deepest _demonstrated_ hands-on context, with sources. This is the single behavior that is impossible for both a plain AI summarizer (no persistent cross-conversation memory) and Jira (only tracks formal assignment, not informal involvement) to replicate.

**Secondary behavior — Decision Provenance:** Given a question like _"why did we decide X?"_, the agent returns the _reasoning and dissent_ behind a decision (who raised what concern, what evidence was posted, who made the final call) — not just the outcome a ticket would show. Build this only after the primary behavior works end-to-end; it reuses the same graph schema.

**Explicitly out of scope for this hackathon:** "drift detection" (re-surfacing decisions being re-contested over time) — too time-risky for a live demo. Mention it as future work in the submission write-up for extra "Quality of the Idea" credit, but do not attempt to build it.

**The test for every demo question you pick:** could this be answered by reading a Jira ticket, or by summarizing one thread? If yes, throw it out — it doesn't prove your project's reason to exist.

---

## Phase 0 — Orientation & Scoping (Day 0, ~2-3 hrs)

Before writing code, get the moving parts straight in your head. This phase is about reducing ambiguity, since you're new to this category of project.

- [ ] **Understand the three required techs and pick your combo.** You'll use all three lightly, but lean hardest on MCP + Slack AI:
  - Slack AI capabilities → the in-Slack agent that answers questions
  - MCP server → the ingestion + extraction pipeline that builds the graph
  - Real-Time Search API → backfilling historical context for new graph nodes
- [ ] **Decide your demo workspace.** Don't use your real work Slack. Create a fresh Slack workspace and seed it with realistic fake conversations — specifically, conversations that _contain expertise signal a Jira ticket would never capture_: someone other than the assignee solving the actual problem across multiple threads, a person who left the project but is still the formal "owner," a decision debated with real back-and-forth. Don't seed generic chitchat — every seeded thread should exist to prove the core behavior.
- [ ] **Scope your entities to serve the two behaviors, nothing more.** Limit to 3 node types and 3-4 edge types:
  - **Nodes:** Person, Project, Decision (optionally: Channel/Thread as a context node for citations)
  - **Edges:** `INVOLVED_IN` (Person→Project, weighted/timestamped by message count + recency — this edge is what powers expertise routing), `RAISED_CONCERN` / `MADE_CALL` (Person→Decision — this is what powers decision provenance), `RELATES_TO` (Decision→Project)
  - Note the `INVOLVED_IN` edge needs a **weight and a recency timestamp**, not just a boolean — that's the actual mechanism that lets you rank "who's the real expert" instead of just "who's mentioned." Don't skip this; it's the core of the differentiation.
- [ ] **Sketch the user-facing story in one sentence.** "Ask the bot who actually knows about a topic — not who's assigned to it — and it answers with sources, ranked by demonstrated involvement, not formal ownership." Keep repeating this sentence when scope creep tempts you.
- [ ] **Read Slack's docs for:** Bolt SDK (Node), Slack Agent Builder templates, `slack create agent` CLI, and the MCP server quickstart. Skim before building — don't deep-read everything now.

**Checkpoint:** You can describe the project in 2 sentences and you know what a node/edge is in your specific schema.

---

## Phase 1 — Environment & Skeleton Setup (Day 1, ~half day)

Goal: every piece of infrastructure exists and can "say hello" before any real logic is written.

- [ ] Create the Slack app via api.slack.com/apps (or `slack create agent` CLI) in your sandbox workspace.
- [ ] Set up Bolt.js (Slack's Node SDK) — get a basic bot responding to a slash command or mention (`/ask-graph hello` → `Hello back`).
- [ ] Set up your Next.js app (this will be your **architecture diagram / dashboard / visual demo surface**, not where Slack logic lives — Slack agents typically run as a separate Node service, not inside Next.js API routes, though you _can_ host both in one repo for simplicity).
- [ ] Decide your graph storage:
  - **Beginner-friendly:** in-memory JS object graph (nodes/edges as arrays), persisted to a JSON file or SQLite. Totally fine for a hackathon demo.
  - **More impressive but more setup:** Neo4j (free AuraDB tier) — gives you real graph queries (Cypher) and a nicer "we used a real graph database" story for judges.
  - Recommendation given your timeline: **start in-memory, upgrade to Neo4j only if Phase 2-3 go smoothly with time to spare.**
- [ ] Set up your MCP server skeleton (Node, using Anthropic's MCP SDK or Slack's MCP integration pattern) — one dummy tool that returns a static response, wired up and callable.
- [ ] Get all three pieces (Slack bot, Next.js dashboard, MCP server) running locally simultaneously without errors.

**Checkpoint:** You can message your bot in Slack and get a static reply; your Next.js app loads a blank dashboard; your MCP server responds to a test call.

---

## Phase 2 — Ingestion Pipeline (Days 2-3)

Goal: turn raw Slack messages into structured entities and relationships.

- [ ] Build a Slack event listener (Bolt's `app.event('message')`) that captures new messages in channels the bot is invited to.
- [ ] Use the **Real-Time Search API** to backfill: when the bot joins a channel, pull recent message history instead of starting from a blank slate.
- [ ] Design your **extraction prompt**. This is the heart of the project: feed a batch of messages to an LLM and ask it to return structured JSON like:
  ```
  { "people": [...], "projects": [...], "decisions": [...], "edges": [...] }
  ```
  Each `INVOLVED_IN` edge must carry a **weight** (increment per message/reply/PR-review mention) and a **last_active timestamp** — this is what later lets you answer "who actually knows this" by ranking, not just listing. Don't let the schema grow past Phase 0's scope.
- [ ] Write the logic that takes extracted JSON and merges it into your graph store (dedupe people by name/Slack user ID, avoid duplicate edges).
- [ ] Add basic entity resolution: same person mentioned as "Sri" and "Srijan" should resolve to one node. (Simple version: normalize by Slack user ID, not name string, wherever possible.)
- [ ] Log everything — you'll want to show "messages in → entities out" in your demo video.

**Checkpoint:** Post 10-15 varied messages in your test workspace; your graph store contains correctly extracted, deduped people/projects/decisions with sensible edges.

---

## Phase 3 — Query / Answering Layer (Days 3-4)

Goal: the part users actually interact with — asking questions and getting graph-grounded answers.

- [ ] Build a query function: natural language question → graph traversal/query → relevant subgraph.
  - Beginner approach: ask the LLM to translate the question into a _structured_ query against your schema (e.g. "find all Person nodes connected to Project X"), execute that against your in-memory graph, then feed the retrieved subgraph back to the LLM to phrase a natural answer.
  - If using Neo4j: the LLM can generate Cypher directly (riskier — validate/sandbox it).
- [ ] Wire this into the Slack bot: `/ask-graph <question>` or @mention triggers this pipeline and replies in-thread.
- [ ] **Always include sources/citations** in the answer (which thread/message the info came from) — this is a big trust + "design" judging point, and distinguishes you from generic chatbots.
- [ ] Handle the "I don't know" case gracefully — don't let the LLM hallucinate relationships not in the graph.

**Checkpoint:** Ask the bot these specific question types and get accurate, sourced answers ranked by actual involvement, not formal ownership:

1. "Who do I talk to about [topic]?" → must surface the deeply-involved person, not the (possibly outdated/departed) formal assignee.
2. "Why did we decide [X]?" → must surface reasoning/dissent, not just the outcome.
   Reject any test question that could be equally well answered by reading one Jira ticket or summarizing one thread — those don't prove the project's value.

---

## Phase 4 — Visualization Dashboard (Day 4-5)

This is where Next.js shines and where you differentiate on "Design" and "Quality of the Idea" — judges _seeing_ the graph is far more memorable than a text-only bot.

- [ ] Build a simple Next.js page that fetches the current graph state (expose a small API route or have the MCP server expose a REST/JSON endpoint).
- [ ] Render it with a graph visualization library — `react-force-graph` or `vis-network` are the easiest to get working fast; `d3` if you want more control and have time.
- [ ] Add basic interactivity: click a node → see its connections highlighted; search/filter by entity type.
- [ ] Bonus (only if time allows): live-update the graph as new Slack messages come in (websocket or polling) — great visual moment for the demo video ("watch the graph grow as I post in Slack").
- [ ] Use this dashboard as your literal **architecture diagram backdrop** too — or build a separate clean diagram (see Phase 6).

**Checkpoint:** Open the dashboard, see a real graph rendered from your seeded data, click around, it doesn't feel broken.

---

## Phase 5 — Marketplace Submission Requirements (Day 5-6)

Specific to the "Slack Agent for Organizations" track — don't leave this to the last day, marketplace review can have friction.

- [ ] Review Slack's Marketplace submission checklist (app manifest, OAuth scopes, privacy policy URL, icons, description).
- [ ] Submit your app to the Slack Marketplace **during the hackathon submission window** — note the App ID, you'll need it for submission.
- [ ] If you run out of time/confidence for a full Marketplace listing, fall back to the **New Slack Agent** track — same build, you just skip this phase and the Marketplace requirement.

**Checkpoint:** You have a Slack App ID confirming submission, OR you've consciously decided to pivot to the New Agent track.

---

## Phase 6 — Submission Assets (Day 6-7)

The judging criteria explicitly reward narrative and clarity — don't underbuild this phase.

- [ ] **Architecture diagram**: Slack → Bolt bot/MCP server → LLM extraction → graph store → Next.js dashboard → back to Slack for answers. Use a simple tool (Excalidraw, or I can help generate one) — clarity over polish.
- [ ] **~3-minute demo video**: structure it as a story, not a feature tour:
  1. The problem (15s): "Jira tells you who's _assigned_ — not who actually knows. Slack threads where real expertise lives are invisible and unsearchable." Show a fake ticket assigned to someone who left the company.
  2. Live demo — expertise routing (60s): ask the bot "who do I talk to about the rate-limiting bug?" → it ignores the departed assignee, surfaces the person who actually solved it across threads, with sources.
  3. Live demo — decision provenance (30s, if ready): ask "why did we stop using library X?" → bot returns the actual debate/reasoning, not just the closed ticket.
  4. Technical highlight (30s): briefly show the MCP server/extraction pipeline and the weighted graph dashboard.
  5. Close (15s): "Unlike a summarizer, this persists across time. Unlike Jira, it captures what was never formally recorded."
- [ ] **Text description**: feature summary, which tracks/techs you used, and why this beats a plain RAG chatbot (multi-hop relationships, visual graph, source citations).
- [ ] **Sandbox URL** + grant access to `slackhack@salesforce.com` and `testing@devpost.com` — easy to forget, do this early, not at 11:58pm.

**Checkpoint:** All four submission assets exist and you've actually watched your own demo video once end-to-end.

---

## Phase 7 — Buffer & Polish (remaining time)

- [ ] Re-test the full flow once, fresh, as if you were a judge with zero context.
- [ ] Fix the one ugly thing you've been ignoring (there's always one).
- [ ] Make sure error states don't crash live during the demo (wrap LLM calls in try/catch, have a fallback canned response if extraction fails).
- [ ] If time allows: add the "Agent for Good" framing as a stretch — e.g. positioning the same graph as an onboarding tool for new hires, which could let you discuss a second track angle in your write-up even if you only formally submit to one track.

---

## Risk Notes / Things Beginners Often Underestimate

- **LLM extraction reliability** is the riskiest part — budget real iteration time on the prompt in Phase 2, don't assume first attempt works.
- **Slack API rate limits & OAuth scopes** can eat an afternoon if you discover a missing scope late — request broad-enough scopes (channels:history, users:read, chat:write) up front in your manifest.
- **Marketplace review/approval** can have unpredictable turnaround — submit early, don't wait until the deadline day.
- **Scope creep** is the main enemy here — the in-memory graph + 3 entity types + 1 demo workspace is genuinely enough to win "Best Technological Implementation" if executed cleanly. Don't expand the schema mid-build.

---

## Quick Reference: Where Each Required Tech Lives

| Tech                   | Where it shows up                                            |
| ---------------------- | ------------------------------------------------------------ |
| MCP server integration | Ingestion pipeline (Phase 2) — Slack data → structured graph |
| Slack AI capabilities  | The `/ask-graph` bot answering in Slack (Phase 3)            |
| Real-Time Search API   | Backfilling channel history on join (Phase 2)                |

---

_Want help on any specific phase — e.g. designing the extraction prompt schema, picking the graph viz library, or drafting the architecture diagram — just say "solve [phase]" and I'll dig into the actual implementation with you._
