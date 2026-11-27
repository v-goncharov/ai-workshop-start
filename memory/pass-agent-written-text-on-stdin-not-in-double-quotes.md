When a skill has the agent pass free text it wrote (messages, questions, PR text) to a command, take it on stdin through a quoted heredoc (`<<'EOF'`), not as a `"<text>"` argument.

**Why:** `implement` ran `ask-slack.ts "<message>"`; the agent's questions use backtick code spans like `spec/cli.md`, which bash runs as command substitution inside double quotes, so Slack got the question with holes in it.
**Source:** https://github.com/v-goncharov/ai-workshop-start/pull/25#discussion_r4718083730
