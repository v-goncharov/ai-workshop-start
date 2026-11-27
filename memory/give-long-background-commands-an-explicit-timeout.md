When a skill tells the agent to run a long command in the background, give the exact Bash `timeout` (above the command's own wait) and say to keep the turn open until it exits.

**Why:** `implement` said to run the hour-long `ask-slack.ts` "in the background" with no timeout; Bash kills background commands at the 30-minute default, and on Air the session ends with the turn, so the wait would be cut off or lost.
**Source:** https://github.com/v-goncharov/ai-workshop-start/pull/25#discussion_r4717963664
