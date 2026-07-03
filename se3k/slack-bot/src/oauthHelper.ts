import 'dotenv/config';
import * as http from 'http';
import { WebClient } from '@slack/web-api';

const PORT = Number(process.env.OAUTH_HELPER_PORT) || 3030;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const USER_SCOPE = 'chat:write';

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
    console.log('\n✅ Got a user token:');
    console.log(`   name:  ${name}`);
    console.log(`   id:    ${user.id}`);
    console.log(`   scope: ${user.scope}`);
    console.log(`   token: ${user.access_token}`);
    console.log(
      `\n   → add to seed-users.json:  "${name}": "${user.access_token}"\n`,
    );
    res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(
        `<h2>✅ Token captured for ${name}</h2><p>Copy it from the terminal into seed-users.json, then close this tab.</p>`,
      );
  } catch (e) {
    res.writeHead(500).end('token exchange failed — see terminal');
    console.error('token exchange failed:', e);
  }
});

server.listen(PORT, () => {
  console.log(`\nOAuth helper listening on ${REDIRECT_URI}`);
  console.log(
    '\n1) Log into Slack as the dummy user (use a separate/incognito browser).',
  );
  console.log('2) Open this authorize link in that browser and click Allow:\n');
  console.log(`   ${authorizeUrl}\n`);
  console.log(
    '3) The captured xoxp- token prints here. Ctrl-C when done, repeat per user.\n',
  );
});
