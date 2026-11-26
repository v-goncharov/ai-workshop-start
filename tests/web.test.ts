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
import { acme, atlas, CLI, EXAMPLE_COMMIT, FIXTURE, open, repository } from './helpers.ts';

const logged: string[] = [];
const slow = Promise.withResolvers<void>();
const halted = Promise.withResolvers<void>();
const server = createWebServer({
  open: (input) => {
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
  for (const [path, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/style.css', 'text/css']]) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type') ?? '', new RegExp(`^${type}`), path);
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  }
  const page = await (await get('/')).text();
  assert.match(page, /<label for="input">Repository<\/label>/);
  assert.match(page, /Scan repository/);
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
async function page(t: TestContext, path: string, { result = true, until = '#filter, .state, .error' } = {}) {
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
  for (const file of ['app.js', 'filter.js']) writeFileSync(join(scripts, file), await (await get(`/${file}`)).text());
  await import(pathToFileURL(join(scripts, 'app.js')).href);
  const document = window.document;
  for (let i = 0; i < 200 && !document.querySelector(until); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  if (result) assert.ok(document.getElementById('filter'), document.getElementById('result')?.textContent ?? '');
  return window;
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

  const scanning = await page(t, `/?input=${encodeURIComponent('https://github.com/scanning')}`, { result: false, until: '.progress:not([hidden])' });
  assert.equal(scanning.document.querySelector('.progress-label')?.textContent, 'Scanned 3 of 10 repositories');
  const bar = scanning.document.querySelector('progress') as HTMLProgressElement;
  assert.deepEqual([bar.value, bar.max], [3, 10]);
  halted.resolve();
});
