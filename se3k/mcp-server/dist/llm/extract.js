"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chunkMessages = chunkMessages;
exports.extractGraph = extractGraph;
const client_1 = require("./client");
// NOTE ON LOGGING: this process is an MCP server whose STDOUT is the JSON-RPC
// transport. All debug output MUST go to stderr (console.error) or it corrupts
// the protocol. `dbg` centralizes that.
const dbg = (...args) => console.error('[se3k:extract]', ...args);
// ============================================================================
// THE EXTRACTION PROMPT — the heart of the project.
// Longer + example-driven on purpose: the default model is small (llama-3.1-8b),
// and a concrete worked example makes weighting and the "assignee ≠ expert" rule
// far more reliable than abstract instructions alone. Keep the prompt AND its
// JSON schema together here so they iterate as one unit (AGENTS.md).
// ============================================================================
const EXTRACTION_SYSTEM = `You are SE3K's extraction engine. You read raw Slack conversation logs from a tech company and turn them into a knowledge graph that answers ONE question better than Jira ever could: "who ACTUALLY knows about X" — judged by demonstrated hands-on work, NOT by who is formally assigned.

OUTPUT: STRICT JSON only (no prose, no markdown fences) matching this schema:

{
  "people":       [{ "slackUserId": "U123 (omit if unknown)", "name": "Display Name" }],
  "projects":     [{ "key": "kebab-slug", "name": "Human Readable Name" }],
  "decisions":    [{ "key": "kebab-slug", "summary": "what was decided, one sentence" }],
  "involvement":  [{ "person": "name or slackUserId", "project": "project key", "weight": 1-5, "ts": "ISO-8601", "evidence": "short quote of what they actually did", "ref": "the [mN] tag of the source message" }],
  "decisionEdges":[{ "person": "name", "decision": "decision key", "type": "RAISED_CONCERN" | "MADE_CALL", "ts": "ISO-8601", "evidence": "short quote", "ref": "the [mN] tag of the source message" }],
  "relations":    [{ "decision": "decision key", "project": "project key" }]
}

WEIGHTING RULES (this is what makes ranking meaningful — be deliberate):
- weight 4-5: posted the actual fix/solution, debugged the ROOT cause, reviewed/merged the change, or repeatedly answered others' questions on the topic.
- weight 2-3: substantive back-and-forth, proposed an approach, reproduced the bug, meaningful review comments.
- weight 1: a passing mention, asking a question, "+1", relaying a report, being @-mentioned without contributing, OR clearly claiming/owning/planning to pick up a piece of work that isn't started yet.
- A person who is formally "assigned"/"owns" something but does NOT actually do the work in these messages gets weight 1 (never more). Demonstrated work beats assignment — this distinction is the whole point of SE3K.
- CAPTURE STATED PLANS: if someone clearly says they are taking on / picking up / going to own a piece of work (e.g. "I'll pick up the delivery-logistics connections next"), CREATE that project and give that person a weight-1 involvement — even if this is the only mention of it and no work has happened yet. Later real work will outweigh the claim. (Still ignore pure banter like "why?", "sounds good", "makes sense".)

OTHER RULES:
- IGNORE normal conversation that carries no expertise signal — greetings, scheduling, lunch, kudos, emoji/reactions, banter, status pings, off-topic chatter. Do NOT emit a person just because they spoke. Only emit people/projects/decisions/involvement that are tied to real technical work or a real decision. If a batch has nothing substantive, return every array empty.
- Prefer Slack user IDs as identity when present; otherwise the display name. Reuse the SAME kebab key across the batch for the same project/decision.
- Only create a project/decision if it is genuinely discussed.
- A DECISION is a real technical or product choice with a tradeoff or dissent (e.g. "adopt PgBouncer over one-connection-per-request", "ship optimistic cart updates"). Do NOT record jokes (e.g. "light vs dark toast"), UI nitpicks, routine tweaks (e.g. debouncing a click), or banter as decisions.
- For each real decision, capture the debate: emit a RAISED_CONCERN edge for anyone who pushed back (and why), and a MADE_CALL edge for whoever said the final call / "let's ship it". If the text contains a concern or a final call, you MUST emit those edges with the right person + ref.
- Every input line is prefixed with a "[mN]" tag. In every involvement and decisionEdge, set "ref" to the [mN] tag of the SINGLE message that best evidences it (so the citation links to the exact Slack message).
- "ts": use the message's real timestamp if given; otherwise infer chronological order with plausible recent ISO timestamps.

WORKED EXAMPLE
Input:
[m1] Sam Okafor: Wave of tickets — customers say checkout times out at peak hours.
[m2] Adam Reyes: I own the checkout service, but I'm slammed this week — can someone dig in?
[m3] Ivan Sanders: Root cause: we exhaust the Postgres connection pool under load. Shipped PgBouncer, checkout p95 9s → 700ms.
[m4] Adam Reyes: Concern: PgBouncer is one more thing to run and monitor.
[m5] Ivan Sanders: Final call: keep PgBouncer — pool exhaustion was the real outage cause; I'll add monitoring.

Correct output:
{
  "people": [{ "name": "Sam Okafor" }, { "name": "Adam Reyes" }, { "name": "Ivan Sanders" }],
  "projects": [{ "key": "checkout-api", "name": "Checkout API" }],
  "decisions": [{ "key": "adopt-pgbouncer", "summary": "Adopt PgBouncer connection pooling for the checkout service" }],
  "involvement": [
    { "person": "Ivan Sanders", "project": "checkout-api", "weight": 5, "ts": "2026-07-01T10:03:00Z", "evidence": "Root cause: connection pool exhausted; shipped PgBouncer, p95 9s → 700ms", "ref": "m3" },
    { "person": "Adam Reyes", "project": "checkout-api", "weight": 1, "ts": "2026-07-01T10:01:00Z", "evidence": "I own the checkout service but I'm slammed", "ref": "m2" },
    { "person": "Sam Okafor", "project": "checkout-api", "weight": 1, "ts": "2026-07-01T10:00:00Z", "evidence": "Customers say checkout times out at peak hours", "ref": "m1" }
  ],
  "decisionEdges": [
    { "person": "Adam Reyes", "decision": "adopt-pgbouncer", "type": "RAISED_CONCERN", "ts": "2026-07-01T10:04:00Z", "evidence": "PgBouncer is one more thing to run and monitor", "ref": "m4" },
    { "person": "Ivan Sanders", "decision": "adopt-pgbouncer", "type": "MADE_CALL", "ts": "2026-07-01T10:05:00Z", "evidence": "Final call: keep PgBouncer, pool exhaustion was the real cause", "ref": "m5" }
  ],
  "relations": [{ "decision": "adopt-pgbouncer", "project": "checkout-api" }]
}

Note how Adam OWNS checkout but gets weight 1 (he did not do the work), while Ivan gets 5. That ranking is the product. Output ONLY the JSON object.`;
const EMPTY = {
    people: [],
    projects: [],
    decisions: [],
    involvement: [],
    decisionEdges: [],
    relations: [],
};
// Chunking bounds: pack whole lines until either trips (~1.5k tokens/chunk).
const MAX_LINES = Number(process.env.EXTRACT_MAX_LINES) || 20;
const MAX_CHARS = Number(process.env.EXTRACT_MAX_CHARS) || 6000;
// Split a message blob into bounded chunks so a big thread never becomes one
// enormous prompt. Keeps a 1-line overlap so context isn't lost at a boundary.
function chunkMessages(text, maxLines = MAX_LINES, maxChars = MAX_CHARS) {
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    const chunks = [];
    let buf = [];
    let chars = 0;
    for (const line of lines) {
        if (buf.length > 0 && (buf.length >= maxLines || chars + line.length > maxChars)) {
            chunks.push(buf.join('\n'));
            const overlap = buf.slice(-1);
            buf = [...overlap];
            chars = overlap.join('\n').length;
        }
        buf.push(line);
        chars += line.length + 1;
    }
    if (buf.length > 0)
        chunks.push(buf.join('\n'));
    return chunks;
}
// Some models wrap JSON in ```json fences despite instructions — strip them.
function stripFences(s) {
    return s
        .trim()
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/i, '')
        .trim();
}
// Extract entities/edges from ONE bounded chunk (a single LLM call). `known`
// carries the keys from earlier chunks so extraction stays consistent across a
// split thread (otherwise a 30-message convo fragments into "Checkout API" +
// "Checkout Service" etc.).
async function extractChunk(chunkText, known) {
    dbg(`extractChunk: ${chunkText.split('\n').length} lines, ${chunkText.length} chars`);
    const hint = known && (known.projects.size || known.decisions.size)
        ? `Entities already extracted earlier in THIS conversation — reuse these exact keys when relevant, do NOT invent near-duplicate keys for the same thing:\n` +
            `projects: ${[...known.projects].map(([k, n]) => `${k} (${n})`).join(', ') || '(none)'}\n` +
            `decisions: ${[...known.decisions.keys()].join(', ') || '(none)'}\n\n`
        : '';
    const raw = await (0, client_1.chat)({
        system: EXTRACTION_SYSTEM,
        user: `${hint}Slack messages to extract from:\n\n${chunkText}`,
        json: true,
        temperature: 0.1,
    });
    try {
        const parsed = JSON.parse(stripFences(raw));
        const merged = { ...EMPTY, ...parsed };
        dbg(`extractChunk → people=${merged.people.length} projects=${merged.projects.length} ` +
            `decisions=${merged.decisions.length} involvement=${merged.involvement.length} ` +
            `decisionEdges=${merged.decisionEdges.length}`);
        return merged;
    }
    catch (err) {
        dbg('extractChunk: failed to parse LLM JSON:', err, '\nraw:', raw);
        return EMPTY;
    }
}
// Append one chunk's result onto the accumulator (arrays concatenate; the graph
// store dedupes + accumulates weights downstream, so this is lossless).
function mergeInto(acc, r) {
    acc.people.push(...(r.people || []));
    acc.projects.push(...(r.projects || []));
    acc.decisions.push(...(r.decisions || []));
    acc.involvement.push(...(r.involvement || []));
    acc.decisionEdges.push(...(r.decisionEdges || []));
    acc.relations.push(...(r.relations || []));
}
// Public API (unchanged signature): any-sized blob in → one merged result out.
// Chunks + extracts sequentially (rate-limit friendly), then merges.
async function extractGraph(messagesText) {
    const chunks = chunkMessages(messagesText);
    dbg(`extractGraph: ${messagesText.split('\n').length} lines → ${chunks.length} chunk(s)`);
    if (chunks.length <= 1)
        return extractChunk(messagesText);
    const acc = {
        people: [],
        projects: [],
        decisions: [],
        involvement: [],
        decisionEdges: [],
        relations: [],
    };
    const known = { projects: new Map(), decisions: new Map() };
    for (let i = 0; i < chunks.length; i++) {
        dbg(`extractGraph: chunk ${i + 1}/${chunks.length}`);
        try {
            const res = await extractChunk(chunks[i], known);
            mergeInto(acc, res);
            for (const p of res.projects || [])
                if (p.key)
                    known.projects.set(p.key, p.name || p.key);
            for (const d of res.decisions || [])
                if (d.key)
                    known.decisions.set(d.key, d.summary || d.key);
        }
        catch (err) {
            dbg(`extractGraph: chunk ${i + 1}/${chunks.length} failed:`, err);
        }
    }
    dbg(`extractGraph done → people=${acc.people.length} projects=${acc.projects.length} ` +
        `decisions=${acc.decisions.length} involvement=${acc.involvement.length}`);
    return acc;
}
