// Status update: the PRs merged and the issues resolved since a time, as a Slack message.
//
//   node .agents/skills/status-update/status-update.ts since              print the default start (see below)
//   node .agents/skills/status-update/status-update.ts draft [<since>]    print the draft message
//   node .agents/skills/status-update/status-update.ts post - <<'EOF'     post the message on stdin
//   <message>
//   EOF
//
// <since> is an ISO 8601 time (2026-11-26T09:00:00Z, 2026-11-26, 2026-11-26T10:00+01:00). Without it,
// the start is the end of the window of the last status update this bot posted in the channel (its
// first line carries it), else 24 hours ago. So a scheduled run reports exactly what came in since the
// last one, whatever the schedule. The window ends 2 minutes before now, in whole seconds: GitHub's
// search index lags behind a merge, so anything newer waits for the next run, and the end the next
// run reads back from the first line is exactly the end this one filtered by.
//
// Options: --channel <ID> (default C0CM9AWDGVB, #very-secrect-alpaca-channel; an ID, since the token
// has no channels:read scope), --repo <owner/name> (default: the current repository, as gh sees it).
// Needs SLACK_BOT_TOKEN, and gh logged in. SLACK_API_URL overrides https://slack.com/api.
//
// Exit 0: done. Exit 1: error.

import { execFileSync } from 'node:child_process';

const MARKER = 'Status update';
const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const [, value] = args.splice(i, 2);
  if (value === undefined) fail(`--${name} needs a value`);
  return value;
};
const channel = opt('channel', 'C0CM9AWDGVB');
const repoArg = opt('repo', '');
const [command, arg] = args;

function fail(message: string): never {
  console.error(`status-update: ${message}`);
  process.exit(1);
}

const token = process.env.SLACK_BOT_TOKEN;
const api = process.env.SLACK_API_URL ?? 'https://slack.com/api';

async function slack(method: string, params: Record<string, string | boolean>, post = false): Promise<any> {
  if (!token) fail('SLACK_BOT_TOKEN is not set');
  const url = new URL(`${api}/${method}`);
  const init: RequestInit = { headers: { Authorization: `Bearer ${token}` } };
  if (post) {
    init.method = 'POST';
    init.headers = { ...init.headers, 'Content-Type': 'application/json; charset=utf-8' };
    init.body = JSON.stringify(params);
  } else {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    fail(`${method}: ${(e as Error).message}`);
  }
  if (!res.ok) fail(`${method}: HTTP ${res.status}`);
  let body: any;
  try {
    body = await res.json();
  } catch {
    fail(`${method}: the response is not JSON`);
  }
  if (!body.ok) fail(`${method}: ${body.error}${body.needed ? ` (needs ${body.needed})` : ''}`);
  return body;
}

function gh(...ghArgs: string[]): any {
  try {
    return JSON.parse(execFileSync('gh', [...ghArgs, ...(repoArg ? ['--repo', repoArg] : [])], { encoding: 'utf8' }));
  } catch (e) {
    fail(`gh ${ghArgs.slice(0, 2).join(' ')}: ${(e as any).stderr?.trim() || (e as Error).message}`);
  }
}

// A date alone is midnight UTC; a time needs Z or an offset, or it would be read in this machine's zone.
function parseTime(raw: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(T.*(Z|[+-]\d{2}:?\d{2}))?$/.exec(raw);
  const d = new Date(raw);
  if (!m || Number.isNaN(d.getTime())) fail(`not an ISO 8601 date, or time with Z or an offset: '${raw}'`);
  // V8 rolls 2026-02-30 over to March 2; a real date reads back the same.
  const [y, mo, day] = [m[1], m[2], m[3]].map(Number);
  const cal = new Date(Date.UTC(y, mo - 1, day));
  if (cal.getUTCFullYear() !== y || cal.getUTCMonth() !== mo - 1 || cal.getUTCDate() !== day) fail(`not a date: '${raw}'`);
  if (d.getTime() > Date.now()) fail(`'${raw}' is in the future`);
  return d;
}

// Whole seconds, so `< until` here and `>= since` in the next run (read back in seconds) split exactly.
const SETTLE_MS = 120e3;
const windowEnd = (): Date => new Date(Math.floor((Date.now() - SETTLE_MS) / 1000) * 1000);

const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
// Slack shows <!date^…> in each reader's own time zone; the text after | is the fallback.
const when = (d: Date): string =>
  `<!date^${Math.floor(d.getTime() / 1000)}^{date_short_pretty} {time}|${iso(d)}>`;

// The first line of a status update, as draft writes it: the window end is the second date. post requires it
// unchanged, so the next run can read the end back.
const STATUS_LINE = new RegExp(`^\\*${MARKER}\\* <!date\\^(\\d+)\\^[^>]*> → <!date\\^(\\d+)\\^[^>]*>$`);
async function defaultSince(): Promise<Date> {
  const me = (await slack('auth.test', {})).user_id;
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const body = await slack('conversations.history', { channel, limit: '200', ...(cursor ? { cursor } : {}) });
    for (const m of body.messages) {
      if (m.user !== me) continue;
      const line = STATUS_LINE.exec((m.text ?? '').split('\n')[0]);
      if (line) return new Date(Number(line[2]) * 1000);
    }
    cursor = body.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
  }
  return new Date(Math.floor((Date.now() - 24 * 3600 * 1000) / 1000) * 1000);
}

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const who = (a: any): string => (a?.is_bot ? a.login.replace(/^app\//, '') : a?.login ?? 'unknown');

function draft(since: Date, until: Date): string {
  const after = (t: string) => new Date(t) >= since && new Date(t) < until;
  const day = iso(since).slice(0, 10); // search by day, then filter to the exact time
  const prs = gh('pr', 'list', '--state', 'merged', '--search', `merged:>=${day}`, '--limit', '500',
    '--json', 'number,title,url,mergedAt,author,closingIssuesReferences')
    .filter((p: any) => after(p.mergedAt))
    .sort((a: any, b: any) => a.mergedAt.localeCompare(b.mergedAt));
  const issues = gh('issue', 'list', '--state', 'closed', '--search', `closed:>=${day} reason:completed`, '--limit', '500',
    '--json', 'number,title,url,closedAt,stateReason')
    .filter((i: any) => i.stateReason === 'COMPLETED' && after(i.closedAt))
    .sort((a: any, b: any) => a.closedAt.localeCompare(b.closedAt));

  const lines = [`*${MARKER}* ${when(since)} → ${when(until)}`, ''];
  if (!prs.length && !issues.length) {
    lines.push('Nothing merged or resolved.');
    return lines.join('\n');
  }
  lines.push(`*Merged PRs (${prs.length})*`);
  for (const p of prs) {
    const closes = (p.closingIssuesReferences ?? []).map((i: any) => `#${i.number}`).join(', ');
    lines.push(`• <${p.url}|#${p.number}> ${escape(p.title)} (${who(p.author)}${closes ? `, closes ${closes}` : ''})`);
  }
  if (!prs.length) lines.push('• none');
  lines.push('', `*Resolved issues (${issues.length})*`);
  for (const i of issues) lines.push(`• <${i.url}|#${i.number}> ${escape(i.title)}`);
  if (!issues.length) lines.push('• none');
  return lines.join('\n');
}

if (command === 'since') {
  console.log(iso(await defaultSince()));
} else if (command === 'draft') {
  const since = arg ? parseTime(arg) : await defaultSince();
  const until = windowEnd();
  if (since > until) fail(`'${iso(since)}' is less than 2 minutes ago: the window ends at ${iso(until)}, to let GitHub's search catch up`);
  console.log(draft(since, until));
} else if (command === 'post') {
  if (arg !== '-') fail("post reads the message from stdin: post - <<'EOF'");
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  text = text.trim();
  if (!text) fail('nothing to post: the message on stdin is empty');
  if (!STATUS_LINE.test(text.split('\n')[0])) fail(`the message must start with the draft's first line, unchanged (*${MARKER}* <!date^…> → <!date^…>)`);
  const posted = await slack('chat.postMessage', { channel, text, unfurl_links: false, unfurl_media: false }, true);
  console.log(`posted: ${posted.ts}`);
} else {
  fail('usage: status-update.ts since | draft [<since>] | post -');
}
