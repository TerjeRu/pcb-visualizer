import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createView } from '../js/ui.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function setup() {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  dom.window.document.getElementById('panel-store').hidden = false;   // as after the layout starts
  const calls = [];
  const handlers = Object.fromEntries(['onSelectBoard', 'onCreateBoard', 'onSubmitToken', 'onSaveDetails', 'onSetGuidance', 'onSetTheme'].map((n) => [n, (...a) => calls.push([n, ...a])]));
  handlers.loadPhoto = async () => 'blob:test';
  const timers = { set: (fn) => { timers.fn = fn; return 1; }, clear() {} };
  const view = createView(dom.window.document, handlers, timers);
  return { dom, doc: dom.window.document, calls, view, timers };
}

const project = (meta = {}) => ({ meta: { name: 'Router', device: 'AX', notes: '', ...meta }, assets: [{}], markers: [], schematics: [], components: [] });
const live = (extra = {}) => ({ status: 'live', project: project(), feed: [], error: null, ...extra });

test('untrusted text is shown as text, never parsed as markup', () => {
  const { doc, view } = setup();
  const evil = '<img src=x onerror=alert(1)><script>boom()</script>';
  view.showBoardPanel();
  view.setBoards([evil], evil);
  view.render(live({
    project: project({ name: evil, notes: evil }),
    feed: [{ seq: 1, ts: '2026-01-01T10:00:00Z', actor: evil, type: 'project/metaUpdated', patch: { [evil]: 1 } }],
  }));
  assert.equal(doc.querySelectorAll('img:not(#photo)').length, 0);   // #photo is the board photo element itself
  assert.equal(doc.body.querySelectorAll('script').length, 0);
  assert.equal(doc.getElementById('field-name').value, evil);
  assert.ok(doc.querySelector('#feed .actor').textContent.includes('<img'));
  assert.equal(doc.querySelector('#board-select option').textContent, evil);
});

test('counts and newest-first feed are drawn from state', () => {
  const { doc, view } = setup();
  view.render(live({ feed: [
    { seq: 1, ts: '2026-01-01T10:00:00Z', actor: 'a', type: 'marker/added', marker: { label: 'TP1' } },
    { seq: 2, ts: '2026-01-01T10:00:01Z', actor: 'b', type: 'marker/removed', id: 'm1' },
  ] }));
  assert.deepEqual([...doc.querySelectorAll('#feed li .seq')].map((n) => n.textContent), ['#2', '#1']);
  assert.ok([...doc.querySelectorAll('#counts li')].some((n) => n.textContent === '1 photo'));
});

test('a focused field is not overwritten by incoming state, but others are', () => {
  const { doc, view } = setup();
  view.showBoardPanel();   // a hidden panel cannot hold focus
  view.render(live());
  const name = doc.getElementById('field-name');
  name.focus();
  assert.equal(doc.activeElement, name);
  name.value = 'half typed';
  view.render(live({ project: project({ name: 'Remote', device: 'Other' }) }));
  assert.equal(name.value, 'half typed');
  assert.equal(doc.getElementById('field-device').value, 'Other');
});

test('a field left unchanged catches up with changes that arrived while it was focused', () => {
  const { doc, view, calls } = setup();
  view.showBoardPanel();
  view.render(live());
  const notes = doc.getElementById('field-notes');
  notes.focus();
  view.render(live({ project: project({ notes: 'from the CLI' }) }));
  assert.equal(notes.value, '');
  notes.blur();
  assert.equal(notes.value, 'from the CLI');
  assert.equal(calls.length, 0);
});

test('a field edited while focused keeps the typed text on leaving', () => {
  const { doc, view } = setup();
  view.showBoardPanel();
  view.render(live());
  const notes = doc.getElementById('field-notes');
  notes.focus();
  notes.value = 'mine';
  view.render(live({ project: project({ notes: 'from the CLI' }) }));
  notes.blur();
  assert.equal(notes.value, 'mine');
});

test('fields are editable only while live', () => {
  const { doc, view } = setup();
  view.render(live({ status: 'reconnecting' }));
  assert.equal(doc.getElementById('field-name').disabled, true);
  view.render(live());
  assert.equal(doc.getElementById('field-name').disabled, false);
});

test('editing a field reports all three values once on change', () => {
  const { dom, doc, view, calls } = setup();
  view.render(live());
  const notes = doc.getElementById('field-notes');
  notes.value = 'swapped UART pins';
  notes.dispatchEvent(new dom.window.Event('change'));
  assert.deepEqual(calls, [['onSaveDetails', { name: 'Router', device: 'AX', notes: 'swapped UART pins' }]]);
});

test('forms report intent and clear secrets/inputs; no page navigation', () => {
  const { dom, doc, calls } = setup();
  const submit = (id) => {
    const ev = new dom.window.Event('submit', { cancelable: true });
    doc.getElementById(id).dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  doc.getElementById('token-input').value = 's3cret';
  assert.equal(submit('token-form'), true);
  doc.getElementById('new-board-name').value = 'Camera';
  assert.equal(submit('new-board-form'), true);
  assert.deepEqual(calls, [['onSubmitToken', 's3cret'], ['onCreateBoard', 'Camera']]);
  assert.equal(doc.getElementById('token-input').value, '');
  assert.equal(doc.getElementById('new-board-name').value, '');
});

test('panels are mutually exclusive and error messages expire', () => {
  const { doc, view, timers } = setup();
  view.showTokenPanel('hello');
  assert.deepEqual(['token-panel', 'empty-panel', 'board-panel'].map((i) => doc.getElementById(i).hidden), [false, true, true]);
  view.showNoBoards();
  assert.deepEqual(['token-panel', 'empty-panel', 'board-panel'].map((i) => doc.getElementById(i).hidden), [true, false, true]);
  view.showError('nope');
  assert.equal(doc.getElementById('message').hidden, false);
  timers.fn();
  assert.equal(doc.getElementById('message').hidden, true);
});

test('rejected state surfaces the reason', () => {
  const { doc, view } = setup();
  view.render(live({ status: 'rejected', error: { message: 'Token refused' } }));
  assert.equal(doc.getElementById('message').textContent, 'Token refused');
});

// Source guards: cheap, catch the mistakes that are easy to make and expensive to notice.
const jsDir = new URL('../js/', import.meta.url);
const sources = readdirSync(jsDir, { recursive: true })
  .filter((f) => f.endsWith('.js'))
  .map((f) => [f, readFileSync(new URL(f, jsDir), 'utf8')]);

test('no unsafe DOM APIs or dynamic code in app sources', () => {
  for (const [file, src] of sources) {
    assert.doesNotMatch(src, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\(/, file);
  }
});

test('page has no inline scripts, handlers or external URLs; every id used in ui.js exists', () => {
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /(src|href)\s*=\s*["']https?:/i);
  const ui = sources.find(([f]) => f === 'ui.js')[1];
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const used = [...ui.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]).concat([...ui.matchAll(/'((?:token|empty|board)-panel)'/g)].map((m) => m[1]));
  assert.ok(used.length > 10);
  for (const id of used) assert.ok(ids.has(id), `missing #${id}`);
});

test('the guidance switch reports a click, and Expert marks the page so the help hides', () => {
  const { doc, view, calls } = setup();
  doc.getElementById('guidance-expert').click();
  assert.deepEqual(calls.at(-1), ['onSetGuidance', 'expert']);
  view.setGuidance('expert');
  assert.equal(doc.documentElement.dataset.guidance, 'expert');
  assert.equal(doc.getElementById('guidance-expert').getAttribute('aria-pressed'), 'true');
  assert.equal(doc.getElementById('guidance-guided').getAttribute('aria-pressed'), 'false');
  assert.equal(doc.getElementById('assistant-input').placeholder, 'Ask about this board');
  assert.ok(doc.querySelector('#viewer-empty .guide') && doc.querySelector('#viewer-empty .terse'));
  view.setGuidance('nonsense');
  assert.equal(doc.documentElement.dataset.guidance, 'guided');
});

test('the theme setting reports a change; data-theme is always the resolved theme', () => {
  const { doc, view, calls } = setup();
  const select = doc.getElementById('theme-select');
  select.value = 'dark';
  select.dispatchEvent(new doc.defaultView.Event('change'));
  assert.deepEqual(calls.at(-1), ['onSetTheme', 'dark']);
  view.setTheme('dark');
  assert.equal(doc.documentElement.dataset.theme, 'dark');
  view.setTheme('light');
  assert.equal(doc.documentElement.dataset.theme, 'light');
  assert.equal(doc.documentElement.dataset.themeSetting, 'light');
  view.setTheme('system');
  assert.equal(doc.documentElement.dataset.theme, 'light', 'no desktop preference: light');
  assert.equal(doc.documentElement.dataset.themeSetting, 'system');
  assert.equal(select.value, 'system');
  doc.defaultView.matchMedia = () => ({ matches: true });
  view.setTheme('system');
  assert.equal(doc.documentElement.dataset.theme, 'dark', 'System follows a dark desktop');
  view.setTheme('sepia');
  assert.equal(doc.documentElement.dataset.themeSetting, 'system');
});

test('theme.js resolves the saved setting before paint and follows the desktop while on System', () => {
  const source = readFileSync(new URL('../js/theme.js', import.meta.url), 'utf8');
  const run = (stored, prefersDark) => {
    const dom = new JSDOM('<!doctype html><html></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const listeners = [];
    const query = { matches: prefersDark, addEventListener: (type, fn) => listeners.push(fn) };
    dom.window.matchMedia = () => query;
    if (stored) dom.window.localStorage.setItem('pcbv-theme', stored);
    dom.window.eval(source);
    return { root: dom.window.document.documentElement, query, listeners };
  };
  assert.equal(run('dark', false).root.dataset.theme, 'dark');
  assert.equal(run('light', true).root.dataset.theme, 'light');
  assert.equal(run('system', true).root.dataset.theme, 'dark');
  const system = run(null, false);
  assert.equal(system.root.dataset.theme, 'light');
  assert.equal(system.root.dataset.themeSetting, 'system');
  system.query.matches = true;
  system.listeners.forEach((fn) => fn());
  assert.equal(system.root.dataset.theme, 'dark');
  const fixed = run('light', false);
  fixed.query.matches = true;
  fixed.listeners.forEach((fn) => fn());
  assert.equal(fixed.root.dataset.theme, 'light', 'an explicit choice does not follow the desktop');
});

test('panel explainers are Guided only and link to pages that exist', () => {
  const { doc } = setup();
  const pages = new Set(readdirSync(new URL('../../service/src/pcbv/wiki/', import.meta.url))
    .filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)));
  const explainers = [...doc.querySelectorAll('.explainer')];
  assert.ok(explainers.length >= 9);
  for (const p of explainers) assert.ok(p.classList.contains('guide'), p.textContent);
  const targets = [...doc.querySelectorAll('.explainer a[data-wiki]')].map((a) => a.dataset.wiki);
  assert.ok(targets.length >= 15);
  for (const name of targets) assert.ok(pages.has(name), `no wiki page ${name}`);
});

test('in a panel window, a wiki link swaps in the Wiki and Back returns to the panel', async () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  const opened = [];
  const handlers = {
    loadWikiIndex: async () => [],
    loadWikiPage: async (name) => { opened.push(name); return { name, title: name, origin: 'builtin', markdown: `# ${name}\n\nSee [Ground](ground).` }; },
  };
  const view = createView(doc, handlers, { set: () => 1, clear() {} }, { single: 'console' });
  view.startLayout();
  const title = doc.title;
  doc.querySelector('#panel-console .explainer a[data-wiki="uart"]').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(opened, ['uart']);
  assert.equal(doc.getElementById('panel-console').hidden, true);
  assert.equal(doc.getElementById('panel-wiki').hidden, false);
  assert.equal(doc.title, title, 'the window title stays for KWin rules');
  assert.equal(doc.getElementById('wiki-back').textContent, '← Back to Console');
  doc.querySelector('#wiki-page a[data-wiki="ground"]').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(opened, ['uart', 'ground'], 'a rendered link opens its page once');
  doc.getElementById('wiki-back').click();
  assert.equal(doc.getElementById('panel-console').hidden, false);
  assert.equal(doc.getElementById('panel-wiki').hidden, true);
});

test('storage warnings persist as text and unwritable boards disable mutation controls', () => {
  const { doc, view } = setup();
  const path = '.pcbv/recovery/snapshot-<img onerror=bad>.json';
  view.render(live({ storage: { writable: false, warnings: ['external_edit_preserved'], warningDetails: { external_edit_preserved: { path } } } }));
  const warning = doc.getElementById('storage-warning');
  assert.equal(warning.hidden, false);
  assert.ok(warning.textContent.includes(path));
  assert.equal(warning.querySelector('img'), null);
  assert.equal(doc.getElementById('field-name').disabled, true);
  assert.equal(doc.getElementById('terminal-start').disabled, true);
  view.render(live({ storage: { writable: true, warnings: [] } }));
  assert.equal(warning.hidden, true);
  assert.equal(doc.getElementById('field-name').disabled, false);
});

test('every panel has one Guided-only explainer line', () => {
  const { doc } = setup();
  const panels = [...doc.querySelectorAll('#panel-store > .panel')];
  assert.equal(panels.length, 11);
  for (const panel of panels) {
    const lines = panel.querySelectorAll('.explainer');
    assert.equal(lines.length, 1, `${panel.id} has one explainer`);
    assert.ok(lines[0].classList.contains('guide'), `${panel.id} explainer is Guided only`);
  }
});

test('empty states carry a Guided sentence and a short form for Expert', () => {
  const { doc } = setup();
  for (const id of ['empty-panel', 'changes-empty', 'assistant-empty', 'inspector-empty', 'viewer-empty', 'logic-empty']) {
    const node = doc.getElementById(id);
    const guide = node.querySelector('.guide'), terse = node.querySelector('.terse');
    assert.ok(guide && terse, `${id} has both forms`);
    assert.ok(terse.textContent.length <= guide.textContent.length, `${id}: the short form is the shorter one`);
  }
});

test('safety confirmations are never marked as Guided help, so Expert still shows them', () => {
  const { doc } = setup();
  for (const node of doc.querySelectorAll('#serial-confirm, #serial-confirm *, button.danger, button.danger *, .gate.destructive')) {
    assert.equal(node.closest('.guide, .terse'), null, `${node.id || node.className || node.tagName} stays visible in both modes`);
  }
});

// The Wiki's Back button returns to the tab it was opened over (spec 22).
async function dockedSetup() {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  const handlers = {
    loadWikiIndex: async () => [],
    loadWikiPage: async (name) => ({ name, title: name, origin: 'builtin', markdown: `# ${name}` }),
  };
  const view = createView(doc, handlers, { set: () => 1, clear() {} }, {});
  view.startLayout();
  await new Promise((r) => setTimeout(r, 0));
  const pause = () => new Promise((r) => setTimeout(r, 0));
  return { doc, view, pause, back: doc.getElementById('wiki-back') };
}
const regionOf = (doc, id) => doc.querySelector('.region')?.ownerDocument.querySelector(`.region:has(#panel-${id})`)?.id ?? null;

test('in the tutorial layout the Wiki goes back to the Console, and the Playbook stays put away', async () => {
  const { doc, view, pause, back } = await dockedSetup();
  await view.tutorialEnter(['console']);
  doc.querySelector('#panel-console .explainer a[data-wiki]').click();
  await pause();
  assert.equal(back.hidden, false);
  assert.equal(back.textContent, '← Back to Console');
  assert.equal(doc.getElementById('panel-console').hidden, true);
  back.click();
  assert.equal(doc.getElementById('panel-console').hidden, false);
  assert.equal(regionOf(doc, 'playbook'), null, 'the Playbook did not come back');
});

test('in the default layout the Wiki goes back to the Playbook, and a second page keeps the target', async () => {
  const { doc, view, pause, back } = await dockedSetup();
  doc.getElementById('tab-playbook')?.click();
  doc.querySelector('#panel-playbook a[data-wiki], a[data-wiki]').click();
  await pause();
  assert.equal(back.textContent, '← Back to Playbook');
  doc.querySelector('a[data-wiki]').click();
  await pause();
  assert.equal(back.textContent, '← Back to Playbook', 'a second page opened with the Wiki in front');
  assert.equal(back.hidden, false);
  back.click();
  assert.equal(doc.getElementById('panel-playbook').hidden, false);
  assert.ok(view);
});

test('leaving the tutorial brings back the Wiki target of the layout it restores', async () => {
  const { doc, view, pause, back } = await dockedSetup();
  doc.getElementById('tab-playbook')?.click();
  doc.querySelector('#panel-playbook a[data-wiki]').click();
  await pause();
  assert.equal(back.textContent, '← Back to Playbook');
  await view.tutorialEnter(['console']);
  assert.equal(back.hidden, true, 'the tutorial layout has nothing the Wiki was opened over yet');
  doc.querySelector('#panel-console .explainer a[data-wiki]').click();
  await pause();
  assert.equal(back.textContent, '← Back to Console');
  view.tutorialLeave();
  assert.equal(back.hidden, false);
  assert.equal(back.textContent, '← Back to Playbook');
  back.click();
  assert.equal(doc.getElementById('panel-playbook').hidden, false);
});

test('before the Wiki has been opened over anything, the Back button is hidden', async () => {
  const { back } = await dockedSetup();
  assert.equal(back.hidden, true);
});

// The highlight of spec 23a: the control the step needs carries a steady ring (replaces Show me).
const coachStep = (extra = {}) => ({
  kind: 'step', moved: false, step: 3, total: 18, chapter: 0, title: 'T', body: ['B'], tasks: [{ id: 'a', text: 'A', done: false }],
  hint: '', canContinue: false, canBack: true, last: false, why: ['W'], wiki: 'headers', target: null, ...extra,
});
async function coachSetup() {
  const t = await dockedSetup();
  t.doc.getElementById('board-panel').hidden = false;
  await t.view.tutorialEnter(['console']);
  t.doc.getElementById('serial-connect').disabled = false;   // the markup starts it disabled, until a port is chosen
  return t;
}
const ringed = (doc) => [...doc.querySelectorAll('.tutorial-target')];

test('the control the step needs carries the highlight, and it moves and clears with the target', async () => {
  const { doc, view } = await coachSetup();
  view.tutorialDraw(coachStep({ target: 'serial-connect' }));
  assert.deepEqual(ringed(doc).map((n) => n.id), ['serial-connect']);
  view.tutorialDraw(coachStep({ target: 'serial-refresh' }));
  assert.deepEqual(ringed(doc).map((n) => n.id), ['serial-refresh'], 'the class moved');
  view.tutorialDraw(coachStep({ target: 'tutorial-continue', canContinue: true }));
  assert.deepEqual(ringed(doc).map((n) => n.id), ['tutorial-continue']);
  view.tutorialDraw({ kind: 'finish', target: null, moved: false, complete: false, step: 4, total: 18, chapter: 0, title: 'End', lead: 'L', lines: [], where: '' });
  assert.equal(ringed(doc).length, 0, 'the finish pages ring nothing');
  view.tutorialDraw(coachStep({ target: 'serial-connect' }));
  view.tutorialLeave();
  assert.equal(ringed(doc).length, 0, 'leaving the tutorial clears it');
});

test('the highlight never moves focus', async () => {
  const { doc, view } = await coachSetup();
  doc.getElementById('serial-refresh').focus();
  view.tutorialDraw(coachStep({ target: 'serial-connect' }));
  assert.equal(doc.activeElement, doc.getElementById('serial-refresh'));
});

test('a target in a tab that is not showing puts the highlight on that tab', async () => {
  const { doc, view } = await coachSetup();
  view.tutorialDraw(coachStep({ target: 'wiki-index' }));
  assert.deepEqual(ringed(doc).map((n) => n.id), ['region-tab-wiki']);
  view.tutorialDraw(coachStep({ target: 'serial-connect' }));
  assert.deepEqual(ringed(doc).map((n) => n.id), ['serial-connect']);
});

test('the highlight is put back when the dock rebuilds its tabs', async () => {
  const { doc, view } = await coachSetup();
  view.tutorialDraw(coachStep({ target: 'wiki-index' }));
  doc.getElementById('region-tab-wiki').click();   // the layout is drawn again, with new tab nodes
  assert.deepEqual(ringed(doc).map((n) => n.id), ['wiki-index'], 'now the control itself');
  doc.getElementById('region-tab-console').click();
  assert.deepEqual(ringed(doc).map((n) => n.id), ['region-tab-wiki'], 'back on the tab');
});

test('a target that is missing, hidden, disabled or inert gives no highlight', async () => {
  const { doc, view } = await coachSetup();
  view.tutorialDraw(coachStep({ target: 'no-such-control' }));
  assert.equal(ringed(doc).length, 0);
  view.tutorialDraw(coachStep({ target: 'vdev-start' }));   // inside a hidden bar
  assert.equal(ringed(doc).length, 0);
  doc.getElementById('serial-connect').disabled = true;
  view.tutorialDraw(coachStep({ target: 'serial-connect' }));
  assert.equal(ringed(doc).length, 0);
  doc.getElementById('serial-connect').disabled = false;
  doc.getElementById('serial-refresh').setAttribute('inert', '');
  view.tutorialDraw(coachStep({ target: 'serial-refresh' }));
  assert.equal(ringed(doc).length, 0);
  view.tutorialDraw(coachStep({ target: 'zoom-in' }));   // a panel that is put away
  assert.equal(ringed(doc).length, 0);
});

test('a target that turns usable after the draw gets the highlight then, and loses it when it stops', async () => {
  const { doc, view } = await coachSetup();
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const connect = doc.getElementById('serial-connect');
  connect.disabled = true;                 // step 10: the virtual board runs, but its port is not listed yet
  view.tutorialDraw(coachStep({ target: 'serial-connect' }));
  assert.equal(ringed(doc).length, 0);
  connect.disabled = false;                // the port list arrived; the coach does not draw again
  await settle();
  assert.deepEqual(ringed(doc).map((n) => n.id), ['serial-connect']);
  connect.parentElement.hidden = true;
  await settle();
  assert.equal(ringed(doc).length, 0, 'a hidden control loses it');
  connect.parentElement.hidden = false;
  await settle();
  assert.deepEqual(ringed(doc).map((n) => n.id), ['serial-connect']);
  view.tutorialLeave();
  connect.disabled = true;
  connect.disabled = false;
  await settle();
  assert.equal(ringed(doc).length, 0, 'nothing is watched after the tutorial');
});

test('the highlighted control is scrolled into view once, when it changes', async () => {
  const { doc, view } = await coachSetup();
  const scrolls = [];
  for (const id of ['serial-connect', 'serial-refresh']) doc.getElementById(id).scrollIntoView = (options) => scrolls.push([id, options]);
  view.tutorialDraw(coachStep({ target: 'serial-connect' }));
  view.tutorialDraw(coachStep({ target: 'serial-connect', hint: 'again' }));
  assert.deepEqual(scrolls, [['serial-connect', { block: 'nearest' }]], 'the same control is not scrolled to again');
  view.tutorialDraw(coachStep({ target: 'serial-refresh' }));
  assert.deepEqual(scrolls.map((s) => s[0]), ['serial-connect', 'serial-refresh']);
});

test('while the tutorial runs an Ask is not delivered and the coach says the answers are examples', async () => {
  const { doc, view } = await coachSetup();
  const ask = async () => {
    view.render(live({ project: { ...project(), captures: [{ id: 'cap_1', kind: 'serial' }] } }));
    doc.getElementById('serial-ask').click();
    await new Promise((r) => setTimeout(r, 0));
    return doc.querySelectorAll('#assistant-log .assistant-msg').length;
  };
  view.tutorialDraw(coachStep({ target: null }));
  assert.equal(await ask(), 0, 'nothing reached the assistant');
  assert.equal(doc.getElementById('tutorial-note').textContent, 'In the tutorial, the assistant\'s answers are examples. Open "Ask the assistant (example)" below the step.');
  assert.equal(doc.querySelector('#panel-assistant').closest('#panel-store') !== null, true, 'the Agent panel stayed put away');
});

test('with the assistant off the example fold-out is not shown', async () => {
  const { doc, view } = await coachSetup();
  assert.equal(doc.getElementById('tutorial-example').hasAttribute('data-ai'), true);
  assert.match(readFileSync(new URL('../css/app.css', import.meta.url), 'utf8'), /\[data-assistant="off"\] \[data-ai\]\s*\{\s*display:\s*none\s*!important/);
  assert.ok(view);
});
