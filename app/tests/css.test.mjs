import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');

test('the narrow-window rule comes after the dock rules and names one column of areas', () => {
  const start = css.indexOf('@media (max-width: 860px)');
  assert.notEqual(start, -1);
  const block = css.slice(start, css.indexOf('\n}\n', start));
  const areas = block.match(/grid-template-areas:\s*((?:"[^"]*"\s*)+);/);
  assert.ok(areas, 'the rule sets its own areas');
  const rows = [...areas[1].matchAll(/"([^"]*)"/g)].map((m) => m[1].trim().split(/\s+/));
  assert.ok(rows.length >= 2 && rows.every((row) => row.length === 1), 'every area row has exactly one column');
  assert.match(block, /grid-template-columns:\s*(minmax\(0,\s*1fr\)|1fr)/);
  for (const rule of ['.board:not(.has-center):not(.has-right) {', '#region-bottom {', '.board {']) {
    assert.ok(css.lastIndexOf(rule, start) !== -1 && css.lastIndexOf(rule, start) < start, `${rule} is defined before the narrow rule`);
  }
  assert.equal(css.indexOf('@media (max-width: 860px)', start + 10), -1, 'only one such rule remains');
});

test('panel windows hide the board picker, since the board follows the main window', () => {
  assert.match(css, /\.single-panel[^{]*#board-field[^{]*\{[^}]*display:\s*none/);
});

const tokenBlock = (selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} defines tokens`);
  return css.slice(start, css.indexOf('\n}', start));
};
const tokensOf = (block) => Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const light = tokensOf(tokenBlock(':root'));
const dark = { ...light, ...tokensOf(tokenBlock(':root[data-theme="dark"]')) };

const luminance = (value) => {
  const hex = value.length === 4 ? `#${[...value.slice(1)].map((c) => c + c).join('')}` : value;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('the focus ring has at least 3:1 contrast against the surfaces it sits on, in both themes', () => {
  for (const [name, set] of [['light', light], ['dark', dark]]) {
    for (const surface of ['--win', '--view', '--btn', '--field']) {
      const ratio = contrast(set['--focus'], set[surface]);
      assert.ok(ratio >= 3, `${name}: --focus on ${surface} is ${ratio.toFixed(2)}:1`);
    }
  }
  assert.match(css, /:focus-visible\s*\{[^}]*var\(--focus\)/);
  assert.match(css, /\.stage :focus-visible[^{]*\{[^}]*var\(--scr-hi\)/, 'dark instrument surfaces use a light ring');
  assert.ok(contrast(light['--scr-hi'], light['--scr-bg']) >= 3);
});

test('the dark tokens are written once, with no second copy behind a media query', () => {
  assert.equal(css.match(/--win:/g).length, 2, 'one light and one dark value');
  assert.doesNotMatch(css, /prefers-color-scheme/);
  for (const name of Object.keys(tokensOf(tokenBlock(':root[data-theme="dark"]')))) assert.ok(name in light, `${name} has a light value`);
  assert.equal(light['--scr-bg'], dark['--scr-bg'], 'instrument surfaces do not change with the theme');
});

test('rules use tokens: literal colours appear only where tokens are defined', () => {
  const rules = css.replace(tokenBlock(':root'), '').replace(tokenBlock(':root[data-theme="dark"]'), '');
  assert.deepEqual(rules.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g), null);
});

test('no literal colours in the app scripts or the page; board data colours live in core/schema.js', () => {
  const dir = new URL('../js/', import.meta.url);
  const files = readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.js') && f !== 'core/schema.js');
  assert.ok(files.includes('core/markdown.js'), 'the pure modules in core/ are scanned too');
  assert.ok(files.length > 25);
  for (const file of files) {
    assert.deepEqual(readFileSync(new URL(file, dir), 'utf8').match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g), null, file);
  }
  assert.doesNotMatch(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), /style\s*=|#[0-9a-fA-F]{6}\b/);
});

test('the stylesheet has no section banners', () => {
  const comments = [...css.matchAll(/\/\*([\s\S]*?)\*\//g)].map((m) => m[1].trim());
  for (const text of comments) assert.ok(/[.:;]|\s\w+\s\w+\s\w+\s\w+/.test(text), `banner: ${text}`);
  assert.doesNotMatch(css, /\/\*\s*(Playbook|Callouts|Console tab|Timeline tab|Logic panel|Agent panel|Terminal panel|Drawn icons)/);
});

test('hidden file inputs use the clip pattern and their label shows the focus ring', () => {
  const rule = css.match(/\.visually-hidden\s*\{([^}]*)\}/)?.[1] ?? '';
  for (const part of ['position: absolute', 'width: 1px', 'height: 1px', 'overflow: hidden', 'clip: rect(0 0 0 0)']) assert.ok(rule.includes(part), part);
  assert.doesNotMatch(rule, /display:\s*none/);
  assert.match(css, /label\.button:focus-within\s*\{[^}]*outline:[^}]*var\(--focus\)/);
  assert.match(css, /label\.button\s*\{[^}]*position:\s*relative/);
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const inputs = [...page.matchAll(/<input[^>]*type="file"[^>]*>/g)].map((m) => m[0]);
  assert.equal(inputs.length, 2);
  for (const tag of inputs) {
    assert.doesNotMatch(tag, /\shidden\b/, tag);
    assert.match(tag, /class="visually-hidden"/, tag);
  }
});

test('guidance rules: Expert hides the help and shows the short form; empty notes go away once there is content', () => {
  assert.match(css, /\[data-guidance="expert"\] \.guide \{ display: none !important; \}/);
  assert.match(css, /:root:not\(\[data-guidance="expert"\]\) \.terse \{ display: none !important; \}/);
  assert.match(css, /\.assistant-log:not\(:empty\) \+ #assistant-empty[^{]*\{ display: none; \}/);
  assert.match(css, /\.feed:not\(:empty\) \+ #changes-empty[^{]*\{ display: none; \}/);
  assert.match(css, /\.screen a\s*\{[^}]*--scr-/, 'links on the dark Changes screen are readable');
});

test('everything marked data-ai is hidden while the assistant is off, whatever other rules say', () => {
  assert.match(css, /\[data-assistant="off"\] \[data-ai\] \{ display: none !important; \}/);
});

test('the tutorial highlight is a steady ring in the focus colour that pulses once and not under reduced motion', () => {
  const rule = css.match(/\.tutorial-target\s*\{([^}]*)\}/);
  assert.ok(rule, '.tutorial-target is styled');
  assert.match(rule[1], /outline:\s*3px solid var\(--focus\)/);
  assert.match(rule[1], /outline-offset:\s*2px/);
  assert.doesNotMatch(rule[1], /#[0-9a-f]{3,6}\b|rgb\(|hsl\(/i, 'no literal colour');
  assert.match(rule[1], /animation:[^;]*\b1\b[^;]*;|animation:[^;]* 1;/, 'one iteration only');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced.slice(0, reduced.indexOf('\n}\n')), /\.tutorial-target\s*\{?[^}]*animation:\s*none|\.tutorial-target[^{]*,[^{]*\{[^}]*animation:\s*none|animation:\s*none/);
  assert.doesNotMatch(css, /tutorial-ring/, 'the Show me ring is gone');
});

test('while the tutorial runs the four Ask buttons are not displayed', () => {
  const rule = css.match(/:root\[data-tutorial="on"\][^{]*#vdev-bar[^{]*\{([^}]*)\}/);
  assert.ok(rule, 'the hidden-in-tutorial rule exists');
  const selectors = css.match(/(:root\[data-tutorial="on"\][^{]*#vdev-bar[^{]*)\{/)[1];
  for (const id of ['pin-ask', 'photo-ask', 'serial-ask', 'logic-ask']) assert.ok(selectors.includes(`#${id}`), `${id} is hidden`);
  assert.match(rule[1], /display:\s*none/);
});
