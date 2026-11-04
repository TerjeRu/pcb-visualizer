import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dragRect, indexToCell, movedRect, newMarkerEvent, pinLayout, roleForKey } from '../js/core/schema.js';

test('pin numbering schemes map to the right cells', () => {
  const idc = { rows: 2, cols: 5, numbering: 'column' };
  assert.deepEqual([1, 2, 3, 10].map((i) => indexToCell(idc, i)), [{ row: 0, col: 0 }, { row: 1, col: 0 }, { row: 0, col: 1 }, { row: 1, col: 4 }]);
  const dip = { rows: 2, cols: 4, numbering: 'u' };
  assert.deepEqual([1, 4, 5, 8].map((i) => indexToCell(dip, i)), [{ row: 0, col: 0 }, { row: 0, col: 3 }, { row: 1, col: 3 }, { row: 1, col: 0 }]);
  assert.deepEqual(indexToCell({ rows: 1, cols: 4, numbering: 'row' }, 3), { row: 0, col: 2 });
});

test('rotation swaps the drawn grid and reverses order where it should', () => {
  const sch = { rows: 1, cols: 4, numbering: 'row', rotation: 90 };
  const layout = pinLayout(sch);
  assert.equal(layout.width, 1);
  assert.equal(layout.height, 4);
  assert.deepEqual(layout.pins.map((p) => p.y), [0, 1, 2, 3]);
  assert.deepEqual(pinLayout({ ...sch, rotation: 180 }).pins.map((p) => p.x), [3, 2, 1, 0]);
});

test('a drag becomes a box clamped to the image, and tiny drags are ignored', () => {
  assert.deepEqual(dragRect(50, 40, 10, 10, 100, 100), { x: 10, y: 10, w: 40, h: 30 });
  assert.deepEqual(dragRect(-20, 90, 30, 150, 100, 100), { x: 0, y: 90, w: 30, h: 10 });
  assert.equal(dragRect(10, 10, 12, 30, 100, 100), null);
});

test('moving a box keeps it on the image', () => {
  const m = { x: 10, y: 10, w: 20, h: 20 };
  assert.deepEqual(movedRect(m, 5.4, -3.6, 100, 100), { x: 15, y: 6 });
  assert.deepEqual(movedRect(m, -50, 500, 100, 100), { x: 0, y: 80 });
});

test('a new marker carries a header shaped like the box', () => {
  const wide = newMarkerEvent({ assetId: 'img_1', rect: { x: 1.4, y: 2.6, w: 80, h: 20 } });
  assert.equal(wide.type, 'marker/added');
  assert.equal(wide.marker.schematicId, wide.schematic.id);
  assert.deepEqual([wide.schematic.rows, wide.schematic.cols], [1, 4]);
  assert.deepEqual([wide.marker.x, wide.marker.y], [1, 3]);
  const tall = newMarkerEvent({ assetId: 'img_1', rect: { x: 0, y: 0, w: 20, h: 80 }, colorIndex: 7 });
  assert.deepEqual([tall.schematic.rows, tall.schematic.cols], [4, 1]);
  assert.ok(tall.marker.color.startsWith('#'));
});

test('role shortcuts', () => {
  assert.equal(roleForKey('t').role, 'TX');
  assert.equal(roleForKey('G').role, 'GND');
  assert.equal(roleForKey('q'), null);
});

test('a new callout puts its label away from the photo edges', async () => {
  const { newCalloutEvent, clampPoint } = await import('../js/core/schema.js');
  const middle = newCalloutEvent({ assetId: 'img_1', x: 500, y: 500, width: 1000, height: 1000 }).annotation;
  assert.ok(middle.lx > middle.x && middle.ly < middle.y, 'up and to the right by default');
  assert.equal(middle.text, '');
  const corner = newCalloutEvent({ assetId: 'img_1', x: 990, y: 5, width: 1000, height: 1000 }).annotation;
  assert.ok(corner.lx < corner.x && corner.ly > corner.y, 'flipped near the top right corner');
  assert.deepEqual(clampPoint(-5, 1200.6, 1000, 1000), { x: 0, y: 1000 });
});

test('a new callout keeps its label inside the photo on all four sides', async () => {
  const { newCalloutEvent } = await import('../js/core/schema.js');
  const inside = (width, height, x, y, unit = 1) => {
    const { annotation: a } = newCalloutEvent({ assetId: 'img', x, y, width, height, unit });
    const room = 110 * unit, half = 14 * unit;
    const [from, to] = a.lx >= a.x ? [a.lx, a.lx + room] : [a.lx - room, a.lx];
    return from >= 0 && to <= width && a.ly - half >= 0 && a.ly + half <= height;
  };
  for (const [x, y] of [[10, 10], [990, 10], [10, 490], [990, 490], [500, 5], [500, 495], [5, 250], [995, 250], [500, 250]]) {
    assert.ok(inside(1000, 500, x, y), `inside at ${x},${y}`);
  }
  assert.ok(inside(1000, 120, 500, 100), 'a short photo clamps instead of placing the label below it');
  assert.ok(inside(1000, 500, 990, 495, 4), 'zoomed out, with a larger unit');
  const tiny = newCalloutEvent({ assetId: 'img', x: 40, y: 30, width: 80, height: 60 }).annotation;
  assert.ok(tiny.lx >= 0 && tiny.lx <= 80 && tiny.ly >= 0 && tiny.ly <= 60, 'too small to flip: clamped to the photo');
});

test('safeColor passes #rrggbb only', async () => {
  const { safeColor } = await import('../js/core/schema.js');
  assert.equal(safeColor('#a1B2c3'), '#a1B2c3');
  for (const bad of ['red', '#fff', '#12345g', '#1234567', 'url(x)', '', null, 7]) assert.equal(safeColor(bad, 'fallback'), 'fallback');
  assert.equal(safeColor('nope'), null);
});
