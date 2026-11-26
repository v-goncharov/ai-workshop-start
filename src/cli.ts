#!/usr/bin/env node
// The Node client: a GitHub repository or owner through the GitHub API, or a local directory; stdout and
// stderr, or the web view. Nothing is stored.
import { run } from './commands.ts';
import { openGitHub, parseGitHubUrl } from './core/github.ts';
import { scanOwner as scanGitHubOwner } from './core/owner.ts';
import { openDirectory } from './local.ts';
import { createWebServer, listen } from './web/server.ts';

const token = process.env.GITHUB_TOKEN || undefined;
const open = (input: string) => (parseGitHubUrl(input) ? openGitHub(input, { fetch, token }) : openDirectory(input));
const scanOwner = (input: string) => scanGitHubOwner(input, { fetch, token });

process.exitCode = await run(process.argv.slice(2), {
  open,
  scanOwner,
  print: (text) => console.log(text),
  error: (text) => console.error(text),
  serve: (port) => listen(createWebServer({ open, scanOwner, log: (text) => console.error(text) }), port),
});
