// The alpaca sometimes refuses (spec/web.md, "Look"): a scan and a filter refused, each with a phrase; asking again
// goes through; a scan from the address is never refused. About 1 in 10: for the video, chance is pinned so the alpaca
// refuses on cue, and no comment gets in the way.
import type { Demo } from '../record.ts';

export default async function alpacaRefuses({ page, repo, caption, pause, type, clear, click }: Demo) {
  // A roll queued in window.demoRolls goes first; else 0.5: no refusal (under 0.9), no comment (over 1/3).
  await page.addInitScript(() => {
    const rolls: number[] = ((window as unknown as { demoRolls: number[] }).demoRolls = []);
    Math.random = () => rolls.shift() ?? 0.5;
  });
  await page.reload();
  // A refusal on the next action: the roll that refuses, then its category and its phrase (the first one).
  const refuseNext = () => page.evaluate(() => (window as unknown as { demoRolls: number[] }).demoRolls.push(0.95, 0, 0));
  const says = () => page.waitForFunction(() => (document.querySelector('.comment')?.textContent ?? '') !== '', undefined, { timeout: 5000 });

  await caption('Skill Atlas: the alpaca has a will of its own', 'Now and then it refuses a scan or a filter, and says why');
  await pause(3200);
  await caption('In this video it refuses on cue', 'Normally about 1 in 10 scans or filters');
  await pause(3000);

  const input = page.locator('#input');
  await type(input, repo);
  await refuseNext();
  await click(page.locator('#scan-button'));
  await says();
  await caption('A scan, refused', 'Nothing is asked of the server; the page and the address stay as they were');
  await pause(4200);

  await click(page.locator('#scan-button'));
  await page.locator('#filter').waitFor();
  await caption('Ask again: it goes through', 'It never refuses the same action twice in a row');
  await pause(3600);

  const filter = page.locator('#filter');
  await click(filter);
  await refuseNext();
  await type(filter, 'gradle');
  await says();
  await caption('A filter, refused once you stop typing', 'The rows and the address go back; your words stay in the field');
  await pause(4400);

  await clear(filter);
  await type(filter, 'gradle');
  await page.waitForURL(/filter=gradle/);
  await pause(1000); // typing has stopped: past the alpaca's 800 ms
  await caption('Typed again: it filters', 'The second try always works');
  await pause(3400);

  await page.reload();
  await page.locator('#filter').waitFor();
  await caption('A shared link always opens', 'A scan from the address — a reload, back and forward — is never refused');
  await pause(3800);

  await caption('Web view only', 'The CLI never refuses');
  await pause(2600);
  await caption('', '');
}
