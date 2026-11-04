// Test doubles: a controllable WebSocket class and a manual clock.

export function makeSocketClass() {
  return class FakeSocket {
    static instances = [];
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.readyState = 0;
      FakeSocket.instances.push(this);
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.closedByClient = true; }
    // --- controls for tests
    open() { this.readyState = 1; this.onopen?.(); }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
    receiveRaw(text) { this.onmessage?.({ data: text }); }
    serverClose(code = 1006, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
  };
}

export function makeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) { const id = ++nextId; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer(id) { timers.delete(id); },
    now() { return now; },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now && timers.has(id)) { timers.delete(id); timer.fn(); }
      }
    },
    delays() { return [...timers.values()].map((t) => t.at - now); },
    count() { return timers.size; },
  };
}

/** BroadcastChannel stand-in: a message reaches every other member of the hub at once, as a copy. */
export function makeChannelHub() {
  const members = [];
  return () => {
    const channel = {
      onmessage: null, closed: false,
      postMessage(data) { for (const m of members) if (m !== channel && !m.closed) m.onmessage?.({ data: structuredClone(data) }); },
      close() { channel.closed = true; },
    };
    members.push(channel);
    return channel;
  };
}

/** Timers that only run when a test fires them. */
export function makeTimers() {
  const live = new Map();
  let next = 0;
  return {
    set(fn, ms) { live.set(++next, { fn, ms }); return next; },
    clear(handle) { live.delete(handle); },
    fire() { for (const [handle, { fn }] of [...live]) { live.delete(handle); fn(); } },
    delays: () => [...live.values()].map((t) => t.ms),
  };
}
