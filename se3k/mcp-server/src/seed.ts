import 'dotenv/config';
import { GraphStore } from './graph/store';

// Deliberate demo scenario that proves the core behavior:
// - "rate-limiting" is FORMALLY owned by Dana, who has since gone quiet.
// - Mia actually debugged + fixed it across threads, recently → the real expert.
// - Leo reviewed/merged → strong runner-up.
// - A decision (drop Redis-based limiter) has real dissent (Sam) and a final
//   call (Mia), proving decision provenance, not just an outcome.
//
// This is the plan's "hand-seeded graph" insurance: the demo answers correctly
// even if live LLM extraction is unavailable. Run with: pnpm seed

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

export function seed(store: GraphStore): void {
  store.clear();

  // ---- People ----
  const dana = store.upsertPerson('Dana Okafor', 'U_DANA'); // formal owner, now inactive
  const mia = store.upsertPerson('Mia Chen', 'U_MIA'); // actual expert
  const leo = store.upsertPerson('Leo Martins', 'U_LEO'); // reviewer / runner-up
  const sam = store.upsertPerson('Sam Reyes', 'U_SAM'); // raised the dissent

  // ---- Projects ----
  const rl = store.upsertProject('rate-limiting', 'API gateway rate limiting');
  const billing = store.upsertProject('billing-webhooks', 'Billing webhooks');

  // ---- Decision ----
  const decision = store.upsertDecision(
    'drop-redis-ratelimit',
    'Drop the Redis-backed rate limiter in favor of an in-process token bucket',
  );

  const ch = { channel: '#backend', channelId: 'C_BACKEND' };

  // ---- Involvement: rate-limiting ----
  // Dana: formally assigned, but only a stale kickoff message long ago → low + old.
  store.addInvolvement(dana.id, rl.id, 1, daysAgo(140), {
    ...ch,
    ts: daysAgo(140),
    excerpt: "I'll own rate-limiting for this quarter.",
  });

  // Mia: repeatedly debugged + posted the actual fix, recently → high + recent.
  store.addInvolvement(mia.id, rl.id, 5, daysAgo(9), {
    ...ch,
    ts: daysAgo(12),
    excerpt: 'Traced the 429 storms to Redis round-trips under burst load.',
  });
  store.addInvolvement(mia.id, rl.id, 5, daysAgo(7), {
    ...ch,
    ts: daysAgo(7),
    excerpt: 'Shipped the in-process token bucket; p99 dropped from 180ms to 22ms.',
  });
  store.addInvolvement(mia.id, rl.id, 3, daysAgo(2), {
    ...ch,
    ts: daysAgo(2),
    excerpt: 'Answered the on-call thread about tuning the burst size.',
  });

  // Leo: reviewed and merged the fix → solid runner-up.
  store.addInvolvement(leo.id, rl.id, 3, daysAgo(7), {
    ...ch,
    ts: daysAgo(7),
    excerpt: 'Reviewed and merged the token-bucket PR; suggested the jitter window.',
  });

  // Some unrelated involvement so ranking has to actually discriminate.
  store.addInvolvement(dana.id, billing.id, 4, daysAgo(20), {
    ...ch,
    ts: daysAgo(20),
    excerpt: 'Rebuilt the Stripe webhook retry logic.',
  });

  // ---- Decision provenance ----
  store.addEdge('RAISED_CONCERN', sam.id, decision.id, daysAgo(11), {
    ...ch,
    ts: daysAgo(11),
    excerpt: 'Worried in-process limits drift across pods without shared state.',
  });
  store.addEdge('RAISED_CONCERN', leo.id, decision.id, daysAgo(10), {
    ...ch,
    ts: daysAgo(10),
    excerpt: 'Asked how we handle a pod restart losing its bucket counts.',
  });
  store.addEdge('MADE_CALL', mia.id, decision.id, daysAgo(8), {
    ...ch,
    ts: daysAgo(8),
    excerpt:
      'Decided per-pod buckets are fine: limits are advisory and Redis latency was the real outage cause.',
  });
  store.addEdge('RELATES_TO', decision.id, rl.id, daysAgo(8));

  store.save();
  const snap = store.snapshot();
  console.log(
    `Seeded graph: ${snap.nodes.length} nodes, ${snap.edges.length} edges → ${''}`,
  );
}

if (require.main === module) {
  seed(new GraphStore());
}
