import { diagnosticSurface, installGlobalErrorListeners, isDiagnosticLogged, markDiagnosticLogged, reportError } from './diagnostics-ui.mjs';

const surface = diagnosticSurface();
const diagnosticCommands = new Set(['DIAGNOSTICS_RECORD', 'DIAGNOSTICS_EXPORT', 'DIAGNOSTICS_SUMMARY']);
installGlobalErrorListeners(globalThis.window, { surface });

function recordRequestFailure(type, error) {
  if (diagnosticCommands.has(type)) {
    markDiagnosticLogged(error);
    return;
  }
  if (!isDiagnosticLogged(error)) {
    void reportError(error, { operation: type, code: 'REQUEST_FAILED', surface, stage: 'request' });
  }
}

export async function request(type, payload = {}) {
  try {
    if (!globalThis.chrome?.runtime?.id) throw new Error('请先在 Chrome 或 Edge 中加载插件，再从插件图标打开工作台。');
    const result = await chrome.runtime.sendMessage({ ...payload, type });
    if (!result?.ok) {
      const error = new Error(result?.error || '插件暂时没有响应，请重新打开后再试。');
      if (result?.diagnosticLogged === true) markDiagnosticLogged(error);
      else recordRequestFailure(type, error);
      throw error;
    }
    return result;
  } catch (error) {
    recordRequestFailure(type, error);
    throw error;
  }
}
