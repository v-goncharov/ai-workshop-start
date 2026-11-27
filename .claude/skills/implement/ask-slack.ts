// Ask a question in Slack and wait for a human answer in its thread.
//
//   node .claude/skills/implement/ask-slack.ts "<question>"          post a new question
//   node .claude/skills/implement/ask-slack.ts --thread <ts> "<text>" follow up in an existing thread
//   node .claude/skills/implement/ask-slack.ts --thread <ts>          only wait, post nothing
//
// Options: --channel <name> (default very-secrect-alpaca-channel), --wait <seconds> (default 3600),
// --poll <seconds> (default 60). Needs SLACK_BOT_TOKEN.
//
// Prints `thread: <ts>` first, then each human reply as `answer from <user>: <text>`.
// Exit 0: answered. Exit 2: no answer within --wait. Exit 1: error.

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const [, value] = args.splice(i, 2);
  if (value === undefined) fail(`--${name} needs a value`);
  return value;
};
const channelName = opt('channel', 'very-secrect-alpaca-channel');
const waitSeconds = Number(opt('wait', '3600'));
const pollSeconds = Number(opt('poll', '60'));
let thread = opt('thread', '');
const text = args.join(' ').trim();

function fail(message: string): never {
  console.error(`ask-slack: ${message}`);
  process.exit(1);
}

const token = process.env.SLACK_BOT_TOKEN;
if (!token) fail('SLACK_BOT_TOKEN is not set');
if (!text && !thread) fail('nothing to ask: give a question, or --thread <ts> to wait for replies');

async function slack(method: string, params: Record<string, string>, post = false): Promise<any> {
  const url = new URL(`https://slack.com/api/${method}`);
  const init: RequestInit = { headers: { Authorization: `Bearer ${token}` } };
  if (post) {
    init.method = 'POST';
    init.headers = { ...init.headers, 'Content-Type': 'application/json; charset=utf-8' };
    init.body = JSON.stringify(params);
  } else {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url, init);
  const body = await res.json();
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

const channel = await findChannel(channelName);
const me = (await slack('auth.test', {})).user_id;

let since = '0';
if (text) {
  const posted = await slack('chat.postMessage', { channel, text, ...(thread ? { thread_ts: thread } : {}) }, true);
  thread ||= posted.ts;
  since = posted.ts;
} else {
  // Only waiting: count replies that arrive from now on.
  since = String(Date.now() / 1000);
}
console.log(`thread: ${thread}`);

const deadline = Date.now() + waitSeconds * 1000;
while (true) {
  const { messages } = await slack('conversations.replies', { channel, ts: thread, oldest: since, limit: '200' });
  const answers = messages.filter((m: any) =>
    Number(m.ts) > Number(since) && m.user && m.user !== me && !m.bot_id && m.ts !== thread);
  if (answers.length) {
    for (const m of answers) console.log(`answer from <@${m.user}>: ${m.text}`);
    process.exit(0);
  }
  if (Date.now() >= deadline) {
    console.log(`no answer in ${waitSeconds}s`);
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, Math.min(pollSeconds * 1000, deadline - Date.now())));
}
