import { NextResponse } from 'next/server';
import { mcpFetch } from '../../lib/mcpServer';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const res = await mcpFetch('/internal/installations');
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json([], { status: 200 });
  }
}
