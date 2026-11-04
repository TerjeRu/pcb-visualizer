import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { renderMarkdown } from '../js/core/markdown.js';

const doc = new JSDOM('<!doctype html><body></body>').window.document;
const render = (text) => {
  const box = doc.createElement('div');
  box.append(renderMarkdown(doc, text));
  return box;
};

test('paragraphs, lists and inline marks', () => {
  const box = render('Intro line\ncontinues here.\n\n1. First **bold**\n2. Second `code`\n   still second\n\n- a *b*\n- c');
  assert.equal(box.querySelector('p').textContent, 'Intro line continues here.');
  const items = [...box.querySelectorAll('ol li')].map((li) => li.textContent);
  assert.deepEqual(items, ['First bold', 'Second code still second']);
  assert.equal(box.querySelector('ol strong').textContent, 'bold');
  assert.equal(box.querySelector('ol code').textContent, 'code');
  assert.equal(box.querySelectorAll('ul li').length, 2);
  assert.equal(box.querySelector('ul em').textContent, 'b');
});

test('HTML in the source stays text', () => {
  const box = render('<img src=x onerror=alert(1)> and **<script>x()</script>**\n- <b>item</b>');
  assert.equal(box.querySelectorAll('img, script, b').length, 0);
  assert.match(box.textContent, /<img src=x onerror=alert\(1\)>/);
});

test('a figure line asks for the file; anything else stays text', async () => {
  const asked = [];
  const box = doc.createElement('div');
  box.append(renderMarkdown(doc, '![Symbols](symbols.svg)\n\n![x](../etc/passwd.svg)\n\nInline ![y](a.svg) stays.',
    { loadFigure: (file) => { asked.push(file); return 'blob:1'; } }));
  await Promise.resolve();
  assert.deepEqual(asked, ['symbols.svg']);
  assert.equal(box.querySelectorAll('figure').length, 1);
  assert.equal(box.querySelector('figure img').alt, 'Symbols');
  assert.equal(box.querySelector('figure img').getAttribute('src'), 'blob:1');
  assert.equal(render('![Symbols](symbols.svg)').querySelectorAll('figure img').length, 0, 'no loader, caption only');
});

test('odd input does not throw', () => {
  for (const text of [null, undefined, '', '**', '`', '* ', '1.', '\r\n\r\n']) render(text);
});

test('headings, code blocks and tables', () => {
  const box = render('# Title\n\n## Part\n\n```\ntio -b 115200 <path>\n**not bold**\n```\n\n| Pin | Name |\n|---|---|\n| 1 | CS# |\n| 4 | **GND** |');
  assert.equal(box.querySelector('h2').textContent, 'Title');
  assert.equal(box.querySelector('h3').textContent, 'Part');
  assert.equal(box.querySelector('pre code').textContent, 'tio -b 115200 <path>\n**not bold**');
  assert.deepEqual([...box.querySelectorAll('th')].map((c) => c.textContent), ['Pin', 'Name']);
  assert.equal(box.querySelectorAll('tbody tr').length, 2);
  assert.equal(box.querySelector('tbody strong').textContent, 'GND');
});

test('links: page names go to the wiki, http opens a new tab, anything else stays text', () => {
  const opened = [];
  const box = doc.createElement('div');
  box.append(renderMarkdown(doc, 'See [UART](uart), [OpenWrt](https://openwrt.org/toh), [bad](javascript:alert(1)) and [file](../x.md).', { onWikiLink: (n) => opened.push(n) }));
  const links = box.querySelectorAll('a');
  assert.equal(links.length, 2);
  assert.equal(links[0].dataset.wiki, 'uart');
  links[0].click();
  assert.deepEqual(opened, ['uart']);
  assert.equal(links[1].target, '_blank');
  assert.equal(links[1].rel, 'noopener noreferrer');
  assert.match(box.textContent, /bad \(javascript:alert\(1/);
  assert.equal([...links].some((a) => a.href.startsWith('javascript')), false);
});

test('links in untrusted text show their host, do not carry the address, and ask before opening', () => {
  const asked = [];
  const box = doc.createElement('div');
  box.append(renderMarkdown(doc, 'See [the datasheet](https://Evil.Example:8443/a?b=1#c) now.', { confirmExternal: (href) => asked.push(href) }));
  const a = box.querySelector('a');
  assert.equal(a.textContent, 'the datasheet');
  assert.equal(box.querySelector('.link-host').textContent, ' [evil.example:8443]');
  assert.equal(a.getAttribute('href'), '#', 'the address is not in the link');
  assert.equal(a.target, '');
  const click = new doc.defaultView.MouseEvent('click', { cancelable: true, bubbles: true });
  a.dispatchEvent(click);
  assert.ok(click.defaultPrevented);
  assert.deepEqual(asked, ['https://evil.example:8443/a?b=1#c'], 'the full address is what gets confirmed');
});

test('an address that cannot be parsed, or is not http(s), stays plain text in untrusted text', () => {
  const box = doc.createElement('div');
  box.append(renderMarkdown(doc, '[a](https://) [b](javascript:alert) [c](https://exa‮mple.com)', { confirmExternal: () => {} }));
  assert.equal(box.querySelector('a'), null);
  assert.match(box.textContent, /^a \(https:\/\/\) b \(javascript:alert\) /);
});

test('without the option, owner-written links behave as before', () => {
  const a = render('[x](https://example.com/p)').querySelector('a');
  assert.equal(a.href, 'https://example.com/p');
  assert.equal(a.rel, 'noopener noreferrer');
});
