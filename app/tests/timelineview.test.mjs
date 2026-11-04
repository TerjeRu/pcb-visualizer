import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { createTimelineView } from '../js/timelineview.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));
const deferred = () => { const d = {}; d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; }); return d; };
const state = (seq) => ({ status: 'live', seq, project: { meta: { name: 'B' }, assets: [], markers: [], schematics: [], components: [] } });

function setup(overrides = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  doc.getElementById('panel-store').hidden = false;
  doc.documentElement.dataset.git = overrides.git ?? 'on';
  delete overrides.git;
  const calls = [];
  const handlers = {
    loadEvents: async (since) => { calls.push(['events', since]); return { events: [], seq: 0 }; },
    loadCommits: async () => { calls.push(['commits']); return []; },
    loadCaptureLog: async () => '',
    onJump() {},
    ...overrides,
  };
  const view = createTimelineView(doc, handlers);
  return { doc, view, calls };
}

const event = (seq) => ({ seq, ts: '2026-10-30T10:00:00Z', actor: 'web', type: 'project/metaUpdated', patch: { notes: `n${seq}` } });

test('commits are fetched once per board and again on an explicit refresh', async () => {
  const { doc, view, calls } = setup();
  view.show(state(0));
  view.hide();
  view.show(state(0));
  view.hide();
  view.show(state(0));
  await tick();
  assert.equal(calls.filter((c) => c[0] === 'commits').length, 1);
  doc.getElementById('timeline-refresh').click();
  await tick();
  assert.equal(calls.filter((c) => c[0] === 'commits').length, 2);
  view.reset();
  view.show(state(0));
  await tick();
  assert.equal(calls.filter((c) => c[0] === 'commits').length, 3, 'a new board loads its own');
});

test('a failed commit fetch is tried again the next time the timeline is shown, never in between', async () => {
  let tries = 0;
  let fail = true;
  const { doc, view } = setup({ loadCommits: async () => { tries += 1; if (fail) throw new Error('offline'); return [{ hash: 'abc', ts: '2026-10-30T10:00:00Z', subject: 'first commit' }]; } });
  view.show(state(0));
  view.show(state(0));
  await tick();
  assert.equal(tries, 1, 'one request while it is running');
  view.render(state(0));
  await tick();
  assert.equal(tries, 1, 'state updates do not retry');
  fail = false;
  view.hide();
  view.show(state(0));
  await tick();
  assert.equal(tries, 2);
  assert.match(doc.getElementById('timeline-list').textContent, /first commit/);
  view.hide();
  view.show(state(0));
  await tick();
  assert.equal(tries, 2, 'once loaded, it is not fetched again');
});

test('history and commits that arrive after a board switch are dropped', async () => {
  const events = deferred();
  const commits = deferred();
  const { doc, view } = setup({ loadEvents: () => events.promise, loadCommits: () => commits.promise });
  view.show(state(1));
  view.reset();
  events.resolve({ events: [event(1)], seq: 1 });
  commits.resolve([{ hash: 'abc', ts: '2026-10-30T10:00:00Z', subject: 'old board commit' }]);
  await tick();
  view.show(state(0));
  assert.doesNotMatch(doc.getElementById('timeline-list').textContent, /old board commit|n1/);
  assert.equal(doc.querySelector('#timeline-status .guide').textContent.startsWith('Nothing has happened on this board yet.'), true);
});

test('a log that loads after a board switch is not shown', async () => {
  const log = deferred();
  const { doc, view } = setup({
    loadEvents: async () => ({ events: [{ seq: 1, ts: '2026-10-30T10:00:00Z', actor: 'web', type: 'capture/started', capture: { id: 'cap_1', kind: 'serial', label: 'Console', path: 'captures/serial/a.log' } }], seq: 1 }),
    loadCaptureLog: () => log.promise,
  });
  view.show(state(1));
  await tick();
  const link = doc.querySelector('#timeline-list a.tl-title');
  assert.ok(link, 'the console session has a link to its log');
  link.click();
  view.reset();
  log.resolve('U-Boot from the old board');
  await tick();
  assert.doesNotMatch(doc.getElementById('timeline-log-output').textContent, /old board/);
});

test('an empty history has a Guided sentence and a short form for Expert', async () => {
  const { doc, view } = setup();
  view.show(state(0));
  await tick();
  const status = doc.getElementById('timeline-status');
  assert.ok(status.querySelector('.guide').textContent.length > status.querySelector('.terse').textContent.length);
  assert.equal(status.querySelector('.terse').textContent, 'No events.');
});

test('once there is history the empty state is gone', async () => {
  const { doc, view } = setup({ loadEvents: async () => ({ events: [event(1)], seq: 1 }) });
  view.show(state(1));
  await tick();
  const status = doc.getElementById('timeline-status');
  assert.equal(status.querySelector('.guide'), null);
  assert.equal(status.textContent, '');
});

const chips = (doc) => [...doc.querySelectorAll('#timeline-filters .chip')].map((chip) => chip.dataset.kind);

test('with git off there is no Commits chip and no commit request, and the guide text does not mention commits', async () => {
  const { doc, view, calls } = setup({ git: 'off' });
  assert.ok(!chips(doc).includes('commit'));
  assert.ok(chips(doc).includes('photo'));
  view.show(state(0));
  doc.getElementById('timeline-refresh').click();
  await tick();
  assert.equal(calls.filter((c) => c[0] === 'commits').length, 0);
  assert.doesNotMatch(doc.getElementById('timeline-status').textContent, /commit/i);
  const hiddenByCss = (selector) => [...doc.querySelectorAll(selector)].map((node) => node.textContent);
  assert.match(hiddenByCss('[data-git-off-only]').join(' '), /^Every change and capture/);
  assert.match(hiddenByCss('[data-git-only]').join(' '), /commit/i);
});

test('turning git on brings the chip and the commits back without a reload, and off takes them away again', async () => {
  const { doc, view } = setup({
    git: 'off',
    loadCommits: async () => [{ hash: 'abc', date: '2026-10-30T10:00:00Z', subject: 'first commit' }],
  });
  view.show(state(0));
  await tick();
  doc.documentElement.dataset.git = 'on';
  view.setGit();
  await tick();
  assert.ok(chips(doc).includes('commit'));
  assert.match(doc.getElementById('timeline-list').textContent, /first commit/);
  doc.querySelector('[data-kind="commit"]').click();
  doc.documentElement.dataset.git = 'off';
  view.setGit();
  assert.ok(!chips(doc).includes('commit'));
  assert.doesNotMatch(doc.getElementById('timeline-list').textContent, /first commit/);
  doc.documentElement.dataset.git = 'on';
  view.setGit();
  assert.equal(doc.querySelector('[data-kind="commit"]').getAttribute('aria-pressed'), 'true', 'a filter set before git went off is forgotten');
});
