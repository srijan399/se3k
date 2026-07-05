import { NextRequest, NextResponse } from 'next/server';
import { mcpFetch } from '../../../../lib/mcpServer';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await params;
  const res = await mcpFetch(`/internal/channels?teamId=${encodeURIComponent(teamId)}`);
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
