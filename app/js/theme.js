// Runs before the page is drawn, as a classic script in <head>. data-theme is always the resolved
// theme, light or dark, so the stylesheet defines the dark tokens once; data-theme-setting keeps what
// the person chose (system, light or dark). A dark window does not flash light while the saved
// setting loads from the service.
{
  const root = document.documentElement;
  const query = window.matchMedia?.('(prefers-color-scheme: dark)');
  const apply = (setting) => {
    root.dataset.themeSetting = setting;
    root.dataset.theme = setting === 'system' ? (query?.matches ? 'dark' : 'light') : setting;
  };
  let saved = 'system';
  try {
    const stored = window.localStorage.getItem('pcbv-theme');
    if (stored === 'light' || stored === 'dark') saved = stored;
  } catch { /* storage blocked: the setting from the service applies a moment later */ }
  apply(saved);
  query?.addEventListener?.('change', () => { if (root.dataset.themeSetting === 'system') apply('system'); });
}
