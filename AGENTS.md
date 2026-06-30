<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

# AGENTS.md

General instructions for any AI coding agent (Claude, Codex, Cursor, etc.) operating in this repository. Tool-agnostic counterpart to `CLAUDE.md`.

## What this repo is

**Slack Org Brain** — a hackathon submission for the Slack Agent Builder Challenge ("Slack Agent for Organizations" track). It ingests Slack messages, extracts a knowledge graph (people/projects/decisions), and answers questions by ranking demonstrated involvement rather than formal/ticketed ownership.

Full build plan: see `slack-org-brain-plan.md` in this repo. Read it before making structural changes — it defines phases, checkpoints, and the two core behaviors this project must deliver.

## Non-negotiable scope anchors

1. **Primary behavior — Expertise Routing:** "who do I talk to about X" must return the person with the strongest demonstrated (not assigned) involvement, with sources.
2. **Secondary behavior — Decision Provenance:** "why did we decide X" must return reasoning/dissent behind a decision, not just an outcome.
3. Anything that doesn't serve #1 or #2 is out of scope unless the human maintainer explicitly asks for it. This includes: drift/re-contestation detection, multi-tool integrations beyond Slack, production-grade auth/rate-limiting, and schema expansion beyond `Person` / `Project` / `Decision` (+ optional `Channel`/`Thread`).

## Repository structure (expected)

````
/slack-bot/         Bolt.js Slack event listener + slash command handler
/mcp-server/        MCP server: ingestion + LLM extraction into graph schema
/graph-store/       In-memory or SQLite-backed graph (Neo4j only if explicitly migrated later)
/web/               Next.js dashboard (graph visualization, not Slack logic)
slack-org-brain-plan.md   Source of truth for phases & checkpoints
CLAUDE.md           Claude-specific session guidance
AGENTS.md           This file
```//Adjust if actual structure differs — keep this section in sync with reality.

## Coding conventions

- TypeScript preferred across the Slack bot and MCP server.
- Favor readability over abstraction. This is a time-boxed hackathon build by a beginner to this category of project — avoid premature design patterns, dependency injection frameworks, or speculative generalization.
- Graph edges of type `INVOLVED_IN` must always carry `weight` and `last_active` fields — this is the mechanism that makes expertise routing possible. Do not simplify to a boolean.
- Keep the LLM extraction prompt and its expected JSON schema in one clearly marked, easily testable location (not scattered across files) — it will need frequent manual iteration.
- Mark intentional hackathon shortcuts with a comment, e.g. `// hackathon shortcut: no auth here, would add before any production use`.

## Testing expectations

There is no formal test suite requirement for this hackathon timeline. Instead, validate against the **checkpoints** defined in `slack-org-brain-plan.md` for each phase — e.g., "ask the bot 2 specific question types and verify sourced, correctly-ranked answers." When asked to verify a phase is complete, check against that phase's checkpoint, not generic test coverage.

## Pull request / change etiquette (if working across branches)

- Keep changes scoped to one phase of the plan at a time where possible.
- If a change would expand the graph schema, add a new track/behavior, or introduce a new major dependency (e.g. Neo4j, a new LLM provider), flag this explicitly before proceeding rather than doing it silently.
- Reference the relevant phase number from `slack-org-brain-plan.md` in commit messages or PR descriptions when applicable (e.g. "Phase 2: tighten extraction prompt for weighted INVOLVED_IN edges").

## Deadline awareness

This is a hackathon with a hard submission deadline. When given a choice between a more "correct" but slower implementation and a simpler one that hits the same checkpoint, default to the simpler one unless told otherwise. Time saved should be redirected toward demo polish (Phase 6 in the plan) and the two core behaviors, not toward infrastructure hardening.
````
