import test from 'node:test';
import assert from 'node:assert/strict';
import { createInviteController } from '../lib/invite-controller.mjs';
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 1)); } throw new Error('Timed out waiting for test transition'); }
function harness(options = {}) {
  let clock = Date.now();
  const local = {}, session = {}, sends = [], alarms = [], diagnostics = [];
  const store = disk => ({ get: async key => ({ [key]: structuredClone(disk[key]) }), set: async data => { if (disk === local && options.beforeLocalWrite) options.beforeLocalWrite(data); if (disk === local && options.failLocalWrites) { if (options.failLocalWrites !== Infinity) options.failLocalWrites--; throw new Error('Synthetic disk write failure'); } Object.assign(disk, structuredClone(data)); }, setAccessLevel: async () => {} });
  const chromeApi = { storage: { local: store(local), session: store(session) }, tabs: { get: async id => { if (options.tabGate) await options.tabGate(); return { id, title: '合成平台', url: 'https://buyin.jinritemai.com/dashboard/' }; } }, alarms: { create: async (name, value) => { if (options.failAlarmCreate) throw new Error('synthetic alarm failure'); alarms.push({ name, ...value }); }, clear: async () => true } };
  const template = { ready: true, platform: 'douyin', flowVersion: 2, contextId: 'context-fixture', templateId: 'template-fixture', expiresAt: new Date(Date.now() + 24 * 60 * 60000).toISOString(), referenceRecipientId: '', summary: { message: '合成测试邀约', productIds: ['sku-fixture'], cardVersion: 'words', contactName: '', phoneMasked: '***', wechatMasked: '***' } };
  const creators = ['a', 'b'].map(id => ({ id: 'douyin:' + id, platform: 'douyin', externalId: id, name: '合成' + id, platformData: { accountId: 'account-' + id } }));
  const execute = async (_tab, operation, args) => {
    if (operation === 'inspect' || operation === 'install') return template;
    if (operation === 'options') return { ready: true, platform: 'douyin', contextId: template.contextId, accountLabel: '演示店铺', mode: 'words', products: [{ id: 'sku-fixture', name: '演示商品' }], hasMore: false, cursor: '', categories: [], rights: [], reason: '' };
    if (operation === 'configure') return template;
    if (operation === 'preflight') return options.preflight ? options.preflight(args) : { ok: true };
    if (operation === 'send') { sends.push(args.recipient); return options.send ? options.send(args) : { status: 'succeeded', code: 0, message: '平台明确成功' }; }
  };
  const reportDiagnostic = event => {
    diagnostics.push(event);
    if (options.diagnosticFailure === 'throw') throw new Error('synthetic logger failure');
    if (options.diagnosticFailure === 'reject') return Promise.reject(new Error('synthetic logger rejection'));
    return options.reportDiagnostic?.(event);
  };
  const make = () => createInviteController({ chromeApi, getCreators: async () => creators, pageExecute: execute, now: () => clock, reportDiagnostic });
  const controller = make();
  return { controller, make, sends, alarms, diagnostics, local, session, options, advance(ms) { clock += ms; }, async prepare() { await controller.dispatch({ type: 'INVITE_OPTIONS', tabId: 7, recipientId: 'douyin:a' }); return (await controller.dispatch({ type: 'INVITE_PREPARE', tabId: 7, ids: ['douyin:a', 'douyin:b'], configuration: { message: '合成测试邀约', phone: '13800000000', wechat: '', contactName: '', productIds: ['sku-fixture'], categoryIds: [], rightIds: [] }, intervalSeconds: 30 })).job; } };
}
const status = async c => (await c.dispatch({ type: 'INVITE_STATUS' })).job;
const start = (c, job, extra = {}) => c.dispatch({ type: 'INVITE_START', jobId: job.id, approvalToken: job.approvalToken, confirmed: true, ...extra });

test('prepare does not send; start requires explicit confirmation and exact approval', async () => {
  const h = harness(); const job = await h.prepare();
  assert.equal(h.sends.length, 0);
  await assert.rejects(start(h.controller, job, { confirmed: false }));
  await assert.rejects(start(h.controller, job, { approvalToken: 'bad' }));
  assert.equal(h.sends.length, 0);
});
test('pause during preflight returns immediately and no send occurs afterwards', async () => {
  const pending = defer(); let checking = false;
  const h = harness({ preflight: async () => { checking = true; return pending.promise; } });
  const job = await h.prepare(); await start(h.controller, job); await until(() => checking);
  const paused = await h.controller.dispatch({ type: 'INVITE_PAUSE', jobId: job.id });
  assert.equal(paused.job.status, 'paused');
  pending.resolve({ ok: true });
  await until(async () => (await status(h.controller)).items[0].status === 'pending');
  assert.equal(h.sends.length, 0);
});
test('pause during async final tab check prevents send submission', async () => {
  const pending = defer(); let phase = 0; let waiting = false;
  const h = harness({ preflight: async () => { phase = 1; return { ok: true }; }, tabGate: async () => { if (phase === 1) { waiting = true; await pending.promise; } } });
  const job = await h.prepare(); await start(h.controller, job); await until(() => waiting);
  await h.controller.dispatch({ type: 'INVITE_PAUSE', jobId: job.id });
  pending.resolve();
  await until(async () => (await status(h.controller)).items[0].status === 'pending');
  assert.equal(h.sends.length, 0);
});
test('pause during an already-submitted send records result but never sends next', async () => {
  const pending = defer();
  const h = harness({ send: () => pending.promise });
  const job = await h.prepare(); await start(h.controller, job); await until(() => h.sends.length === 1);
  await h.controller.dispatch({ type: 'INVITE_PAUSE', jobId: job.id });
  pending.resolve({ status: 'succeeded', code: 0, message: '成功' });
  await until(async () => (await status(h.controller)).items[0].status === 'succeeded');
  assert.equal((await status(h.controller)).status, 'paused');
  h.advance(31000); await h.controller.tick(); assert.equal(h.sends.length, 1);
});
test('interrupted preflight stays pending and is never labelled platform rejection', async () => {
  const h = harness({ preflight: async () => { throw new Error('标签页已关闭'); } });
  const job = await h.prepare(); await start(h.controller, job);
  await until(async () => (await status(h.controller)).status === 'paused');
  const saved = await status(h.controller);
  assert.equal(saved.items[0].status, 'pending');
  assert.equal(saved.items[0].resolutionSource, '');
  assert.match(saved.items[0].message, /尚未发送/);
  assert.equal(h.sends.length, 0);
  assert.equal(h.diagnostics.some(e => e.operation === 'invite.preflight' && e.code === 'PREFLIGHT_FAILED' && e.context.outcome === 'INTERRUPTED'), true);
});
test('false preflight reports a bounded failure and never submits', async () => {
  const h = harness({ preflight: async () => ({ ok: false, reason: 'synthetic rejection' }) });
  const job = await h.prepare(); await start(h.controller, job);
  await until(async () => (await status(h.controller)).status === 'paused');
  assert.equal(h.sends.length, 0);
  const event = h.diagnostics.find(e => e.operation === 'invite.preflight' && e.code === 'PREFLIGHT_FAILED' && e.context.outcome === 'FAILED');
  assert.equal(event.error.message, 'synthetic rejection');
});
test('unknown result pauses, blocks replacement, and is never retried automatically', async () => {
  const h = harness({ send: async () => ({ status: 'unknown', message: '超时' }) });
  const job = await h.prepare(); await start(h.controller, job);
  await until(async () => (await status(h.controller)).status === 'paused');
  await assert.rejects(h.prepare(), /不确定/);
  await assert.rejects(start(h.controller, await status(h.controller)));
  const item = (await status(h.controller)).items[0];
  await h.controller.dispatch({ type: 'INVITE_RESOLVE', jobId: job.id, itemId: item.id, status: 'skipped' });
  const scheduled = h.alarms.length;
  await start(h.controller, await status(h.controller));
  await until(() => h.alarms.length > scheduled);
  await h.controller.tick(); assert.equal(h.sends.length, 1);
  assert.equal(h.diagnostics.some(e => e.operation === 'invite.result' && e.code === 'UNKNOWN'), true);
  h.advance(31000); await h.controller.tick();
  assert.equal(h.sends.length, 2);
  assert.equal(h.sends[1].accountId, 'account-b');
});
test('normal worker sleep preserves authorized waiting queue and exact spacing, never catches up', async () => {
  const h = harness(); const job = await h.prepare(); await start(h.controller, job);
  await until(async () => (await status(h.controller)).items[0].status === 'succeeded');
  const restarted = h.make(); await restarted.ready;
  assert.equal((await status(restarted)).status, 'running');
  await restarted.tick(); assert.equal(h.sends.length, 1);
  h.advance(90000); await restarted.tick();
  assert.equal(h.sends.length, 2);
  assert.equal((await status(restarted)).status, 'completed');
});
test('browser session loss pauses; later inspect cannot authorize old running job', async () => {
  const h = harness(); const job = await h.prepare(); await start(h.controller, job);
  await until(async () => (await status(h.controller)).items[0].status === 'succeeded');
  for (const key of Object.keys(h.session)) delete h.session[key];
  const restarted = h.make(); await restarted.ready;
  assert.equal((await status(restarted)).status, 'paused');
  await restarted.dispatch({ type: 'INVITE_OPTIONS', tabId: 7, recipientId: 'douyin:a' });
  h.advance(60000); await restarted.tick(); assert.equal(h.sends.length, 1);
});

test('malformed send result recovers as unknown and clears future scheduling', async () => {
  const h = harness({ send: async () => ({ status: 'unexpected' }) });
  const job = await h.prepare(); await start(h.controller, job);
  await until(async () => Boolean((await h.controller.dispatch({ type: 'INVITE_STATUS' })).runtimeError));
  const saved = await status(h.controller);
  assert.equal(saved.status, 'paused'); assert.equal(saved.items[0].status, 'unknown');
  assert.equal(h.diagnostics.some(e => e.operation === 'invite.result' && e.code === 'UNEXPECTED_RESULT' && e.context.phase === 'RESULT'), true);
  assert.equal(h.diagnostics.some(e => e.operation === 'invite.result' && e.code === 'STORAGE_ERROR'), false);
  h.advance(60000); await h.controller.tick(); assert.equal(h.sends.length, 1);
});

test('bridge success is logged only when the engine receives explicit code zero', async () => {
  for (const result of [{ status: 'succeeded' }, { status: 'succeeded', code: 9 }]) {
    const h = harness({ send: async () => result }); const job = await h.prepare(); await start(h.controller, job);
    await until(async () => Boolean((await h.controller.dispatch({ type: 'INVITE_STATUS' })).runtimeError));
    assert.equal((await status(h.controller)).items[0].status, 'unknown');
    assert.equal(h.diagnostics.some(e => e.operation === 'invite.result' && e.code === 'SUCCEEDED'), false);
    assert.equal(h.diagnostics.some(e => e.operation === 'invite.result' && e.code === 'UNEXPECTED_RESULT' && e.context.phase === 'RESULT'), true);
    assert.equal(h.diagnostics.some(e => e.operation === 'invite.result' && e.code === 'STORAGE_ERROR'), false);
  }
});
test('after-send disk failure keeps an explicit unknown result, including persistent disk failures', async () => {
  for (const failureCount of [1, Infinity]) {
    const opts = {};
    opts.send = async () => { opts.failLocalWrites = failureCount; return { status: 'succeeded', code: 0, message: 'server success but disk fails' }; };
    const h = harness(opts); const job = await h.prepare(); await start(h.controller, job);
    await until(async () => Boolean((await h.controller.dispatch({ type: 'INVITE_STATUS' })).runtimeError));
    assert.equal((await status(h.controller)).status, 'paused');
    assert.equal((await status(h.controller)).items[0].status, 'unknown');
    assert.equal(h.diagnostics.some(e => e.operation === 'invite.result' && e.code === 'STORAGE_ERROR'), true);
    assert.equal(h.diagnostics.some(e => e.operation === 'invite.recovery' && ['RECOVERED', 'RECOVERY_FAILED'].includes(e.code)), true);
    h.advance(60000); await h.controller.tick(); assert.equal(h.sends.length, 1);
  }
});

test('send throws, failed outcomes, and breadcrumbs are classified without recipient context', async () => {
  for (const [send, expectedCode] of [
    [async () => { throw new Error('synthetic send interruption'); }, 'UNKNOWN'],
    [async () => ({ status: 'failed', code: 12, message: 'platform refusal' }), 'SEND_FAILED'],
  ]) {
    const h = harness({ send }); const job = await h.prepare(); await start(h.controller, job);
    await until(() => h.diagnostics.some(e => e.operation === 'invite.result' && e.code === expectedCode));
    assert.equal(h.diagnostics.some(e => e.operation === 'invite.send' && e.code === 'STARTED'), true);
    const result = h.diagnostics.find(e => e.operation === 'invite.result' && e.code === expectedCode);
    assert.deepEqual(Object.keys(result.context).sort(), ['elapsedMs', 'itemIndex', 'outcome', 'phase', 'total']);
    assert.equal(JSON.stringify(result.context).includes('creator'), false);
    if (expectedCode === 'SEND_FAILED') assert.equal(result.error.message, 'platform refusal');
    else assert.equal(result.error instanceof Error, true);
  }
});

test('diagnostic logger sync throws and async rejections cannot change invite completion', async () => {
  for (const diagnosticFailure of ['throw', 'reject']) {
    const h = harness({ diagnosticFailure }); const job = await h.prepare(); await start(h.controller, job);
    await until(async () => (await status(h.controller)).items[0].status === 'succeeded');
    assert.equal(h.sends.length, 1);
  }
});

test('successful invite result breadcrumb has no error detail', async () => {
  const h = harness(); const job = await h.prepare(); await start(h.controller, job);
  await until(async () => (await status(h.controller)).items[0].status === 'succeeded');
  const success = h.diagnostics.find(e => e.operation === 'invite.result' && e.code === 'SUCCEEDED');
  assert.ok(success);
  assert.equal(success.level, 'info');
  assert.equal(Object.hasOwn(success, 'error'), false);
});

test('unexpected async tick failure is logged before recovery and does not escape', async () => {
  const h = harness({ failAlarmCreate: true }); const job = await h.prepare();
  await start(h.controller, job);
  await until(async () => Boolean((await h.controller.dispatch({ type: 'INVITE_STATUS' })).runtimeError));
  assert.equal(h.sends.length, 1);
  assert.equal(h.diagnostics.some(e => e.operation === 'invite.recovery' && e.code === 'TICK_FAILED'), true);
  assert.equal((await status(h.controller)).status, 'paused');
});

test('local rejection after preflight remains pending and never claims platform rejection', async () => {
  const h = harness({ send: async () => ({ status: 'failed', notSubmitted: true, message: '模板刚刚失效' }) });
  const job = await h.prepare(); await start(h.controller, job);
  await until(async () => (await status(h.controller)).status === 'paused');
  const saved = await status(h.controller);
  assert.equal(saved.items[0].status, 'pending');
  assert.equal(saved.items[0].resolutionSource, '');
  assert.match(saved.items[0].message, /尚未发送/);
});

test('pre-send persistent local failure revokes session authorization across worker recreation', async () => {
  const opts = {};
  opts.beforeLocalWrite = data => { if (Object.values(data).some(j => j?.items?.some(i => i.status === 'sending'))) opts.failLocalWrites = Infinity; };
  const h = harness(opts); const job = await h.prepare(); await start(h.controller, job);
  await until(async () => Boolean((await h.controller.dispatch({ type: 'INVITE_STATUS' })).runtimeError));
  assert.equal(h.sends.length, 0);
  opts.failLocalWrites = 0; opts.beforeLocalWrite = null;
  const restarted = h.make(); await restarted.ready;
  assert.equal((await status(restarted)).status, 'paused');
  h.advance(60000); await restarted.tick();
  assert.equal(h.sends.length, 0);
});

test('legacy version-one job stays readable and never starts under new settings', async () => {
  const h = harness(); const original = await h.prepare();
  const legacy = { ...original, status: 'running' };
  delete legacy.flowVersion; delete legacy.contextId;
  h.local['creator-assistant-invites-v1'] = legacy;
  const fresh = h.make(); await fresh.ready;
  const saved = await status(fresh);
  assert.equal(saved.flowVersion, 1); assert.equal(saved.status, 'paused');
  await assert.rejects(start(fresh, saved), /旧版/);
  assert.equal(h.sends.length, 0);
  assert.equal(saved.items.length, 2);
});

test('rapid repeated start only submits one request', async () => {
  const pending = defer(); const h = harness({ send: () => pending.promise });
  const job = await h.prepare();
  const results = await Promise.allSettled([start(h.controller, job), start(h.controller, job)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await until(() => h.sends.length === 1);
  pending.resolve({ status: 'succeeded', code: 0 });
  await until(async () => (await status(h.controller)).items[0].status === 'succeeded');
  assert.equal(h.sends.length, 1);
});
