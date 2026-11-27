# Skill map
The scanned skills **grouped by what they are about**, so a repository (or a whole owner) with dozens of skills reads at a glance.
In the [CLI](cli.md#skill-map), `--map`; in the [web view](web.md#map), the *Map* view beside the table.
## Grouping
- **Claude groups them**, the only way: `claude -p --model haiku` (Claude Code, the latest Haiku; *no other model*, no heuristic)
  - with **no tools and no MCP servers** (`--tools '' --strict-mcp-config`): the descriptions come from any repository, so they
    are untrusted text, and grouping is text in, text out; a planted "use the tools to …" has nothing to act with
- The prompt, on stdin: each skill's **id** (`repo:path`), **name** and *full* description, and the answer's shape:
  JSON only, `{"groups":[{"name":"<group name>","skills":["<skill id>",…]}]}`, a short name per group, every skill in exactly one
- **Every skill appears exactly once**:
  - an id Claude invented → *dropped*; one it gave twice → kept in its *first* group
  - one it forgot → **Other**; a group Claude named `Other` (in any case) is that one too
  - a group left with no skill → dropped; two groups with the same name → one, at the first one's place
- Order: the groups as Claude gave them, *Other* last; the skills inside a group in the **CLI's order**
  (by name; for an owner, by repository, then by name)
- The answer may sit in a code fence or among other text: the JSON is read from its first `{` to its last `}`
- **An owner**: *one* map over all its skills, each shown with its repository
- **No skills**, or none matching the filter → Claude is *not* asked
- **The filter**: the groups are made from *all* the skills; the filter only hides the skills that don't match, and a group with none left.
  Filtering never asks Claude again
- *Nothing is stored*: no cache, every map asks Claude again
## Failures
None stops the scan: a *warning*, and the skills as without the map.
- `claude` not on the `PATH` → `claude is not installed; the skill map needs Claude Code: https://claude.com/claude-code`
- `claude` exits with an error → `claude failed (exit <code>)`, then `: <its last line>` if it printed one: on stderr, else on stdout
  (`claude failed (exit 1): Not logged in · Please run /login`)
- No answer within *3 minutes* → `claude did not answer within 3 minutes`; it is stopped
- The browser terminal (no Node) → `the skill map runs only from the command line: ./skill-atlas scan <input> --map`
- An answer that doesn't parse (no JSON, no `groups` list, a group without a name or a `skills` list) → `claude's answer is not a skill map`
## Tests
The tests never call the model: they replay a **recorded answer** (`tests/recorded/`) in place of `claude -p`,
by a fake `claude` on the `PATH` for the CLI, and in place of the call for the web view's server.
`npm run test:e2e` does not use the map.
