When a script polls for a human's reply (Slack, comments), don't stop at the first message: keep polling until one interval passes with nothing new, and hand back a cursor (the last `ts` read) that the next wait starts from.

**Why:** `ask-slack.ts` exited at the first poll that found any reply, so an answer sent as two messages 20 s apart was read in half, and the follow-up mode counted from its own post, losing whatever came in between.
**Source:** https://github.com/v-goncharov/ai-workshop-start/pull/25#discussion_r4718171953
