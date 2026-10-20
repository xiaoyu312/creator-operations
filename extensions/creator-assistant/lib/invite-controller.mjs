import { prepareJob, startJob, pauseJob, beginNext, completeItem, recoverJob, resolveUnknown, normalizeJob } from './invite-engine.mjs';
import { executeDouyinPage } from './douyin-page.mjs';
import { createWeixinClient } from './weixin-client.mjs';
import { safePlatformUrl } from './core.mjs';

export const INVITE_ALARM = 'creator-assistant-invite-step';
const KEY = 'creator-assistant-invites-v1';
const SESSION_KEY = 'creator-assistant-runtime-sessions';
const HOSTS = { 'buyin.jinritemai.com': 'douyin', 'channels.weixin.qq.com': 'weixin', 'store.weixin.qq.com': 'weixin' };
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
const DIAGNOSTIC_OPERATIONS = new Set(['invite.options', 'invite.configure', 'invite.preflight', 'invite.send', 'invite.result', 'invite.recovery']);
const DIAGNOSTIC_PHASES = new Set(['START', 'ACCESS', 'REQUEST', 'PARSE', 'VALIDATE', 'PREFLIGHT', 'SUBMIT', 'RESULT', 'PERSIST', 'RECOVER', 'TICK']);
const DIAGNOSTIC_OUTCOMES = new Set(['STARTED', 'SUCCEEDED', 'FAILED', 'REJECTED', 'UNKNOWN', 'NOT_SUBMITTED', 'INTERRUPTED', 'MISMATCHED', 'RECOVERED', 'PAUSED']);
const DIAGNOSTIC_CODES = new Set(['STARTED', 'SUCCEEDED', 'OPTIONS_FAILED', 'CONFIGURE_FAILED', 'PREFLIGHT_FAILED', 'PLATFORM_REJECTED', 'IDENTITY_MISMATCH', 'SEND_FAILED', 'NOT_SUBMITTED', 'UNKNOWN', 'STORAGE_ERROR', 'UNEXPECTED_RESULT', 'RECOVERED', 'RECOVERY_FAILED', 'TICK_FAILED', 'HTTP_ERROR', 'TIMEOUT', 'NETWORK_ERROR', 'INVALID_JSON', 'RESPONSE_TOO_LARGE', 'PLATFORM_ERROR', 'INVALID_PAYLOAD', 'ACCESS_DENIED', 'CONTEXT_CHANGED']);

export function createInviteController({ chromeApi = globalThis.chrome, getCreators, pageExecute, weixinClient, now = () => Date.now(), reportDiagnostic = () => {} }) {
  let gate = Promise.resolve();
  let ticking = false;
  let runtimeFault = '';
  let volatileRecovery = null;
  let settingUp = false;
  let setupBaseline = null;
  const deferredReleases = new Map();
  let setupEpoch = 0;
  const weixin = weixinClient || createWeixinClient({ chromeApi, now, reportDiagnostic });
  function diagnostic(operation, code, level, platform, context = {}, error) {
    if (!DIAGNOSTIC_OPERATIONS.has(operation) || !DIAGNOSTIC_CODES.has(code) || !['error', 'warning', 'info'].includes(level) || !['douyin', 'weixin'].includes(platform)) return;
    const safeContext = {};
    if (DIAGNOSTIC_PHASES.has(context.phase)) safeContext.phase = context.phase;
    if (DIAGNOSTIC_OUTCOMES.has(context.outcome)) safeContext.outcome = context.outcome;
    for (const key of ['httpStatus', 'itemIndex', 'total', 'elapsedMs']) {
      const value = context[key];
      if (Number.isFinite(value) && value >= 0) safeContext[key] = Math.floor(value);
    }
    const event = { source: 'invite', operation, code, level, platform, context: safeContext };
    if (error instanceof Error) event.error = error;
    else if (typeof error === 'string') event.error = { message: error };
    try {
      const result = reportDiagnostic(event);
      if (result && typeof result.then === 'function') void Promise.resolve(result).catch(() => {});
    } catch { /* Diagnostics must not affect invite flow. */ }
  }
  const lock = operation => {
    const result = gate.then(operation);
    gate = result.catch(() => {});
    return result;
  };
  const read = async () => {
    if (volatileRecovery) return normalizeJob(volatileRecovery);
    const value = (await chromeApi.storage.local.get(KEY))[KEY];
    return value ? normalizeJob(value) : null;
  };
  const write = async job => {
    const clean = normalizeJob(job);
    await chromeApi.storage.local.set({ [KEY]: clean });
    volatileRecovery = null;
    return clean;
  };
  async function getTab(tabId) {
    if (!Number.isInteger(tabId)) throw new Error('请选择一个平台标签页。');
    let tab;
    try { tab = await chromeApi.tabs.get(tabId); } catch { throw new Error('平台页面已关闭，请重新打开并设置邀约。'); }
    let url;
    try { url = new URL(tab.url); } catch { throw new Error('无法读取平台页面。'); }
    const platform = url.protocol === 'https:' && HOSTS[url.hostname];
    if (!platform || url.username || url.password || (url.port && url.port !== '443')) throw new Error('此标签页不是抖音精选联盟或视频号后台。');
    return { tab, platform, origin: url.origin };
  }
  async function sessions() { return (await chromeApi.storage.session.get(SESSION_KEY))[SESSION_KEY] || {}; }
  async function authorize(job) {
    const all = await sessions();
    const session = all[job.tabId];
    if (!session || session.platform !== job.platform || session.contextId !== job.contextId) throw new Error('店铺页面已变化，请重新设置邀约。');
    all[job.tabId] = { ...session, authorizedJobId: job.id, authorizedTemplateId: job.templateId, authorizedContextId: job.contextId };
    await chromeApi.storage.session.set({ [SESSION_KEY]: all });
  }
  async function revoke(job) {
    const all = await sessions();
    const session = all[job.tabId];
    if (session?.authorizedJobId === job.id) {
      const { authorizedJobId, authorizedTemplateId, authorizedContextId, ...connection } = session;
      all[job.tabId] = connection;
      await chromeApi.storage.session.set({ [SESSION_KEY]: all });
    }
  }
  const authorized = (job, session) => job.flowVersion === 2 && session?.authorizedJobId === job.id && session?.authorizedTemplateId === job.templateId && session?.authorizedContextId === job.contextId;
  function eligibleAt(job) {
    const last = Math.max(0, ...job.items.filter(i => ['succeeded', 'failed', 'unknown', 'skipped'].includes(i.status)).map(i => Date.parse(i.updatedAt) || 0));
    return last ? last + job.intervalSeconds * 1000 : 0;
  }
  const execute = pageExecute || (async (tabId, operation, args) => {
    const results = await chromeApi.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN', func: executeDouyinPage, args: [operation, args] });
    if (!results?.[0] || results[0].error) throw new Error('页面执行中断，请回到平台检查最后一位达人的邀请结果。');
    return results[0].result;
  });
  async function release(tabId, expectedJobId = null) {
    const epoch = setupEpoch;
    return lock(async () => {
      if (epoch !== setupEpoch) return { released: false };
      if (settingUp) {
        if (!expectedJobId) deferredReleases.set(tabId, epoch);
        return { released: false };
      }
      const job = await read();
      if (expectedJobId && job?.id !== expectedJobId) return { released: false };
      if (job && (job.status === 'running' || job.items.some(i => ['sending', 'unknown'].includes(i.status)))) return { released: false };
      const session = (await sessions())[tabId];
      if (session?.platform !== 'douyin') return { released: true };
      const result = await execute(tabId, 'release', session).catch(() => null);
      return { released: result?.ok === true };
    });
  }
  async function finishSetup() {
    settingUp = false;
    for (const [tabId, epoch] of deferredReleases) {
      deferredReleases.delete(tabId);
      if (epoch === setupEpoch) await release(tabId);
    }
  }
  async function connection(tabId, install = true) {
    const { tab, platform, origin } = await getTab(tabId);
    const all = await sessions();
    let session = all[tabId];
    if (!session || session.origin !== origin || session.platform !== platform) {
      if (!install) throw new Error('页面已变化，请重新设置邀约。');
      session = { sessionKey: `__dabo_invite_${random()}`, capability: random(), origin, platform };
      all[tabId] = session;
      await chromeApi.storage.session.set({ [SESSION_KEY]: all });
      if (platform === 'douyin') await execute(tabId, 'install', session);
    }
    if (platform === 'douyin' && install) {
      const state = await execute(tabId, 'inspect', session);
      if (state?.missing === true) await execute(tabId, 'install', session);
    }
    return { session, tab: { id: tab.id, title: tab.title || '', url: safePlatformUrl(tab.url), platform } };
  }
  const asRecipient = creator => ({ id: creator.id, platform: creator.platform, name: creator.name, externalId: creator.externalId, accountId: creator.platformData?.accountId || '', searchAccount: creator.platformData?.searchAccount || '', talentAppid: creator.platformData?.talentAppid || '' });
  async function bindContext(tabId, contextId) {
    if (typeof contextId !== 'string' || !contextId) throw new Error('未读取到当前店铺，请重新打开平台页面。');
    const all = await sessions();
    if (!all[tabId]) throw new Error('页面已关闭，请重新选择。');
    all[tabId] = { ...all[tabId], contextId };
    await chromeApi.storage.session.set({ [SESSION_KEY]: all });
  }
  async function configured(job) {
    if (job.flowVersion !== 2) return { ready: false, reason: '旧版任务已停止，请重新设置。' };
    if (job.platform === 'weixin') return weixin.inspect(job);
    const { session } = await connection(job.tabId, false);
    return execute(job.tabId, 'inspect', { ...session, templateId: job.templateId, contextId: job.contextId });
  }
  async function preparePageCall(job) {
    const { platform, origin } = await getTab(job.tabId);
    const session = (await sessions())[job.tabId];
    if (!session || session.origin !== origin || session.platform !== platform || platform !== job.platform || session.contextId !== job.contextId) throw new Error('平台账号页面已变化，请重新设置邀约。');
    return (operation, recipient) => execute(job.tabId, operation, { ...session, templateId: job.templateId, contextId: job.contextId, recipient });
  }
  async function callPage(job, operation, recipient) {
    if (job.platform === 'weixin') return weixin.preflight(job, recipient);
    return (await preparePageCall(job))(operation, recipient);
  }
  let recoveryPlatform = '';
  const ready = (async () => {
    await chromeApi.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
    const job = await read();
    if (!job) return;
    recoveryPlatform = job.platform;
    const session = (await sessions())[job.tabId];
    if ((job.flowVersion !== 2 && job.status !== 'completed') || job.items.some(item => item.status === 'sending') || (job.status === 'running' && !authorized(job, session))) {
      await write(recoverJob(job));
      await chromeApi.alarms.clear(INVITE_ALARM);
      diagnostic('invite.recovery', 'RECOVERED', 'warning', job.platform, { phase: 'RECOVER', outcome: 'RECOVERED', total: job.items.length });
    } else if (job.status === 'running') {
      await chromeApi.alarms.create(INVITE_ALARM, { when: Math.max(now() + 1000, eligibleAt(job)) });
    }
  })();
  void ready.catch(error => {
    if (recoveryPlatform) diagnostic('invite.recovery', 'RECOVERY_FAILED', 'error', recoveryPlatform, { phase: 'RECOVER', outcome: 'FAILED' }, error);
  });
  async function schedule(job) {
    if (job.status === 'running') await chromeApi.alarms.create(INVITE_ALARM, { when: now() + job.intervalSeconds * 1000 });
    else await chromeApi.alarms.clear(INVITE_ALARM);
  }
  async function tick() {
    await ready;
    if (ticking || runtimeFault) return;
    ticking = true;
    let operationPlatform = '';
    let diagnosticIndex = 0;
    let diagnosticTotal = 0;
    let stageStartedAt = now();
    let failureOperation = 'invite.recovery';
    let failureCode = 'TICK_FAILED';
    let failurePhase = 'TICK';
    const persistTick = async (job, operation = 'invite.recovery') => {
      failureOperation = operation;
      failureCode = 'STORAGE_ERROR';
      failurePhase = 'PERSIST';
      const saved = await write(job);
      failureOperation = 'invite.recovery';
      failureCode = 'TICK_FAILED';
      failurePhase = 'TICK';
      return saved;
    };
    try {
      const step = await lock(async () => {
        const job = await read();
        if (!job || job.status !== 'running') return null;
        operationPlatform = job.platform;
        if (!authorized(job, (await sessions())[job.tabId])) {
          await persistTick(recoverJob(job));
          await chromeApi.alarms.clear(INVITE_ALARM);
          diagnostic('invite.recovery', 'RECOVERED', 'warning', job.platform, { phase: 'RECOVER', outcome: 'RECOVERED', total: job.items.length });
          return null;
        }
        if (eligibleAt(job) > now()) {
          await chromeApi.alarms.create(INVITE_ALARM, { when: eligibleAt(job) });
          return null;
        }
        if (Date.parse(job.expiresAt) <= now()) {
          await persistTick(pauseJob(job, '本批邀约设置已失效，请重新设置。'));
          await chromeApi.alarms.clear(INVITE_ALARM);
          return null;
        }
        const next = beginNext(job);
        await persistTick(next.job);
        return next.item ? next : null;
      });
      if (!step) return;
      const { job, item } = step;
      operationPlatform = job.platform;
      diagnosticTotal = job.items.length;
      diagnosticIndex = job.items.findIndex(row => row.id === item.id) + 1;
      stageStartedAt = now();
      const recipient = { id: item.creatorId, platform: job.platform, name: item.name, externalId: item.externalId, accountId: item.accountId, searchAccount: item.searchAccount || '', talentAppid: item.talentAppid };
      let preflight;
      let preflightError = null;
      diagnostic('invite.preflight', 'STARTED', 'info', job.platform, { phase: 'START', outcome: 'STARTED', itemIndex: diagnosticIndex, total: diagnosticTotal });
      try { preflight = await callPage(job, 'preflight', recipient); }
      catch (error) {
        preflightError = error;
        preflight = { ok: false, reason: error.message };
        diagnostic('invite.preflight', 'PREFLIGHT_FAILED', 'error', job.platform, { phase: 'PREFLIGHT', outcome: 'INTERRUPTED', itemIndex: diagnosticIndex, total: diagnosticTotal, elapsedMs: Math.max(0, now() - stageStartedAt) }, error);
      }
      if (preflight?.ok) diagnostic('invite.preflight', 'SUCCEEDED', 'info', job.platform, { phase: 'RESULT', outcome: 'SUCCEEDED', itemIndex: diagnosticIndex, total: diagnosticTotal, elapsedMs: Math.max(0, now() - stageStartedAt) });
      else if (preflight?.platformRejected === true) diagnostic('invite.preflight', 'PLATFORM_REJECTED', 'warning', job.platform, { phase: 'RESULT', outcome: 'REJECTED', itemIndex: diagnosticIndex, total: diagnosticTotal, elapsedMs: Math.max(0, now() - stageStartedAt) });
      else if (!preflightError) diagnostic('invite.preflight', 'PREFLIGHT_FAILED', 'warning', job.platform, { phase: 'RESULT', outcome: 'FAILED', itemIndex: diagnosticIndex, total: diagnosticTotal, elapsedMs: Math.max(0, now() - stageStartedAt) }, preflight?.reason);
      let submit;
      if (preflight?.ok) {
        stageStartedAt = now();
        try { submit = job.platform === 'weixin' ? await weixin.prepareSend(job, recipient) : await preparePageCall(job); }
        catch (error) {
          preflight = { ok: false, reason: error.message };
          diagnostic('invite.preflight', 'PREFLIGHT_FAILED', 'error', job.platform, { phase: 'ACCESS', outcome: 'NOT_SUBMITTED', itemIndex: diagnosticIndex, total: diagnosticTotal, elapsedMs: Math.max(0, now() - stageStartedAt) }, error);
        }
      }
      const allowed = await lock(async () => {
        const current = await read();
        if (!current || current.id !== job.id) return false;
        if (current.status !== 'running' || !authorized(current, (await sessions())[current.tabId])) {
          await persistTick({ ...current, items: current.items.map(row => row.id === item.id && row.status === 'sending' ? { ...row, status: 'pending', message: '已在发送前暂停。', updatedAt: new Date(now()).toISOString() } : row) }, 'invite.result');
          return false;
        }
        if (!preflight?.ok) {
          const reason = preflight?.reason || '预检未能确认，尚未发送。';
          const changed = preflight?.platformRejected === true
            ? completeItem(current, item.id, { status: 'failed', message: `平台预检拒绝，未发送：${reason}`, code: preflight?.code })
            : pauseJob({ ...current, items: current.items.map(row => row.id === item.id ? { ...row, status: 'pending', message: `预检中断，尚未发送：${reason}`, resolutionSource: '', updatedAt: new Date(now()).toISOString() } : row) }, '预检中断，尚未发送，可检查平台后恢复。');
          await persistTick(changed, 'invite.result');
          await chromeApi.alarms.clear(INVITE_ALARM);
          return false;
        }
        // No asynchronous gap between the last pause check and submitting executeScript.
        // The network promise is awaited outside this short state lock.
        stageStartedAt = now();
        failureOperation = 'invite.result';
        failureCode = 'UNKNOWN';
        failurePhase = 'RESULT';
        let sendPromise;
        try { sendPromise = Promise.resolve(job.platform === 'weixin' ? submit() : submit('send', recipient)); }
        catch (error) { sendPromise = Promise.reject(error); }
        diagnostic('invite.send', 'STARTED', 'info', job.platform, { phase: 'SUBMIT', outcome: 'STARTED', itemIndex: diagnosticIndex, total: diagnosticTotal });
        return { sendPromise };
      });
      if (!allowed) return;
      let result;
      let sendError = null;
      try { result = await allowed.sendPromise; }
      catch (error) {
        sendError = error;
        result = { status: 'unknown', message: '请求中断，结果不确定。请先在平台核对，系统不会自动重发。' };
      }
      failureOperation = 'invite.result';
      failureCode = 'UNEXPECTED_RESULT';
      failurePhase = 'RESULT';
      const resultCode = result?.notSubmitted === true ? 'NOT_SUBMITTED'
        : result?.platformRejected === true ? 'PLATFORM_REJECTED'
          : result?.status === 'succeeded' && result.code === 0 ? 'SUCCEEDED'
            : result?.status === 'succeeded' ? 'UNEXPECTED_RESULT'
            : result?.status === 'unknown' ? 'UNKNOWN'
              : result?.status === 'failed' ? 'SEND_FAILED' : 'UNEXPECTED_RESULT';
      const resultLevel = resultCode === 'SUCCEEDED' ? 'info' : resultCode === 'PLATFORM_REJECTED' || resultCode === 'NOT_SUBMITTED' ? 'warning' : 'error';
      const resultOutcome = resultCode === 'SUCCEEDED' ? 'SUCCEEDED'
        : resultCode === 'PLATFORM_REJECTED' ? 'REJECTED'
          : resultCode === 'NOT_SUBMITTED' ? 'NOT_SUBMITTED'
            : resultCode === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED';
      diagnostic('invite.result', resultCode, resultLevel, job.platform, { phase: 'RESULT', outcome: resultOutcome, itemIndex: diagnosticIndex, total: diagnosticTotal, elapsedMs: Math.max(0, now() - stageStartedAt) }, resultCode === 'SUCCEEDED' ? undefined : sendError || (typeof result?.message === 'string' ? result.message : undefined));
      await lock(async () => {
        const current = await read();
        if (!current || current.id !== job.id) return;
        const wasPaused = current.status === 'paused';
        failureOperation = 'invite.result';
        failureCode = 'UNEXPECTED_RESULT';
        failurePhase = 'RESULT';
        let changed = result?.notSubmitted === true
          ? pauseJob({ ...current, items: current.items.map(row => row.id === item.id ? { ...row, status: 'pending', resolutionSource: '', message: '本地检查停止，尚未发送：' + (result.message || result.reason || '配置已失效'), updatedAt: new Date(now()).toISOString() } : row) }, '发送前本地检查未通过，尚未提交平台。')
          : completeItem(current, item.id, result || { status: 'unknown', message: '页面未返回发送结果。' });
        if (wasPaused && changed.status === 'running') changed = pauseJob(changed, '已暂停，当前已提交的邀请结果已记录。');
        const saved = await persistTick(changed, 'invite.result');
        await schedule(saved);
        if (saved.status === 'completed') queueMicrotask(() => { void release(saved.tabId, saved.id); });
      });
    } catch (error) {
      if (operationPlatform) diagnostic(failureOperation, failureCode, 'error', operationPlatform, { phase: failurePhase, outcome: 'FAILED', itemIndex: diagnosticIndex || undefined, total: diagnosticTotal || undefined }, error);
      runtimeFault = '任务结果处理或本地保存失败。已停止后续发送，请核对平台结果。';
      await lock(async () => {
        let current;
        try { current = await read(); } catch { current = null; }
        if (current) {
          operationPlatform = current.platform;
          await revoke(current).catch(() => {});
          const recovered = recoverJob(current);
          const stopped = pauseJob(recovered, runtimeFault);
          volatileRecovery = stopped;
          try {
            await write(stopped);
            diagnostic('invite.recovery', 'RECOVERED', 'warning', current.platform, { phase: 'RECOVER', outcome: 'RECOVERED', total: current.items.length });
          } catch (error) {
            diagnostic('invite.recovery', 'RECOVERY_FAILED', 'error', current.platform, { phase: 'PERSIST', outcome: 'FAILED', total: current.items.length }, error);
          }
        }
        await chromeApi.alarms.clear(INVITE_ALARM).catch(() => {});
      }).catch(() => {});
    } finally { ticking = false; }
  }
  async function dispatch(message) {
    await ready;
    const requireJob = async () => {
      const job = await read();
      if (!job || job.id !== message.jobId) throw new Error('任务已变化，请重新读取当前任务。');
      return job;
    };
    switch (message.type) {
      case 'INVITE_STATUS': return lock(async () => ({ job: await read(), runtimeError: runtimeFault }));
      case 'INVITE_RELEASE': return release(message.tabId);
      case 'INVITE_OPTIONS': {
        await lock(async () => {
          const active = await read();
          if (settingUp || active?.status === 'running' || active?.items.some(i => i.status === 'sending')) throw new Error('请先暂停当前任务，再设置新邀约。');
          settingUp = true;
          setupEpoch++;
        });
        let platform = '';
        let phase = 'ACCESS';
        const startedAt = now();
        try {
          const { session, tab } = await connection(message.tabId);
          platform = tab.platform;
          const creator = (await getCreators()).find(c => c.id === message.recipientId && c.platform === tab.platform);
          if (!creator) throw new Error('请先选择一位当前平台的达人。');
          const recipient = asRecipient(creator);
          phase = 'REQUEST';
          const options = tab.platform === 'weixin'
            ? await weixin.options(tab.id, recipient, { keyword: message.keyword, cursor: message.cursor })
            : await execute(tab.id, 'options', { ...session, recipient, keyword: message.keyword, cursor: message.cursor });
          if (!options?.ready) throw new Error(options?.reason || '平台资料暂未读取成功，请重试。');
          phase = 'PERSIST';
          await bindContext(tab.id, options.contextId);
          diagnostic('invite.options', 'SUCCEEDED', 'info', platform, { phase: 'RESULT', outcome: 'SUCCEEDED', elapsedMs: Math.max(0, now() - startedAt) });
          return { options, tab };
        } catch (error) {
          if (platform) diagnostic('invite.options', phase === 'PERSIST' ? 'STORAGE_ERROR' : 'OPTIONS_FAILED', 'error', platform, { phase, outcome: 'FAILED', elapsedMs: Math.max(0, now() - startedAt) }, error);
          throw error;
        } finally { await finishSetup(); }
      }
      case 'INVITE_PREPARE': {
        await lock(async () => {
          const old = await read();
          if (settingUp || (old && (old.status === 'running' || old.items.some(i => ['sending', 'unknown'].includes(i.status))))) throw new Error('当前任务仍在运行或有不确定结果，请先暂停并核对结果。');
          settingUp = true;
          setupEpoch++;
          setupBaseline = old ? { id: old.id, updatedAt: old.updatedAt } : null;
        });
        let platform = '';
        let phase = 'ACCESS';
        const startedAt = now();
        try {
          const { session, tab } = await connection(message.tabId, false);
          platform = tab.platform;
          const creators = await getCreators();
          phase = 'VALIDATE';
          const template = tab.platform === 'weixin'
            ? await weixin.configure(tab.id, message.configuration)
            : await execute(tab.id, 'configure', { ...session, contextId: session.contextId, configuration: message.configuration });
          if (!template?.ready) throw new Error(template?.reason || '请检查话术、商品和联系人。');
          const job = prepareJob({ platform: tab.platform, tabId: tab.id, template, creators, ids: message.ids, intervalSeconds: message.intervalSeconds });
          phase = 'PERSIST';
          return await lock(async () => {
            const current = await read();
            if ((current?.id || null) !== (setupBaseline?.id || null) || (current?.updatedAt || null) !== (setupBaseline?.updatedAt || null) || current?.status === 'running' || current?.items.some(i => ['sending', 'unknown'].includes(i.status))) throw new Error('任务状态已变化，请重新检查当前名单。');
            const saved = await write(job);
            runtimeFault = '';
            diagnostic('invite.configure', 'SUCCEEDED', 'info', platform, { phase: 'RESULT', outcome: 'SUCCEEDED', elapsedMs: Math.max(0, now() - startedAt) });
            return { job: saved };
          });
        } catch (error) {
          if (platform) diagnostic('invite.configure', phase === 'PERSIST' ? 'STORAGE_ERROR' : 'CONFIGURE_FAILED', 'error', platform, { phase, outcome: 'FAILED', elapsedMs: Math.max(0, now() - startedAt) }, error);
          throw error;
        } finally { await finishSetup(); }
      }
      case 'INVITE_START': {
        if (message.confirmed !== true) throw new Error('请先确认邀请配置和收件名单。');
        const before = await lock(async () => { if (settingUp) throw new Error('正在读取邀约设置，请稍候。'); return requireJob(); });
        let phase = 'ACCESS';
        const startedAt = now();
        try {
          const template = await configured(before);
          if (!template?.ready || template.contextId !== before.contextId || (template.templateId && template.templateId !== before.templateId)) throw new Error(template?.reason || '店铺或邀约设置已变化，请重新设置。');
          phase = 'VALIDATE';
          const job = await lock(async () => {
            if (settingUp) throw new Error('邀约设置正在更新，请稍候。');
            const current = await requireJob();
            if (current.updatedAt !== before.updatedAt || current.status !== before.status) throw new Error('任务状态已变化，请重新检查。');
            const changed = startJob(current, message.approvalToken);
            await authorize(changed);
            phase = 'PERSIST';
            const saved = await write(changed);
            runtimeFault = '';
            diagnostic('invite.send', 'STARTED', 'info', saved.platform, { phase: 'START', outcome: 'STARTED', total: saved.items.length, elapsedMs: Math.max(0, now() - startedAt) });
            return saved;
          });
          void tick().catch(async error => {
            diagnostic('invite.recovery', 'TICK_FAILED', 'error', job.platform, { phase: 'TICK', outcome: 'FAILED', total: job.items.length }, error);
            await lock(async () => {
              const current = await read();
              if (current?.status === 'running') await write(recoverJob(current));
            }).catch(recoveryError => diagnostic('invite.recovery', 'RECOVERY_FAILED', 'error', job.platform, { phase: 'RECOVER', outcome: 'FAILED', total: job.items.length }, recoveryError));
          });
          return { job };
        } catch (error) {
          diagnostic('invite.configure', phase === 'PERSIST' ? 'STORAGE_ERROR' : 'CONFIGURE_FAILED', 'error', before.platform, { phase, outcome: 'FAILED', elapsedMs: Math.max(0, now() - startedAt) }, error);
          throw error;
        }
      }
      case 'INVITE_PAUSE': return lock(async () => {
        const current = await requireJob();
        await revoke(current);
        await chromeApi.alarms.clear(INVITE_ALARM);
        const job = await write(pauseJob(current, '用户暂停。已提交的请求仍会记录返回结果。'));
        return { job };
      });
      case 'INVITE_RESOLVE': return lock(async () => ({ job: await write(resolveUnknown(await requireJob(), message.itemId, message.status)) }));
      default: throw new Error('不支持的邀约操作。');
    }
  }
  return { dispatch, tick, ready };
}
