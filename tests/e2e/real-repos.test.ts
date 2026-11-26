// End to end: the real CLI on real GitHub repositories, each pinned to a commit so the answer
// never changes. The edge cases in spec/analysis.md name these repositories; each test also checks
// that the file the edge case skips is really there at that commit, so a pass is never vacuous.
// Needs the network; GITHUB_TOKEN raises the rate limit. `npm run test:e2e` runs it.
// To re-record after an intended output change: ./skill-atlas scan <url> > tests/e2e/expected/<repo>.txt
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CLI } from '../helpers.ts';

/** What the CLI warns about a tree too large for one answer, when the commit is pinned. */
const LARGE_TREE = 'warning: the tree is too large to list at once; looked only in .agents/skills, .claude/skills, .github/skills\n';

const REPOSITORIES = [
  {
    repo: 'JetBrains/MPS',
    commit: '1cbf7f783dbc5c74c8e5231d31f61b02829143de',
    stderr: LARGE_TREE,
    // Part of the product: shipped to users, outside the skill roots.
    skipped: 'plugins/mcp-tools/resources/jetbrains/mps/agents/mcp/skills/mps-aspect-generator/SKILL.md',
  },
  {
    // The commit that added agent/skills; a later one removed it.
    repo: 'JetBrains/android',
    commit: '4d9ec3e52b338aa1c962c1ff0421cc62db5c73af',
    stderr: LARGE_TREE,
    // An unusual folder: the repository's own workflow, outside the skill roots.
    skipped: 'agent/skills/writing-lint-checks/SKILL.md',
  },
  {
    repo: 'JetBrains/koog',
    commit: '709079e4a34d6c9234583352550e6a2b88a0bb85',
    stderr: '',
    // Test data, skipped silently.
    skipped: 'integration-tests/src/jvmTest/resources/skills/weather-retrieval/SKILL.md',
  },
];

const scans = new Map<string, SpawnSyncReturns<string>>();

/** `skill-atlas scan` on the repository at the commit; once per run, to spare the rate limit. */
function scan(repo: string, commit: string) {
  const url = `https://github.com/${repo}/tree/${commit}`;
  const scanned = scans.get(url) ?? spawnSync(process.execPath, [CLI, 'scan', url], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  scans.set(url, scanned);
  assert.equal(scanned.status, 0, scanned.stderr);
  return scanned;
}

for (const { repo, commit, stderr, skipped } of REPOSITORIES) {
  test(`${repo} at ${commit.slice(0, 7)}: every skill, linked to that commit; ${skipped} skipped`, async () => {
    const exists = await fetch(`https://raw.githubusercontent.com/${repo}/${commit}/${skipped}`);
    assert.equal(exists.status, 200, `${skipped} should exist at ${commit}`);

    const scanned = scan(repo, commit);
    const expected = readFileSync(new URL(`expected/${repo.split('/')[1]}.txt`, import.meta.url), 'utf8');
    assert.equal(scanned.stdout, expected);
    assert.equal(scanned.stderr, stderr);
    assert.ok(!scanned.stdout.includes(skipped));
  });
}

test('JetBrains/MPS: mps-tests, identical in .agents and .claude → one skill with a copy', () => {
  const { stdout } = scan('JetBrains/MPS', REPOSITORIES[0].commit);
  const lines = stdout.split('\n');
  const at = lines.findIndex((line) => line.startsWith('mps-tests — '));
  assert.notEqual(at, -1);
  assert.equal(lines[at + 1], `  https://github.com/JetBrains/MPS/blob/${REPOSITORIES[0].commit}/.agents/skills/mps-tests/SKILL.md`);
  assert.equal(lines[at + 2], '  also in .claude/skills/mps-tests/SKILL.md');
  assert.equal(lines.filter((line) => line.startsWith('mps-tests — ')).length, 1);
});
