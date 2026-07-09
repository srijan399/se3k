import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { WebClient } from '@slack/web-api';

const TOKENS_FILE = path.resolve(__dirname, '../seed-users.json');
const DELAY_MS = Number(process.env.SEED_DELAY_MS) || 500;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const clearMode = args.includes('--clear'); // delete seeded messages instead of posting
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;
const fileIdx = args.indexOf('--file');
const CONVO_FILE = path.resolve(
  __dirname,
  '../..',
  fileIdx >= 0 ? args[fileIdx + 1] : 'demo-conversations.txt',
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SeedLine {
  channel: string;
  name: string;
  text: string;
}

function parseConversations(file: string): SeedLine[] {
  const out: SeedLine[] = [];
  let channel: string | null = null;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const cm = line.match(/^#([a-z0-9][a-z0-9_-]*)\s*$/i);
    if (cm) {
      channel = cm[1].toLowerCase();
      continue;
    }
    // "First Last: text" or a single-name author like "Ultrode: text".
    const m = line.match(
      /^([A-Z][A-Za-z.'-]*(?: [A-Z][A-Za-z.'-]*)*):\s+(.+)$/,
    );
    if (m && channel) out.push({ channel, name: m[1], text: m[2] });
  }
  return out;
}

async function resolveChannels(
  bot: WebClient,
  names: Set<string>,
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  let cursor: string | undefined;
  do {
    const res = await bot.conversations.list({
      types: 'public_channel',
      limit: 200,
      cursor,
      exclude_archived: true,
    });
    for (const c of (res.channels || []) as Array<{
      id?: string;
      name?: string;
    }>) {
      if (c.name && names.has(c.name) && c.id) map[c.name] = c.id;
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return map;
}

async function targetChannelIds(
  tokens: { channels?: Record<string, string> },
  needed: Set<string>,
): Promise<Record<string, string>> {
  const channelIds: Record<string, string> = { ...(tokens.channels || {}) };
  const toResolve = [...needed].filter((n) => !channelIds[n]);
  if (toResolve.length) {
    const botToken = process.env.SLACK_BOT_TOKEN;
    if (!botToken) {
      throw new Error(
        'SLACK_BOT_TOKEN missing in slack-bot/.env — needed to look up channel ids. ' +
          'Or pin them in seed-users.json: "channels": { "backend": "C123" }.',
      );
    }
    Object.assign(
      channelIds,
      await resolveChannels(new WebClient(botToken), new Set(toResolve)),
    );
  }
  return channelIds;
}

// --clear: delete messages we posted (seed users + the bot's own replies) from
// the target channels. Never deletes anyone else's messages — it maps each of
// our tokens to a Slack user id up front and only deletes messages whose author
// is in that set, so judges' / real users' messages are always left untouched.
async function clearChannels(
  tokens: { users: Record<string, string>; channels?: Record<string, string> },
  needed: Set<string>,
) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    throw new Error(
      'SLACK_BOT_TOKEN required in slack-bot/.env to read channel history for --clear.',
    );
  }
  const reader = new WebClient(botToken); // history/replies reads
  const deleter = new WebClient(); // chat.delete with a per-message author token

  // Map each usable token → its Slack user id. Only these ids are deletable.
  const idToToken = new Map<string, string>();
  for (const [name, token] of Object.entries(tokens.users)) {
    if (!token || token.startsWith('xoxp-...')) continue;
    try {
      const r = (await new WebClient().auth.test({ token })) as {
        user_id?: string;
      };
      if (r.user_id) idToToken.set(r.user_id, token);
    } catch (e) {
      console.error(`  token check failed for ${name}:`, (e as Error).message);
    }
  }
  let botId: string | undefined;
  try {
    botId = ((await reader.auth.test()) as { user_id?: string }).user_id;
  } catch {
    /* invalid bot token — bot messages just won't be cleared */
  }
  if (idToToken.size === 0 && !botId) {
    console.error('No usable tokens — nothing can be deleted.');
    return;
  }

  // The token that can delete a given author's message, or undefined (= not ours).
  const tokenFor = (userId?: string): string | undefined => {
    if (!userId) return undefined;
    if (idToToken.has(userId)) return idToToken.get(userId);
    if (botId && userId === botId) return botToken;
    return undefined;
  };

  const channelIds = await targetChannelIds(tokens, needed);

  for (const chName of needed) {
    const channel = channelIds[chName];
    if (!channel) {
      console.error(`  no channel id for #${chName} (is the bot a member?)`);
      continue;
    }

    // Gather our messages: top-level + any thread replies (bot answers live in
    // threads), so nothing is left orphaned.
    const targets: Array<{ ts: string; token: string; text: string }> = [];
    let cursor: string | undefined;
    do {
      const res = await reader.conversations.history({
        channel,
        limit: 200,
        cursor,
      });
      for (const m of (res.messages || []) as Array<{
        ts?: string;
        user?: string;
        text?: string;
        reply_count?: number;
      }>) {
        const tok = tokenFor(m.user);
        if (m.ts && tok)
          targets.push({ ts: m.ts, token: tok, text: m.text || '' });
        if (m.ts && m.reply_count) {
          let rc: string | undefined;
          do {
            const rr = await reader.conversations.replies({
              channel,
              ts: m.ts,
              limit: 200,
              cursor: rc,
            });
            for (const r of (rr.messages || []) as Array<{
              ts?: string;
              user?: string;
              text?: string;
            }>) {
              if (r.ts === m.ts) continue; // parent handled above
              const rtok = tokenFor(r.user);
              if (r.ts && rtok)
                targets.push({ ts: r.ts, token: rtok, text: r.text || '' });
            }
            rc = rr.response_metadata?.next_cursor || undefined;
          } while (rc);
        }
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);

    console.log(
      `#${chName}: ${targets.length} message(s) posted by us/the bot.`,
    );
    if (dryRun) {
      for (const t of targets)
        console.log(`  would delete ${t.ts}  ${t.text.slice(0, 60)}`);
      continue;
    }
    let deleted = 0;
    for (const t of targets) {
      try {
        await deleter.chat.delete({ token: t.token, channel, ts: t.ts });
        deleted++;
        await sleep(Math.max(DELAY_MS, 400)); // chat.delete is rate-limited (Tier 3)
      } catch (err) {
        console.error(`  ✗ delete ${t.ts}:`, (err as Error).message);
      }
    }
    console.log(`  🧹 deleted ${deleted}/${targets.length} from #${chName}.`);
  }
}

async function resetGraphViaBrain(): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    console.log(
      '  (no SLACK_BOT_TOKEN — skipping graph reset; run `pnpm -C engine/mcp-server reset-graph <teamId>` manually)',
    );
    return;
  }
  let teamId: string | undefined;
  try {
    teamId = (
      (await new WebClient(botToken).auth.test()) as { team_id?: string }
    ).team_id;
  } catch (e) {
    console.error(
      '  graph reset skipped — bot auth.test failed:',
      (e as Error).message,
    );
    return;
  }
  if (!teamId) return;
  const base = (process.env.MCP_SERVER_URL || 'http://localhost:4000').replace(
    /\/$/,
    '',
  );
  const secret = process.env.INTERNAL_API_SECRET;
  try {
    const r = await fetch(
      `${base}/internal/reset-graph/${encodeURIComponent(teamId)}`,
      {
        method: 'POST',
        headers: secret ? { 'x-internal-secret': secret } : undefined,
      },
    );
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.ok)
      console.log(`  🧹 graph reset (team ${teamId}): ${JSON.stringify(j)}`);
    else
      console.error(
        `  graph reset failed (HTTP ${r.status}) — is the brain running at ${base}?`,
      );
  } catch (e) {
    console.error(
      `  graph reset failed — brain unreachable at ${base}:`,
      (e as Error).message,
    );
  }
}

async function main() {
  const lines = parseConversations(CONVO_FILE).filter(
    (l) => !only || l.channel === only,
  );
  if (lines.length === 0) {
    console.error(
      'No messages parsed (check --only value or demo-conversations.txt).',
    );
    process.exit(1);
  }

  const tokens: {
    users: Record<string, string>;
    channels?: Record<string, string>;
  } = fs.existsSync(TOKENS_FILE)
    ? JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'))
    : { users: {} };

  console.log(
    `Parsed ${lines.length} messages${only ? ` (channel: ${only})` : ''}.`,
  );

  // --clear: delete the seeded messages instead of posting them.
  if (clearMode) {
    const needed = new Set(lines.map((l) => l.channel));
    console.log(
      `${dryRun ? 'DRY RUN — ' : ''}clearing our messages from: ${[...needed]
        .map((c) => `#${c}`)
        .join(', ')}`,
    );
    await clearChannels(tokens, needed);
    if (!dryRun) {
      console.log('Resetting the workspace graph in the brain (team-wide)…');
      await resetGraphViaBrain();
    }
    return;
  }

  // --check: validate each user token via auth.test (never prints the token).
  if (args.includes('--check')) {
    const authors = [...new Set(lines.map((l) => l.name))];
    for (const name of authors) {
      const token = tokens.users[name];
      if (!token || token.startsWith('xoxp-...')) {
        console.log(`  ${name}: (no token in seed-users.json)`);
        continue;
      }
      try {
        const r = (await new WebClient().auth.test({ token })) as {
          user?: string;
          user_id?: string;
          team?: string;
        };
        console.log(
          `  ${name}: ✓ authed as ${r.user} (${r.user_id}) on ${r.team}`,
        );
      } catch (e) {
        console.log(
          `  ${name}: ✗ ${(e as { data?: { error?: string } }).data?.error || (e as Error).message}`,
        );
      }
    }
    return;
  }

  if (dryRun) {
    for (const l of lines)
      console.log(`  #${l.channel}  ${l.name}: ${l.text.slice(0, 80)}`);
    const missing = [...new Set(lines.map((l) => l.name))].filter(
      (n) => !tokens.users[n],
    );
    console.log(
      `\nDRY RUN — nothing posted. ${missing.length ? `Missing tokens for: ${missing.join(', ')}` : 'All authors have tokens.'}`,
    );
    return;
  }

  const needed = new Set(lines.map((l) => l.channel));
  const channelIds: Record<string, string> = { ...(tokens.channels || {}) };
  const toResolve = [...needed].filter((n) => !channelIds[n]);
  if (toResolve.length) {
    const botToken = process.env.SLACK_BOT_TOKEN;
    if (!botToken) {
      throw new Error(
        'SLACK_BOT_TOKEN missing in slack-bot/.env — needed to look up channel ids. ' +
          'Or add a "channels" map to seed-users.json, e.g. { "channels": { "backend": "C123" } }.',
      );
    }
    try {
      Object.assign(
        channelIds,
        await resolveChannels(new WebClient(botToken), new Set(toResolve)),
      );
    } catch (e) {
      console.error('Could not list channels:', (e as Error).message);
      console.error(
        'For private channels, pin ids in seed-users.json: "channels": { "backend": "C123", "frontend": "C456" }.',
      );
    }
  }

  const poster = new WebClient(); // user token passed per call
  let posted = 0;
  const skipped = new Set<string>();

  for (const l of lines) {
    const token = tokens.users[l.name];
    const channel = channelIds[l.channel];
    if (!token) {
      skipped.add(`no token for ${l.name}`);
      continue;
    }
    if (!channel) {
      skipped.add(`no channel #${l.channel} (is the bot a member?)`);
      continue;
    }
    try {
      await poster.chat.postMessage({
        token,
        channel,
        text: l.text,
        as_user: true,
      });
      posted++;
      console.log(`  ✓ #${l.channel}  ${l.name}: ${l.text.slice(0, 60)}`);
      await sleep(DELAY_MS);
    } catch (err) {
      console.error(`  ✗ ${l.name} → #${l.channel}:`, (err as Error).message);
    }
  }

  console.log(`\nPosted ${posted}/${lines.length} messages.`);
  if (skipped.size) console.log('Skipped:', [...skipped].join(' | '));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
