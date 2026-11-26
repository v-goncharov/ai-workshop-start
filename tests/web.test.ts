// The decisions in spec/web.md: the web view's server, through real HTTP requests, and the
// serve command as a user runs it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { JSDOM, type DOMWindow } from 'jsdom';
import { AtlasError } from '../src/core/errors.ts';
import { scanOwner } from '../src/core/owner.ts';
import { replay } from '../src/core/replay.ts';
import { createWebServer, listen, type OwnerScanResponse, type ScanResponse } from '../src/web/server.ts';
import { PHRASES } from '../src/web/static/phrases.js';
import { acme, atlas, CLI, EXAMPLE_COMMIT, FIXTURE, open, repository } from './helpers.ts';

const logged: string[] = [];
const slow = Promise.withResolvers<void>();
const halted = Promise.withResolvers<void>();
/** Scans held until the test lets them go: `held:<directory>`, how long a scan takes is up to the test. */
const held = new Map<string, Promise<void>>();
const server = createWebServer({
  open: async (input) => {
    await held.get(input);
    if (input.startsWith('held:')) return open(input.slice('held:'.length));
    if (input === 'crash') throw new Error('boom');
    // The rate limit's messages, as the CLI words them without and with a token.
    if (input === 'limited-no-token') throw new AtlasError('GitHub rate limit reached; set GITHUB_TOKEN');
    if (input === 'limited-token') throw new AtlasError('GitHub rate limit reached; try again after 2026-11-18 11:06 UTC');
    return open(input);
  },
  scanOwner: async (input, progress) => {
    // Stops halfway, until the test lets it go on: the page's progress, as it is shown.
    if (input === 'https://github.com/slow') {
      progress?.({ stage: 'listing', page: 2 });
      progress?.({ stage: 'scanning', done: 3, total: 10 });
      progress?.({ stage: 'waiting', seconds: 45 });
      await slow.promise;
    }
    if (input === 'https://github.com/listing' || input === 'https://github.com/scanning') {
      progress?.(input.endsWith('listing') ? { stage: 'listing', page: 2 } : { stage: 'scanning', done: 3, total: 10 });
      await halted.promise;
    }
    return scanOwner(input.replace(/\/(slow|listing|scanning)$/, '/acme'), { fetch: replay(acme()), progress });
  },
  log: (text) => logged.push(text),
});
const address = await listen(server, 0);
after(() => server.close());

const get = (path: string, init?: RequestInit) => fetch(`${address}${path}`, init);
const scan = (input: string) => get(`/api/scan?input=${encodeURIComponent(input)}`);

test('serve listens on 127.0.0.1 only', () => {
  assert.match(address, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('the page, its script and its styles', async () => {
  for (const [path, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/phrases.js', 'text/javascript'], ['/style.css', 'text/css']]) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type') ?? '', new RegExp(`^${type}`), path);
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  }
  const page = await (await get('/')).text();
  assert.match(page, /<label for="input">Repository<\/label>/);
  assert.match(page, /Scan repository/);
  // The alpaca look: both alpacas drawn in the page, coloured by the stylesheet (the CSP allows no inline styles).
  assert.match(page, /<symbol id="alpaca" /);
  assert.match(page, /<symbol id="alpaca-trot" /);
  assert.doesNotMatch(page, / style="/);
  assert.match(await (await get('/style.css')).text(), /\.a-wool \{/);
});

test('a GitHub repository: the same skills as the CLI, linked to the scanned commit', async () => {
  const response = await scan('https://github.com/JetBrains/example');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    repository: { id: 'JetBrains/example', url: 'https://github.com/JetBrains/example', commit: EXAMPLE_COMMIT, local: false },
    skills: [
      {
        id: 'JetBrains/example:.claude/skills/commits/SKILL.md',
        name: 'commits',
        path: '.claude/skills/commits/SKILL.md',
        summary: 'Write commit messages the way this repository does.',
        description: 'Write commit messages the way this repository does. Use for every commit.',
        link: `https://github.com/JetBrains/example/blob/${EXAMPLE_COMMIT}/.claude/skills/commits/SKILL.md`,
        copies: [],
      },
    ],
    warnings: [],
  });
});

test('a local directory: sorted by name as the CLI prints it, with the warning for the malformed one', async () => {
  const body = (await (await scan(FIXTURE)).json()) as ScanResponse;
  assert.deepEqual(body.repository, { id: 'fixture', url: pathToFileURL(FIXTURE).href, commit: '', local: true });
  assert.deepEqual(
    body.skills.map((skill) => skill.name),
    ['code-style', 'commits', 'release-checklist'],
  );
  const cli = await atlas(['scan', FIXTURE]);
  const linked = cli.stdout.split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim());
  assert.deepEqual(body.skills.map((skill) => skill.link), linked);
  assert.equal(body.skills[2].summary, '');
  assert.equal(body.warnings.length, 1);
  assert.equal(`warning: ${body.warnings[0]}`, cli.stderr);
});

test('an owner: { owner, repositories, skipped, warnings }, the repositories with skills as the CLI prints them', async () => {
  const response = await scan('https://github.com/acme');
  assert.equal(response.status, 200);
  const body = (await response.json()) as OwnerScanResponse;
  assert.deepEqual(Object.keys(body), ['owner', 'repositories', 'skipped', 'warnings']);
  assert.deepEqual(body.owner, { id: 'acme', url: 'https://github.com/acme', scanned: 5 });
  assert.deepEqual(body.skipped, { forks: 94, archived: 1, empty: 1 });
  assert.deepEqual(body.repositories.map(({ repository }) => repository.id), ['acme/MPS', 'acme/api', 'acme/huge']);
  assert.deepEqual(body.repositories[0], {
    repository: { id: 'acme/MPS', url: 'https://github.com/acme/MPS', commit: 'mps1', local: false },
    skills: [
      {
        id: 'acme/MPS:.agents/skills/mps-tests/SKILL.md',
        name: 'mps-tests',
        path: '.agents/skills/mps-tests/SKILL.md',
        summary: 'Run the MPS tests.',
        description: 'Run the MPS tests.',
        link: 'https://github.com/acme/MPS/blob/mps1/.agents/skills/mps-tests/SKILL.md',
        copies: ['.claude/skills/mps-tests/SKILL.md'],
      },
    ],
  });
  const cli = await atlas(['scan', 'https://github.com/acme'], { fetch: replay(acme()) });
  assert.deepEqual(body.warnings.map((warning) => `warning: ${warning}`), cli.stderr.split('\n'));
});

test('an owner’s errors → 400 with the CLI’s message', async () => {
  const tree = await scan('https://github.com/acme/tree/main');
  assert.equal(tree.status, 400);
  assert.deepEqual(await tree.json(), {
    error: "…/tree/<branch or commit> works only for a repository; an owner's repositories are scanned on their default branches: https://github.com/acme/tree/main",
  });
  const offline = await scan('https://github.com/not-answered');
  assert.equal(offline.status, 400);
  assert.deepEqual(await offline.json(), { error: 'Cannot reach GitHub: not recorded: https://api.github.com/orgs/not-answered/repos?per_page=100&page=1' });
});

test('the page takes an owner URL and renders one table per repository', async () => {
  const page = await (await get('/')).text();
  assert.match(page, /https:\/\/github\.com\/&lt;owner&gt;/);
  const script = await (await get('/app.js')).text();
  assert.match(script, /function showOwnerResult\(/);
});

test('no skills: an empty list, not an error', async () => {
  const body = (await (await scan(new URL('../src', import.meta.url).pathname)).json()) as ScanResponse;
  assert.deepEqual(body.skills, []);
});

test('no input → 400 and what to enter; no scan', async () => {
  for (const path of ['/api/scan', '/api/scan?input=', '/api/scan?input=%20%20']) {
    const response = await get(path);
    assert.equal(response.status, 400, path);
    assert.deepEqual(await response.json(), { error: 'Enter a GitHub URL or a directory path.' });
  }
});

test('the CLI’s errors → 400 with the CLI’s message', async () => {
  const missing = await scan('/no/such/directory');
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: 'Not a GitHub URL or a readable directory: /no/such/directory' });

  const offline = await scan('https://github.com/JetBrains/not-answered');
  assert.equal(offline.status, 400);
  assert.deepEqual(await offline.json(), { error: 'Cannot reach GitHub: not recorded: https://api.github.com/repos/JetBrains/not-answered' });
});

test('an unexpected failure → 500, a short message; the details go to the log', async () => {
  const response = await scan('crash');
  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: string };
  assert.doesNotMatch(body.error, /boom/);
  assert.match(logged.join('\n'), /boom/);
});

test('anything else → 404; anything but GET → 405', async () => {
  assert.equal((await get('/no-such-page')).status, 404);
  assert.equal((await get('/static/../server.ts')).status, 404);
  assert.equal((await get('/api/scan?input=x', { method: 'POST' })).status, 405);
});

/** A raw GET with the headers as given: fetch would not let a test set Host. */
function rawGet(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const { port } = new URL(address);
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    })
      .on('error', reject)
      .end();
  });
}

test('DNS rebinding: another host name → 403, before anything is scanned or served', async () => {
  const { port } = new URL(address);
  const path = `/api/scan?input=${encodeURIComponent(FIXTURE)}`;
  for (const host of [`attacker.example:${port}`, 'attacker.example', '127.0.0.1', `127.0.0.1:${Number(port) + 1}`, `localhost.attacker.example:${port}`]) {
    for (const target of [path, '/']) {
      const answer = await rawGet(target, { host });
      assert.equal(answer.status, 403, `${host} ${target}`);
      assert.doesNotMatch(answer.body, /SKILL\.md/);
    }
  }
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
    assert.equal((await rawGet(path, { host })).status, 200, host);
  }
});

test('a scan asked for by another site → 403; by the page or the address bar → answered', async () => {
  const { port } = new URL(address);
  const path = `/api/scan?input=${encodeURIComponent(FIXTURE)}`;
  const host = `127.0.0.1:${port}`;
  for (const site of ['cross-site', 'same-site']) {
    assert.equal((await rawGet(path, { host, 'sec-fetch-site': site })).status, 403, site);
  }
  for (const site of ['same-origin', 'none']) {
    assert.equal((await rawGet(path, { host, 'sec-fetch-site': site })).status, 200, site);
  }
});

test('a port in use → a clear message', async () => {
  const port = Number(new URL(address).port);
  await assert.rejects(listen(createWebServer({ open }), port), (error: unknown) => {
    assert.ok(error instanceof AtlasError);
    assert.equal(error.message, `Port ${port} is in use; pass another one: skill-atlas serve --port <n>`);
    return true;
  });
});

test('skill-atlas serve --port 0 prints its address and serves the page', async (t) => {
  const child = spawn(process.execPath, [CLI, 'serve', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const [line] = (await once(child.stdout, 'data')) as [Buffer];
  const match = /^Skill Atlas is at (http:\/\/127\.0\.0\.1:\d+); Ctrl\+C stops it\n$/.exec(line.toString());
  assert.ok(match, line.toString());
  const body = (await (await fetch(`${match[1]}/api/scan?input=${encodeURIComponent(FIXTURE)}`)).json()) as ScanResponse;
  assert.equal(body.skills.length, 3);
});

test('skill-atlas serve on a port in use → exit code 1', async (t) => {
  const busy = createServer().listen(0, '127.0.0.1');
  await once(busy, 'listening');
  t.after(() => busy.close());
  const port = (busy.address() as { port: number }).port;
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.equal(stderr, `Port ${port} is in use; pass another one: skill-atlas serve --port <n>\n`);
});

test('serve with a bad port → usage, exit code 1', async () => {
  for (const args of [['--port'], ['--port', 'abc'], ['--port', '70000'], ['8080']]) {
    const result = await atlas(['serve', ...args]);
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(result.stderr, 'Usage: skill-atlas serve [--port <n>]', args.join(' '));
  }
  // The test context, like the browser terminal, has no server to start.
  const noServer = await atlas(['serve']);
  assert.equal(noServer.stderr, 'serve runs only from the command line: ./skill-atlas serve');
});

// The page itself, in spec/web.md ("Page"): the real app.js, run in jsdom against this server.

/** Opens the page at `path` and waits for the scan to show; returns its window. */
async function page(t: TestContext, path: string, { result = true, until = '#filter, .state, .error', before = () => {} } = {}) {
  const html = await (await get('/')).text();
  const { window } = new JSDOM(html, { url: `${address}${path}` });
  const names = ['window', 'document', 'location', 'history', 'Node', 'Event'] as const;
  const saved = Object.fromEntries([...names, 'fetch'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { value: name === 'window' ? window : window[name], configurable: true, writable: true });
  const nodeFetch = fetch;
  Object.defineProperty(globalThis, 'fetch', { value: (url: string, init?: RequestInit) => nodeFetch(new URL(url, window.location.href), init), configurable: true, writable: true });
  t.after(() => {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    window.close();
  });
  // The scripts as served, side by side as the browser resolves them: app.js imports ./filter.js.
  const scripts = mkdtempSync(join(tmpdir(), 'skill-atlas-page-'));
  t.after(() => rmSync(scripts, { recursive: true, force: true }));
  for (const file of ['app.js', 'filter.js', 'phrases.js']) writeFileSync(join(scripts, file), await (await get(`/${file}`)).text());
  before();
  await import(pathToFileURL(join(scripts, 'app.js')).href);
  const document = window.document;
  await shows(document, until);
  if (result) assert.ok(document.getElementById('filter'), document.getElementById('result')?.textContent ?? '');
  return window;
}

/** Waits, for up to 2 s, until the page shows `selector`. */
async function shows(document: Document, selector: string) {
  for (let i = 0; i < 200 && !document.querySelector(selector); i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** The names of the rows shown, the count and the no-match message. */
function shown(window: DOMWindow) {
  const rows = [...window.document.querySelectorAll('table.skills tbody tr')] as HTMLElement[];
  return {
    names: rows.filter((row) => !row.hidden && !row.classList.contains('no-match')).map((row) => row.querySelector('.name')?.textContent),
    count: window.document.querySelector('.filter .meta')?.textContent,
    noMatch: rows.find((row) => row.classList.contains('no-match') && !row.hidden)?.textContent ?? '',
  };
}

function type(window: DOMWindow, words: string) {
  const filter = window.document.getElementById('filter') as HTMLInputElement;
  filter.value = words;
  filter.dispatchEvent(new window.Event('input'));
}

test('the web filter: the CLI’s rules — every word, any field, case, copies’ paths, the full description', async (t) => {
  const { root } = repository(t);
  const window = await page(t, `/?input=${encodeURIComponent(root)}`);
  assert.deepEqual(shown(window).names, ['build-tools-bump-gradle-api', 'commits', 'mps-tests']);
  const cases: [string, string[]][] = [
    ['gradle bump', ['build-tools-bump-gradle-api']],
    ['bump kotlin claude', ['build-tools-bump-gradle-api']],
    ['GRADLE Bum', ['build-tools-bump-gradle-api']],
    ['.github', ['mps-tests']],
    ['release', ['build-tools-bump-gradle-api']],
    ['use', ['build-tools-bump-gradle-api', 'commits']],
    ['gradle commits', []],
  ];
  for (const [words, names] of cases) {
    type(window, words);
    assert.deepEqual(shown(window).names, names, words);
    const cli = await atlas(['scan', root, '--filter', words]);
    const printed = cli.stdout.split('\n').filter((line) => /^\S/.test(line)).slice(1).map((line) => line.split(' — ')[0]);
    assert.deepEqual(printed, names, `the CLI, ${words}`);
  }
  type(window, 'gradle bump');
  assert.equal(shown(window).count, 'Showing 1 of 3 skills');
  type(window, 'gradle commits');
  assert.deepEqual(shown(window), { names: [], count: 'Showing 0 of 3 skills', noMatch: 'No skills match “gradle commits”. Clear the filter' });
});

test('the web filter goes in the address, ?filter=; clearing it removes filter', async (t) => {
  const { root } = repository(t);
  const window = await page(t, `/?input=${encodeURIComponent(root)}`);
  const entries = window.history.length;
  type(window, 'gradle bump');
  assert.equal(window.location.search, `?input=${encodeURIComponent(root)}&filter=gradle%20bump`);
  type(window, '  ');
  assert.equal(window.location.search, `?input=${encodeURIComponent(root)}`);
  assert.equal(window.history.length, entries, 'typing adds no history entry');
});

test('?filter= in the address: a filtered scan, shared and reloaded', async (t) => {
  const { root } = repository(t);
  const window = await page(t, `/?input=${encodeURIComponent(root)}&filter=${encodeURIComponent('Gradle release')}`);
  assert.equal((window.document.getElementById('filter') as HTMLInputElement).value, 'Gradle release');
  assert.deepEqual(shown(window), { names: ['build-tools-bump-gradle-api'], count: 'Showing 1 of 3 skills', noMatch: '' });
});

/** An owner's page: the repositories whose section is shown, the skills shown, the count and the no-match message. */
function shownOwner(window: DOMWindow) {
  const sections = [...window.document.querySelectorAll('section.repository')] as HTMLElement[];
  const visible = sections.filter((section) => !section.hidden);
  const noMatch = window.document.querySelector('p.no-match') as HTMLElement;
  return {
    repositories: visible.map((section) => section.querySelector('h2')?.textContent),
    names: visible.flatMap((section) => ([...section.querySelectorAll('tbody tr')] as HTMLElement[]).filter((row) => !row.hidden).map((row) => row.querySelector('.name')?.textContent)),
    count: window.document.querySelector('.filter .meta')?.textContent,
    noMatch: noMatch.hidden ? '' : noMatch.textContent,
  };
}

test('an owner’s page: one table per repository; the filter, by the CLI’s rules, across all of them, hiding repositories with no match', async (t) => {
  const window = await page(t, `/?input=${encodeURIComponent('https://github.com/acme')}`);
  assert.deepEqual(shownOwner(window), { repositories: ['acme/MPS', 'acme/api', 'acme/huge'], names: ['mps-tests', 'api-docs', 'build'], count: '', noMatch: '' });
  // As the CLI filters an owner: `it` in two repositories, one in the full description only.
  type(window, 'it');
  assert.deepEqual(shownOwner(window), { repositories: ['acme/api', 'acme/huge'], names: ['api-docs', 'build'], count: 'Showing 2 of 3 skills', noMatch: '' });
  const cli = await atlas(['scan', 'https://github.com/acme', '--filter', 'it'], { fetch: replay(acme()) });
  assert.deepEqual(cli.stdout.split('\n').filter((line) => / match "it"$/.test(line)).map((line) => line.split(' · ')[0]), ['acme/api', 'acme/huge']);
  assert.equal(window.location.search, `?input=${encodeURIComponent('https://github.com/acme')}&filter=it`);
  type(window, 'gradle bump');
  assert.deepEqual(shownOwner(window), { repositories: [], names: [], count: 'Showing 0 of 3 skills', noMatch: 'No skills match “gradle bump”. Clear the filter' });
  (window.document.querySelector('p.no-match button') as HTMLButtonElement).click();
  assert.deepEqual(shownOwner(window).repositories, ['acme/MPS', 'acme/api', 'acme/huge']);
  assert.equal(window.location.search, `?input=${encodeURIComponent('https://github.com/acme')}`);
});

test('an owner’s page with ?filter= in the address: filtered across the repositories on load', async (t) => {
  const window = await page(t, `/?input=${encodeURIComponent('https://github.com/acme')}&filter=MPS`);
  assert.deepEqual(shownOwner(window), { repositories: ['acme/MPS'], names: ['mps-tests'], count: 'Showing 1 of 3 skills', noMatch: '' });
});

test('/filter.js: the CLI’s filter module, served to the page', async () => {
  const response = await get('/filter.js');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/javascript/);
  assert.equal(await response.text(), readFileSync(new URL('../src/core/filter.js', import.meta.url), 'utf8'));
});

test('the rate limit on the page: restart with a token only when the server has none', async (t) => {
  const advice = async (input: string) => {
    const window = await page(t, `/?input=${input}`, { result: false });
    return window.document.querySelector('.error')?.textContent ?? '';
  };
  const without = await advice('limited-no-token');
  assert.match(without, /GitHub rate limit reached; set GITHUB_TOKEN/);
  assert.match(without, /Restart the server with a token, GITHUB_TOKEN=… \.\/skill-atlas serve/);
  const withToken = await advice('limited-token');
  assert.match(withToken, /try again after 2026-11-18 11:06 UTC/);
  assert.doesNotMatch(withToken, /Restart the server with a token/);
  assert.match(withToken, /The server has a token already: wait as the message says, then scan again\./);
});

test('the alpaca stands by an error and by "No skills"', async (t) => {
  const error = await page(t, '/?input=limited-token', { result: false });
  assert.ok(error.document.querySelector('.error svg.alpaca use[href="#alpaca"]'), 'the alpaca by the error');
  const empty = await page(t, `/?input=${encodeURIComponent(new URL('../src', import.meta.url).pathname)}`, { result: false });
  assert.match(empty.document.querySelector('.state .state-title')?.textContent ?? '', /^No skills in /);
  assert.ok(empty.document.querySelector('.state svg.alpaca use[href="#alpaca"]'), 'the alpaca by "No skills"');
});

// The alpaca speaks (spec/web.md, "Look"): the idle alpaca, a button; its jokes in a speech bubble.
const JOKES = [
  'What do you call an alpaca with no fleece? A bald-paca.',
  'Why did the alpaca get the job? It was outstanding in its field.',
  "I'd tell you a joke about llamas, but no llamas were consulted.",
  'How do alpacas stay cool? Fleece conditioning.',
  "What's an alpaca's favourite drink? A llama-tini. Shaken, not sheared.",
  'Alpacas never worry. They know everything will be all wool in the end.',
  'I asked the alpaca to fetch your skills. It said: no prob-llama.',
  'What does an alpaca read? The SKILL.md, obviously. Impeccably.',
];

/** The idle page: its talking alpaca and the bubble it speaks in. */
async function idlePage(t: TestContext) {
  const window = await page(t, '/', { result: false, until: '.idle' });
  const document = window.document;
  const speaker = document.querySelector('.idle button.speaker') as HTMLButtonElement;
  const bubble = document.querySelector('.idle .bubble') as HTMLElement;
  return { window, document, speaker, bubble, says: () => bubble?.textContent ?? '' };
}

test('the idle alpaca speaks: a real button; a click shows a joke in a speech bubble, announced politely', async (t) => {
  const { speaker, bubble, says } = await idlePage(t);
  assert.ok(speaker, 'the alpaca is a button');
  assert.equal(speaker.type, 'button');
  assert.equal(speaker.getAttribute('aria-label'), 'Ask the alpaca for a joke');
  assert.ok(speaker.querySelector('svg.alpaca.hero use[href="#alpaca"]'), 'the hero alpaca inside it');
  assert.ok(bubble, 'the bubble');
  assert.equal(bubble.getAttribute('aria-live'), 'polite');
  assert.equal(says(), '', 'silent until clicked');
  speaker.click();
  assert.ok(JOKES.includes(says()), says());
  assert.ok(speaker.classList.contains('wobble'), 'the alpaca wobbles');
});

test('another click, another joke: picked at random, never the same one twice in a row', async (t) => {
  const { speaker, says } = await idlePage(t);
  // Even when chance picks the same one, the alpaca says another.
  t.mock.method(Math, 'random', () => 0);
  speaker.click();
  const first = says();
  speaker.click();
  assert.ok(JOKES.includes(says()));
  assert.notEqual(says(), first);
  t.mock.restoreAll();
  const heard = [says()];
  for (let i = 0; i < 60; i++) {
    speaker.click();
    heard.push(says());
  }
  for (let i = 1; i < heard.length; i++) assert.notEqual(heard[i], heard[i - 1], `the same joke twice: ${heard[i]}`);
  assert.ok(heard.every((joke) => JOKES.includes(joke)));
  assert.ok(new Set(heard).size > 3, 'at random');
});

test('the bubble goes after 5 s, or on a click anywhere else', async (t) => {
  const { document, speaker, says } = await idlePage(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  speaker.click();
  t.mock.timers.tick(4900);
  assert.notEqual(says(), '', 'still there before 5 s');
  // Another joke starts the 5 s again.
  speaker.click();
  t.mock.timers.tick(4900);
  assert.notEqual(says(), '');
  t.mock.timers.tick(100);
  assert.equal(says(), '', 'gone after 5 s');
  speaker.click();
  assert.notEqual(says(), '');
  (document.querySelector('.idle .state-title') as HTMLElement).click();
  assert.equal(says(), '', 'gone on a click elsewhere');
  t.mock.timers.reset();
});

test('the crest stays a plain link home; a click on it is no joke and no comment', async (t) => {
  const { document, says } = await idlePage(t);
  const crest = document.querySelector('a.crest') as HTMLAnchorElement;
  assert.equal(crest.getAttribute('href'), '/');
  assert.equal(crest.querySelector('button'), null);
  assert.equal(document.querySelectorAll('button.speaker').length, 1, 'only the idle alpaca tells jokes');
  t.mock.method(Math, 'random', () => 0);
  (crest.querySelector('svg') as unknown as HTMLElement).dispatchEvent(new document.defaultView!.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(says(), '');
  assert.equal(document.querySelector('.comment')?.textContent, '');
});

test('no motion under prefers-reduced-motion: what moves is only in the no-preference block', async () => {
  const css = (await (await get('/style.css')).text()).replace(/\/\*[\s\S]*?\*\//g, '');
  const start = css.indexOf('@media (prefers-reduced-motion: no-preference) {');
  assert.ok(start >= 0, 'the no-preference block');
  let end = css.indexOf('{', start) + 1;
  for (let depth = 1; depth > 0; end++) depth += css[end] === '{' ? 1 : css[end] === '}' ? -1 : 0;
  const motion = css.slice(start, end);
  const still = css.slice(0, start) + css.slice(end);
  // Outside the block: no animation, no transition of position or transform, no hover or press that moves anything.
  assert.doesNotMatch(still, /animation\s*:/);
  assert.doesNotMatch(still, /transition\s*:[^;}]*\b(left|width|transform)\b/);
  assert.doesNotMatch(still, /:(hover|active)[^{]*\{[^}]*transform\s*:\s*(?!none)/);
  // Inside it: the alpaca and the bar slide to d of n, the crest tilts on hover.
  assert.match(motion, /\.trotter \{ transition: left /);
  assert.match(motion, /::-webkit-progress-value \{ transition: width /);
  assert.match(motion, /\.crest:hover \.alpaca \{ transform: /);
  // The talking alpaca wobbles only here, and so does the crest when it comments.
  assert.match(motion, /\.speaker\.wobble \.hero \{ animation: wobble /);
  assert.match(motion, /\.crest\.wobble \.alpaca \{ animation: wobble /);
});

// The crest alpaca comments on what the user does (spec/web.md, "Look"). Chance is pinned: Math.random answers the
// given rolls in turn, then 0. A comment rolls three times — its 1-in-3 chance, its category, its phrase; an action
// that chance skips rolls once; one in the cooldown, or with no category, not at all.
const CATEGORIES = [
  'scanGitHub', 'scanLocal', 'scanMany', 'scanFew', 'scanSlow', 'scanFast', 'noSkills', 'scanError',
  'filterMatch', 'filterNoMatch', 'filterCleared', 'openFile', 'fullDescription', 'copies', 'emptyPage',
] as const;
const phrases = PHRASES as Record<(typeof CATEGORIES)[number], string[]>;

/** Whether `text` is one of the category's phrases, filled in. */
function from(category: (typeof CATEGORIES)[number], text: string) {
  return phrases[category].some((phrase) => new RegExp(`^${phrase.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\w+\}/g, '.+')}$`).test(text));
}

/** Math.random answers `values` in turn, then 0. Mocked once per test: a mock of a mock would outlive the test. */
const queues = new WeakMap<TestContext, number[]>();
function rolls(t: TestContext, values: number[] = []) {
  const queue = queues.get(t);
  if (queue) return void queue.splice(0, queue.length, ...values);
  const fresh = [...values];
  queues.set(t, fresh);
  t.mock.method(Math, 'random', () => (fresh.length > 0 ? fresh.shift()! : 0));
}

/** performance.now, `ms` ahead of the real one; mocked once per test, as Math.random is. */
const offsets = new WeakMap<TestContext, { ms: number }>();
function later(t: TestContext, ms: number) {
  const offset = offsets.get(t);
  if (offset) return void (offset.ms = ms);
  const fresh = { ms };
  offsets.set(t, fresh);
  const now = performance.now.bind(performance);
  t.mock.method(performance, 'now', () => now() + fresh.ms);
}

/** The page at `path`, chance pinned to `rolled` from the start, and what the crest says. */
async function commentPage(t: TestContext, path: string, rolled: number[] = [], options: { result?: boolean; until?: string } = {}) {
  const window = await page(t, path, { ...options, before: () => rolls(t, rolled) });
  const document = window.document;
  const bubble = document.querySelector('.masthead .comment') as HTMLElement;
  const crest = document.querySelector('a.crest') as HTMLElement;
  return { window, document, bubble, crest, says: () => bubble.textContent ?? '' };
}

/** A click as a user makes it; links don't navigate (jsdom can't). */
function clickOn(element: Element) {
  const window = element.ownerDocument.defaultView!;
  element.addEventListener('click', (event) => event.target instanceof window.Element && event.target.closest('a') && event.preventDefault(), { once: true });
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

const at = (input: string) => `/?input=${encodeURIComponent(input)}`;
const tick = (t: TestContext, ms: number) => t.mock.timers.tick(ms);
const timers = (t: TestContext) => t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });

test('the phrases: at least 150, at least 10 in each category of the spec, no two alike', () => {
  assert.deepEqual(Object.keys(PHRASES).sort(), [...CATEGORIES].sort());
  const all = Object.values(phrases).flat();
  assert.ok(all.length >= 150, `${all.length} phrases`);
  for (const category of CATEGORIES) assert.ok(phrases[category].length >= 10, `${category}: ${phrases[category].length}`);
  assert.equal(new Set(all).size, all.length, 'no two alike');
  // Only the placeholders app.js fills in.
  for (const phrase of all) for (const [key] of phrase.matchAll(/\{\w+\}/g)) assert.ok(['{input}', '{skills}', '{time}', '{text}', '{name}'].includes(key), phrase);
});

test('the crest alpaca comments: the same speech bubble, beside the crest, announced politely, out of the way', async (t) => {
  const { bubble, crest, says } = await commentPage(t, '/', [], { result: false, until: '.idle' });
  assert.ok(bubble, 'the bubble');
  assert.ok(bubble.classList.contains('bubble'));
  assert.equal(bubble.getAttribute('aria-live'), 'polite');
  assert.equal(bubble.closest('a, [aria-hidden="true"]'), null, 'outside the crest link, which screen readers skip');
  assert.equal(bubble.parentElement, crest.parentElement, 'beside the crest');
  assert.equal(bubble.hasAttribute('tabindex'), false);
  assert.equal(says(), '', 'silent until something happens');
  const css = (await (await get('/style.css')).text()).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.bubble\.comment \{[^}]*pointer-events: none/, 'clicks go through it');
  assert.match(css, /\.bubble\.comment \{[^}]*position: fixed;[^}]*top: var\(--top/, 'placed in the window');
});

test('the comment is below the crest, or at the top of the window when the page is scrolled past it', async (t) => {
  const { document, bubble, crest, says } = await commentPage(t, '/', [], { result: false, until: '.idle' });
  timers(t);
  let box = { top: 48, bottom: 136, left: 64 };
  crest.getBoundingClientRect = () => box as DOMRect;
  clickOn(document.querySelector('main')!);
  assert.ok(says());
  assert.deepEqual([bubble.style.getPropertyValue('--top'), bubble.style.getPropertyValue('--left')], ['148px', '64px']);
  tick(t, 10_000);
  box = { top: -600, bottom: -512, left: 64 };
  clickOn(document.querySelector('main')!);
  assert.ok(says());
  assert.equal(bubble.style.getPropertyValue('--top'), '12px', 'scrolled: at the top of the window');
  t.mock.timers.reset();
});

test('a scan started: a GitHub URL, an owner or a directory, said shortly', async (t) => {
  const github = await commentPage(t, at('https://github.com/JetBrains/example'), [0, 0, 0]);
  assert.equal(github.says(), 'Off to GitHub for JetBrains/example. I packed a monocle.');
  assert.ok(github.crest.classList.contains('wobble'), 'the crest wobbles');
  const owner = await commentPage(t, at('https://github.com/acme'), [0, 0, 0]);
  assert.equal(owner.says(), 'Off to GitHub for acme. I packed a monocle.');
  const local = await commentPage(t, at(FIXTURE), [0, 0, 0]);
  assert.equal(local.says(), 'A local directory: fixture. No travel today.');
});

test('a scan finished: few or fast, chance picks one; many; an owner too', async (t) => {
  // The start skipped (0.9), then the comment: chance, category, phrase.
  const few = await commentPage(t, at(FIXTURE), [0.9, 0, 0, 0]);
  assert.equal(few.says(), 'Only 3 skills. Quality over quantity, I suppose.');
  const fast = await commentPage(t, at(FIXTURE), [0.9, 0, 0.99, 0]);
  assert.match(fast.says(), /^Back in \d+ ms\. Did you even blink\?$/);
  const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`.claude/skills/s${i}/SKILL.md`, `---\nname: s${i}\ndescription: Skill ${i}.\n---\n`]));
  const many = await commentPage(t, at(repository(t, files).root), [0.9, 0, 0, 0]);
  assert.equal(many.says(), '20 skills! My saddlebag is heaving.');
  // An owner: its skills across the repositories.
  const owner = await commentPage(t, at('https://github.com/acme'), [0.9, 0, 0, 0]);
  const total = owner.document.querySelectorAll('table.skills tbody tr').length;
  assert.equal(owner.says(), `Only ${total} skills. Quality over quantity, I suppose.`);
});

/** A scan of `directory` that takes `ms` as the page measures it: held while the clock moves on. */
async function timedScan(t: TestContext, directory: string, ms: number, rolled: number[]) {
  const input = `held:${directory}`;
  const release = Promise.withResolvers<void>();
  held.set(input, release.promise);
  const scan = await commentPage(t, at(input), rolled, { result: false, until: '.skeleton' });
  later(t, ms);
  release.resolve();
  await shows(scan.document, '#filter');
  assert.ok(scan.document.getElementById('filter'), 'the result');
  return scan;
}

test('a scan finished: slow; and no comment when no category applies', async (t) => {
  const slow = await timedScan(t, FIXTURE, 12_000, [0.9, 0, 0.99, 0]);
  assert.match(slow.says(), /^1\d\.\d s\. I stopped for tea on the way\.$/);
  // 5 skills in about 2 s: neither many nor few, slow nor fast.
  const files = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`.claude/skills/s${i}/SKILL.md`, `---\nname: s${i}\ndescription: Skill ${i}.\n---\n`]));
  // The start skipped; the end would comment if a category applied.
  later(t, 0);
  const neither = await timedScan(t, repository(t, files).root, 2000, [0.9]);
  assert.equal(neither.says(), '');
});

test('no skills, and a scan error: their own comments', async (t) => {
  const empty = await commentPage(t, at(repository(t, { 'README.md': '# Nothing\n' }).root), [0.9, 0, 0, 0], { result: false });
  assert.match(empty.document.querySelector('.state-title')?.textContent ?? '', /^No skills in /);
  assert.equal(empty.says(), 'Nothing in repo. Not a single skill.');
  const error = await commentPage(t, at('limited-token'), [0.9, 0, 0, 0], { result: false });
  assert.ok(error.document.querySelector('.error'));
  assert.equal(error.says(), 'Oh dear. limited-token would not let me in.');
});

test('the filter: a comment once typing stops for 800 ms, on a match, no match or cleared; none for words unchanged', async (t) => {
  // The start and the end of the scan skipped.
  const { window, document, says } = await commentPage(t, at(repository(t).root), [0.9, 0.9]);
  timers(t);
  const filter = document.getElementById('filter') as HTMLInputElement;
  filter.focus();
  for (const words of ['m', 'mp', 'mps']) {
    type(window, words);
    tick(t, 300);
  }
  assert.equal(says(), '', 'not on every key');
  tick(t, 499);
  assert.equal(says(), '');
  tick(t, 1);
  assert.equal(says(), 'Searching for “mps”? Bold choice.');
  assert.equal(document.activeElement, filter, 'the comment takes no focus');
  tick(t, 10_000);
  type(window, 'zzz');
  tick(t, 800);
  assert.equal(says(), '“zzz”? Never heard of it.');
  tick(t, 10_000);
  assert.equal(says(), '', 'gone after 5 s');
  type(window, ' zzz  ');
  tick(t, 800);
  assert.equal(says(), '', 'the same words: nothing');
  type(window, '');
  tick(t, 800);
  assert.equal(says(), 'All of them again. Fresh start.');
  t.mock.timers.reset();
});

test('the filter from the address: no comment', async (t) => {
  const { window, says } = await commentPage(t, `${at(repository(t).root)}&filter=mps`, [0.9, 0.9]);
  timers(t);
  tick(t, 1000);
  assert.equal(says(), '');
  type(window, 'mps ');
  tick(t, 800);
  assert.equal(says(), '', 'the same words as the address');
  t.mock.timers.reset();
});

test('what the user typed is quoted as text, never markup, shortened to 30 characters', async (t) => {
  const { window, bubble, says } = await commentPage(t, at(repository(t).root), [0.9, 0.9]);
  timers(t);
  type(window, '<img src=x onerror=alert(1)><b>bold</b>');
  tick(t, 800);
  assert.equal(says(), '“<img src=x onerror=alert(1)><…”? Never heard of it.');
  assert.equal(bubble.children.length, 0, 'no markup');
  t.mock.timers.reset();
});

test('clicks: a skill’s file, opening its full description, its copies, the empty page; not the table or a button', async (t) => {
  const github = await commentPage(t, at('https://github.com/JetBrains/example'), [0.9, 0.9]);
  timers(t);
  const { document, says } = github;
  clickOn(document.querySelector('a.path')!);
  assert.equal(says(), 'Opening commits. Do read it carefully.');
  tick(t, 10_000);
  const details = document.querySelector('.description details') as HTMLDetailsElement;
  clickOn(details.querySelector('summary')!);
  assert.equal(says(), 'The full story of commits. Grab a cushion.');
  assert.equal(details.open, true);
  tick(t, 10_000);
  clickOn(details.querySelector('summary')!);
  assert.equal(says(), '', 'closing it: nothing');
  clickOn(document.querySelector('td.name')!);
  clickOn(document.querySelector('#scan-button')!.closest('form')!.querySelector('label')!);
  assert.equal(says(), '', 'the table, a label: nothing');
  clickOn(document.querySelector('main')!);
  assert.equal(says(), 'That was nothing. Literally.');
  t.mock.timers.reset();

  const local = await commentPage(t, at(repository(t).root), [0.9, 0.9]);
  clickOn(local.document.querySelector('.copies code')!);
  assert.equal(local.says(), 'mps-tests is in more than one place. Clever.');
});

test('about 1 in 3: a roll under 1/3 comments, one at or over it does not', async (t) => {
  const { document, says } = await commentPage(t, '/', [0.34, 0.333], { result: false, until: '.idle' });
  const main = document.querySelector('main')!;
  clickOn(main);
  assert.equal(says(), '');
  clickOn(main);
  assert.ok(from('emptyPage', says()), says());
});

test('at least 10 s between two comments; an action chance skips does not count', async (t) => {
  const { document, says } = await commentPage(t, '/', [], { result: false, until: '.idle' });
  timers(t);
  const main = document.querySelector('main')!;
  clickOn(main);
  const first = says();
  assert.ok(from('emptyPage', first));
  tick(t, 9999);
  clickOn(main);
  assert.equal(says(), '', 'not within 10 s');
  tick(t, 1);
  clickOn(main);
  assert.ok(from('emptyPage', says()));
  tick(t, 10_000);
  rolls(t, [0.9]);
  clickOn(main);
  assert.equal(says(), '', 'skipped by chance');
  tick(t, 1);
  clickOn(main);
  assert.ok(from('emptyPage', says()), 'right after: a skipped action starts no wait');
  t.mock.timers.reset();
});

test('never the same phrase twice in a row', async (t) => {
  const { document, says } = await commentPage(t, '/', [], { result: false, until: '.idle' });
  timers(t);
  const main = document.querySelector('main')!;
  // Even when chance picks the same one, the alpaca says another.
  clickOn(main);
  const first = says();
  tick(t, 10_000);
  clickOn(main);
  assert.ok(from('emptyPage', says()));
  assert.notEqual(says(), first);
  t.mock.restoreAll();
  const heard = [says()];
  for (let i = 0; i < 90; i++) {
    tick(t, 10_000);
    clickOn(main);
    if (says()) heard.push(says());
  }
  for (let i = 1; i < heard.length; i++) assert.notEqual(heard[i], heard[i - 1], `the same phrase twice: ${heard[i]}`);
  assert.ok(heard.every((phrase) => from('emptyPage', phrase)));
  assert.ok(new Set(heard).size > 3, `at random: ${JSON.stringify(heard)}`);
  t.mock.timers.reset();
});

test('the comment goes after 5 s, not on a click elsewhere; a joke is no comment', async (t) => {
  const { document, crest, says } = await commentPage(t, '/', [], { result: false, until: '.idle' });
  timers(t);
  clickOn(document.querySelector('main')!);
  const comment = says();
  assert.ok(from('emptyPage', comment));
  assert.ok(crest.classList.contains('wobble'));
  clickOn(document.querySelector('.idle .state-title')!);
  assert.equal(says(), comment, 'a click elsewhere leaves it');
  tick(t, 4999);
  assert.equal(says(), comment);
  tick(t, 1);
  assert.equal(says(), '', 'gone after 5 s');
  assert.equal(crest.classList.contains('wobble'), false);
  tick(t, 10_000);
  (document.querySelector('.idle button.speaker') as HTMLButtonElement).click();
  assert.ok(JOKES.includes(document.querySelector('.idle .bubble')?.textContent ?? ''), 'the joke');
  assert.equal(says(), '', 'no comment on the joke button');
  t.mock.timers.reset();
});

/** `/api/scan` as the page asks for it: a stream of JSON lines. */
async function lines(input: string) {
  const response = await get(`/api/scan?input=${encodeURIComponent(input)}`, { headers: { Accept: 'application/x-ndjson, application/json' } });
  return { response, lines: (await response.text()).trim().split('\n').map((line) => JSON.parse(line)) };
}

test('an owner, streamed: progress lines, then the same result as the JSON answer', async () => {
  const { response, lines: answer } = await lines('https://github.com/acme');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/x-ndjson/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const last = answer.pop();
  assert.deepEqual(last, { result: await (await scan('https://github.com/acme')).json() });
  assert.deepEqual(answer.slice(0, 3), [
    { progress: { stage: 'listing', page: 1 } },
    { progress: { stage: 'listing', page: 2 } },
    { progress: { stage: 'scanning', done: 0, total: 6 } },
  ]);
  assert.deepEqual(answer.at(-1), { progress: { stage: 'scanning', done: 6, total: 6 } });
});

test('an owner, streamed, that fails → { error } as the last line, the CLI’s message', async () => {
  const { response, lines: answer } = await lines('https://github.com/acme/tree/main');
  assert.equal(response.status, 200);
  assert.deepEqual(answer, [
    { error: "…/tree/<branch or commit> works only for a repository; an owner's repositories are scanned on their default branches: https://github.com/acme/tree/main" },
  ]);
  // A single repository is one JSON answer, whatever the page accepts.
  const single = await get(`/api/scan?input=${encodeURIComponent(FIXTURE)}`, { headers: { Accept: 'application/x-ndjson, application/json' } });
  assert.match(single.headers.get('content-type') ?? '', /^application\/json/);
});

test('the page while an owner is scanned: the bar, how many of how many, the wait counting down; then the result', async (t) => {
  const window = await page(t, `/?input=${encodeURIComponent('https://github.com/slow')}`, { result: false, until: '.progress:not([hidden])' });
  const document = window.document;
  const label = () => document.querySelector('.progress-label')?.textContent;
  const bar = document.querySelector('progress') as HTMLProgressElement;
  assert.ok(bar, 'a progress bar');
  // The wait came last; the bar stays at 3 of 10.
  assert.match(label() ?? '', /^GitHub asked to slow down: going on in 4[45] s$/);
  assert.equal(bar.value, 3);
  assert.equal(bar.max, 10);
  // The alpaca on the bar stands still during the wait, where the scan got to.
  const trail = document.querySelector('.trail') as HTMLElement;
  assert.ok(trail.querySelector('svg.trotter use[href="#alpaca-trot"]'), 'the trotting alpaca');
  assert.deepEqual([trail.classList.contains('resting'), trail.classList.contains('roaming')], [true, false]);
  assert.equal(trail.style.getPropertyValue('--at'), '0.3');
  slow.resolve();
  for (let i = 0; i < 200 && !document.getElementById('filter'); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(document.getElementById('filter'), 'the result');
  assert.equal(document.querySelector('progress'), null, 'the bar is gone');
  assert.match(document.querySelector('.summary')?.textContent ?? '', /acme/);
});

test('the page’s progress: listing (the bar moving, no end known), then scanned d of n', async (t) => {
  const listing = await page(t, `/?input=${encodeURIComponent('https://github.com/listing')}`, { result: false, until: '.progress:not([hidden])' });
  assert.equal(listing.document.querySelector('.progress-label')?.textContent, 'Listing the repositories… (page 2)');
  assert.equal(listing.document.querySelector('progress')?.hasAttribute('value'), false);
  // The alpaca trots back and forth: the end is not known yet.
  const roaming = listing.document.querySelector('.trail') as HTMLElement;
  assert.deepEqual([roaming.classList.contains('roaming'), roaming.classList.contains('resting')], [true, false]);

  const scanning = await page(t, `/?input=${encodeURIComponent('https://github.com/scanning')}`, { result: false, until: '.progress:not([hidden])' });
  assert.equal(scanning.document.querySelector('.progress-label')?.textContent, 'Scanned 3 of 10 repositories');
  const bar = scanning.document.querySelector('progress') as HTMLProgressElement;
  assert.deepEqual([bar.value, bar.max], [3, 10]);
  // The alpaca at d of n.
  const trail = scanning.document.querySelector('.trail') as HTMLElement;
  assert.deepEqual([trail.classList.contains('roaming'), trail.classList.contains('resting')], [false, false]);
  assert.equal(trail.style.getPropertyValue('--at'), '0.3');
  halted.resolve();
});
