// The web view's client: reads ?input=, asks /api/scan and renders one of the states —
// idle, loading, error, result (with no skills, with warnings, filtered). All text goes in
// through textContent; nothing from a repository becomes markup.
import { filterWords, matchesFilter } from './filter.js';

const form = document.getElementById('scan-form');
const input = document.getElementById('input');
const button = document.getElementById('scan-button');
const fieldError = document.getElementById('input-error');
const result = document.getElementById('result');
const idle = result.innerHTML;

let current; // the request in flight, so a newer scan cancels it

/** A DOM element: h('a', { href }, 'text', child). */
function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (name.startsWith('on')) element.addEventListener(name.slice(2), value);
    else element.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    element.append(child instanceof Node ? child : String(child));
  }
  return element;
}

function show(...nodes) {
  result.replaceChildren(...nodes.filter(Boolean));
}

function setBusy(busy) {
  result.setAttribute('aria-busy', String(busy));
  button.disabled = busy;
  button.textContent = busy ? 'Scanning…' : 'Scan repository';
}

function setFieldError(message) {
  fieldError.hidden = !message;
  fieldError.textContent = message ?? '';
  input.toggleAttribute('aria-invalid', Boolean(message));
  if (message) input.setAttribute('aria-invalid', 'true');
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = input.value.trim();
  if (!value) {
    setFieldError('Enter a GitHub URL or a directory path.');
    input.focus();
    return;
  }
  const url = addressFor(value);
  if (location.pathname + location.search !== url) history.pushState(null, '', url);
  scanInput(value);
});

input.addEventListener('input', () => setFieldError());

// The example link and the back button both go through the URL.
result.addEventListener('click', (event) => {
  const link = event.target.closest('a#example');
  if (!link) return;
  event.preventDefault();
  history.pushState(null, '', link.getAttribute('href'));
  fromLocation();
});
window.addEventListener('popstate', fromLocation);

/** The page's address for a scan: `/?input=<it>`, and `&filter=<words>` unless the filter is blank. */
function addressFor(value, words = '') {
  const filter = filterWords(words).join(' ');
  return `/?input=${encodeURIComponent(value)}${filter ? `&filter=${encodeURIComponent(filter)}` : ''}`;
}

function fromLocation() {
  const value = new URLSearchParams(location.search).get('input')?.trim() ?? '';
  input.value = value;
  setFieldError();
  if (value) scanInput(value);
  else {
    current?.abort();
    setBusy(false);
    result.innerHTML = idle;
    document.title = 'Skill Atlas';
  }
}

async function scanInput(value) {
  current?.abort();
  const controller = (current = new AbortController());
  setBusy(true);
  showLoading();
  document.title = `Scanning ${value} · Skill Atlas`;
  const started = performance.now();
  try {
    let response;
    let body;
    const notAnswering = () =>
      showError(value, 'The Skill Atlas server is not answering.', 'Check that skill-atlas serve is still running in your terminal, then scan again.');
    try {
      // An owner's scan answers line by line, its progress first; anything else, one JSON answer.
      response = await fetch(`/api/scan?input=${encodeURIComponent(value)}`, {
        signal: controller.signal,
        headers: { Accept: 'application/x-ndjson, application/json' },
      });
      if (response.headers.get('content-type')?.startsWith('application/x-ndjson')) {
        body = await readLines(response, (line) => !controller.signal.aborted && showProgress(line.progress));
        body ??= { error: 'The server stopped answering before the scan finished.' };
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      return notAnswering();
    }
    body ??= await response.json().catch(() => ({ error: `The server answered ${response.status} without details.` }));
    if (controller.signal.aborted) return;
    if (body.error !== undefined) return showError(value, body.error, advice(body.error));
    if (body.owner) showOwnerResult(body, performance.now() - started);
    else showResult(body, performance.now() - started);
  } finally {
    if (current === controller) {
      setBusy(false);
      stopCountdown();
    }
  }
}

/** Each JSON line of a streamed answer: progress lines to `onProgress`; the last one's result, or `{ error }`. */
async function readLines(response, onProgress) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';
  let last;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += value;
    const lines = buffered.split('\n');
    buffered = lines.pop();
    for (const text of lines.filter(Boolean)) {
      const line = JSON.parse(text);
      if (line.progress) onProgress(line);
      else last = line.error !== undefined ? { error: line.error } : line.result;
    }
  }
  return last;
}

let countdown; // the timer of a wait for GitHub's rate limit

function stopCountdown() {
  clearInterval(countdown);
  countdown = undefined;
}

/** How far an owner's scan is, above the skeleton rows: the bar, and what it is doing. */
function showProgress(progress) {
  const bar = result.querySelector('progress');
  const label = result.querySelector('.progress-label');
  if (!bar || !label) return;
  result.querySelector('.progress').hidden = false;
  stopCountdown();
  if (progress.stage === 'listing') {
    bar.removeAttribute('value');
    label.textContent = progress.page > 1 ? `Listing the repositories… (page ${progress.page})` : 'Listing the repositories…';
  } else if (progress.stage === 'scanning') {
    bar.max = Math.max(progress.total, 1);
    bar.value = progress.done;
    label.textContent = `Scanned ${progress.done} of ${progress.total} ${progress.total === 1 ? 'repository' : 'repositories'}`;
  } else if (progress.stage === 'waiting') {
    // The bar stays where it is: GitHub asked to slow down, the scan goes on after the wait.
    const until = Date.now() + progress.seconds * 1000;
    const tick = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      label.textContent = left > 0 ? `GitHub asked to slow down: going on in ${left} s` : 'GitHub asked to slow down: going on…';
      if (left <= 0) stopCountdown();
    };
    tick();
    countdown = setInterval(tick, 1000);
  }
}

/** What to do next, for the errors the scan explains. */
function advice(message = '') {
  if (/set GITHUB_TOKEN/i.test(message)) return ['Restart the server with a token, ', h('code', {}, 'GITHUB_TOKEN=… ./skill-atlas serve'), ', then scan again.'];
  if (/rate limit|API requests remain/i.test(message)) return 'The server has a token already: wait as the message says, then scan again.';
  if (/Cannot reach GitHub/i.test(message)) return 'Check your network connection, then scan again.';
  if (/works only for a repository/i.test(message)) return 'Remove /tree/… to scan every repository of the owner on its default branch, or add a repository name.';
  if (/^Owner not found/i.test(message)) return 'Check the organization or user name.';
  if (/not found/i.test(message)) return 'Check the owner, the repository name and the branch or commit. Private repositories need GITHUB_TOKEN.';
  if (/directory/i.test(message)) return 'Paste a full https://github.com/<owner>/<repo> URL, or a path to a directory the server can read.';
  return 'Check the URL or path, then scan again.';
}

function showLoading() {
  // Widths through classes: the page's CSP allows no inline styles.
  const width = (index) => `skeleton w${index % 4}`;
  const rows = Array.from({ length: 6 }, (_, index) =>
    h('tr', {},
      h('td', {}, h('span', { class: width(index) })),
      h('td', {}, h('span', { class: width(index + 1) }), h('span', { class: 'skeleton w-short' })),
      h('td', {}, h('span', { class: width(index + 2) })),
    ),
  );
  show(
    h('div', { class: 'summary', 'aria-hidden': 'true' },
      h('div', {}, h('span', { class: 'skeleton title' }), h('span', { class: 'skeleton meta-line' })),
    ),
    h('p', { class: 'visually-hidden' }, 'Scanning the repository…'),
    // Shown once an owner's scan says how far it is.
    h('div', { class: 'progress', hidden: true },
      h('p', { class: 'progress-label', id: 'progress-label' }),
      h('progress', { 'aria-labelledby': 'progress-label' }),
    ),
    table(rows, true),
  );
}

function showError(value, message, next) {
  document.title = `Could not scan · Skill Atlas`;
  show(
    h('div', { class: 'error', role: 'alert' },
      h('h1', { class: 'state-title' }, 'Could not scan this repository'),
      h('p', { class: 'message' }, message),
      h('p', {}, next),
      h('p', {}, h('button', { type: 'button', class: 'secondary', onclick: () => scanInput(value) }, 'Scan again')),
    ),
  );
}

function table(rows, hidden = false) {
  return h('table', { class: 'skills', 'aria-hidden': hidden ? 'true' : undefined },
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col', class: 'col-name' }, 'Skill'),
      h('th', { scope: 'col' }, 'Description'),
      h('th', { scope: 'col', class: 'col-file' }, 'File'),
    )),
    h('tbody', {}, rows),
  );
}

function plural(count, one, many) {
  return `${count.toLocaleString('en')} ${count === 1 ? one : many}`;
}

function scannedIn(elapsed) {
  return ` · scanned in ${elapsed < 1000 ? `${Math.round(elapsed)} ms` : `${(elapsed / 1000).toFixed(1)} s`}`;
}

/** The scanned commit, linked; or "local directory". */
function commitMeta(repository) {
  return repository.local
    ? ' · local directory'
    : [' · commit ', h('a', { href: `${repository.url}/tree/${repository.commit}`, title: repository.commit }, h('code', {}, repository.commit.slice(0, 7)))];
}

function warningList(warnings) {
  return warnings.length > 0 &&
    h('details', { class: 'warnings', open: warnings.length <= 3 },
      h('summary', {}, plural(warnings.length, 'warning', 'warnings')),
      h('ul', {}, warnings.map((warning) => h('li', {}, warning))),
    );
}

function noSkills(where) {
  return h('div', { class: 'state' },
    h('h2', { class: 'state-title' }, `No skills in ${where}`),
    h('p', {}, 'Skill Atlas counts only ', h('code', {}, '<root>/<name>/SKILL.md'), ' under ',
      h('code', {}, '.agents/skills'), ', ', h('code', {}, '.claude/skills'), ' and ', h('code', {}, '.github/skills'),
      '. Skills elsewhere, such as test data or skills shipped inside the product, are skipped.'),
  );
}

/**
 * A filter over the rows of one or more tables, by the CLI's rules: `rows` are { skill, row, section? }; a section
 * with no matching row is hidden. `noMatch` shows when nothing matches, its message in `message`.
 * It starts from ?filter= in the address and keeps it there. Returns the field and the live count.
 */
function rowFilter(rows, total, noMatch, message = noMatch) {
  const count = h('p', { class: 'meta', 'aria-live': 'polite' });
  const applyFilter = () => {
    const words = filterWords(filter.value);
    let shown = 0;
    const sections = new Map();
    for (const { skill, row, section } of rows) {
      const match = matchesFilter(skill, words);
      row.hidden = !match;
      if (match) shown++;
      if (section) sections.set(section, (sections.get(section) ?? false) || match);
    }
    for (const [section, any] of sections) section.hidden = !any;
    noMatch.hidden = shown > 0;
    message.replaceChildren(
      `No skills match “${words.join(' ')}”. `,
      h('button', { type: 'button', class: 'link', onclick: () => { filter.value = ''; filter.dispatchEvent(new Event('input')); filter.focus(); } }, 'Clear the filter'),
    );
    count.textContent = words.length > 0 ? `Showing ${shown.toLocaleString('en')} of ${plural(total, 'skill', 'skills')}` : '';
  };
  const filter = h('input', {
    id: 'filter', type: 'search', autocomplete: 'off',
    oninput: () => {
      applyFilter();
      // In the address, so a filtered scan can be shared and reloaded; no history entry per key.
      const params = new URLSearchParams(location.search);
      const url = addressFor(params.get('input') ?? '', filter.value);
      if (location.pathname + location.search !== url) history.replaceState(null, '', url);
    },
  });
  // ?filter= from the address: a shared or reloaded filtered scan.
  filter.value = new URLSearchParams(location.search).get('filter') ?? '';
  applyFilter();
  return h('div', { class: 'filter' }, h('label', { for: 'filter' }, 'Filter by name, description or path'), filter, count);
}

/** An owner: the summary, then one table per repository with skills; the filter goes across all of them. */
function showOwnerResult({ owner, repositories, skipped, warnings }, elapsed) {
  const total = repositories.reduce((count, { skills }) => count + skills.length, 0);
  document.title = `${owner.id} · ${plural(total, 'skill', 'skills')} · Skill Atlas`;
  const kinds = [skipped.forks && plural(skipped.forks, 'fork', 'forks'), skipped.archived && `${skipped.archived} archived`, skipped.empty && `${skipped.empty} empty`].filter(Boolean);
  const meta = h('p', { class: 'meta' },
    `${plural(total, 'skill', 'skills')} in ${repositories.length.toLocaleString('en')} of ${plural(owner.scanned, 'repository', 'repositories')}`,
    kinds.length > 0 && ` · ${kinds.join(', ').replace(/, ([^,]*)$/, ' and $1')} skipped`,
    scannedIn(elapsed),
  );
  const heading = h('h1', {}, h('a', { href: owner.url }, owner.id));

  if (total === 0) {
    return show(h('div', { class: 'summary' }, h('div', {}, heading, meta)), warningList(warnings), noSkills(`any repository of ${owner.id}`));
  }

  const rows = [];
  const sections = repositories.map(({ repository, skills }) => {
    const section = h('section', { class: 'repository' });
    const own = skills.map((skill) => ({ skill, row: skillRow(skill, true), section }));
    rows.push(...own);
    section.append(
      h('h2', {}, h('a', { href: repository.url }, repository.id)),
      h('p', { class: 'meta' }, plural(skills.length, 'skill', 'skills'), commitMeta(repository)),
      table(own.map(({ row }) => row)),
    );
    return section;
  });
  const noMatch = h('p', { class: 'state no-match', hidden: true });

  show(
    h('div', { class: 'summary' }, h('div', {}, heading, meta), rowFilter(rows, total, noMatch)),
    warningList(warnings),
    ...sections,
    noMatch,
  );
}

function showResult({ repository, skills, warnings }, elapsed) {
  document.title = `${repository.id} · ${plural(skills.length, 'skill', 'skills')} · Skill Atlas`;
  const isWeb = /^https?:/.test(repository.url);
  const heading = h('h1', {}, isWeb ? h('a', { href: repository.url }, repository.id) : repository.id);
  const meta = h('p', { class: 'meta' }, plural(skills.length, 'skill', 'skills'), commitMeta(repository), scannedIn(elapsed));

  if (skills.length === 0) {
    return show(h('div', { class: 'summary' }, h('div', {}, heading, meta)), warningList(warnings), noSkills(repository.id));
  }

  const rows = skills.map((skill) => ({ skill, row: skillRow(skill, isWeb) }));
  const noMatch = h('tr', { class: 'no-match', hidden: true }, h('td', { colspan: '3' }));

  show(
    h('div', { class: 'summary' }, h('div', {}, heading, meta), rowFilter(rows, skills.length, noMatch, noMatch.firstChild)),
    warningList(warnings),
    table([...rows.map(({ row }) => row), noMatch]),
  );
}

function skillRow(skill, isWeb) {
  const more = skill.description && skill.description.replace(/\s+/g, ' ') !== skill.summary;
  return h('tr', {},
    h('td', { class: 'name' }, skill.name),
    h('td', { class: 'description' },
      skill.summary ? skill.summary : h('span', { class: 'none' }, 'No description in the front matter'),
      more && h('details', {}, h('summary', {}, 'Full description'), h('p', {}, skill.description)),
    ),
    h('td', {},
      isWeb
        ? h('a', { class: 'path', href: skill.link, title: `${skill.path} at the scanned commit` }, skill.path)
        : h('span', { class: 'path', title: decodeURI(skill.link.replace(/^file:\/\//, '')) }, skill.path),
      skill.copies.length > 0 &&
        h('p', { class: 'copies' }, 'Also in ', skill.copies.flatMap((copy, index) => [index ? ', ' : '', h('code', {}, copy)])),
    ),
  );
}

fromLocation();
