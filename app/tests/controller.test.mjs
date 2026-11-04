import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ClientError } from '../js/client.js';
import { createController } from '../js/controller.js';
import { ApiError } from '../js/api.js';

const project = (meta = {}) => ({ meta: { name: 'Nimbus', device: 'Acme', notes: '', ...meta }, assets: [], markers: [], schematics: [], components: [] });

function setup({ hash = '', stored = {}, boards = ['nimbus', 'router'], listError = null } = {}) {
  const store = { ...stored };
  const log = [];
  const clients = [];
  const view = new Proxy({}, { get: (_, name) => (...args) => log.push([name, ...args]) });
  const env = {
    location: { hash, pathname: '/', search: '' },
    history: { replaceState() {} },
    urls: {
      made: [], revoked: [],
      createObjectURL(blob) { const url = `blob:${blob.blob}`; env.urls.made.push(url); return url; },
      revokeObjectURL(url) { env.urls.revoked.push(url); },
    },
    storage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    },
  };
  const api = {
    calls: [],
    redeemError: null,
    async redeemCode(args) { if (api.redeemError) throw api.redeemError; return args.code; },
    async mintCode(args) { api.calls.push(['mint', args.token]); return `code-for-${args.token}`; },
    async listBoards(args) { api.calls.push(['list', args.token]); if (listError) throw listError; return boards; },
    async createBoard(args) { api.calls.push(['create', args.name]); boards = [...boards, args.name.toLowerCase()]; return { slug: args.name.toLowerCase(), seq: 1 }; },
    uploadError: null,
    async uploadPhoto(args) {
      api.calls.push(['upload', args.slug, args.side, args.label]);
      if (api.uploadError) throw api.uploadError;
      return { event: { type: 'asset/added', asset: { id: 'img_new' } } };
    },
    async fetchFile(args) { api.calls.push(['file', args.slug, args.path]); return { blob: args.path }; },
  };
  const makeClient = ({ slug, token, onSettings }) => {
    const listeners = new Set();
    const client = {
      slug, token, onSettings, closed: false, connected: false, applied: [], applyResult: () => Promise.resolve({ seq: 2 }),
      state: { status: 'live', project: project(), seq: 1, feed: [], error: null },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      connect() { client.connected = true; },
      close() { client.closed = true; },
      apply(event) { client.applied.push(event); return client.applyResult(); },
      push(patch) { client.state = { ...client.state, ...patch }; listeners.forEach((fn) => fn(client.state)); },
    };
    clients.push(client);
    return client;
  };
  const controller = createController({ env, view, api, makeClient, baseUrl: 'http://127.0.0.1:8765' });
  const calls = (name) => log.filter((entry) => entry[0] === name);
  return { controller, store, log, calls, api, clients, env };
}

test('without a token it asks for one and does not call the service', async () => {
  const t = setup();
  await t.controller.start();
  assert.equal(t.calls('showTokenPanel').length, 1);
  assert.deepEqual(t.api.calls, []);
});

test('with a token in the URL it lists boards and opens the one named there', async () => {
  const t = setup({ hash: '#code=abc&board=router', stored: { 'pcbv.board': 'nimbus' } });
  await t.controller.start();
  assert.deepEqual(t.api.calls, [['list', 'abc']]);
  assert.equal(t.clients.at(-1).slug, 'router', 'the URL beats the remembered board');
  assert.ok(t.clients.at(-1).connected);
  assert.equal(t.clients.at(-1).token, 'abc');
});

test('board choice falls back to the remembered one, then the first, ignoring names that no longer exist', async () => {
  const remembered = setup({ hash: '#code=abc', stored: { 'pcbv.board': 'router' } });
  await remembered.controller.start();
  assert.equal(remembered.clients.at(-1).slug, 'router');

  const gone = setup({ hash: '#code=abc&board=deleted', stored: { 'pcbv.board': 'also-gone' } });
  await gone.controller.start();
  assert.equal(gone.clients.at(-1).slug, 'nimbus');
});

test('with no boards it says so instead of connecting', async () => {
  const t = setup({ hash: '#code=abc', boards: [] });
  await t.controller.start();
  assert.equal(t.calls('showNoBoards').length, 1);
  assert.equal(t.clients.length, 0);
});

test('a token the service rejects is forgotten and the person is asked again', async () => {
  const t = setup({ hash: '#code=stale', listError: new ApiError(401, 'unauthorized', 'missing or wrong token') });
  await t.controller.start();
  assert.equal(t.store['pcbv.token'], undefined, 'a rejected token must not be kept');
  assert.match(t.calls('showTokenPanel').at(-1)[1], /pcbv open/);
});

test('an unreachable service is reported without discarding the token', async () => {
  const t = setup({ hash: '#code=abc', listError: new TypeError('fetch failed') });
  await t.controller.start();
  assert.equal(t.store['pcbv.token'], 'abc');
  assert.match(t.calls('showTokenPanel').at(-1)[1], /Could not reach the service/);
});

test('pasting a token signs in; garbage is refused', async () => {
  const t = setup();
  await t.controller.start();
  await t.controller.submitToken('   ');
  assert.deepEqual(t.api.calls, []);
  await t.controller.submitToken('  pasted-token \n');
  assert.deepEqual(t.api.calls, [['list', 'pasted-token']]);
  assert.equal(t.store['pcbv.token'], 'pasted-token');
});

test('switching boards closes the previous connection first and remembers the choice', async () => {
  const t = setup({ hash: '#code=abc&board=nimbus' });
  await t.controller.start();
  const first = t.clients.at(-1);
  t.controller.selectBoard('router');
  assert.ok(first.closed, 'the old board must not keep streaming into the new view');
  assert.equal(t.clients.at(-1).slug, 'router');
  assert.equal(t.store['pcbv.board'], 'router');
  const renders = t.calls('render').length;
  first.push({ seq: 99 });
  assert.equal(t.calls('render').length, renders, 'an old client can no longer drive the view');
});

test('a token refused over the socket signs the person out', async () => {
  const t = setup({ hash: '#code=abc' });
  await t.controller.start();
  t.clients.at(-1).push({ status: 'rejected', error: { code: 4401, message: 'The service rejected the token.' } });
  assert.equal(t.store['pcbv.token'], undefined);
  assert.ok(t.clients.at(-1).closed);
  assert.equal(t.calls('showTokenPanel').length, 1);
});

test('creating a board validates the name, then refreshes and opens it', async () => {
  const t = setup({ hash: '#code=abc' });
  await t.controller.start();
  await t.controller.createBoard('   ');
  assert.equal(t.calls('showError').length, 1);
  assert.deepEqual(t.api.calls.filter(([kind]) => kind === 'create'), []);
  await t.controller.createBoard('  Netgear ');
  assert.deepEqual(t.api.calls.filter(([kind]) => kind === 'create'), [['create', 'Netgear']], 'the name is trimmed');
  assert.equal(t.clients.at(-1).slug, 'netgear');
});

test('a board name the service refuses is shown, not swallowed', async () => {
  const t = setup({ hash: '#code=abc' });
  await t.controller.start();
  t.api.createBoard = async () => { throw new ApiError(409, 'exists', 'board already exists'); };
  await t.controller.createBoard('Nimbus');
  assert.deepEqual(t.calls('showError').at(-1), ['showError', 'board already exists']);
});

test('saving sends only the fields that changed', async () => {
  const t = setup({ hash: '#code=abc' });
  await t.controller.start();
  const client = t.clients.at(-1);
  await t.controller.saveDetails({ name: 'Nimbus', device: 'Acme', notes: '' });
  assert.deepEqual(client.applied, [], 'nothing changed, nothing sent');
  await t.controller.saveDetails({ name: '  Nimbus 4 ', device: 'Acme', notes: 'UART at J3' });
  assert.deepEqual(client.applied, [{ type: 'project/metaUpdated', patch: { name: 'Nimbus 4', notes: 'UART at J3' } }]);
});

test('an empty name is refused locally and the field is put back', async () => {
  const t = setup({ hash: '#code=abc' });
  await t.controller.start();
  const renders = t.calls('render').length;
  await t.controller.saveDetails({ name: '  ', device: 'x', notes: '' });
  assert.deepEqual(t.clients.at(-1).applied, []);
  assert.equal(t.calls('showError').length, 1);
  assert.equal(t.calls('render').length, renders + 1);
});

test('a failed save tells the person why and restores what the service has', async () => {
  const t = setup({ hash: '#code=abc' });
  await t.controller.start();
  const client = t.clients.at(-1);
  client.applyResult = () => Promise.reject(new ClientError('not-connected', 'Not connected to the service.'));
  const renders = t.calls('render').length;
  await t.controller.saveDetails({ name: 'New name', device: 'Acme', notes: '' });
  assert.deepEqual(t.calls('showError').at(-1), ['showError', 'Not connected to the service.']);
  assert.equal(t.calls('render').length, renders + 1);

  client.applyResult = () => Promise.reject(new Error('boom'));
  await t.controller.saveDetails({ name: 'Another', device: 'Acme', notes: '' });
  assert.deepEqual(t.calls('showError').at(-1), ['showError', 'Could not save that change.'], 'internal errors are not shown raw');
});

test('a token that stops working while creating a board signs the person out', async () => {
  const t = setup({ hash: '#code=abc' });
  await t.controller.start();
  t.api.createBoard = async () => { throw new ApiError(401, 'unauthorized', 'missing or wrong token'); };
  await t.controller.createBoard('Netgear');
  assert.equal(t.store['pcbv.token'], undefined);
  assert.equal(t.calls('showTokenPanel').length, 1);
  assert.equal(t.calls('showError').length, 0, 'sign-out replaces the error message');
});


test('photos are fetched once per board and released when the board changes', async () => {
  const t = setup({ hash: '#code=abc' });
  await t.controller.start();
  const first = await t.controller.loadPhoto('assets/photos/a.jpg');
  const again = await t.controller.loadPhoto('assets/photos/a.jpg');
  assert.equal(first, 'blob:assets/photos/a.jpg');
  assert.equal(again, first);
  assert.equal(t.api.calls.filter((c) => c[0] === 'file').length, 1);
  t.controller.selectBoard('router');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(t.env.urls.revoked, [first]);
});

test('uploading a photo names it after the file and reports the new asset', async () => {
  const t = setup({ hash: '#code=abc' });
  await t.controller.start();
  const id = await t.controller.uploadPhoto({ name: 'IMG_2041.jpeg' }, 'back');
  assert.equal(id, 'img_new');
  assert.deepEqual(t.api.calls.at(-1), ['upload', 'nimbus', 'back', 'IMG_2041']);
});

test('a refused upload shows the service reason', async () => {
  const t = setup({ hash: '#code=abc' });
  await t.controller.start();
  t.api.uploadError = new ApiError(422, 'invalid_photo', 'not a readable image');
  assert.equal(await t.controller.uploadPhoto({ name: 'x.gif' }, 'front'), null);
  assert.deepEqual(t.calls('showError').at(-1), ['showError', 'not a readable image']);
});

test('addMarker sends one marker/added with its header and returns the marker id', async () => {
  const t = setup({ hash: '#code=abc' });
  await t.controller.start();
  const id = await t.controller.addMarker('img_1', { x: 10, y: 20, w: 80, h: 20 });
  const sent = t.clients[0].applied.at(-1);
  assert.equal(sent.type, 'marker/added');
  assert.equal(sent.marker.id, id);
  assert.equal(sent.schematic.id, sent.marker.schematicId);
});

test('a refused edit shows why and redraws from the service state', async () => {
  const t = setup({ hash: '#code=abc' });
  await t.controller.start();
  t.clients[0].applyResult = () => Promise.reject(new ClientError('conflict', 'marker does not exist'));
  assert.equal(await t.controller.send({ type: 'marker/removed', id: 'mk_x' }), false);
  assert.deepEqual(t.calls('showError').at(-1), ['showError', 'marker does not exist']);
  assert.ok(t.calls('render').length > 0);
});


test('panel windows: a browser popup normally, the desktop shell when there is one', async () => {
  const t = setup({ hash: '#code=abc' });
  const opened = [];
  const popup = { closed: false, location: { href: '' }, close() { this.closed = true; } };
  t.env.open = (...args) => { opened.push(args); return popup; };
  await t.controller.start();
  t.controller.openPanelWindow('console', 12);
  assert.deepEqual(opened[0], ['', 'pcbv-console', 'popup,width=960,height=720'], 'opened empty inside the click');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(popup.location.href, '/?panel=console&board=nimbus&gen=12#code=code-for-abc', 'a one-time code, never the token');
  const shellCalls = [];
  t.env.shell = { openPanel: (...args) => { shellCalls.push(args); return { closed: false }; } };
  t.controller.openPanelWindow('timeline', 12);
  assert.deepEqual(shellCalls[0].slice(0, 2).concat(shellCalls[0][3], shellCalls[0][4]), ['timeline', 'nimbus', 'Timeline', 12]);
  assert.equal(await shellCalls[0][2](), 'code-for-abc', 'the shell asks for a code only when it creates a window');
  assert.ok(!JSON.stringify(shellCalls[0].filter((x) => typeof x !== 'function')).includes('abc'), 'no token is handed to the shell');
});

test('a failed code for a popup closes it and says so', async () => {
  const t = setup({ hash: '#code=abc' });
  const popup = { closed: false, location: { href: '' }, close() { this.closed = true; } };
  t.env.open = () => popup;
  await t.controller.start();
  t.api.mintCode = async () => { throw new ApiError(429, 'session_busy', 'too many unused codes'); };
  t.controller.openPanelWindow('console');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(popup.closed);
  assert.deepEqual(t.calls('showError').at(-1), ['showError', 'too many unused codes']);
});

test('the one-time code is exchanged for the token, which is stored', async () => {
  const t = setup({ hash: '#code=abc&board=router' });
  await t.controller.start();
  assert.equal(t.store['pcbv.token'], 'abc');
  assert.equal(t.clients.at(-1).slug, 'router');
});

test('a code that was already used asks for a new one and calls nothing else', async () => {
  const t = setup({ hash: '#code=abc' });
  t.api.redeemError = new ApiError(401, 'invalid_code', 'the code is wrong, expired or already used');
  await t.controller.start();
  assert.match(t.calls('showTokenPanel').at(-1)[1], /expired or was already used/);
  assert.deepEqual(t.api.calls, []);
  assert.equal(t.store['pcbv.token'], undefined);
});

test('a window that lost its token asks its opener, and says how to recover when nobody answers', async () => {
  const asked = setup({ stored: {} });
  asked.env.requestCode = async () => 'fresh';
  await asked.controller.start();
  assert.equal(asked.store['pcbv.token'], 'fresh');

  const silent = setup({ stored: {} });
  silent.env.requestCode = async () => null;
  await silent.controller.start();
  assert.match(silent.calls('showTokenPanel').at(-1)[1], /Reopen it from the main window, or run `pcbv open`/);
  assert.deepEqual(silent.api.calls, []);

  const byHand = setup({ stored: {} });
  await byHand.controller.start();
  assert.match(byHand.calls('showTokenPanel').at(-1)[1], /Open this app with `pcbv open`, or paste the token/);

  const kept = setup({ stored: { 'pcbv.token': 'kept' } });
  kept.env.requestCode = async () => { throw new Error('must not ask while the token is there'); };
  await kept.controller.start();
  assert.deepEqual(kept.api.calls, [['list', 'kept']]);
});

test('only a window this one opened gets a code, and only from the same origin', async () => {
  const t = setup({ hash: '#code=abc' });
  const popup = { location: { href: '' }, close() {} };
  t.env.open = () => popup;
  t.env.location.origin = 'http://127.0.0.1:8765';
  await t.controller.start();
  t.controller.openPanelWindow('console');
  const posted = [];
  const mine = Object.assign(popup, { postMessage: (...a) => posted.push(a) });
  await t.controller.answerCodeRequest({ origin: 'http://127.0.0.1:8765', source: mine, data: { type: 'pcbv:code-request' } });
  assert.deepEqual(posted, [[{ type: 'pcbv:code', code: 'code-for-abc' }, 'http://127.0.0.1:8765']]);
  await t.controller.answerCodeRequest({ origin: 'http://127.0.0.1:8765', source: { postMessage: () => posted.push('stranger') }, data: { type: 'pcbv:code-request' } });
  await t.controller.answerCodeRequest({ origin: 'https://evil.example', source: mine, data: { type: 'pcbv:code-request' } });
  await t.controller.answerCodeRequest({ origin: 'http://127.0.0.1:8765', source: mine, data: { type: 'something-else' } });
  assert.equal(posted.length, 1, 'strangers, other origins and other messages get nothing');
});


test('the git setting is passed to the view at sign-in and when another window changes it', async () => {
  const t = setup({ hash: '#code=abc' });
  t.api.getSettings = async () => ({ guidance: 'guided', git: 'on' });
  await t.controller.start();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(t.calls('setGit').at(-1), ['setGit', 'on']);
});

test('guidance is loaded at sign-in, saved when switched, and follows other windows', async () => {
  const t = setup({ hash: '#code=abc' });
  let saved = { guidance: 'expert' };
  t.api.getSettings = async () => saved;
  t.api.saveSettings = async ({ data }) => { t.api.calls.push(['settings', data]); saved = data; return data; };
  await t.controller.start();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(t.calls('setGuidance').at(-1), ['setGuidance', 'expert']);

  await t.controller.setGuidance('guided');
  assert.deepEqual(t.api.calls.at(-1), ['settings', { guidance: 'guided' }]);
  assert.deepEqual(t.calls('setGuidance').at(-1), ['setGuidance', 'guided']);

  t.clients.at(-1).onSettings({ guidance: 'expert' });
  assert.deepEqual(t.calls('setGuidance').at(-1), ['setGuidance', 'expert']);
});

test('a guidance change the service refuses is shown and put back', async () => {
  const t = setup({ hash: '#code=abc' });
  t.api.getSettings = async () => ({ guidance: 'guided' });
  t.api.saveSettings = async () => { throw Object.assign(new Error('disk full'), { status: 500 }); };
  await t.controller.start();
  await t.controller.setGuidance('expert');
  assert.deepEqual(t.calls('setGuidance').map((c) => c[1]).slice(-2), ['expert', 'guided']);
  assert.ok(t.calls('showError').some((c) => /disk full|Could not save the setting/.test(c[1])));
});

test('the theme is loaded at sign-in, saved when switched, and follows other windows', async () => {
  const t = setup({ hash: '#code=abc' });
  t.api.getSettings = async () => ({ guidance: 'guided', theme: 'dark' });
  t.api.saveSettings = async ({ data }) => { t.api.calls.push(['settings', data]); return data; };
  await t.controller.start();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(t.calls('setTheme').at(-1), ['setTheme', 'dark']);
  await t.controller.setTheme('light');
  assert.deepEqual(t.api.calls.at(-1), ['settings', { theme: 'light' }]);
  t.clients.at(-1).onSettings({ guidance: 'guided', theme: 'system' });
  assert.deepEqual(t.calls('setTheme').at(-1), ['setTheme', 'system']);
});

const deferred = () => { const d = {}; d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; }); return d; };
const settle = () => new Promise((r) => setTimeout(r, 0));

test('a failure that arrives after another board was chosen shows nothing', async () => {
  const t = setup({ hash: '#code=abc' });
  await t.controller.start();
  const slow = deferred();
  t.api.uploadPhoto = () => slow.promise;
  const upload = t.controller.uploadPhoto({ name: 'x.jpg' }, 'front');
  t.controller.selectBoard('router');
  slow.reject(new ApiError(422, 'invalid_photo', 'not a readable image'));
  assert.equal(await upload, null);
  assert.equal(t.calls('showError').length, 0);
});

test('an upload that finishes for the previous board does not report its asset', async () => {
  const t = setup({ hash: '#code=abc' });
  await t.controller.start();
  const slow = deferred();
  t.api.uploadPhoto = () => slow.promise;
  const upload = t.controller.uploadPhoto({ name: 'x.jpg' }, 'front');
  t.controller.selectBoard('router');
  slow.resolve({ event: { asset: { id: 'img_old' } } });
  assert.equal(await upload, null);
});

test('a refused edit for the previous board does not redraw the new one', async () => {
  const t = setup({ hash: '#code=abc' });
  await t.controller.start();
  const slow = deferred();
  t.clients[0].applyResult = () => slow.promise;
  const sent = t.controller.send({ type: 'marker/removed', id: 'mk_1' });
  t.controller.selectBoard('router');
  const renders = t.calls('render').length;
  slow.reject(new ClientError('rejected', 'Not allowed'));
  assert.equal(await sent, false);
  assert.equal(t.calls('render').length, renders);
  assert.equal(t.calls('showError').length, 0);
});

test('a rejected token still signs out when the answer arrives late', async () => {
  const t = setup({ hash: '#code=abc' });
  await t.controller.start();
  const slow = deferred();
  t.api.uploadPhoto = () => slow.promise;
  const upload = t.controller.uploadPhoto({ name: 'x.jpg' }, 'front');
  t.controller.selectBoard('router');
  slow.reject(new ApiError(401, 'unauthorized', 'bad token'));
  await upload;
  assert.equal(t.calls('showTokenPanel').length >= 1, true);
});

test('a failed save for the previous board does not touch the new one', async () => {
  const t = setup({ hash: '#code=abc' });
  await t.controller.start();
  const slow = deferred();
  t.clients[0].applyResult = () => slow.promise;
  const saving = t.controller.saveDetails({ name: 'Renamed', device: 'Acme', notes: '' });
  t.controller.selectBoard('router');
  const renders = t.calls('render').length;
  slow.reject(new ClientError('rejected', 'Not allowed'));
  await saving;
  await settle();
  assert.equal(t.calls('showError').length, 0);
  assert.equal(t.calls('render').length, renders);
});

test('panels can be opened when sessionStorage is blocked and the token lives in memory only', async () => {
  const t = setup({ hash: '#code=abc' });
  t.env.storage = { getItem: () => null, setItem() { throw new Error('blocked'); }, removeItem() {} };
  const opened = [];
  const popup = { closed: false, location: { href: '' }, close() { this.closed = true; } };
  t.env.open = (...args) => { opened.push(args); return popup; };
  await t.controller.start();
  t.controller.openPanelWindow('console');
  await settle();
  assert.match(popup.location.href, /#code=code-for-abc$/);
});

test('no window is opened without a sign-in or a board, so no empty window is left behind', async () => {
  const t = setup({ boards: [] });
  const opened = [];
  t.env.open = (...args) => { opened.push(args); return { closed: false, location: { href: '' }, close() {} }; };
  assert.equal(t.controller.openPanelWindow('console'), null, 'not signed in');
  t.env.hash = '';
  await t.controller.start();
  assert.equal(t.controller.openPanelWindow('console'), null, 'no board');
  assert.deepEqual(opened, []);
});

test('a popup the person closed before the code arrived is not navigated', async () => {
  const t = setup({ hash: '#code=abc' });
  const popup = { closed: false, location: { href: '' }, close() {} };
  t.env.open = () => popup;
  await t.controller.start();
  t.controller.openPanelWindow('console');
  popup.closed = true;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(popup.location.href, '');
});

test('choosing a board tells the view, so panel windows can follow', async () => {
  const t = setup({ hash: '#code=abc' });
  await t.controller.start();
  t.controller.selectBoard('router');
  assert.deepEqual(t.calls('boardChanged').map((c) => c[1]), ['nimbus', 'router']);
});

test('the shell can be asked for windows that survived a reload', async () => {
  const t = setup({ hash: '#code=abc' });
  assert.equal(t.controller.findShellWindow('console'), null, 'a browser has none');
  const handle = { closed: false };
  t.env.shell = { find: async (panel) => (panel === 'console' ? handle : null) };
  assert.equal(await t.controller.findShellWindow('console'), handle);
  assert.equal(await t.controller.findShellWindow('wiki'), null);
});

function welcomeSetup({ boards = [], welcomed = false } = {}) {
  const t = setup({ hash: '#code=abc', boards });
  t.api.getSettings = async () => ({ guidance: 'guided', welcomed, data_folder: '/home/x/hw' });
  t.api.saveSettings = async ({ data }) => { t.api.calls.push(['settings', data]); return { guidance: 'guided', ...data }; };
  t.api.listBoards = async () => boards;
  t.api.createBoard = async ({ name }) => { boards = [...boards, name.toLowerCase()]; return { slug: name.toLowerCase(), seq: 1 }; };
  return t;
}
const settled = () => new Promise((r) => setTimeout(r, 0));

test('the Welcome state and the data folder go to the view at sign-in', async () => {
  const t = welcomeSetup();
  await t.controller.start();
  await settled();
  assert.deepEqual(t.calls('setWelcome').at(-1), ['setWelcome', { welcomed: false, dataFolder: '/home/x/hw' }]);
  assert.equal(t.calls('showNoBoards').length, 1);
});

test('opening the first board ends the Welcome once; a welcomed install saves nothing', async () => {
  const t = welcomeSetup();
  await t.controller.start();
  await settled();
  await t.controller.createBoard('Camera');
  await settled();
  assert.deepEqual(t.api.calls.filter((c) => c[0] === 'settings'), [['settings', { welcomed: true }]]);
  t.controller.selectBoard('camera');
  await settled();
  assert.equal(t.api.calls.filter((c) => c[0] === 'settings').length, 1, 'saved once');

  const done = welcomeSetup({ boards: ['nimbus'], welcomed: true });
  await done.controller.start();
  await settled();
  assert.equal(done.api.calls.filter((c) => c[0] === 'settings').length, 0);
});

test('Skip saves welcomed; Show the welcome again shows it without saving anything', async () => {
  const t = welcomeSetup();
  await t.controller.start();
  await settled();
  await t.controller.skipWelcome();
  assert.deepEqual(t.api.calls.at(-1), ['settings', { welcomed: true }]);
  assert.deepEqual(t.calls('setWelcome').at(-1), ['setWelcome', { welcomed: true, dataFolder: undefined }]);

  const saves = t.api.calls.filter((c) => c[0] === 'settings').length;
  t.controller.showWelcome();
  assert.deepEqual(t.calls('showWelcome').at(-1), ['showWelcome', { back: false }]);
  assert.equal(t.api.calls.filter((c) => c[0] === 'settings').length, saves, 'the saved setting is not touched');
});

test('Show the welcome again with a board open shows it in place of the board, and Back reopens that board', async () => {
  const t = welcomeSetup({ boards: ['camera', 'nimbus'], welcomed: true });
  await t.controller.start();
  await settled();
  const open = t.clients.at(-1).slug;
  const clients = t.clients.length;
  t.controller.showWelcome();
  assert.deepEqual(t.calls('showWelcome').at(-1), ['showWelcome', { back: true }]);
  assert.equal(t.clients.at(-1).closed, false, 'the board stays live behind the Welcome, for its wiki pages');
  assert.deepEqual(t.calls('setBoards').at(-1), ['setBoards', ['camera', 'nimbus'], null]);
  t.controller.backFromWelcome();
  assert.equal(t.clients.length, clients + 1);
  assert.equal(t.clients.at(-1).slug, open);
  assert.equal(t.api.calls.filter((c) => c[0] === 'settings').length, 0);
});

// The tutorial through the controller.
function tutorialSetup({ stored = {}, boards = ['nimbus'], settings = {} } = {}) {
  const t = setup({ hash: '#code=abc', boards, stored });
  const saved = { guidance: 'guided', welcomed: true, data_folder: '/home/x/hw', tutorial: 'new', tutorialStep: 1, ...settings };
  t.api.getSettings = async () => ({ ...saved });
  t.api.saveSettings = async ({ data }) => { t.api.calls.push(['settings', data]); Object.assign(saved, data); return { ...saved }; };
  t.api.listBoards = async () => boards;
  t.api.createTutorialBoard = async () => { t.api.calls.push(['practice']); return { slug: 'pcbv-tutorial' }; };
  t.api.resetTutorialBoard = async () => { t.api.calls.push(['practice-reset']); return { slug: 'pcbv-tutorial' }; };
  t.saved = saved;
  return t;
}
const practiceProject = () => ({ ...project(), assets: [{ id: 'as_1', width: 1600, height: 1000, path: 'assets/a.png' }], markers: [], schematics: [] });

test('starting the tutorial opens the practice board next to the user\'s boards without remembering it', async () => {
  const t = tutorialSetup({ stored: { 'pcbv.board': 'nimbus' } });
  await t.controller.start();
  await settled();
  assert.equal(await t.controller.startTutorial(), true);
  assert.equal(t.clients.at(-1).slug, 'pcbv-tutorial');
  assert.deepEqual(t.calls('setBoards').at(-1).slice(1), [['nimbus', 'pcbv-tutorial'], 'pcbv-tutorial']);
  assert.equal(t.store['pcbv.board'], 'nimbus', 'the practice board is never remembered');
  assert.deepEqual(t.api.calls.filter((c) => c[0] === 'settings').at(-1), ['settings', { tutorial: 'started', tutorialStep: 1 }]);
  assert.equal(t.calls('tutorialEnter').length, 1);
  assert.deepEqual(t.calls('tutorialEnter')[0][1], ['photo']);
  assert.equal(t.api.calls.filter((c) => c[0] === 'settings' && c[1].welcomed).length, 0, 'opening the practice board does not end the Welcome');
});

test('while the tutorial runs a change outside the step is not sent and the coach says why', async () => {
  const t = tutorialSetup();
  await t.controller.start();
  await settled();
  await t.controller.startTutorial();
  const client = t.clients.at(-1);
  client.push({ project: practiceProject() });
  await settled();
  const before = client.applied.length;
  assert.equal(await t.controller.send({ type: 'project/metaUpdated', patch: { name: 'x' } }), false);
  assert.equal(client.applied.length, before);
  assert.deepEqual(t.calls('tutorialSay').at(-1), ['tutorialSay', 'Not needed for this step.']);
  await t.controller.saveDetails({ name: 'Other name', device: '', notes: '' });
  assert.equal(client.applied.length, before, 'the details form is refused too');
  assert.equal(await t.controller.uploadPhoto({ name: 'a.png' }, 'front'), null);
  assert.equal(t.api.calls.filter((c) => c[0] === 'upload').length, 0);
  await assert.rejects(() => t.controller.exportBoard(['report'], true), /Not needed for this step/);
  await assert.rejects(() => t.controller.startVdev(), /Not needed for this step/);
  assert.equal(await t.controller.openSerial({ path: 'x' }, 9600), false);
  assert.equal(await t.controller.writeSerial({ line: 'x' }), null);
  assert.equal(await t.controller.importLogic({}, 'a', ''), null);
});

test('Detect does nothing while the tutorial runs and works again after it', async () => {
  const t = tutorialSetup({ stored: { 'pcbv.board': 'nimbus' } });
  t.api.serialDetect = async () => { t.api.calls.push(['detect']); return { best: 9600, results: [] }; };
  await t.controller.start();
  await settled();
  await t.controller.startTutorial();
  t.clients.at(-1).push({ project: practiceProject() });
  await settled();
  assert.equal(await t.controller.detectBaud('/dev/ttyUSB0'), null);
  assert.equal(t.api.calls.filter((c) => c[0] === 'detect').length, 0);
  await t.controller.leaveTutorial();
  assert.deepEqual(await t.controller.detectBaud('/dev/ttyUSB0'), { best: 9600, results: [] });
});

test('a board change goes through again once the tutorial has been left', async () => {
  const t = tutorialSetup({ stored: { 'pcbv.board': 'nimbus' } });
  await t.controller.start();
  await settled();
  await t.controller.startTutorial();
  await t.controller.leaveTutorial();
  assert.equal(t.clients.at(-1).slug, 'nimbus', 'the board that was open comes back');
  assert.equal(await t.controller.send({ type: 'project/metaUpdated', patch: { name: 'x' } }), true);
  assert.equal(t.calls('tutorialLeave').length, 1);
});

test('nothing else can open a board while the tutorial runs', async () => {
  const t = tutorialSetup();
  await t.controller.start();
  await settled();
  await t.controller.startTutorial();
  const count = t.clients.length;
  t.controller.selectBoard('nimbus');
  assert.equal(t.clients.length, count);
});

test('leaving with no board to go back to shows the empty page, and the Welcome can offer Resume', async () => {
  const t = tutorialSetup({ boards: [], settings: { welcomed: false } });
  await t.controller.start();
  await settled();
  await t.controller.startTutorial();
  await t.controller.leaveTutorial();
  assert.equal(t.calls('showNoBoards').length >= 2, true);
  assert.equal(t.saved.tutorial, 'started');
  assert.deepEqual(t.calls('setTutorial').at(-1), ['setTutorial', { state: 'started', step: 1 }]);
});

test('a reload in the window that was inside the tutorial goes straight back to the saved step', async () => {
  const t = tutorialSetup({ stored: { 'pcbv.tutorial': '1' }, settings: { tutorial: 'started', tutorialStep: 6 } });
  await t.controller.start();
  await settled();
  await settled();
  assert.equal(t.clients.at(-1).slug, 'pcbv-tutorial');
  assert.deepEqual(t.calls('tutorialEnter')[0][1], ['photo', 'inspector']);
  assert.equal(t.api.calls.filter((c) => c[0] === 'practice-reset').length, 0, 'resuming does not rebuild the board');

  const fresh = tutorialSetup({ settings: { tutorial: 'started', tutorialStep: 6 } });
  await fresh.controller.start();
  await settled();
  await settled();
  assert.equal(fresh.calls('tutorialEnter').length, 0, 'a new launch offers Resume instead of jumping in');
  assert.deepEqual(fresh.calls('setTutorial').at(-1), ['setTutorial', { state: 'started', step: 6 }]);
});

test('a panel window never starts or resumes the tutorial', async () => {
  const t = tutorialSetup({ stored: { 'pcbv.tutorial': '1' }, settings: { tutorial: 'started', tutorialStep: 6 } });
  t.env.single = true;
  await t.controller.start();
  await settled();
  assert.equal(t.calls('tutorialEnter').length, 0);
  assert.equal(await t.controller.startTutorial(), false);
  assert.equal(t.controller.tutorialInfo().canStart, false);
});

test('Start again rebuilds the practice board; Skip on a new install saves skipped, and only then', async () => {
  const t = tutorialSetup();
  await t.controller.start();
  await settled();
  await t.controller.startTutorial({ restart: true });
  assert.equal(t.api.calls.filter((c) => c[0] === 'practice-reset').length, 1);

  const fresh = tutorialSetup({ settings: { welcomed: false } });
  await fresh.controller.start();
  await settled();
  await fresh.controller.skipWelcome();
  assert.deepEqual(fresh.api.calls.filter((c) => c[0] === 'settings').at(-1), ['settings', { welcomed: true, tutorial: 'skipped' }]);

  const going = tutorialSetup({ settings: { welcomed: false, tutorial: 'started', tutorialStep: 4 } });
  await going.controller.start();
  await settled();
  await going.controller.skipWelcome();
  assert.deepEqual(going.api.calls.filter((c) => c[0] === 'settings').at(-1), ['settings', { welcomed: true }], 'a tutorial in progress is not turned into skipped');
});

test('a lost sign-in ends the tutorial without trying to open a board', async () => {
  const t = tutorialSetup();
  await t.controller.start();
  await settled();
  await t.controller.startTutorial();
  const count = t.clients.length;
  t.clients.at(-1).push({ status: 'rejected', error: { code: 4401, message: 'no' } });
  assert.equal(t.calls('tutorialLeave').length, 1);
  assert.equal(t.clients.length, count);
  assert.equal(t.calls('showTokenPanel').length >= 1, true);
});

test('the zoom report reaches the tutorial and only counts once it runs', async () => {
  const t = tutorialSetup();
  await t.controller.start();
  await settled();
  t.controller.noteZoom();
  assert.equal(t.calls('tutorialDraw').length, 0, 'nothing happens outside the tutorial');
  assert.deepEqual(t.controller.tutorialInfo(), { state: 'new', step: 1, active: false, canStart: true });
});

// The console and logic steps through the controller (21c).
async function runningAt(step) {
  const t = tutorialSetup({ settings: { tutorial: 'started', tutorialStep: step } });
  t.api.vdevStart = async () => { t.api.calls.push(['vdev-start']); return { running: true, owned: true }; };
  t.api.vdevStop = async () => { t.api.calls.push(['vdev-stop']); return { running: false, owned: false }; };
  t.api.serialClose = async (args) => { t.api.calls.push(['serial-close', args.slug]); return null; };
  t.api.logicDecode = async () => { t.api.calls.push(['decode']); return { decoded: {}, preview: '' }; };
  t.api.logicCompare = async () => { t.api.calls.push(['compare']); return { compare: {} }; };
  await t.controller.start();
  await settled();
  await t.controller.startTutorial({ resume: true });
  t.clients.at(-1).push({ project: practiceProject() });
  await settled();
  return t;
}

test('the virtual board starts on step 10 only, and leaving stops it and closes the console on the practice board', async () => {
  const t = await runningAt(10);
  assert.deepEqual(await t.controller.startVdev(), { running: true, owned: true });
  t.controller.noteConsole({ kind: 'session', state: { captureId: 'cap_1', baud: 9600 } });
  await t.controller.leaveTutorial();
  const calls = t.api.calls.map((c) => c[0]);
  assert.ok(calls.indexOf('serial-close') < calls.indexOf('vdev-stop'), 'closed first, then stopped');
  assert.deepEqual(t.api.calls.find((c) => c[0] === 'serial-close'), ['serial-close', 'pcbv-tutorial']);
  assert.equal(t.clients.at(-1).slug, 'nimbus');

  const early = await runningAt(9);
  await assert.rejects(() => early.controller.startVdev(), /Not needed for this step/);
  assert.equal(early.api.calls.filter((c) => c[0] === 'vdev-start').length, 0);
});

test('a virtual board the tutorial did not start is left running when the tutorial ends', async () => {
  const t = await runningAt(12);
  t.controller.noteConsole({ kind: 'vdev', running: true });
  await t.controller.leaveTutorial();
  assert.equal(t.api.calls.filter((c) => c[0] === 'vdev-stop').length, 0);
});

test('the logic panel decodes on steps 15 and 16, compares on step 16 and never imports', async () => {
  const early = await runningAt(14);
  assert.equal(await early.controller.logicDecode('cap_l', 0, 115200), null);
  assert.equal(early.api.calls.filter((c) => c[0] === 'decode').length, 0);

  const decode = await runningAt(15);
  assert.ok(await decode.controller.logicDecode('cap_l', 0, 115200));
  assert.equal(await decode.controller.logicCompare('cap_l', 0, 'cap_s'), null, 'comparing waits for step 16');
  assert.equal(await decode.controller.importLogic({}, 'a.sr', ''), null);

  const compare = await runningAt(16);
  assert.ok(await compare.controller.logicCompare('cap_l', 0, 'cap_s'));
  assert.equal(await compare.controller.importLogic({}, 'a.sr', ''), null);
});

test('outside the tutorial the logic panel imports, decodes and compares as before', async () => {
  const t = setup({ hash: '#code=abc' });
  t.api.importLogic = async () => ({ capture: { id: 'cap_x' } });
  t.api.logicDecode = async () => ({ decoded: {} });
  t.api.logicCompare = async () => ({ compare: {} });
  await t.controller.start();
  await settled();
  assert.ok(await t.controller.importLogic({}, 'a.sr', ''));
  assert.ok(await t.controller.logicDecode('c', 0, 0));
  assert.ok(await t.controller.logicCompare('c', 0, 'd'));
});
