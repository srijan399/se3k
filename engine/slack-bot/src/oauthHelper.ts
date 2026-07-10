import 'dotenv/config';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { WebClient } from '@slack/web-api';

// Prompt on the terminal (used when we can't auto-resolve a display name).
function ask(q: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((res) =>
    rl.question(q, (a) => {
      rl.close();
      res(a.trim());
    }),
  );
}

const PORT = Number(process.env.OAUTH_HELPER_PORT) || 3030;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const USER_SCOPE = 'chat:write';

const TOKENS_FILE = path.resolve(__dirname, '../seed-users.json');
const args = process.argv.slice(2);
const nameIdx = args.indexOf('--name');
const nameOverride = nameIdx >= 0 ? args[nameIdx + 1] : undefined;

function saveToken(name: string, token: string): void {
  let data: {
    users: Record<string, string>;
    channels?: Record<string, string>;
  } = {
    users: {},
  };
  if (fs.existsSync(TOKENS_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    } catch {}
  }
  if (!data.users) data.users = {};
  data.users[name] = token;
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2) + '\n');
}

const clientId = process.env.SLACK_CLIENT_ID;
const clientSecret = process.env.SLACK_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    'Missing SLACK_CLIENT_ID / SLACK_CLIENT_SECRET in slack-bot/.env.\n' +
      'Find them under your app → Basic Information → App Credentials.',
  );
  process.exit(1);
}

const authorizeUrl =
  `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(clientId)}` +
  `&user_scope=${encodeURIComponent(USER_SCOPE)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '', `http://localhost:${PORT}`);
  if (!url.pathname.startsWith('/callback')) {
    res.writeHead(404).end('not found');
    return;
  }
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');
  if (err) {
    res.writeHead(400).end(`OAuth error: ${err}`);
    console.error('OAuth error:', err);
    return;
  }
  if (!code) {
    res.writeHead(400).end('missing ?code');
    return;
  }
  try {
    // oauth.v2.access is unauthenticated (client_id/secret in the body).
    const result = (await new WebClient().oauth.v2.access({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: REDIRECT_URI,
    })) as {
      authed_user?: { id?: string; access_token?: string; scope?: string };
      team?: { name?: string };
    };
    const user = result.authed_user;
    if (!user?.access_token) {
      res
        .writeHead(500)
        .end('no user token in response — did you grant a user scope?');
      console.error(
        'No authed_user.access_token in response:',
        JSON.stringify(result),
      );
      return;
    }
    // Resolve the display name for convenience (bot token, users:read).
    let name = user.id || '';
    try {
      const info = await new WebClient(process.env.SLACK_BOT_TOKEN).users.info({
        user: user.id!,
      });
      const u = info.user as {
        profile?: { real_name?: string };
        real_name?: string;
      };
      name = u?.profile?.real_name || u?.real_name || name;
    } catch {
      /* best-effort */
    }
    let finalName = nameOverride || name;

    if (!nameOverride && (!finalName || finalName === user.id)) {
      console.log(
        `\n⚠️  couldn't auto-resolve a display name (SLACK_BOT_TOKEN stale / missing users:read).`,
      );
      finalName =
        (await ask(
          '   Name to save this token under (must match your seed file): ',
        )) ||
        user.id ||
        '';
    }
    saveToken(finalName, user.access_token);
    console.log(
      `\n✅ Saved token for "${finalName}" (${user.id}) → seed-users.json`,
    );
    console.log(`   scope: ${user.scope}`);
    console.log('   Repeat for the next user, or Ctrl-C when done.\n');
    res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(
        `<h2>✅ Saved token for ${finalName}</h2><p>Written to seed-users.json. Authorize the next user, or close this tab.</p>`,
      );
  } catch (e) {
    res.writeHead(500).end('token exchange failed — see terminal');
    console.error('token exchange failed:', e);
  }
});

server.listen(PORT, () => {
  console.log(`\nOAuth helper listening on ${REDIRECT_URI}`);
  console.log(
    '\n1) Log into Slack as each user (separate incognito windows work well).',
  );
  console.log('2) Open this authorize link in that window and click Allow:\n');
  console.log(`   ${authorizeUrl}\n`);
  console.log(
    "3) The token is auto-saved to seed-users.json (keyed by the user's real name).",
  );
  console.log('   Keep this running and repeat per user; Ctrl-C when done.');
  console.log(
    `   Override the key with a flag if the name differs: pnpm oauth:helper --name "Ivan Sanders"\n`,
  );
});
