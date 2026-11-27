// The web view's client: reads ?input=, asks /api/scan and renders one of the states —
// idle, loading, error, result (with no skills, with warnings, filtered). All text goes in
// through textContent; nothing from a repository becomes markup.
import { filterWords, matchesFilter } from './filter.js';
import { JOKES } from './jokes.js';
import { PHRASES } from './phrases.js';

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

/** One of the page's alpacas (the <symbol>s in index.html), as an <svg> to place. */
function alpaca(className = 'alpaca', symbol = 'alpaca') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${symbol}`);
  svg.append(use);
  return svg;
}

let typing; // the filter's wait for typing to stop, before the alpaca comments

function show(...nodes) {
  clearTimeout(typing);
  result.replaceChildren(...nodes.filter(Boolean));
}

function setBusy(busy) {
  result.setAttribute('aria-busy', String(busy));
  button.disabled = busy;
  button.textContent = busy ? 'The alpaca is out…' : 'Scan repository';
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
  if (refuses('scan', 'scanRefused', { input: scanned(value) })) return;
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
  if (refuses('scan', 'scanRefused', { input: scanned(new URLSearchParams(link.search).get('input') ?? '') })) return;
  history.pushState(null, '', link.getAttribute('href'));
  fromLocation();
});
window.addEventListener('popstate', fromLocation);

// The idle alpaca speaks: a joke in its bubble on each click, never the same twice in a row; gone after 5 s or on a click elsewhere.
let lastJoke; // the index of the joke said last
let hushing; // the timer that clears the bubble

function speak(speaker) {
  // One of the others: chance picks among all but the last joke.
  let index = Math.floor(Math.random() * (lastJoke === undefined ? JOKES.length : JOKES.length - 1));
  if (lastJoke !== undefined && index >= lastJoke) index++;
  lastJoke = index;
  const bubble = result.querySelector('.bubble');
  if (bubble) bubble.textContent = JOKES[index];
  // The wobble starts again on each joke (only where motion is allowed: style.css).
  speaker.classList.remove('wobble');
  void speaker.getBoundingClientRect();
  speaker.classList.add('wobble');
  clearTimeout(hushing);
  hushing = setTimeout(hush, 5000);
}

function hush() {
  clearTimeout(hushing);
  const bubble = result.querySelector('.bubble');
  if (bubble) bubble.textContent = '';
  result.querySelector('.speaker')?.classList.remove('wobble');
}

document.addEventListener('click', (event) => {
  const speaker = event.target.closest?.('button.speaker');
  if (speaker) speak(speaker);
  else hush();
  if (event.target.closest) remarkOnClick(event.target);
});
result.addEventListener('animationend', (event) => {
  if (event.animationName === 'wobble') event.target.closest('.speaker')?.classList.remove('wobble');
});

// The crest alpaca comments on what the user does: about 1 in 3 actions, at least 10 s apart, a line from phrases.js,
// never the same one twice in a row; gone after 5 s. What the user did goes in as text, shortened. With the crest
// scrolled out of view, a visitor comes on screen to say it.
const crest = document.querySelector('.crest');
const comment = document.querySelector('.comment');
const visitor = document.querySelector('.visitor');
const CHANCE = 1 / 3;
const COOLDOWN = 10_000;
let lastRemarkAt = -Infinity; // when the alpaca last commented
let lastPhrase;
let quieting; // the timer that clears its bubble

const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** Shortened to 30 characters, `…` included. */
function shorten(text) {
  const characters = [...String(text)];
  return characters.length > 30 ? `${characters.slice(0, 29).join('')}…` : characters.join('');
}

/** Maybe a comment from one of `categories` (chance picks), its placeholders filled from `values`. */
function remark(categories, values = {}) {
  categories = [categories].flat();
  if (!comment || categories.length === 0 || Date.now() - lastRemarkAt < COOLDOWN) return;
  if (Math.random() >= CHANCE) return;
  say(categories, values);
}

/** A comment from one of `categories` now, whatever the chance and the gap; it starts the gap. */
function say(categories, values = {}) {
  const phrase = pick(PHRASES[pick(categories)].filter((line) => line !== lastPhrase));
  lastPhrase = phrase;
  lastRemarkAt = Date.now();
  comment.textContent = phrase.replace(/\{(\w+)\}/g, (_, key) => (key === 'text' ? `“${shorten(values[key] ?? '')}”` : shorten(values[key] ?? '')));
  place();
  crest.classList.remove('wobble');
  void crest.getBoundingClientRect();
  crest.classList.add('wobble');
  clearTimeout(quieting);
  quieting = setTimeout(() => {
    comment.textContent = '';
    crest.classList.remove('wobble');
    place();
  }, 5000);
}

/**
 * Where the comment is said: below the crest while it is in view; with the crest scrolled out of view (more than half
 * of it), by the visitor, which peeks in from the window's corner with the bubble beside it. Again on each scroll.
 */
function place() {
  const speaking = comment.textContent !== '';
  const { top, bottom, left } = crest.getBoundingClientRect();
  const middle = (top + bottom) / 2;
  const away = speaking && (middle < 0 || middle > window.innerHeight);
  visitor?.classList.toggle('here', away);
  comment.classList.toggle('visiting', away);
  if (speaking && !away) {
    comment.style.setProperty('--top', `${Math.max(bottom + 12, 12)}px`);
    comment.style.setProperty('--left', `${Math.max(left, 12)}px`);
  }
}

if (comment) {
  window.addEventListener('scroll', place, { passive: true });
  window.addEventListener('resize', place, { passive: true });
}

// The alpaca sometimes refuses a scan or a filter, and says why: a roll at or over 0.9 (1 in 10). Never the same action
// twice in a row, so asking again goes through; a scan from the address, or clearing the filter, never asks.
const REFUSE_FROM = 0.9;
const refused = { scan: false, filter: false }; // whether it refused that action the last time

/** Whether the alpaca refuses `action` this time; if so, it says a line from `category`. */
function refuses(action, category, values) {
  if (!comment) return false; // a refusal is never silent
  if (refused[action]) return (refused[action] = false);
  if (Math.random() < REFUSE_FROM) return false;
  refused[action] = true;
  say([category], values);
  return true;
}

crest?.addEventListener('animationend', (event) => {
  if (event.animationName === 'wobble') crest.classList.remove('wobble');
});

const isGitHub = (value) => /^(https?:\/\/)?(www\.)?github\.com(\/|$)/i.test(value);

/** What is scanned, said shortly: without `https://github.com/`, or a directory's last name. */
function scanned(value) {
  if (isGitHub(value)) return value.replace(/^(https?:\/\/)?(www\.)?github\.com\/?/i, '').replace(/\/+$/, '') || 'GitHub';
  return value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value;
}

/** A finished scan with skills: many or few, slow or fast; chance picks among those that apply. */
function remarkOnScan(count, elapsed) {
  const categories = [count >= 20 && 'scanMany', count <= 3 && 'scanFew', elapsed >= 10_000 && 'scanSlow', elapsed < 1000 && 'scanFast'].filter(Boolean);
  remark(categories, { skills: plural(count, 'skill', 'skills'), time: took(elapsed) });
}

/** A skill's file, opening its full description, its copies; or a click on nothing that does anything. */
function remarkOnClick(target) {
  const name = target.closest('tr, .map li')?.querySelector('.name')?.textContent ?? '';
  if (target.closest('a.path')) return remark('openFile', { name });
  const summary = target.closest('.description summary');
  if (summary) return summary.parentElement.open || remark('fullDescription', { name });
  if (target.closest('.copies')) return remark('copies', { name });
  if (!target.closest('a, button, input, select, textarea, label, summary, table, .map, .bubble')) remark('emptyPage');
}

/** The page's address for a scan: `/?input=<it>`, `&filter=<words>` unless the filter is blank, `&view=map` in the Map view. */
function addressFor(value, words = '', view = '') {
  const filter = filterWords(words).join(' ');
  return `/?input=${encodeURIComponent(value)}${filter ? `&filter=${encodeURIComponent(filter)}` : ''}${view === 'map' ? '&view=map' : ''}`;
}

function fromLocation() {
  const value = new URLSearchParams(location.search).get('input')?.trim() ?? '';
  input.value = value;
  setFieldError();
  if (value) scanInput(value);
  else {
    current?.abort();
    mapping?.abort();
    setBusy(false);
    clearTimeout(typing); // the filter is gone: nothing to say about it
    result.innerHTML = idle;
    document.title = 'Skill Atlas';
  }
}

async function scanInput(value) {
  current?.abort();
  mapping?.abort();
  const controller = (current = new AbortController());
  setBusy(true);
  showLoading();
  remark(isGitHub(value) ? 'scanGitHub' : 'scanLocal', { input: scanned(value) });
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
  const trail = result.querySelector('.trail');
  if (!bar || !label || !trail) return;
  result.querySelector('.progress').hidden = false;
  stopCountdown();
  // The alpaca above the bar: roaming while the end is unknown, at d of n after, standing still during a wait.
  trail.classList.toggle('roaming', progress.stage === 'listing');
  trail.classList.toggle('resting', progress.stage === 'waiting');
  if (progress.stage === 'listing') {
    bar.removeAttribute('value');
    label.textContent = progress.page > 1 ? `Listing the repositories… (page ${progress.page})` : 'Listing the repositories…';
  } else if (progress.stage === 'scanning') {
    bar.max = Math.max(progress.total, 1);
    bar.value = progress.done;
    // Through the CSSOM: the page's CSP allows no style attributes.
    trail.style.setProperty('--at', String(progress.done / Math.max(progress.total, 1)));
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
      h('div', { class: 'trail' }, alpaca('trotter', 'alpaca-trot'), h('progress', { 'aria-labelledby': 'progress-label' })),
    ),
    table(rows, true),
  );
}

function showError(value, message, next) {
  document.title = `Could not scan · Skill Atlas`;
  remark('scanError', { input: scanned(value) });
  show(
    h('div', { class: 'error', role: 'alert' },
      alpaca(),
      h('h1', { class: 'state-title' }, 'The alpaca could not scan this repository'),
      h('p', { class: 'message' }, message),
      h('p', {}, next),
      h('p', {}, h('button', { type: 'button', class: 'secondary', onclick: () => refuses('scan', 'scanRefused', { input: scanned(value) }) || scanInput(value) }, 'Scan again')),
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

function took(elapsed) {
  return elapsed < 1000 ? `${Math.round(elapsed)} ms` : `${(elapsed / 1000).toFixed(1)} s`;
}

function scannedIn(elapsed) {
  return ` · the alpaca was back in ${took(elapsed)}`;
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
    alpaca(),
    h('h2', { class: 'state-title' }, `No skills in ${where}`),
    h('p', {}, 'The alpaca looked everywhere it is allowed to graze and came back with an empty saddlebag.'),
    h('p', {}, 'Skill Atlas counts only ', h('code', {}, '<root>/<name>/SKILL.md'), ' under ',
      h('code', {}, '.agents/skills'), ', ', h('code', {}, '.claude/skills'), ' and ', h('code', {}, '.github/skills'),
      '. Skills elsewhere, such as test data or skills shipped inside the product, are skipped.'),
  );
}

/**
 * A filter over the rows of one or more tables, by the CLI's rules: `rows` are { skill, row, section? }; a section
 * with no matching row is hidden, and its `.count`, if it has one, counts the rows shown. `noMatch` shows when nothing
 * matches, its message in `message`. More rows, each set with its own no-match, come with `add` (the map's cards).
 * It starts from ?filter= in the address and keeps it there. Returns the field, with the live count, and `add`.
 */
function rowFilter(rows, total, noMatch, message = noMatch) {
  const count = h('p', { class: 'meta', 'aria-live': 'polite' });
  const sets = [{ rows, noMatch, message }];
  let shown = 0;
  const applyFilter = (text = filter.value) => {
    const words = filterWords(text);
    for (const { rows, noMatch, message } of sets) {
      shown = 0;
      const sections = new Map();
      for (const { skill, row, section } of rows) {
        const match = matchesFilter(skill, words);
        row.hidden = !match;
        if (match) shown++;
        if (section) sections.set(section, (sections.get(section) ?? 0) + (match ? 1 : 0));
      }
      for (const [section, matching] of sections) {
        section.hidden = matching === 0;
        const counted = section.querySelector('.count');
        if (counted) counted.textContent = plural(matching, 'skill', 'skills');
      }
      noMatch.hidden = shown > 0;
      message.replaceChildren(
        `No skills match “${words.join(' ')}”. `,
        h('button', { type: 'button', class: 'link', onclick: () => { filter.value = ''; filter.dispatchEvent(new Event('input')); filter.focus(); } }, 'Clear the filter'),
      );
    }
    count.textContent = words.length > 0 ? `Showing ${shown.toLocaleString('en')} of ${plural(total, 'skill', 'skills')}` : '';
  };
  const filter = h('input', {
    id: 'filter', type: 'search', autocomplete: 'off',
    oninput: () => {
      applyFilter();
      inAddress(filter.value);
      // The alpaca comments once typing stops, on words that changed; or refuses them, and the rows go back.
      clearTimeout(typing);
      typing = setTimeout(() => {
        const words = filterWords(filter.value).join(' ');
        if (words === considered) return;
        if (words && refuses('filter', 'filterRefused', { text: words })) {
          applyFilter(considered);
          return inAddress(considered);
        }
        considered = words;
        if (!words) return remark('filterCleared');
        remark(shown > 0 ? 'filterMatch' : 'filterNoMatch', { text: words, skills: plural(shown, 'skill', 'skills') });
      }, 800);
    },
  });
  // In the address, so a filtered scan can be shared and reloaded; no history entry per key.
  const inAddress = (text) => {
    const params = new URLSearchParams(location.search);
    const url = addressFor(params.get('input') ?? '', text, params.get('view') ?? '');
    if (location.pathname + location.search !== url) history.replaceState(null, '', url);
  };
  // ?filter= from the address: a shared or reloaded filtered scan.
  filter.value = new URLSearchParams(location.search).get('filter') ?? '';
  let considered = filterWords(filter.value).join(' '); // the words the alpaca last thought about
  applyFilter();
  return {
    element: h('div', { class: 'filter' }, h('label', { for: 'filter' }, 'Filter by name, description or path'), filter, count),
    add(rows, noMatch, message = noMatch) {
      sets.push({ rows, noMatch, message });
      applyFilter();
    },
  };
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
    remark('noSkills', { input: owner.id });
    return show(h('div', { class: 'summary' }, h('div', {}, heading, meta)), warningList(warnings), noSkills(`any repository of ${owner.id}`));
  }
  remarkOnScan(total, elapsed);

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
  const filter = rowFilter(rows, total, noMatch);
  const listed = repositories.flatMap(({ repository, skills }) => skills.map((skill) => ({ repository, skill })));
  const { views, panels } = mapViews(h('div', { class: 'table-view' }, ...sections, noMatch), listed, filter, true);

  show(h('div', { class: 'summary' }, h('div', {}, heading, meta), filter.element, views), warningList(warnings), ...panels);
  openView();
}

function showResult({ repository, skills, warnings }, elapsed) {
  document.title = `${repository.id} · ${plural(skills.length, 'skill', 'skills')} · Skill Atlas`;
  const isWeb = /^https?:/.test(repository.url);
  const heading = h('h1', {}, isWeb ? h('a', { href: repository.url }, repository.id) : repository.id);
  const meta = h('p', { class: 'meta' }, plural(skills.length, 'skill', 'skills'), commitMeta(repository), scannedIn(elapsed));

  if (skills.length === 0) {
    remark('noSkills', { input: repository.id });
    return show(h('div', { class: 'summary' }, h('div', {}, heading, meta)), warningList(warnings), noSkills(repository.id));
  }
  remarkOnScan(skills.length, elapsed);

  const rows = skills.map((skill) => ({ skill, row: skillRow(skill, isWeb) }));
  const noMatch = h('tr', { class: 'no-match', hidden: true }, h('td', { colspan: '3' }));
  const filter = rowFilter(rows, skills.length, noMatch, noMatch.firstChild);
  const tableView = h('div', { class: 'table-view' }, table([...rows.map(({ row }) => row), noMatch]));
  const { views, panels } = mapViews(tableView, skills.map((skill) => ({ repository, skill })), filter, false);

  show(h('div', { class: 'summary' }, h('div', {}, heading, meta), filter.element, views), warningList(warnings), ...panels);
  openView();
}

// The skill map (spec/map.md, spec/web.md "Map"): a Map view beside the table, one card per group, Claude asked once per
// scan, when the view opens. The view goes in the address, &view=map.
let mapping; // the request for the map in flight, so a new scan cancels it
let openView = () => {}; // the view from the address, once a result is shown

/** The Table | Map switch and the two panels; `listed` is [{ repository, skill }] in the CLI's order. */
function mapViews(tableView, listed, filter, withRepository) {
  const mapView = h('section', { class: 'map', 'aria-label': 'Skill map', hidden: true });
  const tableButton = h('button', { type: 'button', class: 'view', 'aria-pressed': 'true', onclick: () => setView('table', true) }, 'Table');
  const mapButton = h('button', { type: 'button', class: 'view', 'aria-pressed': 'false', onclick: () => setView('map', true) }, 'Map');
  let drawn = false; // asked, or asking: the map stays until the next scan

  /** Shows `view`; on a click, the address follows (from the address, it already says so). */
  const setView = (view, click = false) => {
    const map = view === 'map';
    tableView.hidden = map;
    mapView.hidden = !map;
    tableButton.setAttribute('aria-pressed', String(!map));
    mapButton.setAttribute('aria-pressed', String(map));
    if (click) {
      const params = new URLSearchParams(location.search);
      const url = addressFor(params.get('input') ?? '', params.get('filter') ?? '', view);
      if (location.pathname + location.search !== url) history.replaceState(null, '', url);
    }
    if (map && !drawn) draw();
  };

  const draw = async () => {
    drawn = true;
    mapping?.abort();
    const controller = (mapping = new AbortController());
    mapView.replaceChildren(
      h('p', { class: 'map-status' }, 'The alpaca is asking Claude to draw the map…'),
      h('div', { class: 'groups', 'aria-hidden': 'true' },
        Array.from({ length: 3 }, (_, index) => h('div', { class: 'group' }, h('span', { class: `skeleton w${index % 4}` }), h('span', { class: 'skeleton w-short' })))),
    );
    let body;
    try {
      const response = await fetch('/api/map', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skills: listed.map(({ skill }) => ({ id: skill.id, name: skill.name, description: skill.description })) }),
      });
      body = await response.json().catch(() => ({ error: `The server answered ${response.status} without details.` }));
    } catch {
      if (controller.signal.aborted) return;
      body = { error: 'The Skill Atlas server is not answering.' };
    }
    if (controller.signal.aborted) return;
    if (body.error !== undefined || !Array.isArray(body.groups)) {
      // The error stays, in this view, until Try again asks again.
      return mapView.replaceChildren(
        h('div', { class: 'error map-error', role: 'alert' },
          alpaca(),
          h('h2', { class: 'state-title' }, 'The alpaca could not draw the map'),
          h('p', { class: 'message' }, body.error ?? 'The server answered without a map.'),
          h('p', {}, h('button', { type: 'button', class: 'secondary', onclick: () => draw() }, 'Try again')),
        ),
      );
    }
    const byId = new Map(listed.map((entry) => [entry.skill.id, entry]));
    const rows = [];
    const cards = body.groups.map((group) => {
      const card = h('section', { class: 'group' });
      const items = group.skills.filter((id) => byId.has(id)).map((id) => {
        const { repository, skill } = byId.get(id);
        const item = mapItem(repository, skill, withRepository);
        rows.push({ skill, row: item, section: card });
        return item;
      });
      card.append(h('h2', {}, group.name), h('p', { class: 'meta count' }, plural(items.length, 'skill', 'skills')), h('ul', {}, items));
      return card;
    });
    const noMatch = h('p', { class: 'state no-match', hidden: true });
    mapView.replaceChildren(h('div', { class: 'groups' }, cards), noMatch);
    filter.add(rows, noMatch);
  };

  openView = () => setView(new URLSearchParams(location.search).get('view') === 'map' ? 'map' : 'table');
  return { views: h('div', { class: 'views', role: 'group', 'aria-label': 'View' }, tableButton, mapButton), panels: [tableView, mapView] };
}

/** A skill on a map card: its name, its file (linked at the scanned commit; the path for a local one), the first sentence; an owner's, its repository. */
function mapItem(repository, skill, withRepository) {
  const isWeb = !repository.local;
  return h('li', {},
    h('p', {},
      h('span', { class: 'name' }, skill.name),
      withRepository && h('span', { class: 'repo' }, ` · ${repository.id}`),
    ),
    skill.summary ? h('p', { class: 'description' }, skill.summary) : h('p', { class: 'description none' }, 'No description in the front matter'),
    isWeb
      ? h('a', { class: 'path', href: skill.link, title: `${skill.path} at the scanned commit` }, skill.path)
      : h('span', { class: 'path', title: decodeURI(skill.link.replace(/^file:\/\//, '')) }, skill.path),
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
