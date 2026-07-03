import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { WebClient } from '@slack/web-api';

const CONVO_FILE = path.resolve(__dirname, '../../demo-conversations.txt');
const TOKENS_FILE = path.resolve(__dirname, '../seed-users.json');
const DELAY_MS = Number(process.env.SEED_DELAY_MS) || 500;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined; // "backend" | "frontend"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SeedLine {
  channel: string; // "backend" | "frontend"
  name: string;
  text: string;
}

function parseConversations(file: string): SeedLine[] {
  const out: SeedLine[] = [];
  let channel: string | null = null;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (line.startsWith('#backend')) {
      channel = 'backend';
      continue;
    }
    if (line.startsWith('#frontend')) {
      channel = 'frontend';
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
