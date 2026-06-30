import { GraphStore } from '../graph/store';
import { Source } from '../graph/types';
import { chat, llmEnabled } from './client';

// Answering layer. We deliberately do NOT let the LLM free-associate over the
// graph: we resolve the relevant subgraph deterministically in code, then ask
// the LLM only to phrase what we already grounded. This keeps answers honest
// and always sourced.

export interface AnswerResult {
  text: string; // natural-language answer for Slack
  sources: Source[]; // citations backing the answer
  kind: 'expertise' | 'provenance' | 'unknown';
}

function classify(question: string): 'expertise' | 'provenance' {
  const q = question.toLowerCase();
  if (/\bwhy\b|decid|decision|reason|chose|chose|stop using|dropped|pushed back|concern/.test(q)) {
    return 'provenance';
  }
  return 'expertise';
}

function fmtSource(s: Source): string {
  const where = s.channel ? `${s.channel}` : 'Slack';
  const quote = s.excerpt ? ` — "${s.excerpt}"` : '';
  return `${where}${s.ts ? ` @ ${s.ts}` : ''}${quote}`;
}

export async function answerQuestion(
  store: GraphStore,
  question: string,
): Promise<AnswerResult> {
  const kind = classify(question);

  if (kind === 'expertise') {
    const project = store.findProjectByText(question);
    if (!project) {
      return {
        kind: 'unknown',
        sources: [],
        text: `I don't have any project in the graph that matches that yet. Known projects: ${store
          .listProjects()
          .map((p) => p.label)
          .join(', ') || '(none — ingest some messages first)'}.`,
      };
    }
    const ranked = store.rankExperts(project.id).slice(0, 3);
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
          `${i + 1}. ${r.person.label} — involvement score ${r.score.toFixed(
            1,
          )} (weight ${r.edge.weight}, last active ${r.edge.last_active}). Evidence: ${r.edge.sources
            .map((s) => s.excerpt)
            .filter(Boolean)
            .slice(0, 3)
            .join(' | ')}`,
      )
      .join('\n');

    const text = await phrase(
      `Question: "${question}"\n\nThe person with the strongest DEMONSTRATED involvement in "${project.label}" (ranked by accumulated weight + recency, NOT by formal assignment) is:\n\n${facts}\n\nWrite a concise Slack answer (2-4 sentences) naming the top person to talk to and briefly why, then mention the runner-up. Make clear this is based on who actually did the work in the threads, not who's assigned. Do not invent anyone not listed.`,
      `**Talk to ${ranked[0].person.label}** about ${project.label}. They have the deepest hands-on involvement (score ${ranked[0].score.toFixed(
        1,
      )}). ${ranked[1] ? `Runner-up: ${ranked[1].person.label}.` : ''}`,
    );
    return { kind, text, sources };
  }

  // provenance
  const decision = store.findDecisionByText(question);
  if (!decision) {
    return {
      kind: 'unknown',
      sources: [],
      text: `I don't have a decision in the graph matching that. Known decisions: ${store
        .listDecisions()
        .map((d) => d.label)
        .join(' | ') || '(none yet)'}.`,
    };
  }
  const prov = store.decisionProvenance(decision.id)!;
  const sources = [...prov.concerns, ...prov.calls].flatMap((x) => x.edge.sources);
  const facts = [
    `Decision: ${prov.decision.label}`,
    ...prov.concerns.map(
      (c) => `Concern raised by ${c.person.label}: ${c.edge.sources.map((s) => s.excerpt).filter(Boolean).join(' | ')}`,
    ),
    ...prov.calls.map(
      (c) => `Final call made by ${c.person.label}: ${c.edge.sources.map((s) => s.excerpt).filter(Boolean).join(' | ')}`,
    ),
  ].join('\n');

  const text = await phrase(
    `Question: "${question}"\n\nHere is the recorded provenance of this decision (the reasoning and dissent behind it, not just the outcome):\n\n${facts}\n\nWrite a concise Slack answer (3-5 sentences) explaining WHY this was decided: surface who pushed back and on what grounds, and who made the final call. Do not invent details beyond what's listed.`,
    `**${prov.decision.label}**\n${facts}`,
  );
  return { kind, text, sources };
}

// Ask the LLM to phrase grounded facts; if no LLM is configured, fall back to a
// deterministic template so the demo still answers (plan's insurance policy).
async function phrase(prompt: string, fallback: string): Promise<string> {
  if (!llmEnabled) return fallback;
  try {
    const out = await chat({
      system:
        'You are SE3K, a Slack agent that answers strictly from the grounded facts provided. Never invent people, projects, or quotes not present in the input. Be concise and direct.',
      user: prompt,
      temperature: 0.3,
    });
    return out.trim() || fallback;
  } catch (err) {
    console.error('answer.phrase LLM error, using fallback:', err);
    return fallback;
  }
}

export function formatSourcesForSlack(sources: Source[]): string {
  const unique = sources.filter(
    (s, i, arr) => arr.findIndex((o) => o.excerpt === s.excerpt && o.ts === s.ts) === i,
  );
  if (unique.length === 0) return '';
  return '\n\n*Sources:*\n' + unique.slice(0, 5).map((s) => `• ${fmtSource(s)}`).join('\n');
}
