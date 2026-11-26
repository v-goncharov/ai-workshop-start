# Command line
`./skill-atlas scan <GitHub URL | owner URL | directory>`; `./skill-atlas serve`: the [web view](web.md)
A GitHub URL scans the default branch; `…/tree/<commit or branch>` scans that one.
An owner URL, `https://github.com/<owner>`, scans every repository of the organization or user ([which ones](analysis.md#a-whole-owner)).
Prints the result **at once**; *nothing is stored*.
`GITHUB_TOKEN`, optional: a higher GitHub rate limit, and private repositories.
## Output
```
JetBrains/kotlin · 6 skills
build-tools-bump-gradle-api — Bumps the Gradle API…
  https://github.com/JetBrains/kotlin/blob/<commit>/…
```
- Sorted by **name**; the description's *first sentence*
- `also in <paths>` for copies; warnings go to *stderr*
## Output for an owner
```
JetBrains · 51 skills in 4 of 312 repositories (20 forks, 7 archived and 2 empty skipped)
JetBrains/MPS · 43 skills
mps-tests — Run the MPS tests.
  https://github.com/JetBrains/MPS/blob/<commit>/.agents/skills/mps-tests/SKILL.md
  also in .claude/skills/mps-tests/SKILL.md
…
JetBrains/kotlin · 6 skills
…
```
- The summary: the skills, the repositories with skills *of* those scanned, and the skipped ones by kind (none skipped → no parentheses)
- Then the repositories **with skills only**, sorted by name, each as a single repository is printed
- No skills in any repository → the summary, then
  `Skills count only as <root>/<name>/SKILL.md under .agents/skills, .claude/skills or .github/skills`; exit code 0
- Warnings start with the repository: `warning: JetBrains/kotlin: <warning>`; a repository that fails: `warning: <owner>/<repo>: <message>; skipped`
