import { promises as fs } from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const GRAPH_PATH =
  process.env.GRAPH_STORE_PATH ||
  path.resolve(process.cwd(), '../se3k/graph-store/graph.json');

export async function GET() {
  try {
    const raw = await fs.readFile(GRAPH_PATH, 'utf-8');
    return new Response(raw, {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return Response.json({ nodes: [], edges: [], updatedAt: null });
  }
}
