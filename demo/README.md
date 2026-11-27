# demo

Feature demos, recorded as videos: `npm run demo -- <scenario>` → `demo/out/<scenario>.mp4` and `.gif` (not committed).
Every PR with a UI change has one; how to make it: the [demo skill](../.claude/skills/demo/SKILL.md).

| Scenario | Shows |
| --- | --- |
| [`filter`](scenarios/filter.ts) | the [filter](../spec/cli.md#filter): one word, every word, a path, the address, no match; then the CLI |
| [`alpaca-comments`](scenarios/alpaca-comments.ts) | the [crest alpaca comments](../spec/web.md#look): a scan started and finished, the filter (a match, no match, cleared), clicks |
| [`alpaca-visitor`](scenarios/alpaca-visitor.ts) | the [visitor](../spec/web.md#look): scrolled past the crest, a comment brings the alpaca on screen; it leaves with the comment, or as the crest comes back; reduced motion |
| [`alpaca-refuses`](scenarios/alpaca-refuses.ts) | the [alpaca sometimes refuses](../spec/web.md#look): a scan and a filter refused, each with a phrase; asking again goes through; a shared link always opens |
| [`skill-map`](scenarios/skill-map.ts) | the [skill map](../spec/map.md): the Map view, its cards, the filter on it, the address, Claude failing and *Try again*; then `--map` in the CLI. Recorded with the fake `claude` (see the scenario's first lines) |
| [`talking-alpaca`](scenarios/talking-alpaca.ts) | the [alpaca speaks](../spec/web.md#look): a joke per click, from 38, from the keyboard too; the bubble goes after 5 s or on a click elsewhere |

- [`record.ts`](record.ts) starts `./skill-atlas serve` on a free port, drives the web view in a browser with
  Playwright, puts captions and the page's address on top, and encodes the frames with `ffmpeg`, 1280×800, 25 fps.
- [`repo/`](repo/) is the scanned repository: 11 skills in the three folders, one with a copy. Local, so a recording
  needs no network and comes out the same every time.
- Needs `ffmpeg` on the `PATH` and a browser: Playwright's Chromium (`npx playwright install chromium`), or else
  the installed Google Chrome.
- [`publish.sh`](publish.sh) `<PR branch> <file>…` puts the videos on the `demos` branch, which has no history in common
  with `main`, and prints the PR's `## Demo` section: the GIF inline, the MP4 linked (GitHub has no API to attach a video).
- A new demo: a file in `scenarios/` that exports `async ({ page, caption, type, click, terminal, … }) => …`;
  see the `Demo` interface in `record.ts`.
