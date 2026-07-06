import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from './db/client';
import {
  backfillJobs,
  graphEdges,
  graphNodes,
  installations,
  processedMessages,
} from './db/schema';

//   pnpm -C engine/mcp-server reset-graph <teamId>
async function main() {
  const teamId = process.argv[2];

  if (!teamId) {
    const rows = await db
      .select({ id: installations.teamId, name: installations.teamName })
      .from(installations);
    console.log('Usage: pnpm reset-graph <teamId>\n');
    if (rows.length) {
      console.log('Installed workspaces:');
      for (const r of rows) console.log(`  ${r.id}  ${r.name || ''}`);
    } else {
      console.log('No workspaces installed.');
    }
    process.exit(1);
  }

  const [inst] = await db
    .select()
    .from(installations)
    .where(eq(installations.teamId, teamId));

  const [n, e, p, j] = await db.transaction(async (tx) => {
    const en = await tx.delete(graphNodes).where(eq(graphNodes.teamId, teamId));
    const ee = await tx.delete(graphEdges).where(eq(graphEdges.teamId, teamId));
    const ep = await tx
      .delete(processedMessages)
      .where(eq(processedMessages.teamId, teamId));
    const ej = await tx
      .delete(backfillJobs)
      .where(eq(backfillJobs.teamId, teamId));
    return [
      en.rowCount ?? 0,
      ee.rowCount ?? 0,
      ep.rowCount ?? 0,
      ej.rowCount ?? 0,
    ];
  });

  console.log(
    `🧹 reset team ${teamId} — removed ${n} node(s), ${e} edge(s), ${p} dedupe row(s), ${j} job(s).`,
  );
  console.log(
    inst
      ? '   Install + tokens kept — re-seed / re-backfill without re-minting.'
      : '   (No installation on record; nothing to keep.)',
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
