# SE3K — Testing

A quick end-to-end run. It proves the two core behaviors: **expertise routing**
(who *actually* knows X, ranked by demonstrated work — not the formal owner) and
**decision provenance** (why we decided X, including the dissent), both answered in
Slack with links to the source messages.

Three services: a **brain** (MCP + REST over HTTP, Postgres-backed), a **Slack bot**
(Socket Mode), and a **Next.js dashboard** (also runs the OAuth install). The bot
reads each workspace's token from Postgres, so **nothing answers until the app is
installed**. All three env files must share the same `INTERNAL_API_SECRET`.

## 1. Run it

### Local

```bash
pnpm run setup                    # one-time: install all packages + build the brain
pnpm -C engine/mcp-server db:push # one-time: create the Postgres schema (uses DB_URL)

# three terminals:
pnpm -C engine/mcp-server dev     # brain   → "🧠 SE3K brain online · HTTP :4000"
pnpm -C web dev                   # web     → http://localhost:3000
pnpm -C engine/slack-bot dev      # bot     → "⚡️ SE3K bot online · Socket Mode"
```

Required env per service:
- **brain** — `DB_URL`, `GROQ_API_KEY`, `INTERNAL_API_SECRET`
- **web** — `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `INTERNAL_API_SECRET`, `MCP_SERVER_URL`, `DASHBOARD_KEY`
- **bot** — `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`, `MCP_SERVER_URL`, `INTERNAL_API_SECRET`, `GATEWAY_URL`

### Production

Same services, hosted (dashboard is the only public one):
- **Brain** → Railway/Render/Fly (`node dist/index.js`, `PORT` injected). Run `pnpm db:push` on the prod DB once.
- **Dashboard** → Vercel. Set `APP_BASE_URL=https://se3k.vercel.app` plus the web env vars above (in the Vercel dashboard, not `.env.local`).
- **Bot** → a long-running worker (no inbound URL).
- **Slack app** → add `https://se3k.vercel.app/api/slack/oauth/callback` to Redirect URLs; reinstall.

`INTERNAL_API_SECRET` must be identical across all three hosts.

## 2. Install the app

Open **/workspaces** (`http://localhost:3000/workspaces` or `https://se3k.vercel.app/workspaces`)
→ **Add to Slack** → approve. This writes the install into Postgres. Re-import
`engine/slack-bot/manifest.json` in the Slack app config whenever scopes/commands change.

## 3. Get data in

- **Invite the bot:** `/invite @se3k` in a channel — it auto-backfills recent history
  (watch the bot terminal for `🕓 backfilled N msgs`), or
- **Backfill from the dashboard:** on `/workspaces`, expand a workspace → pick channels
  → *Start backfill*, or
- **Seed demo data** — posts as the real users (needs a `xoxp-…` token per user in
  `seed-users.json`). Create the channel, invite the users + `@se3k`, then:

  ```bash
  # small #test channel (~18 msgs)
  pnpm -C engine/slack-bot seed:slack --file testing.txt              # add --dry-run to preview
  pnpm -C engine/slack-bot seed:slack --file testing.txt --clear      # delete ONLY our messages

  # full demo (#backend + #frontend)
  pnpm -C engine/slack-bot seed:slack
  pnpm -C engine/slack-bot seed:slack --clear
  ```

Wait ~20s for auto-flush (or run `/se3k-ingest`); the bot terminal shows `📥 ingested N`.

## 4. Ask it

In any channel the bot is in, via `/ask-graph <question>` or `@se3k <question>`:

| Ask | You should get |
|---|---|
| who do I talk to about the checkout timeouts? | the person who did the work, ranked by demonstrated involvement, with sourced links — **not** the formal owner |
| who knows the cart UI? | a **different** expert than the backend one — proves per-topic routing |
| why did we adopt PgBouncer? | the reasoning **and the dissent** (who pushed back, who made the call) |
| what is @Name working on? | that one person's real work, nobody else's |
| who's doing what? | a one-line-per-project team status |
| who owns the mobile app? | an honest "no signal" / known topics — not a made-up name |
| hi · thanks · what can you do? | a short conversational reply, not a status dump |

Every sourced answer ends with clickable links to the exact Slack messages. Links are
attached at ingest time, so they appear for messages ingested after the bot joined the
workspace (the `pnpm -C engine/mcp-server ask` CLI prints the raw `<url|text>` form).

## 5. Dashboard

Open **/workspaces** → *View graph*. Node size ≈ involvement; click a person to see
their weighted `INVOLVED_IN` edges and the quoted messages behind them.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `invalid_code` on install | `APP_BASE_URL` must equal the exact public URL, and match the Slack Redirect URL byte-for-byte (https, no trailing slash). Don't refresh the callback — codes are single-use. |
| Bot logs `no installation found for team …` | Install via `/workspaces`; confirm the same `INTERNAL_API_SECRET` everywhere. |
| Bot doesn't answer | Bot terminal shows "SE3K bot online"; the brain must be running and reachable at `MCP_SERVER_URL`. |
| Brain won't start / DB errors | Run `pnpm -C engine/mcp-server db:push`; check `DB_URL`. |
| Backfill fails `not_in_channel` | Private channels need `/invite @se3k` first; public ones auto-join. |
| Backfill slow / `rate-limited` | Groq free tier is 8000 TPM — it retries and continues. Upgrade the tier for speed. |
| Answers vague / wrong person | Confirm `GROQ_API_KEY` is set; without it, matching falls back to keywords. |
| Nothing ingests | Wait ~20s (debounce) or run `/se3k-ingest`; check the bot terminal for `📥 ingested`. |
