// ask-slack.ts, the implement skill's Slack question helper, against a fake Slack API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../.claude/skills/implement/ask-slack.ts', import.meta.url));

type Reply = { status?: number; body: any };
function fakeSlack(onReplies: (call: number, ts: string) => Reply, override: Record<string, Reply> = {}) {
  const posts: any[] = []; const methods: string[] = []; let calls = 0;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const url = new URL(req.url!, 'http://x'); const m = url.pathname.slice(1);
    assert.equal(req.headers.authorization, 'Bearer xoxb-test');
    methods.push(m);
    let status = 200, body: any;
    if (override[m]) ({ status = 200, body } = override[m]);
    else if (m === 'conversations.list') body = { ok: true, channels: [{ id: 'C1', name: 'very-secrect-alpaca-channel' }] };
    else if (m === 'auth.test') body = { ok: true, user_id: 'UBOT' };
    else if (m === 'chat.postMessage') { const p = JSON.parse(raw); posts.push(p); body = { ok: true, ts: p.thread_ts ? '200.0' : '100.0' }; }
    else if (m === 'conversations.replies') { assert.equal(url.searchParams.get('channel'), posts[0]?.channel ?? 'C1'); ({ status = 200, body } = onReplies(++calls, url.searchParams.get('ts')!)); }
    else body = { ok: false, error: 'unknown_method' };
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  });
  return new Promise<{ url: string; posts: any[]; methods: string[]; close: () => void }>((r) =>
    server.listen(0, () => r({ url: `http://127.0.0.1:${(server.address() as any).port}`, posts, methods, close: () => server.close() })));
}

function run(api: string, args: string[], stdin?: string) {
  return new Promise<{ code: number; out: string; err: string }>((r) => {
    const p = spawn('node', [script, ...args], { env: { ...process.env, SLACK_BOT_TOKEN: 'xoxb-test', SLACK_API_URL: api } });
    if (stdin !== undefined) p.stdin.end(stdin);
    let out = '', err = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => r({ code: code!, out, err }));
  });
}

const parent = { ts: '100.0', user: 'UBOT', bot_id: 'B', text: 'q' };

test('posts the question and exits 0 with the human answer, ignoring bots and surviving a rate limit', async () => {
  const s = await fakeSlack((call) => {
    if (call === 1) return { body: { ok: true, messages: [parent, { ts: '101.0', user: 'UBOT', bot_id: 'B', text: 'own' }, { ts: '102.0', bot_id: 'B2', text: 'other bot' }] } };
    if (call === 2) return { status: 429, body: { ok: false, error: 'ratelimited' } };
    return { body: { ok: true, messages: [parent, { ts: '103.0', user: 'UHUMAN', text: 'use option B' }] } };
  });
  const r = await run(s.url, ['--poll', '0.1', '--wait', '10', 'Which option?']); s.close();
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(s.posts, [{ channel: 'C1', text: 'Which option?' }]);
  assert.match(r.out, /^thread: 100\.0\nanswer from <@UHUMAN>: use option B\n$/);
  assert.match(r.err, /HTTP 429, retrying/);
});

test('a follow-up posts in the thread and only counts replies after it', async () => {
  const s = await fakeSlack((_c, ts) => {
    assert.equal(ts, '100.0');
    return { body: { ok: true, messages: [parent, { ts: '150.0', user: 'UHUMAN', text: 'old answer' }, { ts: '201.0', user: 'UHUMAN', text: 'new answer' }] } };
  });
  const r = await run(s.url, ['--thread', '100.0', '--poll', '0.1', 'And this?']); s.close();
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(s.posts, [{ channel: 'C1', text: 'And this?', thread_ts: '100.0' }]);
  assert.doesNotMatch(r.out, /old answer/); assert.match(r.out, /new answer/);
});

test('exits 2 when nobody answers in time', async () => {
  const s = await fakeSlack(() => ({ body: { ok: true, messages: [parent] } }));
  const r = await run(s.url, ['--wait', '1', '--poll', '0.2', 'Anyone?']); s.close();
  assert.equal(r.code, 2); assert.match(r.out, /no answer in 1s/);
});

test('exits 1 on a real Slack error', async () => {
  const s = await fakeSlack(() => ({ body: { ok: false, error: 'not_in_channel' } }));
  const r = await run(s.url, ['--poll', '0.1', 'Q']); s.close();
  assert.equal(r.code, 1); assert.match(r.err, /conversations.replies: not_in_channel/);
});

test('rejects a --wait or --poll that is not a positive number of seconds, before calling Slack', async () => {
  const s = await fakeSlack(() => ({ body: { ok: true, messages: [parent] } }));
  for (const args of [['--wait', '1h'], ['--wait', 'abc'], ['--wait', '0'], ['--poll', 'abc'], ['--poll', '-1']]) {
    const r = await run(s.url, [...args, 'Q']);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, new RegExp(`^ask-slack: ${args[0]} needs a number of seconds, got '${args[1]}'\n$`));
  }
  s.close();
  assert.deepEqual(s.methods, []);
});

test('a transient error before the wait exits 1 with an ask-slack message, not a stack trace', async () => {
  for (const method of ['conversations.list', 'auth.test', 'chat.postMessage']) {
    const s = await fakeSlack(() => ({ body: { ok: true, messages: [parent] } }), { [method]: { status: 503, body: {} } });
    const r = await run(s.url, ['--poll', '0.1', 'Q']); s.close();
    assert.equal(r.code, 1, method);
    assert.equal(r.err, `ask-slack: ${method}: HTTP 503\n`);
    assert.equal(s.methods.filter((m) => m === 'chat.postMessage').length, method === 'chat.postMessage' ? 1 : 0);
  }
});

test('a channel ID skips the conversations.list lookup', async () => {
  const s = await fakeSlack(() => ({ body: { ok: true, messages: [parent, { ts: '101.0', user: 'UHUMAN', text: 'yes' }] } }),
    { 'conversations.list': { body: { ok: false, error: 'missing_scope' } } });
  const r = await run(s.url, ['--channel', 'C1ABCDEFG', '--poll', '0.1', 'Q']); s.close();
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /answer from <@UHUMAN>: yes/);
  assert.ok(!s.methods.includes('conversations.list'));
  assert.deepEqual(s.posts, [{ channel: 'C1ABCDEFG', text: 'Q' }]);
});

test('`-` reads the message from stdin, keeping backticks, `$` and newlines as they are', async () => {
  const message = 'Should the error go in `spec/cli.md`?\nOr in $HOME/`whoami`?';
  const s = await fakeSlack(() => ({ body: { ok: true, messages: [parent, { ts: '101.0', user: 'UHUMAN', text: 'cli.md' }, { ts: '201.0', user: 'UHUMAN', text: 'yes' }] } }));
  const r = await run(s.url, ['--poll', '0.1', '-'], message + '\n');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(s.posts, [{ channel: 'C1', text: message }]);
  const f = await run(s.url, ['--thread', '100.0', '--poll', '0.1', '-'], 'And `this`?');
  assert.equal(f.code, 0, f.err);
  assert.deepEqual(s.posts[1], { channel: 'C1', text: 'And `this`?', thread_ts: '100.0' });
  const e = await run(s.url, ['-'], '  \n'); s.close();
  assert.equal(e.code, 1); assert.equal(e.err, 'ask-slack: nothing to ask: the message on stdin is empty\n');
});

test('the SKILL.md heredoc form delivers a message with backticks and `$` unchanged', async () => {
  const s = await fakeSlack(() => ({ body: { ok: true, messages: [parent, { ts: '101.0', user: 'UHUMAN', text: 'ok' }] } }));
  const p = spawn('bash', ['-c', `node ${JSON.stringify(script)} --poll 0.1 - <<'EOF'\nUse \`spec/\` and $PATH here\nEOF`],
    { env: { ...process.env, SLACK_BOT_TOKEN: 'xoxb-test', SLACK_API_URL: s.url } });
  let err = ''; p.stderr.on('data', (d) => (err += d));
  const code = await new Promise((r) => p.on('close', r)); s.close();
  assert.equal(code, 0, err);
  assert.deepEqual(s.posts, [{ channel: 'C1', text: 'Use `spec/` and $PATH here' }]);
});
