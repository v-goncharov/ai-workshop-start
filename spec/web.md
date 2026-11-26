# Web view
`./skill-atlas serve [--port <n>]` serves the same scan in the browser, at `http://127.0.0.1:4400` by default.
It listens on *127.0.0.1 only*: the page can scan local directories.
Against DNS rebinding, it answers only `Host: 127.0.0.1:<port>` or `localhost:<port>`; anything else → `403`.
A scan asked for by another site (`Sec-Fetch-Site` neither `same-origin` nor `none`) → `403`.
`GITHUB_TOKEN` and local directories work as they do in the CLI. *Nothing is stored*; every scan reads the repository again.
## Page
- One field, **Repository**: a GitHub URL (`…/tree/<ref>` too), an owner URL (`https://github.com/<owner>`) or a directory; `?input=<it>` in the address, so a scan can be shared and reloaded
- The repository, the skill count, the *scanned commit* (or "local directory") and how long it took
- A table, in the CLI's order: **name**, the description's *first sentence* (the full one on request), the **file**
  linked to the scanned commit, and its *copies*. Local files: the path, not a link (browsers do not open `file://` from a page)
- A filter, by the [CLI's rules](cli.md#filter): words, *every* word in the name, the *full* description or a path (copies' too)
- The filter goes in the address, `?input=<it>&filter=<words>`, so a filtered scan can be shared and reloaded;
  clearing it removes `filter`. Typing replaces the address, it adds no history entry. A new scan starts unfiltered
- "Showing N of M skills" while a filter is set
- An **owner**: the CLI's summary (skills, repositories with skills of those scanned, the skipped ones) and how long it took,
  then one table per repository with skills, in the CLI's order, each headed by the repository, its skill count and commit.
  The filter works across all of them; a repository with no match is hidden, and "Showing N of M skills" counts them all
## States
- **Idle**: what is scanned, and one example
- **Empty field** → "Enter a GitHub URL or a directory path.", no request
- **Loading**: skeleton rows in the table's layout
- **Error**: the CLI's message and what to do next (rate limit → `GITHUB_TOKEN`); *Scan again*
- **No skills** (in a repository, or in all of an owner's): which folders count
- **Warnings**: listed above the table, as the CLI prints them to stderr
- **No filter match**: "No skills match “<words>”", with a way to clear the filter
## API
`GET /api/scan?input=<GitHub URL | directory>` → `200` `{ repository, skills, warnings }`;
each skill: `name`, `path`, `summary` (the first sentence), `description`, `link`, `copies`.
An owner URL → `200` `{ owner, repositories, skipped, warnings }`: `owner` is `{ id, url, scanned }`
(`scanned`: how many repositories were scanned); `repositories`, those with skills only, sorted by name, each `{ repository, skills }` as above;
`skipped` is `{ forks, archived, empty }`; `warnings` as the CLI prints them, without `warning: `.
- No input, or the CLI's error (unreachable repository, rate limit…) → `400` `{ error }`, the CLI's message
- An unexpected failure → `500` `{ error }`, a short message; the details go to the server's stderr
- `/filter.js`: the CLI's filter module, `src/core/filter.js`, as the page loads it
- Anything else → `404`; anything but `GET` → `405`
## Command line
- `--port 0`: any free port; it prints the address
- A port in use → a clear message, exit code 1
