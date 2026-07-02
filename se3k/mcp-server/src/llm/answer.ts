import { GraphStore } from '../graph/store';
import { GraphNode, Source } from '../graph/types';
import { chat, llmEnabled } from './client';
import * as cache from '../cache/semanticCache';

// STDOUT is the MCP JSON-RPC transport — debug goes to stderr only.
const dbg = (...args: unknown[]) => console.error('[se3k:answer]', ...args);

// Design principle: we NEVER let the LLM free-associate over the graph. We
// resolve the relevant node + subgraph deterministically in code, then ask the
// LLM only to phrase facts we already grounded. That keeps answers honest and
// always sourced.

export type Intent = 'expertise' | 'provenance' | 'overview' | 'person';

export interface AnswerResult {
  text: string; // natural-language answer for Slack
  sources: Source[]; // citations backing the answer
  kind: Intent | 'unknown';
}

// Keyword classifier — the no-LLM fallback for choosing the behavior. Order
// matters: broad "who's doing what / status" questions are checked first so they
// don't get mistaken for expertise routing on a single project.
function classify(question: string): Intent {
  const q = question.toLowerCase();
  if (
    /\b(status|overview|going on|catch me up|standup|stand-up)\b|who('?s| is)?\s+doing\s+what|who owns what|what('?s| is)?\s+(everyone|everybody|the team|we|people)\s+(doing|working on|up to)|update (of|on) who/.test(
      q,
    )
  ) {
    return 'overview';
  }
  if (/\bwhy\b|decid|decision|reason|chose|stop using|dropped|pushed back|concern|rationale/.test(q)) {
    return 'provenance';
  }
  return 'expertise';
}

// Some models wrap JSON in ```json fences despite instructions — strip them.
function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Turn the LLM's markdown into Slack markup: tag each known person as <@id>
// (removing any ** or * around their name), then convert any remaining **bold**
// into Slack's *bold*. People without a Slack id keep their plain name.
function renderForSlack(text: string, people: GraphNode[]): string {
  const seen = new Set<string>();
  const withId = people
    .filter((p) => p.slackUserId && !seen.has(p.id) && seen.add(p.id))
    .sort((a, b) => b.label.length - a.label.length); // longest first, avoid partial hits
  for (const p of withId) {
    const re = new RegExp(`\\*{0,2}${escapeRegExp(p.label)}\\*{0,2}`, 'g');
    text = text.replace(re, `<@${p.slackUserId}>`);
  }
  return text.replace(/\*\*([^*]+)\*\*/g, '*$1*');
}

// Render one citation. With a real permalink we emit a clickable Slack link
// straight to the source message ("proof"); otherwise fall back to text.
function fmtSource(s: Source): string {
  const where = s.channel || 'Slack';
  const quote = s.excerpt ? ` — "${s.excerpt}"` : '';
  const label = `${where}${quote}`;
  if (s.permalink) return `<${s.permalink}|${label}>`;
  return `${where}${s.ts ? ` @ ${s.ts}` : ''}${quote}`;
}

// ---------------------------------------------------------------------------
// Query routing: map a question to ONE graph node + intent using a COMPACT
// catalog (node LABELS only — no message bodies), so it's cheap and robust even
// when the question is loosely worded. Example-driven for the small model.
// ---------------------------------------------------------------------------
const ROUTER_SYSTEM = `You route a user's question in a team knowledge graph: label the intent and, when it's about ONE specific thing, pick the matching node id.

Return STRICT JSON only: { "intent": "expertise" | "provenance" | "overview", "targetId": "<an id from the catalog, or empty string>" }

- "expertise" = "who knows / who do I talk to / who should I ask about X" (a SPECIFIC topic) → choose a PROJECT id.
- "provenance" = "why did we decide / the reasoning / who pushed back on X" → choose a DECISION id.
- "overview" = a BROAD status question with no single topic: "who's doing what", "give me an update", "what's everyone working on", "status", "who owns what". → "targetId": "" (no single node).
- Pick the SINGLE best-matching id from the catalog. Match on meaning, not exact words. If nothing matches, "targetId": "".

EXAMPLES
Catalog: {"projects":[{"id":"project:checkout-api","label":"Checkout API"},{"id":"project:cart-ui","label":"Cart / checkout UI"}],"decisions":[{"id":"decision:adopt-pgbouncer","label":"Adopt PgBouncer connection pooling"}]}
Q: "who should I ask about checkout timing out?"      → {"intent":"expertise","targetId":"project:checkout-api"}
Q: "who knows the cart page?"                          → {"intent":"expertise","targetId":"project:cart-ui"}
Q: "why did we start using PgBouncer?"                 → {"intent":"provenance","targetId":"decision:adopt-pgbouncer"}
Q: "give me an update of who is doing what"            → {"intent":"overview","targetId":""}
Q: "what's everyone working on this week?"             → {"intent":"overview","targetId":""}
Q: "who owns the mobile app?"                          → {"intent":"expertise","targetId":""}

Output ONLY the JSON object.`;

async function resolveQuery(
  store: GraphStore,
  question: string,
): Promise<{ intent: Intent; node?: GraphNode }> {
  // Person-scoped first: "what is <person> working on?" — answer about THAT
  // person only, not the whole team. Needs both a named person AND a work/status
  // phrasing (so "who knows X" isn't hijacked).
  const person = store.findPersonByText(question);
  if (
    person &&
    /(working on|work on|worked on|\bworking\b|\bdoing\b|up to|focus|\binvolved\b|responsible|\btasks?\b|contributing|been on|update on|status of|what (is|are|has|'?s) )/i.test(
      question,
    )
  ) {
    dbg(`router → intent=person (${person.label})`);
    return { intent: 'person', node: person };
  }

  const projects = store.listProjects();
  const decisions = store.listDecisions();

  if (llmEnabled && projects.length + decisions.length > 0) {
    try {
      const catalog = {
        projects: projects.map((p) => ({ id: p.id, label: p.label })),
        decisions: decisions.map((d) => ({ id: d.id, label: d.label })),
      };
      const raw = await chat({
        system: ROUTER_SYSTEM,
        user: `Question: "${question}"\n\nCatalog (labels only):\n${JSON.stringify(catalog)}`,
        json: true,
        temperature: 0,
      });
      const parsed = JSON.parse(stripFences(raw)) as { intent?: string; targetId?: string };
      const intent: Intent =
        parsed.intent === 'provenance'
          ? 'provenance'
          : parsed.intent === 'overview'
            ? 'overview'
            : 'expertise';
      dbg(`router → intent=${intent} targetId=${parsed.targetId || '(none)'}`);
      if (intent === 'overview') return { intent };
      const node = parsed.targetId ? store.getNode(parsed.targetId) : undefined;
      if (node) return { intent, node };
      return {
        intent,
        node:
          intent === 'provenance'
            ? store.findDecisionByText(question)
            : store.findProjectByText(question),
      };
    } catch (err) {
      dbg('router LLM error, using keyword heuristic:', err);
    }
  }

  const intent = classify(question);
  dbg(`router (heuristic) → intent=${intent}`);
  if (intent === 'overview') return { intent };
  return {
    intent,
    node:
      intent === 'provenance'
        ? store.findDecisionByText(question)
        : store.findProjectByText(question),
  };
}

// Person-scoped status: what ONE named person is actually working on — their
// projects and any decisions they shaped. Never mentions anyone else.
async function personAnswer(
  store: GraphStore,
  person: GraphNode,
  question: string,
): Promise<AnswerResult> {
  const act = store.personActivity(person.id);
  if (act.projects.length === 0 && act.decisions.length === 0) {
    return {
      kind: 'person',
      sources: [],
      text: `I don't have any tracked work for ${person.label} yet — they may not have been active in a channel I've ingested.`,
    };
  }
  const sources = act.projects.flatMap((p) => p.edge.sources.slice(-2));
  const facts = [
    `${person.label}'s demonstrated work:`,
    ...act.projects.map(
      (p) =>
        `- ${p.project.label} (score ${p.score.toFixed(1)}): ${p.edge.sources
          .map((s) => s.excerpt)
          .filter(Boolean)
          .slice(-2)
          .join(' | ')}`,
    ),
    ...act.decisions.map(
      (d) =>
        `- ${d.edge.type === 'MADE_CALL' ? 'made the final call on' : 'raised a concern on'}: ${d.decision.label}`,
    ),
  ].join('\n');
  const text = await phrase(
    `Question: "${question}"\n\nHere is ONLY what ${person.label} has actually worked on (from the graph):\n\n${facts}\n\nWrite a concise Slack answer describing what ${person.label} is working on — the project(s) they're driving and briefly what they did or decided. Talk ONLY about ${person.label}; do NOT mention any other person. Do not invent anything.`,
    `*${person.label}* is working on: ${act.projects.map((p) => p.project.label).join(', ') || '—'}.`,
  );
  return { kind: 'person', text: renderForSlack(text, [person]), sources };
}

// Team status digest: for each project with activity, who's driving it (top
// demonstrated involvement) and a one-line what. Deterministic → phrased.
async function overviewAnswer(store: GraphStore, question: string): Promise<AnswerResult> {
  const perProject = store
    .listProjects()
    .map((project) => ({ project, top: store.rankExperts(project.id).slice(0, 2) }))
    .filter((x) => x.top.length > 0)
    .sort((a, b) => b.top[0].score - a.top[0].score);

  if (perProject.length === 0) {
    return {
      kind: 'overview',
      sources: [],
      text: "I don't have any tracked work yet — invite me to a channel or ingest some messages first.",
    };
  }

  const people = perProject.flatMap((x) => x.top.map((t) => t.person));
  const sources = perProject.flatMap((x) => x.top.flatMap((t) => t.edge.sources.slice(-1)));
  const facts = perProject
    .map((x) => {
      const lead = x.top[0];
      const ev = lead.edge.sources.map((s) => s.excerpt).filter(Boolean).slice(-1).join('');
      const others = x.top.slice(1).map((t) => t.person.label);
      return `${x.project.label}: ${lead.person.label} is driving it (score ${lead.score.toFixed(1)}${
        ev ? `, e.g. "${ev}"` : ''
      })${others.length ? `; also ${others.join(', ')}` : ''}.`;
    })
    .join('\n');

  const text = await phrase(
    `Question: "${question}"\n\nWho currently has the strongest DEMONSTRATED involvement per project (ranked by weight + recency, not formal assignment):\n\n${facts}\n\nWrite a concise Slack status update — one short bullet per project naming who's driving it and briefly what they're doing. Keep it skimmable. Do not invent projects or people not listed.`,
    perProject
      .map((x) => `• *${x.project.label}* — ${x.top[0].person.label}`)
      .join('\n'),
  );
  return { kind: 'overview', text: renderForSlack(text, people), sources };
}

// ---------------------------------------------------------------------------
// Phrasing: turn grounded facts into a Slack answer. Example-driven so the
// small model keeps the right tone and never invents. If no LLM is configured,
// the deterministic `fallback` string is returned (demo insurance policy).
// ---------------------------------------------------------------------------
const PHRASE_SYSTEM = `You are SE3K, a Slack knowledge-graph agent. Answer STRICTLY from the grounded facts in the user message — never invent people, projects, quotes, weights, or timestamps that are not present. Be concise, direct, and Slack-friendly: short sentences, **bold** the key person's name. Do NOT write a "Sources" list; the app appends citations separately.

EXAMPLE — expertise:
Facts: "1. Ivan Sanders — score 14.2 (weight 10). Evidence: shipped the PgBouncer fix | debugged pool exhaustion. 2. Adam Reyes — score 1.1 (weight 1). Evidence: I own checkout but I'm slammed."
Good answer: "**Talk to Ivan Sanders** about the checkout timeouts — he traced the connection-pool root cause and shipped the PgBouncer fix. Adam owns it on paper but handed it off, so he's not your best bet here."

EXAMPLE — provenance:
Facts: "Decision: Adopt PgBouncer connection pooling. Concern raised by Adam Reyes: it's one more service to run. Final call made by Ivan Sanders: pool exhaustion was the real outage cause."
Good answer: "We adopted PgBouncer because connection-pool exhaustion was the real outage cause. **Adam Reyes** pushed back that it's one more service to run and monitor; **Ivan Sanders** made the final call to keep it and add monitoring."`;

async function phrase(prompt: string, fallback: string): Promise<string> {
  if (!llmEnabled) return fallback;
  try {
    const out = await chat({ system: PHRASE_SYSTEM, user: prompt, temperature: 0.3 });
    return out.trim() || fallback;
  } catch (err) {
    dbg('phrase LLM error, using fallback:', err);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Main entry: resolve the question, run the deterministic graph logic, phrase.
// ---------------------------------------------------------------------------
// Public entry: serve from the semantic cache when possible (zero LLM calls),
// otherwise compute the answer and remember it for next time.
export async function answerQuestion(
  store: GraphStore,
  question: string,
): Promise<AnswerResult> {
  const version = store.version();
  const { result, embedding } = await cache.lookup(question, version);
  if (result) return result;
  const ans = await computeAnswer(store, question);
  await cache.store(question, ans, version, embedding);
  return ans;
}

async function computeAnswer(
  store: GraphStore,
  question: string,
): Promise<AnswerResult> {
  dbg(`computeAnswer: "${question}"`);
  const { intent, node } = await resolveQuery(store, question);

  if (intent === 'person') return personAnswer(store, node!, question);
  if (intent === 'overview') return overviewAnswer(store, question);

  // Behavior follows the resolved node's type; intent only matters when nothing
  // resolved.
  const kind: 'expertise' | 'provenance' =
    node?.type === 'Decision' ? 'provenance' : node?.type === 'Project' ? 'expertise' : intent;
  dbg(`resolved kind=${kind} node=${node?.id || '(none)'}`);

  if (kind === 'expertise') {
    const project = node && node.type === 'Project' ? node : undefined;
    if (!project) {
      dbg('no matching project → unknown');
      return {
        kind: 'unknown',
        sources: [],
        text: `I don't have any project in the graph that matches that yet. Known projects: ${
          store.listProjects().map((p) => p.label).join(', ') ||
          '(none — ingest some messages first)'
        }.`,
      };
    }
    const ranked = store.rankExperts(project.id).slice(0, 3);
    dbg(`ranked experts for ${project.id}:`, ranked.map((r) => `${r.person.label}=${r.score.toFixed(1)}`));
    if (ranked.length === 0) {
      return {
        kind: 'unknown',
        sources: [],
        text: `I know about "${project.label}" but have no demonstrated involvement recorded for it yet.`,
      };
    }
    const sources = ranked.flatMap((r) => r.edge.sources.slice(-2));
    const facts = ranked
      .map(
        (r, i) =>
          `${i + 1}. ${r.person.label} — involvement score ${r.score.toFixed(1)} (weight ${
            r.edge.weight
          }, last active ${r.edge.last_active}). Evidence: ${r.edge.sources
            .map((s) => s.excerpt)
            .filter(Boolean)
            .slice(0, 3)
            .join(' | ')}`,
      )
      .join('\n');
    const text = await phrase(
      `Question: "${question}"\n\nThe person with the strongest DEMONSTRATED involvement in "${project.label}" (ranked by accumulated weight + recency, NOT by formal assignment) is:\n\n${facts}\n\nWrite a concise Slack answer (2-4 sentences) naming the top person to talk to and why, then mention the runner-up. Make clear this is based on who actually did the work, not who's assigned. Do not invent anyone not listed.`,
      `**Talk to ${ranked[0].person.label}** about ${project.label}. They have the deepest hands-on involvement (score ${ranked[0].score.toFixed(1)}). ${
        ranked[1] ? `Runner-up: ${ranked[1].person.label}.` : ''
      }`,
    );
    return { kind, text: renderForSlack(text, ranked.map((r) => r.person)), sources };
  }

  // provenance
  const decision = node && node.type === 'Decision' ? node : undefined;
  if (!decision) {
    dbg('no matching decision → unknown');
    return {
      kind: 'unknown',
      sources: [],
      text: `I don't have a decision in the graph matching that. Known decisions: ${
        store.listDecisions().map((d) => d.label).join(' | ') || '(none yet)'
      }.`,
    };
  }
  const prov = store.decisionProvenance(decision.id)!;
  dbg(`provenance for ${decision.id}: ${prov.concerns.length} concern(s), ${prov.calls.length} call(s)`);
  const sources = [...prov.concerns, ...prov.calls].flatMap((x) => x.edge.sources);
  const facts = [
    `Decision: ${prov.decision.label}`,
    ...prov.concerns.map(
      (c) =>
        `Concern raised by ${c.person.label}: ${c.edge.sources.map((s) => s.excerpt).filter(Boolean).join(' | ')}`,
    ),
    ...prov.calls.map(
      (c) =>
        `Final call made by ${c.person.label}: ${c.edge.sources.map((s) => s.excerpt).filter(Boolean).join(' | ')}`,
    ),
  ].join('\n');
  const text = await phrase(
    `Question: "${question}"\n\nHere is the recorded provenance of this decision (the reasoning and dissent behind it, not just the outcome):\n\n${facts}\n\nWrite a concise Slack answer (3-5 sentences) explaining WHY this was decided: surface who pushed back and on what grounds, and who made the final call. Do not invent details beyond what's listed.`,
    `**${prov.decision.label}**\n${facts}`,
  );
  const people = [...prov.concerns, ...prov.calls].map((x) => x.person);
  return { kind, text: renderForSlack(text, people), sources };
}

// Append the citation list the UI shows under an answer (deduped, capped at 5).
export function formatSourcesForSlack(sources: Source[]): string {
  const unique = sources.filter(
    (s, i, arr) => arr.findIndex((o) => o.excerpt === s.excerpt && o.ts === s.ts) === i,
  );
  if (unique.length === 0) return '';
  return '\n\n*Sources:*\n' + unique.slice(0, 5).map((s) => `• ${fmtSource(s)}`).join('\n');
}
