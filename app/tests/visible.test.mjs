import { test } from 'node:test';
import assert from 'node:assert/strict';

import { showInvisible } from '../js/core/visible.js';

test('controls, bidi overrides, zero-width marks and line breaks show as code points', () => {
  assert.equal(showInvisible('printenv‮'), 'printenv\\u202E');
  assert.equal(showInvisible('a​b c\nd\u0007'), 'a\\u200Bb\\u2028c\\u000Ad\\u0007');
  assert.equal(showInvisible('x\u{E0041}'), 'x\\u{E0041}');
});

test('ordinary text, accents and emoji are left alone', () => {
  assert.equal(showInvisible('ls -l /dev/mtd0 é ✓ 😀'), 'ls -l /dev/mtd0 é ✓ 😀');
  assert.equal(showInvisible(undefined), '');
  assert.equal(showInvisible(5), '5');
});
