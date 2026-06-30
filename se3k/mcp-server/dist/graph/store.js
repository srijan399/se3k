"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.GraphStore = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// In-memory graph, JSON-persisted. Single source of truth for the whole system:
// the MCP tools mutate it, the Slack bot queries it (via MCP), and the Next.js
// dashboard reads the persisted snapshot.
// hackathon shortcut: a JSON file is plenty here; would move to SQLite/Neo4j
// only if we needed concurrent writers, which we don't for a demo.
const DEFAULT_PATH = path.resolve(__dirname, '../../../graph-store/graph.json');
function slug(s) {
    return s
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
class GraphStore {
    constructor(filePath = process.env.GRAPH_STORE_PATH || DEFAULT_PATH) {
        this.nodes = new Map();
        this.edges = new Map();
        this.filePath = filePath;
        this.load();
    }
    // ---------- persistence ----------
    load() {
        try {
            if (!fs.existsSync(this.filePath))
                return;
            const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
            this.nodes = new Map((raw.nodes || []).map((n) => [n.id, n]));
            this.edges = new Map((raw.edges || []).map((e) => [e.id, e]));
        }
        catch (err) {
            console.error('GraphStore.load failed (starting empty):', err);
        }
    }
    save() {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify(this.snapshot(), null, 2));
    }
    snapshot() {
        return {
            nodes: [...this.nodes.values()],
            edges: [...this.edges.values()],
            updatedAt: new Date().toISOString(),
        };
    }
    clear() {
        this.nodes.clear();
        this.edges.clear();
    }
    // ---------- node helpers (with entity resolution) ----------
    upsertPerson(name, slackUserId) {
        // Resolve by Slack user id first (most reliable), then by normalized name.
        let existing;
        if (slackUserId) {
            existing = [...this.nodes.values()].find((n) => n.type === 'Person' && n.slackUserId === slackUserId);
        }
        if (!existing) {
            const key = slug(name);
            existing = [...this.nodes.values()].find((n) => n.type === 'Person' && slug(n.label) === key);
        }
        if (existing) {
            if (slackUserId && !existing.slackUserId)
                existing.slackUserId = slackUserId;
            return existing;
        }
        const id = `person:${slackUserId || slug(name)}`;
        const node = { id, type: 'Person', label: name, slackUserId };
        this.nodes.set(id, node);
        return node;
    }
    upsertProject(key, name) {
        const id = `project:${slug(key)}`;
        const existing = this.nodes.get(id);
        if (existing)
            return existing;
        const node = { id, type: 'Project', label: name || key };
        this.nodes.set(id, node);
        return node;
    }
    upsertDecision(key, summary) {
        const id = `decision:${slug(key)}`;
        const existing = this.nodes.get(id);
        if (existing)
            return existing;
        const node = {
            id,
            type: 'Decision',
            label: summary || key,
            meta: { summary: summary || key },
        };
        this.nodes.set(id, node);
        return node;
    }
    upsertChannel(name, channelId) {
        const id = `channel:${slug(name)}`;
        const existing = this.nodes.get(id);
        if (existing)
            return existing;
        const node = { id, type: 'Channel', label: name, meta: { channelId } };
        this.nodes.set(id, node);
        return node;
    }
    getNode(id) {
        return this.nodes.get(id);
    }
    // ---------- edge helpers ----------
    // Merge an INVOLVED_IN edge: accumulate weight, advance last_active, append
    // the citing source. This accumulation is exactly what lets us rank experts.
    addInvolvement(personId, projectId, weight, ts, source) {
        const id = `INVOLVED_IN:${personId}->${projectId}`;
        const existing = this.edges.get(id);
        if (existing) {
            existing.weight += weight;
            if (ts > existing.last_active)
                existing.last_active = ts;
            existing.sources.push(source);
            return existing;
        }
        const edge = {
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
    addEdge(type, from, to, ts, source) {
        const id = `${type}:${from}->${to}`;
        const existing = this.edges.get(id);
        if (existing) {
            if (ts > existing.last_active)
                existing.last_active = ts;
            if (source)
                existing.sources.push(source);
            existing.weight += 1;
            return existing;
        }
        const edge = {
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
    ingest(result, channel) {
        for (const p of result.people || [])
            this.upsertPerson(p.name, p.slackUserId);
        for (const pr of result.projects || [])
            this.upsertProject(pr.key, pr.name);
        for (const d of result.decisions || [])
            this.upsertDecision(d.key, d.summary);
        for (const inv of result.involvement || []) {
            const person = this.upsertPerson(inv.person, undefined);
            const project = this.resolveProject(inv.project);
            if (!project)
                continue;
            this.addInvolvement(person.id, project.id, inv.weight || 1, inv.ts, {
                ...channel,
                ts: inv.ts,
                excerpt: inv.evidence,
            });
        }
        for (const de of result.decisionEdges || []) {
            const person = this.upsertPerson(de.person, undefined);
            const decision = this.resolveDecision(de.decision);
            if (!decision)
                continue;
            this.addEdge(de.type, person.id, decision.id, de.ts, {
                ...channel,
                ts: de.ts,
                excerpt: de.evidence,
            });
        }
        for (const rel of result.relations || []) {
            const decision = this.resolveDecision(rel.decision);
            const project = this.resolveProject(rel.project);
            if (!decision || !project)
                continue;
            this.addEdge('RELATES_TO', decision.id, project.id, new Date().toISOString());
        }
    }
    resolveProject(ref) {
        const direct = this.nodes.get(`project:${slug(ref)}`);
        if (direct)
            return direct;
        const key = slug(ref);
        return [...this.nodes.values()].find((n) => n.type === 'Project' && (slug(n.label) === key || n.id === `project:${key}`));
    }
    resolveDecision(ref) {
        const direct = this.nodes.get(`decision:${slug(ref)}`);
        if (direct)
            return direct;
        const key = slug(ref);
        return [...this.nodes.values()].find((n) => n.type === 'Decision' && slug(n.label).includes(key.slice(0, 12)));
    }
    // ---------- queries ----------
    listProjects() {
        return [...this.nodes.values()].filter((n) => n.type === 'Project');
    }
    listDecisions() {
        return [...this.nodes.values()].filter((n) => n.type === 'Decision');
    }
    findProjectByText(text) {
        const t = text.toLowerCase();
        const projects = this.listProjects();
        // best match: label tokens appearing in the query text
        return (projects.find((p) => t.includes(p.label.toLowerCase())) ||
            projects.find((p) => p.label.toLowerCase().split(/\s+/).some((w) => w.length > 3 && t.includes(w))) ||
            projects.find((p) => t.includes(p.id.replace('project:', '').replace(/-/g, ' '))));
    }
    findDecisionByText(text) {
        const t = text.toLowerCase();
        const decisions = this.listDecisions();
        return (decisions.find((d) => t.includes(d.label.toLowerCase())) ||
            decisions
                .map((d) => ({
                d,
                score: d.label
                    .toLowerCase()
                    .split(/\s+/)
                    .filter((w) => w.length > 3 && t.includes(w)).length,
            }))
                .sort((a, b) => b.score - a.score)
                .filter((x) => x.score > 0)[0]?.d);
    }
    // The core ranking: experts on a project, scored by accumulated weight with a
    // recency boost so a recently-active contributor outranks a long-dormant one.
    rankExperts(projectId) {
        const now = Date.now();
        const halfLifeDays = 30; // recency half-life
        const involved = [...this.edges.values()].filter((e) => e.type === 'INVOLVED_IN' && e.to === projectId);
        return involved
            .map((edge) => {
            const person = this.nodes.get(edge.from);
            const ageDays = (now - new Date(edge.last_active).getTime()) / 86400000;
            const recency = Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
            const score = edge.weight * (0.4 + 0.6 * recency); // weight dominates, recency tilts ties
            return { person, edge, score };
        })
            .filter((x) => x.person)
            .sort((a, b) => b.score - a.score);
    }
    // Provenance for a decision: who raised concerns, who made the call, sources.
    decisionProvenance(decisionId) {
        const decision = this.nodes.get(decisionId);
        if (!decision)
            return undefined;
        const inbound = [...this.edges.values()].filter((e) => e.to === decisionId);
        const concerns = inbound
            .filter((e) => e.type === 'RAISED_CONCERN')
            .map((edge) => ({ person: this.nodes.get(edge.from), edge }))
            .filter((x) => x.person);
        const calls = inbound
            .filter((e) => e.type === 'MADE_CALL')
            .map((edge) => ({ person: this.nodes.get(edge.from), edge }))
            .filter((x) => x.person);
        const relatedProjects = [...this.edges.values()]
            .filter((e) => e.type === 'RELATES_TO' && e.from === decisionId)
            .map((e) => this.nodes.get(e.to))
            .filter(Boolean);
        return { decision, concerns, calls, relatedProjects };
    }
}
exports.GraphStore = GraphStore;
