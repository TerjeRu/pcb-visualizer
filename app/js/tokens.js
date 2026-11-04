// Reads theme tokens (CSS custom properties) for code that paints outside CSS: the terminal and the
// logic waveform. A token that is not set is left out of the result; app.css defines every one asked for.

export function readTokens(win, element, names) {
  const style = win?.getComputedStyle?.(element);
  const found = {};
  for (const name of names) {
    const value = style?.getPropertyValue(name).trim();
    if (value) found[name] = value;
  }
  return found;
}
