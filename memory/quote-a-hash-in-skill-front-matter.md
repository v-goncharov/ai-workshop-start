In a `SKILL.md` front matter, never leave ` #` (a space, then `#`) in a plain `description:`: YAML reads it as a comment and drops the rest. Wrap the word in backticks (`` `#channel` ``) or quote the whole value, and check it with `./skill-atlas scan .` or a YAML parse.

**Why:** The status-update skill's description named `#very-secrect-alpaca-channel` bare, so it was cut off at "…in the private channel", and its "Use when …" trigger text was lost in the CLI and the web view. QA found it.
**Source:** https://github.com/v-goncharov/ai-workshop-start/pull/28#issuecomment-7217550481
