import { request } from './ui-api.mjs';
import { safePlatformUrl, toCSV } from './lib/core.mjs';
import { exportDiagnostics, isDiagnosticLogged, reportError } from './diagnostics-ui.mjs';

const PLATFORM_LABELS = { douyin: '抖音', kuaishou: '快手', xiaohongshu: '小红书', weixin: '视频号' };
const PLATFORM_MARKS = { douyin: '抖', kuaishou: '快', xiaohongshu: '红', weixin: '视' };
const PLATFORM_HOST_ROOTS = {
  douyin: ['douyin.com', 'iesdouyin.com', 'buyin.jinritemai.com'],
  kuaishou: ['kuaishou.com', 'gifshow.com', 'cps.kwaixiaodian.com'],
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com', 'pgy.xiaohongshu.com'],
  weixin: ['weixin.qq.com', 'mp.weixin.qq.com', 'channels.weixin.qq.com'],
};
const STAGES = ['未跟进', '已联系', '有意向', '已寄样', '已合作', '暂不合作'];
const PAGE_SIZE = 50;
const DRAFT_PICKER_PAGE_SIZE = 30;
const DEFAULT_TEMPLATE = '你好 {name}，关注到你在{platform}分享的内容，想和你聊聊合作。';
const ICON_PENCIL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5.5 4 4M4 20l4.2-.9L19 8.3a2.1 2.1 0 0 0-3-3L5.2 16.1 4 20Z"/></svg>';
const ICON_OPEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 5h6v6M19 5l-9 9"/><path d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

const dom = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));
let state = { version: 1, creators: [], drafts: [], presets: [], settings: { owner: '我' } };
let currentView = 'library';
let currentPage = 1;
let draftPickerPage = 1;
let draftPickerSearch = '';
let selectedCreatorIds = new Set();
let selectedDraftCreatorIds = new Set();
let currentCapture = null;
let captureTabs = [];
let selectedCandidateIds = new Set();
let candidateById = new Map();
let editingCreatorId = '';
let toastTimer = 0;
let stateReadPromise = null;
let stateRefreshTimer = 0;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function platformLabel(platform) { return PLATFORM_LABELS[platform] || '未知平台'; }
function stageClass(stage) { return `stage-${STAGES.indexOf(stage) >= 0 ? STAGES.indexOf(stage) : 0}`; }
function creatorKey(creator) { return creator?.id || `${creator?.platform || ''}:${creator?.externalId || ''}`; }
function notify(message, kind = 'success') {
  dom['toast-region'].innerHTML = `<div class="toast toast-${kind}" role="${kind === 'error' ? 'alert' : 'status'}"><span class="toast-mark" aria-hidden="true">${kind === 'error' ? '!' : '✓'}</span><span>${escapeHtml(message)}</span><button type="button" class="toast-close" aria-label="关闭提示">×</button></div>`;
  dom['toast-region'].querySelector('.toast-close')?.addEventListener('click', () => { dom['toast-region'].replaceChildren(); });
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => dom['toast-region'].replaceChildren(), 4800);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function safeUrl(value) {
  try { return safePlatformUrl(value); } catch { return ''; }
}

function platformForUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return '';
    const host = url.hostname.toLowerCase().replace(/\.$/u, '');
    return Object.entries(PLATFORM_HOST_ROOTS).find(([, roots]) => roots.some((root) => host === root || host.endsWith(`.${root}`)))?.[0] || '';
  } catch {
    return '';
  }
}

function stateFromResponse(response) {
  if (response?.state) state = response.state;
  if (!Array.isArray(state.creators)) state.creators = [];
  if (!Array.isArray(state.drafts)) state.drafts = [];
  if (!Array.isArray(state.presets)) state.presets = [];
  state.settings ||= { owner: '我' };
  const creatorIds = new Set(state.creators.map(creatorKey));
  selectedCreatorIds = new Set([...selectedCreatorIds].filter((id) => creatorIds.has(id)));
  selectedDraftCreatorIds = new Set([...selectedDraftCreatorIds].filter((id) => creatorIds.has(id)));
}

async function runRequest(type, payload = {}) {
  try {
    const result = await request(type, payload);
    stateFromResponse(result);
    renderAll();
    return result;
  } catch (error) {
    notify(error?.message || '操作失败，请重试。', 'error');
    throw error;
  }
}

async function refreshLatestState(showError = false) {
  if (dom['creator-dialog']?.open) return false;
  if (stateReadPromise) return stateReadPromise;
  const pending = request('GET_STATE')
    .then((response) => {
      stateFromResponse(response);
      renderAll();
      return true;
    })
    .catch((error) => {
      if (showError) notify(error?.message || '无法刷新本地数据，请重新打开工作台。', 'error');
      return false;
    });
  stateReadPromise = pending;
  const succeeded = await pending;
  if (stateReadPromise === pending) stateReadPromise = null;
  return succeeded;
}

function scheduleStateRefresh() {
  if (dom['creator-dialog']?.open) return;
  window.clearTimeout(stateRefreshTimer);
  stateRefreshTimer = window.setTimeout(() => { void refreshLatestState(); }, 180);
}

function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setView(view) {
  if (!['library', 'capture', 'drafts', 'presets'].includes(view)) return;
  currentView = view;
  for (const button of document.querySelectorAll('[data-view]')) {
    const active = button.dataset.view === view;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  for (const section of document.querySelectorAll('.view')) {
    const active = section.id === `view-${view}`;
    section.classList.toggle('is-active', active);
    section.hidden = !active;
  }
  const labels = { library: '达人库', capture: '采集当前页面', drafts: '邀约草稿', presets: '筛选书签' };
  dom['breadcrumb-current'].textContent = labels[view];
  if (view === 'capture') refreshTabs();
  if (view === 'drafts') {
    renderDraftPicker();
    renderDrafts();
  }
  if (view === 'presets') renderPresets();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function getFilteredCreators() {
  const query = dom['creator-search'].value.trim().toLocaleLowerCase();
  const platform = dom['platform-filter'].value;
  const stage = dom['stage-filter'].value;
  return state.creators.filter((creator) => {
    if (platform !== 'all' && creator.platform !== platform) return false;
    if (stage !== 'all' && creator.stage !== stage) return false;
    if (!query) return true;
    const searchable = [creator.name, creator.externalId, creator.owner, creator.note, creator.category, creator.contact?.phone, creator.contact?.wechat, creator.contact?.email, ...(creator.tags || [])].join(' ').toLocaleLowerCase();
    return searchable.includes(query);
  }).sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
}

function renderSummary() {
  const creators = state.creators;
  dom['summary-total'].textContent = String(creators.length);
  dom['summary-untracked'].textContent = String(creators.filter((creator) => creator.stage === '未跟进').length);
  dom['summary-partnered'].textContent = String(creators.filter((creator) => creator.stage === '已合作').length);
  dom['nav-creator-count'].textContent = String(creators.length);
  dom['nav-draft-count'].textContent = String(state.drafts.length);
  dom['owner-chip'].textContent = (state.settings?.owner || '我').slice(0, 2);
  dom['owner-chip'].title = `本地默认负责人：${state.settings?.owner || '我'}`;
}

function renderCreatorTable() {
  const filtered = getFilteredCreators();
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);
  dom['creator-result-count'].textContent = filtered.length === state.creators.length
    ? `${state.creators.length} 位达人`
    : `匹配 ${filtered.length} 位，共 ${state.creators.length} 位`;
  dom['creator-empty'].hidden = filtered.length > 0;
  dom['creator-table-wrap'].hidden = filtered.length === 0;
  dom['creator-pagination'].hidden = filtered.length <= PAGE_SIZE;
  dom['creator-empty-title'].textContent = state.creators.length ? '当前筛选下没有匹配达人' : '还没有本地收录的达人';
  dom['creator-empty-description'].textContent = state.creators.length
    ? '调整平台、跟进阶段或搜索词，查看其他本地记录。'
    : '从支持的平台页面采集候选达人，或手工添加一条资料。收录前可先检查候选名单。';
  const contactHtml = (creator) => {
    const count = ['phone', 'wechat', 'email'].filter((key) => creator.contact?.[key]).length;
    return count ? `<span class="contact-summary"><span class="contact-dot"></span>${count} 项联系方式</span>` : '<span class="muted">未填写</span>';
  };
  dom['creator-rows'].innerHTML = visible.map((creator) => {
    const id = creatorKey(creator);
    const selected = selectedCreatorIds.has(id);
    const profile = safeUrl(creator.profileUrl);
    const tags = (creator.tags || []).slice(0, 3).map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join('') || '<span class="muted">—</span>';
    return `<tr>
      <td class="check-column"><label class="table-select-target"><input type="checkbox" data-select-creator="${escapeHtml(id)}" aria-label="选择 ${escapeHtml(creator.name)}" ${selected ? 'checked' : ''} /></label></td>
      <td><div class="creator-cell"><span class="platform-avatar platform-${escapeHtml(creator.platform)}" aria-hidden="true">${escapeHtml(PLATFORM_MARKS[creator.platform] || '达')}</span><div><button class="creator-name-link" type="button" data-edit-creator="${escapeHtml(id)}">${escapeHtml(creator.name)}</button><span class="creator-secondary">账号 ID：${escapeHtml(creator.externalId)}</span></div></div></td>
      <td><span class="platform-label"><i class="platform-dot platform-dot-${escapeHtml(creator.platform)}"></i>${escapeHtml(platformLabel(creator.platform))}</span></td>
      <td><span class="stage-pill ${stageClass(creator.stage)}"><i></i>${escapeHtml(creator.stage)}</span></td>
      <td>${contactHtml(creator)}</td>
      <td>${escapeHtml(creator.owner || '—')}</td>
      <td><div class="tag-list">${tags}</div></td>
      <td class="date-cell">${escapeHtml(formatDate(creator.updatedAt))}</td>
      <td><button class="icon-button row-edit-button" type="button" data-edit-creator="${escapeHtml(id)}" aria-label="编辑 ${escapeHtml(creator.name)}" title="编辑资料">${ICON_PENCIL}</button>${profile ? `<button class="icon-button row-open-button" type="button" data-open-creator="${escapeHtml(id)}" aria-label="打开 ${escapeHtml(creator.name)} 的平台主页" title="打开平台主页">${ICON_OPEN}</button>` : ''}</td>
    </tr>`;
  }).join('');
  const allVisibleSelected = visible.length > 0 && visible.every((creator) => selectedCreatorIds.has(creatorKey(creator)));
  const someVisibleSelected = visible.some((creator) => selectedCreatorIds.has(creatorKey(creator)));
  dom['select-visible-creators'].checked = allVisibleSelected;
  dom['select-visible-creators'].indeterminate = someVisibleSelected && !allVisibleSelected;
  dom['library-bulk-bar'].hidden = selectedCreatorIds.size === 0;
  dom['library-selection-count'].textContent = String(selectedCreatorIds.size);
  dom['page-summary'].textContent = `显示 ${filtered.length ? start + 1 : 0}–${Math.min(start + PAGE_SIZE, filtered.length)}，共 ${filtered.length} 条`;
  dom['page-number'].textContent = `第 ${currentPage} / ${totalPages} 页`;
  dom['previous-page'].disabled = currentPage <= 1;
  dom['next-page'].disabled = currentPage >= totalPages;
}

function renderDraftPicker() {
  const query = draftPickerSearch.toLocaleLowerCase();
  const creators = state.creators.filter((creator) => !query || [creator.name, creator.externalId, platformLabel(creator.platform), ...(creator.tags || [])].join(' ').toLocaleLowerCase().includes(query));
  const totalPages = Math.max(1, Math.ceil(creators.length / DRAFT_PICKER_PAGE_SIZE));
  draftPickerPage = Math.min(draftPickerPage, totalPages);
  const start = (draftPickerPage - 1) * DRAFT_PICKER_PAGE_SIZE;
  const visible = creators.slice(start, start + DRAFT_PICKER_PAGE_SIZE);
  dom['draft-creator-list'].innerHTML = visible.length ? visible.map((creator) => {
    const id = creatorKey(creator);
    return `<label class="draft-creator-row"><input type="checkbox" data-select-draft-creator="${escapeHtml(id)}" ${selectedDraftCreatorIds.has(id) ? 'checked' : ''} /><span class="platform-avatar platform-${escapeHtml(creator.platform)}" aria-hidden="true">${escapeHtml(PLATFORM_MARKS[creator.platform] || '达')}</span><span class="draft-creator-name"><strong>${escapeHtml(creator.name)}</strong><small>${escapeHtml(platformLabel(creator.platform))} · ${escapeHtml(creator.stage)}</small></span><span class="draft-creator-tags">${(creator.tags || []).slice(0, 2).map((tag) => `<i>${escapeHtml(tag)}</i>`).join('')}</span></label>`;
  }).join('') : `<div class="picker-empty">${state.creators.length ? '没有找到匹配的达人。' : '达人库还是空的，先采集或手工添加达人。'}</div>`;
  dom['draft-picker-pagination'].hidden = creators.length <= DRAFT_PICKER_PAGE_SIZE;
  dom['draft-picker-summary'].textContent = `${creators.length ? start + 1 : 0}–${Math.min(start + DRAFT_PICKER_PAGE_SIZE, creators.length)} / ${creators.length} 位`;
  dom['draft-picker-page-number'].textContent = `第 ${draftPickerPage} / ${totalPages} 页`;
  dom['draft-picker-previous'].disabled = draftPickerPage <= 1;
  dom['draft-picker-next'].disabled = draftPickerPage >= totalPages;
  dom['draft-selection-label'].textContent = selectedDraftCreatorIds.size ? `已选择 ${selectedDraftCreatorIds.size} 位达人` : '选择达人后生成草稿';
  dom['generate-drafts-button'].disabled = selectedDraftCreatorIds.size === 0;
}

function statusLabel(status) {
  return ({ pending: '待处理', copied: '已复制', done: '手工标记完成', skipped: '已跳过' })[status] || '待处理';
}

function renderDrafts() {
  const creatorById = new Map(state.creators.map((creator) => [creatorKey(creator), creator]));
  const filter = dom['draft-status-filter'].value;
  const drafts = [...state.drafts].filter((draft) => filter === 'all' || draft.status === filter).sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  dom['draft-result-count'].textContent = `${drafts.length} 条草稿`;
  dom['draft-empty'].hidden = drafts.length > 0;
  dom['draft-list'].innerHTML = drafts.map((draft) => {
    const creator = creatorById.get(draft.creatorId);
    const profile = safeUrl(creator?.profileUrl);
    const title = creator?.name || '达人资料已不存在';
    return `<article class="draft-card">
      <div class="draft-card-heading"><div class="draft-card-creator"><span class="platform-avatar platform-${escapeHtml(creator?.platform || 'douyin')}" aria-hidden="true">${escapeHtml(PLATFORM_MARKS[creator?.platform] || '达')}</span><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(creator ? platformLabel(creator.platform) : '本地草稿')} · 创建于 ${escapeHtml(formatDate(draft.createdAt))}</small></div></div><span class="draft-status status-${escapeHtml(draft.status)}">${escapeHtml(statusLabel(draft.status))}</span></div>
      <p class="draft-text">${escapeHtml(draft.text)}</p>
      <div class="draft-card-actions"><button class="button button-secondary button-small" type="button" data-copy-draft="${escapeHtml(draft.id)}">复制文案</button>${profile ? '<button class="button button-quiet button-small" type="button" data-open-draft-profile="' + escapeHtml(draft.id) + '">打开平台主页</button>' : ''}${draft.status !== 'done' ? `<button class="button button-quiet button-small" type="button" data-mark-draft-done="${escapeHtml(draft.id)}">手工标记完成</button>` : ''}${draft.status !== 'skipped' ? `<button class="button button-quiet button-small" type="button" data-skip-draft="${escapeHtml(draft.id)}">跳过</button>` : ''}<span class="draft-manual-caption">状态由你手工更新</span></div>
    </article>`;
  }).join('');
}

function renderPresets() {
  const presets = [...state.presets].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  dom['preset-result-count'].textContent = `${presets.length} 个书签`;
  dom['preset-empty'].hidden = presets.length > 0;
  dom['preset-list'].innerHTML = presets.map((preset) => {
    const cleanUrl = safeUrl(preset.url);
    let address = '平台地址不可用';
    if (cleanUrl) {
      const url = new URL(cleanUrl);
      address = `${url.hostname}${url.pathname}`;
    }
    return `<article class="preset-card"><div class="preset-icon" aria-hidden="true">☆</div><div class="preset-copy"><strong>${escapeHtml(preset.name)}</strong><span class="preset-platform">${escapeHtml(platformLabel(preset.platform))}</span><small>${escapeHtml(address)}</small><span class="preset-date">保存于 ${escapeHtml(formatDate(preset.createdAt))}</span></div><div class="preset-actions"><button class="button button-secondary button-small" type="button" data-open-preset="${escapeHtml(preset.id)}" ${cleanUrl ? '' : 'disabled'}>打开平台页面</button><button class="icon-button preset-delete" type="button" data-delete-preset="${escapeHtml(preset.id)}" aria-label="删除书签 ${escapeHtml(preset.name)}" title="删除书签">×</button></div></article>`;
  }).join('');
}

function renderAll() {
  renderSummary();
  renderCreatorTable();
  renderDraftPicker();
  renderDrafts();
  renderPresets();
}

function setCaptureFeedback(message, kind = 'info') {
  dom['capture-feedback'].textContent = message;
  dom['capture-feedback'].className = `capture-feedback ${kind === 'error' ? 'is-error' : kind === 'success' ? 'is-success' : ''}`;
  dom['capture-feedback'].hidden = !message;
}

async function refreshTabs() {
  dom['capture-tab-select'].replaceChildren(new Option('正在读取已打开的平台标签页…', ''));
  dom['capture-tab-select'].disabled = true;
  dom['read-capture-button'].disabled = true;
  try {
    const response = await request('LIST_TABS');
    captureTabs = Array.isArray(response.tabs) ? response.tabs : [];
    dom['capture-tab-select'].replaceChildren(new Option(captureTabs.length ? '请选择一个平台标签页' : '未找到支持的平台标签页', ''));
    for (const tab of captureTabs) {
      const option = new Option(`${platformLabel(tab.platform)} · ${tab.title || new URL(tab.url).hostname}`, String(tab.id));
      option.dataset.platform = tab.platform;
      dom['capture-tab-select'].add(option);
    }
    dom['capture-tab-select'].disabled = captureTabs.length === 0;
    setCaptureFeedback(captureTabs.length ? '请选择要读取的标签页；工作台不会自动切换到其他页面。' : '请先在抖音、快手、小红书或视频号平台页面打开一个标签页。');
  } catch (error) {
    captureTabs = [];
    dom['capture-tab-select'].replaceChildren(new Option('无法读取标签页', ''));
    setCaptureFeedback(error?.message || '读取标签页失败，请重新打开工作台。', 'error');
  }
}

function renderCaptureResults() {
  const hasCapture = Boolean(currentCapture);
  dom['capture-source'].hidden = !hasCapture;
  dom['capture-results'].hidden = !hasCapture;
  dom['capture-empty'].hidden = hasCapture;
  if (!hasCapture) return;
  const tab = currentCapture.tab || {};
  const platform = currentCapture.platform;
  dom['capture-platform-mark'].textContent = PLATFORM_MARKS[platform] || '达';
  dom['capture-source-title'].textContent = tab.title || platformLabel(platform);
  const safeTabUrl = safeUrl(tab.url);
  dom['capture-source-url'].textContent = safeTabUrl ? new URL(safeTabUrl).hostname + new URL(safeTabUrl).pathname : '平台页面地址已隐藏';
  dom['capture-source-platform'].textContent = platformLabel(platform);
  const candidates = Array.isArray(currentCapture.candidates) ? currentCapture.candidates : [];
  candidateById = new Map(candidates.map((candidate) => [creatorKey(candidate), candidate]));
  selectedCandidateIds = new Set([...selectedCandidateIds].filter((id) => candidateById.has(id)));
  dom['capture-result-count'].textContent = `${candidates.length} 位候选`;
  dom['candidate-list'].innerHTML = candidates.length ? candidates.map((candidate) => {
    const id = creatorKey(candidate);
    const existing = state.creators.some((creator) => creatorKey(creator) === id);
    const profile = safeUrl(candidate.profileUrl);
    const followers = Number.isSafeInteger(candidate.followers) ? candidate.followers.toLocaleString('zh-CN') : '';
    return `<label class="candidate-row"><input type="checkbox" data-select-candidate="${escapeHtml(id)}" ${selectedCandidateIds.has(id) ? 'checked' : ''} /><span class="platform-avatar platform-${escapeHtml(platform)}" aria-hidden="true">${escapeHtml(PLATFORM_MARKS[platform] || '达')}</span><span class="candidate-main"><strong>${escapeHtml(candidate.name || '未命名达人')}</strong><small>账号 ID：${escapeHtml(candidate.externalId || '—')}${followers ? ` · ${escapeHtml(followers)} 粉丝` : ''}</small></span><span class="candidate-category">${escapeHtml(candidate.category || '未分类')}</span>${existing ? '<span class="existing-badge">已在达人库</span>' : ''}${profile ? '<span class="candidate-profile">平台主页 ↗</span>' : ''}</label>`;
  }).join('') : '<div class="candidate-no-results"><strong>当前页面没有可收录候选</strong><span>尝试在平台的达人列表页打开内容后重新读取。</span></div>';
  const diagnostics = Array.isArray(currentCapture.diagnostics) ? currentCapture.diagnostics.filter(Boolean) : [];
  if (diagnostics.length) setCaptureFeedback(diagnostics.join(' · '), 'info');
  else if (!candidates.length) setCaptureFeedback('读取完成，没有识别到候选达人。', 'info');
  dom['selected-candidate-count'].textContent = String(selectedCandidateIds.size);
  dom['save-candidates-button'].disabled = selectedCandidateIds.size === 0;
}

async function readSelectedTab() {
  const tabId = Number(dom['capture-tab-select'].value);
  if (!Number.isSafeInteger(tabId)) {
    setCaptureFeedback('请先选择一个支持的平台标签页。', 'error');
    dom['capture-tab-select'].focus();
    return;
  }
  const tab = captureTabs.find((item) => Number(item.id) === tabId);
  if (!tab) {
    setCaptureFeedback('所选标签页已关闭或已变化，请刷新列表后重新选择。', 'error');
    return;
  }
  currentCapture = null;
  selectedCandidateIds.clear();
  renderCaptureResults();
  dom['read-capture-button'].disabled = true;
  setCaptureFeedback('正在读取所选页面的候选资料…');
  try {
    currentCapture = await request('GET_ACTIVE_CAPTURE', { tabId });
    renderCaptureResults();
    const diagnostics = Array.isArray(currentCapture.diagnostics) ? currentCapture.diagnostics.filter(Boolean) : [];
    const diagnosticText = diagnostics.length ? `页面提示：${diagnostics.join('；')}` : '确认勾选后再收录。';
    setCaptureFeedback(`已读取 ${currentCapture.candidates?.length || 0} 位候选。${diagnosticText}`);
  } catch (error) {
    currentCapture = null;
    renderCaptureResults();
    setCaptureFeedback(error?.message || '无法读取此页面，请刷新平台标签页后重试。', 'error');
  } finally {
    dom['read-capture-button'].disabled = !captureTabs.length;
  }
}

async function saveSelectedCandidates() {
  const creators = [...selectedCandidateIds].map((id) => candidateById.get(id)).filter(Boolean);
  if (!creators.length) return;
  const button = dom['save-candidates-button'];
  button.disabled = true;
  dom['save-candidate-label'].textContent = '正在收录…';
  try {
    const result = await runRequest('UPSERT_CREATORS', { creators });
    const added = Number(result.added) || 0;
    const updated = Number(result.updated) || 0;
    selectedCandidateIds.clear();
    renderCaptureResults();
    dom['capture-save-receipt'].hidden = false;
    dom['capture-save-receipt'].textContent = added || updated
      ? `本地收录完成：新增 ${added} 位，更新 ${updated} 位。资料保存在此浏览器。`
      : '所选候选已在达人库中；现有资料保持不变。';
    setCaptureFeedback('候选收录已完成。', 'success');
  } catch {
    // runRequest already reports the concrete error.
  } finally {
    dom['save-candidate-label'].textContent = '收录所选';
    button.disabled = selectedCandidateIds.size === 0;
  }
}

async function openSafeUrl(rawUrl, context = '平台地址') {
  const url = safeUrl(rawUrl);
  if (!url) {
    notify(`${context}不在支持的平台地址范围内。`, 'error');
    return false;
  }
  try {
    if (!globalThis.chrome?.tabs?.create) throw new Error('当前环境无法打开新标签页，请从插件工作台内重试。');
    await chrome.tabs.create({ url });
    return true;
  } catch (error) {
    void reportError(error, { operation: 'OPEN_PLATFORM', code: 'REQUEST_FAILED', surface: 'app', stage: 'open' });
    notify(error?.message || '无法打开平台页面，请重试。', 'error');
    return false;
  }
}

async function savePreset() {
  const tabId = Number(dom['capture-tab-select'].value);
  const tab = captureTabs.find((item) => Number(item.id) === tabId);
  if (!tab) {
    setCaptureFeedback('请先选择一个支持的平台标签页。', 'error');
    return;
  }
  const name = dom['preset-name-input'].value.trim();
  if (!name) {
    dom['preset-name-input'].focus();
    notify('请先为筛选书签填写名称。', 'error');
    return;
  }
  const button = dom['save-preset-button'];
  dom['preset-save-receipt'].hidden = true;
  const showReceipt = (title, address, error = false) => {
    dom['preset-save-receipt-title'].textContent = title;
    dom['preset-save-receipt-address'].textContent = address;
    dom['preset-save-receipt'].classList.toggle('is-error', error);
    dom['preset-save-receipt'].setAttribute('role', error ? 'alert' : 'status');
    dom['preset-save-receipt'].hidden = false;
  };
  button.disabled = true;
  button.textContent = '读取页面地址…';
  let liveTab;
  try {
    if (!globalThis.chrome?.tabs?.get) throw new Error('当前环境无法读取标签页地址，请重新打开工作台后重试。');
    liveTab = await chrome.tabs.get(tabId);
  } catch {
    showReceipt('未能保存书签', '所选标签页已关闭或无法读取，请刷新标签页列表后重新选择。', true);
    button.disabled = false;
    button.textContent = '保存当前页面';
    return;
  }
  const currentPlatform = platformForUrl(liveTab?.url);
  if (!currentPlatform || currentPlatform !== tab.platform) {
    showReceipt('未能保存书签', currentPlatform ? '所选标签页已切换到其他平台，请刷新标签页列表后重新选择。' : '当前地址不是受支持的 HTTPS 平台地址，不能保存为书签。', true);
    button.disabled = false;
    button.textContent = '保存当前页面';
    return;
  }
  const url = safeUrl(liveTab.url);
  if (!url) {
    showReceipt('未能保存书签', '当前平台地址暂不符合安全规则，不能保存为书签。', true);
    button.disabled = false;
    button.textContent = '保存当前页面';
    return;
  }
  try {
    const response = await request('SAVE_PRESET', { preset: { name, platform: tab.platform, url } });
    stateFromResponse(response);
    renderAll();
    dom['preset-name-input'].value = '';
    showReceipt('已保存的安全地址', url);
    setCaptureFeedback('筛选书签已保存在本地，已显示清理后的地址。', 'success');
    notify('筛选书签已保存在本地。');
  } catch (error) {
    showReceipt('未能保存书签', error?.message || '保存失败，请检查平台地址后重试。', true);
  } finally {
    button.disabled = false;
    button.textContent = '保存当前页面';
  }
}

function openCreatorDialog(creator = null) {
  editingCreatorId = creator ? creatorKey(creator) : '';
  const editing = Boolean(creator);
  dom['creator-dialog-title'].textContent = editing ? '编辑达人' : '新建达人';
  dom['creator-dialog-description'].textContent = editing ? '更新本地资料与跟进信息。' : '信息保存在本地达人库。';
  dom['creator-form-error'].hidden = true;
  dom['creator-form'].reset();
  dom['creator-platform'].value = creator?.platform || 'douyin';
  dom['creator-name'].value = creator?.name || '';
  dom['creator-external-id'].value = creator?.externalId || '';
  dom['creator-profile-url'].value = creator?.profileUrl || '';
  dom['creator-phone'].value = creator?.contact?.phone || '';
  dom['creator-wechat'].value = creator?.contact?.wechat || '';
  dom['creator-email'].value = creator?.contact?.email || '';
  dom['creator-stage'].value = creator?.stage || '未跟进';
  dom['creator-owner'].value = creator?.owner || state.settings?.owner || '我';
  dom['creator-tags'].value = (creator?.tags || []).join('，');
  dom['creator-note'].value = creator?.note || '';
  dom['creator-platform'].disabled = editing;
  dom['creator-external-id'].readOnly = editing;
  dom['creator-external-id'].setAttribute('aria-readonly', String(editing));
  dom['save-creator-button'].textContent = editing ? '保存修改' : '保存达人';
  dom['creator-dialog'].showModal();
  window.setTimeout(() => dom['creator-name'].focus(), 20);
}

function validateForm() {
  const platform = dom['creator-platform'].value;
  const name = dom['creator-name'].value.trim();
  const externalId = dom['creator-external-id'].value.trim();
  const profileRaw = dom['creator-profile-url'].value.trim();
  if (!name) throw new Error('请填写达人名称。');
  if (!externalId) throw new Error('请填写平台账号 ID。');
  if (/[:\u0000-\u001f\u007f]/u.test(externalId)) throw new Error('账号 ID 不能包含冒号或控制字符。');
  const profileUrl = profileRaw ? safeUrl(profileRaw) : '';
  if (profileRaw && !profileUrl) throw new Error('主页链接必须是支持平台的 HTTPS 地址。');
  const tags = [...new Set(dom['creator-tags'].value.split(/[,，]/u).map((tag) => tag.trim()).filter(Boolean))];
  return {
    platform,
    externalId,
    name,
    profileUrl,
    contact: { phone: dom['creator-phone'].value.trim(), wechat: dom['creator-wechat'].value.trim(), email: dom['creator-email'].value.trim() },
    stage: dom['creator-stage'].value,
    owner: dom['creator-owner'].value.trim(),
    tags,
    note: dom['creator-note'].value.trim(),
  };
}

async function submitCreatorForm(event) {
  event.preventDefault();
  dom['creator-form-error'].hidden = true;
  let creator;
  try { creator = validateForm(); }
  catch (error) {
    dom['creator-form-error'].textContent = error.message;
    dom['creator-form-error'].hidden = false;
    return;
  }
  dom['save-creator-button'].disabled = true;
  try {
    if (editingCreatorId) {
      await runRequest('UPDATE_CREATOR', { id: editingCreatorId, patch: creator });
      dom['creator-dialog'].close();
      notify('达人资料已更新。');
    } else {
      const response = await runRequest('UPSERT_CREATORS', { creators: [creator] });
      dom['creator-dialog'].close();
      currentPage = 1;
      const duplicate = Number(response.added) === 0;
      notify(duplicate ? '已合并到现有达人记录。' : '达人已添加到本地库。');
    }
  } catch (error) {
    dom['creator-form-error'].textContent = error?.message || '保存失败，请检查表单后重试。';
    dom['creator-form-error'].hidden = false;
  } finally {
    dom['save-creator-button'].disabled = false;
  }
}

async function generateDrafts() {
  const ids = [...selectedDraftCreatorIds];
  const template = dom['draft-template'].value.trim();
  if (!ids.length) return;
  if (!template) {
    dom['draft-template'].focus();
    notify('请先填写邀约模板。', 'error');
    return;
  }
  const before = state.drafts.length;
  try {
    await runRequest('ADD_DRAFTS', { ids, template });
    const added = Math.max(0, state.drafts.length - before);
    selectedDraftCreatorIds.clear();
    renderDraftPicker();
    notify(added ? `已为 ${added} 位达人生成本地草稿。` : '所选达人已有待处理草稿，没有重复生成。');
  } catch {
    // runRequest reports the error.
  }
}

async function copyDraft(draft) {
  try {
    await navigator.clipboard.writeText(draft.text);
  } catch {
    const temporary = document.createElement('textarea');
    temporary.value = draft.text;
    temporary.setAttribute('readonly', '');
    temporary.style.position = 'fixed';
    temporary.style.opacity = '0';
    let copied = false;
    let copyError = null;
    try {
      document.body.append(temporary);
      temporary.select();
      copied = document.execCommand('copy');
    } catch (error) {
      copyError = error;
    } finally {
      try { temporary.remove(); } catch (error) { copyError ||= error; }
    }
    if (!copied) {
      void reportError(copyError || new Error('草稿复制失败。'), { operation: 'COPY_DRAFT', code: 'UI_EXCEPTION', surface: 'app', stage: 'copy' });
      notify('无法复制文案，请手动选择并复制草稿内容。', 'error');
      return;
    }
  }
  try {
    await runRequest('UPDATE_DRAFT', { id: draft.id, status: 'copied' });
    notify('草稿已复制。请到平台内确认并发送。');
  } catch {
    // runRequest reports the error.
  }
}

function exportCreators(creators, filename = 'creator-assistant-creators.csv') {
  try {
    downloadFile(filename, toCSV(creators), 'text/csv;charset=utf-8');
    notify(`已导出 ${creators.length} 条 CSV 记录。`);
  } catch (error) {
    void reportError(error, { operation: 'EXPORT_CSV', code: 'UI_EXCEPTION', surface: 'app', stage: 'download' });
    notify(error?.message || 'CSV 导出失败。', 'error');
  }
}

async function exportBackup() {
  if (!await refreshLatestState(true)) return;
  try {
    const backup = JSON.stringify(state);
    const date = new Date().toISOString().slice(0, 10);
    downloadFile(`达人助手-本地备份-${date}.json`, backup, 'application/json;charset=utf-8');
    notify('JSON 备份已下载到本机。');
  } catch (error) {
    void reportError(error, { operation: 'EXPORT_BACKUP', code: 'UI_EXCEPTION', surface: 'app', stage: 'download' });
    notify('JSON 备份下载失败，请重试。', 'error');
  }
}

async function exportCurrentCsv(selectedOnly = false) {
  if (!await refreshLatestState(true)) return;
  const selected = state.creators.filter((creator) => selectedCreatorIds.has(creatorKey(creator)));
  const creators = selectedOnly || selectedCreatorIds.size ? selected : getFilteredCreators();
  exportCreators(creators, selectedOnly || selectedCreatorIds.size ? '达人助手-所选达人.csv' : '达人助手-当前筛选.csv');
}

async function importBackup(file) {
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('备份文件不能超过 5 MB。');
    const contents = await file.text();
    await runRequest('IMPORT_STATE', { data: contents });
    notify(`合并完成：当前达人库共 ${state.creators.length} 位。现有本地资料未清空。`);
  } catch (error) {
    if (!isDiagnosticLogged(error) && error?.message !== '备份文件不能超过 5 MB。') {
      void reportError(error, { operation: 'IMPORT_BACKUP', code: 'UI_EXCEPTION', surface: 'app', stage: 'import' });
    }
    notify(error?.message || '导入失败，请确认文件是有效的达人助手 JSON 备份。', 'error');
  } finally {
    dom['import-json-input'].value = '';
  }
}

function wireEvents() {
  for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => setView(button.dataset.view));
  for (const button of document.querySelectorAll('[data-go-view]')) button.addEventListener('click', () => setView(button.dataset.goView));
  dom['creator-search'].addEventListener('input', () => { currentPage = 1; renderCreatorTable(); });
  dom['platform-filter'].addEventListener('change', () => { currentPage = 1; renderCreatorTable(); });
  dom['stage-filter'].addEventListener('change', () => { currentPage = 1; renderCreatorTable(); });
  dom['reset-filters'].addEventListener('click', () => {
    dom['creator-search'].value = '';
    dom['platform-filter'].value = 'all';
    dom['stage-filter'].value = 'all';
    currentPage = 1;
    renderCreatorTable();
  });
  dom['creator-rows'].addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-select-creator]');
    if (!checkbox) return;
    const id = checkbox.dataset.selectCreator;
    if (checkbox.checked) selectedCreatorIds.add(id); else selectedCreatorIds.delete(id);
    renderCreatorTable();
  });
  dom['creator-rows'].addEventListener('click', (event) => {
    const edit = event.target.closest('[data-edit-creator]');
    if (edit) {
      const creator = state.creators.find((item) => creatorKey(item) === edit.dataset.editCreator);
      if (creator) openCreatorDialog(creator);
      return;
    }
    const open = event.target.closest('[data-open-creator]');
    if (open) {
      const creator = state.creators.find((item) => creatorKey(item) === open.dataset.openCreator);
      if (creator) void openSafeUrl(creator.profileUrl, '达人主页');
    }
  });
  dom['select-visible-creators'].addEventListener('change', (event) => {
    const filtered = getFilteredCreators();
    const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
    for (const creator of visible) {
      const id = creatorKey(creator);
      if (event.target.checked) selectedCreatorIds.add(id); else selectedCreatorIds.delete(id);
    }
    renderCreatorTable();
  });
  dom['previous-page'].addEventListener('click', () => { currentPage = Math.max(1, currentPage - 1); renderCreatorTable(); });
  dom['next-page'].addEventListener('click', () => { currentPage += 1; renderCreatorTable(); });
  dom['clear-library-selection'].addEventListener('click', () => { selectedCreatorIds.clear(); renderCreatorTable(); });
  dom['bulk-csv-button'].addEventListener('click', () => { void exportCurrentCsv(true); });
  dom['export-csv-button'].addEventListener('click', () => { void exportCurrentCsv(false); });
  dom['bulk-draft-button'].addEventListener('click', () => {
    selectedDraftCreatorIds = new Set(selectedCreatorIds);
    draftPickerSearch = '';
    dom['draft-creator-search'].value = '';
    draftPickerPage = 1;
    setView('drafts');
    notify(`已将 ${selectedDraftCreatorIds.size} 位达人带到邀约草稿。`);
  });
  dom['backup-button'].addEventListener('click', exportBackup);
  dom['diagnostics-export-button'].addEventListener('click', () => {
    void exportDiagnostics({ button: dom['diagnostics-export-button'], notify: (message, kind) => notify(message, kind === 'error' ? 'error' : 'success') });
  });
  dom['import-json-input'].addEventListener('change', (event) => importBackup(event.target.files?.[0]));
  dom['add-creator-button'].addEventListener('click', () => openCreatorDialog());
  dom['empty-add-creator-button'].addEventListener('click', () => openCreatorDialog());
  dom['close-creator-dialog'].addEventListener('click', () => dom['creator-dialog'].close());
  dom['cancel-creator-dialog'].addEventListener('click', () => dom['creator-dialog'].close());
  dom['creator-form'].addEventListener('submit', submitCreatorForm);
  dom['creator-dialog'].addEventListener('click', (event) => { if (event.target === dom['creator-dialog']) dom['creator-dialog'].close(); });

  dom['capture-tab-select'].addEventListener('change', () => {
    currentCapture = null;
    selectedCandidateIds.clear();
    dom['capture-save-receipt'].hidden = true;
    dom['preset-save-receipt'].hidden = true;
    renderCaptureResults();
    setCaptureFeedback('已选择标签页；请点击“读取当前页面”开始采集。');
    dom['read-capture-button'].disabled = !dom['capture-tab-select'].value;
  });
  dom['read-capture-button'].addEventListener('click', readSelectedTab);
  dom['refresh-tabs-button'].addEventListener('click', refreshTabs);
  dom['candidate-list'].addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-select-candidate]');
    if (!checkbox) return;
    const id = checkbox.dataset.selectCandidate;
    if (checkbox.checked) selectedCandidateIds.add(id); else selectedCandidateIds.delete(id);
    renderCaptureResults();
  });
  dom['select-all-candidates'].addEventListener('click', () => { selectedCandidateIds = new Set(candidateById.keys()); renderCaptureResults(); });
  dom['clear-candidates'].addEventListener('click', () => { selectedCandidateIds.clear(); renderCaptureResults(); });
  dom['save-candidates-button'].addEventListener('click', saveSelectedCandidates);
  dom['save-preset-button'].addEventListener('click', savePreset);
  dom['preset-name-input'].addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); savePreset(); } });

  dom['draft-creator-search'].addEventListener('input', (event) => { draftPickerSearch = event.target.value.trim(); draftPickerPage = 1; renderDraftPicker(); });
  dom['draft-creator-list'].addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-select-draft-creator]');
    if (!checkbox) return;
    const id = checkbox.dataset.selectDraftCreator;
    if (checkbox.checked) selectedDraftCreatorIds.add(id); else selectedDraftCreatorIds.delete(id);
    renderDraftPicker();
  });
  dom['draft-picker-previous'].addEventListener('click', () => { draftPickerPage = Math.max(1, draftPickerPage - 1); renderDraftPicker(); });
  dom['draft-picker-next'].addEventListener('click', () => { draftPickerPage += 1; renderDraftPicker(); });
  dom['select-all-draft-creators'].addEventListener('click', () => {
    const query = draftPickerSearch.toLocaleLowerCase();
    const matches = state.creators.filter((creator) => !query || [creator.name, creator.externalId, platformLabel(creator.platform), ...(creator.tags || [])].join(' ').toLocaleLowerCase().includes(query));
    const allSelected = matches.length > 0 && matches.every((creator) => selectedDraftCreatorIds.has(creatorKey(creator)));
    for (const creator of matches) {
      const id = creatorKey(creator);
      if (allSelected) selectedDraftCreatorIds.delete(id); else selectedDraftCreatorIds.add(id);
    }
    renderDraftPicker();
  });
  dom['generate-drafts-button'].addEventListener('click', generateDrafts);
  dom['draft-status-filter'].addEventListener('change', renderDrafts);
  dom['draft-list'].addEventListener('click', async (event) => {
    const copy = event.target.closest('[data-copy-draft]');
    if (copy) {
      const draft = state.drafts.find((item) => item.id === copy.dataset.copyDraft);
      if (draft) await copyDraft(draft);
      return;
    }
    const done = event.target.closest('[data-mark-draft-done]');
    const skip = event.target.closest('[data-skip-draft]');
    if (done || skip) {
      const id = done?.dataset.markDraftDone || skip?.dataset.skipDraft;
      try {
        await runRequest('UPDATE_DRAFT', { id, status: done ? 'done' : 'skipped' });
        notify(done ? '已手工标记为完成；平台没有验证发送状态。' : '草稿已标记为跳过。');
      } catch { /* error is shown by runRequest */ }
      return;
    }
    const open = event.target.closest('[data-open-draft-profile]');
    if (open) {
      const draft = state.drafts.find((item) => item.id === open.dataset.openDraftProfile);
      const creator = state.creators.find((item) => creatorKey(item) === draft?.creatorId);
      if (creator) void openSafeUrl(creator.profileUrl, '达人主页');
    }
  });
  dom['preset-list'].addEventListener('click', async (event) => {
    const open = event.target.closest('[data-open-preset]');
    if (open) {
      const preset = state.presets.find((item) => item.id === open.dataset.openPreset);
      if (preset) void openSafeUrl(preset.url, '筛选书签');
      return;
    }
    const remove = event.target.closest('[data-delete-preset]');
    if (remove) {
      try {
        await runRequest('REMOVE_PRESET', { id: remove.dataset.deletePreset });
        notify('筛选书签已删除。');
      } catch { /* error is shown by runRequest */ }
    }
  });
  window.addEventListener('focus', scheduleStateRefresh);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleStateRefresh(); });
}

async function initialize() {
  wireEvents();
  dom['draft-template'].value = DEFAULT_TEMPLATE;
  try {
    const response = await request('GET_STATE');
    stateFromResponse(response);
    renderAll();
  } catch (error) {
    renderAll();
    notify(error?.message || '无法读取本地数据，请重新打开工作台。', 'error');
  }
}

initialize();
