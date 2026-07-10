import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE } from '../../../lib/session';

export async function POST(req: NextRequest) {
  const base = (process.env.APP_BASE_URL || new URL(req.url).origin).replace(
    /\/$/,
    '',
  );
  const res = NextResponse.redirect(`${base}/workspaces`, { status: 303 });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
