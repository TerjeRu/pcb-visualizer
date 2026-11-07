// Project helpers the app needs: ids, new markers and headers, pin geometry.
// Pure, so tests run in Node.

/** Standard pin roles. `key` is the keyboard shortcut while a pin is selected. */
export const PIN_ROLES = [
  { role: 'GND',   color: '#4b5563', key: 'g' },
  { role: 'VCC',   color: '#ef4444', key: 'v' },
  { role: '3V3',   color: '#f97316', key: '3' },
  { role: '5V',    color: '#dc2626', key: '5' },
  { role: 'TX',    color: '#22c55e', key: 't' },
  { role: 'RX',    color: '#e5e7eb', key: 'r' },
  { role: 'RST',   color: '#a855f7', key: 'x' },
  { role: 'BOOT',  color: '#eab308', key: 'b' },
  { role: 'SWDIO', color: '#06b6d4', key: 'd' },
  { role: 'SWCLK', color: '#3b82f6', key: 'c' },
  { role: 'TCK',   color: '#14b8a6', key: 'k' },
  { role: 'TMS',   color: '#8b5cf6', key: 'm' },
  { role: 'TDI',   color: '#0ea5e9', key: 'i' },
  { role: 'TDO',   color: '#84cc16', key: 'o' },
  { role: 'TRST',  color: '#d946ef', key: 'j' },
  { role: 'NC',    color: '#1f2937', key: 'n' },
];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
/** Board files are untrusted: a colour reaches CSS only as #rrggbb, otherwise the caller's default applies. */
export const safeColor = (value, fallback = null) => (typeof value === 'string' && HEX_COLOR.test(value) ? value : fallback);

export const MARKER_COLORS = ['#f59e0b', '#22d3ee', '#a3e635', '#f472b6', '#818cf8', '#f87171'];

export const NUMBERING = {
  row: 'Row by row (1 2 3 / 4 5 6)',
  column: 'Column by column, IDC (1 3 5 / 2 4 6)',
  u: 'U-shape, DIP (1 2 3 / 6 5 4)',
};

export const ROTATIONS = [0, 90, 180, 270];
export const SIDES = ['front', 'back', 'detail', 'other'];
export const MAX_GRID = 64;

export function uid(prefix) {
  const rand = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 10)
    : Math.random().toString(36).slice(2, 12);
  return `${prefix}_${rand}`;
}

export const roleDef = (role) => PIN_ROLES.find((r) => r.role === role) ?? null;
export const roleForKey = (key) => PIN_ROLES.find((r) => r.key === String(key).toLowerCase()) ?? null;

export function createSchematic({ rows = 1, cols = 4, name = 'Header' } = {}) {
  return { id: uid('sch'), kind: 'header', name, rows, cols, pitch: 2.54, numbering: 'row', rotation: 0, notes: '', pins: [] };
}

/** A box marker and its new header, as one marker/added event. A wide box gets a 1 x 4 header, a tall one 4 x 1. */
export function newMarkerEvent({ assetId, rect, label, colorIndex = 0 }) {
  const tall = rect.h > rect.w;
  const schematic = createSchematic({ rows: tall ? 4 : 1, cols: tall ? 1 : 4, name: label || 'Header' });
  const marker = {
    id: uid('mk'), assetId, schematicId: schematic.id, shape: 'box', label: label || '',
    color: MARKER_COLORS[colorIndex % MARKER_COLORS.length],
    x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h),
  };
  return { type: 'marker/added', marker, schematic };
}

export const pinCount = (sch) => Math.max(0, (sch.rows | 0) * (sch.cols | 0));
export const getPin = (sch, index) => (sch.pins ?? []).find((p) => p.index === index) ?? null;

/** Pin index (1-based) to its grid cell before rotation. */
export function indexToCell(sch, index) {
  const { rows, cols } = sch;
  const i = index - 1;
  switch (sch.numbering) {
    case 'column':
      return { row: i % rows, col: Math.floor(i / rows) };
    case 'u':
      if (rows === 2) return i < cols ? { row: 0, col: i } : { row: 1, col: cols - 1 - (i - cols) };
      if (cols === 2) return i < rows ? { row: i, col: 0 } : { row: rows - 1 - (i - rows), col: 1 };
      return { row: Math.floor(i / cols), col: i % cols };
    case 'row':
    default:
      return { row: Math.floor(i / cols), col: i % cols };
  }
}

/** Where each pin is drawn after numbering and rotation, in grid units. */
export function pinLayout(sch) {
  const { rows, cols } = sch;
  const rot = (((sch.rotation || 0) % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const pins = [];
  for (let index = 1; index <= pinCount(sch); index++) {
    const { row, col } = indexToCell(sch, index);
    let x, y;
    switch (rot) {
      case 90: x = rows - 1 - row; y = col; break;
      case 180: x = cols - 1 - col; y = rows - 1 - row; break;
      case 270: x = row; y = cols - 1 - col; break;
      default: x = col; y = row;
    }
    pins.push({ index, x, y });
  }
  return { width: swap ? rows : cols, height: swap ? cols : rows, pins };
}

/** Normalise a drag from (x1, y1) to (x2, y2) into a box clamped to the image. Null when too small to mean anything. */
export function dragRect(x1, y1, x2, y2, width, height, min = 6) {
  const clamp = (v, hi) => Math.min(Math.max(v, 0), hi);
  const ax = clamp(x1, width), bx = clamp(x2, width), ay = clamp(y1, height), by = clamp(y2, height);
  const rect = { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
  return rect.w >= min && rect.h >= min ? rect : null;
}

/** Move a box by (dx, dy) without leaving the image. */
export function movedRect(marker, dx, dy, width, height) {
  const w = marker.w ?? 0, h = marker.h ?? 0;
  return {
    x: Math.round(Math.min(Math.max(marker.x + dx, 0), Math.max(width - w, 0))),
    y: Math.round(Math.min(Math.max(marker.y + dy, 0), Math.max(height - h, 0))),
  };
}

/** Move a callout's dot and label together by (dx, dy), as far as both stay inside the image. */
export function nudgedCallout(c, dx, dy, width, height) {
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(hi, lo));
  const mx = clamp(dx, -Math.min(c.x, c.lx), width - Math.max(c.x, c.lx));
  const my = clamp(dy, -Math.min(c.y, c.ly), height - Math.max(c.y, c.ly));
  return { x: Math.round(c.x + mx), y: Math.round(c.y + my), lx: Math.round(c.lx + mx), ly: Math.round(c.ly + my) };
}

/**
 * True when a callout label grows to the left of its anchor `lx`: a label left of its dot does, unless
 * it would leave the photo and fits on the other side. A turned photo can put a label at either edge.
 */
export function growsLeft(lx, x, width, photoWidth) {
  const left = lx < x;
  if (left && lx - width < 0 && lx + width <= photoWidth) return false;
  if (!left && lx + width > photoWidth && lx - width >= 0) return true;
  return left;
}

export const RESIZE_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * Drag a handle of a box by (dx, dy). The box stays inside the image and keeps at least `min` pixels on
 * each side. A handle that passes the opposite edge stops there; the box does not flip.
 */
export function resizedRect(origin, handle, dx, dy, width, height, min = 6) {
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(hi, lo));
  let left = origin.x, top = origin.y, right = origin.x + origin.w, bottom = origin.y + origin.h;
  if (handle.includes('w')) left = clamp(left + dx, 0, right - min);
  if (handle.includes('e')) right = clamp(right + dx, left + min, width);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - min);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + min, height);
  const x = Math.round(left), y = Math.round(top);
  return { x, y, w: Math.round(right) - x, h: Math.round(bottom) - y };
}

/**
 * A new callout at (x, y): the label goes up and to the right, or the other way near the photo's edges.
 * The label stays inside the photo on all four sides; a photo too small to flip into gets it clamped.
 */
export function newCalloutEvent({ assetId, x, y, width, height = Infinity, unit = 1 }) {
  const dx = 70 * unit, dy = 50 * unit, margin = 60 * unit, room = 110 * unit, half = 14 * unit;
  const flippedX = x + dx > width - margin ? x - dx : x + dx;
  const flippedY = y - dy < margin ? y + dy : y - dy;
  // The label box grows right of lx when lx is right of the dot, left of it otherwise.
  const lx = flippedX >= x ? Math.min(flippedX, Math.max(width - room, 0)) : Math.max(flippedX, Math.min(room, width));
  const ly = Math.min(Math.max(flippedY, half), Math.max(height - half, half));
  const round = (v) => Math.round(v);
  return {
    type: 'annotation/added',
    annotation: { id: uid('an'), assetId, x: round(x), y: round(y), lx: round(lx), ly: round(ly), text: '', wiki: '' },
  };
}

export const clampPoint = (x, y, width, height) => ({
  x: Math.round(Math.min(Math.max(x, 0), width)),
  y: Math.round(Math.min(Math.max(y, 0), height)),
});
