// The filter's rules, the same in the CLI and the web view: plain JavaScript, so the page loads
// this very file, as /filter.js. See spec/cli.md, "Filter".

/**
 * The filter's words: split on whitespace; none for an empty or blank filter.
 * @param {string} text
 * @returns {string[]}
 */
export function filterWords(text) {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Whether every word appears, case-insensitively, in the skill's name, full description or path,
 * its copies' paths included. The words can match in different fields.
 * @param {{ name: string, description: string, path: string, copies: string[] }} skill
 * @param {string[]} words
 * @returns {boolean}
 */
export function matchesFilter(skill, words) {
  // One field per line: a word has no whitespace, so it cannot match across two fields.
  const text = [skill.name, skill.description, skill.path, ...skill.copies].join('\n').toLowerCase();
  return words.every((word) => text.includes(word.toLowerCase()));
}
