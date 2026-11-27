// The skill map (spec/map.md, spec/web.md "Map", spec/cli.md "Skill map"): the Map view beside the table, the filter on it,
// the address, Claude failing and Try again; then --map in the CLI.
//
// Claude is replayed, so the video needs no model and comes out the same every time: record it with the fake claude first
// on the PATH, answering from a file this scenario fills in (tests/recorded/demo-repo.txt, or a broken answer):
//   PATH="$PWD/tests/fake-claude:$PATH" FAKE_CLAUDE_ANSWER=/tmp/skill-map-answer.txt FAKE_CLAUDE_SLEEP=1 npm run demo -- skill-map
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Demo } from '../record.ts';

export default async function skillMap({ page, repo, root, caption, pause, type, clear, click, terminal }: Demo) {
  const answer = process.env.FAKE_CLAUDE_ANSWER;
  if (!answer) throw new Error('Record with the fake claude: see the comment at the top of demo/scenarios/skill-map.ts');
  const recorded = () => copyFileSync(join(root, 'tests', 'recorded', 'demo-repo.txt'), answer);
  recorded();

  // Chance pinned, so the video comes out the same every time: 0.5 is no refusal (under 0.9) and no comment (over 1/3).
  await page.addInitScript(() => {
    Math.random = () => 0.5;
  });
  await page.reload();
  await caption('Skill Atlas: the skill map', 'Dozens of skills, grouped by what they are about');
  await pause(2200);

  const input = page.locator('#input');
  await caption('Scan a repository', 'A GitHub URL, an owner or, here, a local directory');
  await type(input, repo);
  await pause(400);
  await click(page.locator('#scan-button'));
  await page.locator('table.skills').waitFor();
  await caption('11 skills in one long table', 'Hard to take in at a glance');
  await pause(2500);

  const map = page.locator('.views button', { hasText: 'Map' });
  await caption('Open the Map view', 'Beside the table: Table | Map');
  await click(map);
  await page.locator('.map-status').waitFor();
  await caption('Claude draws the map', 'claude -p with the latest Haiku: the names and descriptions go in, groups come back');
  await page.locator('section.group').first().waitFor();
  await pause(1200);
  await caption('One card per group', 'Named by Claude; every skill exactly once, the rest in Other');
  await pause(3000);
  await page.evaluate(() => window.scrollBy({ top: 460, behavior: 'smooth' }));
  await caption('Five groups for 11 skills', 'Testing & CI, Gradle & Dependencies, Kotlin Code, Docs & Releases, Other');
  await pause(3400);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await pause(600);

  const field = page.locator('#filter');
  await caption('The filter applies to the map', '“gradle”: only the matching skills, and only the cards that have one');
  await click(field);
  await type(field, 'gradle');
  await pause(3200);
  await clear(field);
  await pause(600);

  await caption('The view is in the address', '&view=map: share the link or reload, and the map is drawn again');
  await pause(1800);
  await page.goto(page.url());
  await page.locator('section.group').first().waitFor();
  await caption('Reloaded: the map again', 'Nothing is stored; Claude is asked once per scan');
  await pause(2600);

  await caption('Back to the table at any time');
  await click(page.locator('.views button', { hasText: 'Table' }));
  await pause(2200);

  // Claude answers something that is not a map.
  writeFileSync(answer, 'Sorry, I could not group these skills.\n');
  await page.goto(`${page.url()}&view=map`);
  await page.locator('.map-error').waitFor();
  await caption('Claude failed?', 'The Map view says why; the table still works');
  await pause(3200);
  recorded();
  await caption('Try again', 'Asks Claude once more');
  await click(page.locator('.map-error button', { hasText: 'Try again' }));
  await page.locator('section.group').first().waitFor();
  await pause(2400);

  await terminal(['scan', 'demo/repo', '--map', '--filter', 'gradle']);
  await caption('The same map in the CLI', './skill-atlas scan <repository> --map');
  await pause(5000);
  await caption('', '');
}
