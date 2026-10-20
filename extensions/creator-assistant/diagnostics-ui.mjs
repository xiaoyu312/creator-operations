import { sanitizeDiagnostic } from './lib/diagnostics.mjs';

const OPERATIONS = new Set([
  'GET_STATE', 'LIST_TABS', 'GET_ACTIVE_CAPTURE', 'UPSERT_CREATORS', 'SAVE_PRESET', 'UPDATE_CREATOR',
  'ADD_DRAFTS', 'UPDATE_DRAFT', 'IMPORT_STATE', 'REMOVE_PRESET', 'OPEN_WORKBENCH',
  'INVITE_OPTIONS', 'INVITE_PREPARE', 'INVITE_START', 'INVITE_STATUS', 'INVITE_PAUSE', 'INVITE_RESOLVE', 'INVITE_RELEASE',
  'INVITE_TEMPLATES_LIST', 'INVITE_TEMPLATE_SAVE', 'INVITE_TEMPLATE_DELETE', 'EXPORT_INVITE_RESULTS_CSV',
  'UI_GLOBAL', 'EXPORT_CSV', 'EXPORT_BACKUP', 'EXPORT_INVITE_JOB', 'IMPORT_BACKUP', 'COPY_DRAFT', 'OPEN_PLATFORM',
]);
const CODES = new Set(['UI_EXCEPTION', 'UNHANDLED_REJECTION', 'REQUEST_FAILED']);
const SURFACES = new Set(['app', 'auto-invite', 'popup']);
const STAGES = new Set(['global', 'request', 'download', 'import', 'copy', 'open', 'capture', 'save']);
const loggedErrors = new WeakSet();
const globalListeners = new WeakMap();

function createTraceId() {
  try { return globalThis.crypto?.randomUUID?.(); } catch { return undefined; }
}

function safeProperty(value, key) {
  try { return value == null ? undefined : value[key]; } catch { return undefined; }
}

function asError(value) {
  try {
    if (value instanceof Error) return value;
    const message = safeProperty(value, 'message');
    if (value && typeof value === 'object' && typeof message === 'string') {
      const error = new Error(message);
      const name = safeProperty(value, 'name');
      const stack = safeProperty(value, 'stack');
      if (typeof name === 'string') error.name = name;
      if (typeof stack === 'string') error.stack = stack;
      return error;
    }
  } catch { /* hostile or broken error accessors fall through to a safe summary */ }
  return new Error('页面发生未处理错误。');
}

export function diagnosticSurface(documentValue = globalThis.document) {
  const value = documentValue?.body?.dataset?.diagnosticsSurface;
  return SURFACES.has(value) ? value : 'app';
}

export function markDiagnosticLogged(error) {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    loggedErrors.add(error);
    try { error.diagnosticLogged = true; } catch { /* some platform errors are immutable */ }
  }
  return error;
}

export function isDiagnosticLogged(error) {
  try { return Boolean(error && (loggedErrors.has(error) || safeProperty(error, 'diagnosticLogged') === true)); } catch { return false; }
}

export function sanitizeUiDiagnostic(errorValue, {
  operation,
  code = 'UI_EXCEPTION',
  surface = diagnosticSurface(),
  stage = 'global',
  traceId = createTraceId(),
  runtime = globalThis.chrome?.runtime,
} = {}) {
  if (!OPERATIONS.has(operation) || !CODES.has(code) || !SURFACES.has(surface) || !STAGES.has(stage)) return null;
  const error = asError(errorValue);
  const input = {
    source: 'ui',
    operation,
    code,
    level: 'error',
    error: {
      name: error.name || 'Error',
      message: error.message || '页面操作失败。',
      stack: error.stack || '',
    },
    context: { surface, stage },
    ...(typeof traceId === 'string' ? { traceId } : {}),
  };
  try {
    const extensionOrigin = typeof runtime?.getURL === 'function' ? runtime.getURL('') : undefined;
    return sanitizeDiagnostic(input, { extensionOrigin });
  } catch { return null; }
}

export function reportError(error, options = {}) {
  try {
    if (isDiagnosticLogged(error)) return Promise.resolve(false);
    const normalizedError = asError(error);
    markDiagnosticLogged(error && (typeof error === 'object' || typeof error === 'function') ? error : normalizedError);
    const runtime = options.runtime || globalThis.chrome?.runtime;
    const event = sanitizeUiDiagnostic(normalizedError, { ...options, runtime });
    if (!event || !runtime?.id || typeof runtime.sendMessage !== 'function') return Promise.resolve(false);
    return Promise.resolve(runtime.sendMessage({ type: 'DIAGNOSTICS_RECORD', event }))
      .then((result) => result?.ok === true)
      .catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

export function installGlobalErrorListeners(target = globalThis.window, { surface = diagnosticSurface(), runtime = globalThis.chrome?.runtime } = {}) {
  if (!target || typeof target.addEventListener !== 'function') return () => {};
  if (globalListeners.has(target)) return globalListeners.get(target);
  const onError = (event) => {
    const eventTarget = safeProperty(event, 'target');
    if (eventTarget && eventTarget !== target) return;
    void reportError(safeProperty(event, 'error'), { operation: 'UI_GLOBAL', code: 'UI_EXCEPTION', surface, stage: 'global', runtime });
  };
  const onUnhandledRejection = (event) => {
    void reportError(safeProperty(event, 'reason'), { operation: 'UI_GLOBAL', code: 'UNHANDLED_REJECTION', surface, stage: 'global', runtime });
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onUnhandledRejection);
  const uninstall = () => {
    target.removeEventListener?.('error', onError);
    target.removeEventListener?.('unhandledrejection', onUnhandledRejection);
    globalListeners.delete(target);
  };
  globalListeners.set(target, uninstall);
  return uninstall;
}

function downloadJson(bundle) {
  if (!bundle || typeof bundle !== 'object') throw new Error('错误日志内容为空。');
  const content = JSON.stringify(bundle, null, 2);
  if (!content) throw new Error('错误日志内容无法生成。');
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `creator-assistant-error-log-${date}.json`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportDiagnostics({
  runtime = globalThis.chrome?.runtime,
  download = downloadJson,
  notify = () => {},
  button = null,
  timeoutMs = 15_000,
} = {}) {
  if (button) button.disabled = true;
  try {
    if (!runtime?.id || typeof runtime.sendMessage !== 'function') throw new Error('插件运行环境暂不可用。');
    let timeoutId = 0;
    let result;
    try {
      result = await Promise.race([
        runtime.sendMessage({ type: 'DIAGNOSTICS_EXPORT' }),
        new Promise((_, reject) => { timeoutId = globalThis.setTimeout(() => reject(new Error('日志服务响应超时。')), timeoutMs); }),
      ]);
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
    if (!result?.ok) throw new Error('日志服务暂不可用。');
    download(result.bundle);
    const successMessage = result.bundle?.persistence?.mode === 'memory-only'
      ? '错误日志已下载。当前日志只能临时保留，可能丢失，请及时导出。'
      : '错误日志已下载。';
    try { notify(successMessage, 'success'); } catch { /* feedback must not change export state */ }
    return true;
  } catch {
    try { notify('导出错误日志失败，请稍后重试。', 'error'); } catch { /* feedback must not recurse */ }
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}
