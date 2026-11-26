// The decisions in spec/analysis.md and spec/cli.md, checked on what the real command prints for
// ./fixture and for a small GitHub repository answered in tests/helpers.ts. The edge cases of
// where skills live are yours to add.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { client, openGitHub, type Fetch } from '../src/core/github.ts';
import { scan } from '../src/core/scan.ts';
import { parseSkill } from '../src/core/parse.ts';
import { replay } from '../src/core/replay.ts';
import { atlas, CLI, EXAMPLE_COMMIT, FIXTURE } from './helpers.ts';

const fixture = await atlas(['scan', FIXTURE]);
const example = await atlas(['scan', 'github.com/JetBrains/example']);

test('malformed front matter → the directory name, no description and a warning', () => {
  const parsed = parseSkill(readFileSync(join(FIXTURE, '.agents/skills/release-checklist/SKILL.md'), 'utf8'));
  assert.equal(parsed.name, undefined);
  assert.equal(parsed.description, '');
  assert.equal(
    parsed.warning,
    'malformed front matter: Nested mappings are not allowed in compact mappings at line 3, column 14; using the directory name',
  );
});

test('scan prints the repository, then each skill with its first sentence and pinned link', () => {
  assert.equal(example.code, 0, example.stderr);
  assert.equal(
    example.stdout,
    [
      'JetBrains/example · 1 skill',
      'commits — Write commit messages the way this repository does.',
      `  https://github.com/JetBrains/example/blob/${EXAMPLE_COMMIT}/.claude/skills/commits/SKILL.md`,
    ].join('\n'),
  );
});

test('./fixture: every skill, sorted by name, linked to its file, with a warning for the malformed one', () => {
  const root = pathToFileURL(FIXTURE).href;
  assert.equal(fixture.code, 0);
  assert.equal(
    fixture.stdout,
    [
      'fixture · 3 skills',
      "code-style — Follow the project's code style.",
      `  ${root}/.github/skills/code-style/SKILL.md`,
      'commits — Write commit messages the way this repository does.',
      `  ${root}/.claude/skills/commits/SKILL.md`,
      'release-checklist',
      `  ${root}/.agents/skills/release-checklist/SKILL.md`,
    ].join('\n'),
  );
  assert.match(fixture.stderr, /^warning: \.agents\/skills\/release-checklist\/SKILL\.md: malformed front matter: /);
});

test('the CLI prints the result at once and stores nothing', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'skill-atlas-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const scanned = spawnSync(process.execPath, [CLI, 'scan', FIXTURE], { cwd, encoding: 'utf8' });
  assert.equal(scanned.status, 0, scanned.stderr);
  assert.equal(scanned.stdout, `${fixture.stdout}\n`);
  assert.deepEqual(readdirSync(cwd), []);
});

test('unreachable repository → a clear message, exit code 1', async () => {
  const missing = spawnSync(process.execPath, [CLI, 'scan', join(FIXTURE, 'no-such-directory')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^Not a GitHub URL or a readable directory: .*no-such-directory\n$/);

  // What GitHub answers for a repository that does not exist.
  const notFound = replay({ 'https://api.github.com/repos/JetBrains/no-such-repository': { status: 404, body: { message: 'Not Found' } } });
  await assert.rejects(openGitHub('https://github.com/JetBrains/no-such-repository', { fetch: notFound }), {
    message: 'Repository not found: https://github.com/JetBrains/no-such-repository',
  });

  const offline = await atlas(['scan', 'https://github.com/JetBrains/not-answered']);
  assert.equal(offline.code, 1);
  assert.match(offline.stderr, /^Cannot reach GitHub: not recorded: https:\/\/api\.github\.com\/repos\/JetBrains\/not-answered$/);
});

test('rate limit → a message that asks for GITHUB_TOKEN', async () => {
  const limited = replay({
    'https://api.github.com/repos/JetBrains/MPS': {
      status: 403,
      body: { message: 'API rate limit exceeded for 192.0.2.1. (But here is the good news: ...)' },
    },
  });
  await assert.rejects(openGitHub('https://github.com/JetBrains/MPS', { fetch: limited }), {
    message: 'GitHub rate limit reached; set GITHUB_TOKEN',
  });
});

/** What GitHub answers for its secondary rate limit: budget left, too many requests at once. */
const SECONDARY = { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' };

/** Answers each request for a URL with the next of `answers`, the last one again once they run out; counts the requests. */
function inTurn(answers: { status: number; body: unknown; headers?: Record<string, string> }[]) {
  let asked = 0;
  const fetch: Fetch = async () => {
    const { status, body, headers } = answers[Math.min(asked++, answers.length - 1)];
    return new Response(JSON.stringify(body), { status, headers });
  };
  return { fetch, asked: () => asked };
}

test('the hourly budget used up, with a token → when it resets, never "in a minute"', async () => {
  const exceeded = { message: 'API rate limit exceeded for user ID 1.' };
  const withReset = inTurn([{ status: 403, body: exceeded, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1795000000' } }]);
  await assert.rejects(openGitHub('https://github.com/JetBrains/MPS', { fetch: withReset.fetch, token: 'test' }), {
    message: 'GitHub rate limit reached; try again after 2026-11-18 11:06 UTC',
  });
  assert.equal(withReset.asked(), 1, 'not tried again');
  const noReset = inTurn([{ status: 403, body: exceeded }]);
  await assert.rejects(openGitHub('https://github.com/JetBrains/MPS', { fetch: noReset.fetch, token: 'test' }), {
    message: 'GitHub rate limit reached; try again when it resets, within the hour',
  });
});

test('the secondary rate limit → wait retry-after, then the same request again', async () => {
  const waits: number[] = [];
  const github = inTurn([
    { status: 403, body: SECONDARY, headers: { 'retry-after': '30', 'x-ratelimit-remaining': '4000' } },
    { status: 200, body: { full_name: 'JetBrains/MPS', default_branch: 'master' } },
  ]);
  const answer = await client({ fetch: github.fetch, token: 'test', wait: async (ms) => void waits.push(ms) }).json<{ full_name: string }>(
    'https://api.github.com/repos/JetBrains/MPS',
  );
  assert.equal(answer.full_name, 'JetBrains/MPS');
  assert.deepEqual(waits, [30_000]);
  assert.equal(github.asked(), 2);

  // A 429 with budget left and no message is the secondary limit too.
  const bare = inTurn([{ status: 429, body: {}, headers: { 'retry-after': '1' } }, { status: 200, body: { ok: true } }]);
  assert.deepEqual(await client({ fetch: bare.fetch, wait: async () => {} }).json('https://api.github.com/x'), { ok: true });
});

test('the secondary rate limit without retry-after → 1 minute, then 2; still refused → a message, exit code 1', async () => {
  const waits: number[] = [];
  const github = inTurn([{ status: 403, body: SECONDARY }]);
  await assert.rejects(openGitHub('https://github.com/JetBrains/MPS', { fetch: github.fetch, token: 'test', wait: async (ms) => void waits.push(ms) }), {
    message: 'GitHub refused requests again and again for coming too fast (its secondary rate limit); try again in a few minutes',
  });
  assert.deepEqual(waits, [60_000, 120_000]);
  assert.equal(github.asked(), 3);
});

test('the secondary rate limit with retry-after over 5 minutes → stop at once', async () => {
  const waits: number[] = [];
  const github = inTurn([{ status: 429, body: SECONDARY, headers: { 'retry-after': '301' } }]);
  await assert.rejects(client({ fetch: github.fetch, wait: async (ms) => void waits.push(ms) }).json('https://api.github.com/x'), {
    message: /its secondary rate limit\); try again in a few minutes$/,
  });
  assert.deepEqual(waits, []);
});

test('the secondary rate limit pauses every request of the scan, not just the refused one', async () => {
  const asked: string[] = [];
  let refused = false;
  const fetch: Fetch = async (url) => {
    asked.push(url);
    if (url.endsWith('/a') && !refused) {
      refused = true;
      return new Response(JSON.stringify(SECONDARY), { status: 403, headers: { 'retry-after': '60' } });
    }
    return new Response('{}', { status: 200 });
  };
  let resume = () => {};
  const paused = new Promise<void>((resolve) => (resume = resolve));
  const github = client({ fetch, wait: () => paused });
  const a = github.json('https://api.github.com/a');
  while (!refused) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const b = github.json('https://api.github.com/b');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(asked, ['https://api.github.com/a'], 'nothing asked during the pause');
  resume();
  await Promise.all([a, b]);
  assert.deepEqual(asked.sort(), ['https://api.github.com/a', 'https://api.github.com/a', 'https://api.github.com/b']);
});

test('…/tree/<commit> scans that commit', async () => {
  const commit = '1111111111111111111111111111111111111111';
  const pinned = replay({
    'https://api.github.com/repos/JetBrains/example': { status: 200, body: { full_name: 'JetBrains/example', default_branch: 'main' } },
    [`https://api.github.com/repos/JetBrains/example/commits/${commit}`]: { status: 200, body: { sha: commit } },
    [`https://api.github.com/repos/JetBrains/example/git/trees/${commit}`]: {
      status: 200,
      body: { truncated: false, tree: [{ path: '.agents', mode: '040000', type: 'tree', sha: 'agents' }] },
    },
    'https://api.github.com/repos/JetBrains/example/git/trees/agents': {
      status: 200,
      body: { truncated: false, tree: [{ path: 'skills', mode: '040000', type: 'tree', sha: 'skills' }] },
    },
    'https://api.github.com/repos/JetBrains/example/git/trees/skills?recursive=1': {
      status: 200,
      body: { truncated: false, tree: [{ path: 'commits/SKILL.md', mode: '100644', type: 'blob', sha: 'a' }] },
    },
  });
  const source = await openGitHub(`https://github.com/JetBrains/example/tree/${commit}/`, { fetch: pinned, token: 'test' });
  assert.equal(source.repository.commit, commit);
  assert.deepEqual(source.paths, ['.agents/skills/commits/SKILL.md']);

  const missing = replay({
    'https://api.github.com/repos/JetBrains/example': { status: 200, body: { full_name: 'JetBrains/example', default_branch: 'main' } },
    'https://api.github.com/repos/JetBrains/example/commits/no-such-ref': { status: 404, body: { message: 'Not Found' } },
  });
  await assert.rejects(openGitHub('https://github.com/JetBrains/example/tree/no-such-ref', { fetch: missing }), {
    message: 'Not found in https://github.com/JetBrains/example: no-such-ref',
  });
});

/** A repository too large for code search or one tree answer: only its skill roots are asked for. */
function monorepo(skillsTruncated = false) {
  const commit = '2222222222222222222222222222222222222222';
  const asked: { url: string; authorization?: string }[] = [];
  const recorded = replay({
    'https://api.github.com/repos/JetBrains/ultimate': { status: 200, body: { full_name: 'JetBrains/ultimate', default_branch: 'master' } },
    'https://api.github.com/repos/JetBrains/ultimate/commits/master': { status: 200, body: { sha: commit } },
    // A huge top level: the skill roots are found in it, not in a recursive tree.
    [`https://api.github.com/repos/JetBrains/ultimate/git/trees/${commit}`]: {
      status: 200,
      body: {
        truncated: false,
        tree: [
          { path: '.claude', mode: '040000', type: 'tree', sha: 'claude' },
          { path: 'community', mode: '040000', type: 'tree', sha: 'community' },
        ],
      },
    },
    'https://api.github.com/repos/JetBrains/ultimate/git/trees/claude': {
      status: 200,
      body: { truncated: false, tree: [{ path: 'skills', mode: '040000', type: 'tree', sha: 'claude-skills' }] },
    },
    'https://api.github.com/repos/JetBrains/ultimate/git/trees/claude-skills?recursive=1': {
      status: 200,
      body: { truncated: skillsTruncated, tree: [{ path: 'build/SKILL.md', mode: '100644', type: 'blob', sha: 'b' }] },
    },
    [`https://raw.githubusercontent.com/JetBrains/ultimate/${commit}/.claude/skills/build/SKILL.md`]: {
      status: 200,
      body: '---\nname: build\ndescription: Build the IDE.\n---\n',
    },
  });
  const fetch: Fetch = (url, init) => {
    asked.push({ url, authorization: init?.headers?.Authorization });
    return recorded(url, init);
  };
  return { fetch, asked };
}

test('a repository too large for code search: its skills, from the skill roots, with no search and no whole tree', async () => {
  const { fetch, asked } = monorepo();
  const result = await scan(await openGitHub('https://github.com/JetBrains/ultimate', { fetch, token: 'test' }));
  assert.deepEqual(result.skills.map((skill) => skill.path), ['.claude/skills/build/SKILL.md']);
  assert.deepEqual(result.warnings, []);
  const urls = asked.map(({ url }) => url);
  assert.deepEqual(urls.filter((url) => url.includes('/search/')), []);
  // The only recursive listing is the skill root's own.
  assert.deepEqual(urls.filter((url) => url.endsWith('?recursive=1')), ['https://api.github.com/repos/JetBrains/ultimate/git/trees/claude-skills?recursive=1']);
});

test('a private repository: the token goes with every request, file reads too', async () => {
  const { fetch, asked } = monorepo();
  await scan(await openGitHub('https://github.com/JetBrains/ultimate', { fetch, token: 'secret' }));
  assert.ok(asked.length > 0);
  for (const { url, authorization } of asked) assert.equal(authorization, 'Bearer secret', url);
});

test('a skill root too large for one answer → a warning, the skills that were listed', async () => {
  const { fetch } = monorepo(true);
  const result = await scan(await openGitHub('https://github.com/JetBrains/ultimate', { fetch }));
  assert.equal(result.skills.length, 1);
  assert.deepEqual(result.warnings, ['.claude/skills has too many files to list at once; some of its skills may be missing']);
});
