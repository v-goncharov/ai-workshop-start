// Asks Claude Code for the skill map (spec/map.md): `claude -p --model haiku --tools '' --strict-mcp-config`,
// the prompt on stdin, the answer on stdout.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { AtlasError } from './core/errors.ts';

/** How long Claude has to answer: 3 minutes, less in the tests. */
export function askClaude(prompt: string, { timeout = 180_000 } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    // The prompt holds the scanned descriptions, untrusted text: no tools and no MCP servers, so Claude can only answer.
    // Away from the scanned repository: its CLAUDE.md is none of the map's business.
    const args = ['-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config'];
    const child = spawn('claude', args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.stdin.on('error', () => {}); // a claude that exits without reading: its exit says why
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        error.code === 'ENOENT'
          ? new AtlasError('claude is not installed; the skill map needs Claude Code: https://claude.com/claude-code')
          : new AtlasError(`claude failed: ${error.message}`),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new AtlasError(`claude did not answer within ${minutes(timeout)}`));
      if (code !== 0) {
        // Its reason: the last line on stderr, else on stdout (where `claude -p` says "Not logged in").
        const lastLine = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean).pop();
        const last = lastLine(stderr) ?? lastLine(stdout);
        return reject(new AtlasError(`claude failed (exit ${code ?? 'signal'})${last ? `: ${last}` : ''}`));
      }
      resolve(stdout);
    });
    child.stdin.end(prompt);
  });
}

function minutes(ms: number): string {
  const n = ms / 60_000;
  return n >= 1 ? `${n} minute${n === 1 ? '' : 's'}` : `${ms / 1000} seconds`;
}
