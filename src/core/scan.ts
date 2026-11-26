import { findSkills, type SkillFile } from './find.ts';
import { sortSkills, type Repository, type Skill } from './model.ts';
import { parseSkill } from './parse.ts';

/** A repository to scan: its files, and how to read them. */
export type Source = {
  repository: Repository;
  /** Every file path, relative to the repository root. */
  paths: string[];
  /** What listing the files had to leave out. */
  warnings: string[];
  /** The file's bytes, or undefined if it is not there. */
  read(path: string): Promise<Uint8Array | undefined>;
};

export type ScanResult = { repository: Repository; skills: Skill[]; warnings: string[] };

/** fetch → find → parse. Nothing is stored: the result is all there is. */
export async function scan(source: Source): Promise<ScanResult> {
  const files = findSkills(source.paths);
  // The files are read at the same time: on GitHub, each one is a request.
  const contents = await Promise.all(files.map((file) => source.read(file.path)));
  const results = merge(files, contents).map(({ file, bytes }) => readSkill(source, file, bytes));
  return {
    repository: source.repository,
    skills: sortSkills(results.flatMap((result) => (result.skill ? [result.skill] : []))),
    warnings: [...source.warnings, ...results.flatMap((result) => (result.warning ? [result.warning] : []))],
  };
}

/**
 * The same name and identical content in several roots is one skill: the first, in root order,
 * is its main path, the others its copies. Different content stays separate skills.
 */
function merge(files: SkillFile[], contents: (Uint8Array | undefined)[]) {
  const merged: { file: SkillFile; bytes?: Uint8Array }[] = [];
  const byKey = new Map<string, SkillFile>();
  files.forEach((file, index) => {
    const bytes = contents[index];
    const key = bytes && `${file.name}\0${new TextDecoder().decode(bytes)}`;
    const main = key ? byKey.get(key) : undefined;
    if (main) return void main.copies.push(file.path);
    const own = { ...file, copies: [] };
    if (key) byKey.set(key, own);
    merged.push({ file: own, bytes });
  });
  return merged;
}

function readSkill(source: Source, file: SkillFile, bytes: Uint8Array | undefined): { skill?: Skill; warning?: string } {
  if (!bytes) return { warning: `${file.path}: listed, but not found at the scanned commit; skipped` };
  const parsed = parseSkill(new TextDecoder().decode(bytes));
  const skill: Skill = {
    id: `${source.repository.id}:${file.path}`,
    repository: source.repository.id,
    path: file.path,
    name: parsed.name ?? file.name,
    description: parsed.description,
    commit: source.repository.commit,
    copies: file.copies,
  };
  return { skill, warning: parsed.warning && `${file.path}: ${parsed.warning}` };
}
