# TECHNICAL_ARCHITECTURE.md — SE3K

_"Who actually knows this?" — not who's assigned to it._

This document complements `se3k-plan.md`. The plan tells you _what_ to build and _why_, phase by phase. This file shows _how the pieces connect_ (architecture), _what order to build them in_ (roadmap), and _what depends on what_ (flowchart) — so you always know what's safe to start next.

---

## 0. Architecture at a glance (submission diagram)

Render to PNG/SVG at **[mermaid.live](https://mermaid.live)** (paste → Export at 2–3× scale),
or with the CLI: `npx -y @mermaid-js/mermaid-cli -i TECHNICAL_ARCHITECTURE.md -o se3k-arch.png`.
Six boxes, one loop: solid arrows = **ingest** (1–4), dashed arrows = **ask** (A–D).

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontSize':'22px','fontFamily':'Inter, Helvetica, sans-serif','lineColor':'#555'}, 'flowchart':{'nodeSpacing':55,'rankSpacing':90,'curve':'basis','htmlLabels':true}}}%%
flowchart LR
  SLACK["<b>Slack Workspaces</b><br/><br/>messages in channels<br/>/ask-graph &nbsp;·&nbsp; @se3k<br/><i>any number, one per OAuth install</i>"]

  BOT["<b>slack-bot</b><br/>Bolt.js · Socket Mode<br/><br/>• event listener + buffer<br/>• slash / mention handlers<br/>• <b>MCP client (Streamable HTTP)</b><br/>• authorize(teamId) — no static token"]

  MCP["<b>mcp-server — THE BRAIN</b><br/>persistent · MCP over Streamable HTTP + REST<br/><br/>• tools: ingest_messages, ask_graph (teamId-scoped)<br/>• extract.ts &nbsp;→&nbsp; answer.ts<br/>• store.ts — weighted ranking, per team<br/>• backfill runner (own Slack Web API client)"]

  LLM["<b>Groq LLM</b><br/>llama-3.1<br/>OpenAI-compatible"]

  DB[("<b>Postgres (Drizzle)</b> — source of truth<br/><br/>graph_nodes · graph_edges (per team_id)<br/><b>INVOLVED_IN</b> (weight, last_active)<br/>installations · backfill_jobs · processed_messages")]

  WEB["<b>Next.js dashboard</b><br/><br/>Slack OAuth install<br/>channel picker + backfill progress<br/>/api/graph → live force-graph"]

  SLACK == "1 · new message" ==> BOT
  BOT   == "2 · ingest_messages" ==> MCP
  MCP   == "3 · extract / phrase" ==> LLM
  MCP   == "4 · persist &amp; query" ==> DB

  SLACK -. "A · question" .-> BOT
  BOT   -. "B · ask_graph" .-> MCP
  MCP   -. "C · answer + citations" .-> BOT
  BOT   -. "D · reply in thread" .-> SLACK

  WEB   == "E · OAuth install (bot token)" ==> MCP
  MCP   == "F · backfill: conversations.list/history" ==> SLACK
  MCP   == "G · graph snapshot (REST)" ==> WEB

  classDef cSlack fill:#4A154B,color:#fff,stroke:#000,stroke-width:2px;
  classDef cBot fill:#36C5F0,color:#04222e,stroke:#04222e,stroke-width:2px;
  classDef cMcp fill:#ECB22E,color:#3a2a00,stroke:#3a2a00,stroke-width:3px;
  classDef cGraph fill:#2EB67D,color:#00291b,stroke:#00291b,stroke-width:2px;
  classDef cWeb fill:#111,color:#fff,stroke:#000,stroke-width:2px;
  classDef cLlm fill:#f3f3f3,color:#111,stroke:#888,stroke-width:2px;

  class SLACK cSlack
  class BOT cBot
  class MCP cMcp
  class LLM cLlm
  class DB cGraph
  class WEB cWeb
```

> **Reads in one breath:** Slack → bot → the MCP brain, which extracts with the LLM and
> writes the weighted graph; a question runs the same path in reverse and comes back
> **sourced**; the dashboard drives Slack OAuth to connect new workspaces and trigger
> full-history backfill, and reads the same (per-workspace) graph live over REST.

### The two core behaviors (sequence view)

**Ingestion — messages become a weighted graph** (automatic: backfill on join + debounced flush)
```mermaid
sequenceDiagram
  autonumber
  participant S as Slack
  participant B as slack-bot (Bolt)
  participant M as mcp-server (ingest_messages, teamId)
  participant L as Groq LLM
  participant D as Postgres (team-scoped)

  S->>B: message event / channel history (conversations.history)
  B->>B: resolve names, buffer per (team, channel), flush on size or ~20s idle
  B->>M: MCP call ingest_messages(teamId, tagged text, refs) over Streamable HTTP
  M->>D: check (team, channel, ts) against processed_messages — drop dupes
  M->>M: chunk large blobs (bounded per-call context)
  M->>L: extraction prompt (weight rubric + example)
  L-->>M: {people, projects, decisions, involvement, edges} JSON
  M->>D: GraphStore.forTeam(teamId): entity-resolve + accumulate INVOLVED_IN
  M->>D: mark (team, channel, ts) processed — only after the save succeeds
  Note over D: fix/review = weight 4–5,<br/>mention = 1, assigned-but-idle = 1
```

**Query — expertise routing & decision provenance**
```mermaid
sequenceDiagram
  autonumber
  participant U as User in Slack
  participant B as slack-bot
  participant M as mcp-server (ask_graph, teamId)
  participant D as Postgres (team-scoped)
  participant L as Groq LLM
  participant C as Semantic cache (Jina)

  U->>B: /ask-graph who knows about the checkout timeouts?
  B->>M: MCP call ask_graph(teamId, question) over Streamable HTTP
  M->>C: embed question, look up at this workspace's current graph version
  alt semantically-similar hit
    C-->>M: cached answer — ZERO LLM calls
  else miss
    M->>D: GraphStore.forTeam(teamId) — hydrate this workspace's graph only
    M->>L: route to ONE node via compact label-only catalog
    D-->>M: resolve subgraph (deterministic, in code)
    M-->>M: ranked experts by score(p) = W·(0.4+0.6·recency)
    M->>L: phrase ONLY these grounded facts
    L-->>M: natural-language answer
    M->>C: store answer under the graph version
  end
  M-->>B: answer + source permalinks
  B-->>U: reply in-channel / in-thread (never uncited)
```

**Connecting a workspace — OAuth install & full-history backfill**
```mermaid
sequenceDiagram
  autonumber
  participant Op as Workspace admin (browser)
  participant W as web (Next.js)
  participant Sl as Slack OAuth
  participant M as mcp-server (REST)
  participant Db as Postgres
  participant Sk as Slack Web API

  Op->>W: click "Connect Slack"
  W->>Sl: redirect to /oauth/v2/authorize (bot scopes incl. groups:read, channels:join)
  Sl-->>W: redirect back to /api/slack/oauth/callback with ?code
  W->>Sl: oauth.v2.access(code) → bot token + team_id + team_name
  W->>M: POST /internal/installations {teamId, botToken, ...}
  M->>Db: upsert installations row (onConflictDoUpdate by teamId)

  Op->>W: pick channels (or "auto-join all public"), click Backfill
  W->>M: POST /internal/backfill {teamId, channelIds | autoJoinPublic}
  M->>Db: insert backfill_jobs row (status=pending) → jobId
  M-->>W: 202 Accepted {jobId}
  par backfill runs async
    M->>Sk: conversations.list / conversations.history (paginated, per channel)
    M->>Db: check + mark processed_messages, extract + save each batch
    M->>Db: update backfill_jobs progress (channelsDone, messagesProcessed)
  and web polls for progress
    W->>M: GET /internal/backfill/:jobId (every ~2s)
    M-->>W: {status, channelsDone, messagesProcessed}
  end
```

### The ranking that makes it work (the differentiator)

```
score(person) = W · (0.4 + 0.6 · recency)

  W        = Σ weight of every contribution to the project   (fix/review ≫ mention)
  recency  = (1/2) ^ (Δt / 30 days)        Δt = time since last activity

⇒ deep past work never disappears (0.4 floor), but recent hands-on
  involvement wins ties. The demonstrated expert outranks the assignee.
```

### ASCII fallback (if a renderer isn't available)

```
                       ┌──────────────────────────────────────────┐
                       │   SLACK WORKSPACES (any number, one per   │
                       │   OAuth install) — msgs • /ask-graph •    │
                       │   /se3k-ingest • @se3k                    │
                       └───────┬───────────────────────▲──────────┘
              message event    │                       │  sourced answer
                               ▼                       │
                       ┌──────────────────────────────────────────┐
                       │   slack-bot  (Bolt.js, Socket Mode)       │
                       │  event listener • buffer • cmd handlers   │
                       │  authorize(teamId) — no static bot token  │
                       │       └── MCP client (Streamable HTTP) ─┐ │
                       └──────────────────────────────────────────┼─┘
                       ingest_messages / ask_graph (teamId, MCP)  │
                                                          ▼
   ┌───────┐  extraction   ┌───────────────────────────────────────────┐
   │ Groq  │◀──prompt──────│      mcp-server  (THE BRAIN — persistent) │
   │ LLM   │──JSON────────▶│  ingest_messages   ask_graph               │
   │(llama)│   phrase ▲    │  extract.ts        answer.ts               │
   └───────┘   facts  └────│  store.ts (per-team)  backfill runner      │
                           └───────────────┬───────────────▲──────────┘
                     persist/read (per team)│               │ REST: install /
                                           ▼               │ backfill trigger+status /
                       ┌──────────────────────────────────┐ │ graph snapshot
                       │   Postgres (Drizzle) — truth        │
                       │  graph_nodes / graph_edges (team_id)│
                       │  installations · backfill_jobs      │
                       │  processed_messages (idempotency)   │
                       └──────────────────────────────────┘
                                                             │
                       ┌──────────────────────────────────────────┐
                       │   web  (Next.js)                          │
                       │  Slack OAuth install • channel picker +   │
                       │  backfill progress • /api/graph → GraphView│
                       └──────────────────────────────────────────┘
```
_(mcp-server also calls Slack's `conversations.list`/`history` directly during a
backfill job, using the workspace's stored bot token — omitted above for
clarity; see the sequence diagrams for the full picture.)_

**Required-tech mapping for judges:** MCP server integration = the brain, reachable by
both the bot (Streamable HTTP) and the dashboard (REST) · Slack AI capabilities = the
`/ask-graph` agent · history backfill = automatic on-join catch-up via
`conversations.history`, plus an explicit paginated full-history job triggered from the
dashboard for workspaces installing after years of activity.

---

## 1. System Architecture

This is the full picture: how data flows from a Slack message into a graph, and back out as an answer.

```mermaid
flowchart TB
    subgraph Slack["Slack Workspaces (any number, one per OAuth install)"]
        SM[New Message / Thread Reply]
        SQ["/ask-graph command or @mention"]
    end

    subgraph Bot["Slack Bot Service (Bolt.js, Node/TS)"]
        EL[Event Listener]
        SC[Slash Command Handler]
        RTS[On-join backfill via conversations.history]
        AUTH["authorize(teamId)<br/>per-workspace bot token, no static token"]
    end

    subgraph MCP["MCP Server (Node/TS) — persistent, Streamable HTTP + REST"]
        EX[Extraction Tool<br/>LLM call: messages → entities/edges JSON]
        QR[Query Tool<br/>LLM call: question → structured graph query]
        AN[Answer Composer<br/>subgraph → natural language + sources]
        BF[Backfill Runner<br/>paginated conversations.list/history<br/>per team_id, own Slack Web API client]
        REST[REST layer<br/>installations · backfill jobs · graph snapshot]
    end

    subgraph Graph["Postgres (Drizzle) — partitioned by team_id"]
        GS[(graph_nodes / graph_edges)]
        N1["Node: Person"]
        N2["Node: Project"]
        N3["Node: Decision"]
        E1["Edge: INVOLVED_IN<br/>(weight, last_active)"]
        E2["Edge: RAISED_CONCERN / MADE_CALL"]
        E3["Edge: RELATES_TO"]
        INST[(installations<br/>bot token per team)]
        JOBS[(backfill_jobs<br/>status + progress)]
        PROC[(processed_messages<br/>idempotency)]
    end

    subgraph Web["Next.js App"]
        OAUTH[Slack OAuth install + callback]
        PICK[Channel picker / auto-join<br/>+ backfill trigger]
        API[API Route: /api/graph proxy]
        DASH[Dashboard: graph visualization<br/>react-force-graph]
    end

    SM -->|on channel join: backfill| RTS
    RTS --> EL
    SM --> EL
    EL -->|raw message batch, teamId| EX
    EX -->|extracted nodes/edges| GS
    EX -->|check / mark| PROC
    GS --- N1
    GS --- N2
    GS --- N3
    N1 --- E1
    N1 --- E2
    N3 --- E3
    AUTH -.->|reads bot token| INST

    SQ --> SC
    SC -->|question text, teamId| QR
    QR -->|reads| GS
    QR -->|relevant subgraph| AN
    AN -->|answer + citations| SC
    SC -->|reply in Slack thread| SQ

    OAUTH -->|POST installation| REST
    REST --> INST
    PICK -->|POST backfill| REST
    REST --> JOBS
    REST --> BF
    BF -->|conversations.list/history| SM
    BF -->|extract + save, then mark| GS
    BF --> PROC
    PICK -.->|poll status| JOBS

    GS -->|REST graph snapshot| API
    API --> DASH

    style Slack fill:#4A154B,color:#fff
    style Bot fill:#36C5F0,color:#000
    style MCP fill:#ECB22E,color:#000
    style Graph fill:#2EB67D,color:#000
    style Web fill:#000,color:#fff
```

**Key design point to keep visible in your head:** the `INVOLVED_IN` edge is the only place "expertise routing" actually lives — now scoped per Slack workspace (`team_id`), but the mechanism is unchanged. Everything else is plumbing to get data into that edge and query it back out. If you're ever unsure what to build next, ask "does this get me closer to a correct, well-weighted `INVOLVED_IN` edge, or to querying it well?"

> **Implementation notes (current build).** The MCP server now runs as a **persistent, multi-workspace service** — `slack-bot` connects to it over **Streamable HTTP** (not a spawned stdio child process), and `web` reaches the same running process over a REST layer for installs, backfill, and graph reads. Every tool call and REST call carries a `teamId`; `GraphStore.forTeam(teamId)` hydrates only that workspace's rows from Postgres (Drizzle) per call, so workspaces never see each other's data. `slack-bot` itself holds no static bot token — an `authorize(teamId)` function looks up the right token per event, which is what lets one running bot process serve every installed workspace. Ingestion is still **automatic**: the bot backfills recent history via `conversations.history` when it joins a channel, then buffers new messages and flushes them on a short inactivity timer (or batch size). For a workspace that's been running long before installing SE3K, `web`'s OAuth flow now also exposes an explicit **backfill job**: pick channels (or auto-join every public one), and `mcp-server` paginates full channel history itself, using the stored bot token, tracking progress in a `backfill_jobs` row `web` polls. Every batch — live or backfilled — is checked against a `processed_messages` table (`team_id, channel_id, ts`) **before** extraction and only marked **after** a successful save, so a flaky LLM call skips a batch instead of losing or double-counting it, and live ingestion + backfill can safely overlap. Slack user IDs are resolved to display names (`users.info`) before extraction, and the `EX` extraction step **chunks** large blobs into bounded per-call prompts (merging results) so a 100-message thread — or a multi-year backfill — never becomes one giant LLM call. On the query side, `QR` first routes a question to one graph node using a **compact label-only catalog** (cheap + robust), then `AN` runs the deterministic ranking/provenance and phrases the grounded facts with citations. A **semantic answer cache** sits in front of this, scoped per workspace: `ask_graph` embeds the question (Jina) and returns a previously-computed answer for a semantically-similar question at the same graph version — **zero LLM calls** — invalidated automatically whenever that workspace's graph changes. Everything degrades to keyword matching + the seeded graph when no LLM key is set, and the cache is a no-op without `JINA_API_KEY`.

---

## 2. Step-by-Step Technical Roadmap

This is the literal build order — each step assumes the previous one is done and runnable, not just written.

```mermaid
graph TD
    A[1. Create Slack app + sandbox workspace] --> B[2. Bolt bot replies to a test mention]
    B --> C[3. Scaffold Next.js app with blank dashboard page]
    C --> D[4. Scaffold MCP server with one dummy tool call]
    D --> E[5. Define graph schema in code:<br/>Person, Project, Decision + 3 edge types]
    E --> F[6. Write in-memory graph store:<br/>add node, add edge, get neighbors, persist to JSON]
    F --> G[7. Write + manually test LLM extraction prompt<br/>on 5-10 sample messages, no automation yet]
    G --> H[8. Wire extraction into MCP tool:<br/>messages in → graph updated]
    H --> I[9. Connect Bolt event listener to extraction tool<br/>real Slack messages now populate the graph]
    I --> J[10. Add Real-Time Search backfill on channel join]
    J --> K[11. Write query tool: question → structured graph lookup]
    K --> L[12. Write answer composer:<br/>subgraph → natural language + source citations]
    L --> M[13. Wire /ask-graph slash command end-to-end]
    M --> N[14. Validate Phase 3 checkpoint:<br/>expertise routing + decision provenance questions work]
    N --> O[15. Build /api/graph route exposing graph JSON]
    O --> P[16. Build dashboard graph visualization]
    P --> Q[17. Optional: live-update dashboard on new messages]
    Q --> R[18. Marketplace submission OR pivot to New Agent track]
    R --> S[19. Architecture diagram + demo video + text description]
    S --> T[20. Submit: sandbox URL + grant access + final check]

    style A fill:#4A154B,color:#fff
    style N fill:#2EB67D,color:#000
    style T fill:#ECB22E,color:#000
```

**Read this as a checklist, not a suggestion** — steps 1-9 are pure infrastructure with no payoff until step 9, where messages first start becoming graph data. Step 14 is the actual "does this project work" milestone. Everything after that is demoability and packaging, not core functionality.

---

## 3. Dependency Flowchart (what blocks what)

This shows which steps can happen in parallel and which strictly require something else to finish first — useful for knowing what you can work on if you get stuck on one piece.

```mermaid
flowchart LR
    subgraph Track1["Can build in parallel early"]
        direction TB
        A1[Slack app setup]
        A2[Next.js scaffold]
        A3[MCP server scaffold]
    end

    subgraph Track2["Requires schema decided first"]
        direction TB
        B1[Graph store implementation]
        B2[Extraction prompt design]
    end

    subgraph Track3["Requires graph store + extraction"]
        direction TB
        C1[Ingestion wiring<br/>Slack → MCP → Graph]
        C2[RTS backfill]
    end

    subgraph Track4["Requires populated graph"]
        direction TB
        D1[Query tool]
        D2[Answer composer]
    end

    subgraph Track5["Requires working query+answer"]
        direction TB
        E1[Slash command wiring]
        E2[Dashboard visualization]
    end

    subgraph Track6["Requires E1 working end-to-end"]
        direction TB
        F1[Marketplace submission]
        F2[Demo video + diagram + description]
    end

    A1 --> C1
    A3 --> B1
    A3 --> B2
    B1 --> C1
    B2 --> C1
    C1 --> C2
    C1 --> D1
    D1 --> D2
    D2 --> E1
    A2 --> E2
    D2 --> E2
    E1 --> F1
    E1 --> F2
    E2 --> F2

    style Track4 fill:#2EB67D,color:#000
    style Track6 fill:#ECB22E,color:#000
```

**How to use this if you're short on time:** Track 1 (Slack/Next.js/MCP scaffolding) can be done in any order or even out of sequence with help — it's just setup. Track 2 (schema + extraction prompt) is the one place where rushing will cost you later, since everything downstream depends on the schema being right. If your extraction prompt (Track 2) is taking longer than expected, you can keep iterating on it while someone (or a separate work session) builds the dashboard (Track 5/E2) in parallel, since it only needs _a_ graph, not a perfect one, to render against.

---

## 4. Minimum Viable Demo Path

If time runs critically short, this is the smallest path that still proves the core behavior — skip everything not on this list first:

```mermaid
graph LR
    A[Seed workspace<br/>with deliberate expertise-routing scenario] --> B[Manual extraction<br/>hand-write the JSON if the prompt isn't reliable yet]
    B --> C[Graph store with<br/>weighted INVOLVED_IN edges]
    C --> D[Hardcoded or simple<br/>query for the one demo question]
    D --> E[Bot replies in Slack<br/>with sourced answer]
    E --> F[Record demo video]

    style A fill:#4A154B,color:#fff
    style F fill:#ECB22E,color:#000
```

This is your fallback insurance policy, not the plan — but knowing it exists should reduce panic if Phase 2's automation is still flaky on demo day. A convincingly hand-seeded graph answering the right question well beats a fully automated pipeline answering nothing reliably.
