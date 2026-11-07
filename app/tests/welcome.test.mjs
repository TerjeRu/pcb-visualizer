import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createView } from '../js/ui.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const CHECKS = [
  { id: 'serial-group', ok: false, label: 'You are in the uucp group.', fix: 'sudo usermod -aG uucp $USER, then log out and in' },
  { id: 'sigrok', ok: true, label: 'sigrok-cli is installed.', fix: 'sudo pacman -S sigrok-cli' },
];

function setup(overrides = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  const calls = [];
  const handlers = {
    benchCheck: async () => { calls.push(['benchCheck']); return CHECKS; },
    startTutorial: async (options) => { calls.push(['tutorial', options]); },
    skipWelcome: async () => { calls.push(['skip']); },
    showWelcome: async () => { calls.push(['showWelcome']); return true; },
    onOpenWiki: (name) => calls.push(['wiki', name]),
    loadWikiPage: async (name) => { calls.push(['page', name]); return { name, title: name, text: `# ${name}` }; },
    ...overrides,
  };
  const view = createView(doc, handlers, { set: () => 1, clear() {} });
  return { doc, view, calls, window: dom.window };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const visible = (doc, id) => !doc.getElementById(id).hidden;

test('the Welcome shows only while welcomed is false, with the data folder', async () => {
  const { doc, view, calls } = setup();
  view.showNoBoards();
  assert.deepEqual([visible(doc, 'no-boards'), visible(doc, 'welcome')], [true, false]);
  view.setWelcome({ welcomed: true, dataFolder: '/home/x/hw' });
  assert.deepEqual([visible(doc, 'no-boards'), visible(doc, 'welcome')], [true, false]);
  assert.equal(calls.length, 0, 'no bench check while the Welcome is not shown');
  view.setWelcome({ welcomed: false, dataFolder: '/home/x/hw' });
  await flush();
  assert.deepEqual([visible(doc, 'no-boards'), visible(doc, 'welcome')], [false, true]);
  assert.equal(doc.getElementById('welcome-folder').textContent, '/home/x/hw');
  view.setWelcome({ welcomed: true });
  assert.deepEqual([visible(doc, 'no-boards'), visible(doc, 'welcome')], [true, false]);
});

test('the bench check lists each line with a text mark and the fix only for what is missing', async () => {
  const { doc, view } = setup();
  view.setWelcome({ welcomed: false });
  await flush();
  const items = [...doc.querySelectorAll('#welcome-checks li')];
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /^Missing You are in the uucp group\./);
  assert.equal(items[0].querySelector('code').textContent, 'sudo usermod -aG uucp $USER, then log out and in');
  assert.match(items[1].textContent, /^OK sigrok-cli/);
  assert.equal(items[1].querySelector('code'), null);
});

test('Check again reads the checks once more, and a failure is shown as text', async () => {
  let fail = false;
  const { doc, view, calls } = setup({ benchCheck: async () => { calls.push(['benchCheck']); if (fail) throw new Error('offline'); return CHECKS; } });
  view.setWelcome({ welcomed: false });
  await flush();
  fail = true;
  doc.getElementById('welcome-checks-again').click();
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'benchCheck').length, 2);
  assert.equal(doc.querySelector('#welcome-checks').textContent, 'Could not run the checks: offline');
});

test('Skip saves through the handler and leaves focus in the board name box', async () => {
  const { doc, view, calls } = setup();
  view.showNoBoards();
  view.setWelcome({ welcomed: false });
  doc.getElementById('welcome-skip').click();
  await flush();
  assert.deepEqual(calls.filter((c) => c[0] === 'skip'), [['skip']]);
  assert.equal(doc.activeElement, doc.getElementById('new-board-name'));
});

test('a failed Skip is reported and focus stays', async () => {
  const { doc, view } = setup({ skipWelcome: async () => { throw new Error('disk full'); } });
  view.showNoBoards();
  view.setWelcome({ welcomed: false });
  doc.getElementById('welcome-skip').click();
  await flush();
  assert.equal(doc.getElementById('message').textContent, 'disk full');
});

test('Start the tutorial starts it and Create my first board focuses the name box', async () => {
  const { doc, view, calls } = setup();
  view.showNoBoards();
  view.setWelcome({ welcomed: false });
  doc.getElementById('welcome-tutorial').click();
  assert.deepEqual(calls.filter((c) => c[0] === 'tutorial'), [['tutorial', { resume: false }]]);
  doc.getElementById('welcome-create').click();
  assert.equal(doc.activeElement, doc.getElementById('new-board-name'));
});

test('Read Start here brings up the board panel and opens the wiki page', () => {
  const { doc, view } = setup();
  view.showNoBoards();
  view.setWelcome({ welcomed: false });
  doc.getElementById('welcome-start').click();
  assert.equal(doc.getElementById('board-panel').hidden, false);
  assert.equal(doc.getElementById('empty-panel').hidden, true);
  assert.equal(doc.getElementById('wiki-back').textContent, '← Back to the welcome');
  doc.getElementById('wiki-back').click();
  assert.equal(doc.getElementById('empty-panel').hidden, false);
  assert.equal(doc.getElementById('board-panel').hidden, true);
  assert.equal(doc.activeElement, doc.getElementById('welcome-start'));
  assert.equal(doc.getElementById('wiki-back').hidden, true, 'nothing the Wiki was opened over');
});

test('What you need opens that wiki page, and Back returns to the Welcome', () => {
  const { doc, view, calls } = setup();
  view.showNoBoards();
  view.setWelcome({ welcomed: false });
  doc.getElementById('welcome-needs').click();
  assert.deepEqual(calls.filter((c) => c[0] === 'page').at(-1), ['page', 'what-you-need']);
  assert.equal(doc.getElementById('board-panel').hidden, false);
  doc.getElementById('wiki-back').click();
  assert.equal(doc.getElementById('empty-panel').hidden, false);
  assert.equal(doc.activeElement, doc.getElementById('welcome-needs'), 'focus returns to the button that opened the page');
});

test('once a board is open, the wiki Back button no longer points at the Welcome', () => {
  const { doc, view } = setup();
  view.showNoBoards();
  view.setWelcome({ welcomed: false });
  doc.getElementById('welcome-start').click();
  view.showBoardPanel();
  assert.equal(doc.getElementById('wiki-back').hidden, true);
  assert.equal(doc.getElementById('board-panel').hidden, false);
});

test('the optional buttons open Settings with focus on the git or assistant switch', () => {
  const { doc, view } = setup();
  view.showNoBoards();
  view.setWelcome({ welcomed: false });
  doc.getElementById('welcome-git').click();
  assert.equal(doc.getElementById('settings-dialog').hasAttribute('open'), true);
  assert.equal(doc.activeElement, doc.getElementById('settings-git'));
  doc.getElementById('welcome-assistant').click();
  assert.equal(doc.activeElement, doc.getElementById('settings-assistant'));
  doc.getElementById('settings-close').click();
  doc.getElementById('settings-open').click();
  assert.equal(doc.activeElement, doc.getElementById('settings-close'), 'a plain open still starts at Close');
});

test('every Welcome control is a real button that Tab can reach, and the explanation is Guided-only', () => {
  const { doc } = setup();
  const buttons = [...doc.querySelectorAll('#welcome button')];
  assert.deepEqual(buttons.map((b) => b.id), ['welcome-tutorial', 'welcome-create', 'welcome-start', 'welcome-needs', 'welcome-git', 'welcome-assistant', 'welcome-checks-again', 'welcome-skip', 'welcome-back']);
  for (const button of buttons) {
    assert.equal(button.type, 'button');
    assert.equal(button.disabled, false);
    assert.notEqual(button.getAttribute('tabindex'), '-1');
  }
  assert.ok(doc.querySelector('#welcome .guide'), 'the explanation carries the guide class that Expert hides');
  assert.match(doc.querySelector('#welcome .terse')?.textContent ?? '', /Nothing leaves this computer/, 'Expert gets the short form');
});

test('Settings lists the bench check when it opens, and Show the welcome again always closes the dialog', async () => {
  const { doc } = setup();
  doc.getElementById('settings-open').click();
  await flush();
  assert.equal(doc.querySelectorAll('#settings-checks li').length, 2);
  doc.getElementById('settings-welcome').click();
  await flush();
  assert.equal(doc.getElementById('settings-dialog').hasAttribute('open'), false, 'the dialog closes when the Welcome is shown');
  assert.equal(doc.getElementById('settings-welcome-note').textContent, '');
});

test('the Welcome opened from Settings shows whatever the saved setting says, with Back when boards exist', async () => {
  const { doc, view, calls } = setup({ backFromWelcome: () => calls.push(['back']) });
  view.setWelcome({ welcomed: true });
  view.showWelcome({ back: true });
  assert.deepEqual([visible(doc, 'welcome'), visible(doc, 'welcome-back'), visible(doc, 'welcome-skip')], [true, true, false]);
  view.setWelcome({ welcomed: true });
  assert.equal(visible(doc, 'welcome'), true, 'a settings update does not hide it');
  doc.getElementById('welcome-back').click();
  assert.deepEqual(calls.at(-1), ['back']);
  view.showBoardPanel();
  assert.deepEqual([visible(doc, 'welcome'), visible(doc, 'welcome-back'), visible(doc, 'welcome-skip')], [false, false, true]);

  view.showWelcome({ back: false });
  assert.deepEqual([visible(doc, 'welcome'), visible(doc, 'welcome-back'), visible(doc, 'welcome-skip')], [true, false, true]);
});

test('the Welcome offers the tutorial by its saved state: start, resume with the step, or nothing once finished', () => {
  const { doc, view, calls } = setup();
  view.showNoBoards();
  view.setWelcome({ welcomed: false });
  const button = doc.getElementById('welcome-tutorial');
  assert.equal(button.textContent, 'Start the tutorial');
  assert.equal(button.classList.contains('primary'), true);
  assert.match(doc.getElementById('welcome-tutorial-note').textContent, /About 20 minutes\. No hardware needed\./);
  view.setTutorial({ state: 'started', step: 7 });
  assert.equal(button.textContent, 'Resume the tutorial (step 7 of 18)');
  button.click();
  assert.deepEqual(calls.at(-1), ['tutorial', { resume: true }]);
  view.setTutorial({ state: 'skipped', step: 1 });
  assert.equal(button.hidden, false);
  assert.equal(button.classList.contains('primary'), false, 'a skipped tutorial is offered quietly');
  view.setTutorial({ state: 'done', step: 18 });
  assert.equal(button.hidden, true);
});

test('Settings has a Tutorial section: start, resume, and start again after a confirmation', async () => {
  const { doc, view, calls } = setup();
  const text = (id) => doc.getElementById(id).textContent;
  const hidden = (id) => doc.getElementById(id).hidden;
  doc.getElementById('settings-open').click();
  await flush();
  assert.match(text('settings-tutorial-status'), /not taken the tutorial yet/);
  assert.equal(hidden('settings-tutorial-resume'), true);
  assert.equal(text('settings-tutorial-start'), 'Start the tutorial');
  doc.getElementById('settings-tutorial-start').click();
  await flush();
  assert.deepEqual(calls.at(-1), ['tutorial', { restart: true }], 'nothing to lose, so no question');
  assert.equal(doc.getElementById('settings-dialog').hasAttribute('open'), false, 'the dialog closes for the tutorial');

  view.setTutorial({ state: 'started', step: 7 });
  doc.getElementById('settings-open').click();
  await flush();
  assert.equal(text('settings-tutorial-status'), 'In progress: step 7 of 18.');
  assert.equal(text('settings-tutorial-resume'), 'Resume the tutorial (step 7 of 18)');
  assert.equal(text('settings-tutorial-start'), 'Start the tutorial again');
  const before = calls.length;
  doc.getElementById('settings-tutorial-start').click();
  assert.equal(hidden('settings-tutorial-confirm'), false);
  assert.match(text('settings-tutorial-confirm'), /Your practice board is cleared\. Your own boards are not touched\./);
  assert.equal(doc.activeElement, doc.getElementById('settings-tutorial-confirm-no'), 'Cancel is the default');
  doc.getElementById('settings-tutorial-confirm-no').click();
  assert.equal(hidden('settings-tutorial-confirm'), true);
  assert.equal(calls.length, before, 'cancel starts nothing');
  doc.getElementById('settings-tutorial-start').click();
  doc.getElementById('settings-tutorial-confirm-yes').click();
  await flush();
  assert.deepEqual(calls.at(-1), ['tutorial', { restart: true }]);
  doc.getElementById('settings-open').click();
  await flush();
  doc.getElementById('settings-tutorial-resume').click();
  await flush();
  assert.deepEqual(calls.at(-1), ['tutorial', { resume: true }]);

  view.setTutorial({ state: 'done', step: 18 });
  doc.getElementById('settings-open').click();
  await flush();
  assert.equal(text('settings-tutorial-status'), 'You finished the tutorial.');
  assert.equal(text('settings-tutorial-start'), 'Start the tutorial again');
  assert.equal(hidden('settings-tutorial-resume'), true);
});

test('the demo board is gone from the Welcome and Settings', () => {
  const { doc } = setup();
  assert.equal(doc.getElementById('welcome-demo'), null);
  assert.equal(doc.getElementById('settings-demo'), null);
  assert.doesNotMatch(doc.getElementById('welcome').textContent + doc.getElementById('settings-dialog').textContent, /demo board/i);
});

test('the board list reads Choose a board while the Welcome covers an open board, and picking a board opens it', () => {
  const { doc, view, calls } = setup({ onSelectBoard: (slug) => calls.push(['select', slug]) });
  view.setBoards(['camera', 'nimbus'], null);
  const select = doc.getElementById('board-select');
  assert.deepEqual([...select.options].map((o) => o.textContent), ['Choose a board', 'camera', 'nimbus', 'New board…']);
  assert.equal(select.value, '');
  select.value = 'camera';
  select.dispatchEvent(new doc.defaultView.Event('change'));
  assert.deepEqual(calls.at(-1), ['select', 'camera']);
  view.setBoards([], null);
  assert.equal(select.options.length, 0, 'no placeholder in an empty list');
  view.setBoards(['camera'], 'camera');
  assert.deepEqual([...select.options].map((o) => o.value), ['camera', '__new__']);
});

test('New board… swaps the list for the name form; Escape and Cancel bring the earlier board back', () => {
  const { doc, view, calls, window } = setup({ onSelectBoard: (slug) => calls.push(['select', slug]) });
  view.setBoards(['camera', 'nimbus'], 'nimbus');
  const field = doc.getElementById('board-field'), form = doc.getElementById('new-board-form'), select = doc.getElementById('board-select');
  const name = doc.getElementById('new-board-name');
  assert.deepEqual([field.hidden, form.hidden], [false, true]);
  select.value = '__new__';
  select.dispatchEvent(new window.Event('change'));
  assert.deepEqual([field.hidden, form.hidden], [true, false]);
  assert.equal(doc.activeElement, name);
  assert.equal(calls.some((c) => c[0] === 'select'), false, 'New board… does not open a board');
  name.value = 'half typed';
  name.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual([field.hidden, form.hidden], [false, true]);
  assert.equal(select.value, 'nimbus');
  assert.equal(name.value, '');
  assert.equal(doc.activeElement, select);
  select.value = '__new__';
  select.dispatchEvent(new window.Event('change'));
  doc.getElementById('new-board-cancel').click();
  assert.deepEqual([field.hidden, form.hidden], [false, true]);
  assert.equal(select.value, 'nimbus');
});

test('with no boards the name form shows at once, and a new list closes it', () => {
  const { doc, view } = setup();
  const field = doc.getElementById('board-field'), form = doc.getElementById('new-board-form');
  assert.deepEqual([field.hidden, form.hidden, doc.getElementById('new-board-cancel').hidden], [true, false, true], 'at the start');
  view.setBoards(['camera'], 'camera');
  assert.deepEqual([field.hidden, form.hidden], [false, true]);
  view.setBoards([], null);
  assert.deepEqual([field.hidden, form.hidden, doc.getElementById('new-board-cancel').hidden], [true, false, true]);
  doc.getElementById('new-board-name').dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(form.hidden, false, 'nothing to go back to');
});

test('Create my first board and Skip open the name form when boards exist', async () => {
  const { doc, view } = setup();
  view.setBoards(['camera'], null);
  view.showNoBoards();
  view.setWelcome({ welcomed: false });
  doc.getElementById('welcome-create').click();
  assert.equal(doc.getElementById('new-board-form').hidden, false);
  assert.equal(doc.activeElement, doc.getElementById('new-board-name'));
});
