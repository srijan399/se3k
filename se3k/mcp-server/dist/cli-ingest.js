"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const fs = __importStar(require("fs"));
const store_1 = require("./graph/store");
const extract_1 = require("./llm/extract");
// Local ingest tester (no Slack, no MCP plumbing):
//   pnpm ingest ../sample-messages.txt
//   pnpm ingest ../sample-messages.txt 12 30   # batchSize=12, 30s between batches
//
// Reads a file of "Name [#channel @ ts]: text" lines, chunks them, and feeds
// each chunk through the same extraction the MCP tool uses. Throttles between
// batches so we stay under Groq's per-minute (TPM) free-tier limit; the client
// also auto-retries on 429, so this is belt-and-suspenders.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
    const [file, batchArg, delayArg] = process.argv.slice(2);
    if (!file) {
        console.log('Usage: pnpm ingest <file> [batchSize=12] [delaySeconds=20]');
        process.exit(1);
    }
    const batchSize = Number(batchArg) || 12;
    const delayMs = (Number(delayArg) || 20) * 1000;
    const lines = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean); // drop blank separator lines
    const store = new store_1.GraphStore();
    const batches = [];
    for (let i = 0; i < lines.length; i += batchSize) {
        batches.push(lines.slice(i, i + batchSize));
    }
    console.log(`Ingesting ${lines.length} messages in ${batches.length} batch(es) of ${batchSize}, ${delayMs / 1000}s apart…\n`);
    for (let i = 0; i < batches.length; i++) {
        const text = batches[i].join('\n');
        // best-effort channel tag from the first line's [#channel ...]
        const ch = text.match(/\[#?([a-z0-9\-_]+)/i)?.[1];
        try {
            const result = await (0, extract_1.extractGraph)(text);
            store.ingest(result, ch ? { channel: `#${ch}` } : undefined);
            store.save();
            const snap = store.snapshot();
            console.log(`[${i + 1}/${batches.length}] +people:${result.people?.length || 0} projects:${result.projects?.length || 0} decisions:${result.decisions?.length || 0} involvement:${result.involvement?.length || 0}  →  graph: ${snap.nodes.length} nodes / ${snap.edges.length} edges`);
        }
        catch (err) {
            console.error(`[${i + 1}/${batches.length}] batch failed:`, err);
        }
        if (i < batches.length - 1)
            await sleep(delayMs);
    }
    const snap = store.snapshot();
    console.log(`\nDone. Graph: ${snap.nodes.length} nodes / ${snap.edges.length} edges.`);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
