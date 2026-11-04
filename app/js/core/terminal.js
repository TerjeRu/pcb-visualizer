// Turns a serial byte stream (already decoded to text) into display lines, the way a simple terminal
// would: \n starts a line, \r returns to its start, \b steps back (the U-Boot countdown rewrites its
// digit this way), and colour and cursor escape codes are dropped. Pure, so tests run in Node.

// eslint-disable-next-line no-control-regex -- matching escape codes is the point
const ESCAPE = /\x1b(\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[@-Z\\-_])/g;
const MAX_LINES = 5000;

/** What a finished line is, for highlighting. Returns a short kind or ''. */
export function classifyLine(line) {
  if (/^U-Boot \d{4}\.\d{2}/.test(line) || /^CFE version/i.test(line)) return 'bootloader';
  if (/Hit any key to stop autoboot|Press any key|autoboot in \d/i.test(line)) return 'autoboot';
  if (/^\s*=>\s*$/.test(line) || /^[\w@:/~.-]+(\s[\w@:/~.-]+)?\s?[#>$]\s*$/.test(line)) return 'prompt';
  if (/\blogin:\s*$/i.test(line) || /Please press Enter to activate this console/i.test(line)) return 'login';
  if (/^\[\s*\d+\.\d+\]\s/.test(line)) return 'kernel';
  if (/\b(error|fail(ed)?|panic|oops)\b/i.test(line)) return 'error';
  return '';
}

export function createScreen(maxLines = MAX_LINES) {
  const lines = [''];
  let col = 0;
  let pendingEscape = '';      // an escape sequence split across two chunks
  let dropped = 0;             // lines removed from the top to stay under maxLines

  function put(ch) {
    const i = lines.length - 1;
    const line = lines[i];
    lines[i] = line.slice(0, col) + ch + line.slice(col + 1);
    col += 1;
  }

  return {
    /** Add decoded text. Returns the index of the first line that changed. */
    write(text) {
      let input = pendingEscape + String(text ?? '');
      pendingEscape = '';
      const lastEsc = input.lastIndexOf('\x1b');
      if (lastEsc !== -1 && !/[@-~]/.test(input.slice(lastEsc + 2)) && input.length - lastEsc < 32) {
        pendingEscape = input.slice(lastEsc);
        input = input.slice(0, lastEsc);
      }
      input = input.replace(ESCAPE, '');
      const firstChanged = lines.length - 1 + dropped;
      for (const ch of input) {
        if (ch === '\n') { lines.push(''); col = 0; }
        else if (ch === '\r') col = 0;
        else if (ch === '\b') col = Math.max(0, col - 1);
        else if (ch === '\t') { const stop = (Math.floor(col / 8) + 1) * 8; while (col < stop) put(' '); }
        else if (ch >= ' ' || ch > '\x7f') put(ch);
        // other control characters (bell, NUL) are ignored
      }
      if (lines.length > maxLines) {
        const cut = lines.length - maxLines;
        lines.splice(0, cut);
        dropped += cut;
      }
      return firstChanged;
    },
    /** All lines, oldest first. The last one is the line being written. */
    lines: () => lines,
    /** Absolute index of lines[0], counting lines dropped from the top. */
    offset: () => dropped,
    clear() { lines.splice(0, lines.length, ''); col = 0; pendingEscape = ''; dropped = 0; },
    text: () => lines.join('\n'),
  };
}
