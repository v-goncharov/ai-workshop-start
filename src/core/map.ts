// The skill map (spec/map.md): the skills grouped by what they are about, by Claude. This module builds the prompt and
// reads the answer; running `claude -p` is up to the caller (src/claude.ts in Node), so the tests replay a recorded answer.
import { AtlasError } from './errors.ts';

/** What the map needs of a skill. */
export type MapSkill = { id: string; name: string; description: string };

/** The groups, in the map's order, each with the ids of its skills in the order they were given. */
export type SkillMap = { groups: { name: string; skills: string[] }[] };

/** Asks Claude: the prompt in, the answer's text out. Fails with an AtlasError explaining why. */
export type AskClaude = (prompt: string) => Promise<string>;

export const OTHER = 'Other';

/** The prompt: each skill's id, name and full description, and the answer's shape. */
export function mapPrompt(skills: MapSkill[]): string {
  return [
    'Group these agent skills by what they are about, so a person can read a long list at a glance.',
    'Give each group a short name (one to three words). Put every skill in exactly one group;',
    `a skill that fits no group goes in a group named "${OTHER}".`,
    'Answer with JSON only, no other text, in exactly this shape:',
    '{"groups":[{"name":"<group name>","skills":["<skill id>"]}]}',
    '',
    'The skills, one JSON object per line:',
    ...skills.map(({ id, name, description }) => JSON.stringify({ id, name, description: description.trim() })),
  ].join('\n');
}

/**
 * Claude's answer as a map of `skills`: every skill exactly once. Invented ids are dropped, one given twice stays in its
 * first group, forgotten ones go to Other (last, with any group Claude named Other); empty groups are dropped, groups
 * with the same name merged. The skills keep their order in `skills` inside each group.
 */
export function readMap(answer: string, skills: MapSkill[]): SkillMap {
  const groups = parse(answer);
  const order = new Map(skills.map((skill, index) => [skill.id, index]));
  const placed = new Set<string>();
  const named = new Map<string, { name: string; skills: string[] }>();
  const other: string[] = [];
  for (const group of groups) {
    const ids = group.skills.filter((id): id is string => typeof id === 'string' && order.has(id) && !placed.has(id));
    for (const id of ids) placed.add(id);
    const name = group.name.replace(/\s+/g, ' ').trim();
    if (name.toLowerCase() === OTHER.toLowerCase()) other.push(...ids);
    else if (named.has(name)) named.get(name)!.skills.push(...ids);
    else named.set(name, { name, skills: ids });
  }
  other.push(...skills.map(({ id }) => id).filter((id) => !placed.has(id)));
  const sorted = (ids: string[]) => [...ids].sort((a, b) => order.get(a)! - order.get(b)!);
  return {
    groups: [...named.values(), { name: OTHER, skills: other }]
      .filter((group) => group.skills.length > 0)
      .map((group) => ({ name: group.name, skills: sorted(group.skills) })),
  };
}

/** The map of `skills`, from Claude; none → no groups, and Claude is not asked. */
export async function mapSkills(skills: MapSkill[], ask: AskClaude): Promise<SkillMap> {
  if (skills.length === 0) return { groups: [] };
  return readMap(await ask(mapPrompt(skills)), skills);
}

const NOT_A_MAP = "claude's answer is not a skill map";

/** The groups in the answer: its JSON, from the first `{` to the last `}`, so a code fence or a sentence around it does no harm. */
function parse(answer: string): { name: string; skills: unknown[] }[] {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start === -1 || end < start) throw new AtlasError(NOT_A_MAP);
  let json: unknown;
  try {
    json = JSON.parse(answer.slice(start, end + 1));
  } catch {
    throw new AtlasError(NOT_A_MAP);
  }
  const groups = (json as { groups?: unknown })?.groups;
  if (!Array.isArray(groups)) throw new AtlasError(NOT_A_MAP);
  for (const group of groups) {
    if (typeof group?.name !== 'string' || !group.name.trim() || !Array.isArray(group.skills)) throw new AtlasError(NOT_A_MAP);
  }
  return groups;
}
