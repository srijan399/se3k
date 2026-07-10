import { NextRequest, NextResponse } from 'next/server';
import { mcpFetch } from '../../../../lib/mcpServer';
import { requireOwnTeam } from '../../../../lib/requireSession';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await params;
  const guard = requireOwnTeam(req, teamId);
  if (guard instanceof NextResponse) return guard;
  const res = await mcpFetch(`/internal/channels?teamId=${encodeURIComponent(teamId)}`);
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
