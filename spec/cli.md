# Command line
`./skill-atlas scan <GitHub URL | directory> [--filter "<words>"]`; `./skill-atlas serve`: the [web view](web.md)
A GitHub URL scans the default branch; `…/tree/<commit or branch>` scans that one.
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
## Filter
`./skill-atlas scan <GitHub URL | directory> --filter "<words>"`: only the skills you need, in a large repository
- **Words**: the filter is split on whitespace; each word matches *case-insensitively*, as a substring
- A skill matches when **every** word appears in its **name**, **description** (the full one, not just the first sentence)
  or **path**, its copies' paths included. The words can match in different fields
  (`gradle bump` matches `build-tools-bump-gradle-api`)
- Order and output are unchanged; only matching skills are printed
- The header shows the match: `JetBrains/kotlin · 2 of 6 skills match "gradle bump"`;
  the words as typed, one space between them; `skill` when the repository has one
- **No match** → `No skills match "<words>"` instead of the header, exit code **0**. Warnings still go to *stderr*
- **Empty or blank filter** (`--filter ""`) → the same as no filter
- `--filter` may come before or after the input
- `--filter` without a value, or given twice → `Usage: skill-atlas scan <GitHub URL | directory> [--filter "<words>"]`, exit code 1
- Out of scope: OR, quoted phrases, regular expressions, fuzzy matching
- The same rules in the [web view](web.md): one module, `src/core/filter.js`, for both
