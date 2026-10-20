import { request } from './ui-api.mjs';
import { safePlatformUrl } from './lib/core.mjs';
import { exportDiagnostics } from './diagnostics-ui.mjs';

const labels = { douyin: '抖', kuaishou: '快', xiaohongshu: '红', weixin: '视' };
const popup = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));
let capture = null;

function setFeedback(message, error = false) {
  popup['popup-feedback'].textContent = message;
  popup['popup-feedback'].classList.toggle('is-error', error);
}

async function readActivePage() {
  popup['popup-save-button'].disabled = true;
  popup['popup-source'].hidden = true;
  popup['popup-preview'].hidden = true;
  setFeedback('正在读取当前标签页…');
  try {
    capture = await request('GET_ACTIVE_CAPTURE');
    const candidates = Array.isArray(capture.candidates) ? capture.candidates : [];
    popup['popup-platform-mark'].textContent = labels[capture.platform] || '达';
    popup['popup-page-title'].textContent = capture.tab?.title || '平台页面';
    const safeUrl = safePlatformUrl(capture.tab?.url || '');
    popup['popup-page-url'].textContent = safeUrl ? new URL(safeUrl).hostname + new URL(safeUrl).pathname : '平台地址已隐藏';
    popup['popup-source'].hidden = false;
    popup['popup-count'].textContent = String(candidates.length);
    popup['popup-summary'].textContent = candidates.length
      ? '已读取此标签页本次加载的达人资料；确认数量后可一键收录到本地。'
      : '页面已读取，但没有识别到候选达人。可在平台达人列表页重试。';
    popup['popup-preview'].hidden = false;
    popup['popup-save-button'].disabled = candidates.length === 0;
    setFeedback(candidates.length ? '页面读取完成。' : '当前页面没有可收录候选。');
  } catch (error) {
    capture = null;
    setFeedback(error?.message || '无法读取当前页面，请打开支持的平台达人页后重试。', true);
  }
}

popup['popup-save-button'].addEventListener('click', async () => {
  const creators = capture?.candidates || [];
  if (!creators.length) return;
  popup['popup-save-button'].disabled = true;
  setFeedback('正在保存到本地达人库…');
  try {
    const result = await request('UPSERT_CREATORS', { creators });
    setFeedback(`本地收录完成：新增 ${Number(result.added) || 0} 位，更新 ${Number(result.updated) || 0} 位。`);
    popup['popup-save-button'].textContent = '已保存到本地';
  } catch (error) {
    setFeedback(error?.message || '保存失败，请重新打开插件后重试。', true);
    popup['popup-save-button'].disabled = false;
  }
});

popup['popup-open-workbench'].addEventListener('click', async () => {
  try { await request('OPEN_WORKBENCH'); }
  catch (error) { setFeedback(error?.message || '工作台暂时无法打开，请重试。', true); }
});

popup['popup-export-diagnostics-button'].addEventListener('click', () => {
  void exportDiagnostics({
    button: popup['popup-export-diagnostics-button'],
    notify: (message, kind) => {
      const feedback = popup['popup-diagnostics-feedback'];
      feedback.textContent = message;
      feedback.classList.toggle('is-error', kind === 'error');
      feedback.hidden = false;
    },
  });
});

readActivePage();
