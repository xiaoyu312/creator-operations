import assert from 'node:assert/strict';
import { emptyState, normalizeCreator, mergeCreators, createDrafts } from '../extensions/creator-assistant/lib/core.mjs';

const fixedTime = '2026-10-20T00:00:00.000Z';
const candidates = [1, 2].map(number => normalizeCreator({
  platform: 'douyin', externalId: `SYNTHETIC-CREATOR-${number}`,
  name: `虚构达人 ${number}`, capturedAt: fixedTime, updatedAt: fixedTime,
  contact: {}, owner: '演示成员', stage: '未跟进',
}));
const state = emptyState();
state.creators = mergeCreators(state.creators, candidates).creators;
const drafts = createDrafts(state.creators, state.creators.map(row => row.id), '你好，{name}，这是一条不会发送的演示草稿。', []);
assert.equal(drafts.length, 2);
assert.equal(new Set(state.creators.map(row => row.id)).size, 2);
console.log(JSON.stringify({
  mode: 'synthetic-only', creators: state.creators.length, unsentDrafts: drafts.length,
  network: 'none', browser: 'not opened', persisted: false,
}, null, 2));
