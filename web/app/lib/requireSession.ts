import { NextRequest, NextResponse } from 'next/server';
import { decodeSession, Session, SESSION_COOKIE } from './session';

export function getSession(req: NextRequest): Session | null {
  return decodeSession(req.cookies.get(SESSION_COOKIE)?.value);
}

// For routes scoped to a specific :teamId — the signed-in user may only act
// on the one team their session says they belong to, never any other.
export function requireOwnTeam(
  req: NextRequest,
  teamId: string,
): { session: Session } | NextResponse {
  const session = getSession(req);
  if (!session) {
    return NextResponse.json({ error: 'sign-in required' }, { status: 401 });
  }
  if (session.teamId !== teamId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return { session };
}
