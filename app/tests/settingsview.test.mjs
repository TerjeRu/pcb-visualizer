import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { createSettingsView } from '../js/settingsview.js';
import { createView } from '../js/ui.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));
const detail = (extra = {}) => ({ setting: 'off', folder: '/home/t/hw', git: true, gitleaks: true, repository: true, guard: true,
  originals_ignored: true, remote: null, last_commit: null, problems: [], ...extra });

function setup(overrides = {}, prepare = () => {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  prepare(dom.window);
  const doc = dom.window.document;
  const calls = [];
  const handlers = {
    onSetGuidance: (v) => calls.push(['guidance', v]),
    onSetSetting: async (patch) => { calls.push(['setting', patch]); },
    gitStatus: async () => ({ ok: true, detail: detail() }),
    gitSetup: async (body) => { calls.push(['setup', body]); return { ok: true, detail: `${body.step} done` }; },
    onOpen: () => calls.push(['open']),
    ...overrides,
  };
  const view = createSettingsView(doc, handlers);
  const click = (id) => doc.getElementById(id).dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  const text = (id) => doc.getElementById(id).textContent;
  return { dom, doc, calls, view, click, text };
}

test('the dialog opens from the header, tells the app, and Escape closes it', async () => {
  const { dom, doc, calls, click } = setup();
  click('settings-open');
  await tick();
  assert.ok(doc.getElementById('settings-dialog').open);
  assert.deepEqual(calls[0], ['open']);
  doc.getElementById('settings-dialog').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.ok(!doc.getElementById('settings-dialog').open);
});

test('the profile form moved from the Agent panel into the dialog', () => {
  const { doc } = setup();
  assert.ok(doc.querySelector('#settings-dialog #assistant-settings'));
  assert.equal(doc.querySelector('#panel-assistant #assistant-settings'), null);
  assert.ok(doc.getElementById('assistant-config').hasAttribute('data-ai'), 'hidden while the assistant is off');
  assert.ok(doc.querySelector('#settings-dialog #theme-select'));
});

test('Guidance is saved through the app', () => {
  const { doc, calls, dom } = setup();
  const select = doc.getElementById('settings-guidance');
  select.value = 'expert';
  select.dispatchEvent(new dom.window.Event('change'));
  assert.deepEqual(calls, [['guidance', 'expert']]);
});

test('the assistant switch saves, and a refusal puts it back with the reason', async () => {
  const { doc, calls, dom, text } = setup({ onSetSetting: async (p) => { if (p.assistant === 'on') throw new Error('cannot save'); } });
  const box = doc.getElementById('settings-assistant');
  box.checked = true;
  box.dispatchEvent(new dom.window.Event('change'));
  await tick();
  assert.equal(box.checked, false);
  assert.equal(text('settings-message'), 'cannot save');
  assert.equal(calls.length, 0);
  assert.equal(box.disabled, false);
});

test('git cannot be switched on until the service allows it', async () => {
  const refuse = async () => { throw new Error('Git cannot be turned on yet: gitleaks not installed'); };
  const { doc, dom, text } = setup({ onSetSetting: refuse });
  const box = doc.getElementById('settings-git');
  box.checked = true;
  box.dispatchEvent(new dom.window.Event('change'));
  await tick();
  assert.equal(box.checked, false);
  assert.match(text('settings-message'), /gitleaks not installed/);
});

test('each setup step runs on its own and shows its result', async () => {
  const { calls, click, text } = setup();
  for (const step of ['check', 'init', 'ignore', 'sync']) {
    click(`git-step-${step}`);
    await tick();
    assert.equal(text(`git-result-${step}`), `${step} done`);
  }
  assert.deepEqual(calls.map((c) => c[1]), [{ step: 'check' }, { step: 'init' }, { step: 'ignore' }, { step: 'sync' }]);
});

test('a result from the service is text, never markup', async () => {
  const { doc, click } = setup({ gitSetup: async () => ({ ok: false, detail: '<img src=x onerror=alert(1)>' }) });
  click('git-step-check');
  await tick();
  assert.equal(doc.querySelectorAll('#settings-dialog img').length, 0);
  assert.match(doc.getElementById('git-result-check').textContent, /<img/);
  assert.equal(doc.getElementById('git-result-check').dataset.ok, 'false');
});

test('only one step runs at a time', async () => {
  let release;
  const { doc, calls, click } = setup({ gitSetup: (body) => { calls.push(['setup', body]); return new Promise((r) => { release = () => r({ ok: true, detail: 'ok' }); }); } });
  click('git-step-init');
  assert.equal(doc.getElementById('git-step-check').disabled, true);
  click('git-step-check');
  click('git-step-init');
  assert.equal(calls.filter((c) => c[0] === 'setup').length, 1);
  release();
  await tick();
  assert.equal(doc.getElementById('git-step-check').disabled, false);
});

test('the remote step sends the address and asks before replacing an existing one', async () => {
  const answers = [{ ok: false, detail: 'origin is already a', confirm: { old: 'git@old:o/r.git', new: 'git@host:o/r.git' } }, { ok: true, detail: 'origin changed' }];
  const { doc, calls, click, text } = setup({ gitSetup: async (body) => { calls.push(['setup', body]); return answers.shift(); } });
  doc.getElementById('git-remote-url').value = ' git@host:o/r.git ';
  click('git-step-remote');
  await tick();
  assert.deepEqual(calls.at(-1)[1], { step: 'remote', url: 'git@host:o/r.git' });
  assert.equal(doc.getElementById('git-replace').hidden, false);
  assert.equal(text('git-result-remote'), 'The remote address is already git@old:o/r.git. Replace it with git@host:o/r.git?');
  doc.getElementById('git-remote-url').value = 'git@typo:o/r.git';   // edited after the question: the confirmed address is sent
  click('git-replace-yes');
  await tick();
  assert.deepEqual(calls.at(-1)[1], { step: 'remote', url: 'git@host:o/r.git', replace: true });
  assert.equal(doc.getElementById('git-replace').hidden, true);
  assert.equal(text('git-result-remote'), 'origin changed');
});

test('keeping the existing remote sends nothing', async () => {
  const { doc, calls, click, text } = setup({ gitSetup: async () => ({ ok: false, detail: 'x', confirm: { old: 'a', new: 'b' } }) });
  click('git-step-remote');
  await tick();
  click('git-replace-no');
  assert.equal(doc.getElementById('git-replace').hidden, true);
  assert.match(text('git-result-remote'), /kept/);
  assert.equal(calls.length, 0);
});

test('the status lists the folder, tools, guard, originals, remote and last commit', async () => {
  const { doc, click } = setup({ gitStatus: async () => ({ ok: true, detail: detail({ remote: 'https://host/o/r.git', last_commit: '2026-10-31T10:00:00+01:00', originals_ignored: false }) }) });
  click('settings-open');
  await tick();
  const rows = [...doc.querySelectorAll('#git-status dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent]);
  assert.deepEqual(Object.fromEntries(rows), {
    Folder: '/home/t/hw', git: 'installed', gitleaks: 'installed', Repository: 'yes', 'Commit guard': 'active',
    'Photo originals': 'NOT ignored', Remote: 'https://host/o/r.git', 'Last commit': '2026-10-31T10:00:00+01:00' });
});

test('a failed status read says so', async () => {
  const { doc, click } = setup({ gitStatus: async () => { throw new Error('offline'); } });
  click('settings-open');
  await tick();
  assert.match(doc.getElementById('git-message').textContent, /offline/);
  assert.equal(doc.querySelectorAll('#git-status dd').length, 0);
});

test('a warning about git goes away once the problem is fixed', async () => {
  const answers = [detail({ setting: 'on', guard: false, problems: ['the commit guard is not active'] }), detail({ setting: 'on' })];
  const { view, click, text } = setup({ gitStatus: async () => ({ ok: true, detail: answers.shift() }) });
  click('settings-open');
  await tick();
  assert.match(text('git-message'), /commit guard is not active/);
  view.setGit('on');
  await tick();
  assert.equal(text('git-message'), '');
});

test('in the app, turning the assistant on while the dialog is open loads its profiles', async () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  let loads = 0;
  const view = createView(doc, {
    gitStatus: async () => ({ ok: true, detail: detail() }),
    assistantGet: async () => { loads += 1; return { default: 'tutor', keyring: { available: true }, usage: {}, profiles: { tutor: { base_url: '' } } }; },
  }, { set: () => 1, clear() {} });
  doc.getElementById('settings-open').dispatchEvent(new dom.window.Event('click'));
  view.setAssistant('on');
  await tick();
  assert.equal(loads, 1);
  assert.equal(doc.getElementById('settings-assistant').checked, true);
  assert.equal(doc.getElementById('assistant-config-profile').options.length, 1);
  view.setGit('on');
  assert.equal(doc.getElementById('settings-git').checked, true);
});

// A fresh Agent window gets an Ask over the channel before it has read the settings.
async function freshAgentWindow() {
  const { makeChannelHub, makeTimers } = await import('./fakes.mjs');
  const connect = makeChannelHub();
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  const chats = [];
  const view = createView(doc, {
    assistantGet: async () => ({ default: 'tutor', keyring: { available: true }, usage: {}, profiles: { tutor: { base_url: 'http://127.0.0.1:9/v1' } } }),
    assistantChat: async (body) => { chats.push(body); return { reply: 'ok', tools: [], usage: null }; },
    assistantProposals: async () => ({ proposals: [] }),
  }, { set: () => 1, clear() {} }, { single: 'assistant', channel: connect(), slug: 'b', generation: 1 });
  const { createPanelBus } = await import('../js/panelbus.js');
  const sender = createPanelBus({ channel: connect(), win: dom.window, slug: 'b', generation: 1, isLocal: () => false, onAction() {}, timers: makeTimers() });
  return { doc, view, chats, sender };
}

test('an Ask that reaches an Agent window before its settings load runs once the assistant is known to be on', async () => {
  const { doc, view, chats, sender } = await freshAgentWindow();
  const sent = sender.send('assistant', 'ask', { text: 'What is this?' });
  await tick();
  assert.equal(chats.length, 0, 'held, not dropped and not run');
  view.setAssistant('on');
  await tick(); await tick(); await tick();
  assert.deepEqual((await sent), { ok: true });
  assert.equal(chats.length, 1);
  assert.equal(chats[0].message, 'What is this?');
  assert.equal(doc.getElementById('message').hidden, true);
});

test('an Ask held for a window whose assistant turns out to be off is refused with a notice', async () => {
  const { doc, view, chats, sender } = await freshAgentWindow();
  sender.send('assistant', 'ask', { text: 'What is this?' });
  await tick();
  view.setAssistant('off');
  await tick();
  assert.equal(chats.length, 0);
  assert.match(doc.getElementById('message').textContent, /assistant is off/i);
});

test('the remote step has a GitHub guide for Guided and one line for Expert', () => {
  const { doc } = setup();
  const item = doc.getElementById('git-step-remote').closest('li');
  const guide = item.querySelector('.git-guide.guide');
  assert.ok(guide, 'the guide carries the class that Expert hides');
  const long = guide.textContent;
  assert.match(long, /private/);
  assert.match(long, /Add a README/);
  assert.match(long, /sudo pacman -S github-cli/);
  assert.match(long, /gh auth login/);
  assert.match(long, /Authenticate Git with your GitHub credentials/);
  assert.match(long, /ssh-keygen -t ed25519/);
  assert.match(long, /git@github\.com:<owner>\/<repo>\.git/);
  assert.equal(guide.querySelector('a[href="https://github.com/new"]')?.textContent, 'github.com/new');
  assert.equal(item.querySelector('.terse a[href="https://github.com/new"]')?.textContent, 'github.com/new');
  assert.ok(guide.querySelector('a[data-wiki="github-backup"]'));
  const short = item.querySelector('.git-guide.terse');
  assert.ok(short, 'Expert gets the short form');
  assert.match(short.textContent, /private/);
  assert.ok(short.querySelector('a[data-wiki="github-backup"]'));
});

test('both modes say before the step runs that GitHub is asked whether the repository is public', () => {
  const { doc } = setup();
  const note = doc.getElementById('git-remote-note');
  assert.match(note.textContent, /asks GitHub whether the repository is public/);
  assert.equal(note.closest('.guide, .terse'), null, 'a privacy statement is not hidden by the guidance setting');
  assert.ok(doc.getElementById('git-step-remote').closest('li').contains(note));
});

test('the remote step says it is waiting on GitHub and git while it runs', async () => {
  let release;
  const { click, text } = setup({ gitSetup: () => new Promise((r) => { release = () => r({ ok: true, detail: 'done' }); }) });
  click('git-step-remote');
  assert.match(text('git-result-remote'), /The app checks the address with GitHub and git/);
  release();
  await tick();
  assert.equal(text('git-result-remote'), 'done');
});

test('the new-repository link opens in a new tab in a browser', () => {
  const { doc } = setup();
  const link = doc.querySelector('#git-remote-note').closest('li').querySelector('a[data-external]');
  assert.equal(link.href, 'https://github.com/new');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
});

test('in the desktop shell the new-repository link asks and then opens through the shell', async () => {
  const opened = [];
  const asked = [];
  const { doc } = setup({}, (win) => {
    win.__TAURI__ = { core: { invoke: async (...args) => { opened.push(args); } } };
    win.confirm = (text) => { asked.push(text); return true; };
  });
  const link = doc.querySelector('#git-remote-note').closest('li').querySelector('a[data-external]');
  assert.equal(link.target, '');
  link.click();
  await tick();
  assert.match(asked[0], /https:\/\/github\.com\/new/);
  assert.deepEqual(opened, [['open_link', { url: 'https://github.com/new' }]]);
});
