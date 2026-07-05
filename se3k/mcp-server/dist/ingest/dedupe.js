"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.filterProcessed = filterProcessed;
const client_1 = require("../db/client");
const schema_1 = require("../db/schema");
// Shared idempotency gate for BOTH live ingestion (mcpTools.ts) and the
// backfill runner (backfill/run.ts) — the two things that used to double-count
// INVOLVED_IN weight when run as separate processes with no shared dedupe
// state. Lines without a channelId/ts pass through unchecked.
async function filterProcessed(teamId, channelId, lines, refs) {
    if (!channelId || !refs)
        return { lines, refs, skipped: 0 };
    const keptLines = [];
    const keptRefs = {};
    let skipped = 0;
    for (const line of lines) {
        const tag = line.match(/^\[([A-Za-z0-9]+)\]/)?.[1];
        const ref = tag ? refs[tag] : undefined;
        if (tag && ref?.ts) {
            const inserted = await client_1.db
                .insert(schema_1.processedMessages)
                .values({ teamId, channelId, ts: ref.ts })
                .onConflictDoNothing()
                .returning({ ts: schema_1.processedMessages.ts });
            if (inserted.length === 0) {
                skipped++;
                continue; // already ingested (live + backfill overlap)
            }
        }
        keptLines.push(line);
        if (tag && ref)
            keptRefs[tag] = ref;
    }
    return { lines: keptLines, refs: keptRefs, skipped };
}
