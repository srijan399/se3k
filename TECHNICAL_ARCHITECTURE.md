# TECHNICAL_ARCHITECTURE.md — SE3K

_"Who actually knows this?" — not who's assigned to it._

This document complements `se3k-plan.md`. The plan tells you _what_ to build and _why_, phase by phase. This file shows _how the pieces connect_ (architecture), _what order to build them in_ (roadmap), and _what depends on what_ (flowchart) — so you always know what's safe to start next.

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
