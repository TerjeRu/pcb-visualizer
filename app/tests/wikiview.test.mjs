import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { ApiError } from '../js/api.js';
import { createWikiView } from '../js/wikiview.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));

const pages = {
  uart: { name: 'uart', title: 'UART', origin: 'builtin', section: 'Interfaces', markdown: '# UART\n\nSee [Ground](ground).\n\n![Adapter wiring](uart-wiring.svg)' },
  ground: { name: 'ground', title: 'Ground', origin: 'data repo', section: 'Your pages', markdown: '# Ground\n\n<img src=x onerror=alert(1)>' },
};

function setup(overrides = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  dom.window.document.getElementById('panel-store').hidden = false;   // as after the layout starts
  const doc = dom.window.document;
  doc.getElementById('tab-wiki').hidden = false;
  const view = createWikiView(doc, {
    loadWikiIndex: async () => Object.values(pages).map(({ markdown, ...p }) => p),
    loadWikiPage: async (name) => { if (!pages[name]) throw new ApiError(404, 'not_found', 'nope'); return pages[name]; },
    ...overrides,
  });
  return { doc, view };
}

test('the index groups pages by section and marks your own', async () => {
  const { doc, view } = setup();
  view.ensure();
  await tick();
  const sections = [...doc.querySelectorAll('#wiki-index .wiki-section h3')].map((h) => h.textContent);
  assert.deepEqual(sections, ['Interfaces', 'Your pages']);
  const items = [...doc.querySelectorAll('#wiki-index .wiki-section li')].map((li) => li.textContent);
  assert.deepEqual(items, ['UART', 'Ground yours']);
  assert.equal(doc.getElementById('wiki-index-button').disabled, true);
});

test('opening a page renders it and links between pages stay in the tab', async () => {
  const { doc, view } = setup();
  await view.open('uart');
  assert.equal(doc.querySelector('#wiki-page h2').textContent, 'UART');
  assert.match(doc.getElementById('wiki-source').textContent, /copy it to ~\/hw\/wiki\/uart\.md/);
  doc.querySelector('#wiki-page a[data-wiki="ground"]').click();
  await tick();
  assert.equal(doc.querySelector('#wiki-page h2').textContent, 'Ground');
  assert.equal(doc.getElementById('wiki-source').textContent, '~/hw/wiki/ground.md');
  assert.equal(doc.querySelectorAll('#wiki-page img').length, 0, 'page HTML stays text');
});

test('figures load through the handler and keep their caption', async () => {
  const asked = [];
  const { doc, view } = setup({ loadWikiFigure: async (file) => { asked.push(file); return 'blob:figure'; } });
  await view.open('uart');
  await tick();
  assert.deepEqual(asked, ['uart-wiring.svg']);
  assert.equal(doc.querySelector('#wiki-page figure img').getAttribute('src'), 'blob:figure');
  assert.equal(doc.querySelector('#wiki-page figcaption').textContent, 'Adapter wiring');
});

test('a figure that cannot be loaded leaves its caption', async () => {
  const { doc, view } = setup({ loadWikiFigure: async () => { throw new Error('gone'); } });
  await view.open('uart');
  await tick();
  assert.equal(doc.querySelectorAll('#wiki-page figure img').length, 0);
  assert.equal(doc.querySelector('#wiki-page figcaption').textContent, 'Adapter wiring');
});

test('a missing page says how to create it', async () => {
  const { doc, view } = setup();
  await view.open('jtag');
  assert.equal(doc.getElementById('wiki-page').hidden, true);
  assert.match(doc.getElementById('wiki-status').textContent, /Create ~\/hw\/wiki\/jtag\.md/);
});

test('a slow answer does not replace a page opened after it', async () => {
  let release;
  const { doc, view } = setup({
    loadWikiPage: (name) => (name === 'uart' ? new Promise((r) => { release = () => r(pages.uart); }) : Promise.resolve(pages[name])),
  });
  const slow = view.open('uart');
  await view.open('ground');
  release();
  await slow;
  assert.equal(doc.querySelector('#wiki-page h2').textContent, 'Ground');
});

test('in the desktop shell a link to another site asks and then opens through the shell; in a browser it is a new-tab link', async () => {
  const withLink = { ...pages.uart, markdown: '# UART\n\nSee [Datasheet](https://example.org/ds).' };
  const { doc, view } = setup({ loadWikiPage: async () => withLink });
  view.ensure();
  await tick();
  doc.querySelector('#wiki-index li a, #wiki-index li button').click();
  await tick();
  assert.equal(doc.querySelector('#wiki-page a').target, '_blank', 'a plain browser is unchanged');

  const { doc: shellDoc, view: shellView } = setup({ loadWikiPage: async () => withLink });
  const win = shellDoc.defaultView;
  const invoked = [];
  const asked = [];
  win.__TAURI__ = { core: { invoke: async (...args) => { invoked.push(args); } } };
  win.confirm = (text) => { asked.push(text); return asked.length === 2; };
  shellView.ensure();
  await tick();
  shellDoc.querySelector('#wiki-index li a, #wiki-index li button').click();
  await tick();
  const link = shellDoc.querySelector('#wiki-page a');
  link.click();
  await tick();
  assert.deepEqual(invoked, [], 'declining opens nothing');
  link.click();
  await tick();
  assert.match(asked[0], /https:\/\/example\.org\/ds/);
  assert.deepEqual(invoked, [['open_link', { url: 'https://example.org/ds' }]]);
});
