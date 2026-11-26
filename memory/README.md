# Memory

Lessons the agents learned working on this repository, written by the agents for the agents. [AGENTS.md](../AGENTS.md) says when to read and write them.

## When to write
Write a lesson when something went wrong that a future run could have avoided by knowing one thing:
- a review comment you agreed with and fixed (`address-cr`): the author should have known it;
- a check that failed more than once before you found the cause: `typecheck`, `test`, `test:e2e`, CI;
- a QA failure you fixed: the tests missed a class of bug;
- a demo that failed to record or whose frames were wrong;
- the user corrected you, or you had to ask something the repository could have told you.

Nothing went wrong → write nothing. Don't record what the code, `spec/`, `AGENTS.md`, a skill or the git history already says, or anything that only mattered to this one change.

## How to write
- First look for a lesson on the same topic. Update it instead of adding a near-duplicate. A lesson that turns out to be wrong gets deleted.
- One lesson per file: `memory/<what-to-do-in-kebab-case>.md`, for example `memory/run-e2e-when-touching-github-client.md`. Separate files mean parallel runs don't conflict.
- Format:
  ```markdown
  <The rule, one or two sentences, as an instruction.>

  **Why:** <what happened, concretely>
  **Source:** <PR, review comment or CI run URL>
  ```
- Commit it on the branch you are already on, in its own commit (`memory: <rule>`), so it is reviewed and merged with the change. Never push to `main` directly.

## Graduating
`memory/` is for lessons that haven't settled. When a lesson is clearly part of how the repo works, move it to where it belongs (`spec/`, `AGENTS.md`, or the skill it is about) and delete the file, in the same commit. When there are more than 15 lessons, graduate or merge some before adding another.
