import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createLinkOpener } from '../js/core/links.js';
import { renderMarkdown } from '../js/core/markdown.js';

const doc = new JSDOM('<!doctype html><body></body>').window.document;

function desktop({ answer = true, invoke } = {}) {
  const calls = { invoked: [], asked: [], alerts: [] };
  const win = {
    __TAURI__: { core: { invoke: invoke ?? (async (...args) => { calls.invoked.push(args); }) } },
    confirm: (text) => { calls.asked.push(text); return answer; },
    alert: (text) => calls.alerts.push(text),
  };
  return { win, calls };
}

test('outside the desktop shell there is no opener', () => {
  assert.equal(createLinkOpener({ confirm: () => true }), undefined);
  assert.equal(createLinkOpener({ __TAURI__: {} }), undefined);
  assert.equal(createLinkOpener(undefined), undefined);
});

test('the desktop opener asks with the full address and calls open_link only after a yes', async () => {
  const yes = desktop();
  assert.equal(await createLinkOpener(yes.win)('https://example.org/a?b=1#c'), true);
  assert.match(yes.calls.asked[0], /https:\/\/example\.org\/a\?b=1#c/);
  assert.deepEqual(yes.calls.invoked, [['open_link', { url: 'https://example.org/a?b=1#c' }]]);

  const no = desktop({ answer: false });
  assert.equal(await createLinkOpener(no.win)('https://example.org/'), false);
  assert.deepEqual(no.calls.invoked, [], 'a no opens nothing');
});

test('a refusal from the shell is reported, by alert unless the caller says where', async () => {
  const refuse = async () => { throw 'The link has no host.'; };
  const plain = desktop({ invoke: refuse });
  assert.equal(await createLinkOpener(plain.win)('https://example.org/'), false);
  assert.deepEqual(plain.calls.alerts, ['The link has no host.']);

  const reported = [];
  const where = desktop({ invoke: async () => { throw new Error('xdg-open failed'); } });
  await createLinkOpener(where.win, { report: (message) => reported.push(message) })('https://example.org/');
  assert.deepEqual(reported, ['xdg-open failed']);
  assert.deepEqual(where.calls.alerts, []);
});

test('with an opener, an owner-written link keeps its address and opens through the opener on a click', () => {
  const opened = [];
  const box = doc.createElement('div');
  box.append(renderMarkdown(doc, 'Read [the page](https://example.com/p).', { openExternal: (href) => opened.push(href) }));
  const a = box.querySelector('a');
  assert.equal(a.href, 'https://example.com/p');
  assert.equal(a.target, '', 'no new tab: the shell would refuse it');
  const click = new doc.defaultView.MouseEvent('click', { cancelable: true, bubbles: true });
  a.dispatchEvent(click);
  assert.ok(click.defaultPrevented);
  assert.deepEqual(opened, ['https://example.com/p']);
});

test('page names still go to the wiki and other targets stay text when there is an opener', () => {
  const box = doc.createElement('div');
  box.append(renderMarkdown(doc, '[UART](uart) [bad](javascript:alert(1))', { openExternal: () => {}, onWikiLink: () => {} }));
  assert.equal(box.querySelectorAll('a').length, 1);
  assert.match(box.textContent, /bad \(javascript:alert\(1/);
});
