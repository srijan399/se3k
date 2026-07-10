import { GraphStore } from '../graph/store';
import { GraphNode, Source } from '../graph/types';
import { chat, llmEnabled } from './client';
import * as cache from '../cache/semanticCache';

const dbg = (...args: unknown[]) => console.error('[se3k:answer]', ...args);

export type Intent =
  | 'expertise'
  | 'provenance'
  | 'overview'
  | 'person'
  | 'general';

export interface AnswerResult {
  text: string; // natural-language answer for Slack
  sources: Source[]; // citations backing the answer
  kind: Intent | 'unknown';
}

function classify(question: string): Intent {
  const q = question.toLowerCase();
  if (
    /\b(status|overview|going on|catch me up|standup|stand-up)\b|who('?s| is)?\s+doing\s+what|who owns what|what('?s| is)?\s+(everyone|everybody|the team|we|people)\s+(doing|working on|up to)|update (of|on) who/.test(
      q,
    )
  ) {
    return 'overview';
  }
  if (
    /\bwhy\b|decid|decision|reason|chose|stop using|dropped|pushed back|concern|rationale/.test(
      q,
    )
  ) {
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

function fmtSource(s: Source): string {
  const where = s.channel || 'Slack';
  const clean = (s.excerpt || '')
    .replace(/[<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const quote = clean ? ` — "${clean.slice(0, 80)}"` : '';
  const label = `${where}${quote}`;
  if (s.permalink) return `<${s.permalink}|${label}>`;
  return `${where}${s.ts ? ` @ ${s.ts}` : ''}${quote}`;
}

const HELP_TEXT = [
  "Hi! I'm SE3K. I track who *actually* knows things here from real Slack activity, not who's formally assigned. Try:",
  '• *who do I talk to about <topic>?* — the person with the deepest hands-on involvement, with receipts',
  '• *why did we decide <X>?* — the reasoning and dissent behind a call',
  '• *what is @someone working on?* — one person’s real work',
  "• *who's doing what?* — a quick team status snapshot",
].join('\n');

function isSmallTalk(question: string): boolean {
  const q = question
    .trim()
    .toLowerCase()
    .replace(/[!.?,]+$/g, '');
  if (!q) return true;
  if (
    /^(hi|hey+|hello|yo|sup|hiya|heya|howdy|hallo|hola|gm|good (morning|afternoon|evening)|greetings)\b/.test(
      q,
    )
  )
    return true;
  if (
    /^(thanks|thank you|thx|ty|cheers|nice|cool|great|awesome|ok(ay)?|got it)\b/.test(
      q,
    )
  )
    return true;
  if (
    /^(who are you|what are you|what can you do|what do you do|how do you work|help)\b/.test(
      q,
    )
  )
    return true;
  return false;
}

const CLASSIFY_SYSTEM = `You are the router for SE3K, a Slack assistant that, from a team's real chat history, answers: who ACTUALLY knows about a topic (by demonstrated work), why a decision was made (and who dissented), what one person is working on, and overall team status.

Classify the user's message into EXACTLY ONE intent and, when it's about a single catalog item, return that item's id.

Return STRICT JSON ONLY: { "intent": "<intent>", "targetId": "<an id from the catalog, or empty string>" }

intent is one of:
- "expertise"  — who knows / who to ask / who's best for a SPECIFIC topic. targetId = a PROJECT id.
- "provenance" — why did we decide / the reasoning / who pushed back on a SPECIFIC decision. targetId = a DECISION id.
- "person"     — what is <someone> doing / working on / responsible for / their status / their recent work. targetId = that PERSON's id.
- "overview"   — broad team status with NO single subject: "who's doing what", "give me an update", "what's everyone working on".
- "general"    — greetings, thanks, small talk, or meta questions about you ("who are you", "what can you do", "help"), or anything a team knowledge graph cannot answer. targetId "".

Judge by MEANING, not keywords — phrasing is open-ended. Choose the SINGLE best-matching id; if none fits, targetId "".

EXAMPLES (catalog omitted here for brevity):
Q: "who should I ask about checkout timing out?"   -> {"intent":"expertise","targetId":"project:checkout-api"}
Q: "any idea why we ditched redis for rate limits?"-> {"intent":"provenance","targetId":"decision:drop-redis-limiter"}
Q: "what's Ivan been heads-down on lately?"        -> {"intent":"person","targetId":"person:U123"}
Q: "give me the lay of the land, who's on what?"   -> {"intent":"overview","targetId":""}
Q: "yo"                                            -> {"intent":"general","targetId":""}
Q: "appreciate it, super helpful 🙏"               -> {"intent":"general","targetId":""}
Q: "who owns the mobile app?"                      -> {"intent":"expertise","targetId":""}

Output ONLY the JSON object.`;

const PERSON_HINT =
  /(working on|work on|worked on|\bworking\b|\bdoing\b|up to|focus|\binvolved\b|responsible|\btasks?\b|contributing|been on|\bupdate\b|\bstatus\b|what (is|are|has|'?s) )/i;

function normalizeIntent(s?: string): Intent {
  return s === 'provenance' ||
    s === 'overview' ||
    s === 'person' ||
    s === 'general'
    ? s
    : 'expertise';
}

async function route(
  store: GraphStore,
  question: string,
): Promise<{ intent: Intent; node?: GraphNode }> {
  if (llmEnabled) {
    try {
      const catalog = {
        projects: store
          .listProjects()
          .map((p) => ({ id: p.id, label: p.label })),
        decisions: store
          .listDecisions()
          .map((d) => ({ id: d.id, label: d.label })),
        people: store.listPeople().map((p) => ({ id: p.id, label: p.label })),
      };
      const raw = await chat({
        system: CLASSIFY_SYSTEM,
        user: `Message: "${question}"\n\nCatalog (choose targetId from these ids):\n${JSON.stringify(catalog)}`,
        json: true,
        temperature: 0,
      });
      const parsed = JSON.parse(stripFences(raw)) as {
        intent?: string;
        targetId?: string;
      };
      const intent = normalizeIntent(parsed.intent);
      dbg(
        `🧭 classify → ${intent}${parsed.targetId ? ` · ${parsed.targetId}` : ''}`,
      );
      if (intent === 'general' || intent === 'overview') return { intent };
      const byId = parsed.targetId ? store.getNode(parsed.targetId) : undefined;
      if (intent === 'person')
        return { intent, node: byId ?? store.findPersonByText(question) };
      return {
        intent,
        node:
          byId ??
          (intent === 'provenance'
            ? store.findDecisionByText(question)
            : store.findProjectByText(question)),
      };
    } catch (err) {
      dbg('classify LLM error, using keyword fallback:', err);
    }
  }

  if (isSmallTalk(question)) return { intent: 'general' };
  const person = store.findPersonByText(question);
  if (person && PERSON_HINT.test(question))
    return { intent: 'person', node: person };
  const intent = classify(question);
  if (intent === 'overview') return { intent };
  return {
    intent,
    node:
      intent === 'provenance'
        ? store.findDecisionByText(question)
        : store.findProjectByText(question),
  };
}

// Casual conversation → a natural, on-brand reply (assistant mode): no graph
// lookup, never invents team facts. Falls back to the canned help text.
const ASSISTANT_SYSTEM = `You are SE3K, a friendly Slack assistant. From a team's real Slack activity you can answer: who ACTUALLY knows about a topic (ranked by demonstrated work, with sources), why a past decision was made (with the dissent), what one person is working on, and overall team status. The user's message is casual conversation, not one of those queries. Reply briefly, warmly, and Slack-friendly, and when it fits, nudge them toward what you can look up. NEVER invent facts about the team, its people, projects, or decisions — you have no data for this reply.`;

async function assistantReply(question: string): Promise<AnswerResult> {
  if (!llmEnabled) return { kind: 'general', sources: [], text: HELP_TEXT };
  try {
    const text = await chat({
      system: ASSISTANT_SYSTEM,
      user: question,
      temperature: 0.6,
    });
    return { kind: 'general', sources: [], text: text.trim() || HELP_TEXT };
  } catch (err) {
    dbg('assistant reply error, using help text:', err);
    return { kind: 'general', sources: [], text: HELP_TEXT };
  }
}

// Asked about a specific @person we have no tracked work for.
function unknownPersonReply(question: string): AnswerResult {
  const m = question.match(/<@[UW][A-Z0-9]+(?:\|([^>]+))?>/i);
  const who = m?.[1] ? `@${m[1]}` : 'that person';
  return {
    kind: 'unknown',
    sources: [],
    text: `I don't have any tracked work for ${who} yet — they may not have been active in a channel I've ingested.`,
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
async function overviewAnswer(
  store: GraphStore,
  question: string,
): Promise<AnswerResult> {
  const perProject = store
    .listProjects()
    .map((project) => ({
      project,
      top: store.rankExperts(project.id).slice(0, 2),
    }))
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
  const sources = perProject.flatMap((x) =>
    x.top.flatMap((t) => t.edge.sources.slice(-1)),
  );

  const text = perProject
    .map((x) => {
      const lead = x.top[0];
      const ev = lead.edge.sources
        .map((s) => s.excerpt)
        .filter(Boolean)
        .slice(-1)
        .join('')
        .replace(/[\s.]+$/, '')
        .trim();
      const others = x.top.slice(1).map((t) => t.person.label);
      const evClause = ev ? `: ${ev}` : '';
      const alsoClause = others.length
        ? ` Also involved: ${others.join(', ')}.`
        : '';
      return `• *${x.project.label}* — **${lead.person.label}** is driving it${evClause}.${alsoClause}`;
    })
    .join('\n');

  return { kind: 'overview', text: renderForSlack(text, people), sources };
}

const PHRASE_SYSTEM = `You are SE3K, a Slack knowledge-graph agent. Answer STRICTLY from the grounded facts in the user message — never invent people, projects, quotes, weights, or timestamps that are not present. The facts you are given ARE what we know: NEVER reply that you "don't have information", "don't know", or "can't help" when facts are present — summarize them instead. If the question is phrased as "what do you know about X", "tell me about X", or "what's the status of X", answer with who has worked on it and what they built or decided. Be concise, direct, and Slack-friendly: short sentences, **bold** the key person's name. Do NOT write a "Sources" list; the app appends citations separately.

EXAMPLE — expertise:
Facts: "1. Ivan Sanders — score 14.2 (weight 10). Evidence: shipped the PgBouncer fix | debugged pool exhaustion. 2. Adam Reyes — score 1.1 (weight 1). Evidence: I own checkout but I'm slammed."
Good answer: "**Talk to Ivan Sanders** about the checkout timeouts — he traced the connection-pool root cause and shipped the PgBouncer fix. Adam owns it on paper but handed it off, so he's not your best bet here."

EXAMPLE — "what do you know about X":
Facts: "1. Ivan Sanders — score 9.0. Evidence: added a Redis cache with write-through invalidation | added a cache-hit-rate dashboard. 2. Rahul Sharma — score 2.0. Evidence: optimistic results render."
Good answer: "Here's what we know about the cache: **Ivan Sanders** built it — a Redis cache in front of the ranking with write-through invalidation, plus a hit-rate dashboard. Rahul Sharma added the optimistic results render on top."

EXAMPLE — provenance:
Facts: "Decision: Adopt PgBouncer connection pooling. Concern raised by Adam Reyes: it's one more service to run. Final call made by Ivan Sanders: pool exhaustion was the real outage cause."
Good answer: "We adopted PgBouncer because connection-pool exhaustion was the real outage cause. **Adam Reyes** pushed back that it's one more service to run and monitor; **Ivan Sanders** made the final call to keep it and add monitoring."`;

async function phrase(prompt: string, fallback: string): Promise<string> {
  if (!llmEnabled) return fallback;
  try {
    const out = await chat({
      system: PHRASE_SYSTEM,
      user: prompt,
      temperature: 0.3,
    });
    return out.trim() || fallback;
  } catch (err) {
    dbg('phrase LLM error, using fallback:', err);
    return fallback;
  }
}

export async function answerQuestion(
  store: GraphStore,
  question: string,
): Promise<AnswerResult> {
  const version = store.version();
  const { result, embedding } = await cache.lookup(question, version);
  if (result) return result;
  const ans = await computeAnswer(store, question);
  // Don't cache casual/assistant replies — they're cheap to regenerate and we
  // don't want a "hi" reply served back for a "thanks".
  if (ans.kind !== 'general')
    await cache.store(question, ans, version, embedding);
  return ans;
}

async function computeAnswer(
  store: GraphStore,
  question: string,
): Promise<AnswerResult> {
  dbg(`🔮 answering · "${question}"`);
  const { intent, node } = await route(store, question);

  if (intent === 'general') return assistantReply(question);

  if (intent === 'person')
    return node
      ? personAnswer(store, node, question)
      : unknownPersonReply(question);

  // A query that @mentions a specific user but resolved no topic is really a
  // person query the classifier under-labeled — handle it as one.
  if (!node && /<@[UW][A-Z0-9]+/i.test(question)) {
    const p = store.findPersonByText(question);
    return p ? personAnswer(store, p, question) : unknownPersonReply(question);
  }

  if (intent === 'overview') return overviewAnswer(store, question);

  const kind: 'expertise' | 'provenance' =
    node?.type === 'Decision'
      ? 'provenance'
      : node?.type === 'Project'
        ? 'expertise'
        : intent;
  dbg(`🧭 kind=${kind} · node=${node?.id || '—'}`);

  if (kind === 'expertise') {
    const project = node && node.type === 'Project' ? node : undefined;
    if (!project) {
      dbg('no matching project → unknown');
      return {
        kind: 'unknown',
        sources: [],
        text: `I don't have any project in the graph that matches that yet. Known projects: ${
          store
            .listProjects()
            .map((p) => p.label)
            .join(', ') || '(none — ingest some messages first)'
        }.`,
      };
    }
    const ranked = store.rankExperts(project.id).slice(0, 3);
    dbg(
      `🏆 ranked ${project.label}:`,
      ranked.map((r) => `${r.person.label} ${r.score.toFixed(1)}`).join(' · '),
    );
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
    return {
      kind,
      text: renderForSlack(
        text,
        ranked.map((r) => r.person),
      ),
      sources,
    };
  }

  // provenance
  const decision = node && node.type === 'Decision' ? node : undefined;
  if (!decision) {
    dbg('no matching decision → unknown');
    return {
      kind: 'unknown',
      sources: [],
      text: `I don't have a decision in the graph matching that. Known decisions: ${
        store
          .listDecisions()
          .map((d) => d.label)
          .join(' | ') || '(none yet)'
      }.`,
    };
  }
  const prov = store.decisionProvenance(decision.id)!;
  dbg(
    `⚖️  provenance · ${prov.concerns.length} concern(s) · ${prov.calls.length} call(s)`,
  );
  const sources = [...prov.concerns, ...prov.calls].flatMap(
    (x) => x.edge.sources,
  );
  const facts = [
    `Decision: ${prov.decision.label}`,
    ...prov.concerns.map(
      (c) =>
        `Concern raised by ${c.person.label}: ${c.edge.sources
          .map((s) => s.excerpt)
          .filter(Boolean)
          .join(' | ')}`,
    ),
    ...prov.calls.map(
      (c) =>
        `Final call made by ${c.person.label}: ${c.edge.sources
          .map((s) => s.excerpt)
          .filter(Boolean)
          .join(' | ')}`,
    ),
  ].join('\n');
  const text = await phrase(
    `Question: "${question}"\n\nHere is the recorded provenance of this decision (the reasoning and dissent behind it, not just the outcome):\n\n${facts}\n\nWrite a concise Slack answer (3-5 sentences) explaining WHY this was decided: surface who pushed back and on what grounds, and who made the final call. Do not invent details beyond what's listed.`,
    `**${prov.decision.label}**\n${facts}`,
  );
  const people = [...prov.concerns, ...prov.calls].map((x) => x.person);
  return { kind, text: renderForSlack(text, people), sources };
}

export function sourceLines(sources: Source[]): string[] {
  const unique = sources.filter(
    (s, i, arr) =>
      arr.findIndex((o) => o.excerpt === s.excerpt && o.ts === s.ts) === i,
  );
  return unique.slice(0, 5).map((s) => fmtSource(s));
}

export function formatSourcesForSlack(sources: Source[]): string {
  const lines = sourceLines(sources);
  if (lines.length === 0) return '';
  return '\n\n*Sources:*\n' + lines.join('\n');
}
