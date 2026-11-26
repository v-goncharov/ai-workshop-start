# Repository analysis
## Input
A **GitHub repository** URL, or a local directory
## Output
Every `SKILL.md`: **name**, **description**, **link**
## Architecture
Core: fetch → find → parse. CLI: a *thin client*.
Skill: id = `repo:path`, name, description, commit
## Details
- **GitHub API**, no clone; *under 5 s* for intellij-community
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
## End-to-end
The edge cases above, on the real repositories, each pinned to a commit: `tests/e2e`.
