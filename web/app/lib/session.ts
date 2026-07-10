import { createHmac, timingSafeEqual } from 'crypto';

// Signed, stateless session cookie: HMAC(payload) so a client can't forge or
// tamper with teamId/userId, but nothing is stored server-side. This is what
// replaced the DASHBOARD_KEY shared-secret gate — every request is now
// authorized against a specific signed-in Slack user + team, not a bearer
// token any holder could use for any company's data. Set directly from the
// bot-install OAuth callback (app/api/slack/oauth/callback) — authed_user.id
// is present there even with no user_scope requested, so there's no need for
// a separate "Sign in with Slack" round trip.

export const SESSION_COOKIE = 'se3k_session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface Session {
  userId: string;
  teamId: string;
  teamName?: string;
  name?: string;
}

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET not configured');
  return s;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function encodeSession(session: Session): string {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(cookieValue: string | undefined): Session | null {
  if (!cookieValue) return null;
  const dot = cookieValue.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  let expected: string;
  try {
    expected = sign(payload);
  } catch {
    return null; // SESSION_SECRET missing — fail closed
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as Session;
  } catch {
    return null;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_MAX_AGE_SECONDS,
};
