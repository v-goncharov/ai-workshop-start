import { AtlasError, GitHubError, RateLimitError } from './errors.ts';
import { client, openRepository, parseGitHubOwner, type Client, type GitHubOptions } from './github.ts';
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

export type OwnerOptions = GitHubOptions & {
  /** How many repositories are scanned at once. */
  concurrency?: number;
};

/** The least a repository's scan asks the API for: its commit and its top-level tree. */
const REQUESTS_PER_REPOSITORY = 2;

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
  const github = client(options);
  const listed = await listRepositories(github, name.owner);
  const id = listed[0]?.full_name.split('/')[0] ?? name.owner;
  const forks = listed.filter((repository) => repository.fork);
  const archived = listed.filter((repository) => !repository.fork && repository.archived);
  const candidates = listed.filter((repository) => !repository.fork && !repository.archived);

  const tooMany = async (count: number) => {
    const { resources } = await github.fresh<{ resources: { core: { remaining: number; reset: number } } }>(`${API}/rate_limit`);
    const { remaining, reset } = resources.core;
    if (remaining >= count * REQUESTS_PER_REPOSITORY) return undefined;
    const next = options.token ? `try again after ${new Date(reset * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'set GITHUB_TOKEN';
    return `${id} has ${plural(count, 'repository', 'repositories')} to scan, but only ${remaining} GitHub API requests remain (at least ${REQUESTS_PER_REPOSITORY} for each); ${next}`;
  };
  const before = await tooMany(candidates.length);
  if (before) throw new RateLimitError(before);

  let results: Awaited<ReturnType<typeof scanOne>>[];
  try {
    results = await inTurns(candidates, options.concurrency ?? 4, (repository) => scanOne(github, repository));
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

/** Every page of `/orgs/<owner>/repos`, or of `/users/<owner>/repos` if the owner is not an organization. */
async function listRepositories(github: Client, owner: string): Promise<Listed[]> {
  const page = (kind: string, number: number) => github.json<Listed[]>(`${API}/${kind}/${encodeURIComponent(owner)}/repos?per_page=${PAGE}&page=${number}`);
  let kind = 'orgs';
  let first: Listed[];
  try {
    first = await page(kind, 1);
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 404)) throw error;
    kind = 'users';
    first = await page(kind, 1).catch((error: unknown) => {
      if (error instanceof GitHubError && error.status === 404) throw new AtlasError(`Owner not found: https://github.com/${owner}`);
      throw error;
    });
  }
  const all = [...first];
  for (let number = 2, last = first; last.length === PAGE; number++) {
    last = await page(kind, number);
    all.push(...last);
  }
  return all;
}

type OneResult = { kind: 'scanned'; scan: ScanResult } | { kind: 'failed'; warning: string } | { kind: 'empty' };

/** One repository, as a single one is scanned; its failure is a warning, the rate limit is not. */
async function scanOne(github: Client, repository: Listed): Promise<OneResult> {
  try {
    return { kind: 'scanned', scan: await scan(await openRepository(github, repository.full_name, repository.default_branch)) };
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
