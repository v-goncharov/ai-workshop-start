// Runs the commands the way the CLI does, with GitHub answering from EXAMPLE below.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from '../src/commands.ts';
import { openGitHub, parseGitHubUrl } from '../src/core/github.ts';
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

/** `skill-atlas <args>`, as the CLI runs it, with GitHub answering from EXAMPLE. */
export async function atlas(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(args, {
    open,
    print: (text) => stdout.push(text),
    error: (text) => stderr.push(text),
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
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
