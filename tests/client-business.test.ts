import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isObservedInShanghaiMonth, parseNonnegativeCents, parseNonnegativeInteger, parsePositiveCents } from '../client/src/lib/business-ui.ts';

test('manual expense and offer amounts preserve every cent at safe integer boundaries', () => {
  assert.equal(parseNonnegativeCents('90071992547409.90'), 9007199254740990);
  assert.equal(parseNonnegativeCents('90071992547409.91'), Number.MAX_SAFE_INTEGER);
  assert.equal(parsePositiveCents('70368744177664.01'), 7036874417766401);
  assert.equal(parseNonnegativeCents('90071992547409.92'), null);
  assert.equal(parseNonnegativeCents('0'), 0);
  assert.equal(parsePositiveCents('0.00'), null);
  assert.equal(parsePositiveCents('1.01'), 101);
  for (const invalid of ['', '1.001', '1e4', '-1', '1,000', 'Infinity']) {
    assert.equal(parseNonnegativeCents(invalid), null);
  }
});

test('manual observation counts distinguish real zero from missing and invalid values', () => {
  assert.equal(parseNonnegativeInteger('0'), 0);
  assert.equal(parseNonnegativeInteger(''), null);
  assert.equal(parseNonnegativeInteger('-1'), null);
  assert.equal(parseNonnegativeInteger('1.1'), null);
  assert.equal(parseNonnegativeInteger('9007199254740992'), null);
});

test('target coverage uses the same snapshot cutoff as actuals and Shanghai month boundaries', () => {
  const cutoff = '2026-10-13T12:00:00+08:00';
  assert.equal(isObservedInShanghaiMonth('2026-10-30T00:00:00+08:00', '2026-10', cutoff), false);
  assert.equal(isObservedInShanghaiMonth(cutoff, '2026-10', cutoff), true);
  assert.equal(isObservedInShanghaiMonth('2026-09-30T16:00:00Z', '2026-10', cutoff), true);
  assert.equal(isObservedInShanghaiMonth('2026-09-30T15:59:59Z', '2026-10', cutoff), false);
  assert.equal(isObservedInShanghaiMonth('invalid', '2026-10', cutoff), false);
});
