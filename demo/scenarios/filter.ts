// The filter (spec/cli.md#filter, spec/web.md): words, every word in the name, the full description or a path,
// in the address, no match; then the same rules in the CLI.
import type { Demo } from '../record.ts';

export default async function filter({ page, repo, caption, pause, type, clear, click, terminal }: Demo) {
  // Chance pinned, so the video comes out the same every time: 0.5 is no refusal (under 0.9) and no comment (over 1/3).
  await page.addInitScript(() => {
    Math.random = () => 0.5;
  });
  await page.reload();
  await caption('Skill Atlas: filtering skills', 'Every SKILL.md in a repository — and only the ones you need');
  await pause(2200);

  const input = page.locator('#input');
  await caption('Scan a repository', 'A GitHub URL or, here, a local directory');
  await type(input, repo);
  await pause(400);
  await click(page.locator('#scan-button'));
  await page.locator('table.skills').waitFor();
  await caption('11 skills', 'Too many to skim in a large repository');
  await pause(2500);

  const field = page.locator('#filter');
  await caption('Type a word', 'Matches the name, the full description or the path — in any case');
  await click(field);
  await type(field, 'kotlin');
  await pause(2800);

  await caption('Every word must match', '“gradle test”: the words can match in different fields');
  await clear(field);
  await type(field, 'gradle test');
  await pause(3200);

  await caption('Paths count too', '“.github”: the skills in the .github/skills folder');
  await clear(field);
  await type(field, '.github');
  await pause(2800);

  await caption('The filter is in the address', 'Share the link or reload: the same filtered scan');
  await clear(field);
  await type(field, 'review');
  await pause(1800);
  await page.goto(page.url());
  await page.locator('table.skills').waitFor();
  await caption('Reloaded — still filtered', `&filter=review`);
  await pause(2800);

  await caption('No match?', 'It says so, with a way to clear the filter');
  await clear(field);
  await type(field, 'kubernetes deploy');
  await pause(2200);
  await click(page.locator('.no-match button'));
  await caption('Cleared: all 11 skills again');
  await pause(2400);

  await terminal(['scan', 'demo/repo', '--filter', 'gradle test']);
  await caption('The same rules in the CLI', './skill-atlas scan <repository> --filter "<words>"');
  await pause(4500);
  await caption('', '');
}
