// Links to other sites in the desktop shell. A click on one in the app does nothing there (the shell
// refuses to navigate away from the service), so the shell opens it in the system browser through its
// `open_link` command, after asking with the full address. In a plain browser there is no opener and
// links behave as usual.

/** `win` supplies `__TAURI__`, `confirm` and `alert`. Returns `undefined` outside the desktop shell. */
export function createLinkOpener(win, { question = 'This link goes to:', report = (message) => win.alert(message) } = {}) {
  const invoke = win?.__TAURI__?.core?.invoke;
  if (!invoke) return undefined;
  return async (href) => {
    if (!win.confirm(`${question}\n\n${href}\n\nOpen it in your browser?`)) return false;
    try {
      await invoke('open_link', { url: href });
      return true;
    } catch (error) {
      report(String(error?.message ?? error));
      return false;
    }
  };
}
