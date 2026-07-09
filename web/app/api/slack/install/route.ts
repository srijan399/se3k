import { NextRequest, NextResponse } from 'next/server';

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
    return NextResponse.json(
      { error: 'SLACK_CLIENT_ID not configured' },
      { status: 500 },
    );
  }

  const base = (process.env.APP_BASE_URL || new URL(req.url).origin).replace(
    /\/$/,
    '',
  );
  const redirectUri = `${base}/api/slack/oauth/callback`;
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('redirect_uri', redirectUri);
  // Force a specific workspace when known — without this, Slack defaults to
  // whichever workspace session is active in the browser and won't offer a
  // picker for workspaces you haven't separately signed into.
  const team = new URL(req.url).searchParams.get('team');
  if (team) url.searchParams.set('team', team);
  return NextResponse.redirect(url.toString());
}
