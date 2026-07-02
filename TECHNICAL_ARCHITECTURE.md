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
  SLACK["<b>Slack Workspace</b><br/><br/>messages in channels<br/>/ask-graph &nbsp;·&nbsp; @se3k<br/><i>developer sandbox</i>"]

  BOT["<b>slack-bot</b><br/>Bolt.js · Socket Mode<br/><br/>• event listener + buffer<br/>• slash / mention handlers<br/>• <b>MCP stdio client</b>"]

  MCP["<b>mcp-server — THE BRAIN</b><br/>MCP server over stdio<br/><br/>• tools: ingest_messages, ask_graph<br/>• extract.ts &nbsp;→&nbsp; answer.ts<br/>• store.ts — weighted ranking"]

  LLM["<b>Groq LLM</b><br/>llama-3.1<br/>OpenAI-compatible"]

  GRAPH[("<b>graph.json</b> — source of truth<br/><br/>Person · Project · Decision<br/><b>INVOLVED_IN</b> (weight, last_active)<br/>RAISED_CONCERN · MADE_CALL")]

  WEB["<b>Next.js dashboard</b><br/><br/>/api/graph<br/>live force-graph"]

  SLACK == "1 · new message" ==> BOT
  BOT   == "2 · ingest_messages" ==> MCP
  MCP   == "3 · extract / phrase" ==> LLM
  MCP   == "4 · persist &amp; query" ==> GRAPH

  SLACK -. "A · question" .-> BOT
  BOT   -. "B · ask_graph" .-> MCP
  MCP   -. "C · answer + citations" .-> BOT
  BOT   -. "D · reply in thread" .-> SLACK

  GRAPH == "live snapshot (poll)" ==> WEB

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
  class GRAPH cGraph
  class WEB cWeb
```

> **Reads in one breath:** Slack → bot → the MCP brain, which extracts with the LLM and
> writes the weighted graph; a question runs the same path in reverse and comes back
> **sourced**; the dashboard reads the same graph live.

### The two core behaviors (sequence view)

**Ingestion — messages become a weighted graph** (automatic: backfill on join + debounced flush)
```mermaid
sequenceDiagram
  autonumber
  participant S as Slack
  participant B as slack-bot (Bolt)
  participant M as mcp-server (ingest_messages)
  participant L as Groq LLM
  participant G as graph.json

  S->>B: message event / channel history (conversations.history)
  B->>B: resolve names, buffer per channel, flush on size or ~20s idle
  B->>M: MCP call ingest_messages(tagged text, refs)
  M->>M: chunk large blobs (bounded per-call context)
  M->>L: extraction prompt (weight rubric + example)
  L-->>M: {people, projects, decisions, involvement, edges} JSON
  M->>G: entity-resolve + accumulate INVOLVED_IN (weight, last_active, permalink)
  Note over G: fix/review = weight 4–5,<br/>mention = 1, assigned-but-idle = 1
```

**Query — expertise routing & decision provenance**
```mermaid
sequenceDiagram
  autonumber
  participant U as User in Slack
  participant B as slack-bot
  participant M as mcp-server (ask_graph)
  participant G as graph.json
  participant L as Groq LLM

  participant C as Semantic cache (Jina)
  U->>B: /ask-graph who knows about the checkout timeouts?
  B->>M: MCP call ask_graph(question)
  M->>C: embed question, look up at current graph version
  alt semantically-similar hit
    C-->>M: cached answer — ZERO LLM calls
  else miss
    M->>L: route to ONE node via compact label-only catalog
    M->>G: resolve subgraph (deterministic, in code)
    G-->>M: ranked experts by score(p) = W·(0.4+0.6·recency)
    M->>L: phrase ONLY these grounded facts
    L-->>M: natural-language answer
    M->>C: store answer under the graph version
  end
  M-->>B: answer + source permalinks
  B-->>U: reply in-channel / in-thread (never uncited)
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
                       │        SLACK WORKSPACE (sandbox)          │
                       │  msgs • /ask-graph • /se3k-ingest • @se3k │
                       └───────┬───────────────────────▲──────────┘
              message event    │                       │  sourced answer
                               ▼                       │
                       ┌──────────────────────────────────────────┐
                       │   slack-bot  (Bolt.js, Socket Mode)       │
                       │  event listener • buffer • cmd handlers   │
                       │            └── MCP stdio client ──┐       │
                       └──────────────────────────────────┼───────┘
                       ingest_messages / ask_graph (MCP)  │
                                                          ▼
   ┌───────┐  extraction   ┌───────────────────────────────────────────┐
   │ Groq  │◀──prompt──────│         mcp-server  (THE BRAIN)           │
   │ LLM   │──JSON────────▶│  ingest_messages   ask_graph              │
   │(llama)│   phrase ▲    │  extract.ts        answer.ts              │
   └───────┘   facts  └────│  ───────────────  store.ts (graph+rank)   │
                           └───────────────┬───────────────▲──────────┘
                             persist/read  │               │ read subgraph
                                           ▼               │
                       ┌──────────────────────────────────────────┐
                       │     graph-store/graph.json  (truth)       │
                       │  Person·Project·Decision  +  weighted      │
                       │  INVOLVED_IN(weight,last_active), etc.     │
                       └───────────────┬──────────────────────────┘
                          JSON snapshot│
                                       ▼
                       ┌──────────────────────────────────────────┐
                       │   web  (Next.js) — /api/graph → GraphView │
                       │   live force-graph, colored by node type  │
                       └──────────────────────────────────────────┘
```

**Required-tech mapping for judges:** MCP server integration = the brain & the bot↔brain link ·
Slack AI capabilities = the `/ask-graph` agent · history backfill = `conversations.history`
pulled automatically on channel join.

---

## 1. System Architecture

This is the full picture: how data flows from a Slack message into a graph, and back out as an answer.

```mermaid
flowchart TB
    subgraph Slack["Slack Workspace (sandbox)"]
        SM[New Message / Thread Reply]
        SQ["/ask-graph command or @mention"]
    end

    subgraph Bot["Slack Bot Service (Bolt.js, Node/TS)"]
        EL[Event Listener]
        SC[Slash Command Handler]
        RTS[Real-Time Search API client]
    end

    subgraph MCP["MCP Server (Node/TS)"]
        EX[Extraction Tool<br/>LLM call: messages → entities/edges JSON]
        QR[Query Tool<br/>LLM call: question → structured graph query]
        AN[Answer Composer<br/>subgraph → natural language + sources]
    end

    subgraph Graph["Graph Store"]
        GS[(In-memory graph<br/>JSON-persisted)]
        N1["Node: Person"]
        N2["Node: Project"]
        N3["Node: Decision"]
        E1["Edge: INVOLVED_IN<br/>(weight, last_active)"]
        E2["Edge: RAISED_CONCERN / MADE_CALL"]
        E3["Edge: RELATES_TO"]
    end

    subgraph Web["Next.js App"]
        API[API Route: /api/graph]
        DASH[Dashboard: graph visualization<br/>react-force-graph]
    end

    SM -->|on channel join: backfill| RTS
    RTS --> EL
    SM --> EL
    EL -->|raw message batch| EX
    EX -->|extracted nodes/edges| GS
    GS --- N1
    GS --- N2
    GS --- N3
    N1 --- E1
    N1 --- E2
    N3 --- E3

    SQ --> SC
    SC -->|question text| QR
    QR -->|reads| GS
    QR -->|relevant subgraph| AN
    AN -->|answer + citations| SC
    SC -->|reply in Slack thread| SQ

    GS -->|graph snapshot| API
    API --> DASH

    style Slack fill:#4A154B,color:#fff
    style Bot fill:#36C5F0,color:#000
    style MCP fill:#ECB22E,color:#000
    style Graph fill:#2EB67D,color:#000
    style Web fill:#000,color:#fff
```

**Key design point to keep visible in your head:** the `INVOLVED_IN` edge is the only place "expertise routing" actually lives. Everything else is plumbing to get data into that edge and query it back out. If you're ever unsure what to build next, ask "does this get me closer to a correct, well-weighted `INVOLVED_IN` edge, or to querying it well?"

> **Implementation notes (current build).** Ingestion is now **automatic**: the bot backfills recent history via `conversations.history` when it joins a channel, then buffers new messages and flushes them on a short inactivity timer (or batch size) — no manual trigger. Slack user IDs are resolved to display names (`users.info`) before extraction, messages are de-duped by timestamp, and the `EX` extraction step **chunks** large blobs into bounded per-call prompts (merging results) so a 100-message thread never becomes one giant LLM call. On the query side, `QR` first routes a question to one graph node using a **compact label-only catalog** (cheap + robust), then `AN` runs the deterministic ranking/provenance and phrases the grounded facts with citations. A **semantic answer cache** sits in front of this: `ask_graph` embeds the question (Jina) and returns a previously-computed answer for a semantically-similar question at the same graph version — **zero LLM calls** — invalidated automatically whenever the graph changes. Everything degrades to keyword matching + the seeded graph when no LLM key is set, and the cache is a no-op without `JINA_API_KEY`.

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
