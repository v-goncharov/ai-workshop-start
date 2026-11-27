// Ask a question in Slack and wait for a human answer in its thread.
//
//   node .claude/skills/implement/ask-slack.ts "<question>"          post a new question
//   node .claude/skills/implement/ask-slack.ts --thread <ts> "<text>" follow up in an existing thread
//   node .claude/skills/implement/ask-slack.ts --thread <ts>          only wait, post nothing
//   node .claude/skills/implement/ask-slack.ts [--thread <ts>] - <<'EOF'
//   <message>
//   EOF                                                                read the message from stdin
//
// `-` reads the message from stdin unchanged, so a quoted heredoc keeps backticks and `$` that a
// double-quoted argument would hand to the shell as command substitution.
//
// Options: --channel <name or ID> (default very-secrect-alpaca-channel; an ID like C0123ABCD skips the
// conversations.list lookup and its channels:read scope), --wait <seconds> (default 3600),
// --poll <seconds> (default 60), --since <ts> (with --thread: count replies after this ts, e.g. the
// `last:` of the previous run, instead of after the follow-up post or now, so nothing posted in between is
// missed). Needs SLACK_BOT_TOKEN. SLACK_API_URL overrides https://slack.com/api (tests).
//
// Once the first human reply arrives, it keeps polling until a whole poll interval passes with no new
// reply (or --wait runs out), so an answer sent as several messages is read in full.
//
// Prints `thread: <ts>` first, then each human reply as `answer from <user>: <text>`, then `last: <ts>`
// of the last reply read. Exit 0: answered. Exit 2: no answer within --wait. Exit 1: error.

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const [, value] = args.splice(i, 2);
  if (value === undefined) fail(`--${name} needs a value`);
  return value;
};
const channelName = opt('channel', 'very-secrect-alpaca-channel');
const seconds = (name: string, fallback: string): number => {
  const raw = opt(name, fallback);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) fail(`--${name} needs a number of seconds, got '${raw}'`);
  return n;
};
const waitSeconds = seconds('wait', '3600');
const pollSeconds = seconds('poll', '60');
let thread = opt('thread', '');
const sinceArg = opt('since', '');
if (sinceArg && !thread) fail('--since needs --thread');
if (sinceArg && !(Number.isFinite(Number(sinceArg)) && Number(sinceArg) > 0)) fail(`--since needs a Slack ts, got '${sinceArg}'`);
const fromStdin = args.length === 1 && args[0] === '-';
let text = args.join(' ').trim();

function fail(message: string): never {
  console.error(`ask-slack: ${message}`);
  process.exit(1);
}

const token = process.env.SLACK_BOT_TOKEN;
if (!token) fail('SLACK_BOT_TOKEN is not set');
if (fromStdin) {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  text = raw.trim();
  if (!text) fail('nothing to ask: the message on stdin is empty');
}
if (!text && !thread) fail('nothing to ask: give a question, or --thread <ts> to wait for replies');

const api = process.env.SLACK_API_URL ?? 'https://slack.com/api';

class Transient extends Error {}

async function slack(method: string, params: Record<string, string>, post = false): Promise<any> {
  const url = new URL(`${api}/${method}`);
  const init: RequestInit = { headers: { Authorization: `Bearer ${token}` } };
  if (post) {
    init.method = 'POST';
    init.headers = { ...init.headers, 'Content-Type': 'application/json; charset=utf-8' };
    init.body = JSON.stringify(params);
  } else {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new Transient(`${method}: ${(e as Error).message}`);
  }
  if (res.status === 429 || res.status >= 500) throw new Transient(`${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error === 'ratelimited') throw new Transient(`${method}: ratelimited`);
  if (!body.ok) fail(`${method}: ${body.error}`);
  return body;
}

async function findChannel(name: string): Promise<string> {
  let cursor = '';
  do {
    const page = await slack('conversations.list', {
      types: 'public_channel,private_channel', exclude_archived: 'true', limit: '1000', cursor,
    });
    const found = page.channels.find((c: any) => c.name === name);
    if (found) return found.id;
    cursor = page.response_metadata?.next_cursor ?? '';
  } while (cursor);
  fail(`channel #${name} not found, or the bot is not in it`);
}

// Before the wait a transient error is not retried (a retried post could post twice): report it and exit 1.
const once = <T>(p: Promise<T>): Promise<T> =>
  p.catch((e) => (e instanceof Transient ? fail(e.message) : Promise.reject(e)));

const channel = /^[CG][A-Z0-9]{6,}$/.test(channelName) ? channelName : await once(findChannel(channelName));
const me = (await once(slack('auth.test', {}))).user_id;

let since = '0';
if (text) {
  const posted = await once(slack('chat.postMessage', { channel, text, ...(thread ? { thread_ts: thread } : {}) }, true));
  thread ||= posted.ts;
  since = sinceArg || posted.ts;
} else if (sinceArg) {
  since = sinceArg;
} else {
  // Only waiting: count replies that arrive from now on.
  since = String(Date.now() / 1000);
}
console.log(`thread: ${thread}`);

const deadline = Date.now() + waitSeconds * 1000;
// Human replies found so far. Once there are some, stop at the first poll that finds no new one.
let answers: any[] = [];
while (true) {
  let settled = false;
  try {
    const { messages } = await slack('conversations.replies', { channel, ts: thread, oldest: since, limit: '200' });
    const found = messages.filter((m: any) =>
      Number(m.ts) > Number(since) && m.user && m.user !== me && !m.bot_id && m.ts !== thread)
      .sort((a: any, b: any) => Number(a.ts) - Number(b.ts));
    settled = answers.length > 0 && found.length <= answers.length;
    if (found.length > answers.length) answers = found;
  } catch (e) {
    if (!(e instanceof Transient)) throw e;
    console.error(`ask-slack: ${e.message}, retrying`); // a blip must not end an hour-long wait
  }
  if (answers.length && (settled || Date.now() >= deadline)) {
    for (const m of answers) console.log(`answer from <@${m.user}>: ${m.text}`);
    console.log(`last: ${answers[answers.length - 1].ts}`);
    process.exit(0);
  }
  if (Date.now() >= deadline) {
    console.log(`no answer in ${waitSeconds}s`);
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, Math.min(pollSeconds * 1000, deadline - Date.now())));
}
