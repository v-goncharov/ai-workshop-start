import { AtlasError, GitHubError, RateLimitError } from './errors.ts';
import { client, openBranch, resetTime, parseGitHubOwner, type Client, type GitHubOptions } from './github.ts';
import { scan, type ScanResult } from './scan.ts';

/** Every repository of an organization or a user, scanned. */
export type OwnerResult = {
  owner: { id: string; url: string };
  /** How many repositories were scanned: neither forks, archived nor empty. */
  scanned: number;
  /** The scanned repositories with skills, sorted by name. */
  repositories: ScanResult[];
  skipped: { forks: number; archived: number; empty: number };
  /** Each starts with the repository it is about. */
  warnings: string[];
};

/** How far an owner scan is: listing the repositories, scanning them, or waiting for GitHub's secondary rate limit. */
export type Progress =
  | { stage: 'listing'; page: number }
  | { stage: 'scanning'; done: number; total: number }
  | { stage: 'waiting'; seconds: number };

export type OwnerOptions = GitHubOptions & {
  /** How many repositories are scanned, and pages of them listed, at once. */
  concurrency?: number;
  /** Told as the scan goes: each page listed, each repository scanned, each wait. */
  progress?: (progress: Progress) => void;
};

/** The least a repository's scan asks the API for: its branch's top-level tree, which names the commit too. */
const REQUESTS_PER_REPOSITORY = 1;
/** Repositories scanned, and pages listed, at once. */
const CONCURRENCY = 8;

const API = 'https://api.github.com';
const PAGE = 100;

type Listed = { full_name: string; default_branch: string; fork: boolean; archived: boolean };

/**
 * `https://github.com/<owner>`: each repository on its default branch, scanned as a single one is.
 * Forks, archived and empty repositories are skipped; a repository that fails is a warning.
 * The rate limit stops the whole scan, before it starts if the budget cannot cover it.
 */
export async function scanOwner(input: string, options: OwnerOptions): Promise<OwnerResult> {
  const name = parseGitHubOwner(input);
  if (!name) throw new AtlasError(`Not a GitHub owner URL: ${input}`);
  if (name.tree) {
    throw new AtlasError(`…/tree/<branch or commit> works only for a repository; an owner's repositories are scanned on their default branches: ${input}`);
  }
  const progress = options.progress ?? (() => {});
  const github = client({ ...options, paused: (ms) => progress({ stage: 'waiting', seconds: Math.ceil(ms / 1000) }) });
  // A user's first page is asked for twice, after /orgs/ answers 404: told once.
  let pages = 0;
  const concurrency = options.concurrency ?? CONCURRENCY;
  const listed = await listRepositories(github, name.owner, concurrency, (page) => page > pages && progress({ stage: 'listing', page: (pages = page) }));
  const id = listed[0]?.full_name.split('/')[0] ?? name.owner;
  const forks = listed.filter((repository) => repository.fork);
  const archived = listed.filter((repository) => !repository.fork && repository.archived);
  const candidates = listed.filter((repository) => !repository.fork && !repository.archived);

  const tooMany = async (count: number) => {
    const { resources } = await github.fresh<{ resources: { core: { remaining: number; reset: number } } }>(`${API}/rate_limit`);
    const { remaining, reset } = resources.core;
    if (remaining >= count * REQUESTS_PER_REPOSITORY) return undefined;
    const next = options.token ? `try again after ${resetTime(reset)}` : 'set GITHUB_TOKEN';
    return `${id} has ${plural(count, 'repository', 'repositories')} to scan, but only ${remaining} GitHub API requests remain (at least ${REQUESTS_PER_REPOSITORY} for each); ${next}`;
  };
  const before = await tooMany(candidates.length);
  if (before) throw new RateLimitError(before);

  let results: Awaited<ReturnType<typeof scanOne>>[];
  let done = 0;
  progress({ stage: 'scanning', done, total: candidates.length });
  try {
    results = await inTurns(candidates, concurrency, async (repository) => {
      const result = await scanOne(github, repository);
      progress({ stage: 'scanning', done: ++done, total: candidates.length });
      return result;
    });
  } catch (error) {
    if (!(error instanceof RateLimitError)) throw error;
    // Hit midway: the same message as before scanning, with what is left now.
    throw new RateLimitError((await tooMany(candidates.length).catch(() => undefined)) ?? error.message);
  }

  const scanned = results.filter((result) => result.kind !== 'empty');
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    owner: { id, url: `https://github.com/${id}` },
    scanned: scanned.length,
    repositories: scanned
      .flatMap((result) => (result.kind === 'scanned' && result.scan.skills.length > 0 ? [result.scan] : []))
      .sort((a, b) => compare(a.repository.id, b.repository.id)),
    skipped: { forks: forks.length, archived: archived.length, empty: results.length - scanned.length },
    warnings: scanned.flatMap((result) =>
      result.kind === 'failed' ? [result.warning] : result.scan.warnings.map((warning) => `${result.scan.repository.id}: ${warning}`),
    ),
  };
}

/**
 * Every page of `/orgs/<owner>/repos`; if the owner is not an organization, of `/users/<owner>/repos`, which has only
 * a user's public repositories, or of `/user/repos?affiliation=owner` when the token is that user's own, with their private ones.
 */
async function listRepositories(github: Client, owner: string, concurrency: number, listing: (page: number) => void): Promise<Listed[]> {
  const url = (path: string, number: number) => `${API}/${path}per_page=${PAGE}&page=${number}`;
  const page = (path: string, number: number) => (listing(number), github.json<Listed[]>(url(path, number)));
  let path = `orgs/${encodeURIComponent(owner)}/repos?`;
  let first: Listed[];
  try {
    first = await page(path, 1);
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 404)) throw error;
    path = (await isTokenOf(github, owner)) ? 'user/repos?affiliation=owner&' : `users/${encodeURIComponent(owner)}/repos?`;
    first = await page(path, 1).catch((error: unknown) => {
      if (error instanceof GitHubError && error.status === 404) throw new AtlasError(`Owner not found: https://github.com/${owner}`);
      throw error;
    });
  }
  const all = [...first];
  // GitHub names the last page (`Link: <…&page=21>; rel="last"`): the others are asked for at once, told as they come.
  const lastPage = Number(/[?&]page=(\d+)>;\s*rel="last"/.exec(github.link(url(path, 1)) ?? '')?.[1] ?? NaN);
  if (lastPage > 1) {
    let pages = 1;
    const rest = await inTurns(
      Array.from({ length: lastPage - 1 }, (_, index) => index + 2),
      concurrency,
      async (number) => {
        const listed = await github.json<Listed[]>(url(path, number));
        listing(++pages);
        return listed;
      },
    );
    return all.concat(...rest);
  }
  for (let number = 2, last = first; last.length === PAGE; number++) {
    last = await page(path, number);
    all.push(...last);
  }
  return all;
}

/** Whether GITHUB_TOKEN is the user's own (`/user` names them); not for a token `/user` refuses, such as a GitHub App's. */
async function isTokenOf(github: Client, owner: string): Promise<boolean> {
  if (!github.token) return false;
  try {
    const { login } = await github.json<{ login: string }>(`${API}/user`);
    return login.toLowerCase() === owner.toLowerCase();
  } catch (error) {
    if (error instanceof GitHubError) return false;
    throw error;
  }
}

type OneResult = { kind: 'scanned'; scan: ScanResult } | { kind: 'failed'; warning: string } | { kind: 'empty' };

/** One repository, as a single one is scanned; its failure is a warning, the rate limit is not. */
async function scanOne(github: Client, repository: Listed): Promise<OneResult> {
  try {
    return { kind: 'scanned', scan: await scan(await openBranch(github, repository.full_name, repository.default_branch)) };
  } catch (error) {
    if (error instanceof RateLimitError) throw error;
    // GitHub has no commit for an empty repository: "409 Git Repository is empty."
    if (error instanceof GitHubError && error.status === 409) return { kind: 'empty' };
    if (error instanceof AtlasError) return { kind: 'failed', warning: `${repository.full_name}: ${error.message}; skipped` };
    throw error;
  }
}

/** `work` on each item, `limit` at a time, the results in the items' order; the first failure stops what has not started. */
async function inTurns<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await work(items[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  // Settled, so nothing is still running when the failure is thrown.
  const workers = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
  const failure = workers.find((outcome) => outcome.status === 'rejected');
  if (failure) throw failure.reason;
  return results;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
