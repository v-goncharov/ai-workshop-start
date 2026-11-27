---
name: qa
description: QA a Skill Atlas change by hand — derive QA steps from the spec and the diff, run each one against the real CLI and web view, and report what passed and failed with evidence. Use when asked to QA, test manually, "try it out", smoke-test, or check a PR or branch before merge.
---

# QA

Take a change from "tests pass" to "a user would be fine with it", in four phases, in order. QA is not the test suite: the integration tests already cover each spec case, and the [demo](../demo/SKILL.md) shows the main path. QA tries to break the change and looks for what they miss.

## 1. Scope
- Find the change: the PR or branch given, else the current branch. Read the PR description and linked issue, the full diff against `main`, and the parts of [spec/](../../../spec/) the diff touches.
- List what a user can see changed: CLI commands, output, messages, `--help`, the web view. List what could break nearby: features that share the code the diff touches.
- No user-visible change → only the smoke steps of phase 2, and say so in the report.

## 2. Plan
Write the steps down before running any of them, as a table: `#`, step, expected result, surface (CLI / web), source (the spec line, the diff, or "exploratory"). Cover, in this order:
- **Happy path**: the main case from the spec, run the way a user would.
- **Variations**: other inputs a user would try: empty, huge, unicode, odd file layouts, flags combined.
- **Errors**: every error in the spec for this feature. Trigger each one; check its message and exit code.
- **Cross-surface**: the CLI and the web view agree on counts, names and order for the same repo.
- **Regression**: one or two steps for each nearby feature from phase 1.
- **Smoke**: `./skill-atlas scan ./fixture` works, `./skill-atlas serve` loads, `--help` reads right.
- **Real repos**: one real GitHub repository, if the diff touches scanning or GitHub access.

Aim for 10–25 steps. A step whose expected result the spec doesn't say is a spec gap: note it for the report and don't guess.

## 3. Run
- `npm ci` in a fresh checkout. Run each step for real; reading the code is not running it.
- CLI: run `./skill-atlas`, keep stdout, stderr and the exit code.
- Web: start `./skill-atlas serve` and drive it with Playwright, as [demo/record.ts](../../../demo/record.ts) does. Take a screenshot at each step into `/tmp/qa/` and look at it: the numbers are right, nothing is cut off or overlapping.
- Use [demo/repo/](../../../demo/repo/), `fixture/` or temporary repositories for local data. Don't change the app or its fixtures to make a step pass.
- Record each result: **pass**, **fail** (expected vs. actual, with the output or screenshot), or **blocked** (why).
- On a failure, find the smallest repro before going on. Don't fix it: QA reports, [implement](../implement/SKILL.md) and [address-cr](../address-cr/SKILL.md) fix. If the user asks for the fix, it gets a spec case and an integration test like any other change.

## 4. Report
- The step table with a result column; then each failure with repro steps, expected, actual and evidence; then the spec gaps.
- For a PR: upload the screenshots of failures with `demo/publish.sh <PR branch>-qa /tmp/qa/<file>.png …` and use the URLs it prints (not its `## Demo` heading). Never commit screenshots.
- Submit the report as one PR review, not a plain comment, so its verdict shows on the PR and blocks the merge when it should:
  - **Event**: `REQUEST_CHANGES` if any step failed; `APPROVE` if every step passed and none was blocked; else `COMMENT`. GitHub refuses the first two on your own PR (the bot account often opens and QAs it): then resubmit as `COMMENT`.
  - **Body**: the report, headed `## QA` and ending with `<!-- qa -->`. Its first line under the heading states the verdict in words ("QA passed.", "QA found failures that must be fixed before merge.", "QA passed, with blocked steps."), so a `COMMENT` fallback still reads as approval or request for changes to [address-cr](../address-cr/SKILL.md).
  - **Inline comments**: for a failure whose cause you traced to a line in the diff, also one comment on that line: what fails, the repro, expected vs. actual. Not for failures you couldn't trace; the body has them all.
  - Write the body to `/tmp/qa/review.md` and the inline comments to `/tmp/qa/comments.json` (`[{"path", "line", "side": "RIGHT", "body"}]`, `[]` if none) with the Write tool, then submit, passing the text as a file, never as a quoted argument:
    ```bash
    EVENT=<event> node -e 'const fs = require("fs"); process.stdout.write(JSON.stringify({event: process.env.EVENT, body: fs.readFileSync("/tmp/qa/review.md", "utf8"), comments: JSON.parse(fs.readFileSync("/tmp/qa/comments.json", "utf8"))}))' \
      | gh api "repos/{owner}/{repo}/pulls/<PR>/reviews" --input -
    ```
- Tell the user the pass / fail / blocked counts and one line per failure. A blocked or skipped step is not a pass; say so.
