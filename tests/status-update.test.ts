// status-update.ts, the status-update skill's helper, against a fake Slack API and a fake gh.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = fileURLToPath(new URL('../.agents/skills/status-update/status-update.ts', import.meta.url));

// A fake gh on PATH: prints $FAKE_DIR/pr.json or issue.json, and logs its arguments.
const dir = mkdtempSync(join(tmpdir(), 'status-update-'));
writeFileSync(join(dir, 'gh'), `#!/bin/sh\necho "$@" >> "$FAKE_DIR/calls"\ncat "$FAKE_DIR/$1.json"\n`);
chmodSync(join(dir, 'gh'), 0o755);
after(() => rmSync(dir, { recursive: true, force: true }));

const author = (login: string, is_bot = false) => ({ login, is_bot });
const prs = [
  { number: 3, title: 'Late <b> & more', url: 'https://gh/pr/3', mergedAt: '2026-11-26T12:00:00Z', author: author('app/jetbrains-air', true), closingIssuesReferences: [{ number: 2 }] },
  { number: 1, title: 'Too early', url: 'https://gh/pr/1', mergedAt: '2026-11-26T08:00:00Z', author: author('ann'), closingIssuesReferences: [] },
  { number: 4, title: 'Early', url: 'https://gh/pr/4', mergedAt: '2026-11-26T10:00:00Z', author: author('ann'), closingIssuesReferences: [] },
];
const issues = [
  { number: 2, title: 'Done', url: 'https://gh/issues/2', closedAt: '2026-11-26T12:00:01Z', stateReason: 'COMPLETED' },
  { number: 5, title: 'Not planned', url: 'https://gh/issues/5', closedAt: '2026-11-26T12:00:01Z', stateReason: 'NOT_PLANNED' },
  { number: 6, title: 'Old', url: 'https://gh/issues/6', closedAt: '2026-11-25T12:00:00Z', stateReason: 'COMPLETED' },
];
function fakeGh(p: any[], i: any[]) {
  writeFileSync(join(dir, 'pr.json'), JSON.stringify(p));
  writeFileSync(join(dir, 'issue.json'), JSON.stringify(i));
  writeFileSync(join(dir, 'calls'), '');
}

function fakeSlack(history: any[] = []) {
  const posts: any[] = []; const methods: string[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const url = new URL(req.url!, 'http://x'); const m = url.pathname.slice(1);
    assert.equal(req.headers.authorization, 'Bearer xoxb-test');
    methods.push(m);
    let body: any;
    if (m === 'auth.test') body = { ok: true, user_id: 'UBOT' };
    else if (m === 'conversations.history') { assert.equal(url.searchParams.get('channel'), 'C0CM9AWDGVB'); body = { ok: true, messages: history }; }
    else if (m === 'chat.postMessage') { posts.push(JSON.parse(raw)); body = { ok: true, ts: '100.0' }; }
    else body = { ok: false, error: 'unknown_method' };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  });
  server.unref(); // a failed assertion skips close(); don't let the server keep the test process alive
  return new Promise<{ url: string; posts: any[]; methods: string[]; close: () => void }>((r) =>
    server.listen(0, () => r({ url: `http://127.0.0.1:${(server.address() as any).port}`, posts, methods, close: () => server.close() })));
}

function run(api: string, args: string[], stdin?: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number; out: string; err: string }>((r) => {
    const p = spawn('node', [script, ...args], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_DIR: dir, SLACK_BOT_TOKEN: 'xoxb-test', SLACK_API_URL: api, ...env },
    });
    p.stdin.end(stdin ?? '');
    let out = '', err = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => r({ code: code!, out, err }));
  });
}

test('the draft lists merged PRs and completed issues in the window, oldest first, escaped for Slack', async () => {
  fakeGh(prs, issues);
  const s = await fakeSlack();
  const r = await run(s.url, ['draft', '2026-11-26T09:00:00Z']); s.close();
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trimEnd().split('\n');
  assert.match(lines[0], /^\*Status update\* <!date\^1795683600\^[^|]+\|2026-11-26T09:00:00Z> → <!date\^\d+\^/);
  assert.deepEqual(lines.slice(1), [
    '',
    '*Merged PRs (2)*',
    '• <https://gh/pr/4|#4> Early (ann)',
    '• <https://gh/pr/3|#3> Late &lt;b&gt; &amp; more (jetbrains-air, closes #2)',
    '',
    '*Resolved issues (1)*',
    '• <https://gh/issues/2|#2> Done',
  ]);
  assert.deepEqual(s.methods, [], 'an explicit start needs no Slack call');
  const calls = readFileSync(join(dir, 'calls'), 'utf8');
  assert.match(calls, /pr list --state merged --search merged:>=2026-11-26 /);
  assert.match(calls, /issue list --state closed --search closed:>=2026-11-26 reason:completed /);
});

test('the window ends 2 minutes ago in whole seconds: newer items wait, an item at the start second is in', async () => {
  const sec = (ms: number) => Math.floor(ms / 1000) * 1000;
  const since = new Date(sec(Date.now() - 3600e3)); // the end of the previous update
  const at = (ms: number) => new Date(ms).toISOString();
  fakeGh([
    { number: 7, title: 'At the previous end', url: 'https://gh/pr/7', mergedAt: at(since.getTime()), author: author('ann'), closingIssuesReferences: [] },
    { number: 8, title: 'Just before it', url: 'https://gh/pr/8', mergedAt: at(since.getTime() - 1000), author: author('ann'), closingIssuesReferences: [] },
    { number: 9, title: 'Too fresh', url: 'https://gh/pr/9', mergedAt: at(Date.now() - 30e3), author: author('ann'), closingIssuesReferences: [] },
  ], [
    { number: 10, title: 'Too fresh', url: 'https://gh/issues/10', closedAt: at(Date.now() - 60e3), stateReason: 'COMPLETED' },
  ]);
  const s = await fakeSlack();
  const before = Date.now();
  const r = await run(s.url, ['draft', since.toISOString()]); s.close();
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trimEnd().split('\n');
  const end = [...lines[0].matchAll(/<!date\^(\d+)\^[^|]+\|([^>]+)>/g)][1];
  const endMs = Number(end[1]) * 1000;
  assert.equal(new Date(end[2]).getTime(), endMs, 'the fallback text and the timestamp agree, in whole seconds');
  assert.ok(endMs <= before - 120e3 + 1000 && endMs > before - 130e3, lines[0]);
  assert.deepEqual(lines.slice(1), [
    '',
    '*Merged PRs (1)*',
    '• <https://gh/pr/7|#7> At the previous end (ann)',
    '',
    '*Resolved issues (0)*',
    '• none',
  ]);
});

test('rejects a start less than 2 minutes ago, after the window end', async () => {
  fakeGh([], []);
  const s = await fakeSlack();
  const r = await run(s.url, ['draft', new Date(Date.now() - 30e3).toISOString()]); s.close();
  assert.equal(r.code, 1); assert.match(r.err, /less than 2 minutes ago/);
});

test('an empty window says so', async () => {
  fakeGh([], []);
  const s = await fakeSlack();
  const r = await run(s.url, ['draft', '2026-11-26']); s.close();
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\n\nNothing merged or resolved\.\n$/);
});

test('without a start, it continues from the end of the last status update this bot posted', async () => {
  const s = await fakeSlack([
    { ts: '3.0', user: 'UHUMAN', text: '*Status update* <!date^1^x|a> → <!date^2^x|b>' },
    { ts: '2.5', user: 'UBOT', subtype: 'bot_message', files: [{}] },
    { ts: '2.0', user: 'UBOT', text: 'Implementing the skill map' },
    { ts: '1.5', user: 'UBOT', text: '*Status update* for this week' },
    { ts: '1.0', user: 'UBOT', text: '*Status update* <!date^1795680000^x|a> → <!date^1795690000^x|b>\nSummary' },
  ]);
  const r = await run(s.url, ['since']); s.close();
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `${new Date(1795690000 * 1000).toISOString().replace('.000', '')}\n`);
});

test('without a start or an earlier update, it covers the last 24 hours', async () => {
  const s = await fakeSlack([]);
  const r = await run(s.url, ['since']); s.close();
  assert.equal(r.code, 0, r.err);
  const ago = Date.now() - new Date(r.out.trim()).getTime();
  assert.ok(Math.abs(ago - 24 * 3600e3) < 60e3, r.out);
});

test('rejects a start that is not ISO 8601 or is in the future, before calling gh or Slack', async () => {
  fakeGh(prs, issues);
  const s = await fakeSlack();
  for (const [arg, msg] of [
    ['yesterday', /not an ISO 8601 date/],
    ['1795683600', /not an ISO 8601 date/],
    ['2026-11-26T09:00:00Zjunk', /not an ISO 8601 date/],
    ['2026-11-26T09:00', /not an ISO 8601 date, or time with Z or an offset/],
    ['2026-02-30', /not a date: '2026-02-30'/],
    ['2026-02-29T10:00Z', /not a date/],
    ['2999-01-01', /in the future/],
  ] as const) {
    const r = await run(s.url, ['draft', arg]);
    assert.equal(r.code, 1); assert.match(r.err, msg);
  }
  s.close();
  assert.deepEqual(s.methods, []);
  assert.equal(readFileSync(join(dir, 'calls'), 'utf8'), '');
});

test('posts the message on stdin to the channel, without link previews', async () => {
  const s = await fakeSlack();
  const text = '*Status update* <!date^1^x|a> → <!date^2^x|b>\nThe `$HOME` stays as written.';
  const r = await run(s.url, ['post', '-'], `${text}\n`); s.close();
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'posted: 100.0\n');
  assert.deepEqual(s.posts, [{ channel: 'C0CM9AWDGVB', text, unfurl_links: false, unfurl_media: false }]);
});

test('refuses to post an empty message, one without the status line, or without stdin', async () => {
  const s = await fakeSlack();
  for (const [args, stdin, msg] of [
    [['post', '-'], '  \n', /empty/],
    [['post', '-'], 'Hello', /must start with the draft's first line/],
    [['post', '-'], '*Status update* for this week\n• a PR', /must start with the draft's first line, unchanged/],
    [['post', '-'], '*Status update* <!date^1^x|a> → <!date^2^x|b> — a good week\n', /must start with the draft's first line, unchanged/],
    [['post', 'Hello'], '', /reads the message from stdin/],
  ] as const) {
    const r = await run(s.url, [...args], stdin);
    assert.equal(r.code, 1); assert.match(r.err, msg);
  }
  s.close();
  assert.deepEqual(s.posts, []);
});

test('accepts a date, and a time with an offset, converted to UTC', async () => {
  fakeGh([], []);
  const s = await fakeSlack();
  for (const [arg, start] of [['2026-11-26', '2026-11-26T00:00:00Z'], ['2026-11-26T10:00+01:00', '2026-11-26T09:00:00Z'], ['2024-02-29', '2024-02-29T00:00:00Z']]) {
    const r = await run(s.url, ['draft', arg], '', { TZ: 'Asia/Tokyo' });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`^\\*Status update\\* <!date\\^\\d+\\^[^|]+\\|${start}>`));
  }
  s.close();
});

test('reports a missing token and a Slack error, and exits 1', async () => {
  const s = await fakeSlack();
  const noToken = await run(s.url, ['since'], '', { SLACK_BOT_TOKEN: '' });
  assert.equal(noToken.code, 1); assert.match(noToken.err, /SLACK_BOT_TOKEN is not set/);
  s.close();
  const down = await run('http://127.0.0.1:1', ['since']);
  assert.equal(down.code, 1); assert.match(down.err, /^status-update: auth\.test: /);
  const html = http.createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>'); });
  html.unref();
  await new Promise<void>((ok) => html.listen(0, ok));
  const bad = await run(`http://127.0.0.1:${(html.address() as any).port}`, ['since']); html.closeAllConnections(); html.close();
  assert.equal(bad.code, 1); assert.equal(bad.err, 'status-update: auth.test: the response is not JSON\n');
});
