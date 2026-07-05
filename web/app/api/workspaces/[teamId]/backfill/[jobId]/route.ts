import { NextRequest, NextResponse } from 'next/server';
import { mcpFetch } from '../../../../../lib/mcpServer';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ teamId: string; jobId: string }> },
) {
  const { jobId } = await params;
  const res = await mcpFetch(`/internal/backfill/${encodeURIComponent(jobId)}`);
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
