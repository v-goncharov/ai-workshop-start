// The visitor (spec/web.md, "Look"): with the crest scrolled out of view, a comment brings the alpaca on screen, peeking
// in from the bottom-left corner with the bubble beside it; it goes with the comment, or when the crest comes back into
// view; under reduced motion it appears without sliding. As in alpaca-comments, chance is pinned so every action gets a
// comment, and the clock skips the 10 s between two of them.
import type { Demo } from '../record.ts';

export default async function alpacaVisitor({ page, repo, caption, pause, type, click }: Demo) {
  await page.addInitScript(() => {
    let seed = 11;
    Math.random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) / 3;
  });
  await page.clock.install();
  await page.reload();
  const says = () => page.waitForFunction(() => (document.querySelector('.comment')?.textContent ?? '') !== '', undefined, { timeout: 5000 });
  const quiet = () => page.waitForFunction(() => document.querySelector('.comment')?.textContent === '', undefined, { timeout: 8000 });
  // The 10 s between two comments, skipped; the bubble has gone by then.
  const later = async () => {
    await page.clock.fastForward(10_000);
    await quiet();
  };
  const scrollTo = async (top: number) => {
    await page.evaluate((top) => window.scrollTo({ top, behavior: 'smooth' }), top);
    await page.waitForFunction((top) => Math.abs(window.scrollY - Math.min(top, document.documentElement.scrollHeight - innerHeight)) < 2, top);
  };
  const row = (name: string) => page.locator('tr', { has: page.locator('td.name', { hasText: name }) });

  await caption('Skill Atlas: the alpaca comes on screen', 'When you are scrolled past the crest, it brings itself along');
  await pause(3200);

  await type(page.locator('#input'), repo);
  await click(page.locator('#scan-button'));
  await page.locator('#filter').waitFor();
  await says();
  await caption('The crest in view', 'The comment below it, as before');
  await pause(3400);

  await later();
  await caption('', '');
  await scrollTo(10_000);
  await pause(800);
  await click(row('run-tests').locator('summary'));
  await says();
  await page.locator('.visitor.here').waitFor();
  await caption('Scrolled past it: a visitor', 'Peeking in from the corner, the bubble beside it');
  await pause(3600);

  await caption('It leaves with the comment', 'After 5 s; it lets clicks through and takes no focus');
  await quiet();
  await pause(1800);

  await later();
  await caption('', '');
  await click(row('run-tests').locator('.copies'));
  await says();
  await pause(1600);
  await caption('Scroll back up while it speaks', 'The visitor goes; the comment carries on at the crest');
  await scrollTo(0);
  await pause(3200);

  await later();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await caption('', '');
  await scrollTo(10_000);
  await pause(600);
  await click(page.locator('.colophon p'));
  await says();
  await caption('Under reduced motion', 'It appears and goes without sliding');
  await pause(3400);
  await quiet();
  await pause(1200);

  await caption('Web view only', 'Still about 1 in 3 actions, at least 10 s apart');
  await pause(2800);
  await caption('', '');
}
