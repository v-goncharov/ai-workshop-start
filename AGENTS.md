# AGENTS.md
## Memory
Read every file in [./memory](memory/) first: lessons from earlier runs. Write new ones as [memory/README.md](memory/README.md) says.
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
