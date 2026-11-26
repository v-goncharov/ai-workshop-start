---
name: implement
description: Implement an issue end to end in Skill Atlas — understand the design, update the spec, write the tests, implement, and open a pull request. Use when asked to implement, fix, build or "do" an issue, feature request or bug report (a URL, a number, or pasted text).
---

# Implement

Take the issue from understanding to an open pull request, in four phases, in order. Don't start a phase until the previous one is done.

## 1. Understand the design
- Read the issue with all its comments and linked issues. Issues are disabled on this repository, so the issue may be a URL elsewhere or pasted text; if there is none, ask for it.
- Read [AGENTS.md](../../../AGENTS.md), then every file in [spec/](../../../spec/): it says what the tool does today. Then read the code the issue touches and enough code around it to know where the change belongs: `src/core` (scan, GitHub, parsing), `src/commands.ts` and `src/cli.ts` (CLI), `src/web` (web view).
- Write the design down as a change to `spec/`, in the spec's own terse style: the new behavior, each case and edge case, every error and its message. This is the contract for phases 2 and 3.
- Stop and ask the user when the issue is ambiguous, contradicts the spec, or has more than one sensible design. Give the options and your recommendation. Don't guess on behavior a user will see.

## 2. Tests
- One integration test for every case you added or changed in the spec, named after that case, in the matching `tests/*.test.ts` (`scan`, `edge-cases`, `web`), or a new file if none fits. Follow the existing tests: run the real CLI or server, use `tests/helpers.ts`, and use temporary repositories or replayed GitHub recordings, so `npm test` stays offline.
- Change `tests/e2e/` only when the behavior on real repositories changes. Then re-record its expected output on purpose and say why in the PR.
- Run `npm test`. Each new test must fail, and fail because the behavior is missing, not because the test is broken.

## 3. Implementation
- Make the smallest change that makes the tests pass and fits how the code is already built. No refactors, renames or abstractions the issue doesn't need.
- Keep the spec, README and `--help` in step with the code. If the implementation changes the design, update the spec first.
- Done means: `npm run typecheck` and `npm test` pass, and `npm run test:e2e` too if you touched scanning or GitHub access. Run them; don't assume. Try the change once the way a user would: `./skill-atlas scan ./fixture`, or `./skill-atlas serve` for the web view.

## 4. Pull request
- Branch from an up-to-date `main` (the remote is `fork`) with a short descriptive name. Commit the spec, tests and code together with a message that says what changed and why.
- Push and open the PR with `gh pr create`. Use the style of the earlier PRs:
  - `## What`: the user-visible change, a few bullets.
  - `## Spec changes`: what changed in `spec/` and why, including any corrections.
  - `## Testing`: the commands you ran and their real results (for example "`npm test` (17 pass)").
  - Link the issue.
- Give the user the PR URL. If a check fails or a step was skipped, say so; don't report it as done.
