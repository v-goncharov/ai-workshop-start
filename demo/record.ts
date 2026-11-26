// Records a feature demo as a video: `npm run demo -- <scenario>` → demo/out/<scenario>.mp4 and .gif.
// It starts `./skill-atlas serve` on a free port, drives the web view in Chrome with Playwright, with captions
// on top, and converts Playwright's WebM to MP4 with ffmpeg. Scenarios: demo/scenarios/<scenario>.ts.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Locator, type Page } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'demo', 'out');
const size = { width: 1280, height: 800 };

export interface Demo {
  page: Page;
  /** The web view's address, `http://127.0.0.1:<port>`. */
  base: string;
  /** The demo repository, `demo/repo`, as an absolute path. */
  repo: string;
  root: string;
  /** A caption at the bottom of the frame; '' hides it. */
  caption(title: string, detail?: string): Promise<void>;
  /** Waits, so the viewer can read. */
  pause(ms?: number): Promise<void>;
  /** Types like a person. */
  type(field: Locator, text: string): Promise<void>;
  /** Clears a field like a person: select all, delete. */
  clear(field: Locator): Promise<void>;
  /** Flashes the element, then clicks it: the recording shows no mouse pointer. */
  click(target: Locator): Promise<void>;
  /** A terminal: types `./skill-atlas <args>`, runs it for real in the checkout, and shows what it printed. */
  terminal(args: string[]): Promise<void>;
}

// Captions and the address strip, installed in every page the demo opens.
const overlay = () => {
  const install = () => {
    if (document.getElementById('demo-overlay')) return;
    const style = document.createElement('style');
    style.textContent = `
      #demo-address { position: fixed; top: 0; left: 0; right: 0; z-index: 99999; padding: 6px 14px;
        font: 13px ui-monospace, Menlo, monospace; background: #20232a; color: #c9d1d9; }
      #demo-address:empty { display: none; }
      #demo-address b { color: #79c0ff; font-weight: normal; }
      body { padding-top: 30px !important; }
      #demo-overlay { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 99999;
        max-width: 80%; padding: 14px 22px; border-radius: 12px; background: rgba(17, 20, 26, .88); color: #fff;
        font: 600 22px system-ui, sans-serif; text-align: center; box-shadow: 0 8px 30px rgba(0,0,0,.25);
        transition: opacity .3s; }
      #demo-overlay small { display: block; margin-top: 6px; font: 400 16px system-ui, sans-serif; color: #c9d1d9; }
      #demo-overlay[hidden] { display: block; opacity: 0; }
      .demo-flash { outline: 3px solid #f0883e !important; outline-offset: 3px; transition: outline .1s; }`;
    document.head.append(style);
    const address = document.createElement('div');
    address.id = 'demo-address';
    const caption = document.createElement('div');
    caption.id = 'demo-overlay';
    caption.hidden = true;
    document.body.append(address, caption);
    const render = () => {
      if (!location.protocol.startsWith('http')) return;
      const [path, query = ''] = (location.pathname + location.search).split('?');
      address.replaceChildren(`${location.host}${path}`, ...(query ? ['?', Object.assign(document.createElement('b'), { textContent: decodeURIComponent(query) })] : []));
    };
    render();
    setInterval(render, 100);
  };
  if (document.body) install(); else document.addEventListener('DOMContentLoaded', install);
};

function serve(): Promise<{ base: string; stop: () => void }> {
  return new Promise((done, fail) => {
    const server = spawn(process.execPath, [join(root, 'src', 'cli.ts'), 'serve', '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
    server.on('error', fail);
    server.stdout.setEncoding('utf8').on('data', (text: string) => {
      const address = /http:\/\/127\.0\.0\.1:\d+/.exec(text);
      if (address) done({ base: address[0], stop: () => server.kill() });
    });
  });
}

/**
 * Records the page into an MP4: Chrome's screencast sends a frame when the page changes; the latest one goes to
 * ffmpeg at a steady frame rate, so the video keeps real time. (Playwright's own recorder needs a download of its ffmpeg.)
 */
async function screencast(page: Page, mp4: string) {
  const fps = 25;
  const ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', mp4], { stdio: ['pipe', 'inherit', 'inherit'] });
  const finished = new Promise<void>((done, fail) => ffmpeg.on('close', (code) => code === 0 ? done() : fail(new Error(`ffmpeg exited with ${code}`))));
  const cdp = await page.context().newCDPSession(page);
  let latest: Buffer | undefined;
  cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
    latest = Buffer.from(data, 'base64');
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: size.width, maxHeight: size.height });
  const start = Date.now();
  let written = 0;
  const timer = setInterval(() => {
    // As many frames as the time says, so a slow tick does not shorten the video.
    for (const due = Math.floor((Date.now() - start) / 1000 * fps); latest && written < due; written++) ffmpeg.stdin.write(latest);
  }, 1000 / fps);
  return {
    async stop() {
      clearInterval(timer);
      await cdp.send('Page.stopScreencast').catch(() => {});
      ffmpeg.stdin.end();
      await finished;
    },
  };
}

async function record(scenario: string) {
  const { default: run } = await import(join(root, 'demo', 'scenarios', `${scenario}.ts`)) as { default: (demo: Demo) => Promise<void> };
  const { base, stop } = await serve();
  mkdirSync(out, { recursive: true });
  const mp4 = join(out, `${scenario}.mp4`);
  // Playwright's own Chromium (`npx playwright install chromium`), else the installed Google Chrome.
  const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
  try {
    // bypassCSP: the web view's Content-Security-Policy would block the captions' styles.
    const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, bypassCSP: true });
    await context.addInitScript(overlay);
    const page = await context.newPage();
    const recording = await screencast(page, mp4);
    const pause = (ms = 1200) => page.waitForTimeout(ms);
    const demo: Demo = {
      page, base, root, repo: join(root, 'demo', 'repo'), pause,
      async caption(title, detail) {
        await page.evaluate(([title, detail]) => {
          const caption = document.getElementById('demo-overlay')!;
          caption.hidden = !title;
          if (title) caption.replaceChildren(title, ...(detail ? [Object.assign(document.createElement('small'), { textContent: detail })] : []));
        }, [title, detail ?? ''] as const);
      },
      type: (field, text) => field.pressSequentially(text, { delay: 110 }),
      async clear(field) {
        await field.focus();
        await page.keyboard.press('ControlOrMeta+A');
        await pause(250);
        await page.keyboard.press('Backspace');
      },
      async click(target) {
        await target.evaluate((element) => element.classList.add('demo-flash'));
        await pause(500);
        await target.evaluate((element) => element.classList.remove('demo-flash'));
        await target.click();
      },
      async terminal(args) {
        const quote = (arg: string) => /^[\w./:-]+$/.test(arg) ? arg : `"${arg}"`;
        let printed: string;
        try {
          printed = execFileSync(join(root, 'skill-atlas'), args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
          printed = (error as { stdout?: string }).stdout ?? String(error);
        }
        if (!page.url().startsWith('about:')) await page.goto('about:blank');
        await page.setContent(`<style>
          body { margin: 0; background: #0d1117; color: #c9d1d9; font: 17px/1.5 ui-monospace, Menlo, monospace; }
          pre { margin: 0; padding: 28px 32px; white-space: pre-wrap; word-break: break-all; }
          .prompt { color: #7ee787; } .cursor { background: #c9d1d9; }</style>
          <pre id="screen"></pre>`);
        await page.evaluate(overlay);
        const screen = page.locator('#screen');
        const command = `./skill-atlas ${args.map(quote).join(' ')}`;
        for (let i = 0; i <= command.length; i++) {
          await screen.evaluate((pre, typed) => { pre.innerHTML = '<span class="prompt">$</span> '; pre.append(typed, Object.assign(document.createElement('span'), { className: 'cursor', textContent: ' ' })); }, command.slice(0, i));
          await pause(45);
        }
        await pause(500);
        await screen.evaluate((pre, [command, printed]) => {
          pre.innerHTML = '<span class="prompt">$</span> ';
          pre.append(`${command}\n${printed}`);
        }, [command, printed.replaceAll(`file://${root}/`, '')] as const);
      },
    };
    await page.goto(base);
    await run(demo);
    await pause(800);
    await recording.stop();
    // A GIF too: a PR description shows a GIF inline, an MP4 only as a link.
    const gif = mp4.replace(/\.mp4$/, '.gif');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vf',
      'fps=8,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none', gif]);
    console.log(mp4);
    console.log(gif);
  } finally {
    await browser.close();
    stop();
  }
}

const scenario = process.argv[2];
if (!scenario) {
  console.error('Usage: npm run demo -- <scenario>   (demo/scenarios/<scenario>.ts)');
  process.exit(1);
}
await record(scenario);
