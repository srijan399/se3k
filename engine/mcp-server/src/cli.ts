import 'dotenv/config';
import { GraphStore } from './graph/store';
import { answerQuestion, formatSourcesForSlack } from './llm/answer';

async function main() {
  const teamId = process.env.TEAM_ID;
  const question = process.argv.slice(2).join(' ').trim();
  if (!teamId || !question) {
    console.log('Usage: TEAM_ID=<teamId> pnpm ask "<your question>"');
    process.exit(1);
  }
  const store = await GraphStore.forTeam(teamId);
  const ans = await answerQuestion(store, question);
  console.log(`\n[${ans.kind}]\n`);
  console.log(ans.text + formatSourcesForSlack(ans.sources));
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
