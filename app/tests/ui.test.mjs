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
const live = (extra = {}) => ({ status: 'live', project: project(), error: null, ...extra });

test('untrusted text is shown as text, never parsed as markup', () => {
  const { doc, view } = setup();
  const evil = '<img src=x onerror=alert(1)><script>boom()</script>';
  view.showBoardPanel();
  view.setBoards([evil], evil);
  view.render(live({
    project: project({ name: evil, notes: evil }),
  }));
  assert.equal(doc.querySelectorAll('img:not(#photo)').length, 0);   // #photo is the board photo element itself
  assert.equal(doc.body.querySelectorAll('script').length, 0);
  assert.equal(doc.getElementById('field-name').value, evil);
  assert.equal(doc.querySelector('#board-select option').textContent, evil);
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
  const notes = doc.getElementById('field-device');
  notes.focus();
  view.render(live({ project: project({ device: 'from the CLI' }) }));
  assert.equal(notes.value, 'AX');
  notes.blur();
  assert.equal(notes.value, 'from the CLI');
  assert.equal(calls.length, 0);
});

test('a field edited while focused keeps the typed text on leaving', () => {
  const { doc, view } = setup();
  view.showBoardPanel();
  view.render(live());
  const notes = doc.getElementById('field-device');
  notes.focus();
  notes.value = 'mine';
  view.render(live({ project: project({ device: 'from the CLI' }) }));
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

test('editing a field reports the name and the device once on change, and not the notes', () => {
  const { dom, doc, view, calls } = setup();
  view.render(live());
  const device = doc.getElementById('field-device');
  device.value = 'AX3000';
  device.dispatchEvent(new dom.window.Event('change'));
  assert.deepEqual(calls, [['onSaveDetails', { name: 'Router', device: 'AX3000' }]]);
  assert.equal(doc.getElementById('field-notes'), null, 'the notes have their own panel');
});

test('the Board card shows the first line of the notes, or says there are none', () => {
  const { doc, view } = setup();
  view.render(live());
  assert.equal(doc.getElementById('open-notes').textContent, 'No notes yet');
  view.render(live({ project: project({ notes: '\n- 2026-11-05 18:16 UART on J2\nsecond line' }) }));
  assert.equal(doc.getElementById('open-notes').textContent, '- 2026-11-05 18:16 UART on J2');
  view.render(live({ project: project({ notes: `${'x'.repeat(200)}\nnext` }) }));
  assert.equal(doc.getElementById('open-notes').textContent, `${'x'.repeat(79)}…`);
  assert.equal(doc.getElementById('notes-text').value, `${'x'.repeat(200)}\nnext`, 'the panel holds the whole text');
});

test('the Board card button brings the Notes panel forward, also from away, and focuses the text', async () => {
  const { doc, view, pause } = await dockedSetup();
  doc.getElementById('board-panel').hidden = false;   // jsdom focuses only what is shown
  view.render(live({ project: project({ notes: 'text' }) }));
  doc.getElementById('open-notes').click();
  await pause();
  assert.equal(doc.querySelector('#region-center [role="tab"][aria-selected="true"]').dataset.panel, 'notes');
  assert.equal(doc.activeElement.id, 'notes-text');
  doc.getElementById('panels-open').click();
  [...doc.querySelectorAll('.panels-row[data-panel="notes"] [role="menuitem"]')].find((b) => b.textContent === 'Put away').click();
  assert.equal(doc.querySelector('#region-center [data-panel="notes"]'), null);
  doc.getElementById('open-notes').click();
  await pause();
  assert.equal(doc.querySelector('#region-center [role="tab"][aria-selected="true"]').dataset.panel, 'notes', 'it comes back from away');
});

test('unsaved notes are sent when the board is left', () => {
  const { dom, doc, view, calls } = setup();
  view.render(live());
  const text = doc.getElementById('notes-text');
  text.value = 'half done';
  text.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(calls.length, 0);
  view.flushNotes();
  assert.deepEqual(calls, [['onSaveDetails', { notes: 'half done' }]]);
  view.showBoardPanel();
  assert.equal(text.value, '', 'the next board starts empty');
});

test('the header and pin notes are text boxes that grow with their text', () => {
  const { dom, doc } = setup();
  const header = doc.getElementById('header-notes');
  const pin = doc.getElementById('pin-note');
  assert.equal(header.tagName, 'TEXTAREA');
  assert.equal(pin.tagName, 'TEXTAREA');
  assert.deepEqual([header.rows, header.dataset.maxRows, pin.rows, pin.dataset.maxRows], [3, '12', 2, '8']);
  assert.equal(pin.getAttribute('maxlength'), '400');
  for (const [box, rows] of [[header, '12'], [pin, '8']]) {
    Object.defineProperty(box, 'scrollHeight', { value: 96, configurable: true });
    box.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(box.style.height, '96px');
    assert.equal(box.style.getPropertyValue('--rows'), rows, 'CSS caps the height at this many rows');
  }
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
  for (const id of ['empty-panel', 'assistant-empty', 'inspector-empty', 'viewer-empty', 'logic-empty']) {
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

test('a control inside a closed dialog puts the highlight on the button that opens it', async () => {
  const t = await dockedSetup();
  t.doc.getElementById('board-panel').hidden = false;
  await t.view.tutorialEnter(['board']);
  const { doc, view } = t;
  view.tutorialDraw(coachStep({ target: 'export-run' }));
  assert.deepEqual(ringed(doc).map((n) => n.id), ['export-open']);
  doc.getElementById('export-open').click();
  await new Promise((resolve) => setTimeout(resolve, 0));        // the observer redraws the ring
  assert.deepEqual(ringed(doc).map((n) => n.id), ['export-run'], 'the dialog is open now');
  doc.getElementById('export-close').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(ringed(doc).map((n) => n.id), ['export-open']);
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

const chip = (doc) => doc.getElementById('status');

test('the chip says Saved, then Saving only after 400 ms, then Not saved with the reason', () => {
  const { doc, view, timers } = setup();
  view.showBoardPanel();
  view.render(live({ save: { pending: 0, at: null, error: null } }));
  assert.equal(chip(doc).textContent, 'Saved');
  assert.equal(chip(doc).dataset.state, 'saved');
  view.render(live({ save: { pending: 1, at: null, error: null } }));
  assert.equal(chip(doc).textContent, 'Saved', 'a short write does not flicker');
  timers.fn();
  assert.equal(chip(doc).textContent, 'Saving');
  assert.equal(chip(doc).dataset.state, 'saving');
  view.render(live({ save: { pending: 0, at: new Date(2026, 10, 5, 18, 16).getTime(), error: null } }));
  assert.equal(chip(doc).textContent, 'Saved 18:16');
  view.render(live({ save: { pending: 0, at: null, error: 'The disk is full.' } }));
  assert.equal(chip(doc).textContent, 'Not saved');
  assert.equal(chip(doc).title, 'The disk is full.');
  view.render(live({ status: 'reconnecting', save: { pending: 0, at: null, error: 'x' } }));
  assert.equal(chip(doc).textContent, 'Reconnecting');
});

function menuSetup({ git = 'off', folder = '/home/t/hw/boards/nimbus', commit = '2026-11-05T18:02:00+01:00', labels = { undo: null, redo: null } } = {}) {
  const t = setup();
  const copied = [];
  const revealed = [];
  const stepped = [];
  const win = t.doc.defaultView;
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async (text) => { copied.push(text); } }, configurable: true });
  const view = createView(t.doc, {
    onSaveDetails() {}, loadPhoto: async () => 'blob:test',
    boardFolder: async () => folder, revealBoard: () => revealed.push('board'),
    gitStatus: async () => ({ detail: { last_commit: commit } }),
    historyLabels: () => labels, undo: () => stepped.push('undo'), redo: () => stepped.push('redo'),
  }, { set: () => 1, clear() {} });
  t.doc.documentElement.dataset.git = git;
  return { ...t, view, copied, revealed, stepped };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const key = (doc, target, name) => target.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

test('the chip is plain text without a board and a menu button with one', () => {
  const { doc, view } = menuSetup();
  view.showNoBoards();
  assert.equal(doc.getElementById('status-button').disabled, true);
  view.showBoardPanel();
  view.render(live());
  assert.equal(doc.getElementById('status-button').disabled, false);
  assert.equal(doc.getElementById('status-button').getAttribute('aria-haspopup'), 'menu');
});

test('the status menu shows the folder, copies it, opens it, and closes with Esc to the chip', async () => {
  const { doc, view, copied, revealed } = menuSetup();
  view.showBoardPanel();
  view.render(live());
  const button = doc.getElementById('status-button');
  button.click();
  await flush();
  const menu = doc.querySelector('.status-menu');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  assert.deepEqual(items.map((i) => i.firstChild.textContent), ['Nothing to undo', 'Nothing to redo', 'Copy folder path', 'Open board folder']);
  assert.equal(items[2].querySelector('.menu-sub').textContent, '/home/t/hw/boards/nimbus');
  assert.equal(doc.activeElement, items[3]);
  key(doc, items[3], 'ArrowDown');
  assert.equal(doc.activeElement, items[0]);
  key(doc, items[0], 'End');
  assert.equal(doc.activeElement, items[3]);
  items[2].click();
  assert.deepEqual(copied, ['/home/t/hw/boards/nimbus']);
  assert.equal(doc.querySelector('.status-menu'), null);
  button.click();
  await flush();
  doc.querySelectorAll('.status-menu [role="menuitem"]')[3].click();
  assert.deepEqual(revealed, ['board']);
  button.click();
  await flush();
  key(doc, doc.activeElement, 'Escape');
  assert.equal(doc.querySelector('.status-menu'), null);
  assert.equal(doc.activeElement, button);
});

test('the Last commit line shows only with git on', async () => {
  for (const [git, expected] of [['off', 0], ['on', 1]]) {
    const { doc, view } = menuSetup({ git });
    view.showBoardPanel();
    view.render(live());
    doc.getElementById('status-button').click();
    await flush();
    await flush();
    const lines = [...doc.querySelectorAll('.status-menu .menu-note')];
    assert.equal(lines.length, expected, git);
    if (expected) assert.match(lines[0].textContent, /^Last commit: /);
  }
});

test('Open board folder in the Board card asks the controller', () => {
  const { doc, view, revealed } = menuSetup();
  view.showBoardPanel();
  doc.getElementById('reveal-board').click();
  assert.deepEqual(revealed, ['board']);
});

test('Undo and Redo in the status menu are named after the change and do nothing when there is none', async () => {
  const { doc, view, stepped } = menuSetup({ labels: { undo: 'Header marked: J2', redo: '' } });
  view.showBoardPanel();
  view.render(live());
  doc.getElementById('status-button').click();
  await flush();
  const [undo, redo] = doc.querySelectorAll('.status-menu [role="menuitem"]');
  assert.equal(undo.firstChild.textContent, 'Undo: Header marked: J2');
  assert.equal(undo.querySelector('.menu-sub').textContent, 'Ctrl+Z');
  assert.equal(undo.getAttribute('aria-keyshortcuts'), 'Control+Z');
  assert.equal(redo.firstChild.textContent, 'Redo last change');
  assert.equal(redo.getAttribute('aria-disabled'), null);
  undo.click();
  assert.deepEqual(stepped, ['undo']);
  assert.equal(doc.querySelector('.status-menu'), null, 'the menu closes');

  const empty = menuSetup();
  empty.view.showBoardPanel();
  empty.view.render(live());
  empty.doc.getElementById('status-button').click();
  await flush();
  const nothing = empty.doc.querySelector('.status-menu [role="menuitem"]');
  assert.equal(nothing.getAttribute('aria-disabled'), 'true');
  nothing.click();
  assert.deepEqual(empty.stepped, []);
});

const press = (doc, target, key, mods = {}) => {
  const event = new doc.defaultView.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ctrlKey: true, ...mods });
  target.dispatchEvent(event);
  return event.defaultPrevented;
};

test('Ctrl+Z undoes and Ctrl+Shift+Z and Ctrl+Y redo, outside fields that have their own undo', () => {
  const { doc, stepped } = menuSetup();
  assert.equal(press(doc, doc.body, 'z'), true);
  press(doc, doc.body, 'Z', { shiftKey: true });
  press(doc, doc.body, 'y');
  assert.deepEqual(stepped, ['undo', 'redo', 'redo']);
  for (const id of ['notes-text', 'field-name', 'pin-label']) {
    const field = doc.getElementById(id);
    assert.ok(field, id);
    assert.equal(press(doc, field, 'z'), false, id);
  }
  const editable = doc.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  doc.body.append(editable);
  press(doc, editable, 'z');
  press(doc, doc.body, 'z', { altKey: true });
  press(doc, doc.body, 'z', { ctrlKey: false });
  assert.deepEqual(stepped, ['undo', 'redo', 'redo']);
  // a checkbox and a select have no text undo, so the board change is undone there
  const box = doc.createElement('input');
  box.type = 'checkbox';
  doc.body.append(box);
  assert.equal(press(doc, box, 'z'), true);
  assert.equal(press(doc, doc.getElementById('pin-role'), 'z'), true);
  assert.deepEqual(stepped, ['undo', 'redo', 'redo', 'undo', 'undo']);
});
