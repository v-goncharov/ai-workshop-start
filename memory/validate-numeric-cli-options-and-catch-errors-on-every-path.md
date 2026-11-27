In a helper script, reject numeric options that aren't finite positive numbers (`Number.isFinite(n) && n > 0`), and handle the errors you throw on every call path, not just the main loop.

**Why:** `ask-slack.ts` took `--wait 1h` as `NaN`, so its deadline never passed and it polled Slack ~1,300 times a second; its `Transient` errors were caught only in the polling loop, so a blip at start-up printed a raw stack trace. QA found both.
**Source:** https://github.com/v-goncharov/ai-workshop-start/pull/25#issuecomment-7215387588
