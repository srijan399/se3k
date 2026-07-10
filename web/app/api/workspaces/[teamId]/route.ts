import { NextRequest, NextResponse } from 'next/server';
import { mcpFetch } from '../../../lib/mcpServer';
import { requireOwnTeam } from '../../../lib/requireSession';

export const dynamic = 'force-dynamic';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await params;
  const guard = requireOwnTeam(req, teamId);
  if (guard instanceof NextResponse) return guard;

  // 1. Get the install so we have the bot token for apps.uninstall.
  const infoRes = await mcpFetch(
    `/internal/installations/${encodeURIComponent(teamId)}`,
  );
  if (infoRes.status === 404) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const install = (await infoRes.json().catch(() => null)) as {
    botToken?: string;
  } | null;

  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (install?.botToken && clientId && clientSecret) {
    try {
      const r = await fetch('https://slack.com/api/apps.uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          token: install.botToken,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!j.ok)
        console.warn(`[se3k] apps.uninstall(${teamId}) failed: ${j.error}`);
    } catch (err) {
      console.warn(`[se3k] apps.uninstall(${teamId}) threw:`, err);
    }
  }

  const res = await mcpFetch(
    `/internal/installations/${encodeURIComponent(teamId)}`,
    { method: 'DELETE' },
  );
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
