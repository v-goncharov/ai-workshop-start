# Command line
`./skill-atlas scan <GitHub URL | owner URL | directory> [--filter "<words>"] [--map]`; `./skill-atlas serve`: the [web view](web.md)
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
## Filter
`./skill-atlas scan <GitHub URL | owner URL | directory> --filter "<words>"`: only the skills you need, in a large repository
- **Words**: the filter is split on whitespace; each word matches *case-insensitively*, as a substring
- A skill matches when **every** word appears in its **name**, **description** (the full one, not just the first sentence)
  or **path**, its copies' paths included. The words can match in different fields
  (`gradle bump` matches `build-tools-bump-gradle-api`)
- Order and output are unchanged; only matching skills are printed
- The header shows the match: `JetBrains/kotlin · 2 of 6 skills match "gradle bump"`;
  the words as typed, one space between them; `skill` when the repository has one
- **No match** → `No skills match "<words>"` instead of the header, exit code **0**. Warnings still go to *stderr*
- **An owner**: the summary line is unchanged; then only the repositories with a match, each with its own header
  (`JetBrains/kotlin · 2 of 6 skills match "gradle bump"`). No match in any repository → the summary, then `No skills match "<words>"`.
  No skills at all → the same as without a filter
- **Empty or blank filter** (`--filter ""`) → the same as no filter
- `--filter` may come before or after the input
- `--filter` without a value, or given twice → `Usage: skill-atlas scan <GitHub URL | directory> [--filter "<words>"] [--map]`, exit code 1
- Out of scope: OR, quoted phrases, regular expressions, fuzzy matching
- The same rules in the [web view](web.md): one module, `src/core/filter.js`, for both
## Skill map
`./skill-atlas scan <GitHub URL | owner URL | directory> --map`: the skills grouped by Claude, [the skill map](map.md)
```
JetBrains/kotlin · 6 skills in 2 groups
## Build · 4 skills
build-tools-bump-gradle-api — Bumps the Gradle API…
  https://github.com/JetBrains/kotlin/blob/<commit>/…
…
## Other · 2 skills
…
```
- The header: `<repository> · N skills in G groups` (`group` when there is one); then each group, `## <name> · N skills`,
  and its skills printed as without `--map`, in the [map's order](map.md#grouping)
- **An owner**: the summary line, unchanged; then `N skills in G groups`; then the groups, each skill's line starting with its repository:
  `JetBrains/MPS: mps-tests — Run the MPS tests.`
- **With `--filter`**: the filtered header (`JetBrains/kotlin · 2 of 6 skills in 1 of 2 groups match "gradle bump"`;
  an owner: `2 of 51 skills in 1 of 9 groups match "gradle bump"` below the summary), then only the groups with a match,
  each `## <name> · N skills` counting the matches. No match → as without `--map`, Claude not asked
- **No skills** → as without `--map`, Claude not asked
- **Claude fails** ([the failures](map.md#failures)) → the skills as without `--map`, then `warning: no skill map: <message>` on *stderr*, exit code **0**
- `--map` takes no value; before or after the input, with or without `--filter`. Given twice → the usage above, exit code 1
