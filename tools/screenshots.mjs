// Takes the README screenshots (docs/screenshots/) from a running service with the demo board, through
// headless Firefox and WebDriver BiDi. It changes settings through the API, so it runs only in a scratch
// environment; ~/hw and ~/.config stay out:
//   S=$(mktemp -d); export XDG_RUNTIME_DIR=$S/run XDG_CONFIG_HOME=$S/config XDG_DATA_HOME=$S/data
//   mkdir -m 700 $S/run; mkdir -p $S/config/pcbv; echo '{"assistant": "on"}' > $S/config/pcbv/settings.json
//   cd service && uv run pcbv --root $S/boards demo
//   uv run pcbv --root $S/boards serve --port 8766 &    uv run pcbv vdev &    uv run pcbv fake-model &
//   for r in 4:beep 1:3.29V 2:3.12V 3:3.30V 4:0V; do uv run pcbv --root $S/boards measure demo-router J4 ${r%:*} ${r#*:}; done
//   firefox --headless --profile $S/ff --no-remote --remote-debugging-port 9333 &
//   node ../tools/screenshots.mjs ../docs/screenshots && optipng -o2 ../docs/screenshots/*.png
// The readings are made up; with them the workbench shot completes the Find the UART steps up to Measure
// voltages. PCBV_SHOTS=workbench,notes takes only those shots. The fake model needs the assistant on to start.
// The Agent shot uses the Local profile pointed at it, so no key or paid model is involved. The README's Agent
// shot is a real answer: PCBV_AGENT_BASE_URL=https://openrouter.ai/api/v1 PCBV_AGENT_MODEL=deepseek/deepseek-v4-pro
// PCBV_AGENT_PRICES=0.74/1.48, with the OpenRouter key in the keyring (pcbv, assistant:tutor). Use a fresh $S:
// the playbook, the notes and the Agent counts keep what earlier runs left.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [out] = process.argv.slice(2);
const config = process.env.XDG_CONFIG_HOME;
if (!out || !config || path.resolve(config) === path.join(os.homedir(), '.config')) {
  console.error('usage: node tools/screenshots.mjs <folder>, with XDG_RUNTIME_DIR and XDG_CONFIG_HOME set to a scratch folder');
  process.exit(2);
}
const advertised = JSON.parse(fs.readFileSync(`${process.env.XDG_RUNTIME_DIR}/pcbv/service.json`, 'utf8'));
const origin = 'http://127.0.0.1:8766';
const authed = (route, body) => fetch(`${origin}${route}`, { method: 'POST', body: JSON.stringify(body),
  headers: { Authorization: `Bearer ${advertised.token}`, 'Content-Type': 'application/json', 'X-Pcbv-Protocol': '2' } }).then((r) => r.json());
const mintCode = async () => (await authed('/api/session/code', {})).code;
const board = 'demo-router';
const mainUrl = async () => `${origin}/#code=${await mintCode()}&board=${board}`;
const panel = async (name) => `${origin}/?panel=${name}&board=${board}#code=${await mintCode()}`;

const ws = new WebSocket('ws://127.0.0.1:9333/session');
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(href, w, h) {
  const created = await send('browsingContext.create', { type: 'tab' });
  if (!created.result) throw new Error(`no new tab: ${JSON.stringify(created)}`);
  const ctx = created.result.context;
  await send('browsingContext.setViewport', { context: ctx, viewport: { width: w, height: h } });
  await send('browsingContext.navigate', { context: ctx, url: href, wait: 'complete' });
  await wait(2500);
  const ev = async (expr) => (await send('script.evaluate', { expression: expr, target: { context: ctx }, awaitPromise: true })).result?.result?.value;
  const shot = async (name) => { const r = await send('browsingContext.captureScreenshot', { context: ctx }); fs.writeFileSync(`${out}/${name}.png`, Buffer.from(r.result.data, 'base64')); console.log('shot', name); };
  // Click the first element matching `sel` whose text starts with `text`.
  const click = (text, sel = 'button') => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)})); b?.click(); return !!b; })()`);
  // An item of a panel's menu (the three dots), as a person would choose it.
  const menu = async (name, item) => { await ev(`document.querySelector('.panel-menu[data-menu-for="${name}"]')?.click()`); return click(item, '.menu button'); };
  const choose = (sel, value) => ev(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
  const close = () => send('browsingContext.close', { context: ctx });
  // Reset layout, from the workspace menu in the top bar.
  const reset = async () => { await ev(`document.getElementById('workspace-menu').click()`); await wait(200); await click('Reset layout', '[role=menu] button'); await wait(800); };
  return { ev, shot, click, menu, choose, close, reset };
}

async function workbench() {
  // The hero: photo with callouts, header J4 with its pins, the playbook, and a shell on the virtual board.
  await authed('/api/settings', { theme: 'dark', guidance: 'guided', assistant: 'off' });
  const m = await open(await mainUrl(), 1920, 1300);   // the bottom region gets 42% of the height: enough for the whole Console panel
  await m.choose('#workspace-select', 'Learn');
  await m.reset();
  await m.menu('board', 'Put away');
  await m.click('Console', '[role=tab]'); await wait(300);
  await m.menu('console', 'Move to bottom');
  await m.click('Playbook', '[role=tab]'); await wait(800);
  // The readings check step 3 (Measure voltages); tick its safety boxes and mark it done, as a person would.
  for (let i = 0; i < 2; i++) { await m.ev(`[...document.querySelectorAll('#playbook-body .gates input')].find((b) => !b.checked && !b.disabled)?.click()`); await wait(400); }
  await m.click('Mark step done'); await wait(800);
  await m.ev(`document.getElementById('serial-connect').click()`);
  await wait(10000);                                         // the virtual board boots in about 8 seconds
  await m.ev(`document.getElementById('key-enter').click()`); await wait(1200);
  for (const cmd of ['uname -a', 'cat /proc/mtd']) {
    await m.ev(`(() => { document.getElementById('serial-input').value = ${JSON.stringify(cmd)}; document.getElementById('serial-send').click(); })()`);
    await wait(1200);
  }
  await m.click('J4'); await wait(600);
  await m.ev(`[...document.querySelectorAll('#pin-grid button')][1]?.click()`); await wait(300);
  // The TX pin's readings and the Reading field, at the bottom of the left region.
  await m.ev(`[...document.querySelectorAll('#region-left label')].find((l) => l.textContent.trim().startsWith('Silkscreen label'))?.scrollIntoView({ block: 'start' })`);
  await m.click('Fit'); await wait(800);
  console.log('console chars:', await m.ev(`document.getElementById('serial-output').textContent.length`));
  await m.shot('workbench');
  await m.ev(`document.getElementById('serial-connect').click()`); await wait(500);
  await m.reset();
  await m.close();
}

async function notes() {
  // The Notes panel in Split mode: a dated entry, a task list and the flash layout from the console.
  await authed('/api/settings', { theme: 'dark' });
  const n = await open(await panel('notes'), 1400, 640);
  await n.click('Split'); await wait(300);
  const text = [
    '## UART on J4', '',
    '- [x] Find GND with continuity (pin 4 beeps)',
    '- [x] Powered readings on all four pins',
    '- [ ] Confirm TX with the logic analyzer',
    '- [ ] Back up the flash before any change', '',
    'Pin 2 wobbles around **3.12 V** while the board prints, so it is TX.',
    'The logic level is 3.3 V: set the adapter to 3.3 V, never 5 V.', '',
    '### Flash partitions', '',
    '| Name | Size |', '|---|---|',
    '| u-boot | 192 KB |', '| factory | 64 KB |', '| kernel | 2 MB |', '| rootfs | 11.7 MB |', '', '',
  ].join('\n');
  await n.ev(`(() => { const t = document.getElementById('notes-text'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await n.ev(`(() => { const t = document.getElementById('notes-text'); t.setSelectionRange(t.value.length, t.value.length); t.focus(); })()`);
  await n.click('Add dated entry'); await wait(300);
  await n.ev(`(() => { const t = document.getElementById('notes-text'); t.setRangeText('Booted to a root shell at 115200 baud.', t.selectionStart, t.selectionEnd, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); t.blur(); })()`);
  await wait(1500);                                          // the notes save while typing
  await n.shot('notes');
  await n.close();
}

async function logic() {
  const l = await open(await panel('logic'), 1200, 820);
  await l.ev(`document.getElementById('logic-decode').click()`); await wait(2500);
  for (let i = 0; i < 6; i++) { await l.ev(`document.getElementById('logic-zoom-in').click()`); await wait(250); }
  await wait(1000);
  console.log('decoded chars:', await l.ev(`document.getElementById('logic-text').textContent.length`));
  await l.shot('logic');
  await l.close();
}

async function agent() {
  // A tricky problem: the console was opened at the wrong speed, so the boot log is junk. The question gives
  // the assistant a misleading hint (the wiring looks fine); the logic capture decoded at 115200 baud and
  // the readings are on the board for it to find.
  const c = await open(await panel('console'), 1200, 700);
  await c.choose('#serial-baud', '57600');
  await c.ev(`document.getElementById('serial-connect').click()`); await wait(10000);
  await c.ev(`document.getElementById('serial-connect').click()`); await wait(800);
  await c.close();
  // PCBV_AGENT_BASE_URL and PCBV_AGENT_MODEL put a real model on the Quick profile; its key comes from the
  // keyring, as in the app. PCBV_AGENT_PRICES=in/out gives its dollars per million tokens, so the shot shows the
  // real cost. Without them the Local profile asks pcbv fake-model.
  const real = process.env.PCBV_AGENT_MODEL;
  const profile = real ? 'tutor' : 'local';
  const [priceIn, priceOut] = (process.env.PCBV_AGENT_PRICES ?? '0/0').split('/').map(Number);
  const target = real ? { base_url: process.env.PCBV_AGENT_BASE_URL, model: real, price_in: priceIn, price_out: priceOut }
    : { base_url: 'http://127.0.0.1:8767/v1', model: 'pcbv-fake-model' };
  await authed('/api/settings', { theme: 'dark', assistant: 'on' });
  await authed('/api/assistant/settings', { profiles: { [profile]: target } });
  // One card in the shot: decline what an earlier run left open.
  const listed = await (await fetch(`${origin}/api/boards/${board}/assistant/proposals`, { headers: { Authorization: `Bearer ${advertised.token}` } })).json();
  for (const p of listed.proposals ?? []) if (p.status === 'pending') await authed(`/api/boards/${board}/assistant/proposals/${p.id}`, { action: 'decline' });
  const a = await open(await panel('assistant'), 1200, 860);
  await a.ev(`document.querySelector('#assistant-profile [data-profile="${profile}"]')?.click()`); await wait(300);
  await a.click('New chat'); await wait(500);
  await a.ev(`(() => { document.getElementById('assistant-input').value = 'The console only shows junk characters. TX on J4 reads 3.12 V, so the wiring looks fine. Check the captures. What is wrong?'; document.getElementById('assistant-send').click(); })()`);
  // The Send button stays off until the answer is complete.
  for (let s = 0; s < 180; s++) { await wait(1000); if (s > 2 && !(await a.ev(`document.getElementById('assistant-send').disabled`))) break; }
  await wait(500);
  await a.ev(`document.querySelectorAll('#assistant-log details').forEach((d) => { d.open = true; })`); await wait(300);
  console.log('answer chars:', await a.ev(`document.getElementById('assistant-log').textContent.length`));
  await a.shot('agent');
  await a.close();
  await authed('/api/settings', { assistant: 'off' });
}

async function wiki() {
  await authed('/api/settings', { theme: 'light' });
  const w = await open(await panel('wiki'), 1100, 820);
  await w.ev(`document.querySelector('#wiki-index a[href="#wiki/reading-schematics"]')?.click()`); await wait(1500);
  await w.ev(`(() => { const f = [...document.querySelectorAll('#wiki-page figure')].find((f) => f.textContent.includes('4-pin UART')); if (!f) return; f.scrollIntoView({ block: 'start' });
    for (let e = f.parentElement; e; e = e.parentElement) if (e.scrollTop > 0) { e.scrollTop -= 24; break; } })()`);
  await wait(800);
  await w.shot('wiki');
  await w.close();
  await authed('/api/settings', { theme: 'system' });
}

ws.onopen = async () => {
  await send('session.new', { capabilities: {} });
  try {
    const only = process.env.PCBV_SHOTS?.split(',');
    for (const take of [workbench, notes, logic, agent, wiki]) if (!only || only.includes(take.name)) await take();
  } finally {
    await send('session.end', {});
  }
  process.exit(0);
};
