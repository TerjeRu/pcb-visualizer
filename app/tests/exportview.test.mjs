import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { createExportView } from '../js/exportview.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(exportBoard) {
  const doc = new JSDOM(html).window.document;
  doc.getElementById('board-panel').hidden = false;      // as after the layout starts, so the button can take focus
  doc.getElementById('panel-store').hidden = false;
  const calls = [];
  const view = createExportView(doc, { exportBoard: async (...args) => { calls.push(args); return exportBoard(...args); } });
  const submit = () => doc.getElementById('export-form').dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  return { doc, calls, submit, view };
}

test('export sends the ticked formats, redacted by default, and says where the files went', async () => {
  const { doc, calls, submit } = setup(async () => ({ folder: '/home/t/pcbv-exports/demo', files: ['a.png', 'report.md', 'pinouts.csv'], redacted: true, counts: { mac: 1, credential: 1 } }));
  submit();
  await tick();
  assert.deepEqual(calls, [[['photo', 'report', 'csv'], true]]);
  assert.equal(doc.getElementById('export-result').textContent, '3 files in /home/t/pcbv-exports/demo. Redacted: 2 distinct values replaced. Open folder');
  assert.equal(doc.getElementById('export-run').disabled, false);
});

test('turning redaction off warns, and the result says to keep it private', async () => {
  const { doc, calls, submit } = setup(async () => ({ folder: '/x', files: ['report.md'], redacted: false, counts: {} }));
  const redact = doc.getElementById('export-redact');
  redact.checked = false;
  redact.dispatchEvent(new doc.defaultView.Event('change'));
  assert.equal(doc.getElementById('export-warning').hidden, false);
  submit();
  await tick();
  assert.equal(calls[0][1], false);
  assert.match(doc.getElementById('export-result').textContent, /The files are not redacted. Keep them private/);
});

test('a redacted export with nothing to replace says so plainly', async () => {
  const { doc, submit } = setup(async () => ({ folder: '/x', files: ['report.md'], redacted: true, counts: {} }));
  submit();
  await tick();
  assert.match(doc.getElementById('export-result').textContent, /nothing matched the redaction rules/);
});

test('no format chosen, or a failure, is explained', async () => {
  const { doc, calls, submit } = setup(async () => { throw new Error('the export cannot go inside the board folder'); });
  for (const box of doc.querySelectorAll('#export-form input[name="format"]')) box.checked = false;
  submit();
  assert.equal(calls.length, 0);
  assert.match(doc.getElementById('export-result').textContent, /at least one format/);
  doc.querySelector('#export-form input[value="zip"]').checked = true;
  submit();
  await tick();
  assert.match(doc.getElementById('export-result').textContent, /Could not export: the export cannot go inside/);
});

test('an export that finishes after a board switch is not reported for the new board', async () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  let release;
  const view = createExportView(doc, { exportBoard: () => new Promise((resolve) => { release = resolve; }) });
  doc.querySelector('#export-form input[name="format"]').checked = true;
  doc.getElementById('export-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  assert.equal(doc.getElementById('export-run').disabled, true);
  view.reset();
  assert.equal(doc.getElementById('export-result').textContent, '');
  assert.equal(doc.getElementById('export-run').disabled, false);
  release({ files: ['a.png'], folder: 'exports/old', redacted: true, counts: {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(doc.getElementById('export-result').textContent, '');
});

test('a finished export is reported for the tutorial, a failed one is not', async () => {
  const doc = new JSDOM(html).window.document;
  let fail = false;
  let reports = 0;
  createExportView(doc, { exportBoard: async () => { if (fail) throw new Error('no'); return { folder: '/x', files: ['a'], redacted: true, counts: {} }; }, noteExport: () => { reports += 1; } });
  const submit = () => doc.getElementById('export-form').dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  submit();
  await tick();
  assert.equal(reports, 1);
  fail = true;
  submit();
  await tick();
  assert.equal(reports, 1);
});

test('the result has an Open folder button that asks for the folder the export returned', async () => {
  const opened = [];
  const doc = new JSDOM(html).window.document;
  createExportView(doc, { exportBoard: async () => ({ folder: '/x/nimbus-1', files: ['report.md'], redacted: true, counts: {} }), revealExport: (folder) => opened.push(folder) });
  doc.getElementById('export-form').dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await tick();
  const button = doc.querySelector('#export-result button');
  assert.equal(button.textContent, 'Open folder');
  button.click();
  assert.deepEqual(opened, ['/x/nimbus-1']);
});

test('Export… opens a dialog with the form; Close and Escape close it and the focus goes back to the button', () => {
  const { doc } = setup(async () => ({}));
  const dialog = doc.getElementById('export-dialog');
  const button = doc.getElementById('export-open');
  assert.equal(button.closest('.step-actions').contains(doc.getElementById('reveal-board')), true, 'in the actions row');
  assert.equal(doc.getElementById('export'), null, 'the fold is gone from the Board card');
  assert.equal(dialog.querySelector('#export-form') !== null && dialog.querySelector('#export-result') !== null, true);
  assert.equal(dialog.open, false);
  button.click();
  assert.equal(dialog.open, true);
  assert.equal(doc.activeElement.name, 'format', 'focus is inside the dialog');
  doc.getElementById('export-close').click();
  assert.equal(dialog.open, false);
  assert.equal(doc.activeElement, button);
  button.click();
  dialog.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(dialog.open, false);
  assert.equal(doc.activeElement, button);
});

test('a board switch closes the dialog and clears the result', () => {
  const { doc, view } = setup(async () => ({}));
  doc.getElementById('export-open').click();
  doc.getElementById('export-result').textContent = 'old board';
  view.reset();
  assert.equal(doc.getElementById('export-dialog').open, false);
  assert.equal(doc.getElementById('export-result').textContent, '');
});
