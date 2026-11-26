// "A whole owner" in spec/analysis.md and "Output for an owner" in spec/cli.md: `skill-atlas scan
// https://github.com/<owner>` on a small organization and a user, answered from recordings.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import type { Fetch } from '../src/core/github.ts';
import { scanOwner, type Progress } from '../src/core/owner.ts';
import { replay, type Recorded, type Recording } from '../src/core/replay.ts';
import { acme, atlas, budget, CLI, listed, recordRepository } from './helpers.ts';

const MPS_TESTS = '---\nname: mps-tests\ndescription: Run the MPS tests.\n---\n';

/** What GitHub answers when jane is a user, not an organization. */
const NOT_AN_ORGANIZATION: Recording = { [`https://api.github.com/orgs/jane/repos?per_page=100&page=1`]: { status: 404, body: { message: 'Not Found' } } };

const ACME_STDOUT = [
  'acme · 3 skills in 3 of 5 repositories (94 forks, 1 archived and 1 empty skipped)',
  'acme/MPS · 1 skill',
  'mps-tests — Run the MPS tests.',
  '  https://github.com/acme/MPS/blob/mps1/.agents/skills/mps-tests/SKILL.md',
  '  also in .claude/skills/mps-tests/SKILL.md',
  'acme/api · 1 skill',
  'api-docs — Document the API.',
  '  https://github.com/acme/api/blob/a1/.github/skills/api-docs/SKILL.md',
  'acme/huge · 1 skill',
  'build — Build it.',
  '  https://github.com/acme/huge/blob/h1/.claude/skills/build/SKILL.md',
].join('\n');

test('an organization: every page of repositories, those with skills only, sorted by name, each as a single repository', async () => {
  const scanned = await atlas(['scan', 'https://github.com/acme'], { fetch: replay(acme()) });
  assert.equal(scanned.code, 0, scanned.stderr);
  // Scanned: no-skills, MPS, broken, huge and api; 3 of them have skills.
  assert.equal(scanned.stdout, ACME_STDOUT);
});

test('an owner URL with or without the scheme or a trailing slash', async () => {
  for (const input of ['github.com/acme', 'https://github.com/acme/', 'http://www.github.com/acme']) {
    const scanned = await atlas(['scan', input], { fetch: replay(acme()) });
    assert.equal(scanned.code, 0, `${input}: ${scanned.stderr}`);
    assert.match(scanned.stdout, /^acme · 3 skills in 3 of 5 repositories /, input);
  }
});

test('forks, archived and empty repositories → skipped, counted in the summary, no warning for each', async () => {
  const asked: string[] = [];
  const recorded = replay(acme());
  const scanned = await atlas(['scan', 'https://github.com/acme'], { fetch: (url, init) => (asked.push(url), recorded(url, init)) });
  assert.match(scanned.stdout.split('\n')[0], /\(94 forks, 1 archived and 1 empty skipped\)$/);
  assert.doesNotMatch(scanned.stderr, /fork|old|empty/);
  // Forks and archived repositories are not even asked for.
  assert.deepEqual(asked.filter((url) => /acme\/(fork-|old)/.test(url)), []);
});

test('one repository fails, or has a root too large → a warning naming it; the scan goes on', async () => {
  const scanned = await atlas(['scan', 'https://github.com/acme'], { fetch: replay(acme()) });
  assert.equal(scanned.code, 0);
  assert.equal(
    scanned.stderr,
    [
      'warning: acme/broken: GitHub answered 500 for https://api.github.com/repos/acme/broken/git/trees/b0: Server Error; skipped',
      'warning: acme/huge: .claude/skills has too many files to list at once; some of its skills may be missing',
    ].join('\n'),
  );
});

test('a private repository with a token: listed and scanned, the token with every request', async () => {
  const asked: { url: string; authorization?: string }[] = [];
  const withToken = replay(acme({ token: true }));
  const fetch: Fetch = (url, init) => {
    asked.push({ url, authorization: init?.headers?.Authorization });
    return withToken(url, init);
  };
  const scanned = await atlas(['scan', 'https://github.com/acme'], { fetch, token: 'secret' });
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.match(scanned.stdout, /^acme · 4 skills in 4 of 6 repositories /);
  assert.match(scanned.stdout, /\nacme\/secret · 1 skill\ndeploy — Deploy\.\n {2}https:\/\/github\.com\/acme\/secret\/blob\/s1\/\.claude\/skills\/deploy\/SKILL\.md$/);
  for (const { url, authorization } of asked) assert.equal(authorization, 'Bearer secret', url);
});

test('a user: /orgs/<owner>/repos is not found, so /users/<owner>/repos, every page', async () => {
  const page1 = [listed('jane/dotfiles'), ...Array.from({ length: 99 }, (_, index) => listed(`jane/fork-${index}`, { fork: true }))];
  const recording: Recording = {
    ...NOT_AN_ORGANIZATION,
    'https://api.github.com/users/jane/repos?per_page=100&page=1': { status: 200, body: page1 },
    'https://api.github.com/users/jane/repos?per_page=100&page=2': { status: 200, body: [] },
    ...budget(60),
    ...recordRepository('jane/dotfiles', { '.claude/skills/commits/SKILL.md': '---\nname: commits\ndescription: Write commits.\n---\n' }, { commit: 'd1' }),
  };
  const scanned = await atlas(['scan', 'github.com/jane'], { fetch: replay(recording) });
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(
    scanned.stdout,
    [
      'jane · 1 skill in 1 of 1 repository (99 forks skipped)',
      'jane/dotfiles · 1 skill',
      'commits — Write commits.',
      '  https://github.com/jane/dotfiles/blob/d1/.claude/skills/commits/SKILL.md',
    ].join('\n'),
  );
});

/** jane's public repository, with one skill, as /users/jane/repos lists it. */
const JANE_PUBLIC: Recording = {
  ...NOT_AN_ORGANIZATION,
  'https://api.github.com/users/jane/repos?per_page=100&page=1': { status: 200, body: [listed('jane/dotfiles')] },
  ...budget(5000),
  ...recordRepository('jane/dotfiles', { '.claude/skills/commits/SKILL.md': '---\nname: commits\ndescription: Write commits.\n---\n' }, { commit: 'd1' }),
};

const JANE_DOTFILES = ['jane/dotfiles · 1 skill', 'commits — Write commits.', '  https://github.com/jane/dotfiles/blob/d1/.claude/skills/commits/SKILL.md'];

test('a user with their own token: /user/repos?affiliation=owner, every page, their private repositories too', async () => {
  const page1 = [listed('jane/dotfiles'), ...Array.from({ length: 99 }, (_, index) => listed(`jane/fork-${index}`, { fork: true }))];
  const recording: Recording = {
    ...JANE_PUBLIC,
    // The login in another case than the URL: still the user's own token.
    'https://api.github.com/user': { status: 200, body: { login: 'Jane' } },
    'https://api.github.com/user/repos?affiliation=owner&per_page=100&page=1': { status: 200, body: page1 },
    'https://api.github.com/user/repos?affiliation=owner&per_page=100&page=2': { status: 200, body: [listed('jane/notes', { priv: true })] },
    ...recordRepository('jane/notes', { '.agents/skills/journal/SKILL.md': '---\nname: journal\ndescription: Keep the journal.\n---\n' }, { commit: 'n1' }),
  };
  const asked: { url: string; authorization?: string }[] = [];
  const recorded = replay(recording);
  const fetch: Fetch = (url, init) => (asked.push({ url, authorization: init?.headers?.Authorization }), recorded(url, init));
  const scanned = await atlas(['scan', 'https://github.com/jane'], { fetch, token: 'janes-token' });
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(
    scanned.stdout,
    [
      'jane · 2 skills in 2 of 2 repositories (99 forks skipped)',
      ...JANE_DOTFILES,
      'jane/notes · 1 skill',
      'journal — Keep the journal.',
      '  https://github.com/jane/notes/blob/n1/.agents/skills/journal/SKILL.md',
    ].join('\n'),
  );
  assert.deepEqual(asked.filter(({ url }) => url.includes('/users/')), [], 'the public listing is not asked for');
  for (const { url, authorization } of asked) assert.equal(authorization, 'Bearer janes-token', url);
});

test('a user with another user’s token, or a token /user refuses → /users/<owner>/repos, public repositories only, no warning', async () => {
  const answers: [string, Recorded][] = [
    ['another user', { status: 200, body: { login: 'bob' } }],
    ['a GitHub App token', { status: 403, body: { message: 'Resource not accessible by integration' } }],
  ];
  for (const [token, user] of answers) {
    // bob's /user/repos would list bob's repositories, not jane's: it must not be asked for.
    const recording: Recording = { ...JANE_PUBLIC, 'https://api.github.com/user': user };
    const scanned = await atlas(['scan', 'https://github.com/jane'], { fetch: replay(recording), token: 'test' });
    assert.equal(scanned.code, 0, `${token}: ${scanned.stderr}`);
    assert.equal(scanned.stdout, ['jane · 1 skill in 1 of 1 repository', ...JANE_DOTFILES].join('\n'), token);
    assert.equal(scanned.stderr, '', token);
  }
});

test('a user without a token: /user is not asked for', async () => {
  const asked: string[] = [];
  const recorded = replay(JANE_PUBLIC);
  const scanned = await atlas(['scan', 'https://github.com/jane'], { fetch: (url, init) => (asked.push(url), recorded(url, init)) });
  assert.equal(scanned.stdout, ['jane · 1 skill in 1 of 1 repository', ...JANE_DOTFILES].join('\n'));
  assert.ok(!asked.some((url) => /api\.github\.com\/user(\/|$)/.test(url)), asked.join('\n'));
});

test('no skills in any repository → the summary and which folders count, exit code 0', async () => {
  const recording: Recording = {
    ...NOT_AN_ORGANIZATION,
    'https://api.github.com/users/jane/repos?per_page=100&page=1': { status: 200, body: [listed('jane/a'), listed('jane/b')] },
    ...budget(60),
    ...recordRepository('jane/a', { 'skills/x/SKILL.md': MPS_TESTS }),
    ...recordRepository('jane/b', {}),
  };
  const scanned = await atlas(['scan', 'https://github.com/jane'], { fetch: replay(recording) });
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(
    scanned.stdout,
    [
      'jane · 0 skills in 0 of 2 repositories',
      'Skills count only as <root>/<name>/SKILL.md under .agents/skills, .claude/skills or .github/skills',
    ].join('\n'),
  );
});

test('--filter on an owner: the summary, then only the repositories with a match, each with its filtered header', async () => {
  // `it` is in huge's "Build it." and api's "All of it." (the full description), not in MPS.
  const scanned = await atlas(['scan', 'https://github.com/acme', '--filter', 'it'], { fetch: replay(acme()) });
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(
    scanned.stdout,
    [
      'acme · 3 skills in 3 of 5 repositories (94 forks, 1 archived and 1 empty skipped)',
      'acme/api · 1 of 1 skill match "it"',
      'api-docs — Document the API.',
      '  https://github.com/acme/api/blob/a1/.github/skills/api-docs/SKILL.md',
      'acme/huge · 1 of 1 skill match "it"',
      'build — Build it.',
      '  https://github.com/acme/huge/blob/h1/.claude/skills/build/SKILL.md',
    ].join('\n'),
  );
  // --filter before the input; a blank filter is the same as none.
  const before = await atlas(['scan', '--filter', 'it', 'https://github.com/acme'], { fetch: replay(acme()) });
  assert.equal(before.stdout, scanned.stdout);
  const blank = await atlas(['scan', 'https://github.com/acme', '--filter', '  '], { fetch: replay(acme()) });
  assert.equal(blank.stdout, ACME_STDOUT);
});

test('--filter on an owner, no match in any repository → the summary, then "No skills match", exit code 0; warnings still go to stderr', async () => {
  const scanned = await atlas(['scan', 'https://github.com/acme', '--filter', 'gradle bump'], { fetch: replay(acme()) });
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(scanned.stdout, ['acme · 3 skills in 3 of 5 repositories (94 forks, 1 archived and 1 empty skipped)', 'No skills match "gradle bump"'].join('\n'));
  assert.match(scanned.stderr, /^warning: acme\/broken: /);
});

test('--filter on an owner with no skills at all → the same as without a filter', async () => {
  const recording: Recording = {
    ...NOT_AN_ORGANIZATION,
    'https://api.github.com/users/jane/repos?per_page=100&page=1': { status: 200, body: [listed('jane/a')] },
    ...budget(60),
    ...recordRepository('jane/a', {}),
  };
  const scanned = await atlas(['scan', 'https://github.com/jane', '--filter', 'tests'], { fetch: replay(recording) });
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(
    scanned.stdout,
    [
      'jane · 0 skills in 0 of 1 repository',
      'Skills count only as <root>/<name>/SKILL.md under .agents/skills, .claude/skills or .github/skills',
    ].join('\n'),
  );
});

test('unknown owner → a clear message, exit code 1', async () => {
  const recording: Recording = {
    'https://api.github.com/orgs/nobody/repos?per_page=100&page=1': { status: 404, body: { message: 'Not Found' } },
    'https://api.github.com/users/nobody/repos?per_page=100&page=1': { status: 404, body: { message: 'Not Found' } },
  };
  const scanned = await atlas(['scan', 'https://github.com/nobody'], { fetch: replay(recording) });
  assert.equal(scanned.code, 1);
  assert.equal(scanned.stdout, '');
  assert.equal(scanned.stderr, 'Owner not found: https://github.com/nobody');
});

test('…/tree/<ref> on an owner → a clear message, exit code 1', () => {
  // The real CLI: the message comes before any request.
  for (const input of ['https://github.com/acme/tree/main', 'github.com/acme/tree/main/']) {
    const scanned = spawnSync(process.execPath, [CLI, 'scan', input], { encoding: 'utf8' });
    assert.equal(scanned.status, 1, input);
    assert.equal(scanned.stdout, '');
    assert.equal(
      scanned.stderr,
      `…/tree/<branch or commit> works only for a repository; an owner's repositories are scanned on their default branches: ${input}\n`,
    );
  }
});

test('rate limit: more repositories than the remaining budget allows → stop before scanning', async () => {
  // 6 to scan: whether one is empty shows only when it is scanned.
  const asked: string[] = [];
  const recorded = replay(acme({ remaining: 11 }));
  const fetch: Fetch = (url, init) => (asked.push(url), recorded(url, init));
  const scanned = await atlas(['scan', 'https://github.com/acme'], { fetch });
  assert.equal(scanned.code, 1);
  assert.equal(scanned.stdout, '');
  assert.equal(scanned.stderr, 'acme has 6 repositories to scan, but only 11 GitHub API requests remain (at least 2 for each); set GITHUB_TOKEN');
  assert.deepEqual(asked.filter((url) => url.includes('/repos/acme/')), []);

  const withToken = await atlas(['scan', 'https://github.com/acme'], { fetch: replay(acme({ remaining: 11 })), token: 'secret' });
  assert.equal(withToken.code, 1);
  assert.match(withToken.stderr, /^acme has 6 repositories to scan, but only 11 GitHub API requests remain \(at least 2 for each\); try again after 2026-11-18 11:06 UTC$/);

  // Exactly enough: the scan goes on.
  assert.equal((await atlas(['scan', 'https://github.com/acme'], { fetch: replay(acme({ remaining: 12 })) })).code, 0);
});

test('rate limit hit midway → the same message, exit code 1, no partial output', async () => {
  const recording = acme();
  recording['https://api.github.com/repos/acme/api/commits/main'] = {
    status: 403,
    body: { message: 'API rate limit exceeded for 192.0.2.1. (But here is the good news: ...)' },
  };
  const recorded = replay(recording);
  let budgets = 0;
  const fetch: Fetch = (url, init) => {
    // The second look at the budget, after the limit is hit, finds none left.
    if (url === 'https://api.github.com/rate_limit' && budgets++ > 0) return replay(budget(0))(url, init);
    return recorded(url, init);
  };
  const scanned = await atlas(['scan', 'https://github.com/acme'], { fetch });
  assert.equal(scanned.code, 1);
  assert.equal(scanned.stdout, '');
  assert.equal(scanned.stderr, 'acme has 6 repositories to scan, but only 0 GitHub API requests remain (at least 2 for each); set GITHUB_TOKEN');
});

test('the secondary rate limit midway → waited out; the scan goes on as if nothing happened', async () => {
  const recorded = replay(acme());
  let refused = 0;
  const waits: number[] = [];
  const fetch: Fetch = (url, init) => {
    if (url === 'https://api.github.com/repos/acme/api/commits/main' && refused++ === 0) {
      return Promise.resolve(new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit.' }), { status: 403, headers: { 'retry-after': '60' } }));
    }
    return recorded(url, init);
  };
  const scanned = await atlas(['scan', 'https://github.com/acme'], { fetch, wait: async (ms) => void waits.push(ms) });
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(scanned.stdout, ACME_STDOUT);
  assert.deepEqual(waits, [60_000]);
});

test('the secondary rate limit midway, still refused → its own message, not the budget, exit code 1, no partial output', async () => {
  const recorded = replay(acme());
  const fetch: Fetch = (url, init) =>
    url === 'https://api.github.com/repos/acme/api/commits/main'
      ? Promise.resolve(new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit.' }), { status: 403 }))
      : recorded(url, init);
  const scanned = await atlas(['scan', 'https://github.com/acme'], { fetch, token: 'secret', wait: async () => {} });
  assert.equal(scanned.code, 1);
  assert.equal(scanned.stdout, '');
  assert.equal(scanned.stderr, 'GitHub refused requests again and again for coming too fast (its secondary rate limit); try again in a few minutes');
});

test('progress: each page listed, then scanned 0 of n, one more after each repository; each wait for the secondary limit', async () => {
  const seen: Progress[] = [];
  const recorded = replay(acme());
  let refused = 0;
  const fetch: Fetch = (url, init) => {
    if (url === 'https://api.github.com/repos/acme/api/commits/main' && refused++ === 0) {
      return Promise.resolve(new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit.' }), { status: 403, headers: { 'retry-after': '45' } }));
    }
    return recorded(url, init);
  };
  await scanOwner('https://github.com/acme', { fetch, wait: async () => {}, progress: (progress) => seen.push(progress) });
  assert.deepEqual(seen.slice(0, 3), [
    { stage: 'listing', page: 1 },
    { stage: 'listing', page: 2 },
    { stage: 'scanning', done: 0, total: 6 },
  ]);
  assert.deepEqual(
    seen.filter((progress) => progress.stage === 'scanning').map((progress) => progress.done),
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(seen.filter((progress) => progress.stage === 'waiting'), [{ stage: 'waiting', seconds: 45 }]);
});

test('progress for a user: the first page told once, though /orgs/ is asked first', async () => {
  const seen: Progress[] = [];
  const recording: Recording = {
    ...NOT_AN_ORGANIZATION,
    'https://api.github.com/users/jane/repos?per_page=100&page=1': { status: 200, body: [] },
  };
  await scanOwner('https://github.com/jane', { fetch: replay({ ...recording, ...budget(5000) }), progress: (progress) => seen.push(progress) });
  assert.deepEqual(seen, [{ stage: 'listing', page: 1 }, { stage: 'scanning', done: 0, total: 0 }]);
});

test('repositories are scanned concurrently, a few at a time; the order of the output stays the same', async () => {
  const recorded = replay(acme());
  const active = new Map<string, number>();
  let most = 0;
  const fetch: Fetch = async (url, init) => {
    const repository = /\/repos\/acme\/([\w.-]+)\/|githubusercontent\.com\/acme\/([\w.-]+)\//.exec(url);
    const id = repository?.[1] ?? repository?.[2];
    if (id) active.set(id, (active.get(id) ?? 0) + 1);
    most = Math.max(most, active.size);
    // The first repositories answer last.
    await new Promise((resolve) => setTimeout(resolve, id === 'no-skills' || id === 'MPS' ? 30 : 1));
    try {
      return await recorded(url, init);
    } finally {
      if (id) {
        const left = (active.get(id) ?? 1) - 1;
        if (left) active.set(id, left);
        else active.delete(id);
      }
    }
  };
  const scanned = await atlas(['scan', 'https://github.com/acme'], { fetch });
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.ok(most > 1 && most <= 4, `${most} repositories at once`);
  assert.equal(scanned.stdout, (await atlas(['scan', 'https://github.com/acme'], { fetch: replay(acme()) })).stdout);
});

test('a local directory and a single repository are not affected', async () => {
  const single = await atlas(['scan', 'https://github.com/JetBrains/example']);
  assert.equal(single.code, 0, single.stderr);
  assert.match(single.stdout, /^JetBrains\/example · 1 skill\n/);
});
