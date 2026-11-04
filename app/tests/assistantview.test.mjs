import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { createAssistantView } from '../js/assistantview.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));

const profile = (extra = {}) => ({ base_url: 'http://127.0.0.1:9/v1', model: 'm', price_in: 1, price_out: 2, key_set: true, ...extra });
const baseSettings = () => ({ default: 'tutor', keyring: { available: true, detail: '' }, usage: {},
  profiles: { tutor: profile(), analyst: profile({ base_url: '', key_set: false }), local: profile({ base_url: '', key_set: false }) } });

function setup(overrides = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  doc.getElementById('panel-store').hidden = false;
  const calls = [];
  const handlers = {
    assistantGet: async () => baseSettings(),
    assistantSettings: async (x) => { calls.push(['settings', x]); },
    assistantKey: async (p, k) => { calls.push(['key', p, k]); },
    assistantChat: async (b) => { calls.push(['chat', b]); return { reply: 'It is a U-Boot log.', model: 'm', profile: 'tutor', tools: [{ name: 'get_capture', summary: 'capture cap_a', error: false }],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0002 }, totals: { requests: 1, prompt_tokens: 100, completion_tokens: 20, cost: 0.0002 } }; },
    assistantReset: async () => { calls.push(['reset']); },
    assistantProposals: async () => ({ proposals: [] }),
    assistantDecide: async (id, action) => { calls.push(['decide', id, action]); },
    ...overrides,
  };
  const view = createAssistantView(doc, handlers);
  view.render({}, true);
  return { doc, view, calls };
}

test('asking shows the answer, what was looked at, and the cost', async () => {
  const { doc, view, calls } = setup();
  view.ensure();
  await tick();
  assert.deepEqual([...doc.querySelectorAll('#assistant-profile [role="radio"]')].map((b) => b.dataset.profile), ['tutor', 'analyst', 'local']);
  doc.getElementById('assistant-input').value = 'What is this?';
  doc.getElementById('assistant-form').dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await tick(); await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'chat')[1], { message: 'What is this?', profile: 'tutor' });
  const msgs = [...doc.querySelectorAll('#assistant-log .assistant-msg')].map((m) => m.className);
  assert.deepEqual(msgs, ['assistant-msg user', 'assistant-msg assistant']);
  assert.equal(doc.querySelector('.assistant-tools summary').textContent, 'What it did (1)');
  assert.equal(doc.querySelector('.assistant-tools li').textContent, 'capture cap_a');
  assert.match(doc.getElementById('assistant-status').textContent, /120 tokens/);
  assert.match(doc.getElementById('assistant-usage').textContent, /1 questions/);
});

test('model text is never parsed as HTML', async () => {
  const { doc, view } = setup({ assistantChat: async () => ({ reply: '<img src=x onerror=alert(1)>', tools: [], usage: null }) });
  await view.ask('hi');
  assert.equal(doc.querySelectorAll('#assistant-log img').length, 0);
  assert.match(doc.querySelector('.assistant-msg.assistant p').textContent, /<img/);
});

test('a failed question shows the problem and the panel keeps working', async () => {
  let n = 0;
  const { doc, view } = setup({ assistantChat: async () => { if (n++ === 0) throw new Error('could not reach the model server'); return { reply: 'ok', tools: [] }; } });
  await view.ask('one');
  assert.match(doc.querySelector('.assistant-msg.error p').textContent, /could not reach/);
  await view.ask('two');
  assert.equal(doc.getElementById('assistant-send').disabled, false);
  assert.equal(doc.querySelectorAll('.assistant-msg.assistant').length, 1);
});

test('saving sends settings and the key, then clears the key field', async () => {
  const { doc, view, calls } = setup();
  view.ensure();
  await tick();
  doc.getElementById('assistant-base').value = 'https://api.example.com/v1';
  doc.getElementById('assistant-model').value = 'big';
  doc.getElementById('assistant-key').value = 'sk-abcdefgh1234';
  doc.getElementById('assistant-settings').dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await tick(); await tick();
  assert.equal(calls.find((c) => c[0] === 'settings')[1].profiles.tutor.model, 'big');
  assert.deepEqual(calls.find((c) => c[0] === 'key'), ['key', 'tutor', 'sk-abcdefgh1234']);
  assert.equal(doc.getElementById('assistant-key').value, '');
});

test('an empty model field suggests the model chosen for that profile', async () => {
  const { doc, view } = setup();
  view.ensure();
  await tick();
  const model = doc.getElementById('assistant-model');
  assert.equal(model.placeholder, 'anthropic/claude-haiku-5.5');
  doc.querySelector('#assistant-profile [data-profile="analyst"]').click();
  assert.equal(model.placeholder, 'anthropic/claude-sonnet-5.5');
  assert.equal(model.value, 'm');
});

test('proposals wait for a click; refused ones cannot be sent', async () => {
  const list = [
    { id: 'prop_1', command: 'printenv', reason: 'see the boot args', status: 'pending', detail: '' },
    { id: 'prop_2', command: 'saveenv', reason: '', status: 'refused', detail: 'saves bootloader settings' },
  ];
  const { doc, view, calls } = setup({ assistantProposals: async () => ({ proposals: list }) });
  view.ensure();
  await tick(); await tick();
  const cards = doc.querySelectorAll('.assistant-card');
  assert.equal(cards.length, 2);
  assert.equal(cards[1].querySelectorAll('button').length, 0);
  assert.equal(cards[0].querySelector('code').textContent, 'printenv');
  cards[0].querySelector('button.primary').click();
  await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'decide'), ['decide', 'prop_1', 'approve']);
});

test('without edit rights the send button is off', async () => {
  const { doc, view } = setup({ assistantProposals: async () => ({ proposals: [{ id: 'p', command: 'help', reason: '', status: 'pending', detail: '' }] }) });
  view.render({}, false);
  view.ensure();
  await tick(); await tick();
  assert.equal(doc.querySelector('.assistant-card button.primary').disabled, true);
});

test('the playbook step button asks with the playbook and step as context', async () => {
  const { JSDOM: J } = await import('jsdom');
  const { createPlaybookView } = await import('../js/playbookview.js');
  const dom = new J(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  doc.getElementById('panel-store').hidden = false;
  const asked = [];
  const view = createPlaybookView(doc, { onAsk: (t, c) => asked.push([t, c]), onPlaybookUpdate() {} });
  const pb = { id: 'find-uart', title: 'Find UART', requires: [], steps: [{ id: 'ground', title: 'Find ground', why: 'w', do: 'd', gates: [], asks: [], checks: [], wiki: [] }] };
  view.setPlaybooks([pb], []);
  view.render({ playbooks: {}, meta: { mode: 'guided' } }, true);
  doc.querySelector('.ask-assistant')?.click();
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0][1], { playbook: 'find-uart', step: 'ground' });
});

test('answers are rendered as Markdown without HTML, and the thinking line goes away', async () => {
  let release;
  const { doc, view } = setup({ assistantChat: () => new Promise((r) => { release = r; }) });
  const asked = view.ask('hi');
  await tick();
  assert.ok(doc.querySelector('#assistant-log .assistant-msg.pending'));
  release({ reply: '**TX** is on pin 2.\n\n- check `printenv`\n- <b>not markup</b>', tools: [], usage: null });
  await asked;
  assert.equal(doc.querySelector('#assistant-log .assistant-msg.pending'), null);
  const answer = doc.querySelector('.assistant-msg.assistant .md');
  assert.equal(answer.querySelector('strong').textContent, 'TX');
  assert.equal(answer.querySelectorAll('li').length, 2);
  assert.equal(answer.querySelector('code').textContent, 'printenv');
  assert.equal(answer.querySelector('b'), null);
});

test('the conversation the service holds is drawn again, before a new question', async () => {
  let release;
  const { doc, view } = setup({ assistantConversation: () => new Promise((r) => { release = r; }) });
  const asked = view.ask('next question');
  await tick();
  release({ messages: [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'first answer' }] });
  await asked;
  const texts = [...doc.querySelectorAll('#assistant-log .assistant-msg')].map((m) => m.children[1].textContent);
  assert.deepEqual(texts, ['first', 'first answer', 'next question', 'It is a U-Boot log.']);
  view.ensure();
  await tick();
  assert.equal(doc.querySelectorAll('#assistant-log .assistant-msg').length, 4, 'shown once');
});

test('a new chat that fails says so and keeps the conversation on screen', async () => {
  const { doc, view } = setup({ assistantReset: async () => { throw new Error('service stopped'); } });
  await view.ask('hi');
  doc.getElementById('assistant-reset').click();
  await tick();
  assert.match(doc.getElementById('assistant-status').textContent, /Could not start a new conversation: service stopped/);
  assert.equal(doc.querySelectorAll('#assistant-log .assistant-msg').length, 2);
});

test('label and pin-role suggestions show their certainty and evidence, and are added as guesses', async () => {
  const proposals = [
    { id: 'p1', kind: 'label', status: 'pending', text: 'U3: SPI flash', confidence: 'high', evidence: 'Marking 25Q128 legible' },
    { id: 'p2', kind: 'pins', status: 'pending', header_label: 'J2', pins: [
      { pin: 1, role: 'GND', confidence: 'medium', evidence: 'Wide trace' }, { pin: 3, role: 'TX', confidence: 'low', evidence: 'Guess' }] },
  ];
  const { doc, view, calls } = setup({ assistantProposals: async () => ({ proposals }) });
  view.ensure();
  await tick(); await tick();
  const cards = doc.querySelectorAll('#assistant-proposals .assistant-card');
  assert.match(cards[0].textContent, /Suggested label.*U3: SPI flash · high certainty.*Marking 25Q128 legible/);
  assert.match(cards[1].textContent, /Suggested pin roles for J2.*Pin 1: GND · medium.*Pin 3: TX · low/);
  const add = [...cards[1].querySelectorAll('button')].find((b) => b.textContent === 'Add as AI guesses');
  add.click();
  await tick(); await tick();
  assert.deepEqual(calls.at(-1), ['decide', 'p2', 'approve']);
  assert.match(doc.getElementById('assistant-status').textContent, /AI guess/);
});

test('the photo switch is shown per profile and saved with it', async () => {
  const settings = baseSettings();
  settings.profiles.tutor.photos = false;
  const { doc, view, calls } = setup({ assistantGet: async () => settings });
  view.ensure();
  await tick();
  assert.equal(doc.getElementById('assistant-photos').checked, false);
  doc.getElementById('assistant-photos').checked = true;
  doc.getElementById('assistant-settings').dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await tick();
  assert.equal(calls.find((c) => c[0] === 'settings')[1].profiles.tutor.photos, true);
});

test('the effort select shows the value of each profile and is saved with it', async () => {
  const settings = baseSettings();
  settings.profiles.tutor.budget = 'deep';
  const { doc, view, calls } = setup({ assistantGet: async () => settings });
  view.ensure();
  await tick();
  const select = doc.getElementById('assistant-budget');
  assert.equal(select.value, 'deep');
  select.value = 'normal';
  doc.getElementById('assistant-settings').dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await tick();
  assert.equal(calls.find((c) => c[0] === 'settings')[1].profiles.tutor.budget, 'normal');
  const config = doc.getElementById('assistant-config-profile');
  config.value = 'analyst';
  config.dispatchEvent(new doc.defaultView.Event('change'));
  assert.equal(select.value, 'normal', 'a profile with no budget field reads as normal');
});

test('a proposal card shows hidden characters as escapes', async () => {
  const { doc, view } = setup({ assistantProposals: async () => ({ proposals: [
    { id: 'p1', kind: 'command', status: 'pending', command: 'printenv‮', reason: 'see​the env', detail: '' },
    { id: 'p2', kind: 'label', status: 'pending', text: 'U1\u0007', confidence: 'low', evidence: 'x y' },
    { id: 'p3', kind: 'pins', status: 'pending', header_label: 'J2', pins: [{ pin: 1, role: 'T‮X', confidence: 'low', evidence: 'e​' }] }] }) });
  view.ensure();
  await tick(); await tick();
  const text = doc.getElementById('assistant-proposals').textContent;
  for (const shown of ['printenv\\u202E', 'see\\u200Bthe env', 'U1\\u0007', 'x\\u2028y', 'T\\u202EX', 'e\\u200B']) assert.ok(text.includes(shown), shown);
  assert.ok(![...text].some((ch) => '\u202E\u200B\u2028\u0007'.includes(ch)), 'no invisible character is left in the card');
});

test('links in a reply show the host and ask before opening', async () => {
  const { doc, view } = setup({ assistantChat: async () => ({ reply: 'Read [this](https://example.org/x?y=1).', model: 'm', profile: 'tutor', tools: [], usage: null, totals: null }) });
  const win = doc.defaultView;
  const opened = [];
  const prompts = [];
  win.confirm = (text) => { prompts.push(text); return prompts.length === 2; };
  win.open = (...args) => { opened.push(args); };
  view.ensure();
  await tick();
  doc.getElementById('assistant-input').value = 'links?';
  doc.getElementById('assistant-form').dispatchEvent(new win.Event('submit', { cancelable: true }));
  await tick(); await tick();
  assert.equal(doc.querySelector('#assistant-log .link-host').textContent, ' [example.org]');
  const link = doc.querySelector('#assistant-log a.external-link');
  link.click();
  assert.deepEqual(opened, [], 'declining opens nothing');
  assert.match(prompts[0], /https:\/\/example\.org\/x\?y=1/);
  link.click();
  assert.deepEqual(opened, [['https://example.org/x?y=1', '_blank', 'noopener,noreferrer']]);
});

test('in the desktop shell a link in a reply asks with the full address, then opens through the shell, and a refusal shows as a problem', async () => {
  const { doc, view } = setup({ assistantChat: async () => ({ reply: 'Read [this](https://example.org/x?y=1).', model: 'm', profile: 'tutor', tools: [], usage: null, totals: null }) });
  const win = doc.defaultView;
  const invoked = [];
  const prompts = [];
  win.open = () => assert.fail('the shell opens links, not window.open');
  win.confirm = (text) => { prompts.push(text); return prompts.length >= 2; };
  win.__TAURI__ = { core: { invoke: async (...args) => { invoked.push(args); if (invoked.length === 2) throw 'The link has no host.'; } } };
  view.ensure();
  await tick();
  doc.getElementById('assistant-input').value = 'links?';
  doc.getElementById('assistant-form').dispatchEvent(new win.Event('submit', { cancelable: true }));
  await tick(); await tick();
  const link = doc.querySelector('#assistant-log a.external-link');
  link.click();
  await tick();
  assert.deepEqual(invoked, [], 'declining opens nothing');
  assert.match(prompts[0], /https:\/\/example\.org\/x\?y=1/);
  link.click();
  await tick();
  assert.deepEqual(invoked[0], ['open_link', { url: 'https://example.org/x?y=1' }]);
  link.click();
  await tick();
  assert.equal(doc.querySelector('#assistant-log .assistant-msg.error p').textContent, 'The link has no host.');
});

test('photo consent is off unless the service says it is on, and a new address starts unticked', async () => {
  const { doc, view } = setup({ assistantGet: async () => ({ ...baseSettings(), profiles: {
    tutor: profile({ photos: true }), analyst: profile({ base_url: 'https://a.example/v1' }), local: profile({ base_url: '', key_set: false }) } }) });
  view.ensure();
  await tick();
  const photos = doc.getElementById('assistant-photos');
  assert.equal(photos.checked, true);
  const base = doc.getElementById('assistant-base');
  base.value = 'http://127.0.0.1:9/other';
  base.dispatchEvent(new doc.defaultView.Event('change'));
  assert.equal(photos.checked, true, 'a path change on the same server keeps the choice');
  base.value = 'https://elsewhere.example/v1';
  base.dispatchEvent(new doc.defaultView.Event('change'));
  assert.equal(photos.checked, false);
  doc.querySelector('#assistant-profile [data-profile="analyst"]').click();
  assert.equal(photos.checked, false, 'a profile with no photos field is off');
});

test('saving a new address tells the person the stored key was removed', async () => {
  const { doc, view } = setup({ assistantSettings: async () => ({ keys_cleared: ['tutor'] }) });
  view.ensure();
  await tick();
  doc.getElementById('assistant-base').value = 'https://new.example/v1';
  doc.getElementById('assistant-settings').dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await tick(); await tick();
  assert.match(doc.getElementById('assistant-status').textContent, /removed the stored key/);
});

const deferred = () => { const d = {}; d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; }); return d; };

test('a failed proposal fetch is tried again the next time the panel is shown', async () => {
  let fetched = 0;
  let fail = true;
  const { doc, view } = setup({ assistantProposals: async () => {
    fetched += 1;
    if (fail) throw new Error('offline');
    return { proposals: [{ id: 'p', command: 'help', reason: '', status: 'pending', detail: '' }] };
  } });
  view.ensure();
  await tick();
  assert.equal(fetched, 1);
  fail = false;
  view.ensure();
  await tick();
  assert.equal(fetched, 2);
  assert.equal(doc.querySelectorAll('#assistant-proposals .assistant-card').length, 1);
  view.ensure();
  await tick();
  assert.equal(fetched, 2, 'once loaded, it is not fetched again');
});

test('a proposal fetch that fails after a board switch does not change the new board', async () => {
  let fetched = 0;
  let reject;
  const { view } = setup({ assistantProposals: () => { fetched += 1; return fetched === 1 ? new Promise((_, r) => { reject = r; }) : Promise.resolve({ proposals: [] }); } });
  view.ensure();
  view.reset();
  view.ensure();
  await tick();
  reject(new Error('offline'));
  await tick();
  view.ensure();
  await tick();
  assert.equal(fetched, 2, 'the new board loaded its own and the old failure does not ask again');
});

test('proposals are fetched once per board, not every time the panel opens', async () => {
  let fetched = 0;
  const { view } = setup({ assistantProposals: async () => { fetched += 1; return { proposals: [] }; } });
  view.ensure();
  view.ensure();
  view.ensure();
  await tick();
  assert.equal(fetched, 1);
  view.reset();
  view.ensure();
  await tick();
  assert.equal(fetched, 2);
});

test('a reply that arrives after a board switch is not drawn, and the next question is not blocked', async () => {
  const slow = deferred();
  const reply = (text) => ({ reply: text, model: 'm', profile: 'tutor', tools: [], usage: null, totals: null });
  let asked = 0;
  const { doc, view } = setup({ assistantChat: () => (++asked === 1 ? slow.promise : Promise.resolve(reply('About the new board'))) });
  view.ensure();
  await tick();
  view.ask('Old board question?');
  await tick();
  view.reset();
  slow.resolve(reply('About the old board'));
  await tick(); await tick();
  assert.doesNotMatch(doc.getElementById('assistant-log').textContent, /About the old board/);
  assert.equal(doc.getElementById('assistant-send').disabled, false);
  view.ask('New board question?');
  await tick(); await tick(); await tick();
  assert.match(doc.getElementById('assistant-log').textContent, /About the new board/);
  assert.doesNotMatch(doc.getElementById('assistant-log').textContent, /old board/i);
});

test('a question cut off by a board switch does not free Send while the new board asks', async () => {
  const oldHistory = deferred();
  const newReply = deferred();
  let loads = 0;
  const { doc, view } = setup({
    assistantConversation: () => (++loads === 1 ? oldHistory.promise : Promise.resolve({ messages: [] })),
    assistantChat: () => newReply.promise,
  });
  view.ask('Old board question?');
  view.reset();
  view.ask('New board question?');
  await tick();
  oldHistory.resolve({ messages: [] });
  await tick(); await tick();
  assert.equal(doc.getElementById('assistant-send').disabled, true, 'the new question is still running');
  newReply.resolve({ reply: 'ok', model: 'm', profile: 'tutor', tools: [], usage: null, totals: null });
  await tick(); await tick();
  assert.equal(doc.getElementById('assistant-send').disabled, false);
});

test('a decision that finishes after a board switch does not redraw the new board', async () => {
  const slow = deferred();
  let fetched = 0;
  const { doc, view } = setup({
    assistantProposals: async () => { fetched += 1; return { proposals: [{ id: 'p1', kind: 'label', status: 'pending', text: 'UART', confidence: 'high', evidence: 'e' }] }; },
    assistantDecide: () => slow.promise,
  });
  view.ensure();
  await tick();
  doc.querySelector('.assistant-card .assistant-actions button').click();
  view.reset();
  slow.resolve({});
  await tick(); await tick();
  assert.equal(fetched, 1, 'no proposal reload for the board that is gone');
  assert.equal(doc.getElementById('assistant-status').textContent, '');
});

test('a profile without a server address says what to do in Guided and gives the short form in Expert', async () => {
  const { doc, view } = setup({ assistantGet: async () => ({ ...baseSettings(), default: 'analyst' }) });
  view.ensure();
  await tick();
  const status = doc.getElementById('assistant-status');
  assert.match(status.querySelector('.guide').textContent, /Settings/);
  assert.equal(status.querySelector('.terse').textContent, 'No server address set.');
});

test('the empty conversation has a Guided line and a short form, shown only while the log is empty', async () => {
  const { doc, view } = setup();
  const empty = doc.getElementById('assistant-empty');
  assert.ok(empty.querySelector('.guide') && empty.querySelector('.terse'));
  assert.equal(doc.querySelectorAll('#assistant-log:empty + #assistant-empty').length, 1, 'next to the log, so CSS can hide it');
  await view.ask('hi');
  assert.equal(doc.querySelectorAll('#assistant-log:empty + #assistant-empty').length, 0);
});

test('profiles that were reset are named above the profiles, with the reason', async () => {
  const { doc, view } = setup({ assistantGet: async () => ({ ...baseSettings(),
    settings_warnings: [{ profile: 'analyst', message: 'Thorough: base_url must use https unless the model server runs on this machine' },
      { profile: 'tutor', message: 'settings could not be read' }] }) });
  view.ensure();
  await tick();
  const note = doc.getElementById('assistant-warnings');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /Thorough: base_url/);
  assert.doesNotMatch(note.textContent, /Thorough: Thorough/, 'the name is not repeated');
  assert.match(note.textContent, /Quick: settings could not be read\./);
  assert.match(note.textContent, /must use https/);
});

test('no notice about reset profiles when nothing was reset', async () => {
  const { doc, view } = setup();
  view.ensure();
  await tick();
  assert.equal(doc.getElementById('assistant-warnings').hidden, true);
});

// --- Assistant setup (spec 20d) ---

const visibleGuides = (doc) => [...doc.querySelectorAll('#assistant-guide [data-guide]')].filter((n) => !n.hidden).map((n) => n.dataset.guide);

test('the provider guide follows the profile being edited', async () => {
  const { doc, view } = setup();
  view.ensure();
  await tick();
  assert.deepEqual(visibleGuides(doc), ['cloud', 'remote']);
  assert.match(doc.querySelector('#assistant-guide [data-guide="cloud"]').textContent, /openrouter\.ai\/keys/);
  const pick = doc.getElementById('assistant-config-profile');
  pick.value = 'local';
  pick.dispatchEvent(new doc.defaultView.Event('change'));
  assert.deepEqual(visibleGuides(doc), ['local', 'remote']);
  assert.match(doc.querySelector('#assistant-guide [data-guide="local"]').textContent, /sudo pacman -S ollama/);
  assert.match(doc.querySelector('#assistant-guide [data-guide="remote"]').textContent, /ssh -N -L 11434:localhost:11434/);
});

test('Test this profile shows the answer and does not save anything', async () => {
  const { doc, view, calls } = setup({
    assistantTest: async (p) => { calls_.push(p); return { ok: true, model: 'm' }; } });
  const calls_ = [];
  view.ensure();
  await tick();
  doc.getElementById('assistant-test').click();
  await tick(); await tick();
  assert.deepEqual(calls_, ['tutor']);
  assert.match(doc.getElementById('assistant-test-result').textContent, /works.*m/i);
  assert.equal(calls.filter((c) => c[0] === 'settings').length, 0);
});

test('Test this profile shows the note after the success sentence, and only the sentence without one', async () => {
  const note = 'The model spent this short test on thinking and wrote no text.';
  let reply = { ok: true, model: 'm', note };
  const { doc, view } = setup({ assistantTest: async () => reply });
  view.ensure();
  await tick();
  doc.getElementById('assistant-test').click();
  await tick(); await tick();
  assert.equal(doc.getElementById('assistant-test-result').textContent, `It works: the server answered with m. ${note}`);
  reply = { ok: true, model: 'm', note: '' };
  doc.getElementById('assistant-test').click();
  await tick(); await tick();
  assert.equal(doc.getElementById('assistant-test-result').textContent, 'It works: the server answered with m.');
});

test('a successful test updates the usage line, because it counts like any question', async () => {
  const { doc, view } = setup({
    assistantTest: async () => ({ ok: true, model: 'm', totals: { requests: 3, prompt_tokens: 30, completion_tokens: 3, cost: 0.0001 } }) });
  view.ensure();
  await tick();
  doc.getElementById('assistant-test').click();
  await tick(); await tick();
  assert.match(doc.getElementById('assistant-usage').textContent, /3 questions/);
});

test('Test this profile shows the plain-language failure', async () => {
  const { doc, view } = setup({ assistantTest: async () => ({ ok: false, message: 'The server refused the key.' }) });
  view.ensure();
  await tick();
  doc.getElementById('assistant-test').click();
  await tick(); await tick();
  assert.match(doc.getElementById('assistant-test-result').textContent, /The server refused the key\./);
  assert.equal(doc.getElementById('assistant-test').disabled, false);
});

test('a test that cannot be sent shows the error and frees the button', async () => {
  const { doc, view } = setup({ assistantTest: async () => { throw new Error('The assistant is off.'); } });
  view.ensure();
  await tick();
  doc.getElementById('assistant-test').click();
  await tick(); await tick();
  assert.match(doc.getElementById('assistant-test-result').textContent, /The assistant is off\./);
  assert.equal(doc.getElementById('assistant-test').disabled, false);
});

test('the key field is disabled and the dialog explains when the keyring is not available', async () => {
  const { doc, view } = setup({ assistantGet: async () => ({ ...baseSettings(), keyring: { available: false, detail: 'locked' } }) });
  view.ensure();
  await tick();
  assert.equal(doc.getElementById('assistant-key').disabled, true);
  assert.match(doc.getElementById('assistant-key-state').textContent, /system keyring is not available.*KWallet Manager/);
  assert.match(doc.getElementById('assistant-key-state').textContent, /local model works without a key/i);
});

test('the key field is usable when the keyring works', async () => {
  const { doc, view } = setup();
  view.ensure();
  await tick();
  assert.equal(doc.getElementById('assistant-key').disabled, false);
});

test('the profile switch shows the saved names, moves with the arrow keys and sends the chosen profile', async () => {
  const { doc, view, calls } = setup({ assistantGet: async () => {
    const s = baseSettings();
    s.profiles.tutor.name = 'Cheap';
    s.profiles.analyst.base_url = 'https://example.org/v1';
    return s;
  } });
  view.ensure();
  await tick();
  for (let node = doc.getElementById('assistant-profile'); node; node = node.parentElement) node.hidden = false;   // focus needs a shown panel
  const radios = () => [...doc.querySelectorAll('#assistant-profile [role="radio"]')];
  assert.deepEqual(radios().map((b) => b.textContent), ['Cheap', 'Thorough', 'Local (not set up)']);
  assert.deepEqual(radios().map((b) => b.getAttribute('aria-checked')), ['true', 'false', 'false']);
  assert.deepEqual(radios().map((b) => b.tabIndex), [0, -1, -1]);
  radios()[0].dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(doc.activeElement.dataset.profile, 'analyst');
  assert.equal(doc.getElementById('assistant-config-profile').value, 'analyst', 'Settings follows the switch');
  radios()[1].dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(doc.getElementById('assistant-name-field').hidden, true, 'Local has no name field');
  assert.match(doc.getElementById('assistant-status').textContent, /server address/);
  assert.match(doc.getElementById('assistant-unset').textContent, /Not set up yet: Local\./, 'shown in words, not only by colour');
  radios()[2].dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(doc.activeElement.dataset.profile, 'tutor', 'the arrows wrap around');
  assert.equal(doc.getElementById('assistant-status').textContent, '', 'a set-up profile clears the not-set-up line');
  doc.activeElement.click();
  assert.equal(doc.activeElement.dataset.profile, 'tutor', 'a click keeps focus on the switch');
  assert.equal(doc.getElementById('assistant-name').value, 'Cheap');
  doc.getElementById('assistant-input').value = 'Hi';
  doc.getElementById('assistant-form').dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await tick(); await tick();
  assert.equal(calls.find((c) => c[0] === 'chat')[1].profile, 'tutor');
});

test('saving a cloud profile sends its name; saving Local sends none', async () => {
  const { doc, view, calls } = setup();
  view.ensure();
  await tick();
  doc.getElementById('assistant-name').value = '  Careful ';
  doc.getElementById('assistant-settings').dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await tick(); await tick();
  const saves = () => calls.filter((c) => c[0] === 'settings');
  assert.equal(saves().at(-1)[1].profiles.tutor.name, 'Careful');
  doc.querySelector('#assistant-profile [data-profile="local"]').click();
  doc.getElementById('assistant-settings').dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await tick(); await tick();
  assert.equal('name' in saves().at(-1)[1].profiles.local, false);
});
