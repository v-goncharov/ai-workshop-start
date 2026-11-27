When the code runs an agent CLI (`claude -p`) on text from scanned repositories, start it with no tools and no MCP servers (`--tools '' --strict-mcp-config`): that text is untrusted, and the user's own allowlist and MCP servers still load.

**Why:** The skill map ran `claude -p --model haiku` on every scanned skill description; a planted "use the tools to …" could have acted with the user's credentials. `cwd: tmpdir()` only kept the scanned repository's CLAUDE.md out.
**Source:** https://github.com/v-goncharov/ai-workshop-start/pull/27#discussion_r4718639942
