import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bold, checklist, code, counterText, datedEntry, firstLine, heading, link, list, stamp, toggleTask } from '../js/core/notes.js';

/** Apply an edit the way the panel does and report the text and the selected text. */
const apply = (value, edit) => {
  const next = value.slice(0, edit.from) + edit.text + value.slice(edit.to);
  return { next, picked: edit.select ? next.slice(...edit.select) : null };
};

test('heading adds ## to the current line and takes it away again', () => {
  assert.equal(apply('one\ntwo', heading('one\ntwo', 5)).next, 'one\n## two');
  assert.equal(apply('one\n## two', heading('one\n## two', 6)).next, 'one\ntwo');
  assert.equal(apply('\nx', heading('\nx', 0)).next, '## \nx', 'a cursor at the start of the text uses the first line');
  const cursor = heading('one', 3).select;
  assert.deepEqual(cursor, [6, 6], 'the cursor moves with the text');
});

test('bold wraps the selection, or leaves the cursor between four stars', () => {
  assert.equal(apply('a word here', bold('a word here', 2, 6)).next, 'a **word** here');
  assert.equal(apply('a word here', bold('a word here', 2, 6)).picked, 'word');
  const none = bold('ab', 1, 1);
  assert.equal(apply('ab', none).next, 'a****b');
  assert.deepEqual(none.select, [3, 3]);
});

test('list puts - on each selected line and removes it when every line has it', () => {
  const text = 'one\ntwo\n\nthree';
  const added = apply(text, list(text, 0, text.length));
  assert.equal(added.next, '- one\n- two\n\n- three', 'blank lines in a selection stay blank');
  assert.equal(added.picked, added.next);
  assert.equal(apply(added.next, list(added.next, 0, added.next.length)).next, text);
  assert.equal(apply('x', list('x', 1, 1)).next, '- x');
  assert.equal(apply('- [ ] a\n- b', list('- [ ] a\n- b', 0, 11)).next, 'a\nb', 'a checkbox goes with its bullet');
});

test('list leaves the line a selection ends at the start of alone', () => {
  const text = 'one\ntwo\nthree';
  assert.equal(apply(text, list(text, 0, 8)).next, '- one\n- two\nthree');
});

test('checklist adds a checkbox, turns a bullet into a task, and removes tasks', () => {
  assert.equal(apply('a\n- b\n- [x] c', checklist('a\n- b\n- [x] c', 0, 13)).next, '- [ ] a\n- [ ] b\n- [x] c');
  assert.equal(apply('- [ ] a\n- [x] b', checklist('- [ ] a\n- [x] b', 0, 15)).next, 'a\nb');
  assert.equal(apply('', checklist('', 0, 0)).next, '- [ ] ');
  assert.deepEqual(checklist('', 0, 0).select, [6, 6]);
});

test('code uses backticks on one line and a fenced block over more lines', () => {
  assert.equal(apply('run ls now', code('run ls now', 4, 6)).next, 'run `ls` now');
  assert.equal(apply('run ls now', code('run ls now', 4, 6)).picked, 'ls');
  assert.equal(apply('ab', code('ab', 1, 1)).next, 'a``b');
  const text = 'x\nline 1\nline 2\ny';
  const edit = code(text, 2, 15);
  assert.equal(apply(text, edit).next, 'x\n```\nline 1\nline 2\n```\ny');
  assert.equal(apply(text, edit).picked, 'line 1\nline 2');
  assert.equal(apply('ab\ncd', code('ab\ncd', 1, 4)).next, 'a\n```\nb\nc\n```\nd', 'the fence starts on its own line');
});

test('link wraps the selection and selects the address, or puts the cursor in the brackets', () => {
  const edit = link('see docs now', 4, 8);
  assert.equal(apply('see docs now', edit).next, 'see [docs](https://) now');
  assert.equal(apply('see docs now', edit).picked, 'https://');
  assert.deepEqual(link('', 0, 0).select, [1, 1]);
  assert.equal(apply('', link('', 0, 0)).next, '[](https://)');
});

test('a dated entry starts a new line in the form of pcbv note', () => {
  const date = new Date(2026, 10, 5, 8, 4);
  assert.equal(stamp(date), '2026-11-05 08:04');
  assert.equal(apply('', datedEntry('', date)).next, '- 2026-11-05 08:04 ');
  assert.equal(apply('first', datedEntry('first', date)).next, 'first\n- 2026-11-05 08:04 ');
  assert.equal(apply('first\n', datedEntry('first\n', date)).next, 'first\n- 2026-11-05 08:04 ');
  const edit = datedEntry('first', date);
  assert.deepEqual(edit.select, [edit.from + edit.text.length, edit.from + edit.text.length]);
});

test('toggleTask flips one item, counted like the renderer, and skips code blocks', () => {
  const text = '- [ ] one\n- plain\n```\n- [ ] code\n```\n1. [x] two\n   more\n  * [X] three\n- [ ]';
  assert.equal(apply(text, toggleTask(text, 0)).next.split('\n')[0], '- [x] one');
  assert.equal(apply(text, toggleTask(text, 1)).next.split('\n')[5], '1. [ ] two');
  assert.equal(apply(text, toggleTask(text, 2)).next.split('\n')[7], '  * [ ] three');
  assert.equal(apply(text, toggleTask(text, 3)).next.split('\n')[8], '- [x]');
  assert.equal(toggleTask(text, 4), null);
  assert.equal(toggleTask('- [] no', 0), null);
  const flipped = apply(text, toggleTask(text, 0)).next;
  assert.equal(flipped.length, text.length, 'only one character changes');
});

test('the counter shows from 90,000 characters', () => {
  assert.equal(counterText(89_999), '');
  assert.equal(counterText(92_000), '92,000 of 100,000 characters');
  assert.equal(counterText(100_000), '100,000 of 100,000 characters');
});

test('the first line is the first one with text', () => {
  assert.equal(firstLine('\n  \n  - 2026 note \nsecond'), '- 2026 note');
  assert.equal(firstLine(''), '');
  assert.equal(firstLine(undefined), '');
});
