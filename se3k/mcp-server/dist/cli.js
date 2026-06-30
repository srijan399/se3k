"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const store_1 = require("./graph/store");
const answer_1 = require("./llm/answer");
// Quick local tester (no Slack, no MCP plumbing):
//   pnpm ask "who do I talk to about rate limiting?"
//   pnpm ask "why did we drop the redis rate limiter?"
async function main() {
    const question = process.argv.slice(2).join(' ').trim();
    if (!question) {
        console.log('Usage: pnpm ask "<your question>"');
        process.exit(1);
    }
    const store = new store_1.GraphStore();
    const ans = await (0, answer_1.answerQuestion)(store, question);
    console.log(`\n[${ans.kind}]\n`);
    console.log(ans.text + (0, answer_1.formatSourcesForSlack)(ans.sources));
    console.log('');
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
