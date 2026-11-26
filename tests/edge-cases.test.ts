// The edge cases of where skills live, from spec/analysis.md ("Which SKILL.md counts", "Edge cases"),
// checked on what `skill-atlas scan` prints for small repositories laid out in a temporary directory.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { atlas } from './helpers.ts';

const MPS_TESTS = '---\nname: mps-tests\ndescription: Run the MPS tests.\n---\n# MPS tests\n';

/** A repository named `repo` with the given files, removed after the test. */
function repository(t: TestContext, files: Record<string, string>) {
  const root = join(mkdtempSync(join(tmpdir(), 'skill-atlas-')), 'repo');
  t.after(() => rmSync(dirname(root), { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { root, url: pathToFileURL(root).href };
}

test('duplicates: the same name and identical content in every root → one skill, the others its copies', async (t) => {
  // JetBrains/MPS: .agents/skills/mps-tests + .claude/skills/mps-tests
  const { root, url } = repository(t, {
    '.github/skills/mps-tests/SKILL.md': MPS_TESTS,
    '.claude/skills/mps-tests/SKILL.md': MPS_TESTS,
    '.agents/skills/mps-tests/SKILL.md': MPS_TESTS,
  });
  const scanned = await atlas(['scan', root]);
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(
    scanned.stdout,
    [
      'repo · 1 skill',
      'mps-tests — Run the MPS tests.',
      `  ${url}/.agents/skills/mps-tests/SKILL.md`,
      '  also in .claude/skills/mps-tests/SKILL.md, .github/skills/mps-tests/SKILL.md',
    ].join('\n'),
  );
  assert.equal(scanned.stderr, '');
});

test('duplicates: the main path follows the root order, not the alphabet', async (t) => {
  // `.claude` comes before `.github` in the root order; `.agents` is absent.
  const { root, url } = repository(t, {
    '.github/skills/mps-tests/SKILL.md': MPS_TESTS,
    '.claude/skills/mps-tests/SKILL.md': MPS_TESTS,
  });
  const scanned = await atlas(['scan', root]);
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(
    scanned.stdout,
    [
      'repo · 1 skill',
      'mps-tests — Run the MPS tests.',
      `  ${url}/.claude/skills/mps-tests/SKILL.md`,
      '  also in .github/skills/mps-tests/SKILL.md',
    ].join('\n'),
  );
});

test('duplicates: the same name, different content → separate skills, no copies', async (t) => {
  const { root, url } = repository(t, {
    '.agents/skills/mps-tests/SKILL.md': MPS_TESTS,
    '.claude/skills/mps-tests/SKILL.md': '---\nname: mps-tests\ndescription: Run the MPS tests from Claude.\n---\n',
  });
  const scanned = await atlas(['scan', root]);
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(
    scanned.stdout,
    [
      'repo · 2 skills',
      'mps-tests — Run the MPS tests.',
      `  ${url}/.agents/skills/mps-tests/SKILL.md`,
      'mps-tests — Run the MPS tests from Claude.',
      `  ${url}/.claude/skills/mps-tests/SKILL.md`,
    ].join('\n'),
  );
});

test('an unusual folder: the repository’s own workflow outside the skill roots → skipped', async (t) => {
  // JetBrains/android: agent/skills/writing-lint-checks
  const { root, url } = repository(t, {
    'agent/skills/writing-lint-checks/SKILL.md': '---\nname: writing-lint-checks\ndescription: Write lint checks.\n---\n',
    '.claude/skills/commits/SKILL.md': '---\nname: commits\ndescription: Write commits.\n---\n',
  });
  const scanned = await atlas(['scan', root]);
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(
    scanned.stdout,
    ['repo · 1 skill', 'commits — Write commits.', `  ${url}/.claude/skills/commits/SKILL.md`].join('\n'),
  );
});

test('part of the product: skills shipped to users, outside the skill roots → skipped', async (t) => {
  // JetBrains/MPS: plugins/mcp-tools/resources/…/skills/mps-aspect-generator
  const { root } = repository(t, {
    'plugins/mcp-tools/resources/META-INF/skills/mps-aspect-generator/SKILL.md':
      '---\nname: mps-aspect-generator\ndescription: Generate an MPS aspect.\n---\n',
  });
  const scanned = await atlas(['scan', root]);
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(scanned.stdout, 'repo · 0 skills');
});

test('test data: fixtures for the project’s own tests → skipped, silently', async (t) => {
  // JetBrains/koog: integration-tests/src/jvmTest/resources/skills/weather-retrieval
  const { root } = repository(t, {
    // Malformed on purpose: a skipped file is not parsed, so it cannot warn either.
    'integration-tests/src/jvmTest/resources/skills/weather-retrieval/SKILL.md': '---\nname: a: b\n---\n',
  });
  const scanned = await atlas(['scan', root]);
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(scanned.stdout, 'repo · 0 skills');
  assert.equal(scanned.stderr, '');
});

test('only <skill root>/<name>/SKILL.md counts: not deeper, not directly in a root, not at the top', async (t) => {
  const { root, url } = repository(t, {
    'SKILL.md': '---\nname: top\ndescription: At the top.\n---\n',
    '.claude/skills/SKILL.md': '---\nname: in-root\ndescription: Directly in a root.\n---\n',
    '.claude/skills/group/nested/SKILL.md': '---\nname: nested\ndescription: Too deep.\n---\n',
    '.claude/skills/commits/references/SKILL.md': '---\nname: reference\ndescription: Inside a skill.\n---\n',
    'skills/plain/SKILL.md': '---\nname: plain\ndescription: Not a skill root.\n---\n',
    'module/.claude/skills/sub/SKILL.md': '---\nname: sub\ndescription: A root, but not at the top.\n---\n',
    '.claude/skills/commits/SKILL.md': '---\nname: commits\ndescription: Write commits.\n---\n',
  });
  const scanned = await atlas(['scan', root]);
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(
    scanned.stdout,
    ['repo · 1 skill', 'commits — Write commits.', `  ${url}/.claude/skills/commits/SKILL.md`].join('\n'),
  );
});
