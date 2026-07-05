"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const store_1 = require("./graph/store");
const answer_1 = require("./llm/answer");
async function main() {
    const teamId = process.env.TEAM_ID;
    const question = process.argv.slice(2).join(' ').trim();
    if (!teamId || !question) {
        console.log('Usage: TEAM_ID=<teamId> pnpm ask "<your question>"');
        process.exit(1);
    }
    const store = await store_1.GraphStore.forTeam(teamId);
    const ans = await (0, answer_1.answerQuestion)(store, question);
    console.log(`\n[${ans.kind}]\n`);
    console.log(ans.text + (0, answer_1.formatSourcesForSlack)(ans.sources));
    console.log('');
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
