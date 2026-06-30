import * as fs from 'fs';
import * as path from 'path';
import {
  EdgeType,
  ExtractionResult,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  Source,
} from './types';

// In-memory graph, JSON-persisted. Single source of truth for the whole system:
// the MCP tools mutate it, the Slack bot queries it (via MCP), and the Next.js
// dashboard reads the persisted snapshot.
// hackathon shortcut: a JSON file is plenty here; would move to SQLite/Neo4j
// only if we needed concurrent writers, which we don't for a demo.

const DEFAULT_PATH = path.resolve(
  __dirname,
  '../../../graph-store/graph.json',
);

function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export class GraphStore {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  private filePath: string;

  constructor(filePath: string = process.env.GRAPH_STORE_PATH || DEFAULT_PATH) {
    this.filePath = filePath;
    this.load();
  }

  // ---------- persistence ----------

  load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as GraphSnapshot;
      this.nodes = new Map((raw.nodes || []).map((n) => [n.id, n]));
      this.edges = new Map((raw.edges || []).map((e) => [e.id, e]));
    } catch (err) {
      console.error('GraphStore.load failed (starting empty):', err);
    }
  }

  save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.snapshot(), null, 2));
  }

  snapshot(): GraphSnapshot {
    return {
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      updatedAt: new Date().toISOString(),
    };
  }

  clear(): void {
    this.nodes.clear();
    this.edges.clear();
  }

  // ---------- node helpers (with entity resolution) ----------

  upsertPerson(name: string, slackUserId?: string): GraphNode {
    // Resolve by Slack user id first (most reliable), then by normalized name.
    let existing: GraphNode | undefined;
    if (slackUserId) {
      existing = [...this.nodes.values()].find(
        (n) => n.type === 'Person' && n.slackUserId === slackUserId,
      );
    }
    if (!existing) {
      const key = slug(name);
      existing = [...this.nodes.values()].find(
        (n) => n.type === 'Person' && slug(n.label) === key,
      );
    }
    if (existing) {
      if (slackUserId && !existing.slackUserId) existing.slackUserId = slackUserId;
      return existing;
    }
    const id = `person:${slackUserId || slug(name)}`;
    const node: GraphNode = { id, type: 'Person', label: name, slackUserId };
    this.nodes.set(id, node);
    return node;
  }

  upsertProject(key: string, name?: string): GraphNode {
    const id = `project:${slug(key)}`;
    const existing = this.nodes.get(id);
    if (existing) return existing;
    const node: GraphNode = { id, type: 'Project', label: name || key };
    this.nodes.set(id, node);
    return node;
  }

  upsertDecision(key: string, summary?: string): GraphNode {
    const id = `decision:${slug(key)}`;
    const existing = this.nodes.get(id);
    if (existing) return existing;
    const node: GraphNode = {
      id,
      type: 'Decision',
      label: summary || key,
      meta: { summary: summary || key },
    };
    this.nodes.set(id, node);
    return node;
  }

  upsertChannel(name: string, channelId?: string): GraphNode {
    const id = `channel:${slug(name)}`;
    const existing = this.nodes.get(id);
    if (existing) return existing;
    const node: GraphNode = { id, type: 'Channel', label: name, meta: { channelId } };
    this.nodes.set(id, node);
    return node;
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  // ---------- edge helpers ----------

  // Merge an INVOLVED_IN edge: accumulate weight, advance last_active, append
  // the citing source. This accumulation is exactly what lets us rank experts.
  addInvolvement(
    personId: string,
    projectId: string,
    weight: number,
    ts: string,
    source: Source,
  ): GraphEdge {
    const id = `INVOLVED_IN:${personId}->${projectId}`;
    const existing = this.edges.get(id);
    if (existing) {
      existing.weight += weight;
      if (ts > existing.last_active) existing.last_active = ts;
      existing.sources.push(source);
      return existing;
    }
    const edge: GraphEdge = {
      id,
      type: 'INVOLVED_IN',
      from: personId,
      to: projectId,
      weight,
      last_active: ts,
      sources: [source],
    };
    this.edges.set(id, edge);
    return edge;
  }

  // Generic relation edge (RAISED_CONCERN / MADE_CALL / RELATES_TO / POSTED_IN).
  addEdge(
    type: EdgeType,
    from: string,
    to: string,
    ts: string,
    source?: Source,
  ): GraphEdge {
    const id = `${type}:${from}->${to}`;
    const existing = this.edges.get(id);
    if (existing) {
      if (ts > existing.last_active) existing.last_active = ts;
      if (source) existing.sources.push(source);
      existing.weight += 1;
      return existing;
    }
    const edge: GraphEdge = {
      id,
      type,
      from,
      to,
      weight: 1,
      last_active: ts,
      sources: source ? [source] : [],
    };
    this.edges.set(id, edge);
    return edge;
  }

  // ---------- ingestion ----------

  // Merge a full LLM extraction batch into the graph.
  ingest(result: ExtractionResult, channel?: Source): void {
    for (const p of result.people || []) this.upsertPerson(p.name, p.slackUserId);
    for (const pr of result.projects || []) this.upsertProject(pr.key, pr.name);
    for (const d of result.decisions || []) this.upsertDecision(d.key, d.summary);

    for (const inv of result.involvement || []) {
      const person = this.upsertPerson(inv.person, undefined);
      const project = this.resolveProject(inv.project);
      if (!project) continue;
      this.addInvolvement(person.id, project.id, inv.weight || 1, inv.ts, {
        ...channel,
        ts: inv.ts,
        excerpt: inv.evidence,
      });
    }

    for (const de of result.decisionEdges || []) {
      const person = this.upsertPerson(de.person, undefined);
      const decision = this.resolveDecision(de.decision);
      if (!decision) continue;
      this.addEdge(de.type, person.id, decision.id, de.ts, {
        ...channel,
        ts: de.ts,
        excerpt: de.evidence,
      });
    }

    for (const rel of result.relations || []) {
      const decision = this.resolveDecision(rel.decision);
      const project = this.resolveProject(rel.project);
      if (!decision || !project) continue;
      this.addEdge('RELATES_TO', decision.id, project.id, new Date().toISOString());
    }
  }

  private resolveProject(ref: string): GraphNode | undefined {
    const direct = this.nodes.get(`project:${slug(ref)}`);
    if (direct) return direct;
    const key = slug(ref);
    return [...this.nodes.values()].find(
      (n) => n.type === 'Project' && (slug(n.label) === key || n.id === `project:${key}`),
    );
  }

  private resolveDecision(ref: string): GraphNode | undefined {
    const direct = this.nodes.get(`decision:${slug(ref)}`);
    if (direct) return direct;
    const key = slug(ref);
    return [...this.nodes.values()].find(
      (n) => n.type === 'Decision' && slug(n.label).includes(key.slice(0, 12)),
    );
  }

  // ---------- queries ----------

  listProjects(): GraphNode[] {
    return [...this.nodes.values()].filter((n) => n.type === 'Project');
  }

  listDecisions(): GraphNode[] {
    return [...this.nodes.values()].filter((n) => n.type === 'Decision');
  }

  findProjectByText(text: string): GraphNode | undefined {
    const t = text.toLowerCase();
    const projects = this.listProjects();
    // best match: label tokens appearing in the query text
    return (
      projects.find((p) => t.includes(p.label.toLowerCase())) ||
      projects.find((p) => p.label.toLowerCase().split(/\s+/).some((w) => w.length > 3 && t.includes(w))) ||
      projects.find((p) => t.includes(p.id.replace('project:', '').replace(/-/g, ' ')))
    );
  }

  findDecisionByText(text: string): GraphNode | undefined {
    const t = text.toLowerCase();
    const decisions = this.listDecisions();
    return (
      decisions.find((d) => t.includes(d.label.toLowerCase())) ||
      decisions
        .map((d) => ({
          d,
          score: d.label
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length > 3 && t.includes(w)).length,
        }))
        .sort((a, b) => b.score - a.score)
        .filter((x) => x.score > 0)[0]?.d
    );
  }

  // The core ranking: experts on a project, scored by accumulated weight with a
  // recency boost so a recently-active contributor outranks a long-dormant one.
  rankExperts(projectId: string): Array<{ person: GraphNode; edge: GraphEdge; score: number }> {
    const now = Date.now();
    const halfLifeDays = 30; // recency half-life
    const involved = [...this.edges.values()].filter(
      (e) => e.type === 'INVOLVED_IN' && e.to === projectId,
    );
    return involved
      .map((edge) => {
        const person = this.nodes.get(edge.from)!;
        const ageDays = (now - new Date(edge.last_active).getTime()) / 86_400_000;
        const recency = Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
        const score = edge.weight * (0.4 + 0.6 * recency); // weight dominates, recency tilts ties
        return { person, edge, score };
      })
      .filter((x) => x.person)
      .sort((a, b) => b.score - a.score);
  }

  // Provenance for a decision: who raised concerns, who made the call, sources.
  decisionProvenance(decisionId: string): {
    decision: GraphNode;
    concerns: Array<{ person: GraphNode; edge: GraphEdge }>;
    calls: Array<{ person: GraphNode; edge: GraphEdge }>;
    relatedProjects: GraphNode[];
  } | undefined {
    const decision = this.nodes.get(decisionId);
    if (!decision) return undefined;
    const inbound = [...this.edges.values()].filter((e) => e.to === decisionId);
    const concerns = inbound
      .filter((e) => e.type === 'RAISED_CONCERN')
      .map((edge) => ({ person: this.nodes.get(edge.from)!, edge }))
      .filter((x) => x.person);
    const calls = inbound
      .filter((e) => e.type === 'MADE_CALL')
      .map((edge) => ({ person: this.nodes.get(edge.from)!, edge }))
      .filter((x) => x.person);
    const relatedProjects = [...this.edges.values()]
      .filter((e) => e.type === 'RELATES_TO' && e.from === decisionId)
      .map((e) => this.nodes.get(e.to)!)
      .filter(Boolean);
    return { decision, concerns, calls, relatedProjects };
  }
}
