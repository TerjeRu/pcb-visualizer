// Pure text edits for the Notes panel. Each function takes the text and the selection and returns an
// edit { from, to, text, select: [start, end] }: replace value[from..to] with `text` and select the range
// (in the new value). The panel applies it with setRangeText, so the browser keeps its own undo. No DOM.

export const NOTES_LIMIT = 100_000;
export const COUNTER_FROM = 90_000;

const pad = (n) => String(n).padStart(2, '0');
const BULLET = /^- /;
const CHECK = /^- \[[ xX]\] /;
const TASK_LINE = /^\s*(?:[-*]|\d+[.)])\s+\[([ xX])\](?:\s|$)/;

/** The whole lines a selection touches: a selection that ends at the start of a line does not touch it. */
function lineBlock(value, start, end) {
  const from = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const found = value.indexOf('\n', last);
  return { from, to: found === -1 ? value.length : found };
}

/** Rewrite every line of the selection. A cursor keeps its place in the line; a range selects the result. */
function mapLines(value, start, end, change) {
  const { from, to } = lineBlock(value, start, end);
  const lines = value.slice(from, to).split('\n');
  const many = lines.length > 1;
  const next = change(lines, many);
  const text = next.join('\n');
  if (start !== end) return { from, to, text, select: [from, from + text.length] };
  const cursor = Math.max(from, start + next[0].length - lines[0].length);
  return { from, to, text, select: [cursor, cursor] };
}

/** `## ` at the start of the current line, or none when it is there. */
export function heading(value, start) {
  return mapLines(value, start, start, ([line]) => [line.startsWith('## ') ? line.slice(3) : `## ${line}`]);
}

export function bold(value, start, end) {
  const picked = value.slice(start, end);
  if (!picked) return { from: start, to: end, text: '****', select: [start + 2, start + 2] };
  return { from: start, to: end, text: `**${picked}**`, select: [start + 2, start + 2 + picked.length] };
}

/** `- ` before each selected line; when every line has it, take it away (with a checkbox that follows it). */
export function list(value, start, end) {
  return mapLines(value, start, end, (lines, many) => {
    const used = lines.filter((line) => !many || line.trim());
    if (used.every((line) => BULLET.test(line))) return lines.map((line) => line.replace(CHECK, '').replace(BULLET, ''));
    return lines.map((line) => (many && !line.trim() ? line : BULLET.test(line) ? line : `- ${line}`));
  });
}

/** `- [ ] ` before each selected line; when every line has a checkbox, take it away. */
export function checklist(value, start, end) {
  return mapLines(value, start, end, (lines, many) => {
    const used = lines.filter((line) => !many || line.trim());
    if (used.every((line) => CHECK.test(line))) return lines.map((line) => line.replace(CHECK, ''));
    return lines.map((line) => {
      if (many && !line.trim()) return line;
      if (CHECK.test(line)) return line;
      return BULLET.test(line) ? `- [ ] ${line.slice(2)}` : `- [ ] ${line}`;
    });
  });
}

/** Backticks round a selection on one line; a fenced block round a longer one. */
export function code(value, start, end) {
  const picked = value.slice(start, end);
  if (!picked.includes('\n')) return { from: start, to: end, text: `\`${picked}\``, select: [start + 1, start + 1 + picked.length] };
  const before = start > 0 && value[start - 1] !== '\n' ? '\n' : '';
  const after = end < value.length && value[end] !== '\n' ? '\n' : '';
  const text = `${before}\`\`\`\n${picked.replace(/\n$/, '')}\n\`\`\`${after}`;
  return { from: start, to: end, text, select: [start + before.length + 4, start + before.length + 4 + picked.replace(/\n$/, '').length] };
}

/** `[selection](https://)` with the address selected, ready to be typed over. */
export function link(value, start, end) {
  const picked = value.slice(start, end);
  const text = `[${picked}](https://)`;
  if (!picked) return { from: start, to: end, text, select: [start + 1, start + 1] };
  const at = start + picked.length + 3;
  return { from: start, to: end, text, select: [at, at + 'https://'.length] };
}

/** The local time in the form `pcbv note` writes: 2026-11-05 18:16. */
export function stamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A new `- 2026-11-05 18:16 ` line at the end, on its own line, with the cursor after it. */
export function datedEntry(value, date) {
  const lead = value && !value.endsWith('\n') ? '\n' : '';
  const text = `${lead}- ${stamp(date)} `;
  const end = value.length + text.length;
  return { from: value.length, to: value.length, text, select: [end, end] };
}

/** The edit that flips the `index`th task item ([ ] or [x]), counted as core/markdown.js counts them. Null when there is none. */
export function toggleTask(value, index) {
  let offset = 0;
  let fenced = false;
  let seen = 0;
  for (const raw of value.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (/^```/.test(line)) fenced = !fenced;
    else if (!fenced) {
      const task = TASK_LINE.exec(line);
      if (task && seen++ === index) {
        const at = offset + line.indexOf('[') + 1;
        return { from: at, to: at + 1, text: task[1] === ' ' ? 'x' : ' ', select: null };
      }
    }
    offset += raw.length + 1;
  }
  return null;
}

/** "92,000 of 100,000 characters" from 90,000 characters, else an empty string. */
export function counterText(length) {
  if (length < COUNTER_FROM) return '';
  const group = (n) => n.toLocaleString('en-US');
  return `${group(length)} of ${group(NOTES_LIMIT)} characters`;
}

/** The first non-empty line of the notes, for the Board card. */
export function firstLine(value) {
  return String(value ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}
