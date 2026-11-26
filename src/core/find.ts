/** A skill found in a repository: its SKILL.md, its name and its copies. */
export type SkillFile = { path: string; name: string; copies: string[] };

/** Where agents keep a repository's own skills, in the order that picks a skill's main path. */
export const SKILL_ROOTS = ['.agents/skills', '.claude/skills', '.github/skills'];

/**
 * The repository's own skills: `<skill root>/<name>/SKILL.md`, named after the directory.
 * Anything else — other folders, deeper files, product skills, test data — is not one.
 * Sorted by root order, then by path, so the first of any duplicates is its main path.
 */
export function findSkills(paths: string[]): SkillFile[] {
  return SKILL_ROOTS.flatMap((root) =>
    paths
      .filter((path) => path.startsWith(`${root}/`))
      .map((path) => path.slice(root.length + 1).split('/'))
      .filter((segments) => segments.length === 2 && segments[1] === 'SKILL.md')
      .map(([name]) => ({ path: `${root}/${name}/SKILL.md`, name, copies: [] }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
}
