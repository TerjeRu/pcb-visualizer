import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BoardClient, ClientError } from '../js/client.js';
import { makeClock, makeSocketClass } from './fakes.mjs';

const T0 = '2026-10-25T10:00:00.000Z';
const baseProject = () => ({
  format: 'pcb-visualizer-project', schemaVersion: 2,
  meta: { id: 'prj_1', name: 'Nimbus', device: '', notes: '', created: T0, modified: T0 },
  assets: [], markers: [], schematics: [], components: [],
});
const assetEvent = (seq, id = `img_${seq}`) => ({
  seq, ts: `2026-10-25T10:00:${String(seq).padStart(2, '0')}.000Z`, actor: 'cli',
  type: 'asset/added', asset: { id, path: `assets/${id}.jpg` },
});

function harness(options = {}) {
  const Socket = makeSocketClass();
  const clock = makeClock();
  const client = new BoardClient({
    baseUrl: 'http://127.0.0.1:8765', token: 'tok', slug: 'nimbus', actor: 'web',
    WebSocketImpl: Socket, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now, random: () => 1, ...options,
  });
  const last = () => Socket.instances.at(-1);
  return { client, Socket, clock, last };
}

/** Connect and take the snapshot, so a test can start from a live client at `seq`. */
function live(h, seq = 1, project = baseProject()) {
  h.client.connect();
  h.last().open();
  h.last().receive({ op: 'snapshot', seq, project });
  return h.last();
}

test('first connection authenticates without a resume point and shows the snapshot', () => {
  const h = harness();
  h.client.connect();
  assert.equal(h.client.state.status, 'connecting');
  assert.equal(h.last().url, 'ws://127.0.0.1:8765/api/boards/nimbus/ws');
  h.last().open();
  assert.deepEqual(h.last().sent, [{ op: 'auth', protocol: 2, token: 'tok', actor: 'web' }]);
  h.last().receive({ op: 'snapshot', seq: 4, project: baseProject() });
  assert.equal(h.client.state.status, 'live');
  assert.equal(h.client.state.seq, 4);
  assert.equal(h.client.state.project.meta.name, 'Nimbus');
});

test('board names are escaped in the socket URL', () => {
  const h = harness({ slug: 'a/b' });
  h.client.connect();
  assert.equal(h.last().url, 'ws://127.0.0.1:8765/api/boards/a%2Fb/ws');
});

test('events apply in order and meta.modified follows the event time like on the service', () => {
  const h = harness();
  const socket = live(h);
  socket.receive({ op: 'event', event: assetEvent(2) });
  socket.receive({ op: 'event', event: assetEvent(3) });
  assert.equal(h.client.state.seq, 3);
  assert.deepEqual(h.client.state.project.assets.map((a) => a.id), ['img_2', 'img_3']);
  assert.equal(h.client.state.project.meta.modified, '2026-10-25T10:00:03.000Z');
});

test('an event that arrives twice is applied once', () => {
  const h = harness();
  const socket = live(h);
  socket.receive({ op: 'event', event: assetEvent(2) });
  socket.receive({ op: 'event', event: assetEvent(2) });
  assert.equal(h.client.state.project.assets.length, 1);
  assert.equal(h.Socket.instances.length, 1, 'a harmless duplicate must not cost a reconnect');
  assert.equal(h.client.state.status, 'live');
});

test('a gap in sequence numbers restarts from a full snapshot and never applies the later event', () => {
  const h = harness();
  const first = live(h, 1);
  first.receive({ op: 'event', event: assetEvent(2) });
  const before = h.client.state.project;

  first.receive({ op: 'event', event: assetEvent(5) });          // 3 and 4 were lost
  assert.equal(h.client.state.project, before, 'the out-of-order event must not be applied');
  assert.equal(h.Socket.instances.length, 1, 'it waits for the backoff delay first');
  assert.ok(first.closedByClient);
  h.clock.advance(250);
  assert.equal(h.Socket.instances.length, 2);
  h.last().open();
  assert.deepEqual(h.last().sent[0], { op: 'auth', protocol: 2, token: 'tok', actor: 'web' }, 'no resume point after a gap');

  const fresh = { ...baseProject(), assets: [{ id: 'from_snapshot', path: 'assets/x.jpg' }] };
  h.last().receive({ op: 'snapshot', seq: 6, project: fresh });
  assert.equal(h.client.state.seq, 6);
  assert.deepEqual(h.client.state.project.assets.map((a) => a.id), ['from_snapshot']);
  assert.equal(h.client.state.error, null);
});

test('an event this client cannot apply triggers a resync instead of a crash', () => {
  const h = harness();
  const socket = live(h);
  socket.receive({ op: 'event', event: { seq: 2, ts: T0, actor: 'x', type: 'firmware/dumped' } });
  h.clock.advance(250);
  assert.equal(h.Socket.instances.length, 2);
  assert.equal(h.client.state.seq, 1);
  assert.match(h.client.state.error.message, /Resynchronising/);
});

test('unreadable and malformed messages trigger a resync', () => {
  const h = harness();
  live(h).receiveRaw('{not json');
  h.clock.advance(250);
  assert.equal(h.Socket.instances.length, 2);
  h.last().open();
  h.last().receive({ op: 'snapshot', seq: 1, project: baseProject() });
  h.last().receive({ op: 'event', event: { type: 'asset/added' } });   // no seq
  h.clock.advance(500);
  assert.equal(h.Socket.instances.length, 3);
});

test('after a drop it reconnects and asks only for what it missed', () => {
  const h = harness();
  const socket = live(h, 5);
  socket.serverClose(1006);
  assert.equal(h.client.state.status, 'reconnecting');
  assert.deepEqual(h.clock.delays(), [250]);
  assert.equal(h.client.state.project.meta.name, 'Nimbus', 'the last known state stays visible meanwhile');

  h.clock.advance(250);
  assert.equal(h.Socket.instances.length, 2);
  h.last().open();
  assert.deepEqual(h.last().sent[0], { op: 'auth', protocol: 2, token: 'tok', actor: 'web', sinceSeq: 5 });
  h.last().receive({ op: 'ready', mode: 'resume', seq: 7 });
  h.last().receive({ op: 'event', event: assetEvent(6) });
  h.last().receive({ op: 'event', event: assetEvent(7) });
  assert.equal(h.client.state.status, 'live');
  assert.equal(h.client.state.seq, 7);
  assert.deepEqual(h.client.state.project.assets.map((a) => a.id), ['img_6', 'img_7']);
});

test('reconnect delays grow, are capped, and start over only after a stable minute', () => {
  const h = harness();
  h.client.connect();
  const seen = [];
  for (let i = 0; i < 7; i += 1) {
    h.last().serverClose(1006);
    seen.push(h.clock.delays()[0]);
    h.clock.advance(seen.at(-1));
  }
  assert.deepEqual(seen, [250, 500, 1000, 2000, 5000, 5000, 5000]);
  h.last().open();
  h.last().receive({ op: 'snapshot', seq: 1, project: baseProject() });
  h.clock.advance(59_999);
  h.last().serverClose(1006);
  assert.deepEqual(h.clock.delays(), [5000], 'a snapshot alone does not reset the delay');
  h.clock.advance(5000);
  h.last().open();
  h.last().receive({ op: 'snapshot', seq: 1, project: baseProject() });
  h.clock.advance(60_000);
  h.last().serverClose(1006);
  assert.deepEqual(h.clock.delays(), [250]);
});

test('delays are jittered between half and the full step', () => {
  for (const [random, expected] of [[0, 125], [0.5, 188], [1, 250]]) {
    const h = harness({ random: () => random });
    h.client.connect();
    h.last().serverClose(1006);
    assert.deepEqual(h.clock.delays(), [expected]);
  }
});

test('resyncs back off like reconnects, so a failing service is not hammered', () => {
  const h = harness();
  const first = live(h, 1);
  first.receive({ op: 'event', event: assetEvent(5) });
  assert.deepEqual(h.clock.delays(), [250]);
  h.clock.advance(250);
  h.last().open();
  h.last().receive({ op: 'snapshot', seq: 5, project: baseProject() });
  h.last().receiveRaw('{not json');
  assert.deepEqual(h.clock.delays(), [500], 'the second trouble in a row waits longer');
  assert.equal(h.client.state.status, 'reconnecting');
  assert.equal(h.Socket.instances.length, 2);
});

test('a resume the service cannot honour is answered with a snapshot, which replaces the copy', () => {
  const h = harness();
  const socket = live(h, 5);
  socket.serverClose(1006);
  h.clock.advance(250);
  h.last().open();
  const restarted = { ...baseProject(), meta: { ...baseProject().meta, name: 'After restart' } };
  h.last().receive({ op: 'snapshot', seq: 2, project: restarted });
  assert.equal(h.client.state.seq, 2);
  assert.equal(h.client.state.project.meta.name, 'After restart');
});

test('a service that is behind this copy forces a full resync', () => {
  const h = harness();
  const socket = live(h, 5);
  socket.serverClose(1006);
  h.clock.advance(250);
  h.last().open();
  h.last().receive({ op: 'ready', mode: 'resume', seq: 3 });
  h.clock.advance(500);
  assert.equal(h.Socket.instances.length, 3);
  h.last().open();
  assert.equal('sinceSeq' in h.last().sent[0], false);
});

for (const [code, pattern] of [[4401, /token/i], [4404, /no board/i], [1008, /refused/i]]) {
  test(`close code ${code} is a refusal: no retry, and the reason is shown`, () => {
    const h = harness();
    h.client.connect();
    h.last().open();
    h.last().serverClose(code);
    assert.equal(h.client.state.status, 'rejected');
    assert.match(h.client.state.error.message, pattern);
    assert.equal(h.clock.count(), 0, 'no reconnect timer');
  });
}

test('a window the service dropped for falling behind reconnects with backoff and resumes', () => {
  const h = harness();
  const socket = live(h, 5);
  socket.serverClose(4408, 'slow-client');
  assert.equal(h.client.state.status, 'reconnecting');
  assert.deepEqual(h.clock.delays(), [250]);
  h.clock.advance(250);
  h.last().open();
  assert.equal(h.last().sent[0].sinceSeq, 5);
});

test('a board too large to send is shown and not retried, whichever of notice and close arrives first', () => {
  for (const noticeFirst of [true, false]) {
    const h = harness();
    h.client.connect();
    h.last().open();
    if (noticeFirst) h.last().receive({ op: 'error', code: 'board_too_large', error: 'board_too_large', message: 'Board too large to send' });
    h.last().serverClose(4408, 'board-too-large');
    assert.equal(h.client.state.status, 'rejected');
    assert.equal(h.client.state.error.code, 'board_too_large');
    assert.match(h.client.state.error.message, /too large to send/i);
    assert.equal(h.clock.count(), 0, 'no reconnect timer');
  }
});

test('apply sends the event and resolves with the sequence number the service assigned', async () => {
  const h = harness();
  const socket = live(h);
  const done = h.client.apply({ type: 'project/metaUpdated', patch: { notes: 'hello' } });
  const request = socket.sent.at(-1);
  assert.equal(request.op, 'apply');
  assert.deepEqual(request.event, { type: 'project/metaUpdated', patch: { notes: 'hello' } });
  socket.receive({ op: 'event', event: { seq: 2, ts: T0, actor: 'web', type: 'project/metaUpdated', patch: { notes: 'hello' } } });
  socket.receive({ op: 'ack', id: request.id, seq: 2 });
  assert.deepEqual(await done, { seq: 2 });
  assert.equal(h.client.state.project.meta.notes, 'hello');
  assert.equal(h.clock.count(), 0, 'the timeout timer is cleaned up');
});

test('a rejected edit fails with the service code and changes nothing', async () => {
  const h = harness();
  const socket = live(h);
  const before = h.client.state.project;
  const done = h.client.apply({ type: 'asset/removed', id: 'missing' });
  socket.receive({ op: 'error', id: socket.sent.at(-1).id, code: 'conflict', message: 'asset does not exist' });
  await assert.rejects(done, (error) => error instanceof ClientError && error.code === 'conflict' && /does not exist/.test(error.message));
  assert.equal(h.client.state.project, before);
});

test('edits waiting for an answer fail when the connection drops instead of hanging', async () => {
  const h = harness();
  const socket = live(h);
  const done = h.client.apply({ type: 'project/metaUpdated', patch: { notes: 'x' } });
  socket.serverClose(1006);
  await assert.rejects(done, (error) => error.code === 'disconnected');
  assert.equal(h.clock.count(), 1, 'only the reconnect timer is left');
});

test('apply refuses to send while not live', async () => {
  const h = harness();
  await assert.rejects(h.client.apply({ type: 'x' }), (e) => e.code === 'not-connected');
  h.client.connect();
  await assert.rejects(h.client.apply({ type: 'x' }), (e) => e.code === 'not-connected');
  assert.deepEqual(h.last().sent, [], 'nothing was written to the socket');
  h.last().open();
  h.last().receive({ op: 'snapshot', seq: 1, project: baseProject() });
  h.last().serverClose(1006);
  await assert.rejects(h.client.apply({ type: 'x' }), (e) => e.code === 'not-connected');
});

test('apply times out, and a late acknowledgement is ignored', async () => {
  const h = harness({ applyTimeoutMs: 3000 });
  const socket = live(h);
  const done = h.client.apply({ type: 'project/metaUpdated', patch: { notes: 'x' } });
  const id = socket.sent.at(-1).id;
  h.clock.advance(3000);
  await assert.rejects(done, (error) => error.code === 'timeout');
  assert.doesNotThrow(() => socket.receive({ op: 'ack', id, seq: 2 }));
  assert.doesNotThrow(() => socket.receive({ op: 'ack', id: 'never-sent', seq: 9 }));
});

test('close stops reconnecting and fails anything still waiting', async () => {
  const h = harness();
  const socket = live(h);
  const done = h.client.apply({ type: 'project/metaUpdated', patch: { notes: 'x' } });
  h.client.close();
  await assert.rejects(done, (error) => error.code === 'closed');
  assert.equal(h.client.state.status, 'closed');
  assert.equal(h.clock.count(), 0);
  assert.ok(socket.closedByClient);
  assert.throws(() => h.client.connect(), /closed/);

  const h2 = harness();
  live(h2).serverClose(1006);
  h2.client.close();
  assert.equal(h2.clock.count(), 0, 'a pending reconnect is cancelled');
});

test('messages from a socket that was replaced are ignored', () => {
  const h = harness();
  const old = live(h);
  old.receive({ op: 'event', event: assetEvent(9) });             // gap: forces a resync, old socket is dropped
  const projectAfterResyncStart = h.client.state.project;
  old.receive({ op: 'event', event: assetEvent(2) });             // late arrival on the dead socket
  old.serverClose(1006);
  assert.equal(h.client.state.project, projectAfterResyncStart);
  assert.equal(h.clock.count(), 1, 'closing the old socket must not schedule a second reconnect');
});

test('listeners are told about every change and can unsubscribe', () => {
  const h = harness();
  const seen = [];
  const stop = h.client.subscribe((state) => seen.push(state.status));
  h.client.connect();
  h.last().open();
  h.last().receive({ op: 'snapshot', seq: 1, project: baseProject() });
  stop();
  h.last().serverClose(1006);
  assert.deepEqual(seen, ['connecting', 'live']);
});

test('after recovering from a resync the next drop goes back to a cheap resume', () => {
  const h = harness();
  const first = live(h, 1);
  first.receive({ op: 'event', event: assetEvent(4) });             // gap: resync
  h.clock.advance(250);
  h.last().open();
  h.last().receive({ op: 'snapshot', seq: 4, project: baseProject() });
  h.last().serverClose(1006);
  h.clock.advance(500);
  h.last().open();
  assert.equal(h.last().sent[0].sinceSeq, 4, 'resume point is sent again once the copy is trusted');
});

test('a settings message goes to onSettings and leaves the project alone', () => {
  const received = [];
  const h = harness({ onSettings: (settings) => received.push(settings) });
  const socket = live(h, 3);
  socket.receive({ op: 'settings', settings: { guidance: 'expert' } });
  assert.deepEqual(received, [{ guidance: 'expert' }]);
  assert.equal(h.client.state.seq, 3);
  assert.equal(h.client.state.status, 'live');
});

test('protocol refusal does not reconnect', () => {
  const h = harness();
  live(h).serverClose(4409);
  assert.equal(h.client.state.status, 'rejected');
  assert.match(h.client.state.error.message, /Reload/);
  assert.equal(h.clock.count(), 0);
});

test('unknown mutation outcome resyncs without resending and gives inspection guidance', async () => {
  const h = harness();
  const socket = live(h);
  const pending = h.client.apply({ type: 'project/metaUpdated', patch: { name: 'uncertain' } });
  const rejected = assert.rejects(pending, /operation may have completed/);
  socket.serverClose(1006);
  await rejected;
  h.clock.advance(250);
  h.last().open();
  assert.equal(h.last().sent.some((m) => m.op === 'apply'), false);
});

test('read-only storage blocks edits', async () => {
  const h = harness();
  const socket = live(h);
  socket.receive({ op: 'storage', storage: { writable: false, warnings: [] } });
  await assert.rejects(h.client.apply({ type: 'project/metaUpdated', patch: {} }), (e) => e.code === 'recovery_required');
  assert.equal(socket.sent.some((m) => m.op === 'apply'), false);
});

test('unusable board reports recovery instructions and waits for an explicit reopen', () => {
  const h = harness();
  h.client.connect();
  h.last().open();
  const message = 'Unsupported journal version; recreate with pcbv new or pcbv demo';
  h.last().receive({ op: 'error', code: 'recovery_required', error: 'recovery_required', message });
  h.last().serverClose(1011);
  assert.equal(h.client.state.status, 'rejected');
  assert.equal(h.client.state.error.message, message);
  assert.equal(h.clock.count(), 0);
});

const edit = { type: 'project/metaUpdated', patch: { notes: 'x' } };

test('the save state starts empty and counts writes in flight', async () => {
  const h = harness();
  const socket = live(h);
  assert.deepEqual(h.client.state.save, { pending: 0, at: null, error: null });
  const first = h.client.apply(edit);
  const second = h.client.apply(edit);
  assert.equal(h.client.state.save.pending, 2);
  socket.receive({ op: 'ack', id: socket.sent.at(-2).id, seq: 2 });
  await first;
  assert.equal(h.client.state.save.pending, 1);
  socket.receive({ op: 'ack', id: socket.sent.at(-1).id, seq: 3 });
  await second;
  assert.equal(h.client.state.save.pending, 0);
});

test('a stored write sets the time and a refused one the reason, until the next success', async () => {
  const h = harness();
  const socket = live(h);
  h.clock.advance(5000);
  const stored = h.client.apply(edit);
  socket.receive({ op: 'ack', id: socket.sent.at(-1).id, seq: 2 });
  await stored;
  assert.deepEqual(h.client.state.save, { pending: 0, at: 5000, error: null });
  const refused = h.client.apply(edit);
  socket.receive({ op: 'error', id: socket.sent.at(-1).id, code: 'invalid_event', message: 'No.' });
  await assert.rejects(refused);
  assert.deepEqual(h.client.state.save, { pending: 0, at: 5000, error: 'No.' });
  h.clock.advance(1000);
  const again = h.client.apply(edit);
  socket.receive({ op: 'ack', id: socket.sent.at(-1).id, seq: 3 });
  await again;
  assert.deepEqual(h.client.state.save, { pending: 0, at: 6000, error: null });
});

test('a timeout and a write while not connected set the error', async () => {
  const h = harness({ applyTimeoutMs: 3000 });
  live(h);
  const slow = h.client.apply(edit);
  h.clock.advance(3000);
  await assert.rejects(slow, (e) => e.code === 'timeout');
  assert.equal(h.client.state.save.pending, 0);
  assert.match(h.client.state.save.error, /./);
  const closed = harness();
  await assert.rejects(closed.client.apply(edit), (e) => e.code === 'not-connected');
  assert.equal(closed.client.state.save.error, 'The app is not connected to the service.');
});

test('track follows a write outside the socket and passes its result on', async () => {
  const h = harness();
  live(h);
  let finish;
  const upload = h.client.track(new Promise((resolve) => { finish = resolve; }));
  assert.equal(h.client.state.save.pending, 1);
  finish('done');
  assert.equal(await upload, 'done');
  assert.deepEqual(h.client.state.save, { pending: 0, at: 0, error: null });
  await assert.rejects(h.client.track(Promise.reject(new Error('Disk full.'))), /Disk full/);
  assert.deepEqual(h.client.state.save, { pending: 0, at: 0, error: 'Disk full.' });
});

test('a snapshot or reconnect keeps the save state', async () => {
  const h = harness();
  const socket = live(h);
  await assert.rejects(h.client.track(Promise.reject(new Error('Disk full.'))));
  socket.serverClose();
  h.clock.advance(5000);
  h.last().open();
  h.last().receive({ op: 'snapshot', seq: 1, project: baseProject() });
  assert.equal(h.client.state.save.error, 'Disk full.');
});

test('around gives the board just before and just after an event, also when asked before it arrives', async () => {
  const h = harness();
  const socket = live(h);
  const early = h.client.around(3);
  socket.receive({ op: 'event', event: assetEvent(2) });
  socket.receive({ op: 'event', event: assetEvent(3) });
  const { before, after } = await early;
  assert.deepEqual(before.assets.map((a) => a.id), ['img_2']);
  assert.deepEqual(after.assets.map((a) => a.id), ['img_2', 'img_3']);
  const late = await h.client.around(2);
  assert.deepEqual(late.before.assets, []);
});

test('around answers null for an event older than the recent list or one a snapshot skipped', async () => {
  const h = harness();
  const socket = live(h);
  for (let seq = 2; seq <= 70; seq += 1) socket.receive({ op: 'event', event: assetEvent(seq) });
  assert.equal(await h.client.around(2), null);
  assert.ok(await h.client.around(70));
  const skipped = h.client.around(80);
  socket.receive({ op: 'event', event: assetEvent(75) });          // a gap: resync
  h.clock.advance(5000);
  h.last().open();
  h.last().receive({ op: 'snapshot', seq: 90, project: baseProject() });
  assert.equal(await skipped, null);
  assert.equal(await h.client.around(70), null, 'a snapshot forgets the recent events');
});

test('the state counts snapshots, so a resync can be told from a resume', () => {
  const h = harness();
  const socket = live(h);
  assert.equal(h.client.state.snapshots, 1);
  socket.serverClose(1006);
  h.clock.advance(5000);
  h.last().open();
  h.last().receive({ op: 'ready', mode: 'resume', seq: 1 });
  assert.equal(h.client.state.snapshots, 1);
  h.client.refresh();
  h.clock.advance(5000);
  h.last().open();
  h.last().receive({ op: 'snapshot', seq: 1, project: baseProject() });
  assert.equal(h.client.state.snapshots, 2);
});

test('close answers waiting around calls with null', async () => {
  const h = harness();
  live(h);
  const waiting = h.client.around(5);
  h.client.close();
  assert.equal(await waiting, null);
});
