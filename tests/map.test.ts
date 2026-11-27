// The skill map in spec/map.md and spec/cli.md ("Skill map"): `skill-atlas scan … --map`. Claude is never called:
// the commands get a recorded answer from tests/recorded/, and the real CLI runs a fake `claude` (tests/fake-claude) first on its PATH.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { askClaude } from '../src/claude.ts';
import { replay } from '../src/core/replay.ts';
import { acme, atlas, CLI, FAKE_CLAUDE, RECORDED, replayClaude, repository } from './helpers.ts';

const BUMP = (url: string) => [
  'build-tools-bump-gradle-api — Bumps the Gradle API version that Kotlin Gradle plugins are compiled against.',
  `  ${url}/.claude/skills/build-tools-bump-gradle-api/SKILL.md`,
];
const COMMITS = (url: string) => ['commits — Write commit messages the way this repository does.', `  ${url}/.claude/skills/commits/SKILL.md`];
const MPS = (url: string) => ['mps-tests — Run the MPS tests.', `  ${url}/.agents/skills/mps-tests/SKILL.md`, '  also in .github/skills/mps-tests/SKILL.md'];

/** The real CLI, with the fake `claude` first on the PATH (or none), as `env` tells it to answer. */
function cli(t: TestContext, args: string[], env: Record<string, string> = {}, { claude = true } = {}) {
  const log = join(mkdtempSync(join(tmpdir(), 'skill-atlas-claude-')), 'log');
  t.after(() => rmSync(dirname(log), { recursive: true, force: true }));
  const PATH = [...(claude ? [FAKE_CLAUDE] : []), dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter);
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH, FAKE_CLAUDE_LOG: log, ...env } });
  const calls = (() => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; cwd: string; prompt: string });
    } catch {
      return [];
    }
  })();
  return { code: result.status, stdout: result.stdout.trimEnd(), stderr: result.stderr.trimEnd(), calls };
}

test('map: claude -p --model haiku with no tools and no MCP servers, away from the repository; the prompt on stdin: each skill’s id, name, full description, the answer’s shape', async (t) => {
  const { root, url } = repository(t);
  const result = cli(t, ['scan', root, '--map'], { FAKE_CLAUDE_ANSWER: RECORDED('repo') });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.calls.length, 1);
  const [{ args, cwd, prompt }] = result.calls;
  assert.deepEqual(args, ['-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config']);
  assert.notEqual(cwd, root);
  assert.match(prompt, /\{"groups":\[\{"name":"<group name>","skills":\["<skill id>"\]\}\]\}/);
  assert.match(prompt, /JSON only/);
  const listed = prompt.split('\n').filter((line) => line.startsWith('{"id"')).map((line) => JSON.parse(line));
  assert.deepEqual(listed, [
    { id: 'repo:.claude/skills/build-tools-bump-gradle-api/SKILL.md', name: 'build-tools-bump-gradle-api', description: 'Bumps the Gradle API version that Kotlin Gradle plugins are compiled against. Use it after each Gradle release.' },
    { id: 'repo:.claude/skills/commits/SKILL.md', name: 'commits', description: 'Write commit messages the way this repository does. Use for every commit.' },
    { id: 'repo:.agents/skills/mps-tests/SKILL.md', name: 'mps-tests', description: 'Run the MPS tests.' },
  ]);
  assert.equal(result.stdout, ['repo · 3 skills in 2 groups', '## Build · 2 skills', ...BUMP(url), ...MPS(url), '## Git · 1 skill', ...COMMITS(url)].join('\n'));
});

test('map: every skill exactly once — an invented id dropped, one given twice in its first group, a forgotten one in Other', async (t) => {
  const { root, url } = repository(t);
  // messy.txt: prose and a code fence around the JSON; an invented id; a group with only an invented one; mps-tests twice;
  // a group named "other"; "Testing" twice; commits forgotten.
  const result = await atlas(['scan', root, '--map'], undefined, { askClaude: replayClaude('messy') });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, ['repo · 3 skills in 2 groups', '## Testing · 2 skills', ...BUMP(url), ...MPS(url), '## Other · 1 skill', ...COMMITS(url)].join('\n'));
});

test('map: the groups in Claude’s order, Other last; the skills inside in the CLI’s order', async (t) => {
  const { root } = repository(t);
  const ask = async () => JSON.stringify({ groups: [{ name: 'Other', skills: ['repo:.agents/skills/mps-tests/SKILL.md'] }, { name: 'Zeta', skills: ['repo:.claude/skills/commits/SKILL.md', 'repo:.claude/skills/build-tools-bump-gradle-api/SKILL.md'] }] });
  const result = await atlas(['scan', root, '--map'], undefined, { askClaude: ask });
  const lines = result.stdout.split('\n').filter((line) => /^(##|\S+ —)/.test(line));
  assert.deepEqual(lines.map((line) => line.split(' — ')[0]), ['## Zeta · 2 skills', 'build-tools-bump-gradle-api', 'commits', '## Other · 1 skill', 'mps-tests']);
});

test('map: an owner — one map over all its skills, each after its repository; the summary unchanged', async () => {
  const ask = replayClaude('acme');
  const result = await atlas(['scan', 'https://github.com/acme', '--map'], { fetch: replay(acme()), token: 'test' }, { askClaude: ask });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(ask.prompts.length, 1);
  assert.equal(
    result.stdout,
    [
      'acme · 3 skills in 3 of 5 repositories (94 forks, 1 archived and 1 empty skipped)',
      '3 skills in 2 groups',
      '## Build and test · 2 skills',
      'acme/MPS: mps-tests — Run the MPS tests.',
      '  https://github.com/acme/MPS/blob/mps1/.agents/skills/mps-tests/SKILL.md',
      '  also in .claude/skills/mps-tests/SKILL.md',
      'acme/huge: build — Build it.',
      '  https://github.com/acme/huge/blob/h1/.claude/skills/build/SKILL.md',
      '## Docs · 1 skill',
      'acme/api: api-docs — Document the API.',
      '  https://github.com/acme/api/blob/a1/.github/skills/api-docs/SKILL.md',
    ].join('\n'),
  );
  // The owner's warnings, as without --map.
  assert.match(result.stderr, /^warning: acme\/broken: .*; skipped$/m);
});

test('map: with --filter — the groups from all the skills, only those with a match, counting the matches', async (t) => {
  const { root, url } = repository(t);
  const ask = replayClaude('repo');
  const result = await atlas(['scan', root, '--filter', 'gradle', '--map'], undefined, { askClaude: ask });
  assert.equal(result.stdout, ['repo · 1 of 3 skills in 1 of 2 groups match "gradle"', '## Build · 1 skill', ...BUMP(url)].join('\n'));
  // All three skills went to Claude, not only the match.
  assert.equal(ask.prompts[0].split('\n').filter((line) => line.startsWith('{"id"')).length, 3);
  const owner = await atlas(['scan', 'https://github.com/acme', '--map', '--filter', 'docs'], { fetch: replay(acme()), token: 'test' }, { askClaude: replayClaude('acme') });
  assert.deepEqual(owner.stdout.split('\n').slice(1), [
    '1 of 3 skills in 1 of 2 groups match "docs"',
    '## Docs · 1 skill',
    'acme/api: api-docs — Document the API.',
    '  https://github.com/acme/api/blob/a1/.github/skills/api-docs/SKILL.md',
  ]);
});

test('map: no skills, or none matching the filter → as without --map; Claude not asked', async (t) => {
  const ask = replayClaude('repo');
  const empty = repository(t, { 'README.md': '# Nothing here\n' });
  assert.deepEqual(await atlas(['scan', empty.root, '--map'], undefined, { askClaude: ask }), await atlas(['scan', empty.root]));
  const { root } = repository(t);
  assert.deepEqual(await atlas(['scan', root, '--map', '--filter', 'kubernetes'], undefined, { askClaude: ask }), await atlas(['scan', root, '--filter', 'kubernetes']));
  assert.equal(ask.prompts.length, 0);
});

test('map: nothing is stored — every map asks Claude again', async (t) => {
  const { root } = repository(t);
  const ask = replayClaude('repo');
  const first = await atlas(['scan', root, '--map'], undefined, { askClaude: ask });
  const second = await atlas(['scan', root, '--map'], undefined, { askClaude: ask });
  assert.equal(first.stdout, second.stdout);
  assert.equal(ask.prompts.length, 2);
});

test('map: --map before or after the input; given twice → usage, exit code 1', async (t) => {
  const { root } = repository(t);
  const before = await atlas(['scan', '--map', root], undefined, { askClaude: replayClaude('repo') });
  const after = await atlas(['scan', root, '--map'], undefined, { askClaude: replayClaude('repo') });
  assert.equal(before.code, 0, before.stderr);
  assert.equal(before.stdout, after.stdout);
  const twice = await atlas(['scan', root, '--map', '--map'], undefined, { askClaude: replayClaude('repo') });
  assert.deepEqual(twice, { code: 1, stdout: '', stderr: 'Usage: skill-atlas scan <GitHub URL | directory> [--filter "<words>"] [--map]' });
  const help = await atlas(['help']);
  assert.match(help.stdout, /scan <GitHub URL \| directory> \[--filter "<words>"\] \[--map\]/);
  assert.match(help.stdout, /--map: grouped by what they are about, by Claude/);
});

test('map: claude not on the PATH → a warning, the skills as without --map, exit code 0', async (t) => {
  const { root } = repository(t);
  const plain = await atlas(['scan', root]);
  const result = cli(t, ['scan', root, '--map'], {}, { claude: false });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, plain.stdout);
  assert.equal(result.stderr, 'warning: no skill map: claude is not installed; the skill map needs Claude Code: https://claude.com/claude-code');
});

test('map: claude exits with an error → its last line, on stderr, else on stdout', async (t) => {
  const { root } = repository(t);
  const plain = await atlas(['scan', root]);
  const stderr = cli(t, ['scan', root, '--map'], { FAKE_CLAUDE_EXIT: '2', FAKE_CLAUDE_STDERR: 'starting\nAPI Error: 529 overloaded\n' });
  assert.equal(stderr.code, 0);
  assert.equal(stderr.stdout, plain.stdout);
  assert.equal(stderr.stderr, 'warning: no skill map: claude failed (exit 2): API Error: 529 overloaded');
  // claude -p says why on stdout when it is not logged in.
  const stdout = cli(t, ['scan', root, '--map'], { FAKE_CLAUDE_EXIT: '1', FAKE_CLAUDE_ANSWER: RECORDED('not-logged-in') });
  assert.equal(stdout.stderr, 'warning: no skill map: claude failed (exit 1): Not logged in · Please run /login');
  const silent = cli(t, ['scan', root, '--map'], { FAKE_CLAUDE_EXIT: '3' });
  assert.equal(silent.stderr, 'warning: no skill map: claude failed (exit 3)');
});

test('map: no answer in time → claude is stopped, a warning', async () => {
  const PATH = [FAKE_CLAUDE, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter);
  const saved = { PATH: process.env.PATH, FAKE_CLAUDE_SLEEP: process.env.FAKE_CLAUDE_SLEEP };
  Object.assign(process.env, { PATH, FAKE_CLAUDE_SLEEP: '30' });
  try {
    const started = Date.now();
    // 3 minutes in the CLI; a shorter wait here, the same way of stopping it.
    await assert.rejects(askClaude('a prompt', { timeout: 500 }), { message: 'claude did not answer within 0.5 seconds' });
    assert.ok(Date.now() - started < 5000);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  assert.equal(await askClaude('a prompt', { timeout: 30_000 }).catch((error) => error.message), "claude is not installed; the skill map needs Claude Code: https://claude.com/claude-code");
});

test('map: an answer that doesn’t parse → claude’s answer is not a skill map; the skills as without --map', async (t) => {
  const { root } = repository(t);
  const plain = await atlas(['scan', root]);
  const answers = ['not-a-map', 'no-name'].map((name) => replayClaude(name)).concat([
    Object.assign(async () => '{"map": []}', { prompts: [] }),
    Object.assign(async () => '{"groups": [{"name": "Build", "skills": "all of them"}]}', { prompts: [] }),
    Object.assign(async () => '{"groups": [{"name": "Build", "skills": [}', { prompts: [] }),
  ]);
  for (const askClaude of answers) {
    const result = await atlas(['scan', root, '--map'], undefined, { askClaude });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, plain.stdout);
    assert.equal(result.stderr, "warning: no skill map: claude's answer is not a skill map");
  }
});

test('map: Claude fails for an owner → the owner as without --map, then the warning', async () => {
  const github = { fetch: replay(acme()), token: 'test' };
  const plain = await atlas(['scan', 'https://github.com/acme'], github);
  const result = await atlas(['scan', 'https://github.com/acme', '--map'], { fetch: replay(acme()), token: 'test' }, { askClaude: replayClaude('not-a-map') });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, plain.stdout);
  assert.equal(result.stderr, `${plain.stderr}\nwarning: no skill map: claude's answer is not a skill map`);
});

test('map: the browser terminal, with no Node → it runs only from the command line', async (t) => {
  const { root } = repository(t);
  const result = await atlas(['scan', root, '--map']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, 'warning: no skill map: the skill map runs only from the command line: ./skill-atlas scan <input> --map');
});

test('map: the real CLI, with the recorded answer replayed by the fake claude: the same as through the commands', async (t) => {
  const { root } = repository(t);
  const real = cli(t, ['scan', root, '--map'], { FAKE_CLAUDE_ANSWER: RECORDED('messy') });
  const replayed = await atlas(['scan', root, '--map'], undefined, { askClaude: replayClaude('messy') });
  assert.equal(real.code, 0, real.stderr);
  assert.match(real.stdout, /^repo · 3 skills in 2 groups\n## Testing · 2 skills\n/);
  assert.equal(real.stdout, replayed.stdout);
});
