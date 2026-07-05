import { NextRequest } from 'next/server';
import { mcpFetch } from '../../lib/mcpServer';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const teamId = req.nextUrl.searchParams.get('team');
  if (!teamId) {
    return Response.json({ nodes: [], edges: [], updatedAt: null });
  }
  try {
    const res = await mcpFetch(`/graph?teamId=${encodeURIComponent(teamId)}`);
    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch {
    return Response.json({ nodes: [], edges: [], updatedAt: null });
  }
}
