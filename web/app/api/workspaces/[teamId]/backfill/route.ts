import { NextRequest, NextResponse } from 'next/server';
import { mcpFetch } from '../../../../lib/mcpServer';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await params;
  const body = await req.json().catch(() => ({}));
  const res = await mcpFetch('/internal/backfill', {
    method: 'POST',
    body: JSON.stringify({
      teamId,
      channelIds: body.channelIds,
      autoJoinPublic: body.autoJoinPublic,
    }),
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
