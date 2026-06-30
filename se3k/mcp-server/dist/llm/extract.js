"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractGraph = extractGraph;
const client_1 = require("./client");
// ============================================================================
// THE EXTRACTION PROMPT — the heart of the project.
// Keep the prompt AND its expected JSON schema together here so they can be
// iterated as one unit (AGENTS.md requirement). Do not scatter this.
// ============================================================================
const EXTRACTION_SYSTEM = `You convert raw Slack conversation logs into a knowledge graph that answers ONE question better than Jira ever could: "who ACTUALLY knows about X" — based on demonstrated hands-on involvement, not formal assignment.

You output STRICT JSON (no prose, no markdown) matching this schema:

{
  "people":      [{ "slackUserId": "U123 or omit", "name": "Display Name" }],
  "projects":    [{ "key": "kebab-slug", "name": "Human Name" }],
  "decisions":   [{ "key": "kebab-slug", "summary": "what was decided, one sentence" }],
  "involvement": [{ "person": "name or slackUserId", "project": "project key or name", "weight": 1-5, "ts": "ISO-8601", "evidence": "short quote of what they actually did" }],
  "decisionEdges":[{ "person": "name", "decision": "decision key", "type": "RAISED_CONCERN" | "MADE_CALL", "ts": "ISO-8601", "evidence": "short quote" }],
  "relations":   [{ "decision": "decision key", "project": "project key" }]
}

WEIGHTING RULES (this is what makes ranking meaningful — be deliberate):
- Higher weight (4-5): posting an actual fix/solution, debugging the root cause, reviewing/merging the change, repeatedly answering others' questions on the topic.
- Medium weight (2-3): substantive back-and-forth, proposing an approach, reproducing the bug.
- Low weight (1): a passing mention, asking a question, "+1", being @-mentioned without contributing.
- A person formally "assigned" who does NOT actually contribute in the messages gets LOW or NO involvement. Demonstrated work beats assignment. This distinction is the entire point.

OTHER RULES:
- Use Slack user IDs as the person identity when present; otherwise the display name.
- Create a project/decision only if it's genuinely discussed. Reuse the same kebab key across the batch for the same thing.
- For decisions, capture dissent: who pushed back (RAISED_CONCERN) and who made the final call (MADE_CALL).
- "ts" must be a real ISO timestamp from the message metadata when available; otherwise infer order and use plausible recent timestamps.
- Output ONLY the JSON object.`;
const EMPTY = {
    people: [],
    projects: [],
    decisions: [],
    involvement: [],
    decisionEdges: [],
    relations: [],
};
async function extractGraph(messagesText) {
    const raw = await (0, client_1.chat)({
        system: EXTRACTION_SYSTEM,
        user: `Slack messages to extract from:\n\n${messagesText}`,
        json: true,
        temperature: 0.1,
        maxTokens: 2048,
    });
    try {
        const parsed = JSON.parse(stripFences(raw));
        return { ...EMPTY, ...parsed };
    }
    catch (err) {
        console.error('extractGraph: failed to parse LLM JSON:', err, '\nraw:', raw);
        return EMPTY;
    }
}
// Some models wrap JSON in ```json fences despite instructions.
function stripFences(s) {
    return s
        .trim()
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/i, '')
        .trim();
}
