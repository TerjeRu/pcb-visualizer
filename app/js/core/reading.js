// Multimeter readings as the person types them. Gives the same results as `parse_reading` and
// `reading_event` in service/src/pcbv/edits.py; service/tests/fixtures/readings.json holds the shared cases.

// Python's str.isspace set, which `strip()` and `\s` use there. JavaScript's own set differs (it has the BOM, and lacks \x1c to \x1f and \x85).
const SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const READING = new RegExp(`^[${SPACE}]*(-?\\p{Nd}+(?:[.,]\\p{Nd}+)?)[${SPACE}]*(mv|v|kohm|kω|k|mohm|mω|ohm|ohms|ω|r)?[${SPACE}]*$`, 'iu');
const EDGES = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, 'g');
const SCALE = {
  mv: ['V', 0.001, 'dc'], v: ['V', 1, 'dc'],
  k: ['Ω', 1e3, 'ohm'], kohm: ['Ω', 1e3, 'ohm'], 'kω': ['Ω', 1e3, 'ohm'],
  mohm: ['Ω', 1e6, 'ohm'], 'mω': ['Ω', 1e6, 'ohm'],
  ohm: ['Ω', 1, 'ohm'], ohms: ['Ω', 1, 'ohm'], 'ω': ['Ω', 1, 'ohm'], r: ['Ω', 1, 'ohm'],
};

export const MAX_READING = 40;

const NOT_PRINTABLE = /[\p{C}\p{Z}]/u;

function escaped(code) {
  if (code === 0x20) return ' ';
  if (code < 0x100) return `\\x${code.toString(16).padStart(2, '0')}`;
  if (code < 0x10000) return `\\u${code.toString(16).padStart(4, '0')}`;
  return `\\U${code.toString(16).padStart(8, '0')}`;
}

/** Python's `repr` of a string, which the CLI puts in its message. */
function pyRepr(text) {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0);
    if (char === '\\' || char === quote) out += `\\${char}`;
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (NOT_PRINTABLE.test(char)) out += escaped(code);
    else out += char;
  }
  return `${quote}${out}${quote}`;
}

/** Python's `round(x, 6)`: the exact value is rounded, and an exact tie goes to the even digit. */
function round6(x) {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e15) return x;
  const exact = Math.abs(x).toFixed(100);
  const [whole, fraction] = exact.split('.');
  const tail = fraction.slice(6);
  const tie = /^50*$/.test(tail);
  let scaled = BigInt(whole + fraction.slice(0, 6));
  if (tail[0] > '5' || (tail[0] === '5' && (!tie || scaled % 2n === 1n))) scaled += 1n;
  const rounded = Number(`${scaled / 1000000n}.${String(scaled % 1000000n).padStart(6, '0')}`);
  return x < 0 || Object.is(x, -0) ? -rounded : rounded;
}

/** Python's `format(x, 'g')`: six significant digits, no trailing zeros, an exponent below 1e-4 and from 1e6. */
function formatG(x) {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x < 0 ? '-inf' : 'inf';
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  const sign = x < 0 ? '-' : '';
  const magnitude = Math.abs(x);
  const digits = magnitude.toExponential(100).split('e');
  let [lead, exponent] = [digits[0].replace('.', ''), Number(digits[1])];
  const tail = lead.slice(6);
  const tie = /^50*$/.test(tail);
  let kept = BigInt(lead.slice(0, 6));
  if (tail[0] > '5' || (tail[0] === '5' && (!tie || kept % 2n === 1n))) kept += 1n;
  if (kept === 1000000n) { kept = 100000n; exponent += 1; }
  const mantissa = String(kept);
  if (exponent < -4 || exponent >= 6) {
    const frac = mantissa.slice(1).replace(/0+$/, '');
    const exp = `${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
    return `${sign}${mantissa[0]}${frac ? `.${frac}` : ''}e${exp}`;
  }
  const point = exponent + 1;
  if (point >= mantissa.length) return `${sign}${mantissa.padEnd(point, '0')}`;
  const full = point <= 0 ? `0.${'0'.repeat(-point)}${mantissa}` : `${mantissa.slice(0, point)}.${mantissa.slice(point)}`;
  return `${sign}${full.replace(/0+$/, '').replace(/\.$/, '')}`;
}

function ohms(value) {
  if (value >= 1e6) return `${formatG(value / 1e6)} MΩ`;
  if (value >= 1e3) return `${formatG(value / 1e3)} kΩ`;
  return `${formatG(value)} Ω`;
}

/** Python's float() reads any Unicode decimal digit. Each run of such digits starts at a zero and has ten per set. */
function asciiDigits(text) {
  return text.replace(/\p{Nd}/gu, (char) => {
    let zero = char.codePointAt(0);
    while (/\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero -= 1;
    return String((char.codePointAt(0) - zero) % 10);
  });
}

/** '3.29V', '330 mV', '0.3ohm', '4.7k', 'OL' or 'beep' to `{mode, value, unit, text}`. Throws an Error with the CLI's message. */
export function parseReading(text) {
  const raw = String(text).replace(EDGES, '');
  const lowered = raw.toLowerCase();
  if (['ol', 'open', 'o.l.'].includes(lowered)) return { mode: 'ohm', value: null, unit: 'Ω', text: 'OL' };
  if (['beep', 'short', 'continuity'].includes(lowered)) return { mode: 'continuity', value: 0, unit: 'Ω', text: 'beep' };
  const match = READING.exec(raw);
  if (!match) throw new Error(`cannot read ${pyRepr(String(text))}; write it like 3.29V, 330mV, 0.3ohm, 4.7k, OL or beep`);
  const [unit, factor, mode] = SCALE[(match[2] || 'v').toLowerCase()];
  const value = round6(Number(asciiDigits(match[1]).replace(',', '.')) * factor);
  if (!Number.isFinite(value)) throw new Error('the number is too large; write it like 3.29V, 330mV, 0.3ohm, 4.7k, OL or beep');
  if (mode === 'ohm' && match[1].startsWith('-')) throw new Error('a resistance cannot be negative; write it like 0.3ohm or 4.7k');
  return { mode, value, unit, text: unit === 'V' ? `${formatG(value)} V` : ohms(value) };
}

/** What `reading_event` does with the parsed reading: the power state, the warnings and the event's reading. */
export function readingFor(text, powered, ts) {
  const parsed = parseReading(text);
  const on = powered ?? parsed.mode === 'dc';
  const warnings = [];
  if (parsed.mode !== 'dc' && on) {
    warnings.push('resistance and continuity are measured with the board unplugged; on a powered board the reading is meaningless and the meter can be damaged');
  }
  if (parsed.mode === 'dc' && !on) warnings.push('a voltage on an unpowered board usually means a capacitor still holds charge');
  return { reading: { ts, ...parsed, powered: on, source: 'app' }, warnings };
}
