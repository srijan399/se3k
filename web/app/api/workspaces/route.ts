import { NextRequest, NextResponse } from 'next/server';
import { mcpFetch } from '../../lib/mcpServer';
import { getSession } from '../../lib/requireSession';

export const dynamic = 'force-dynamic';

interface Installation {
  teamId: string;
}

export async function GET(req: NextRequest) {
  const session = getSession(req);
  if (!session) {
    return NextResponse.json({ error: 'sign-in required' }, { status: 401 });
  }
  try {
    const res = await mcpFetch('/internal/installations');
    const data = (await res.json()) as Installation[];
    // Never hand back other companies' installations — only the signed-in
    // user's own team, even though the internal API returns everyone's.
    const own = Array.isArray(data)
      ? data.filter((i) => i.teamId === session.teamId)
      : [];
    return NextResponse.json(own, { status: res.status });
  } catch {
    return NextResponse.json([], { status: 200 });
  }
}
