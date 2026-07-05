import 'dotenv/config';
import { GraphStore } from './graph/store';

// Deterministic demo graph that mirrors the two TESTING.md scenarios, using the
// real workspace cast. It's the offline insurance: the dashboard and /ask-graph
// answer correctly even with no LLM key or before anyone posts.
//
// Roles (assignee ≠ expert, both ways):
//   #backend  — Adam formally owns checkout but hands it off; IVAN does the work.
//   #frontend — Adam owns the frontend on paper; RAHUL does the work.
//   Sam relays support tickets (low weight). Adam raises the concerns; the doers
//   make the calls.
//
// hackathon shortcut: no slackUserId on seeded people — they render as plain
// names so a cold-open Slack demo never shows a broken <@id> mention. Live
// ingestion supplies real ids (see store.ingest `authors`). Run with: pnpm seed

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

export async function seed(store: GraphStore): Promise<void> {
  store.clear();

  // ---- People (real cast) ----
  const adam = store.upsertPerson('Adam Reyes'); // CEO / Sr. Backend — formal owner, hands off
  const ivan = store.upsertPerson('Ivan Sanders'); // Forward Deployed — backend expert
  const rahul = store.upsertPerson('Rahul Sharma'); // Frontend Developer — frontend expert
  const sam = store.upsertPerson('Sam Okafor'); // Director, Customer Service — relays tickets

  // ---- Projects ----
  const checkout = store.upsertProject('checkout-api', 'Checkout API');
  const cart = store.upsertProject('cart-ui', 'Cart / checkout UI');

  // ---- Decisions ----
  const pgbouncer = store.upsertDecision(
    'adopt-pgbouncer',
    'Adopt PgBouncer connection pooling for the checkout service',
  );
  const optimisticCart = store.upsertDecision(
    'optimistic-cart',
    'Ship optimistic cart updates with a rollback toast + retry',
  );

  const backend = { channel: '#backend' };
  const frontend = { channel: '#frontend' };

  // ---- #backend / checkout-api ----
  // Adam: formally assigned, one stale kickoff long ago → low + old.
  store.addInvolvement(adam.id, checkout.id, 1, daysAgo(120), {
    ...backend,
    ts: daysAgo(120),
    excerpt: 'I own the checkout service this quarter.',
  });
  // Sam: relays the customer signal → low weight.
  store.addInvolvement(sam.id, checkout.id, 1, daysAgo(7), {
    ...backend,
    ts: daysAgo(7),
    excerpt: 'Wave of tickets — customers say checkout times out at peak hours.',
  });
  // Ivan: reproduced, root-caused, shipped the fix, recently → the real expert.
  store.addInvolvement(ivan.id, checkout.id, 4, daysAgo(6), {
    ...backend,
    ts: daysAgo(6),
    excerpt: 'Reproduced it — the API stalls when the Postgres connection pool is exhausted.',
  });
  store.addInvolvement(ivan.id, checkout.id, 5, daysAgo(4), {
    ...backend,
    ts: daysAgo(4),
    excerpt: 'Shipped PgBouncer connection pooling; checkout p95 dropped 9s → 700ms.',
  });

  // ---- #frontend / cart-ui ----
  // Adam: owns the frontend on paper, stale → low + old.
  store.addInvolvement(adam.id, cart.id, 1, daysAgo(150), {
    ...frontend,
    ts: daysAgo(150),
    excerpt: "I own the frontend on paper but haven't touched it in months.",
  });
  // Rahul: rewrote the cart flow + fixed the stepper, recently → frontend expert.
  store.addInvolvement(rahul.id, cart.id, 5, daysAgo(5), {
    ...frontend,
    ts: daysAgo(5),
    excerpt: 'Rewrote add-to-cart to update optimistically; the UI freeze is gone.',
  });
  store.addInvolvement(rahul.id, cart.id, 3, daysAgo(3), {
    ...frontend,
    ts: daysAgo(3),
    excerpt: 'Fixed the quantity stepper that fired a request per click.',
  });

  // ---- Decision provenance ----
  // PgBouncer: Adam pushed back, Ivan made the call.
  store.addEdge('RAISED_CONCERN', adam.id, pgbouncer.id, daysAgo(5), {
    ...backend,
    ts: daysAgo(5),
    excerpt: 'Concern: PgBouncer is one more thing to run and monitor.',
  });
  store.addEdge('MADE_CALL', ivan.id, pgbouncer.id, daysAgo(4), {
    ...backend,
    ts: daysAgo(4),
    excerpt: 'Final call: keep PgBouncer — pool exhaustion was the real outage cause; adding monitoring.',
  });
  store.addEdge('RELATES_TO', pgbouncer.id, checkout.id, daysAgo(4));

  // Optimistic cart: Adam pushed back, Rahul made the call.
  store.addEdge('RAISED_CONCERN', adam.id, optimisticCart.id, daysAgo(4), {
    ...frontend,
    ts: daysAgo(4),
    excerpt: 'Concern: optimistic updates could show a wrong item count if a reconcile silently fails.',
  });
  store.addEdge('MADE_CALL', rahul.id, optimisticCart.id, daysAgo(3), {
    ...frontend,
    ts: daysAgo(3),
    excerpt: 'Final call: ship optimistic updates with a rollback toast + retry on failure.',
  });
  store.addEdge('RELATES_TO', optimisticCart.id, cart.id, daysAgo(3));

  await store.saveTeam();
  const snap = store.snapshot();
  console.error(`Seeded graph: ${snap.nodes.length} nodes, ${snap.edges.length} edges`);
}

if (require.main === module) {
  const teamId = process.argv[2];
  if (!teamId) {
    console.error('Usage: pnpm seed <teamId>');
    process.exit(1);
  }
  GraphStore.forTeam(teamId).then(seed).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
