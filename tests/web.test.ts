// The decisions in spec/web.md: the web view's server, through real HTTP requests, and the
// serve command as a user runs it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { AtlasError } from '../src/core/errors.ts';
import { scanOwner } from '../src/core/owner.ts';
import { replay } from '../src/core/replay.ts';
import { createWebServer, listen, type OwnerScanResponse, type ScanResponse } from '../src/web/server.ts';
import { acme, atlas, CLI, EXAMPLE_COMMIT, FIXTURE, open } from './helpers.ts';

const logged: string[] = [];
const server = createWebServer({
  open: (input) => {
    if (input === 'crash') throw new Error('boom');
    return open(input);
  },
  scanOwner: (input) => scanOwner(input, { fetch: replay(acme()) }),
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
