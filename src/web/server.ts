// The web view: the page in ./static, and one JSON endpoint that runs the same scan as the CLI.
// Nothing is stored; each request scans again.
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AtlasError } from '../core/errors.ts';
import { firstSentence, skillLink } from '../core/model.ts';
import { scan, type Source } from '../core/scan.ts';

export type WebOptions = {
  /** Opens what the user asked to scan, as the CLI does. */
  open(input: string): Promise<Source>;
  /** Unexpected failures, for the server log; the page gets a short message. */
  log?(text: string): void;
};

/** What `/api/scan` answers: the scan result, each skill with its link and first sentence. */
export type ScanResponse = {
  repository: { id: string; url: string; commit: string; local: boolean };
  skills: { id: string; name: string; path: string; summary: string; description: string; link: string; copies: string[] }[];
  warnings: string[];
};

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

export function createWebServer(options: WebOptions): Server {
  return createServer((request, response) => {
    handle(request, response, options).catch((error) => {
      options.log?.(`Unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      if (!response.headersSent) json(response, 500, { error: 'Something went wrong on the server. The terminal running skill-atlas serve has the details.' });
      else response.end();
    });
  });
}

/** Listens on 127.0.0.1 only: the page can read local directories. Resolves to the address. */
export function listen(server: Server, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(error.code === 'EADDRINUSE' ? new AtlasError(`Port ${port} is in use; pass another one: skill-atlas serve --port <n>`) : error),
    );
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`);
    });
  });
}

/**
 * Listening on 127.0.0.1 is not enough: a page on another site can rebind its own host name to
 * 127.0.0.1 and then read the answers as same-origin. Only this machine's own names, at the port
 * the server listens on, are answered.
 */
function isOwnHost(request: IncomingMessage): boolean {
  const port = request.socket.localPort;
  return request.headers.host === `127.0.0.1:${port}` || request.headers.host === `localhost:${port}`;
}

/** A scan only for the page itself, or for an address typed in the browser; not for other sites. */
function isOwnSite(request: IncomingMessage): boolean {
  const site = request.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

async function handle(request: IncomingMessage, response: ServerResponse, options: WebOptions) {
  if (!isOwnHost(request)) {
    return json(response, 403, { error: 'Skill Atlas answers only at 127.0.0.1 or localhost. Open the address skill-atlas serve printed.' });
  }
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Only GET is supported.' });

  if (url.pathname === '/api/scan') {
    if (!isOwnSite(request)) return json(response, 403, { error: 'Scans are answered only for the Skill Atlas page itself.' });
    const input = url.searchParams.get('input')?.trim();
    if (!input) return json(response, 400, { error: 'Enter a GitHub URL or a directory path.' });
    try {
      return json(response, 200, toResponse(await scan(await options.open(input))));
    } catch (error) {
      if (error instanceof AtlasError) return json(response, 400, { error: error.message });
      throw error;
    }
  }

  const asset = STATIC[url.pathname];
  if (!asset) return json(response, 404, { error: `Not found: ${url.pathname}` });
  const body = await readFile(new URL(`./static/${asset.file}`, import.meta.url));
  response.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache', ...SECURITY });
  response.end(request.method === 'HEAD' ? undefined : body);
}

function toResponse({ repository, skills, warnings }: Awaited<ReturnType<typeof scan>>): ScanResponse {
  return {
    repository: { id: repository.id, url: repository.url, commit: repository.commit, local: !repository.commit },
    skills: skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      path: skill.path,
      summary: firstSentence(skill.description),
      description: skill.description.trim(),
      link: skillLink(repository, skill),
      copies: skill.copies,
    })),
    warnings,
  };
}

const SECURITY = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY });
  response.end(JSON.stringify(body));
}
