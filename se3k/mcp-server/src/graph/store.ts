import * as fs from 'fs';
import * as path from 'path';
import {
  EdgeType,
  ExtractionResult,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  MessageRef,
  MessageRefs,
  Source,
} from './types';

const dbg = (...args: unknown[]) => console.error('[se3k:store]', ...args);

const DEFAULT_PATH = path.resolve(__dirname, '../../../graph-store/graph.json');

function lookupRef(
  refs: MessageRefs | undefined,
  r?: string,
): MessageRef | undefined {
  if (!refs || !r) return undefined;
  return refs[r] || refs[r.replace(/[^a-z0-9]/gi, '')];
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function bestRefByText(
  refs: MessageRefs | undefined,
  evidence?: string,
): MessageRef | undefined {
  if (!refs || !evidence) return undefined;
  const ev = tokens(evidence);
  if (ev.size === 0) return undefined;
  let best: MessageRef | undefined;
  let bestScore = 0;
  for (const r of Object.values(refs)) {
    if (!r.text) continue;
    const t = tokens(r.text);
    let inter = 0;
    for (const w of ev) if (t.has(w)) inter++;
    const score = inter / ev.size; // share of the evidence found in this message
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore >= 0.5 ? best : undefined;
}

// Stable, comparable id fragment for a human/label string.
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

  load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(
        fs.readFileSync(this.filePath, 'utf-8'),
      ) as GraphSnapshot;
      this.nodes = new Map((raw.nodes || []).map((n) => [n.id, n]));
      this.edges = new Map((raw.edges || []).map((e) => [e.id, e]));
      dbg(`📂 loaded ${this.nodes.size} nodes · ${this.edges.size} edges`);
    } catch (err) {
      dbg('load failed (starting empty):', err);
    }
  }

  save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.snapshot(), null, 2));
    dbg(`💾 saved ${this.nodes.size} nodes · ${this.edges.size} edges`);
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
    dbg('🧹 cleared graph');
  }

  version(): string {
    let h = 0;
    for (const e of this.edges.values()) {
      const s = `${e.id}|${e.weight}|${e.last_active}`;
      for (let i = 0; i < s.length; i++)
        h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    }
    return `${this.nodes.size}:${this.edges.size}:${h >>> 0}`;
  }

  upsertPerson(name: string, slackUserId?: string): GraphNode {
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
      if (slackUserId && !existing.slackUserId)
        existing.slackUserId = slackUserId;
      return existing;
    }
    const id = `person:${slackUserId || slug(name)}`;
    const node: GraphNode = { id, type: 'Person', label: name, slackUserId };
    this.nodes.set(id, node);
    dbg(`  🔎 found node · 🧑 Person   ${name}`);
    return node;
  }

  upsertProject(key: string, name?: string): GraphNode {
    const id = `project:${slug(key)}`;
    const existing = this.nodes.get(id);
    if (existing) return existing;
    const node: GraphNode = { id, type: 'Project', label: name || key };
    this.nodes.set(id, node);
    dbg(`  🔎 found node · 📁 Project  ${node.label}`);
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
    dbg(`  🔎 found node · ⚖️  Decision ${node.label}`);
    return node;
  }

  upsertChannel(name: string, channelId?: string): GraphNode {
    const id = `channel:${slug(name)}`;
    const existing = this.nodes.get(id);
    if (existing) return existing;
    const node: GraphNode = {
      id,
      type: 'Channel',
      label: name,
      meta: { channelId },
    };
    this.nodes.set(id, node);
    return node;
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  // Human label for a node id (for readable edge logs).
  private label(id: string): string {
    return this.nodes.get(id)?.label ?? id;
  }

  setPersonIds(ids: Record<string, string>): number {
    const bySlug = new Map<string, string>();
    for (const [name, id] of Object.entries(ids))
      if (name && id) bySlug.set(slug(name), id);
    let n = 0;
    for (const node of this.nodes.values()) {
      if (node.type !== 'Person' || node.slackUserId) continue;
      const id = bySlug.get(slug(node.label));
      if (id) {
        node.slackUserId = id;
        n++;
      }
    }
    if (n) this.save();
    return n;
  }

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
      dbg(
        `     ↳ 🔗 INVOLVED_IN  ${this.label(personId)} → ${this.label(projectId)}  (+${weight} → w${existing.weight})`,
      );
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
    dbg(
      `     ↳ 🔗 INVOLVED_IN  ${this.label(personId)} → ${this.label(projectId)}  (w${weight})`,
    );
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
    dbg(`     ↳ 🔗 ${type}  ${this.label(from)} → ${this.label(to)}`);
    return edge;
  }

  // ---------- ingestion ---------
  ingest(
    result: ExtractionResult,
    channel?: Source,
    refs?: MessageRefs,
    authors?: Record<string, string>,
  ): void {
    dbg(
      `📥 ingest · ${result.people?.length || 0} people · ${result.projects?.length || 0} projects · ` +
        `${result.decisions?.length || 0} decisions · ${result.involvement?.length || 0} involvement · ` +
        `${result.decisionEdges?.length || 0} decision-edges`,
    );

    const authorBySlug = new Map<string, string>();
    for (const [name, id] of Object.entries(authors || {}))
      authorBySlug.set(slug(name), id);
    const authorId = (name: string) => authorBySlug.get(slug(name));

    for (const p of result.people || [])
      this.upsertPerson(p.name, p.slackUserId || authorId(p.name));
    for (const pr of result.projects || []) this.upsertProject(pr.key, pr.name);
    for (const d of result.decisions || [])
      this.upsertDecision(d.key, d.summary);

    for (const inv of result.involvement || []) {
      const person = this.upsertPerson(inv.person, authorId(inv.person));
      const project = this.resolveProject(inv.project);
      if (!project) {
        dbg(`     ⚠️  dropped involvement — unknown project "${inv.project}"`);
        continue;
      }
      const ref = lookupRef(refs, inv.ref) || bestRefByText(refs, inv.evidence);
      const ts = ref?.ts || inv.ts;
      this.addInvolvement(person.id, project.id, inv.weight || 1, ts, {
        ...channel,
        ts,
        permalink: ref?.permalink,
        excerpt: inv.evidence,
      });
    }

    for (const de of result.decisionEdges || []) {
      const person = this.upsertPerson(de.person, authorId(de.person));
      const decision = this.resolveDecision(de.decision);
      if (!decision) {
        dbg(
          `     ⚠️  dropped decision-edge — unknown decision "${de.decision}"`,
        );
        continue;
      }
      const ref = lookupRef(refs, de.ref) || bestRefByText(refs, de.evidence);
      const ts = ref?.ts || de.ts;
      this.addEdge(de.type, person.id, decision.id, ts, {
        ...channel,
        ts,
        permalink: ref?.permalink,
        excerpt: de.evidence,
      });
    }

    for (const rel of result.relations || []) {
      const decision = this.resolveDecision(rel.decision);
      const project = this.resolveProject(rel.project);
      if (!decision || !project) continue;
      this.addEdge(
        'RELATES_TO',
        decision.id,
        project.id,
        new Date().toISOString(),
      );
    }

    const pruned = this.pruneOrphans();
    if (pruned) dbg(`🧽 pruned ${pruned} orphan node(s) (chatter, no edges)`);
    dbg(
      `✅ ingest done · graph: ${this.nodes.size} nodes · ${this.edges.size} edges`,
    );
  }

  private pruneOrphans(): number {
    const referenced = new Set<string>();
    for (const e of this.edges.values()) {
      referenced.add(e.from);
      referenced.add(e.to);
    }
    let n = 0;
    for (const id of [...this.nodes.keys()]) {
      if (!referenced.has(id)) {
        this.nodes.delete(id);
        n++;
      }
    }
    return n;
  }

  // Fuzzy-resolve a project reference (key or name) the LLM emitted.
  private resolveProject(ref: string): GraphNode | undefined {
    const direct = this.nodes.get(`project:${slug(ref)}`);
    if (direct) return direct;
    const key = slug(ref);
    return [...this.nodes.values()].find(
      (n) =>
        n.type === 'Project' &&
        (slug(n.label) === key || n.id === `project:${key}`),
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

  listProjects(): GraphNode[] {
    return [...this.nodes.values()].filter((n) => n.type === 'Project');
  }

  listDecisions(): GraphNode[] {
    return [...this.nodes.values()].filter((n) => n.type === 'Decision');
  }

  listPeople(): GraphNode[] {
    return [...this.nodes.values()].filter((n) => n.type === 'Person');
  }

  findPersonByText(text: string): GraphNode | undefined {
    const people = this.listPeople();
    const mention = text.match(/<@([A-Za-z0-9]+)(?:\|[^>]+)?>/);
    if (mention) {
      const byId = people.find((p) => p.slackUserId === mention[1]);
      if (byId) return byId;
    }
    const t = text.toLowerCase();
    return (
      people.find((p) => t.includes(p.label.toLowerCase())) ||
      people.find((p) => {
        const first = p.label.split(/\s+/)[0].toLowerCase();
        return first.length > 2 && new RegExp(`\\b${first}\\b`).test(t);
      })
    );
  }

  personActivity(personId: string): {
    person: GraphNode | undefined;
    projects: Array<{ project: GraphNode; edge: GraphEdge; score: number }>;
    decisions: Array<{ decision: GraphNode; edge: GraphEdge }>;
  } {
    const now = Date.now();
    const halfLifeDays = 30;
    const projects = [...this.edges.values()]
      .filter((e) => e.type === 'INVOLVED_IN' && e.from === personId)
      .map((edge) => {
        const project = this.nodes.get(edge.to)!;
        const ageDays =
          (now - new Date(edge.last_active).getTime()) / 86_400_000;
        const recency = Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
        return { project, edge, score: edge.weight * (0.4 + 0.6 * recency) };
      })
      .filter((x) => x.project)
      .sort((a, b) => b.score - a.score);
    const decisions = [...this.edges.values()]
      .filter(
        (e) =>
          (e.type === 'RAISED_CONCERN' || e.type === 'MADE_CALL') &&
          e.from === personId,
      )
      .map((edge) => ({ decision: this.nodes.get(edge.to)!, edge }))
      .filter((x) => x.decision);
    return { person: this.nodes.get(personId), projects, decisions };
  }
  findProjectByText(text: string): GraphNode | undefined {
    const t = text.toLowerCase();
    const projects = this.listProjects();
    return (
      projects.find((p) => t.includes(p.label.toLowerCase())) ||
      projects.find((p) =>
        p.label
          .toLowerCase()
          .split(/\s+/)
          .some((w) => w.length > 3 && t.includes(w)),
      ) ||
      projects.find((p) =>
        t.includes(p.id.replace('project:', '').replace(/-/g, ' ')),
      )
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

  rankExperts(
    projectId: string,
  ): Array<{ person: GraphNode; edge: GraphEdge; score: number }> {
    const now = Date.now();
    const halfLifeDays = 30;
    const involved = [...this.edges.values()].filter(
      (e) => e.type === 'INVOLVED_IN' && e.to === projectId,
    );
    return involved
      .map((edge) => {
        const person = this.nodes.get(edge.from)!;
        const ageDays =
          (now - new Date(edge.last_active).getTime()) / 86_400_000;
        const recency = Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
        const score = edge.weight * (0.4 + 0.6 * recency);
        return { person, edge, score };
      })
      .filter((x) => x.person)
      .sort((a, b) => b.score - a.score);
  }

  decisionProvenance(decisionId: string):
    | {
        decision: GraphNode;
        concerns: Array<{ person: GraphNode; edge: GraphEdge }>;
        calls: Array<{ person: GraphNode; edge: GraphEdge }>;
        relatedProjects: GraphNode[];
      }
    | undefined {
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
