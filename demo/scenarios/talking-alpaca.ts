// The alpaca speaks (spec/web.md, "Look"): the idle alpaca is a button; each click, a dad joke in a speech bubble,
// never the same twice in a row; gone after 5 s or on a click elsewhere. The crest stays a link home.
import type { Demo } from '../record.ts';

export default async function talkingAlpaca({ page, caption, pause, click }: Demo) {
  const speaker = page.locator('button.speaker');
  const bubble = page.locator('.bubble');
  const says = async (before = '') => {
    await page.waitForFunction((old) => { const text = document.querySelector('.bubble')?.textContent ?? ''; return text !== '' && text !== old; }, before);
    return (await bubble.textContent()) ?? '';
  };

  await caption('Skill Atlas: the alpaca speaks', 'Click the alpaca, waiting impeccably dressed on the start page');
  await pause(2600);

  await click(speaker);
  let joke = await says();
  await caption('A dad joke, in a speech bubble', 'Picked at random; the alpaca wobbles as it speaks');
  await pause(3200);

  await click(speaker);
  joke = await says(joke);
  await caption('Another click, another joke', 'Never the same one twice in a row');
  await pause(3000);

  await speaker.focus();
  await page.keyboard.press('Enter');
  joke = await says(joke);
  await caption('A real button', 'Enter or Space from the keyboard; screen readers announce the joke');
  await pause(3600);

  await caption('Gone after 5 seconds', 'Or on a click anywhere else');
  await page.waitForFunction(() => document.querySelector('.bubble')?.textContent === '', undefined, { timeout: 8000 });
  await pause(1600);

  await click(speaker);
  await says();
  await pause(1600);
  await click(page.locator('.idle .state-title'));
  await page.waitForFunction(() => document.querySelector('.bubble')?.textContent === '');
  await caption('A click elsewhere: the bubble goes', 'The crest by the name stays a plain link home');
  await pause(3000);
  await caption('', '');
}
