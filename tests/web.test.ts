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
import { createWebServer, listen, type ScanResponse } from '../src/web/server.ts';
import { atlas, CLI, EXAMPLE_COMMIT, FIXTURE, open, repository } from './helpers.ts';

const logged: string[] = [];
const server = createWebServer({
  open: (input) => {
    if (input === 'crash') throw new Error('boom');
    return open(input);
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
async function page(t: TestContext, path: string) {
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
  for (let i = 0; i < 200 && !document.getElementById('filter') && !document.querySelector('.state, .error'); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(document.getElementById('filter'), document.getElementById('result')?.textContent ?? '');
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

test('/filter.js: the CLI’s filter module, served to the page', async () => {
  const response = await get('/filter.js');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/javascript/);
  assert.equal(await response.text(), readFileSync(new URL('../src/core/filter.js', import.meta.url), 'utf8'));
});
