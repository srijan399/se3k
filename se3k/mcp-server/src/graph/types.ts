// SE3K graph schema — the entire ontology lives here.
// Scope is deliberately frozen at 3 primary node types + the edge types that
// power the two core behaviors (expertise routing + decision provenance).
// Do not expand this without flagging a scope change (see AGENTS.md).

export type NodeType = 'Person' | 'Project' | 'Decision' | 'Channel';

export type EdgeType =
  | 'INVOLVED_IN' // Person -> Project (weighted, timestamped) — powers expertise routing
  | 'RAISED_CONCERN' // Person -> Decision — powers decision provenance
  | 'MADE_CALL' // Person -> Decision — who made the final call
  | 'RELATES_TO' // Decision -> Project
  | 'POSTED_IN'; // Person -> Channel (light context, optional)

export interface GraphNode {
  id: string; // stable id, e.g. "person:U123", "project:rate-limiting"
  type: NodeType;
  label: string; // human-readable display name
  slackUserId?: string; // for Person nodes — entity resolution key
  meta?: Record<string, unknown>;
}

// A citation back to the Slack source that produced a fact. Every edge keeps
// these so answers can always say "here's where I learned this".
export interface Source {
  channel?: string; // human-readable channel name, e.g. "#backend"
  channelId?: string;
  ts?: string; // Slack message timestamp
  permalink?: string;
  excerpt?: string; // short quote for the demo
}

export interface GraphEdge {
  id: string; // `${type}:${from}->${to}`
  type: EdgeType;
  from: string; // node id
  to: string; // node id
  // weight + last_active are REQUIRED on INVOLVED_IN edges. This is the whole
  // mechanism behind "who actually knows this" — never collapse to a boolean.
  weight: number;
  last_active: string; // ISO timestamp of most recent activity on this edge
  sources: Source[];
  meta?: Record<string, unknown>;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  updatedAt: string;
}

// ---- Shape returned by the LLM extraction step (see llm/extract.ts) ----
// Kept here so the schema and its consumers stay in one mental model.

export interface ExtractedPerson {
  slackUserId?: string;
  name: string;
}

export interface ExtractedProject {
  key: string; // slug, e.g. "rate-limiting"
  name: string;
}

export interface ExtractedDecision {
  key: string; // slug, e.g. "drop-redis-ratelimit"
  summary: string;
}

export interface ExtractedInvolvement {
  person: string; // matches a person's slackUserId or name
  project: string; // matches a project key or name
  weight: number; // contribution from this batch (msgs/replies/fixes)
  ts: string; // ISO timestamp of the activity
  evidence: string; // short quote/justification for the citation
}

export interface ExtractedDecisionEdge {
  person: string;
  decision: string; // matches a decision key or summary
  type: 'RAISED_CONCERN' | 'MADE_CALL';
  ts: string;
  evidence: string;
}

export interface ExtractedRelation {
  decision: string;
  project: string;
}

export interface ExtractionResult {
  people: ExtractedPerson[];
  projects: ExtractedProject[];
  decisions: ExtractedDecision[];
  involvement: ExtractedInvolvement[];
  decisionEdges: ExtractedDecisionEdge[];
  relations: ExtractedRelation[];
}
