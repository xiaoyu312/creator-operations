import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHomeProductRanking } from '../client/src/lib/home-overview.ts';

test('home product ranking aggregates scoped paid lines and preserves unknown amounts', () => {
  const result = buildHomeProductRanking([
    { productId: 'cream', paidAmountCents: 12900 },
    { productId: 'cream', paidAmountCents: null },
    { productId: 'serum', paidAmountCents: 6800 },
  ], [
    { id: 'cream', name: '面霜' },
    { id: 'serum', name: '精华' },
  ]);

  assert.deepEqual(result.rows, [
    { id: 'cream', name: '面霜', count: 2, knownCents: 12900, unknownAmountCount: 1 },
    { id: 'serum', name: '精华', count: 1, knownCents: 6800, unknownAmountCount: 0 },
  ]);
  assert.equal(result.unmatchedLineCount, 0);
});

test('home product ranking keeps missing product matches outside the ranked product totals', () => {
  const result = buildHomeProductRanking([
    { productId: null, paidAmountCents: 5000 },
    { productId: 'unavailable-product', paidAmountCents: 9000 },
    { productId: 'cream', paidAmountCents: 12900 },
  ], [{ id: 'cream', name: '面霜' }]);

  assert.deepEqual(result.rows, [
    { id: 'cream', name: '面霜', count: 1, knownCents: 12900, unknownAmountCount: 0 },
  ]);
  assert.equal(result.unmatchedLineCount, 2);
});
