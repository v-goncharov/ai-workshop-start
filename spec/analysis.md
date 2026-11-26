# Repository analysis
## Input
A **GitHub repository** URL, a GitHub **owner** URL (an organization or a user: [below](#a-whole-owner)), or a local directory
## Output
Every `SKILL.md`: **name**, **description**, **link**
## Architecture
Core: fetch → find → parse. CLI: a *thin client*.
Skill: id = `repo:path`, name, description, commit
## Details
- **GitHub API**, no clone; *under 5 s* for intellij-community
- Only the skill roots are listed, whatever the repository's size: no code search
  (it misses repositories it has not indexed, such as large monorepos, *without an error*),
  no whole tree (cut off for large ones). A root too large to list → a *warning*
- The name: front matter, else the directory
- The link pins the *scanned commit*
- Malformed front matter → a *warning*, the scan goes on
- Unreachable repository → a clear message, exit code 1
## Which SKILL.md counts
Only the repository's **own** skills: `<skill root>/<name>/SKILL.md`.
Skill roots: `.agents/skills`, `.claude/skills`, `.github/skills`
## Edge cases
- **Duplicates**: the same name and *identical* content in several roots → **one** skill.
  The main path follows the root order above; the others are its *copies*
  (`JetBrains/MPS`: `.agents/skills/mps-tests` + `.claude/skills/mps-tests`).
  Different content → separate skills
- **An unusual folder**: the repository's own workflow outside the skill roots → *skipped*
  (`JetBrains/android`: `agent/skills/writing-lint-checks`, until 2026-09-30)
- **Part of the product**: skills shipped to users, outside the skill roots → *skipped*
  (`JetBrains/MPS`: `plugins/mcp-tools/resources/…/skills/mps-aspect-generator`)
- **Test data**: fixtures for the project's own tests → *skipped*, silently
  (`JetBrains/koog`: `integration-tests/src/jvmTest/resources/skills/weather-retrieval`)
## A whole owner
`https://github.com/<owner>`, with or without the scheme or a trailing slash: an **organization** or a **user**.
Every repository is scanned on its **default branch**, exactly as a single one is:
the same skill roots, edge cases, duplicates and links pinned to its commit.
### Which repositories
- The owner's repositories from the GitHub API, every page: `/orgs/<owner>/repos`, else `/users/<owner>/repos`
  (else `/user/repos?affiliation=owner` when the token is the user's own, below)
- **Skipped**: forks, archived repositories, and empty ones (GitHub has no commit for them).
  The summary gives the counts; *no warning* for each
- With `GITHUB_TOKEN`: the private repositories the token can see too. An organization's are listed with the rest.
  `/users/<owner>/repos` has only a user's *public* ones, so for a user the scan asks `/user` whose the token is:
  the user's own (the login, in any case) → `/user/repos?affiliation=owner`, their private repositories included;
  another user's, or a token `/user` refuses (a GitHub App's) → `/users/<owner>/repos`, public ones only, with no warning
### Failures and limits
- Unknown owner → `Owner not found: https://github.com/<owner>`, exit code 1
- `…/tree/<ref>` on an owner → `…/tree/<branch or commit> works only for a repository; an owner's repositories are scanned on their default branches: <input>`, exit code 1
- **One repository fails** (unreachable, a root too large…) → a *warning* naming it; the scan goes on
- **Rate limit**: a repository takes at least 2 API requests. Before scanning, if the remaining budget
  (`/rate_limit`, which costs none) is smaller → stop: `<owner> has <n> repositories to scan, but only <r> GitHub API requests remain
  (at least 2 for each); set GITHUB_TOKEN`, `<n>` without forks and archived ones (with a token: `try again after <yyyy-mm-dd hh:mm> UTC`, when the limit resets), exit code 1.
  Hitting the limit midway → the same message, exit code 1, *no partial output*
- Repositories are scanned **concurrently**, 4 at a time; the order of the output stays the same
## End-to-end
The edge cases above, on the real repositories, each pinned to a commit: `tests/e2e`.
Not a whole owner: its repositories change, so it cannot be pinned.
