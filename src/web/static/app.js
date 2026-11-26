// The web view's client: reads ?input=, asks /api/scan and renders one of the states —
// idle, loading, error, result (with no skills, with warnings, filtered). All text goes in
// through textContent; nothing from a repository becomes markup.

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
  result.replaceChildren(...nodes);
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
  const url = `/?input=${encodeURIComponent(value)}`;
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
    try {
      response = await fetch(`/api/scan?input=${encodeURIComponent(value)}`, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) return;
      return showError(value, 'The Skill Atlas server is not answering.', 'Check that skill-atlas serve is still running in your terminal, then scan again.');
    }
    const body = await response.json().catch(() => ({ error: `The server answered ${response.status} without details.` }));
    if (controller.signal.aborted) return;
    if (!response.ok) return showError(value, body.error, advice(body.error));
    showResult(body, performance.now() - started);
  } finally {
    if (current === controller) setBusy(false);
  }
}

/** What to do next, for the errors the scan explains. */
function advice(message = '') {
  if (/rate limit/i.test(message)) return 'Restart the server with GITHUB_TOKEN set (GITHUB_TOKEN=… ./skill-atlas serve), then scan again.';
  if (/Cannot reach GitHub/i.test(message)) return 'Check your network connection, then scan again.';
  if (/not found/i.test(message)) return 'Check the owner, the repository name and the branch or commit. Private repositories need GITHUB_TOKEN.';
  if (/directory/i.test(message)) return 'Paste a full https://github.com/<owner>/<repo> URL, or a path to a directory the server can read.';
  return 'Check the URL or path, then scan again.';
}

function showLoading() {
  const rows = Array.from({ length: 6 }, (_, index) =>
    h('tr', {},
      h('td', {}, h('span', { class: 'skeleton', style: `width: ${60 + ((index * 23) % 35)}%` })),
      h('td', {}, h('span', { class: 'skeleton', style: `width: ${70 + ((index * 17) % 30)}%` }), h('span', { class: 'skeleton', style: 'width: 40%' })),
      h('td', {}, h('span', { class: 'skeleton', style: `width: ${55 + ((index * 29) % 40)}%` })),
    ),
  );
  show(
    h('div', { class: 'summary', 'aria-hidden': 'true' },
      h('div', {}, h('span', { class: 'skeleton title' }), h('span', { class: 'skeleton meta-line' })),
    ),
    h('p', { class: 'visually-hidden' }, 'Scanning the repository…'),
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

function showResult({ repository, skills, warnings }, elapsed) {
  document.title = `${repository.id} · ${plural(skills.length, 'skill', 'skills')} · Skill Atlas`;
  const isWeb = /^https?:/.test(repository.url);
  const heading = h('h1', {}, isWeb ? h('a', { href: repository.url }, repository.id) : repository.id);
  const meta = h('p', { class: 'meta' },
    plural(skills.length, 'skill', 'skills'),
    repository.local
      ? ' · local directory'
      : [' · commit ', h('a', { href: `${repository.url}/tree/${repository.commit}`, title: repository.commit }, h('code', {}, repository.commit.slice(0, 7)))],
    ` · scanned in ${(elapsed / 1000).toFixed(1)} s`,
  );

  const warningList = warnings.length > 0 &&
    h('details', { class: 'warnings', open: warnings.length <= 3 },
      h('summary', {}, plural(warnings.length, 'warning', 'warnings')),
      h('ul', {}, warnings.map((warning) => h('li', {}, warning))),
    );

  if (skills.length === 0) {
    return show(
      h('div', { class: 'summary' }, h('div', {}, heading, meta)),
      warningList,
      h('div', { class: 'state' },
        h('h2', { class: 'state-title' }, `No skills in ${repository.id}`),
        h('p', {}, 'Skill Atlas counts only ', h('code', {}, '<root>/<name>/SKILL.md'), ' under ',
          h('code', {}, '.agents/skills'), ', ', h('code', {}, '.claude/skills'), ' and ', h('code', {}, '.github/skills'),
          '. Skills elsewhere, such as test data or skills shipped inside the product, are skipped.'),
      ),
    );
  }

  const rows = skills.map((skill) => ({ skill, row: skillRow(skill, isWeb), text: `${skill.name}\n${skill.description}\n${skill.path}`.toLowerCase() }));
  const noMatch = h('tr', { class: 'no-match', hidden: true }, h('td', { colspan: '3' }));
  const count = h('p', { class: 'meta', 'aria-live': 'polite' });
  const filter = h('input', {
    id: 'filter', type: 'search', autocomplete: 'off',
    oninput: () => {
      const query = filter.value.trim().toLowerCase();
      let shown = 0;
      for (const { row, text } of rows) {
        const match = !query || text.includes(query);
        row.hidden = !match;
        if (match) shown++;
      }
      noMatch.hidden = shown > 0;
      noMatch.firstChild.replaceChildren(
        `No skills match “${filter.value.trim()}”. `,
        h('button', { type: 'button', class: 'link', onclick: () => { filter.value = ''; filter.dispatchEvent(new Event('input')); filter.focus(); } }, 'Clear the filter'),
      );
      count.textContent = query ? `Showing ${shown.toLocaleString('en')} of ${plural(skills.length, 'skill', 'skills')}` : '';
    },
  });

  show(
    h('div', { class: 'summary' },
      h('div', {}, heading, meta),
      h('div', { class: 'filter' }, h('label', { for: 'filter' }, 'Filter by name, description or path'), filter, count),
    ),
    warningList,
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
