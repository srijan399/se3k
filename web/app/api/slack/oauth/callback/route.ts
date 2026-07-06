import { NextRequest, NextResponse } from 'next/server';
import { mcpFetch } from '../../../../lib/mcpServer';

interface OAuthAccessResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  bot_user_id?: string;
  scope?: string;
  team?: { id?: string; name?: string };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  // Must byte-match the redirect_uri the install route sent to /authorize, or
  // Slack rejects the exchange as `invalid_code`. Pin it via env so Vercel's
  // proxy can't hand back a mismatching scheme/host. See install/route.ts.
  const base = (process.env.APP_BASE_URL || url.origin).replace(/\/$/, '');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error) {
    return NextResponse.redirect(`${base}/workspaces?error=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return NextResponse.json({ error: 'missing ?code' }, { status: 400 });
  }

  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: 'SLACK_CLIENT_ID / SLACK_CLIENT_SECRET not configured' },
      { status: 500 },
    );
  }
  const redirectUri = `${base}/api/slack/oauth/callback`;

  const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const result = (await tokenRes.json()) as OAuthAccessResponse;

  if (!result.ok || !result.access_token || !result.team?.id) {
    return NextResponse.redirect(
      `${base}/workspaces?error=${encodeURIComponent(result.error || 'oauth_failed')}`,
    );
  }

  await mcpFetch('/internal/installations', {
    method: 'POST',
    body: JSON.stringify({
      teamId: result.team.id,
      teamName: result.team.name,
      botToken: result.access_token,
      botUserId: result.bot_user_id,
      scope: result.scope,
    }),
  });

  return NextResponse.redirect(`${base}/workspaces?connected=${encodeURIComponent(result.team.id)}`);
}
