// The skill-atlas commands. The same code serves the Node CLI and the browser
// terminal: everything that differs between them comes in through the context.
import { AtlasError } from './core/errors.ts';
import { SKILL_ROOTS } from './core/find.ts';
import { parseGitHubOwner } from './core/github.ts';
import { firstSentence, skillLink, type Repository, type Skill } from './core/model.ts';
import type { OwnerResult } from './core/owner.ts';
import { scan, type Source } from './core/scan.ts';

export type Context = {
  /** Opens what the user asked to scan. */
  open(input: string): Promise<Source>;
  /** Scans every repository of a GitHub organization or user. */
  scanOwner?(input: string): Promise<OwnerResult>;
  print(text: string): void;
  /** Errors and warnings. */
  error(text: string): void;
  /** Starts the web view on the port (0: any free one) and returns its address; Node only. */
  serve?(port: number): Promise<string>;
};

const usage = `Usage: skill-atlas <command>

  scan <GitHub URL | directory>   find every SKILL.md in a repository and print it;
                                  https://github.com/<owner>: in every repository of an organization or user
  serve [--port <n>]              open the web view at http://127.0.0.1:<n> (4400 by default)
  help                            show this help`;

/** Runs one command; returns its exit code. */
export async function run(args: string[], context: Context): Promise<number> {
  const [command = 'help', ...rest] = args;
  try {
    if (command === 'scan') await scanCommand(rest, context);
    else if (command === 'serve') await serveCommand(rest, context);
    else if (command === 'help') context.print(usage);
    else throw new AtlasError(`Unknown command: ${command}\n\n${usage}`);
    return 0;
  } catch (error) {
    if (!(error instanceof AtlasError)) throw error;
    context.error(error.message);
    return 1;
  }
}

async function scanCommand(args: string[], context: Context) {
  if (args.length !== 1) throw new AtlasError('Usage: skill-atlas scan <GitHub URL | directory>');
  if (parseGitHubOwner(args[0]) && context.scanOwner) return printOwner(await context.scanOwner(args[0]), context);
  const result = await scan(await context.open(args[0]));
  printRepository(result.repository, result.skills, context);
  for (const warning of result.warnings) context.error(`warning: ${warning}`);
}

export const DEFAULT_PORT = 4400;

async function serveCommand(args: string[], context: Context) {
  const usage = 'Usage: skill-atlas serve [--port <n>]';
  let port = DEFAULT_PORT;
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1]) || Number(args[1]) > 65535) throw new AtlasError(usage);
    port = Number(args[1]);
  }
  if (!context.serve) throw new AtlasError('serve runs only from the command line: ./skill-atlas serve');
  const address = await context.serve(port);
  context.print(`Skill Atlas is at ${address}; Ctrl+C stops it`);
}

/** The summary, then each repository with skills as a single one is printed; no skills → which folders count. */
function printOwner(result: OwnerResult, context: Context) {
  const skills = result.repositories.reduce((count, { skills }) => count + skills.length, 0);
  const { forks, archived, empty } = result.skipped;
  const skipped = [forks && plural(forks, 'fork', 'forks'), archived && `${archived} archived`, empty && `${empty} empty`].filter(Boolean);
  context.print(
    `${result.owner.id} · ${plural(skills, 'skill', 'skills')} in ${result.repositories.length} of ${plural(result.scanned, 'repository', 'repositories')}` +
      (skipped.length > 0 ? ` (${skipped.join(', ').replace(/, ([^,]*)$/, ' and $1')} skipped)` : ''),
  );
  if (skills === 0) {
    const roots = SKILL_ROOTS.join(', ').replace(/, ([^,]*)$/, ' or $1');
    context.print(`Skills count only as <root>/<name>/SKILL.md under ${roots}`);
  }
  for (const { repository, skills } of result.repositories) printRepository(repository, skills, context);
  for (const warning of result.warnings) context.error(`warning: ${warning}`);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** `<owner>/<repo> · N skills`, then each skill's name, first sentence and link. */
function printRepository(repository: Repository, skills: Skill[], { print }: Context) {
  print(`${repository.id} · ${plural(skills.length, 'skill', 'skills')}`);
  for (const skill of skills) {
    print(skill.description ? `${skill.name} — ${firstSentence(skill.description)}` : skill.name);
    print(`  ${skillLink(repository, skill)}`);
    if (skill.copies.length > 0) print(`  also in ${skill.copies.join(', ')}`);
  }
}
