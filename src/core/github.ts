import { AtlasError, GitHubError, RateLimitError } from './errors.ts';
import { SKILL_ROOTS } from './find.ts';
import type { Source } from './scan.ts';

/** The part of `fetch` the core uses, so tests and the browser can pass their own. */
export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

export type GitHubOptions = {
  fetch: Fetch;
  /** A higher rate limit, and private repositories. */
  token?: string;
  /** Waits out GitHub's secondary rate limit; tests pass one that does not really wait. */
  wait?: (ms: number) => Promise<void>;
  /** Told when every request starts waiting `ms` for the secondary rate limit, to show it. */
  paused?: (ms: number) => void;
};

/** Tries of a request GitHub refuses for its secondary rate limit: the first, then after each wait. */
export const SECONDARY_TRIES = 3;
/** The wait before the first retry when GitHub does not say (`retry-after`); it doubles for each one after. */
const SECONDARY_WAIT = 60_000;
/** A longer `retry-after` than this is not waited out: the scan stops. */
const LONGEST_WAIT = 5 * 60_000;

/** When GitHub's rate limit resets, from its epoch seconds: `2026-11-18 11:06 UTC`. */
export function resetTime(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

/**
 * `https://github.com/owner/repo`, with or without the scheme, a trailing slash or `.git`;
 * `…/tree/<commit or branch>` pins what is scanned.
 */
export function parseGitHubUrl(input: string): { owner: string; repo: string; ref?: string } | undefined {
  const match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/(\S+?))?\/?$/i.exec(input.trim());
  if (!match) return undefined;
  return match[3] ? { owner: match[1], repo: match[2], ref: match[3] } : { owner: match[1], repo: match[2] };
}

/**
 * `https://github.com/<owner>`, an organization or a user, with or without the scheme or a trailing slash.
 * `tree` when it goes on with `/tree/…`, which only a repository has. A repository URL is not an owner's.
 */
export function parseGitHubOwner(input: string): { owner: string; tree: boolean } | undefined {
  if (parseGitHubUrl(input)) return undefined;
  const match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)(\/tree\/\S*)?\/?$/i.exec(input.trim());
  return match ? { owner: match[1], tree: Boolean(match[2]) } : undefined;
}

/** Resolves the default branch, or the ref in the URL, to a commit and lists the files that may be skills. */
export async function openGitHub(input: string, options: GitHubOptions): Promise<Source> {
  const name = parseGitHubUrl(input);
  if (!name) throw new AtlasError(`Not a GitHub repository URL: ${input}`);
  const github = client(options);
  const info = await github.json<{ full_name: string; default_branch: string }>(
    `${API}/repos/${name.owner}/${name.repo}`,
    `Repository not found: https://github.com/${name.owner}/${name.repo}`,
  );
  return openRepository(github, info.full_name, name.ref ?? info.default_branch);
}

/** A repository whose name and ref are known: the ref resolved to a commit, and the files that may be skills. */
export async function openRepository(github: Client, id: string, ref: string): Promise<Source> {
  const { sha } = await github.json<{ sha: string }>(
    `${API}/repos/${id}/commits/${encodePath(ref)}`,
    `Not found in https://github.com/${id}: ${ref}`,
  );
  const warnings: string[] = [];
  const paths = await rootPaths(github, id, sha, warnings);
  const [organization, repo] = id.split('/');
  return {
    repository: { id, organization, name: repo, url: `https://github.com/${id}`, commit: sha },
    paths,
    warnings,
    read: (path) => github.raw(`${RAW}/${id}/${sha}/${encodePath(path)}`),
  };
}

type Tree = { truncated: boolean; tree: { path: string; mode: string; type: string; sha: string }[] };

/**
 * Only the skill roots count, so only they are listed: a few requests, whatever the repository's
 * size, at any commit. Code search would miss repositories it has not indexed, such as large
 * monorepos, and answer "nothing" without an error; the whole tree is cut off for large ones.
 */
async function rootPaths(github: Client, id: string, sha: string, warnings: string[]): Promise<string[]> {
  const listed = await Promise.all(
    SKILL_ROOTS.map(async (root) => {
      const rootSha = await directory(github, id, sha, root);
      if (!rootSha) return [];
      const subtree = await github.json<Tree>(`${API}/repos/${id}/git/trees/${rootSha}?recursive=1`);
      if (subtree.truncated) warnings.push(`${root} has too many files to list at once; some of its skills may be missing`);
      return files(subtree).map((path) => `${root}/${path}`);
    }),
  );
  return listed.flat();
}

/** Walks down one level at a time; the directory's tree, or undefined if it does not exist. */
async function directory(github: Client, id: string, sha: string, path: string): Promise<string | undefined> {
  let current = sha;
  for (const segment of path.split('/')) {
    const tree = await github.json<Tree>(`${API}/repos/${id}/git/trees/${current}`);
    const entry = tree.tree.find((item) => item.path === segment && item.type === 'tree');
    if (!entry) return undefined;
    current = entry.sha;
  }
  return current;
}

/** Regular files only: a symbolic link's content is its target, not a SKILL.md. */
function files(tree: Tree): string[] {
  return tree.tree.filter((item) => item.type === 'blob' && item.mode !== '120000').map((item) => item.path);
}

export type Client = ReturnType<typeof client>;

/**
 * GitHub API requests with the token, each URL asked for once; errors explained as AtlasErrors.
 * GitHub's secondary rate limit, for too many requests in a short time, pauses every request of the client
 * for as long as GitHub asks, then the refused one is tried again.
 */
export function client({ fetch, token, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), paused: onPause }: GitHubOptions) {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const answers = new Map<string, Promise<unknown>>(); // the root tree is asked for once per skill root
  let paused: Promise<void> = Promise.resolve();
  let pausedUntil = 0;

  /** Holds back every request until `ms` from now, unless a longer pause is already on. */
  function pause(ms: number) {
    const until = Date.now() + ms;
    if (until <= pausedUntil) return;
    pausedUntil = until;
    paused = wait(ms);
    onPause?.(ms);
  }

  async function get(url: string, init?: { headers: Record<string, string> }): Promise<Response> {
    await paused;
    try {
      return await fetch(url, init);
    } catch (error) {
      throw new AtlasError(`Cannot reach GitHub: ${describe(error)}`);
    }
  }

  async function request(url: string, notFound: string, tries = 1): Promise<unknown> {
    const response = await get(url, { headers });
    if (response.ok) return response.json();
    const body: unknown = await response.json().catch(() => undefined);
    const message = (body as { message?: unknown } | undefined)?.message;
    const text = typeof message === 'string' ? message : '';
    if (response.status === 404) throw new GitHubError(404, notFound);
    const retryAfter = Number(response.headers.get('retry-after') ?? NaN);
    if ((response.status === 403 || response.status === 429) && (/rate limit/i.test(text) || retryAfter >= 0)) {
      // The hourly budget says 0 left, or GitHub says so in the message; otherwise requests came too fast.
      const remaining = response.headers.get('x-ratelimit-remaining');
      const secondary = /secondary rate limit/i.test(text) || (remaining !== '0' && !/API rate limit exceeded/i.test(text));
      if (!secondary) {
        const reset = Number(response.headers.get('x-ratelimit-reset') ?? NaN);
        const next = !token ? 'set GITHUB_TOKEN' : reset > 0 ? `try again after ${resetTime(reset)}` : 'try again when it resets, within the hour';
        throw new RateLimitError(`GitHub rate limit reached; ${next}`);
      }
      const ms = retryAfter >= 0 ? retryAfter * 1000 : SECONDARY_WAIT * 2 ** (tries - 1);
      if (tries >= SECONDARY_TRIES || ms > LONGEST_WAIT) {
        throw new RateLimitError('GitHub refused requests again and again for coming too fast (its secondary rate limit); try again in a few minutes');
      }
      pause(ms);
      return request(url, notFound, tries + 1);
    }
    if (response.status === 401) throw new GitHubError(401, 'GitHub rejected the token in GITHUB_TOKEN');
    throw new GitHubError(response.status, `GitHub answered ${response.status} for ${url}${text && `: ${text}`}`);
  }

  return {
    /** A GitHub API answer; `notFound` explains a 404. */
    json<T>(url: string, notFound = `Not found on GitHub: ${url}`): Promise<T> {
      if (!answers.has(url)) answers.set(url, request(url, notFound));
      return answers.get(url) as Promise<T>;
    },
    /** A GitHub API answer asked for again each time, such as the rate limit left. */
    fresh<T>(url: string): Promise<T> {
      return request(url, `Not found on GitHub: ${url}`) as Promise<T>;
    },
    token,
    /** A file's bytes at the scanned commit, or undefined if it is not there. */
    async raw(url: string): Promise<Uint8Array | undefined> {
      // A private repository's files need the token too.
      const response = await get(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
      if (response.status === 404) return undefined;
      if (!response.ok) throw new AtlasError(`GitHub answered ${response.status} for ${url}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}
