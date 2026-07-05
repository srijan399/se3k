// Same filter slack-bot applies to live messages (src/index.ts there) — kept
// as a small local copy since mcp-server and slack-bot are separate pnpm
// projects with no shared package today.
export function isNoise(text: string): boolean {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 2) return true;
  if (/^\+\d+$/.test(t)) return true; // "+1"
  if (!/[a-z0-9]/i.test(t.replace(/:[a-z0-9_+-]+:/gi, ''))) return true; // emoji/reaction only
  return false;
}
