"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GraphStore = void 0;
const drizzle_orm_1 = require("drizzle-orm");
const client_1 = require("../db/client");
const schema_1 = require("../db/schema");
const dbg = (...args) => console.error('[se3k:store]', ...args);
function rowToNode(r) {
    return {
        id: r.id,
        type: r.type,
        label: r.label,
        slackUserId: r.slackUserId ?? undefined,
        meta: r.meta ?? undefined,
    };
}
function nodeToRow(teamId, n) {
    return {
        teamId,
        id: n.id,
        type: n.type,
        label: n.label,
        slackUserId: n.slackUserId ?? null,
        meta: n.meta ?? null,
    };
}
function rowToEdge(r) {
    return {
        id: r.id,
        type: r.type,
        from: r.from,
        to: r.to,
        weight: r.weight,
        last_active: r.lastActive,
        sources: r.sources || [],
        meta: r.meta ?? undefined,
    };
}
function edgeToRow(teamId, e) {
    return {
        teamId,
        id: e.id,
        type: e.type,
        from: e.from,
        to: e.to,
        weight: e.weight,
        lastActive: e.last_active,
        sources: e.sources,
        meta: e.meta ?? null,
    };
}
function lookupRef(refs, r) {
    if (!refs || !r)
        return undefined;
    return refs[r] || refs[r.replace(/[^a-z0-9]/gi, '')];
}
function tokens(s) {
    return new Set(s
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2));
}
function bestRefByText(refs, evidence) {
    if (!refs || !evidence)
        return undefined;
    const ev = tokens(evidence);
    if (ev.size === 0)
        return undefined;
    let best;
    let bestScore = 0;
    for (const r of Object.values(refs)) {
        if (!r.text)
            continue;
        const t = tokens(r.text);
        let inter = 0;
        for (const w of ev)
            if (t.has(w))
                inter++;
        const score = inter / ev.size; // share of the evidence found in this message
        if (score > bestScore) {
            bestScore = score;
            best = r;
        }
    }
    return bestScore >= 0.5 ? best : undefined;
}
// Stable, comparable id fragment for a human/label string.
function slug(s) {
    return s
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
class GraphStore {
    constructor(teamId) {
        this.nodes = new Map();
        this.edges = new Map();
        this.teamId = teamId;
    }
    // Hydrate a team's graph from Postgres. Every MCP tool / REST handler gets
    // its own short-lived store per call — workspace-sized graphs are cheap to
    // load in full, so there's no cross-call cache to invalidate.
    static async forTeam(teamId) {
        const store = new GraphStore(teamId);
        await store.hydrate();
        return store;
    }
    async hydrate() {
        const [nodeRows, edgeRows] = await Promise.all([
            client_1.db.select().from(schema_1.graphNodes).where((0, drizzle_orm_1.eq)(schema_1.graphNodes.teamId, this.teamId)),
            client_1.db.select().from(schema_1.graphEdges).where((0, drizzle_orm_1.eq)(schema_1.graphEdges.teamId, this.teamId)),
        ]);
        this.nodes = new Map(nodeRows.map((r) => [r.id, rowToNode(r)]));
        this.edges = new Map(edgeRows.map((r) => [r.id, rowToEdge(r)]));
        dbg(`📂 loaded ${this.nodes.size} nodes · ${this.edges.size} edges (team ${this.teamId})`);
    }
    // Full-snapshot overwrite of this team's rows — mirrors the old JSON
    // file's "write the whole graph" semantics, just against Postgres.
    async saveTeam() {
        const nodeRows = [...this.nodes.values()].map((n) => nodeToRow(this.teamId, n));
        const edgeRows = [...this.edges.values()].map((e) => edgeToRow(this.teamId, e));
        await client_1.db.transaction(async (tx) => {
            await tx.delete(schema_1.graphNodes).where((0, drizzle_orm_1.eq)(schema_1.graphNodes.teamId, this.teamId));
            await tx.delete(schema_1.graphEdges).where((0, drizzle_orm_1.eq)(schema_1.graphEdges.teamId, this.teamId));
            if (nodeRows.length)
                await tx.insert(schema_1.graphNodes).values(nodeRows);
            if (edgeRows.length)
                await tx.insert(schema_1.graphEdges).values(edgeRows);
        });
        dbg(`💾 saved ${this.nodes.size} nodes · ${this.edges.size} edges (team ${this.teamId})`);
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
        dbg('🧹 cleared graph');
    }
    version() {
        let h = 0;
        for (const e of this.edges.values()) {
            const s = `${e.id}|${e.weight}|${e.last_active}`;
            for (let i = 0; i < s.length; i++)
                h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
        }
        return `${this.nodes.size}:${this.edges.size}:${h >>> 0}`;
    }
    upsertPerson(name, slackUserId) {
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
        dbg(`  🔎 found node · 🧑 Person   ${name}`);
        return node;
    }
    upsertProject(key, name) {
        const id = `project:${slug(key)}`;
        const existing = this.nodes.get(id);
        if (existing)
            return existing;
        const node = { id, type: 'Project', label: name || key };
        this.nodes.set(id, node);
        dbg(`  🔎 found node · 📁 Project  ${node.label}`);
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
        dbg(`  🔎 found node · ⚖️  Decision ${node.label}`);
        return node;
    }
    upsertChannel(name, channelId) {
        const id = `channel:${slug(name)}`;
        const existing = this.nodes.get(id);
        if (existing)
            return existing;
        const node = {
            id,
            type: 'Channel',
            label: name,
            meta: { channelId },
        };
        this.nodes.set(id, node);
        return node;
    }
    getNode(id) {
        return this.nodes.get(id);
    }
    // Human label for a node id (for readable edge logs).
    label(id) {
        return this.nodes.get(id)?.label ?? id;
    }
    async setPersonIds(ids) {
        const bySlug = new Map();
        for (const [name, id] of Object.entries(ids))
            if (name && id)
                bySlug.set(slug(name), id);
        let n = 0;
        for (const node of this.nodes.values()) {
            if (node.type !== 'Person' || node.slackUserId)
                continue;
            const id = bySlug.get(slug(node.label));
            if (id) {
                node.slackUserId = id;
                n++;
            }
        }
        if (n)
            await this.saveTeam();
        return n;
    }
    addInvolvement(personId, projectId, weight, ts, source) {
        const id = `INVOLVED_IN:${personId}->${projectId}`;
        const existing = this.edges.get(id);
        if (existing) {
            existing.weight += weight;
            if (ts > existing.last_active)
                existing.last_active = ts;
            existing.sources.push(source);
            dbg(`     ↳ 🔗 INVOLVED_IN  ${this.label(personId)} → ${this.label(projectId)}  (+${weight} → w${existing.weight})`);
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
        dbg(`     ↳ 🔗 INVOLVED_IN  ${this.label(personId)} → ${this.label(projectId)}  (w${weight})`);
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
        dbg(`     ↳ 🔗 ${type}  ${this.label(from)} → ${this.label(to)}`);
        return edge;
    }
    // ---------- ingestion ---------
    ingest(result, channel, refs, authors) {
        dbg(`📥 ingest · ${result.people?.length || 0} people · ${result.projects?.length || 0} projects · ` +
            `${result.decisions?.length || 0} decisions · ${result.involvement?.length || 0} involvement · ` +
            `${result.decisionEdges?.length || 0} decision-edges`);
        const authorBySlug = new Map();
        for (const [name, id] of Object.entries(authors || {}))
            authorBySlug.set(slug(name), id);
        const authorId = (name) => authorBySlug.get(slug(name));
        for (const p of result.people || [])
            this.upsertPerson(p.name, p.slackUserId || authorId(p.name));
        for (const pr of result.projects || [])
            this.upsertProject(pr.key, pr.name);
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
                dbg(`     ⚠️  dropped decision-edge — unknown decision "${de.decision}"`);
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
            if (!decision || !project)
                continue;
            this.addEdge('RELATES_TO', decision.id, project.id, new Date().toISOString());
        }
        const pruned = this.pruneOrphans();
        if (pruned)
            dbg(`🧽 pruned ${pruned} orphan node(s) (chatter, no edges)`);
        dbg(`✅ ingest done · graph: ${this.nodes.size} nodes · ${this.edges.size} edges`);
    }
    pruneOrphans() {
        const referenced = new Set();
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
    resolveProject(ref) {
        const direct = this.nodes.get(`project:${slug(ref)}`);
        if (direct)
            return direct;
        const key = slug(ref);
        return [...this.nodes.values()].find((n) => n.type === 'Project' &&
            (slug(n.label) === key || n.id === `project:${key}`));
    }
    resolveDecision(ref) {
        const direct = this.nodes.get(`decision:${slug(ref)}`);
        if (direct)
            return direct;
        const key = slug(ref);
        return [...this.nodes.values()].find((n) => n.type === 'Decision' && slug(n.label).includes(key.slice(0, 12)));
    }
    listProjects() {
        return [...this.nodes.values()].filter((n) => n.type === 'Project');
    }
    listDecisions() {
        return [...this.nodes.values()].filter((n) => n.type === 'Decision');
    }
    listPeople() {
        return [...this.nodes.values()].filter((n) => n.type === 'Person');
    }
    findPersonByText(text) {
        const people = this.listPeople();
        const mention = text.match(/<@([A-Za-z0-9]+)(?:\|[^>]+)?>/);
        if (mention) {
            const byId = people.find((p) => p.slackUserId === mention[1]);
            if (byId)
                return byId;
        }
        const t = text.toLowerCase();
        return (people.find((p) => t.includes(p.label.toLowerCase())) ||
            people.find((p) => {
                const first = p.label.split(/\s+/)[0].toLowerCase();
                return first.length > 2 && new RegExp(`\\b${first}\\b`).test(t);
            }));
    }
    personActivity(personId) {
        const now = Date.now();
        const halfLifeDays = 30;
        const projects = [...this.edges.values()]
            .filter((e) => e.type === 'INVOLVED_IN' && e.from === personId)
            .map((edge) => {
            const project = this.nodes.get(edge.to);
            const ageDays = (now - new Date(edge.last_active).getTime()) / 86400000;
            const recency = Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
            return { project, edge, score: edge.weight * (0.4 + 0.6 * recency) };
        })
            .filter((x) => x.project)
            .sort((a, b) => b.score - a.score);
        const decisions = [...this.edges.values()]
            .filter((e) => (e.type === 'RAISED_CONCERN' || e.type === 'MADE_CALL') &&
            e.from === personId)
            .map((edge) => ({ decision: this.nodes.get(edge.to), edge }))
            .filter((x) => x.decision);
        return { person: this.nodes.get(personId), projects, decisions };
    }
    findProjectByText(text) {
        const t = text.toLowerCase();
        const projects = this.listProjects();
        return (projects.find((p) => t.includes(p.label.toLowerCase())) ||
            projects.find((p) => p.label
                .toLowerCase()
                .split(/\s+/)
                .some((w) => w.length > 3 && t.includes(w))) ||
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
    rankExperts(projectId) {
        const now = Date.now();
        const halfLifeDays = 30;
        const involved = [...this.edges.values()].filter((e) => e.type === 'INVOLVED_IN' && e.to === projectId);
        return involved
            .map((edge) => {
            const person = this.nodes.get(edge.from);
            const ageDays = (now - new Date(edge.last_active).getTime()) / 86400000;
            const recency = Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
            const score = edge.weight * (0.4 + 0.6 * recency);
            return { person, edge, score };
        })
            .filter((x) => x.person)
            .sort((a, b) => b.score - a.score);
    }
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
