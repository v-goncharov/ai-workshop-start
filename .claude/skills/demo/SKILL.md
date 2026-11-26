---
name: demo
description: Record a video demo of a Skill Atlas feature — a scenario that drives the web view (and the CLI if it matters), an MP4 and a GIF, checked frame by frame, published for a pull request. Use when asked to record, demo, showcase or make a video of a feature, and for every PR with a user-visible change (the implement skill asks for one).
---

# Demo

Turn a feature into a short captioned video that shows the feature working, in four phases, in order. The tooling is in [demo/](../../../demo/README.md). Read its README first.

## 1. Plan
- Read the feature's cases in [spec/](../../../spec/). The demo shows the cases a user would try: the main one, one or two variations, and what happens when there is no result or an error. It doesn't show every edge case; the tests cover those.
- Write one caption per step: a short title ("Every word must match") and an optional line with the detail. The captions say what the feature does, not what the mouse does.
- Use the web view for anything it shows. Add a `terminal([...])` scene when the feature is in the CLI too, or only in the CLI.
- Aim for 30–60 seconds: about 2–3 s per step, longer when the step has more text to read.

## 2. Scenario
- One file per feature: `demo/scenarios/<feature>.ts`, exporting `async (demo: Demo) => …`. Copy [filter.ts](../../../demo/scenarios/filter.ts) as a starting point. The helpers are on the `Demo` interface in [record.ts](../../../demo/record.ts): `caption`, `type`, `clear`, `click` (it flashes the target, since the video shows no mouse pointer), `pause`, `terminal`, and Playwright's `page`.
- Scan [demo/repo/](../../../demo/repo/), a local repository, so the video needs no network and comes out the same every time. If the feature needs data it doesn't have, add skills there. Then update every scenario whose captions count or name skills (`filter.ts` says "11 skills"), and re-record those scenarios.
- Pin chance in any scenario that scans or filters: the alpaca's comments and refusals roll `Math.random`, and a refused scan or filter breaks the video. Start with `page.addInitScript(() => { Math.random = () => 0.5; })` and `page.reload()` (0.5: no refusal, no comment), as `filter.ts` does; queue other rolls when the feature needs them, as `alpaca-refuses.ts` does.
- Wait for what the feature produces (`locator.waitFor()`) before each caption about it, not for a fixed time.
- Don't change the app for the demo. A problem the demo exposes is a bug: fix it in the PR, with a test.

## 3. Record and check
- `npm run demo -- <feature>` → `demo/out/<feature>.mp4` and `.gif`. It needs `ffmpeg` and a browser: Playwright's Chromium, or else the installed Google Chrome (`google-chrome --version`). If neither is installed, install Chrome from Google's `.deb`.
- Watch the result before you share it. Take a frame at each step and look at them:
  `ffmpeg -loglevel error -ss <s> -i demo/out/<feature>.mp4 -frames:v 1 -vf scale=640:-1 /tmp/frame-<s>.png`
  Check that each caption matches what is on screen, nothing is cut off or hidden behind a caption, and the numbers are right. Fix the scenario and record again until they are.

## 4. Publish
- Commit the scenario, and any change to `demo/repo/`, with the feature. Never commit `demo/out/`.
- For a PR, run `demo/publish.sh <PR branch> demo/out/<feature>.gif demo/out/<feature>.mp4` after the branch is pushed. It puts the files on the `demos` branch of the remote you push PRs to (`fork` if there is one, else `origin`), which has no history in common with `main`, and prints a `## Demo` section: the GIF inline and a link to the MP4. Paste it into the PR description as printed.
- Outside a PR, give the user the path of the MP4 and copy it to `$AIR_ARTIFACTS_DIR` when that variable is set.
