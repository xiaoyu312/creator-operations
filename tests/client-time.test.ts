import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareTimestamps, shanghaiWeekStart } from '../client/src/lib/time.ts';

test('Shanghai weeks begin on Monday even while the UTC calendar is still Sunday', () => {
  for (const instant of ['2026-10-11T16:00:00Z', '2026-10-14T10:00:00Z', '2026-10-18T15:59:59Z']) {
    assert.equal(shanghaiWeekStart(new Date(instant)).toISOString(), '2026-10-11T16:00:00.000Z');
  }
  assert.equal(shanghaiWeekStart(new Date('2026-10-18T16:00:00Z')).toISOString(), '2026-10-18T16:00:00.000Z');
});

test('business timestamps sort by instant across offsets and keep missing due dates last', () => {
  const earlier = '2026-10-13T10:00:00+08:00';
  const later = '2026-10-13T03:00:00Z';
  assert.ok(compareTimestamps(earlier, later) < 0);
  assert.ok(compareTimestamps(earlier, later, 'desc') > 0);
  assert.equal(compareTimestamps(earlier, '2026-10-13T02:00:00Z'), 0);
  for (const direction of ['asc', 'desc'] as const) {
    assert.ok(compareTimestamps(null, earlier, direction) > 0);
    assert.ok(compareTimestamps(later, 'invalid', direction) < 0);
    assert.equal(compareTimestamps(null, undefined, direction), 0);
  }
});
