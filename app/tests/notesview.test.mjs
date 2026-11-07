import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { createNotesView } from '../js/notesview.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function setup({ notes = '', editable = true } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  for (const id of ['board-panel', 'panel-store']) doc.getElementById(id).hidden = false;   // jsdom focuses only what is shown
  const saved = [];
  const waiting = new Map();
  let next = 1;
  const timers = { set: (fn, ms) => { waiting.set(next, { fn, ms }); return next++; }, clear: (id) => waiting.delete(id) };
  const fire = () => { for (const [id, { fn }] of [...waiting]) { waiting.delete(id); fn(); } };
  let answer = true;
  const handlers = { onSaveDetails: async (fields) => { saved.push(fields); return answer; }, onOpenWiki: () => {} };
  const view = createNotesView(doc, handlers, timers, { now: () => new Date(2026, 10, 5, 18, 16) });
  const $ = (id) => doc.getElementById(id);
  const text = $('notes-text');
  const type = (value) => { text.value = value; text.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const click = (id) => $(id).click();
  const select = (start, end = start) => { text.focus(); text.setSelectionRange(start, end); };
  view.render(notes, editable);
  return { dom, doc, view, $, text, saved, waiting, fire, type, click, select, answer: (v) => { answer = v; } };
}

const pressed = (t) => ['edit', 'split', 'preview'].filter((m) => t.$(`notes-mode-${m}`).getAttribute('aria-pressed') === 'true');

test('the default mode is Split from 720 px and Edit below; the choice stays', () => {
  const t = setup();
  assert.deepEqual(pressed(t), ['edit'], 'before the panel has a width, Edit');
  t.view.setWidth(900);
  assert.deepEqual(pressed(t), ['split']);
  assert.equal(t.text.hidden, false);
  assert.equal(t.$('notes-preview').hidden, false);
  t.view.setWidth(719);
  assert.deepEqual(pressed(t), ['edit']);
  assert.equal(t.$('notes-mode-split').disabled, true);
  assert.equal(t.$('notes-preview').hidden, true);
  t.view.setWidth(0);
  assert.deepEqual(pressed(t), ['edit'], 'a width of 0 means the panel is not on screen and changes nothing');
});

test('a chosen mode stays, and Split comes back when the panel is wide again', () => {
  const t = setup();
  t.view.setWidth(900);
  t.click('notes-mode-preview');
  assert.deepEqual(pressed(t), ['preview']);
  assert.equal(t.text.hidden, true);
  t.view.setWidth(500);
  assert.deepEqual(pressed(t), ['preview']);
  t.click('notes-mode-split');
  assert.deepEqual(pressed(t), ['preview'], 'Split is disabled when narrow');
  t.click('notes-mode-edit');
  t.view.setWidth(900);
  assert.deepEqual(pressed(t), ['edit'], 'the person chose Edit');
  t.click('notes-mode-split');
  t.view.setWidth(400);
  assert.deepEqual(pressed(t), ['edit'], 'Split shows Edit while narrow');
  t.view.setWidth(1000);
  assert.deepEqual(pressed(t), ['split'], 'the choice comes back');
});

test('the preview shows formatted notes and an empty state in both guidance levels', () => {
  const t = setup();
  t.view.setWidth(900);
  const empty = t.$('notes-preview');
  assert.match(empty.querySelector('.guide').textContent, /^No notes yet\. Write what you find, or press Add dated entry to start a dated line\.$/);
  assert.equal(empty.querySelector('.terse').textContent, 'No notes.');
  t.type('## Plan\n\nuse `ls`');
  assert.equal(t.$('notes-preview').querySelector('h3').textContent, 'Plan');
  assert.equal(t.$('notes-preview').querySelector('code').textContent, 'ls');
  assert.equal(t.$('notes-preview').querySelector('.guide'), null);
});

test('notes from the service fill the field, and untrusted text never becomes markup', () => {
  const t = setup({ notes: '<img src=x onerror=alert(1)> **b**' });
  t.view.setWidth(900);
  assert.equal(t.text.value, '<img src=x onerror=alert(1)> **b**');
  assert.equal(t.$('notes-preview').querySelector('img'), null);
  assert.equal(t.$('notes-preview').querySelector('strong').textContent, 'b');
});

test('format buttons work on the selection', () => {
  const t = setup({ notes: 'alpha beta\ngamma' });
  t.view.setWidth(900);
  t.select(6, 10);
  t.click('notes-bold');
  assert.equal(t.text.value, 'alpha **beta**\ngamma');
  assert.equal(t.text.value.slice(t.text.selectionStart, t.text.selectionEnd), 'beta');
  t.select(0);
  t.click('notes-heading');
  assert.equal(t.text.value.split('\n')[0], '## alpha **beta**');
  t.click('notes-heading');
  assert.equal(t.text.value.split('\n')[0], 'alpha **beta**');
  t.select(0, t.text.value.length);
  t.click('notes-list');
  assert.equal(t.text.value, '- alpha **beta**\n- gamma');
  t.click('notes-checklist');
  assert.equal(t.text.value, '- [ ] alpha **beta**\n- [ ] gamma');
  t.click('notes-checklist');
  assert.equal(t.text.value, 'alpha **beta**\ngamma');
  assert.equal(t.doc.activeElement, t.text, 'focus goes back to the field');
});

test('bold without a selection leaves the cursor between the stars; code and link', () => {
  const t = setup({ notes: 'x' });
  t.select(1);
  t.click('notes-bold');
  assert.equal(t.text.value, 'x****');
  assert.equal(t.text.selectionStart, 3);
  t.type('see docs');
  t.select(4, 8);
  t.click('notes-link');
  assert.equal(t.text.value, 'see [docs](https://)');
  assert.equal(t.text.value.slice(t.text.selectionStart, t.text.selectionEnd), 'https://');
  t.type('run ls');
  t.select(4, 6);
  t.click('notes-code');
  assert.equal(t.text.value, 'run `ls`');
  t.type('a\nb');
  t.select(0, 3);
  t.click('notes-code');
  assert.equal(t.text.value, '```\na\nb\n```');
});

test('Ctrl+B and Ctrl+K work in the field; Tab is left alone', () => {
  const t = setup({ notes: 'word' });
  t.select(0, 4);
  const key = (init) => { const e = new t.dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }); t.text.dispatchEvent(e); return e; };
  assert.equal(key({ key: 'b', ctrlKey: true }).defaultPrevented, true);
  assert.equal(t.text.value, '**word**');
  t.type('word');
  t.select(0, 4);
  assert.equal(key({ key: 'K', ctrlKey: true }).defaultPrevented, true);
  assert.equal(t.text.value, '[word](https://)');
  assert.equal(key({ key: 'Tab' }).defaultPrevented, false);
  assert.equal(key({ key: 'b' }).defaultPrevented, false);
  assert.equal(key({ key: 'b', ctrlKey: true, shiftKey: true }).defaultPrevented, false);
});

test('format buttons are off in Preview and while the notes cannot be changed', () => {
  const t = setup({ notes: 'x' });
  t.view.setWidth(900);
  t.click('notes-mode-preview');
  assert.equal(t.$('notes-bold').disabled, true);
  assert.equal(t.$('notes-dated').disabled, false);
  t.view.render('x', false);
  assert.equal(t.$('notes-dated').disabled, true);
  assert.equal(t.text.disabled, true);
  t.click('notes-mode-edit');
  assert.equal(t.$('notes-heading').disabled, true);
});

test('Add dated entry starts a dated line, leaves Preview, and saves at once', () => {
  const t = setup({ notes: 'first' });
  t.view.setWidth(900);
  t.click('notes-mode-preview');
  t.click('notes-dated');
  assert.equal(t.text.value, 'first\n- 2026-11-05 18:16 ');
  assert.deepEqual(pressed(t), ['split']);
  assert.equal(t.doc.activeElement, t.text);
  assert.equal(t.text.selectionStart, t.text.value.length);
  assert.deepEqual(t.saved, [{ notes: 'first\n- 2026-11-05 18:16 ' }]);
  assert.equal(t.waiting.size, 0);
  t.view.setWidth(500);
  t.click('notes-mode-preview');
  t.click('notes-dated');
  assert.deepEqual(pressed(t), ['edit'], 'Edit when the panel is narrow');
});

test('typing saves once, a second after the last key', () => {
  const t = setup();
  t.type('a');
  t.type('ab');
  assert.equal(t.saved.length, 0);
  assert.equal([...t.waiting.values()].length, 1, 'one timer, restarted by each key');
  assert.equal([...t.waiting.values()][0].ms, 1000);
  assert.equal(t.$('notes-save').textContent, 'Saving', 'a save that waits for the timer is not a failure');
  t.fire();
  assert.deepEqual(t.saved, [{ notes: 'ab' }]);
  assert.equal(t.$('notes-save').textContent, 'Saving');
  t.view.render('ab', true);
  assert.equal(t.$('notes-save').textContent, 'Saved');
  t.fire();
  assert.equal(t.saved.length, 1);
});

test('leaving the field saves at once, and a text the service already has is not sent', () => {
  const t = setup({ notes: 'kept' });
  t.text.focus();
  t.type('kept and more');
  t.text.blur();
  assert.deepEqual(t.saved, [{ notes: 'kept and more' }]);
  assert.equal(t.waiting.size, 0);
  t.text.focus();
  t.text.blur();
  assert.equal(t.saved.length, 1, 'nothing changed, nothing sent');
  t.view.render('kept and more', true);
  t.type('kept');
  t.view.flush();
  assert.equal(t.saved.length, 2);
  t.view.flush();
  assert.equal(t.saved.length, 2, 'the same text is not sent twice');
});

test('a failed save says Not saved and the next flush sends it again', async () => {
  const t = setup();
  t.answer(false);
  t.type('lost');
  t.view.flush();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(t.$('notes-save').textContent, 'Not saved');
  t.view.render('', true);
  assert.equal(t.text.value, 'lost', 'the text is kept');
  t.type('lost and more');
  assert.equal(t.$('notes-save').textContent, 'Not saved', 'typing does not hide the failure');
  t.answer(true);
  t.view.flush();
  assert.equal(t.saved.length, 2);
  assert.equal(t.$('notes-save').textContent, 'Saving');
});

test('a change from the service waits while the field has focus and arrives when it is left', () => {
  const t = setup({ notes: 'one' });
  t.text.focus();
  t.view.render('one\n- from the CLI', true);
  assert.equal(t.text.value, 'one');
  t.text.blur();
  assert.equal(t.text.value, 'one\n- from the CLI');
  assert.equal(t.saved.length, 0, 'the old text is not sent back');
  t.view.render('later', true);
  assert.equal(t.text.value, 'later', 'with the field not focused it follows at once');
});

test('typed text is not replaced by an older answer, and the next save wins over a CLI line', () => {
  const t = setup({ notes: '' });
  t.type('ab');
  t.view.flush();
  t.type('abc');
  t.view.render('ab', true);
  assert.equal(t.text.value, 'abc');
  t.view.render('x\n- from the CLI', true);
  assert.equal(t.text.value, 'abc', 'unsaved typing is kept');
  t.view.flush();
  assert.deepEqual(t.saved.map((s) => s.notes), ['ab', 'abc']);
});

test('reset drops the text and a pending save of the old board', async () => {
  const t = setup({ notes: 'old' });
  t.type('old edit');
  t.view.reset();
  assert.equal(t.text.value, '');
  assert.equal(t.waiting.size, 0);
  t.view.flush();
  assert.equal(t.saved.length, 0);
  t.view.render('new board', true);
  assert.equal(t.text.value, 'new board');
});

test('the counter shows from 90,000 characters and the field has the limit', () => {
  const t = setup();
  assert.equal(t.text.getAttribute('maxlength'), '100000');
  assert.equal(t.$('notes-counter').hidden, true);
  t.type('x'.repeat(92_000));
  assert.equal(t.$('notes-counter').hidden, false);
  assert.equal(t.$('notes-counter').textContent, '92,000 of 100,000 characters');
  t.type('x'.repeat(89_999));
  assert.equal(t.$('notes-counter').hidden, true);
});

test('a button edit that would pass the limit is refused', () => {
  const t = setup({ notes: 'x'.repeat(99_999) });
  t.select(0, 0);
  t.click('notes-checklist');
  assert.equal(t.text.value.length, 99_999);
  t.click('notes-dated');
  assert.equal(t.text.value.length, 99_999);
  assert.equal(t.saved.length, 0);
});

test('ticking a task in the preview changes the text to [x] and saves at once', () => {
  const t = setup({ notes: '- [ ] solder J2\n- [x] photo' });
  t.view.setWidth(900);
  const boxes = [...t.$('notes-preview').querySelectorAll('input[type=checkbox]')];
  assert.deepEqual(boxes.map((b) => [b.disabled, b.checked]), [[false, false], [false, true]]);
  boxes[0].dispatchEvent(new t.dom.window.Event('change'));
  assert.equal(t.text.value, '- [x] solder J2\n- [x] photo');
  assert.deepEqual(t.saved, [{ notes: '- [x] solder J2\n- [x] photo' }]);
  const again = [...t.$('notes-preview').querySelectorAll('input[type=checkbox]')];
  assert.equal(again[0].checked, true);
  again[1].dispatchEvent(new t.dom.window.Event('change'));
  assert.equal(t.text.value, '- [x] solder J2\n- [ ] photo');
});

test('the checkboxes are disabled while the notes cannot be changed', () => {
  const t = setup({ notes: '- [ ] a', editable: false });
  t.view.setWidth(900);
  assert.equal(t.$('notes-preview').querySelector('input').disabled, true);
});

test('a state update that changes nothing leaves the preview alone', () => {
  const t = setup({ notes: '- [ ] a' });
  t.view.setWidth(900);
  const before = t.$('notes-preview').firstChild;
  t.view.render('- [ ] a', true);
  assert.equal(t.$('notes-preview').firstChild, before);
});
