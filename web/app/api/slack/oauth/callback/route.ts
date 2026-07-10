import { NextRequest, NextResponse } from 'next/server';
import { mcpFetch } from '../../../../lib/mcpServer';
import { encodeSession, Session, SESSION_COOKIE, sessionCookieOptions } from '../../../../lib/session';

interface OAuthAccessResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  bot_user_id?: string;
  scope?: string;
  team?: { id?: string; name?: string };
  authed_user?: { id?: string };
}

interface UserInfoResponse {
  user?: { real_name?: string; profile?: { real_name?: string } };
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

  const res = NextResponse.redirect(
    `${base}/workspaces?connected=${encodeURIComponent(result.team.id)}`,
  );

  // Whoever completes this install flow IS the identity we scope the
  // dashboard session to — authed_user.id is present even with no
  // `user_scope` requested, so a second "Sign in with Slack" (OIDC) round
  // trip isn't needed. This also sidesteps OIDC's Enterprise Grid quirk
  // where sign-in resolves to the enterprise and never returns a team_id.
  const userId = result.authed_user?.id;
  if (userId) {
    let name: string | undefined;
    try {
      const infoRes = await fetch(
        `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`,
        { headers: { Authorization: `Bearer ${result.access_token}` } },
      );
      const info = (await infoRes.json()) as UserInfoResponse;
      name = info.user?.profile?.real_name || info.user?.real_name;
    } catch {
      /* best-effort display name only */
    }
    const session: Session = {
      userId,
      teamId: result.team.id,
      teamName: result.team.name,
      name,
    };
    res.cookies.set(SESSION_COOKIE, encodeSession(session), sessionCookieOptions);
  }

  return res;
}
