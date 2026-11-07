import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseReading, readingFor } from '../js/core/reading.js';

const fixture = JSON.parse(readFileSync(new URL('../../service/tests/fixtures/readings.json', import.meta.url), 'utf8'));

test('the fixture has the cases the parity needs', () => {
  assert.ok(fixture.parse.length >= 30);
  assert.ok(fixture.parse.some((c) => c.error) && fixture.parse.some((c) => c.expect));
});

for (const c of fixture.parse) {
  test(`parseReading(${JSON.stringify(c.input)}) matches the service parser`, () => {
    if (c.error) assert.throws(() => parseReading(c.input), { message: c.error });
    else assert.deepEqual(parseReading(c.input), c.expect);
  });
}

for (const c of fixture.events) {
  test(`readingFor(${JSON.stringify(c.input)}, ${c.powered}) matches the service`, () => {
    const { reading, warnings } = readingFor(c.input, c.powered, '2026-11-06T10:00:00Z');
    assert.deepEqual({ powered: reading.powered, warnings }, c.expect);
  });
}

test('a reading has the shape of the one pcbv measure writes, with source app', () => {
  const { reading } = readingFor('3.31V', undefined, '2026-11-06T10:00:00Z');
  assert.deepEqual(reading, { ts: '2026-11-06T10:00:00Z', mode: 'dc', value: 3.31, unit: 'V', text: '3.31 V', powered: true, source: 'app' });
});

test('a number too large for a float is refused with the service message, and does not hang', () => {
  const message = 'the number is too large; write it like 3.29V, 330mV, 0.3ohm, 4.7k, OL or beep';
  assert.throws(() => parseReading(`${'9'.repeat(320)}V`), { message });
  assert.throws(() => parseReading(`-${'9'.repeat(320)}k`), { message });
});
