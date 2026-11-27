// The filter in spec/cli.md ("Filter"): `skill-atlas scan … --filter "<words>"`, on a small repository
// laid out in a temporary directory, on ./fixture and on the JetBrains/example recording.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { atlas, CLI, EXAMPLE_COMMIT, FIXTURE, repository } from './helpers.ts';

const BUMP = (url: string) => [
  'build-tools-bump-gradle-api — Bumps the Gradle API version that Kotlin Gradle plugins are compiled against.',
  `  ${url}/.claude/skills/build-tools-bump-gradle-api/SKILL.md`,
];
const MPS = (url: string) => ['mps-tests — Run the MPS tests.', `  ${url}/.agents/skills/mps-tests/SKILL.md`, '  also in .github/skills/mps-tests/SKILL.md'];

test('filter: every word must match, in any field (gradle bump → build-tools-bump-gradle-api)', async (t) => {
  const { root, url } = repository(t);
  const scanned = await atlas(['scan', root, '--filter', 'gradle bump']);
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(scanned.stdout, ['repo · 1 of 3 skills match "gradle bump"', ...BUMP(url)].join('\n'));
  // `bump` only in the name, `kotlin` only in the description, `claude` only in the path: still one match.
  const fields = await atlas(['scan', root, '--filter', 'bump kotlin claude']);
  assert.equal(fields.stdout, ['repo · 1 of 3 skills match "bump kotlin claude"', ...BUMP(url)].join('\n'));
  // AND, not OR: `gradle` and `commits` are in different skills.
  const both = await atlas(['scan', root, '--filter', 'gradle commits']);
  assert.equal(both.stdout, 'No skills match "gradle commits"');
});

test('filter: words match case-insensitively, as substrings; the header shows them as typed', async (t) => {
  const { root, url } = repository(t);
  const scanned = await atlas(['scan', root, '--filter', '  GRADLE   Bum ']);
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(scanned.stdout, ['repo · 1 of 3 skills match "GRADLE Bum"', ...BUMP(url)].join('\n'));
});

test('filter: a match in a copy’s path only → the skill, with its copies', async (t) => {
  const { root, url } = repository(t);
  const scanned = await atlas(['scan', root, '--filter', '.github']);
  assert.equal(scanned.stdout, ['repo · 1 of 3 skills match ".github"', ...MPS(url)].join('\n'));
});

test('filter: a match in the full description only, past the first sentence → the skill', async (t) => {
  const { root, url } = repository(t);
  const scanned = await atlas(['scan', root, '--filter', 'release']);
  assert.equal(scanned.stdout, ['repo · 1 of 3 skills match "release"', ...BUMP(url)].join('\n'));
});

test('filter: order and output unchanged; only the matching skills are printed', async (t) => {
  const { root, url } = repository(t);
  const scanned = await atlas(['scan', root, '--filter', 's']);
  const all = await atlas(['scan', root]);
  assert.equal(scanned.stdout, ['repo · 3 of 3 skills match "s"', ...all.stdout.split('\n').slice(1)].join('\n'));
  const two = await atlas(['scan', root, '--filter', 'use']);
  assert.equal(
    two.stdout,
    ['repo · 2 of 3 skills match "use"', ...BUMP(url), 'commits — Write commit messages the way this repository does.', `  ${url}/.claude/skills/commits/SKILL.md`].join('\n'),
  );
});

test('filter: the header, on GitHub and for a repository with one skill', async () => {
  const scanned = await atlas(['scan', 'https://github.com/JetBrains/example', '--filter', 'commit']);
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(
    scanned.stdout,
    [
      'JetBrains/example · 1 of 1 skill match "commit"',
      'commits — Write commit messages the way this repository does.',
      `  https://github.com/JetBrains/example/blob/${EXAMPLE_COMMIT}/.claude/skills/commits/SKILL.md`,
    ].join('\n'),
  );
});

test('filter: no match → "No skills match", exit code 0; warnings still go to stderr', async () => {
  const unfiltered = await atlas(['scan', FIXTURE]);
  const scanned = spawnSync(process.execPath, [CLI, 'scan', FIXTURE, '--filter', 'no such words'], { encoding: 'utf8' });
  assert.equal(scanned.status, 0);
  assert.equal(scanned.stdout, 'No skills match "no such words"\n');
  assert.equal(scanned.stderr, `${unfiltered.stderr}\n`);
  assert.match(scanned.stderr, /^warning: \.agents\/skills\/release-checklist\/SKILL\.md: malformed front matter: /);
});

test('filter: an empty or blank filter → the same as no filter', async () => {
  const unfiltered = await atlas(['scan', FIXTURE]);
  for (const words of ['', '   ', '\t']) {
    assert.deepEqual(await atlas(['scan', FIXTURE, '--filter', words]), unfiltered, JSON.stringify(words));
  }
});

test('filter: --filter before or after the input → the same result', async (t) => {
  const { root } = repository(t);
  const after = await atlas(['scan', root, '--filter', 'gradle']);
  assert.deepEqual(await atlas(['scan', '--filter', 'gradle', root]), after);
  const cli = spawnSync(process.execPath, [CLI, 'scan', '--filter', 'gradle', root], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, `${after.stdout}\n`);
});

test('filter: --filter without a value, or given twice → usage, exit code 1', async () => {
  const usage = 'Usage: skill-atlas scan <GitHub URL | directory> [--filter "<words>"] [--map]';
  for (const args of [
    [FIXTURE, '--filter'],
    ['--filter'],
    ['--filter', 'a', '--filter', 'b', FIXTURE],
    [FIXTURE, '--filter', 'a', '--filter', 'a'],
    ['--filter', 'a'],
    [FIXTURE, FIXTURE, '--filter', 'a'],
  ]) {
    const scanned = await atlas(['scan', ...args]);
    assert.equal(scanned.code, 1, args.join(' '));
    assert.equal(scanned.stdout, '', args.join(' '));
    assert.equal(scanned.stderr, usage, args.join(' '));
  }
});

test('help shows --filter', async () => {
  assert.match((await atlas(['help'])).stdout, /scan <GitHub URL \| directory> \[--filter "<words>"\]/);
});
