# AGENTS.md
## Memory
[./memory](memory/) holds lessons from earlier runs. Read every file there first.
When something went wrong that knowing one thing would have prevented (a review comment you fixed, a check that kept failing, a correction from the user), add or update a lesson as [memory/README.md](memory/README.md) says. Commit it only on a branch you are already pushing. Reviews and QA don't commit, because a new commit invalidates an approval.
## Specs
Read [./spec](spec/) first. Update it with the code.
## Tests
Integration tests for every case in the spec.
## Definition of done
- All tests pass locally

## Commands
- `npm ci`: first, in a fresh checkout
- `npm test`: the tests
- `npm run test:e2e`: end-to-end, on real GitHub repositories (network; `GITHUB_TOKEN` optional)
