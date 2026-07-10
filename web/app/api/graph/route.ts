import { NextRequest, NextResponse } from 'next/server';
import { mcpFetch } from '../../lib/mcpServer';
import { getSession } from '../../lib/requireSession';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession(req);
  if (!session) {
    return NextResponse.json({ error: 'sign-in required' }, { status: 401 });
  }
  // The graph is always the signed-in user's own team — a `team` param that
  // named a different team would just be ignored, never trusted.
  const teamId = session.teamId;
  try {
    const res = await mcpFetch(`/graph?teamId=${encodeURIComponent(teamId)}`);
    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch {
    return Response.json({ nodes: [], edges: [], updatedAt: null });
  }
}
