import assert from 'node:assert/strict';
import test from 'node:test';
import { generateDemo, SYNTHETIC_SEED } from '../examples/generate-demo.ts';

test('synthetic generator is fixed, isolated, and contains no actual contacts', () => {
  const first = generateDemo();
  const second = generateDemo();
  assert.deepEqual(first, second);
  assert.equal(first.seed, SYNTHETIC_SEED);
  assert.equal(first.state.dataMode, 'demo');
  assert.ok(first.state.creators.every((creator) => creator.contact === null && creator.name.startsWith('虚构达人')));
  assert.ok(first.state.orders.length === 0);
  first.state.creators[0].name = 'changed in this test only';
  assert.notEqual(first.state.creators[0].name, generateDemo().state.creators[0].name);
});
