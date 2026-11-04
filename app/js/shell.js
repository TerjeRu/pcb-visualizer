// Panel windows inside the desktop shell (Tauri). They are real windows with stable titles such as
// "pcbv · Console", which KWin rules can pin to a monitor. createDesktopShell returns undefined in a
// plain browser, where the page opens pop-ups itself.

const POLL_MS = 1000;

export function createDesktopShell(tauri, origin, timers = { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h) }) {
  const Win = tauri?.webviewWindow?.WebviewWindow;
  if (!Win) return undefined;
  const handles = new Map();      // panel -> handle; a second request for a panel reuses its window and its one watcher
  const closing = new Map();      // panel -> promise that settles once its old window was told to close
  const labelOf = (panel) => `panel-${panel}`;

  /**
   * A handle starts without a window because Tauri creates it asynchronously. focus() and close() wait
   * for it, so closing a window that is still being created closes it once it exists instead of doing nothing.
   * A closing handle is forgotten at once, so opening the panel again gets a new window, not the one going away.
   */
  function makeHandle(panel, build) {
    const handle = {
      closed: false, win: null, ready: null,
      focus() { this.ready.then(() => this.win?.setFocus()); },
      close() {
        if (handles.get(panel) === this) handles.delete(panel);
        const done = this.ready.then(() => this.win?.close()).catch(() => {});
        closing.set(panel, done);
        done.then(() => { if (closing.get(panel) === done) closing.delete(panel); });
      },
    };
    handle.ready = (async () => {
      const { win, existed } = await build();
      handle.win = win;
      watch(panel, handle, existed);
    })().catch(() => { handle.closed = true; handles.delete(panel); });
    handles.set(panel, handle);
    return handle;
  }

  // Close events from other windows do not reliably reach this one, so ask Tauri whether the window still
  // exists. It only counts as closed after it has been seen, so a window still being created is not
  // mistaken for a closed one. The dock then brings the panel back.
  function watch(panel, handle, existed) {
    let seen = existed;
    const timer = timers.setInterval(async () => {
      const exists = Boolean(await Win.getByLabel(labelOf(panel)).catch(() => null));
      if (exists) seen = true;
      else if (seen) {
        handle.closed = true;
        timers.clearInterval(timer);
        if (handles.get(panel) === handle) handles.delete(panel);
      }
    }, POLL_MS);
  }

  return {
    /** Open the panel's window, or focus it if it exists. A new webview has its own session storage, so it gets a one-time code in the fragment, as with pcbv open. */
    openPanel(panel, slug, getCode, title, generation = 0) {
      const existing = handles.get(panel);
      if (existing && !existing.closed) { existing.focus(); return existing; }
      return makeHandle(panel, async () => {
        await closing.get(panel);
        const found = await Win.getByLabel(labelOf(panel));
        if (found) { await found.setFocus(); return { win: found, existed: true }; }
        const code = await getCode();
        const url = `${origin}/?panel=${encodeURIComponent(panel)}&board=${encodeURIComponent(slug ?? '')}&gen=${generation}#code=${encodeURIComponent(code)}`;
        return { win: new Win(labelOf(panel), { url, title: `pcbv · ${title}`, width: 960, height: 720 }), existed: false };
      });
    },

    /** The handle of a panel window that exists already, for example after the main window reloaded. */
    async find(panel) {
      const existing = handles.get(panel);
      if (existing && !existing.closed) return existing;
      const win = await Win.getByLabel(labelOf(panel)).catch(() => null);
      return win ? makeHandle(panel, async () => ({ win, existed: true })) : null;
    },
  };
}
