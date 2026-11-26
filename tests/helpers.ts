// Runs the commands the way the CLI does, with GitHub answering from EXAMPLE below.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from '../src/commands.ts';
import { openGitHub, parseGitHubUrl, type GitHubOptions } from '../src/core/github.ts';
import { scanOwner, type Progress } from '../src/core/owner.ts';
import { replay, type Recording } from '../src/core/replay.ts';
import { openDirectory } from '../src/local.ts';

export const FIXTURE = fileURLToPath(new URL('../fixture', import.meta.url));
export const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

/** The commit GitHub answers for JetBrains/example. */
export const EXAMPLE_COMMIT = '5ab6270ab772d113e8ad52ebfcaa0109c522ae00';

/** What GitHub answers for a small repository, JetBrains/example, with one skill. */
const EXAMPLE: Recording = {
  'https://api.github.com/repos/JetBrains/example': { status: 200, body: { full_name: 'JetBrains/example', default_branch: 'main' } },
  'https://api.github.com/repos/JetBrains/example/commits/main': { status: 200, body: { sha: EXAMPLE_COMMIT } },
  // Only the skill roots are listed: the top of the tree, then down to each root that is there.
  [`https://api.github.com/repos/JetBrains/example/git/trees/${EXAMPLE_COMMIT}`]: {
    status: 200,
    body: { truncated: false, tree: [{ path: '.claude', mode: '040000', type: 'tree', sha: 'claude' }, { path: 'README.md', mode: '100644', type: 'blob', sha: 'readme' }] },
  },
  'https://api.github.com/repos/JetBrains/example/git/trees/claude': {
    status: 200,
    body: { truncated: false, tree: [{ path: 'skills', mode: '040000', type: 'tree', sha: 'claude-skills' }] },
  },
  'https://api.github.com/repos/JetBrains/example/git/trees/claude-skills?recursive=1': {
    status: 200,
    body: {
      truncated: false,
      tree: [
        { path: 'commits', mode: '040000', type: 'tree', sha: 'commits' },
        { path: 'commits/SKILL.md', mode: '100644', type: 'blob', sha: 'skill' },
      ],
    },
  },
  [`https://raw.githubusercontent.com/JetBrains/example/${EXAMPLE_COMMIT}/.claude/skills/commits/SKILL.md`]: {
    status: 200,
    body: '---\nname: commits\ndescription: Write commit messages the way this repository does. Use for every commit.\n---\n# Commits\n',
  },
};

const github = replay(EXAMPLE);

/** Opens a GitHub URL or a directory as the CLI does, with GitHub answering from EXAMPLE. */
export const open = (input: string) =>
  parseGitHubUrl(input) ? openGitHub(input, { fetch: github, token: 'test' }) : openDirectory(input);

/** Opens and scans as the CLI does, with GitHub answering as given. */
export function contextFor(github: GitHubOptions) {
  return {
    open: (input: string) => (parseGitHubUrl(input) ? openGitHub(input, github) : openDirectory(input)),
    scanOwner: (input: string, progress?: (progress: Progress) => void) => scanOwner(input, { ...github, progress }),
  };
}

/** `skill-atlas <args>`, as the CLI runs it, with GitHub answering from EXAMPLE, or as given. */
export async function atlas(args: string[], github: GitHubOptions = { fetch: replay(EXAMPLE), token: 'test' }) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(args, {
    ...contextFor(github),
    print: (text) => stdout.push(text),
    error: (text) => stderr.push(text),
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

/** A recorded repository: its files at `commit`, on `branch`. Only the skill roots are answered, as GitHub would be asked. */
export function recordRepository(id: string, files: Record<string, string>, { commit = 'c0ffee', branch = 'main', truncated = false } = {}): Recording {
  const api = `https://api.github.com/repos/${id}`;
  const recording: Recording = { [`${api}/commits/${branch}`]: { status: 200, body: { sha: commit } } };
  const tops = new Set(Object.keys(files).map((path) => path.split('/')[0]));
  const dir = (path: string, sha: string) => ({ path, mode: '040000', type: 'tree', sha });
  recording[`${api}/git/trees/${commit}`] = {
    status: 200,
    body: { truncated: false, tree: [...tops].map((top) => dir(top, `${commit}-${top}`)).concat([{ path: 'README.md', mode: '100644', type: 'blob', sha: 'readme' }]) },
  };
  for (const top of tops) {
    const roots = new Set(Object.keys(files).filter((path) => path.startsWith(`${top}/`)).map((path) => path.split('/')[1]));
    recording[`${api}/git/trees/${commit}-${top}`] = { status: 200, body: { truncated: false, tree: [...roots].map((root) => dir(root, `${commit}-${top}-${root}`)) } };
    for (const root of roots) {
      const prefix = `${top}/${root}/`;
      const inside = Object.keys(files).filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
      recording[`${api}/git/trees/${commit}-${top}-${root}?recursive=1`] = {
        status: 200,
        body: { truncated, tree: inside.map((path) => ({ path, mode: '100644', type: 'blob', sha: path })) },
      };
    }
  }
  for (const [path, content] of Object.entries(files)) {
    recording[`https://raw.githubusercontent.com/${id}/${commit}/${path}`] = { status: 200, body: content };
  }
  return recording;
}

/** A repository as GitHub lists it under its owner. */
export function listed(id: string, { fork = false, archived = false, priv = false, branch = 'main' } = {}) {
  return { full_name: id, name: id.split('/')[1], owner: { login: id.split('/')[0] }, fork, archived, private: priv, default_branch: branch };
}

/** What `/rate_limit` answers. 1795000000 is 2026-11-18 11:06:40 UTC. */
export function budget(remaining: number): Recording {
  return { 'https://api.github.com/rate_limit': { status: 200, body: { resources: { core: { limit: 5000, remaining, reset: 1795000000 } } } } };
}

const ACME_SKILL = '---\nname: mps-tests\ndescription: Run the MPS tests.\n---\n';
const ORGS = 'https://api.github.com/orgs/acme/repos?per_page=100';

/** 94 forks fill the first page, so the second one has to be asked for. */
const FORKS = Array.from({ length: 94 }, (_, index) => listed(`acme/fork-${String(index).padStart(2, '0')}`, { fork: true }));

/**
 * acme: two pages of repositories. With skills: MPS (a duplicate), api (on the second page), huge (a root too large)
 * and secret (private, with a token only). Without: no-skills; empty; broken (fails); old (archived); 94 forks.
 */
export function acme({ token = false, remaining = 5000 } = {}): Recording {
  const page1 = [
    listed('acme/no-skills'),
    listed('acme/MPS', { branch: 'master' }),
    listed('acme/empty'),
    listed('acme/broken'),
    listed('acme/old', { archived: true }),
    listed('acme/huge'),
    ...FORKS,
  ];
  const page2 = [listed('acme/api'), ...(token ? [listed('acme/secret', { priv: true })] : [])];
  return {
    [`${ORGS}&page=1`]: { status: 200, body: page1 },
    [`${ORGS}&page=2`]: { status: 200, body: page2 },
    ...budget(remaining),
    ...recordRepository('acme/no-skills', { 'src/main.ts': '', '.github/workflows/ci.yml': '' }),
    ...recordRepository('acme/MPS', { '.agents/skills/mps-tests/SKILL.md': ACME_SKILL, '.claude/skills/mps-tests/SKILL.md': ACME_SKILL }, { branch: 'master', commit: 'mps1' }),
    'https://api.github.com/repos/acme/empty/commits/main': { status: 409, body: { message: 'Git Repository is empty.' } },
    'https://api.github.com/repos/acme/broken/commits/main': { status: 200, body: { sha: 'b0' } },
    'https://api.github.com/repos/acme/broken/git/trees/b0': { status: 500, body: { message: 'Server Error' } },
    ...recordRepository('acme/huge', { '.claude/skills/build/SKILL.md': '---\nname: build\ndescription: Build it.\n---\n' }, { commit: 'h1', truncated: true }),
    ...recordRepository('acme/api', { '.github/skills/api-docs/SKILL.md': '---\nname: api-docs\ndescription: Document the API. All of it.\n---\n' }, { commit: 'a1' }),
    ...(token ? recordRepository('acme/secret', { '.claude/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Deploy.\n---\n' }, { commit: 's1' }) : {}),
  };
}

/** What the filter is tried on (tests/filter.test.ts, tests/web.test.ts): words in each field, a copy, and a full description. */
export const SKILLS: Record<string, string> = {
  '.claude/skills/build-tools-bump-gradle-api/SKILL.md':
    '---\nname: build-tools-bump-gradle-api\ndescription: Bumps the Gradle API version that Kotlin Gradle plugins are compiled against. Use it after each Gradle release.\n---\n',
  '.claude/skills/commits/SKILL.md': '---\nname: commits\ndescription: Write commit messages the way this repository does. Use for every commit.\n---\n',
  '.agents/skills/mps-tests/SKILL.md': '---\nname: mps-tests\ndescription: Run the MPS tests.\n---\n',
  '.github/skills/mps-tests/SKILL.md': '---\nname: mps-tests\ndescription: Run the MPS tests.\n---\n',
};

/** A repository named `repo` with the given files, removed after the test. */
export function repository(t: TestContext, files: Record<string, string> = SKILLS) {
  const root = join(mkdtempSync(join(tmpdir(), 'skill-atlas-')), 'repo');
  t.after(() => rmSync(dirname(root), { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { root, url: pathToFileURL(root).href };
}
