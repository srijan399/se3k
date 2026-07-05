// Server-side only: every browser-facing route proxies through here so the
// shared internal secret never reaches the client.
const MCP_SERVER_URL = (process.env.MCP_SERVER_URL || 'http://localhost:4000').replace(/\/$/, '');
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

export async function mcpFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (INTERNAL_API_SECRET) headers['x-internal-secret'] = INTERNAL_API_SECRET;
  if (init?.body) headers['Content-Type'] = 'application/json';
  return fetch(`${MCP_SERVER_URL}${path}`, { ...init, headers, cache: 'no-store' });
}
