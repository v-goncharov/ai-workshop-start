// The crest alpaca comments (spec/web.md, "Look"): a scan started and finished, the filter (a match, no match,
// cleared), clicks (a full description, copies, the empty page). About 1 in 3 actions, at least 10 s apart: for the
// video, chance is pinned so every action gets a comment, and the clock skips the 10 s wait between two of them.
import type { Demo } from '../record.ts';

export default async function alpacaComments({ page, repo, caption, pause, type, clear, click }: Demo) {
  // Every roll under 1/3: chance always says yes; the phrase still varies. A roll queued in window.demoRolls goes first.
  await page.addInitScript(() => {
    let seed = 7;
    const rolls: number[] = ((window as unknown as { demoRolls: number[] }).demoRolls = []);
    Math.random = () => rolls.shift() ?? ((seed = (seed * 16807) % 2147483647) / 2147483647) / 3;
  });
  await page.clock.install();
  await page.reload();
  const bubble = page.locator('.comment');
  const says = async () => {
    await page.waitForFunction(() => (document.querySelector('.comment')?.textContent ?? '') !== '', undefined, { timeout: 5000 });
    return (await bubble.textContent()) ?? '';
  };
  // The 10 s between two comments, skipped; the bubble has gone by then.
  const later = async () => {
    await page.clock.fastForward(10_000);
    await page.waitForFunction(() => document.querySelector('.comment')?.textContent === '');
  };

  await caption('Skill Atlas: the alpaca comments', 'The crest by the name says something about what you do, now and then');
  await pause(3000);
  await caption('In this video every action gets a comment', 'Normally about 1 in 3, at least 10 s apart; here the 10 s are skipped');
  await pause(3600);

  const input = page.locator('#input');
  await type(input, repo);
  await click(page.locator('#scan-button'));
  await page.locator('#filter').waitFor();
  await says();
  await caption('A scan started', 'A GitHub URL or, here, a local directory');
  await pause(3400);

  await later();
  await page.evaluate(() => (window as unknown as { demoRolls: number[] }).demoRolls.push(0.9)); // no comment on the start this time
  await click(page.locator('#scan-button'));
  await says();
  await caption('A scan finished', 'Many skills, few, a slow scan or, here, a fast one');
  await pause(3400);

  await later();
  const filter = page.locator('#filter');
  await click(filter);
  await type(filter, 'gradle');
  await says();
  await caption('The filter, once you stop typing', 'What you typed, quoted: as text, shortened');
  await pause(3400);

  await later();
  await clear(filter);
  await type(filter, 'llama');
  await says();
  await caption('No match', 'It has its opinions');
  await pause(3200);

  // Within the 10 s: no comment on these words; they bring run-tests to the top.
  await clear(filter);
  await type(filter, 'run-tests');
  await pause(1200);

  await later();
  const runTests = page.locator('tr', { has: page.locator('td.name', { hasText: 'run-tests' }) });
  await click(runTests.locator('summary'));
  await says();
  await caption('Clicks: a full description', 'Or a skill’s file');
  await pause(3400);

  await later();
  await click(runTests.locator('.copies'));
  await says();
  await caption('A skill’s copies', 'With the skill’s name');
  await pause(3200);

  await later();
  await clear(filter);
  await says();
  await caption('The filter cleared', 'Every skill again');
  await pause(3000);

  await later();
  await click(page.locator('.summary h1'));
  await says();
  await caption('A click on the empty page', 'The bubble goes after 5 s; it never takes focus or blocks a click');
  await pause(3800);

  await caption('Over 150 lines, never the same twice in a row', 'Web view only; the idle alpaca still tells its jokes');
  await pause(3200);
  await caption('', '');
}
