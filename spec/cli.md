# Command line
`./skill-atlas scan <GitHub URL | directory>`; `./skill-atlas serve`: the [web view](web.md)
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
