# Web view
`./skill-atlas serve [--port <n>]` serves the same scan in the browser, at `http://127.0.0.1:4400` by default.
It listens on *127.0.0.1 only*: the page can scan local directories.
Against DNS rebinding, it answers only `Host: 127.0.0.1:<port>` or `localhost:<port>`; anything else → `403`.
A scan asked for by another site (`Sec-Fetch-Site` neither `same-origin` nor `none`) → `403`.
`GITHUB_TOKEN` and local directories work as they do in the CLI. *Nothing is stored*; every scan reads the repository again.
## Page
- One field, **Repository**: a GitHub URL (`…/tree/<ref>` too), an owner URL (`https://github.com/<owner>`) or a directory; `?input=<it>` in the address, so a scan can be shared and reloaded
- The repository, the skill count, the *scanned commit* (or "local directory") and how long it took ("the alpaca was back in …")
- A table, in the CLI's order: **name**, the description's *first sentence* (the full one on request), the **file**
  linked to the scanned commit, and its *copies*. Local files: the path, not a link (browsers do not open `file://` from a page)
- A filter, by the [CLI's rules](cli.md#filter): words, *every* word in the name, the *full* description or a path (copies' too)
- The filter goes in the address, `?input=<it>&filter=<words>`, so a filtered scan can be shared and reloaded;
  clearing it removes `filter`. Typing replaces the address, it adds no history entry. A new scan starts unfiltered
- "Showing N of M skills" while a filter is set
- An **owner**: the CLI's summary (skills, repositories with skills of those scanned, the skipped ones) and how long it took,
  then one table per repository with skills, in the CLI's order, each headed by the repository, its skill count and commit.
  The filter works across all of them; a repository with no match is hidden, and "Showing N of M skills" counts them all
## Look
Alpacas, and fancy: fleece cream, terracotta, indigo and gold (light and dark), serif headings, a woven band above and below the page.
- *The alpaca* (top hat, monocle, bow tie) is the crest by the name, the idle state's picture, and stands by an error and by "No skills"
- A second one *trots along an owner's progress bar*: back and forth while listing, at d of n while scanning, standing still during a wait
- Both are drawn once in the page (`<symbol id="alpaca">`, `<symbol id="alpaca-trot">`) and coloured by `style.css`: no inline styles, no images to fetch
- *The idle alpaca speaks*: it is a real button, "Ask the alpaca for a joke". A click (tap, Enter, Space) shows an alpaca dad joke
  in a speech bubble beside it, picked at random from the pre-written ones in `jokes.js` (*at least 38*, no two alike, each at most 80 characters
  so the bubble stays a few lines), *never the same one twice in a row*; the alpaca wobbles.
  Another click on it, another joke. The bubble goes after 5 s, or on a click anywhere else.
  The bubble is an `aria-live="polite"` region, so screen readers announce the joke. No wobble under `prefers-reduced-motion`
- The crest stays a plain link home (a click on it is no joke and no comment)
- *The crest alpaca comments* on what the user does, in every state: the same speech bubble, beside the crest, `aria-live="polite"`.
  Each action has a *1 in 3 chance* of a comment, and at least *10 s* go by between two comments; a skipped action doesn't count.
  The bubble is below the crest, its tail pointing up at it, while the crest is in view.
  A comment replaces the one shown; it goes after 5 s (a click elsewhere leaves it); the crest wobbles, not under `prefers-reduced-motion`.
  - *The visitor*: when the crest is *out of view* (scrolled past it, or more than half of it) as a comment starts, the same fancy
    alpaca, at the crest's size, *peeks in from the bottom-left corner* of the window, away from the filter and the table's links,
    with the bubble beside it, its tail pointing at the visitor. It goes with the comment, after 5 s;
    a new comment while it is there replaces the text, and the visitor stays
  - *Scrolling while it speaks*: the crest back in view → the visitor goes and the comment carries on below the crest, until its 5 s are up;
    the crest out of view again → the visitor comes back
  - The visitor is `aria-hidden` and takes no focus; clicks go through it, as through the bubble. The comment is announced once, by the bubble
  - It slides up into view and back down; under `prefers-reduced-motion` it appears and goes without moving
  - At phone width it fits, the bubble beside it inside the window
  It never takes focus, and the bubble lets clicks through. The lines are pre-written, in `phrases.js`: *at least 150*,
  at least 10 per category, *never the same one twice in a row*. A line may quote what the user did, shortened to 30 characters with `…`,
  always as text, never markup. The categories:
  - **Scan started**: a GitHub URL (`{input}`, repository or owner), or a directory (`{input}`)
  - **Scan finished** (repository or owner, `{skills}`, `{time}`): *many* (20 skills or more), *few* (1 to 3), *slow* (10 s or more),
    *fast* (under 1 s); when two apply, chance picks one; when none does, no comment
  - **No skills** (`{input}`); **scan error** (`{input}`), as the page shows them
  - **Filter**, once typing stops for 800 ms (not on every key): *a match* (`{text}` in quotes, `{skills}` shown), *no match* (`{text}`),
    *cleared* (it had words, now none). Words unchanged since the last time, or the filter from the address → nothing
  - **Clicks**: a skill's file link (`{name}`), opening a *Full description* (`{name}`), a skill's copies, "Also in …" (`{name}`),
    and *the empty page*: a click on nothing that does anything (not a link, button, field, label, summary, the table or a bubble)
- Not in the CLI
- The copy speaks of the alpaca (it is sent out, grazes, comes back); the texts quoted below stay as they are. No motion under `prefers-reduced-motion`
## States
- **Idle**: the alpaca (it speaks, see [Look](#look)), what is scanned, and one example
- **Empty field** → "Enter a GitHub URL or a directory path.", no request
- **Loading**: skeleton rows in the table's layout. An **owner**'s scan takes minutes, so above them a *progress bar* and what it does:
  `Listing the repositories… (page <n>)` (the bar moving, no end known), `Scanned <d> of <n> repositories` (the bar at d of n),
  `GitHub asked to slow down: going on in <s> s`, counting down each second, the bar where it was
- **Error**: the CLI's message and what to do next (rate limit without a token → restart with `GITHUB_TOKEN`;
  with one, the message says when to try again → wait); *Scan again*
- **No skills** (in a repository, or in all of an owner's): which folders count
- **Warnings**: listed above the table, as the CLI prints them to stderr
- **No filter match**: "No skills match “<words>”", with a way to clear the filter
## API
`GET /api/scan?input=<GitHub URL | directory>` → `200` `{ repository, skills, warnings }`;
each skill: `name`, `path`, `summary` (the first sentence), `description`, `link`, `copies`.
An owner URL → `200` `{ owner, repositories, skipped, warnings }`: `owner` is `{ id, url, scanned }`
(`scanned`: how many repositories were scanned); `repositories`, those with skills only, sorted by name, each `{ repository, skills }` as above;
`skipped` is `{ forks, archived, empty }`; `warnings` as the CLI prints them, without `warning: `.
- An owner URL with `Accept: application/x-ndjson` (the page asks so) → `200` `application/x-ndjson`, one JSON object per line
  as the scan goes: `{ progress }`, where `progress` is `{ stage: "listing", page }`, `{ stage: "scanning", done, total }` (once with `done` 0,
  then after each repository; `total` without forks and archived ones) or `{ stage: "waiting", seconds }` (GitHub's [secondary rate limit](analysis.md#details));
  then the last line, `{ result }` (the owner's answer above) or `{ error }` (the CLI's message, or the short one for an unexpected failure)
- No input, or the CLI's error (unreachable repository, rate limit…) → `400` `{ error }`, the CLI's message
- An unexpected failure → `500` `{ error }`, a short message; the details go to the server's stderr
- `/filter.js`: the CLI's filter module, `src/core/filter.js`, as the page loads it
- `/phrases.js`: the alpaca's comments, `src/web/static/phrases.js`
- `/jokes.js`: the idle alpaca's jokes, `src/web/static/jokes.js`
- Anything else → `404`; anything but `GET` → `405`
## Command line
- `--port 0`: any free port; it prints the address
- A port in use → a clear message, exit code 1
