import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { processedMessages } from '../db/schema';
import { MessageRefs } from '../graph/types';

// Shared idempotency gate for BOTH live ingestion (mcpTools.ts) and the
// backfill runner (backfill/run.ts) — the two things that used to double-count
// INVOLVED_IN weight when run as separate processes with no shared dedupe
// state. Lines without a channelId/ts pass through unchecked.
//
// This only CHECKS prior processing — it does not record anything yet.
// Callers must call markProcessed() after a successful ingest. Marking up
// front (before extraction) would permanently blackhole a batch if the LLM
// call happened to fail transiently — it'd be marked "seen" and never
// retried even though nothing was ever extracted from it.
export async function filterProcessed(
  teamId: string,
  channelId: string | undefined,
  lines: string[],
  refs: MessageRefs | undefined,
): Promise<{
  lines: string[];
  refs: MessageRefs | undefined;
  skipped: number;
  tsToMark: string[];
}> {
  if (!channelId || !refs) return { lines, refs, skipped: 0, tsToMark: [] };

  const tagged = lines.map((line) => {
    const tag = line.match(/^\[([A-Za-z0-9]+)\]/)?.[1];
    const ref = tag ? refs[tag] : undefined;
    return { line, tag, ref };
  });

  const candidateTs = [
    ...new Set(tagged.map((t) => t.ref?.ts).filter((ts): ts is string => !!ts)),
  ];
  let already = new Set<string>();
  if (candidateTs.length) {
    const rows = await db
      .select({ ts: processedMessages.ts })
      .from(processedMessages)
      .where(
        and(
          eq(processedMessages.teamId, teamId),
          eq(processedMessages.channelId, channelId),
          inArray(processedMessages.ts, candidateTs),
        ),
      );
    already = new Set(rows.map((r) => r.ts));
  }

  const keptLines: string[] = [];
  const keptRefs: MessageRefs = {};
  const tsToMark: string[] = [];
  let skipped = 0;
  for (const { line, tag, ref } of tagged) {
    if (ref?.ts && already.has(ref.ts)) {
      skipped++;
      continue; // already ingested (live + backfill overlap)
    }
    keptLines.push(line);
    if (tag && ref) keptRefs[tag] = ref;
    if (ref?.ts) tsToMark.push(ref.ts);
  }
  return { lines: keptLines, refs: keptRefs, skipped, tsToMark };
}

// Commit the dedupe record — call ONLY after a successful ingest + saveTeam,
// so a failed extraction leaves the batch unmarked and eligible for retry.
export async function markProcessed(
  teamId: string,
  channelId: string | undefined,
  tsList: string[],
): Promise<void> {
  if (!channelId || !tsList.length) return;
  await db
    .insert(processedMessages)
    .values(tsList.map((ts) => ({ teamId, channelId, ts })))
    .onConflictDoNothing();
}
