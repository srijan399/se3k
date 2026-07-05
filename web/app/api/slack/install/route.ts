import { NextRequest, NextResponse } from 'next/server';

// Keep in sync with se3k/slack-bot/manifest.json's oauth_config.scopes.bot —
// this is what actually gets requested/granted per installation; the
// manifest only configures what the Slack app is ALLOWED to ask for.
const SCOPES = [
  'app_mentions:read',
  'channels:history',
  'groups:history',
  'channels:read',
  'groups:read',
  'channels:join',
  'chat:write',
  'commands',
  'users:read',
].join(',');

export async function GET(req: NextRequest) {
  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: 'SLACK_CLIENT_ID not configured' }, { status: 500 });
  }
  const redirectUri = `${new URL(req.url).origin}/api/slack/oauth/callback`;
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('redirect_uri', redirectUri);
  return NextResponse.redirect(url.toString());
}
