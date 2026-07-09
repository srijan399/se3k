clear-test:
	pnpm -C engine/slack-bot seed:slack --file testing.txt --clear

clear-channels:
	pnpm -C engine/slack-bot seed:slack --clear