import { test } from 'node:test';
import assert from 'node:assert/strict';

import { forgetToken, parseFragment, requestCodeFromOpener, resolveSession } from '../js/session.js';

function env({ hash = '', stored = {} } = {}) {
  const store = { ...stored };
  const calls = [];
  return {
    store, calls,
    location: { hash, pathname: '/', search: '' },
    history: { replaceState: (...args) => calls.push(args) },
    storage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    },
  };
}

test('code and board are read from the URL fragment', () => {
  assert.deepEqual(parseFragment('#code=abc_DEF-123&board=nimbus'), { code: 'abc_DEF-123', board: 'nimbus' });
  assert.deepEqual(parseFragment('code=abc'), { code: 'abc', board: null });
});

test('junk in the fragment is ignored rather than trusted, and a token in it is not read', () => {
  assert.deepEqual(parseFragment(''), { code: null, board: null });
  assert.deepEqual(parseFragment(undefined), { code: null, board: null });
  assert.deepEqual(parseFragment('#board=../etc/passwd&code='), { code: null, board: null });
  assert.deepEqual(parseFragment('#board=UPPER'), { code: null, board: null });
  assert.deepEqual(parseFragment('#token=abc'), { code: null, board: null });
  assert.equal(parseFragment(`#code=${'x'.repeat(129)}`).code, null);
  assert.equal(parseFragment('#code=a%20b').code, null);
});

test('the code is handed on and the address bar is cleaned; nothing is stored yet', () => {
  const e = env({ hash: '#code=once&board=nimbus' });
  assert.deepEqual(resolveSession(e), { token: null, code: 'once', board: 'nimbus' });
  assert.deepEqual(e.store, {}, 'a code is never stored');
  assert.deepEqual(e.calls, [[null, '', '/']], 'history is rewritten without the fragment');
});

test('a reload without a fragment keeps working from session storage', () => {
  const e = env({ stored: { 'pcbv.token': 'kept' } });
  assert.deepEqual(resolveSession(e), { token: 'kept', code: null, board: null });
  assert.deepEqual(e.calls, [], 'nothing to strip');
});

test('without any token the session says so', () => {
  assert.equal(resolveSession(env()).token, null);
});

test('blocked storage does not break reading the session', () => {
  const e = env({ hash: '#code=abc' });
  e.storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  assert.equal(resolveSession(e).code, 'abc');
  assert.doesNotThrow(() => forgetToken(e.storage));
});

test('forgetToken removes it', () => {
  const e = env({ stored: { 'pcbv.token': 'x' } });
  forgetToken(e.storage);
  assert.equal(e.store['pcbv.token'], undefined);
});

function fakeWindow({ opener }) {
  const listeners = new Set();
  return {
    opener, location: { origin: 'http://127.0.0.1:8765' },
    addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn),
    deliver: (event) => [...listeners].forEach((fn) => fn(event)), listeners,
  };
}

test('a window without an opener has nobody to ask', async () => {
  assert.equal(await requestCodeFromOpener(fakeWindow({ opener: null }), 10), null);
});

test('the opener answers with a code; other senders, origins and shapes are ignored', async () => {
  const posted = [];
  const opener = { postMessage: (...a) => posted.push(a) };
  const win = fakeWindow({ opener });
  const waiting = requestCodeFromOpener(win, 200);
  assert.deepEqual(posted, [[{ type: 'pcbv:code-request' }, 'http://127.0.0.1:8765']]);
  win.deliver({ source: {}, origin: 'http://127.0.0.1:8765', data: { type: 'pcbv:code', code: 'fromstranger' } });
  win.deliver({ source: opener, origin: 'https://evil.example', data: { type: 'pcbv:code', code: 'fromevil' } });
  win.deliver({ source: opener, origin: 'http://127.0.0.1:8765', data: { type: 'pcbv:code', code: 'bad code!' } });
  win.deliver({ source: opener, origin: 'http://127.0.0.1:8765', data: { type: 'pcbv:code', code: 'good_code-1' } });
  assert.equal(await waiting, 'good_code-1');
  assert.equal(win.listeners.size, 0, 'the listener is removed');
});

test('no answer within the time limit gives null and removes the listener', async () => {
  const win = fakeWindow({ opener: { postMessage() {} } });
  assert.equal(await requestCodeFromOpener(win, 20), null);
  assert.equal(win.listeners.size, 0);
});
