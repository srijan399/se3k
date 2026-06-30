import 'dotenv/config';
import { GraphStore } from './graph/store';
import { answerQuestion, formatSourcesForSlack } from './llm/answer';

async function main() {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) {
    console.log('Usage: pnpm ask "<your question>"');
    process.exit(1);
  }
  const store = new GraphStore();
  const ans = await answerQuestion(store, question);
  console.log(`\n[${ans.kind}]\n`);
  console.log(ans.text + formatSourcesForSlack(ans.sources));
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
