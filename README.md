# Skill Atlas

Every agent skill in a repository: `./skill-atlas scan` finds each `SKILL.md` and prints its name,
description and link.

```console
$ npm ci
$ ./skill-atlas scan https://github.com/JetBrains/kotlin
JetBrains/kotlin · 6 skills
…
build-tools-bump-gradle-api — Bumps the Gradle API version that Kotlin Gradle plugins are compiled against in the Kotlin compiler repository.
  https://github.com/JetBrains/kotlin/blob/5ab6270ab772d113e8ad52ebfcaa0109c522ae00/.claude/skills/build-tools-bump-gradle-api/SKILL.md
…
```

Every repository of an organization or user at once: `./skill-atlas scan https://github.com/JetBrains`. It skips
forks, archived and empty repositories and prints only the repositories with skills, under one summary line.

`--filter "<words>"` keeps only the skills with every word in the name, description or path,
in any case: `./skill-atlas scan https://github.com/JetBrains/kotlin --filter "gradle bump"`.

The same scan in the browser: `./skill-atlas serve` starts the web view at http://127.0.0.1:4400
(`--port <n>` for another port). Paste a GitHub URL or a local directory; `?input=` keeps it in the
address, so a scan can be shared and reloaded; the page's filter follows the CLI's rules and goes in
the address too, `&filter=`.

Set `GITHUB_TOKEN` for a higher GitHub rate limit (an organization needs a few requests per repository) and private repositories. `npm test` runs the tests.

- [spec/](spec/): what it does; [spec/web.md](spec/web.md): the web view. [AGENTS.md](AGENTS.md): the definition of done.
- [fixture/](fixture/README.md): a small repository for the tests.
- [demo/](demo/README.md): feature demos as videos, `npm run demo -- filter`.
