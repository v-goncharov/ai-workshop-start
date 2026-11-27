---
name: implement
description: Implement an issue end to end in Skill Atlas — understand the design, update the spec, write the tests, implement, and open a pull request. Use when asked to implement, fix, build or "do" an issue, feature request or bug report (a URL, a number, or pasted text).
---

# Implement

Take the issue from understanding to an open pull request, in five phases, in order. Don't start a phase until the previous one is done.

## 1. Understand the design
- Read the issue with all its comments and linked issues. Issues are disabled on this repository, so the issue may be a URL elsewhere or pasted text; if there is none, ask for it.
- Read [AGENTS.md](../../../AGENTS.md), then every file in [spec/](../../../spec/): it says what the tool does today. Then read the code the issue touches and enough code around it to know where the change belongs: `src/core` (scan, GitHub, parsing), `src/commands.ts` and `src/cli.ts` (CLI), `src/web` (web view).
- Write the design down as a change to `spec/`, in the spec's own terse style: the new behavior, each case and edge case, every error and its message. This is the contract for phases 2 and 3.
- When the issue is ambiguous, contradicts the spec, or has more than one sensible design, ask in Slack, in `#very-secrect-alpaca-channel`, and wait up to an hour for an answer. Don't guess on behavior a user will see.
  - Ask everything in one message: a link to the issue, each question, its options and your recommendation.
  - Post it and wait. Pass the message on stdin with a quoted heredoc, never as a `"<message>"` argument: inside double quotes bash runs the backticks and `$…` of code spans like `spec/cli.md` as commands. Write the output and the exit code to a file:
    ```bash
    timeout 3700 node .claude/skills/implement/ask-slack.ts - > /tmp/ask-slack.out 2>&1 <<'EOF'; echo "exit: $?" >> /tmp/ask-slack.out
    <message>
    EOF
    ```
    The script waits up to 3600 s, longer than a foreground command may run, so run this with Bash `run_in_background: true` and `timeout: 3900000` (65 min). The background default is 30 min, and at that limit the command is killed before the hour is up. The inner `timeout 3700` makes sure the `exit:` line is still written if the script hangs or is killed. Don't poll Slack yourself. The file gets `thread: <ts>`, then the replies, then `exit: <code>`.
  - Keep the turn open until the `exit:` line appears. Wait with Monitor, `timeout_ms: 1800000` (its maximum; the 5-minute default expires long before the hour), running `until grep -q '^exit:' /tmp/ask-slack.out; do sleep 30; done; cat /tmp/ask-slack.out`. When the monitor expires without output, arm it again, as often as it takes, and don't end the turn in between: on Air nothing wakes the session after the turn ends, so the answer would never be read. If the background command ends and the file has no `exit:` line, treat it as an error (below).
  - `exit: 0`: read the answer and go on. If it leaves something open, follow up in the same thread with `--thread <ts> -` and the message in the heredoc, run and waited for the same way; each follow-up waits up to another hour.
  - `exit: 2`, no answer within the hour: stop. Don't guess and don't open a PR. Report the unanswered questions and the Slack thread to the user. Any other exit (1, 124 from `timeout`, 143 and the like from a signal, or no `exit:` line): Slack or the wait failed; report the error and stop the same way.

## 2. Tests
- One integration test for every case you added or changed in the spec, named after that case, in the matching `tests/*.test.ts` (`scan`, `edge-cases`, `web`), or a new file if none fits. Follow the existing tests: run the real CLI or server, use `tests/helpers.ts`, and use temporary repositories or replayed GitHub recordings, so `npm test` stays offline.
- Change `tests/e2e/` only when the behavior on real repositories changes. Then re-record its expected output on purpose and say why in the PR.
- Run `npm test`. Each new test must fail, and fail because the behavior is missing, not because the test is broken.

## 3. Implementation
- Make the smallest change that makes the tests pass and fits how the code is already built. No refactors, renames or abstractions the issue doesn't need.
- Keep the spec, README and `--help` in step with the code. If the implementation changes the design, update the spec first.
- Done means: `npm run typecheck` and `npm test` pass, and `npm run test:e2e` too if you touched scanning or GitHub access. Run them; don't assume. Try the change once the way a user would: `./skill-atlas scan ./fixture`, or `./skill-atlas serve` for the web view.

## 4. Demo
- **Every PR with a UI change MUST have a video demo.** A UI change is anything a user sees: the web view, or the CLI's output, messages and `--help`. With the [demo skill](../demo/SKILL.md), add `demo/scenarios/<feature>.ts` and record it with `npm run demo -- <feature>`. Show the feature as the spec describes it, and check the frames before you go on.
- When a change shows up differently in a scenario that already exists (a caption, a count, a screen), update that scenario and record it again too.
- No UI change (internals, GitHub access, speed, tests only) → no demo. Say so in the PR with the reason. When unsure, record one.
- A demo you can't record (no browser, no `ffmpeg`) blocks the PR. Tell the user and don't open the PR without it.

## 5. Pull request
- Branch from an up-to-date `main` (the remote is `fork`) with a short descriptive name. Commit the spec, tests, code and demo scenario together with a message that says what changed and why.
- Push the branch. With a demo, publish it: `demo/publish.sh <branch> demo/out/<feature>.gif demo/out/<feature>.mp4`. This prints the `## Demo` section.
- Open the PR with `gh pr create`. Use the style of the earlier PRs:
  - `## What`: the user-visible change, a few bullets.
  - `## Spec changes`: what changed in `spec/` and why, including any corrections.
  - `## Demo`: as `demo/publish.sh` printed it, the GIF inline and the MP4 linked. Without a UI change: `No demo: <why there is nothing to show>`.
  - `## Testing`: the commands you ran and their real results (for example "`npm test` (17 pass)").
  - Link the issue.
- Give the user the PR URL. If a check fails or a step was skipped, say so; don't report it as done.
