import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyLine, createScreen } from '../js/core/terminal.js';

test('newlines, carriage returns and backspaces behave like a terminal', () => {
  const s = createScreen();
  // exactly what U-Boot sends: "%2d " first, then "\b\b\b%2d " every second
  s.write('U-Boot 2015.07\r\nHit any key to stop autoboot:  3 ');
  s.write('\b\b\b 2 ');
  s.write('\b\b\b 1 ');
  assert.deepEqual(s.lines(), ['U-Boot 2015.07', 'Hit any key to stop autoboot:  1 ']);
  s.write('\r\nprogress 10%\rprogress 99%\n');
  assert.deepEqual(s.lines().slice(-2), ['progress 99%', '']);
});

test('colour and cursor escape codes are dropped, even split across chunks', () => {
  const s = createScreen();
  s.write('\x1b[1;32mgreen\x1b[0m and \x1b[');
  s.write('31mred\x1b]0;title\x07!');
  assert.equal(s.lines()[0], 'green and red!');
});

test('the buffer keeps the newest lines and reports the offset', () => {
  const s = createScreen(3);
  s.write('a\nb\nc\nd\ne');
  assert.deepEqual(s.lines(), ['c', 'd', 'e']);
  assert.equal(s.offset(), 2);
});

test('lines worth highlighting', () => {
  assert.equal(classifyLine('U-Boot 2015.07-ARC (Mar 14 2019 - 10:21:07 +0000)'), 'bootloader');
  assert.equal(classifyLine('Hit any key to stop autoboot:  2'), 'autoboot');
  assert.equal(classifyLine('ARC7621 # '), 'prompt');
  assert.equal(classifyLine('=> '), 'prompt');
  assert.equal(classifyLine('root@ARC-DEMO:/# '), 'prompt');
  assert.equal(classifyLine('OpenWrt login: '), 'login');
  assert.equal(classifyLine('[    0.410000] Serial: 8250/16550 driver'), 'kernel');
  assert.equal(classifyLine('Kernel panic - not syncing'), 'error');
  assert.equal(classifyLine('DRAM:  128 MiB'), '');
});
