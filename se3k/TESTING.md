# SE3K — Live testing flow

A ~15-minute end-to-end test in your Slack sandbox, set in **your tech workplace**
(`#backend` and `#frontend`). It proves both core behaviors — **expertise
routing** (who really knows X) and **decision provenance** (why we decided X) —
and shows SE3K discriminating *per area*: the backend expert and the frontend
expert are different people, and **neither is the formal "owner."** It also covers
two bonus query types — **person status** ("what is X working on?", §7) and a
**team overview** ("who's doing what?", §8).

## Cast (your workspace)

| Person | Title | Role in the demo |
|---|---|---|
| **Adam Reyes** (you) | CEO · Sr. Backend Eng | *formal owner* of checkout & the frontend — too busy → hands both off (in `#backend` + `#frontend`) |
| **Ivan Sanders** | Forward Deployed Eng | roots out + fixes the **backend** timeout → backend expert (`#backend`) |
| **Rahul Sharma** | Frontend Developer | rebuilds the cart flow → **frontend** expert (`#frontend`) |
| **Sam Okafor** | Director, Customer Service | relays support tickets — low weight, so ranking must discriminate (`#backend`) |
| **testing@devpost.com**, **slackhack@salesforce.com** | judges | just need to be in the workspace |

> `#frontend` only has **Adam** and **Rahul**, so its scenario is a two-person
> conversation — Rahul does the work, Adam is the idle owner who raises a concern.

The point: a Jira ticket says **Adam** owns checkout. SE3K sends you to **Ivan**
for the backend and **Rahul** for the UI — the people who actually did the work —
with a link to the exact message as proof.

---

## 0. Start the three processes

```bash
# Terminal 1 — the brain (must be built; the bot spawns dist/)
cd se3k/mcp-server
cp .env.example .env          # ensure GROQ_API_KEY is set for live extraction
pnpm install && pnpm build

# Terminal 2 — the Slack bot (needs SLACK_* tokens in slack-bot/.env)
cd se3k/slack-bot
pnpm install && pnpm dev      # → "⚡️ SE3K bot is running in Socket Mode"

# Terminal 3 — the dashboard
cd web
pnpm install && pnpm dev      # → http://localhost:3000
```

> **Re-install the app after the manifest change.** The new `/se3k-backfill`
> command + `member_joined_channel` event only activate after you re-import
> `slack-bot/manifest.json`: api.slack.com/apps → your app → *App Manifest* →
> paste & save → reinstall to workspace.

## 1. Invite the bot to both channels

In **`#backend`** and **`#frontend`**: `/invite @se3k`. On each join the bot
**auto-backfills** recent history (watch Terminal 2 for `🕓 backfilled N msgs`).
If the channels already have the messages below, backfill alone populates the
graph — otherwise post them in step 2.

## 2. Seed the two conversations

The full scripts (~32 human messages each, with jokes and tangents) live in
**[`demo-conversations.txt`](./demo-conversations.txt)**. Post them **as the named
person** (switch accounts or post from each teammate's session) — SE3K ignores the
banter and still extracts the real story. A taste of each:

`#backend` (Ivan, Sam, Adam):
```
Sam Okafor:    morning all ☕ my inbox is on fire, ~40 tickets came in overnight
Adam Reyes:    I "own" checkout on paper but I'm buried this week — Ivan can you take a look?
Ivan Sanders:  reproduced it… we open a fresh Postgres connection per request, pool's maxed 🙃
Ivan Sanders:  fix: PgBouncer in front. p95 went from 9s to 700ms under the same load
Adam Reyes:    concern: that's one more piece of infra to run and monitor
Ivan Sanders:  final call: keep PgBouncer, I'll add dashboards + a pager alert
```

`#frontend` (Adam, Rahul):
```
Adam Reyes:    our cart page feels like it's running on a potato. I "own" the frontend but haven't touched it since March
Rahul Sharma:  found it — it re-fetches the whole basket on every add, so the UI freezes for a second
Rahul Sharma:  making it optimistic — update instantly, reconcile in the background
Adam Reyes:    concern: if the server call quietly fails, the cart could show the wrong count
Rahul Sharma:  final call: ship optimistic updates with a rollback toast + retry
```

Wait ~20s (auto-flush) **or** run `/se3k-ingest` in each channel. Terminal 2 shows
`📥 ingested N msgs …`. Open **http://localhost:3000** and watch the graph fill —
Ivan should be the biggest node on the checkout/backend project, Rahul on the cart.

---

## 3. Expertise routing — backend

Ask in `#backend` (either form works):

```
/ask-graph who do I talk to about the checkout timeouts?
```
or
```
@se3k who actually knows the checkout timeout issue?
```

**Expected:** **Ivan Sanders** — he reproduced it, found the connection-pool
root cause, and shipped the PgBouncer fix. **Not Adam**, who owns it on paper but
handed it off. Sources link to Ivan's actual messages.

## 4. Expertise routing — frontend

```
/ask-graph who knows the cart / checkout UI?
```

**Expected:** **Rahul Sharma** — rewrote add-to-cart and fixed the stepper. **Not
Adam**, who owns the frontend on paper but handed it off. Different area →
different expert (Ivan for backend, Rahul for frontend), proving per-topic routing.

## 5. Decision provenance — backend

```
/ask-graph why did we adopt PgBouncer?
```

**Expected:** surfaces **Adam's** concern (another service to run/monitor) and
**Ivan's** final call (pool exhaustion was the real outage cause) — the reasoning
and dissent, not just "we added PgBouncer."

## 6. Decision provenance — frontend

```
/ask-graph why did we switch to optimistic cart updates?
```

**Expected:** **Adam's** concern (a silent reconcile failure could show a wrong
item count) + **Rahul's** final call (ship with a rollback toast + retry).

## 7. Person status — "what is X working on?"

```
@se3k what is @Rahul Sharma working on?
/ask-graph what's Ivan working on?
```

**Expected:** a summary about **that person only** — Rahul → the cart UI work
(optimistic add-to-cart, stepper fix, shipped it); Ivan → the Checkout API /
PgBouncer fix. It must **not** drag in other people. (Great counter-demo: it used
to answer with the whole team — now it's person-scoped.)

## 8. Team overview — "who's doing what?"

```
/ask-graph give me an update of who is doing what
@se3k what's everyone working on?
```

**Expected:** a skimmable per-project digest — **Checkout API → Ivan** (+ Sam),
**Cart UI → Rahul** (+ Adam) — one line each, sourced. The "team status in one
question" moment.

## 9. Honest "I don't know"

```
/ask-graph who owns the mobile app?
```

**Expected:** SE3K says it has no signal / lists known topics, instead of
inventing a name.

## 10. Proof — click the source

Every answer ends with a **Sources** list, and each item is a **clickable link
straight to the exact Slack message** it drew from. Click one during the demo to
jump to Ivan's "shipped a fix… 9s → 700ms" message — that's the "trust, but
verify" moment. (Links render live from Slack; the local `pnpm ask` tester prints
the raw `<url|text>` form.)

## 11. Big-thread / context safety (optional)

Paste a long back-and-forth (30–100 lines) into a channel and `/se3k-ingest`.
Terminal 2 shows `extractGraph: N chunks` — the thread was split into several
small LLM calls instead of one huge prompt, then merged. The graph still updates
correctly, no context-limit errors.

## 12. Dashboard

Open **http://localhost:3000**:
- Node size ≈ involvement — **Ivan** dominates checkout-backend, **Rahul** the cart.
- Click a person → the side panel shows their weighted `INVOLVED_IN` edges with the
  quoted Slack messages behind them.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Bot doesn't answer | Terminal 2 must show "running in Socket Mode"; the MCP server must be **built** (`pnpm build` in `mcp-server`). |
| People show as `U08…` | Old build — display-name resolution needs `users:read`; rebuild the bot. |
| Source links missing / not clickable | Links only exist for messages ingested **live from Slack** (the bot supplies real ts + permalink); the `pnpm ask` CLI prints `<url|text>`. |
| `/se3k-backfill` unknown | Re-install the app so Slack picks up the new command (step 0). |
| Answers vague / wrong person | Confirm `GROQ_API_KEY` is set in `mcp-server/.env`; without it, matching falls back to keywords. |
| Nothing ingests | Give it ~20s (debounce) or run `/se3k-ingest`; check Terminal 2 for `📥 ingested`. |
