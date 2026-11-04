import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoard, uploadPhoto, importLogic } from '../js/api.js';

for (const [name, operation] of [['creation', createBoard], ['photo upload', uploadPhoto], ['logic import', importLogic]]) {
  test(`uncertain ${name} is sent once with protocol and shows inspection guidance`, async () => {
    let calls = 0;
    await assert.rejects(operation({ baseUrl: '', token: 'test', slug: 'board', file: new Uint8Array(), name: 'test',
      fetchImpl: async (_url, options) => {
        calls += 1;
        assert.equal(options.headers['X-PCBV-Protocol'], '2');
        throw new TypeError('connection lost');
      } }), /operation may have completed/);
    assert.equal(calls, 1);
  });
}

import { mintCode, redeemCode } from '../js/api.js';

test('redeeming a code sends no Authorization header and returns the token', async () => {
  const seen = [];
  const token = await redeemCode({ baseUrl: 'http://x', code: 'c1', fetchImpl: async (url, options) => {
    seen.push([url, options.method, options.headers, options.body]);
    return new Response(JSON.stringify({ token: 'tok' }), { status: 200 });
  } });
  assert.equal(token, 'tok');
  assert.deepEqual(seen, [['http://x/api/session', 'POST', { 'Content-Type': 'application/json' }, '{"code":"c1"}']]);
});

test('a refused or odd answer to a code is an ApiError, not a token', async () => {
  await assert.rejects(redeemCode({ baseUrl: '', code: 'c', fetchImpl: async () => new Response('{"error":"invalid_code","message":"used"}', { status: 401 }) }),
    (error) => error.status === 401 && error.code === 'invalid_code');
  await assert.rejects(redeemCode({ baseUrl: '', code: 'c', fetchImpl: async () => new Response('{"token": 5}', { status: 200 }) }), /request failed/i);
});

test('minting a code needs the token', async () => {
  let sent;
  const code = await mintCode({ baseUrl: 'http://x', token: 'tok', fetchImpl: async (url, options) => {
    sent = [url, options.method, options.headers.Authorization];
    return new Response('{"code":"c2","expiresIn":60}', { status: 200 });
  } });
  assert.equal(code, 'c2');
  assert.deepEqual(sent, ['http://x/api/session/code', 'POST', 'Bearer tok']);
});
