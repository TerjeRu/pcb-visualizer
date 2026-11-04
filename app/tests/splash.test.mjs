import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const ui = (name) => readFileSync(new URL(`../../desktop/ui/${name}`, import.meta.url), 'utf8');

function load(search) {
  const dom = new JSDOM(ui('index.html'), { url: `http://splash.test/index.html${search}`, runScripts: 'outside-only' });
  dom.window.eval(ui('splash.js'));
  return dom.window;
}

const visible = (window, id) => !window.document.getElementById(id).hidden;

test('without a failure only the starting text shows', () => {
  const window = load('');
  assert.ok(visible(window, 'starting'));
  assert.ok(!visible(window, 'failed'));
});

test('a failure shows reason, detail and command and hides the starting text', () => {
  const query = new URLSearchParams({ state: 'failed', reason: 'It broke.', detail: 'boom on line 3', command: 'Run pcbv serve.' });
  const window = load(`?${query}`);
  const text = (id) => window.document.getElementById(id).textContent;
  assert.ok(!visible(window, 'starting'));
  assert.ok(visible(window, 'failed'));
  assert.equal(text('reason'), 'It broke.');
  assert.equal(text('detail'), 'boom on line 3');
  assert.equal(text('command'), 'Run pcbv serve.');
  assert.ok(visible(window, 'detail'));
});

test('an empty detail is not shown', () => {
  const window = load(`?${new URLSearchParams({ state: 'failed', reason: 'x', detail: '', command: 'y' })}`);
  assert.ok(!visible(window, 'detail'));
});

test('markup in the texts stays text', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const window = load(`?${new URLSearchParams({ state: 'failed', reason: hostile, detail: hostile, command: hostile })}`);
  assert.equal(window.document.getElementById('reason').textContent, hostile);
  assert.equal(window.document.querySelectorAll('img').length, 0);
});

test('Retry asks for a retry through the address', () => {
  const dom = new JSDOM(ui('index.html'), { url: 'http://splash.test/index.html', runScripts: 'outside-only' });
  const fake = { search: `?${new URLSearchParams({ state: 'failed', reason: 'x', command: 'y' })}` };
  dom.window.fake = fake;
  dom.window.eval(`(function (location) {${ui('splash.js')}})(window.fake)`);
  dom.window.document.getElementById('retry').click();
  assert.equal(fake.search, '?retry=1');
});
