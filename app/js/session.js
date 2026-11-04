export const PROTOCOL_VERSION = 2;
export const UNCERTAIN_OPERATION = 'The operation may have completed. Refresh and inspect the board before trying again.';

// Where the token and the board choice come from.
//
// `pcbv open` starts the app at  http://127.0.0.1:8765/#code=...&board=slug .  The code is good for 60
// seconds and one use; the app exchanges it at POST /api/session for the token, keeps the token in
// sessionStorage (this tab only, gone when the tab closes) and removes the fragment from the address bar,
// so nothing is left in history or a copied URL. The token itself never appears in a URL.

const CODE_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const isBoardSlug = (value) => typeof value === 'string' && SLUG_RE.test(value);

export function parseFragment(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const code = params.get('code');
  const board = params.get('board');
  return { code: code && CODE_RE.test(code) ? code : null, board: isBoardSlug(board) ? board : null };
}

const TOKEN_KEY = 'pcbv.token';

/** Returns {token, code, board}: the stored token, the one-time code from the address if any, and the board. `env` carries location, history and storage so tests can supply fakes. */
export function resolveSession(env) {
  const { location, history, storage } = env;
  const fromUrl = parseFragment(location.hash);
  if (location.hash) {
    history.replaceState(null, '', location.pathname + location.search);
  }
  let token = null;
  try { token = storage.getItem(TOKEN_KEY); } catch { /* blocked storage: no stored token */ }
  return { token: token || null, code: fromUrl.code, board: fromUrl.board };
}

/**
 * A window opened from the main window can ask it for a fresh code when its own storage lost the token.
 * Only the window that opened this one is asked and only its answer, from the same origin, is taken.
 * Resolves to the code, or null when there is no opener or no answer within `timeoutMs`.
 */
export function requestCodeFromOpener(win, timeoutMs = 5000) {
  const opener = win.opener;
  if (!opener) return Promise.resolve(null);
  return new Promise((resolve) => {
    const finish = (code) => { clearTimeout(timer); win.removeEventListener('message', onMessage); resolve(code); };
    const onMessage = (event) => {
      if (event.source === opener && event.origin === win.location.origin && event.data?.type === 'pcbv:code'
        && typeof event.data.code === 'string' && CODE_RE.test(event.data.code)) finish(event.data.code);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    win.addEventListener('message', onMessage);
    try { opener.postMessage({ type: 'pcbv:code-request' }, win.location.origin); } catch { finish(null); }
  });
}

export function forgetToken(storage) {
  try { storage.removeItem(TOKEN_KEY); } catch { /* nothing to forget */ }
}

/** Remember a token the person pasted by hand (used when the app was opened without `pcbv open`). */
export function storeToken(storage, token) {
  const clean = typeof token === 'string' ? token.trim() : '';
  if (!clean || clean.length > 512) return false;
  try { storage.setItem(TOKEN_KEY, clean); } catch { /* the token then lives for this page load only */ }
  return true;
}
