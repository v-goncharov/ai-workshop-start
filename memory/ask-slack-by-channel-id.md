Run `ask-slack.ts` with `--channel C0CM9AWDGVB` (the ID of `#very-secrect-alpaca-channel`): the bot token has no `channels:read` scope, so looking the channel up by name fails.

**Why:** On issue #26, `ask-slack.ts` exited 1 with `conversations.list: missing_scope` before posting. `chat.postMessage` accepts `#very-secrect-alpaca-channel` and returns the ID, and with that ID the script posts and waits fine.
**Source:** https://github.com/v-goncharov/ai-workshop-start/issues/26
