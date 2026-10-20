import { request } from './ui-api.mjs';
import { exportDiagnostics, isDiagnosticLogged, reportError } from './diagnostics-ui.mjs';
import { mergeCreators } from './lib/core.mjs';
import { applyInviteTemplate, filterInviteResults, inviteResultsToCSV, recipientReadiness } from './lib/invite-workspace.mjs';

const PLATFORM_LABELS = { douyin: '抖音', weixin: '视频号' };
const PLATFORM_MARKS = { douyin: '抖', weixin: '视' };
const PAGE_SIZE = 30;
const dom = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));

let state = { creators: [] };
let tabs = [];
let activePlatform = '';
let selectedTabId = '';
let step = 1;
let workflowMode = 'new';
let busy = false;
let job = null;
let jobSignature = '';
let jobOperationEpoch = 0;
let runtimeError = '';
let pollTimer = 0;
let toastTimer = 0;

let recipientSearch = '';
let recipientPage = 1;
let recipientStageFilter = 'all';
let recipientReadinessFilter = 'all';
let visibleRecipientIds = [];
let selectedCreatorIds = new Set();
let captureData = null;
let candidateById = new Map();

let options = null;
let optionsError = '';
let optionsLoading = false;
let optionsRequestEpoch = 0;
let optionsRecipientId = '';
let optionsTabId = '';
let inviteConfig = { message: '', contactName: '', phone: '', wechat: '' };
let selectedProductIds = new Set();
let selectedCategoryIds = new Set();
let selectedRightIds = new Set();
let productsById = new Map();
let productKeyword = '';
let productPageCursors = [null];
let productPageIndex = 0;
let productSearchTimer = 0;
let operationTimer = 0;
let inviteTemplates = [];
let inviteTemplatesLoading = false;
let inviteTemplatesError = '';
let inviteTemplateFeedback = '';
let inviteTemplateFeedbackKind = '';
let selectedInviteTemplateId = '';
let inviteTemplateMutationBusy = false;
let inviteTemplateRequestEpoch = 0;
let resultFilter = 'all';
let resultExportBusy = false;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function platformLabel(platform) { return PLATFORM_LABELS[platform] || '未知平台'; }
function creatorId(creator) { return creator?.id || `${creator?.platform || ''}:${creator?.externalId || ''}`; }
function selectedCreators() {
  const selected = new Map();
  const locals = new Map(state.creators.map((creator) => [creatorId(creator), creator]));
  for (const id of selectedCreatorIds) {
    const local = locals.get(id);
    const candidate = candidateById.get(id);
    if (local && candidate) {
      try { selected.set(id, mergeCreators([local], [candidate]).creators[0]); }
      catch { selected.set(id, local); }
    } else if (local) selected.set(id, local);
    else if (candidate?.platform === activePlatform) selected.set(id, candidate);
  }
  return [...selected.values()].filter((creator) => creator.platform === activePlatform);
}
function pad(value) { return String(value).padStart(2, '0'); }
function maskPhone(value) { return value ? `${value.slice(0, 3)}****${value.slice(-4)}` : '未填写'; }
function maskWechat(value) { return value ? `${value.slice(0, 2)}****${value.slice(-2)}` : '未填写'; }
function formatDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date) : '—';
}

function showAlert(message) {
  dom['invite-global-alert'].textContent = message || '';
  dom['invite-global-alert'].hidden = !message;
}
function showToast(message, error = false) {
  dom['invite-toast-region'].innerHTML = `<div class="invite-toast${error ? ' is-error' : ''}" role="${error ? 'alert' : 'status'}"><span>${escapeHtml(message)}</span><button class="invite-toast-close" type="button" aria-label="关闭提示">×</button></div>`;
  dom['invite-toast-region'].querySelector('.invite-toast-close')?.addEventListener('click', () => dom['invite-toast-region'].replaceChildren());
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => dom['invite-toast-region'].replaceChildren(), 4500);
}
function setStepStatus(id, message, kind = '') {
  dom[id].textContent = message;
  dom[id].className = `step-feedback${kind ? ` is-${kind}` : ''}`;
}
function setBusy(value) {
  busy = value;
  dom['invite-platform'].disabled = value;
  dom['invite-tab-select'].disabled = value || !activePlatform || !tabs.some((tab) => tab.platform === activePlatform);
  dom['refresh-invite-tabs'].disabled = value;
  dom['capture-current-page'].disabled = value || !dom['invite-tab-select'].value;
  dom['continue-settings'].disabled = value || selectedCreatorIds.size === 0 || selectedCreatorIds.size > 50 || jobBlocksNew();
  dom['back-to-creators'].disabled = value;
  dom['retry-options'].disabled = value || optionsLoading;
  for (const control of dom['settings-form'].querySelectorAll('input, textarea, button')) control.disabled = value;
  dom['start-invite-button'].disabled = value || !canStartFromCurrentFlow();
  dom['export-invite-job'].disabled = value;
  dom['job-results-filter'].disabled = value || resultExportBusy;
  dom['export-invite-results'].disabled = value || resultExportBusy;
  for (const control of dom['job-actions'].querySelectorAll('button')) control.disabled = value || control.disabled;
  if (value) {
    for (const control of dom['step-creators'].querySelectorAll('input, select, button')) control.disabled = true;
  } else renderRecipients();
  renderInviteTemplates();
}

function isLegacyJob() { return Boolean(job && job.flowVersion !== 2); }
function hasUnresolvedJobItem() { return Boolean(job?.items?.some((item) => ['sending', 'unknown'].includes(item.status))); }
function jobBlocksNew() { return Boolean(runtimeError || (job && (job.status === 'running' || hasUnresolvedJobItem()))); }
function resumeExistingJob() {
  return Boolean(!runtimeError && workflowMode === 'resume' && job?.flowVersion === 2 && ['prepared', 'paused'].includes(job.status) && !hasUnresolvedJobItem());
}
function canStartFromCurrentFlow() {
  if (busy) return false;
  if (workflowMode === 'resume') return resumeExistingJob() && Boolean(job?.approvalToken) && Date.parse(job?.expiresAt) > Date.now();
  return isInviteConfigValid();
}

function renderTabs() {
  const previous = dom['invite-tab-select'].value;
  const available = tabs.filter((tab) => tab.platform === activePlatform);
  dom['invite-tab-select'].replaceChildren(new Option(!activePlatform ? '先选择平台' : available.length ? '选择已打开的平台页' : `没有已打开的${platformLabel(activePlatform)}页`, ''));
  for (const tab of available) {
    let host = tab.title || '官方平台页';
    try { host = new URL(tab.url).hostname; } catch { /* background only returns known platform URLs */ }
    dom['invite-tab-select'].add(new Option(`${tab.title || host} · ${host}`, String(tab.id)));
  }
  const keep = available.some((tab) => String(tab.id) === previous);
  dom['invite-tab-select'].value = keep ? previous : '';
  if (keep) selectedTabId = previous;
  else if (!available.some((tab) => String(tab.id) === selectedTabId)) selectedTabId = '';
  dom['invite-tab-select'].disabled = busy || !activePlatform || available.length === 0;
  dom['capture-current-page'].disabled = busy || !dom['invite-tab-select'].value;
}

function resetOptions({ clearInput = false } = {}) {
  optionsRequestEpoch += 1;
  optionsLoading = false;
  window.clearTimeout(productSearchTimer);
  options = null;
  optionsError = '';
  optionsRecipientId = '';
  optionsTabId = '';
  selectedProductIds.clear();
  selectedCategoryIds.clear();
  selectedRightIds.clear();
  productsById.clear();
  productKeyword = '';
  productPageCursors = [null];
  productPageIndex = 0;
  if (clearInput) {
    inviteConfig = { message: '', contactName: '', phone: '', wechat: '' };
    dom['invite-message'].value = '';
    dom['contact-name'].value = '';
    dom['contact-phone'].value = '';
    dom['contact-wechat'].value = '';
    dom['invite-interval'].value = '30';
    dom['product-search'].value = '';
  }
  renderSettings();
}

function recipientReady(creator) {
  try { return recipientReadiness(creator); }
  catch { return { ready: false, reason: '邀请资料不完整，无法识别平台邀请 ID。' }; }
}

function recipientControlsLocked() { return busy || workflowMode === 'resume' || jobBlocksNew(); }

function renderRecipients() {
  const localRows = state.creators.filter((creator) => creator.platform === activePlatform).map((creator) => ({ creator, local: true, currentPage: false }));
  const merged = new Map(localRows.map((row) => [creatorId(row.creator), row]));
  const pageRows = Array.isArray(captureData?.candidates) ? captureData.candidates.filter((creator) => creator.platform === activePlatform) : [];
  candidateById = new Map(pageRows.map((creator) => [creatorId(creator), creator]));
  for (const candidate of pageRows) {
    const id = creatorId(candidate);
    const existing = merged.get(id);
    if (existing) {
      try { existing.creator = mergeCreators([existing.creator], [candidate]).creators[0]; }
      catch { /* keep the saved CRM record if capture data is malformed */ }
      existing.currentPage = true;
      existing.candidate = candidate;
    } else merged.set(id, { creator: candidate, local: false, currentPage: true, candidate });
  }
  const query = recipientSearch.toLocaleLowerCase();
  const rows = [...merged.values()].filter(({ creator }) => {
    if (query && ![creator.name, creator.externalId, creator.owner, creator.note, ...(creator.tags || [])].join(' ').toLocaleLowerCase().includes(query)) return false;
    if (recipientStageFilter !== 'all' && (creator.stage || '未跟进') !== recipientStageFilter) return false;
    const ready = recipientReady(creator).ready === true;
    if (recipientReadinessFilter === 'ready' && !ready) return false;
    if (recipientReadinessFilter === 'missing' && ready) return false;
    return true;
  }).sort((a, b) => a.creator.name.localeCompare(b.creator.name, 'zh-CN'));
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  recipientPage = Math.min(recipientPage, totalPages);
  const start = (recipientPage - 1) * PAGE_SIZE;
  const visible = rows.slice(start, start + PAGE_SIZE);
  visibleRecipientIds = visible.map(({ creator }) => creatorId(creator));
  const validIds = new Set(merged.keys());
  selectedCreatorIds = new Set([...selectedCreatorIds].filter((id) => validIds.has(id)));
  const locked = recipientControlsLocked();
  dom['recipient-selection-count'].textContent = String(selectedCreatorIds.size);
  dom['recipient-platform-hint'].textContent = activePlatform ? `本地达人库 · ${platformLabel(activePlatform)}${pageRows.length ? ` · 当前页候选 ${pageRows.length} 位` : ''}` : '请先选择平台。';
  dom['recipient-list'].innerHTML = visible.map(({ creator, local, currentPage: fromPage }) => {
    const id = creatorId(creator);
    const source = local && fromPage ? '当前页 · 已在本地' : fromPage ? '当前页候选' : '本地达人';
    const readiness = recipientReady(creator);
    const readinessLabel = readiness.ready ? '邀请资料完整' : readiness.reason || '缺少平台邀请 ID';
    return `<label class="recipient-row"><span><input type="checkbox" data-recipient-id="${escapeHtml(id)}" aria-label="选择 ${escapeHtml(creator.name)}" ${selectedCreatorIds.has(id) ? 'checked' : ''} ${locked ? 'disabled' : ''} /><span class="platform-avatar platform-${escapeHtml(creator.platform)}" aria-hidden="true">${escapeHtml(PLATFORM_MARKS[creator.platform] || '达')}</span><span class="recipient-copy"><strong>${escapeHtml(creator.name)}</strong><small>${escapeHtml(source)}${creator.tags?.length ? ` · ${escapeHtml(creator.tags.slice(0, 2).join(' / '))}` : ''}</small><small class="recipient-readiness${readiness.ready ? '' : ' is-missing'}">${escapeHtml(readinessLabel)}</small></span></span><span class="recipient-external-id" title="${escapeHtml(creator.externalId)}">${escapeHtml(creator.externalId || '—')}</span><span class="recipient-stage">${escapeHtml(creator.stage || '未跟进')}</span></label>`;
  }).join('');
  dom['recipient-empty'].hidden = visible.length > 0;
  dom['recipient-table'].querySelector('.recipient-table-head').hidden = visible.length === 0;
  dom['recipient-empty-title'].textContent = !activePlatform ? '选择平台以查看达人' : merged.size ? '没有符合条件的达人' : `达人库暂无${platformLabel(activePlatform)}达人`;
  dom['recipient-empty-copy'].textContent = !activePlatform ? '选择平台后，可查看本地名单或读取当前平台页。' : merged.size ? '调整搜索词或筛选条件，也可读取当前平台页。' : '从当前平台页读取候选并收录到本地达人库。';
  dom['recipient-pagination'].hidden = rows.length <= PAGE_SIZE;
  dom['recipient-page-summary'].textContent = `${rows.length ? start + 1 : 0}–${Math.min(start + PAGE_SIZE, rows.length)} / ${rows.length} 位`;
  dom['recipient-page-number'].textContent = `第 ${recipientPage} / ${totalPages} 页`;
  dom['recipient-previous'].disabled = locked || recipientPage <= 1;
  dom['recipient-next'].disabled = locked || recipientPage >= totalPages;
  dom['recipient-search'].disabled = locked;
  dom['recipient-stage-filter'].disabled = locked;
  dom['recipient-readiness-filter'].disabled = locked;
  const selectedOnPage = visibleRecipientIds.filter((id) => selectedCreatorIds.has(id)).length;
  dom['recipient-visible-summary'].textContent = `本页 ${visible.length} 位 · 已选 ${selectedCreatorIds.size} / 50 位`;
  dom['select-current-page'].disabled = locked || visibleRecipientIds.length === 0 || selectedOnPage === visibleRecipientIds.length || selectedCreatorIds.size >= 50;
  dom['clear-current-page'].disabled = locked || selectedOnPage === 0;
  dom['clear-recipient-selection'].disabled = locked || selectedCreatorIds.size === 0;
  dom['continue-settings'].disabled = busy || selectedCreatorIds.size === 0 || selectedCreatorIds.size > 50 || !activePlatform || !dom['invite-tab-select'].value || jobBlocksNew();
}

function optionLabel(item) { return item?.label || item?.name || item?.id || ''; }
function renderOptionGroup(container, rows, selection, attribute, emptyElement) {
  emptyElement.hidden = rows.length > 0;
  container.innerHTML = rows.map((row) => {
    const label = optionLabel(row);
    const hint = row.path?.length ? row.path.join(' / ') : row.group || '';
    return `<label class="option-row"><input type="checkbox" data-${attribute}="${escapeHtml(row.id)}" ${selection.has(row.id) ? 'checked' : ''} /><span>${escapeHtml(label)}${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</span></label>`;
  }).join('');
}

function updateOptionSelection(event, attribute, selection) {
  const checkbox = event.target.closest(`[data-${attribute}]`);
  if (!checkbox) return;
  const id = checkbox.dataset[attribute.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())];
  if (checkbox.checked && !selection.has(id) && selection.size >= 50) {
    checkbox.checked = false;
    showAlert('每类选项最多选择 50 项。');
    return;
  }
  if (checkbox.checked) selection.add(id); else selection.delete(id);
  showAlert('');
  renderSettings();
  renderStartSummary();
}

function renderProducts() {
  const rows = options?.products || [];
  const limit = activePlatform === 'douyin' ? 5 : 10;
  const selectedNames = [...selectedProductIds].map((id) => productsById.get(id)?.name || id);
  dom['product-count'].textContent = `已选 ${selectedProductIds.size} / ${limit} 项`;
  dom['product-limit-note'].textContent = `至少 1 项，最多 ${limit} 项`;
  dom['product-list'].innerHTML = rows.map((product) => `<label class="product-row"><span class="product-primary"><input type="checkbox" data-product-id="${escapeHtml(product.id)}" ${selectedProductIds.has(product.id) ? 'checked' : ''} /><span class="product-name" title="${escapeHtml(product.name)}">${escapeHtml(product.name)}</span></span><span class="product-price">${escapeHtml(product.priceText || '')}</span></label>`).join('');
  dom['product-empty'].hidden = rows.length > 0;
  dom['product-empty-title'].textContent = productKeyword ? '没有匹配的商品' : '官方商品列表为空';
  dom['product-empty-copy'].textContent = optionsError || (productKeyword ? '调整搜索词后重试。' : '请确认所选官方账号下有可邀约商品。');
  dom['product-pagination'].hidden = !options?.hasMore && productPageIndex === 0;
  dom['product-page-label'].textContent = `第 ${productPageIndex + 1} 页${selectedNames.length ? ` · 已选：${selectedNames.join('、')}` : ''}`;
  dom['product-previous'].disabled = productPageIndex <= 0 || optionsLoading;
  dom['product-next'].disabled = !options?.hasMore || optionsLoading;
  dom['product-account-label'].textContent = options?.accountLabel || '';
}

function configForRequest() {
  const isCategory = options?.mode === 'category';
  return {
    message: isCategory ? '' : dom['invite-message'].value.trim(),
    contactName: dom['contact-name'].value.trim(),
    phone: dom['contact-phone'].value.trim(),
    wechat: dom['contact-wechat'].value.trim(),
    productIds: [...selectedProductIds],
    categoryIds: isCategory ? [...selectedCategoryIds] : [],
    rightIds: isCategory ? [...selectedRightIds] : [],
  };
}

function validationErrors() {
  const errors = [];
  if (!options?.ready) return ['请先读取官方邀约设置。'];
  const config = configForRequest();
  const intervalSeconds = Number(dom['invite-interval'].value);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 30 || intervalSeconds > 300) errors.push('发送间隔需为 30–300 秒的整数。');
  const maxProducts = activePlatform === 'douyin' ? 5 : 10;
  if (!config.productIds.length) errors.push('至少选择 1 件官方商品。');
  if (config.productIds.length > maxProducts) errors.push(`最多选择 ${maxProducts} 件商品。`);
  if (options.mode === 'words') {
    const maxMessage = activePlatform === 'weixin' ? 200 : 500;
    if (!config.message) errors.push('请填写邀约话术。');
    if (config.message.length > maxMessage) errors.push(`话术不能超过 ${maxMessage} 字。`);
  }
  if (activePlatform === 'weixin') {
    if (!config.contactName) errors.push('请填写联系人姓名。');
    if (!/^1[3-9]\d{9}$/u.test(config.phone)) errors.push('视频号联系人手机号需为 11 位大陆手机号。');
    if (!/^[A-Za-z0-9_-]{6,20}$/u.test(config.wechat)) errors.push('视频号微信号需为 6–20 位字母、数字、下划线或连字符。');
  } else {
    if (!config.phone && !config.wechat) errors.push('抖音邀约至少填写手机号或微信号。');
    if (config.phone && !/^1[3-9]\d{9}$/u.test(config.phone)) errors.push('抖音手机号需为 11 位大陆手机号。');
    if (config.wechat && !/^[A-Za-z0-9_-]{6,20}$/u.test(config.wechat)) errors.push('抖音微信号需为 6–20 位字母、数字、下划线或连字符。');
  }
  if (options.mode === 'category') {
    if (!config.categoryIds.length) errors.push('请选择至少 1 个主营类目。');
    if (!config.rightIds.length) errors.push('请选择至少 1 个合作权益。');
  }
  return errors;
}

function renderSettings() {
  const preparedResume = workflowMode === 'resume' && job?.flowVersion === 2 && job.status === 'prepared';
  const preparedCanStart = Boolean(job?.approvalToken && Date.parse(job?.expiresAt) > Date.now());
  const recipientCount = selectedCreators().length;
  dom['settings-recipient-label'].textContent = recipientCount ? `${recipientCount} 位 ${platformLabel(activePlatform)}达人` : '—';
  dom['invite-template-tools'].hidden = preparedResume;
  dom['prepared-job-note'].hidden = !preparedResume;
  if (preparedResume) dom['prepared-job-note'].textContent = preparedCanStart ? '已有一份待开始的邀约任务。点击下方按钮即可开始。' : '这份待开始任务已失效；请先导出记录，再新建一批。';
  dom['back-to-creators'].hidden = preparedResume;
  renderInviteTemplates();
  dom['options-status'].hidden = preparedResume;
  dom['settings-form'].hidden = preparedResume || !options?.ready;
  dom['retry-options'].hidden = preparedResume || !optionsError || !activeTabId() || !selectedCreators().length;
  dom['start-summary-details'].hidden = preparedResume ? false : !options?.ready;
  dom['start-summary-details'].open = preparedResume;
  dom['options-status'].textContent = optionsError || (optionsLoading ? '正在读取官方邀约设置…' : options?.ready ? `已读取 ${options.accountLabel} 的可用设置。` : '选择达人后，官方商品和邀约设置会自动读取。');
  dom['options-status'].className = `step-feedback${optionsError ? ' is-error' : optionsLoading ? '' : options?.ready ? ' is-success' : ''}`;
  if (!options?.ready) return;
  const isCategory = options.mode === 'category';
  dom['native-mode-summary'].textContent = isCategory ? '类目邀请 · 由官方类目和合作权益生成内容' : '文字邀请 · 使用下方话术和联系人信息';
  dom['words-message-field'].hidden = isCategory;
  dom['category-mode-note'].hidden = !isCategory;
  dom['category-right-groups'].hidden = !isCategory;
  dom['contact-name-field'].hidden = activePlatform === 'douyin';
  dom['phone-requirement'].textContent = activePlatform === 'weixin' ? '必填' : '手机号或微信至少填一项';
  dom['wechat-requirement'].textContent = activePlatform === 'weixin' ? '必填' : '手机号或微信至少填一项';
  dom['invite-message'].maxLength = activePlatform === 'weixin' ? 200 : 500;
  dom['message-limit-label'].textContent = `最多 ${activePlatform === 'weixin' ? 200 : 500} 字`;
  dom['message-count'].textContent = `${dom['invite-message'].value.length} / ${activePlatform === 'weixin' ? 200 : 500}`;
  renderOptionGroup(dom['category-list'], options.categories || [], selectedCategoryIds, 'category-id', dom['category-empty']);
  renderOptionGroup(dom['right-list'], options.rights || [], selectedRightIds, 'right-id', dom['right-empty']);
  renderProducts();
  renderStartSummary();
  if (busy) for (const control of dom['settings-form'].querySelectorAll('input, textarea, button')) control.disabled = true;
}

function canModifyInviteConfiguration() {
  const recipient = selectedRecipientAnchor();
  return !busy && !optionsLoading && workflowMode === 'new' && step === 2 && options?.ready === true
    && Boolean(recipient) && optionsRecipientId === creatorId(recipient) && optionsTabId === String(activeTabId()) && !jobBlocksNew();
}

function setInviteTemplateFeedback(message, kind = '') {
  inviteTemplateFeedback = message;
  inviteTemplateFeedbackKind = kind;
  renderInviteTemplates();
}

function renderInviteTemplates() {
  const select = dom['invite-template-select'];
  const wantedId = selectedInviteTemplateId || select.value;
  const available = new Set(inviteTemplates.map((template) => template.id));
  if (!available.has(wantedId)) selectedInviteTemplateId = '';
  else selectedInviteTemplateId = wantedId;
  select.replaceChildren(new Option('选择模板', ''));
  for (const template of inviteTemplates) {
    const platform = platformLabel(template.platform);
    const mode = template.mode === 'category' ? '类目' : '话术';
    select.add(new Option(`${template.name} · ${platform} · ${mode}`, template.id));
  }
  select.value = selectedInviteTemplateId;
  const selected = inviteTemplates.find((template) => template.id === selectedInviteTemplateId);
  const canModify = canModifyInviteConfiguration();
  const controlsLocked = busy || inviteTemplateMutationBusy || workflowMode === 'resume' || jobBlocksNew();
  const name = dom['invite-template-name'].value.trim();
  const updatesSelected = Boolean(selected && name === selected.name && selected.platform === activePlatform && selected.mode === options?.mode);
  select.disabled = inviteTemplatesLoading || controlsLocked;
  dom['reload-invite-templates'].disabled = inviteTemplatesLoading || busy;
  dom['apply-invite-template'].disabled = !selected || inviteTemplatesLoading || !canModify;
  dom['delete-invite-template'].disabled = !selected || inviteTemplatesLoading || controlsLocked;
  dom['invite-template-name'].disabled = controlsLocked;
  dom['template-include-contact'].disabled = controlsLocked;
  dom['save-invite-template'].disabled = !name || inviteTemplatesLoading || !canModify;
  dom['save-invite-template'].textContent = updatesSelected ? '更新所选模板' : '另存为新模板';
  const message = inviteTemplateFeedback || inviteTemplatesError || (inviteTemplatesLoading ? '正在读取已保存模板…' : inviteTemplates.length ? '' : '尚无已保存模板。');
  dom['invite-template-feedback'].textContent = message;
  dom['invite-template-feedback'].hidden = !message;
  dom['invite-template-feedback'].className = `template-feedback${inviteTemplateFeedbackKind ? ` is-${inviteTemplateFeedbackKind}` : inviteTemplatesError ? ' is-error' : ''}`;
}

async function loadInviteTemplates() {
  if (inviteTemplateMutationBusy) return;
  const epoch = ++inviteTemplateRequestEpoch;
  inviteTemplatesLoading = true;
  inviteTemplatesError = '';
  inviteTemplateFeedback = '';
  inviteTemplateFeedbackKind = '';
  renderInviteTemplates();
  try {
    const response = await request('INVITE_TEMPLATES_LIST');
    if (epoch !== inviteTemplateRequestEpoch || inviteTemplateMutationBusy) return;
    inviteTemplates = Array.isArray(response.templates) ? response.templates : [];
    if (!inviteTemplates.some((template) => template.id === selectedInviteTemplateId)) selectedInviteTemplateId = '';
  } catch (error) {
    if (epoch === inviteTemplateRequestEpoch && !inviteTemplateMutationBusy) inviteTemplatesError = error?.message || '暂时无法读取邀约模板。';
  } finally {
    if (epoch === inviteTemplateRequestEpoch && !inviteTemplateMutationBusy) {
      inviteTemplatesLoading = false;
      renderInviteTemplates();
    }
  }
}

async function saveInviteTemplate() {
  if (!canModifyInviteConfiguration() || inviteTemplateMutationBusy) return;
  const name = dom['invite-template-name'].value.trim();
  if (!name) {
    setInviteTemplateFeedback('请先填写模板名称。', 'error');
    return;
  }
  const includeContact = dom['template-include-contact'].checked;
  const configuration = configForRequest();
  if (!includeContact) {
    delete configuration.contactName;
    delete configuration.phone;
    delete configuration.wechat;
  }
  const selected = inviteTemplates.find((template) => template.id === selectedInviteTemplateId);
  const updatesSelected = Boolean(selected && name === selected.name && selected.platform === activePlatform && selected.mode === options.mode);
  const template = {
    ...(updatesSelected ? { id: selected.id } : {}),
    name,
    platform: activePlatform,
    mode: options.mode,
    includeContact,
    configuration,
    intervalSeconds: Number(dom['invite-interval'].value),
  };
  const snapshot = { name, platform: activePlatform, mode: options.mode, selectedId: selected?.id || '', updatesSelected };
  inviteTemplateMutationBusy = true;
  inviteTemplateRequestEpoch += 1;
  inviteTemplatesLoading = false;
  setBusy(true);
  try {
    const response = await request('INVITE_TEMPLATE_SAVE', { template });
    inviteTemplates = Array.isArray(response.templates) ? response.templates : inviteTemplates;
    const saved = snapshot.updatesSelected
      ? inviteTemplates.find((item) => item.id === snapshot.selectedId)
      : [...inviteTemplates].reverse().find((item) => item.name === snapshot.name && item.platform === snapshot.platform && item.mode === snapshot.mode);
    selectedInviteTemplateId = saved?.id || '';
    dom['invite-template-select'].value = selectedInviteTemplateId;
    dom['template-include-contact'].checked = false;
    setInviteTemplateFeedback(snapshot.updatesSelected ? '模板已更新。' : '模板已保存。', 'success');
  } catch (error) {
    setInviteTemplateFeedback(error?.message || '保存模板失败，请重试。', 'error');
  } finally {
    inviteTemplateMutationBusy = false;
    inviteTemplatesLoading = false;
    setBusy(false);
    renderAll();
  }
}

async function deleteInviteTemplate() {
  if (busy || inviteTemplateMutationBusy || workflowMode === 'resume') return;
  const selected = inviteTemplates.find((template) => template.id === selectedInviteTemplateId);
  if (!selected) return;
  if (!window.confirm(`确认删除模板“${selected.name}”？`)) return;
  const selectedId = selected.id;
  inviteTemplateMutationBusy = true;
  inviteTemplateRequestEpoch += 1;
  inviteTemplatesLoading = false;
  setBusy(true);
  try {
    const response = await request('INVITE_TEMPLATE_DELETE', { id: selectedId });
    inviteTemplates = Array.isArray(response.templates) ? response.templates : inviteTemplates.filter((template) => template.id !== selectedId);
    if (selectedInviteTemplateId === selectedId) {
      selectedInviteTemplateId = '';
      dom['invite-template-select'].value = '';
      dom['invite-template-name'].value = '';
    }
    setInviteTemplateFeedback('模板已删除。', 'success');
  } catch (error) {
    setInviteTemplateFeedback(error?.message || '删除模板失败，请重试。', 'error');
  } finally {
    inviteTemplateMutationBusy = false;
    inviteTemplatesLoading = false;
    setBusy(false);
    renderAll();
  }
}

function inviteTemplateTargetMatches(snapshot) {
  const recipients = selectedCreators().map(creatorId).sort();
  return workflowMode === 'new' && step === 2 && activePlatform === snapshot.platform
    && activeTabId() === snapshot.tabId && recipients.join('\n') === snapshot.recipientIds.join('\n')
    && options?.ready === true && !optionsLoading
    && optionsRecipientId === snapshot.anchorId && optionsTabId === String(snapshot.tabId)
    && !runtimeError && !jobBlocksNew();
}

async function applySelectedInviteTemplate() {
  if (!canModifyInviteConfiguration()) return;
  const template = inviteTemplates.find((item) => item.id === selectedInviteTemplateId);
  if (!template) return;
  const recipient = selectedRecipientAnchor();
  const snapshot = {
    platform: activePlatform,
    tabId: activeTabId(),
    anchorId: creatorId(recipient),
    recipientIds: selectedCreators().map(creatorId).sort(),
  };
  setBusy(true);
  setInviteTemplateFeedback('正在刷新当前官方选项…');
  try {
    const loaded = await loadOptions({ keyword: productKeyword, cursor: productPageCursors[productPageIndex] || null });
    if (!loaded) {
      setInviteTemplateFeedback(optionsError || '未能刷新官方选项，模板尚未应用。', 'error');
      return;
    }
    const status = await request('INVITE_STATUS');
    job = status.job || null;
    jobSignature = JSON.stringify(job);
    runtimeError = status.runtimeError || '';
    const frozen = job?.flowVersion === 2 && ['prepared', 'paused', 'running'].includes(job.status);
    if (frozen || jobBlocksNew()) {
      if (frozen) {
        workflowMode = 'resume';
        step = job.status === 'prepared' ? 2 : 3;
      }
      setInviteTemplateFeedback('当前任务状态已变化，模板未应用。', 'error');
      return;
    }
    if (!inviteTemplateTargetMatches(snapshot)) {
      setInviteTemplateFeedback('平台、达人或官方选项已变化，模板未应用。', 'error');
      return;
    }
    const applied = applyInviteTemplate(template, options, options.products || []);
    const { configuration, intervalSeconds, warnings } = applied;
    dom['invite-message'].value = configuration.message || '';
    for (const [key, id] of [['contactName', 'contact-name'], ['phone', 'contact-phone'], ['wechat', 'contact-wechat']]) {
      if (Object.hasOwn(configuration, key)) dom[id].value = configuration[key];
    }
    selectedProductIds = new Set(configuration.productIds);
    selectedCategoryIds = new Set(configuration.categoryIds);
    selectedRightIds = new Set(configuration.rightIds);
    dom['invite-interval'].value = String(intervalSeconds);
    clearStartError();
    renderSettings();
    renderStartSummary();
    const suffix = warnings.length ? `未匹配的选项已跳过：${warnings.join('；')}` : (template.includeContact ? '模板联系人已填入。' : '当前联系人信息已保留。');
    setInviteTemplateFeedback(`模板已应用。${suffix}`, warnings.length ? 'warning' : 'success');
  } catch (error) {
    setInviteTemplateFeedback(error?.message || '无法应用此模板，请检查平台和当前官方选项。', 'error');
  } finally {
    setBusy(false);
    renderAll();
  }
}

function selectedProductLabels() {
  return [...selectedProductIds].map((id) => productsById.get(id)?.name || id);
}
function selectedOptionLabels(rows, ids) {
  const byId = new Map((rows || []).map((row) => [row.id, optionLabel(row)]));
  return [...ids].map((id) => byId.get(id) || id);
}
function isInviteConfigValid() {
  return !optionsLoading && options?.ready === true && validationErrors().length === 0 && selectedCreators().length > 0 && selectedCreators().length <= 50 && !jobBlocksNew();
}
function renderStartSummary() {
  let recipients = selectedCreators();
  const preparedCanStart = Boolean(job?.approvalToken && Date.parse(job?.expiresAt) > Date.now());
  let summaryRows;
  if (workflowMode === 'resume' && job) {
    const summary = job.summary || {};
    const products = Array.isArray(summary.productNames) && summary.productNames.length ? summary.productNames.join('、') : Array.isArray(summary.productIds) ? summary.productIds.join('、') : '—';
    summaryRows = [
      ['达人名单', `${job.items?.length || 0} 位：${(job.items || []).slice(0, 8).map((item) => item.name).join('、')}${(job.items?.length || 0) > 8 ? ` 等 ${job.items.length} 位` : ''}`, 'is-wide'],
      ['邀约方式', summary.cardVersion === 'category' ? '类目邀请' : '文字邀请'],
      ['官方账号', summary.accountLabel || '—'],
      ['联系人', summary.contactName || '—'],
      ['手机号', summary.phoneMasked || '未填写'],
      ['微信号', summary.wechatMasked || '未填写'],
      ['商品', products, 'is-wide'],
      ['邀约内容', summary.message || '—', 'is-wide'],
      ['发送间隔', `${Number(job.intervalSeconds) || 30} 秒`],
    ];
    recipients = [];
  } else {
    const config = options?.ready ? configForRequest() : inviteConfig;
    const message = options?.mode === 'category' ? '使用平台类目模板' : config.message || '—';
    const productNames = selectedProductLabels();
    const categories = selectedOptionLabels(options?.categories, selectedCategoryIds);
    const rights = selectedOptionLabels(options?.rights, selectedRightIds);
    summaryRows = [
      ['达人名单', `${recipients.length} 位：${recipients.slice(0, 8).map((creator) => creator.name).join('、')}${recipients.length > 8 ? ` 等 ${recipients.length} 位` : ''}`, 'is-wide'],
      ['邀约方式', options?.mode === 'category' ? '类目邀请' : options?.mode === 'words' ? '文字邀请' : '—'],
      ['官方账号', options?.accountLabel || '—'],
      ['联系人', config.contactName || '—'],
      ['手机号', maskPhone(config.phone)],
      ['微信号', maskWechat(config.wechat)],
      ['商品', productNames.length ? productNames.join('、') : '—', 'is-wide'],
      ...(options?.mode === 'category' ? [['主营类目', categories.join('、') || '—'], ['合作权益', rights.join('、') || '—']] : [['邀约话术', message, 'is-wide']]),
      ['发送间隔', `${Number(dom['invite-interval'].value) || 30} 秒`],
    ];
  }
  dom['start-summary'].innerHTML = summaryRows.map(([label, value, extra = '']) => `<div class="summary-cell ${extra}"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div>`).join('');
  const resuming = resumeExistingJob();
  const running = Boolean(job?.flowVersion === 2 && job.status === 'running');
  const unknown = hasUnresolvedJobItem();
  const total = workflowMode === 'resume' ? job?.items?.length || 0 : recipients.length;
  dom['start-count-label'].textContent = `${total} 位达人 · ${platformLabel(workflowMode === 'resume' ? job?.platform : activePlatform)}`;
  dom['start-invite-button'].textContent = running ? `邀约进行中（${total} 位）` : resuming ? `${job.status === 'paused' ? '继续' : '开始'}邀约（${total} 位）` : `开始邀约（${total} 位）`;
  dom['start-invite-button'].disabled = busy || running || unknown || !canStartFromCurrentFlow();
  const preparedResume = workflowMode === 'resume' && job?.flowVersion === 2 && job.status === 'prepared';
  const errors = preparedResume ? [] : validationErrors();
  dom['settings-validation-hint'].textContent = preparedResume ? (preparedCanStart ? '任务已准备好，可直接开始。' : '任务已失效，请先导出并新建一批。') : errors.length ? errors[0] : '邀约设置已齐备。';
  dom['settings-validation-hint'].className = errors.length ? 'validation-error' : 'validation-ok';
}

function renderJob() {
  dom['job-results-filter'].disabled = busy || resultExportBusy;
  dom['export-invite-results'].disabled = busy || resultExportBusy;
  if (!job) {
    dom['invite-job-panel'].hidden = true;
    return;
  }
  dom['invite-job-panel'].hidden = false;
  const items = Array.isArray(job.items) ? job.items : [];
  const excluded = Array.isArray(job.excluded) ? job.excluded : [];
  const flowVersion = job.flowVersion || 1;
  const legacy = flowVersion !== 2;
  const unknownItems = items.filter((item) => item.status === 'unknown');
  const progressCount = items.filter((item) => ['succeeded', 'failed', 'skipped'].includes(item.status)).length;
  dom['job-status-badge'].textContent = `${legacy ? '旧版 · ' : ''}${({ prepared: '待开始', running: '邀约中', paused: '已暂停', completed: '已完成', failed: '已停止' })[job.status] || job.status || '未知'}`;
  dom['job-status-badge'].className = `job-status-badge status-${['running', 'paused', 'completed', 'failed'].includes(job.status) ? job.status : 'prepared'}`;
  dom['job-subtitle'].textContent = job.status === 'running' && !legacy ? '任务正在逐位处理，状态仅从本地任务读取。' : job.status === 'paused' ? (job.pauseReason || '任务已暂停。') : legacy ? '旧版任务停止运行；不会自动恢复。' : job.status === 'completed' ? '任务已结束，人工标记与平台结果分别显示。' : '任务保存在本地。';
  dom['legacy-job-notice'].hidden = !legacy;
  const runtimeMessage = runtimeError || '';
  dom['job-runtime-error'].textContent = runtimeMessage;
  dom['job-runtime-error'].hidden = !runtimeMessage;
  dom['job-progress-bar'].style.width = `${items.length ? Math.round(progressCount / items.length * 100) : 0}%`;
  dom['job-progress-label'].textContent = `${progressCount} / ${items.length}`;
  const summary = job.summary || {};
  const productNames = Array.isArray(summary.productNames) && summary.productNames.length ? summary.productNames.join('、') : (summary.productIds || []).join?.('、') || '—';
  const details = [
    ['平台', platformLabel(job.platform)],
    ['名单', `${items.length} 位`],
    ['官方账号', summary.accountLabel || '—'],
    ['联系人', summary.contactName || '—'],
    ['手机号', summary.phoneMasked || '未填写'],
    ['微信号', summary.wechatMasked || '未填写'],
    ['商品', productNames, 'is-wide'],
    ['邀约内容', summary.message || '—', 'is-wide'],
  ];
  dom['job-summary'].innerHTML = details.map(([label, value, extra = '']) => `<div class="job-summary-cell ${extra}"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div>`).join('');
  const visibleItems = filterInviteResults(items, resultFilter);
  dom['job-results-filter'].value = resultFilter;
  dom['job-results-empty'].hidden = visibleItems.length > 0;
  dom['job-results-empty'].textContent = items.length ? '当前筛选下没有结果。' : '当前任务暂无结果。';
  dom['job-result-list'].innerHTML = visibleItems.map((item) => {
    let statusLabel = ({ pending: '待处理', sending: '正在发送', failed: '失败', unknown: '结果未明', skipped: '手工跳过' })[item.status] || item.status;
    let source = item.message || '';
    if (item.status === 'succeeded') {
      if (item.resolutionSource === 'platform') { statusLabel = '平台确认成功'; source = '平台明确返回成功'; }
      else if (item.resolutionSource === 'manual') { statusLabel = '人工确认成功'; source = '人工确认，非平台回执'; }
      else { statusLabel = '结果来源未注明'; source = '此记录未注明平台或人工确认'; }
    } else if (item.status === 'unknown') source = '请先到平台核对；系统不会自动重试。';
    const statusClass = item.status === 'succeeded' && !['platform', 'manual'].includes(item.resolutionSource) ? 'item-unclassified' : `item-${item.status}`;
    return `<div class="job-result-row"><strong class="job-result-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name || '未知达人')}</strong><span class="job-result-status ${statusClass}">${escapeHtml(statusLabel)}</span><span class="job-result-message" title="${escapeHtml(source)}">${escapeHtml(source)}</span></div>`;
  }).join('');
  dom['job-excluded-list'].innerHTML = excluded.map((item) => {
    const creator = state.creators.find((row) => creatorId(row) === item.creatorId || row.externalId === item.externalId);
    return `<div class="job-excluded-row"><strong>${escapeHtml(item.name || creator?.name || item.externalId || '未识别达人')}</strong><span>${escapeHtml(item.reason || '未纳入任务')}</span></div>`;
  }).join('');
  dom['job-excluded-list'].hidden = excluded.length === 0;
  renderJobActions();
}

function renderJobActions() {
  if (!job) return;
  const items = job.items || [];
  const unknownItems = items.filter((item) => item.status === 'unknown');
  const legacy = job.flowVersion !== 2;
  const canStartNew = job.status !== 'running' && !items.some((item) => ['sending', 'unknown'].includes(item.status));
  const newBatchButton = canStartNew ? '<button class="button button-quiet button-small" type="button" data-job-action="new-batch">新建一批</button>' : '';
  if (legacy) {
    dom['job-actions'].innerHTML = `${unknownItems.map((item) => unknownActionMarkup(item)).join('')}${newBatchButton}`;
    return;
  }
  let actions = '';
  if (job.status === 'running') actions = '<span class="job-action-message">可以暂停后续发送；正在处理的单人邀约仍会记录结果。</span><button class="button button-secondary button-small" type="button" data-job-action="pause">暂停邀约</button>';
  if (job.status === 'paused' && !hasUnresolvedJobItem()) actions = '<button class="button button-primary button-small" type="button" data-job-action="resume">继续邀约</button>';
  if (unknownItems.length) actions = unknownItems.map((item) => unknownActionMarkup(item)).join('');
  dom['job-actions'].innerHTML = `${actions}${newBatchButton}`;
}

function unknownActionMarkup(item) {
  return `<div class="unknown-action-row"><span>${escapeHtml(item.name || '未知达人')} · 先到平台核对结果</span><div><button class="button button-secondary button-small" type="button" data-job-action="resolve-success" data-item-id="${escapeHtml(item.id)}">我已在平台确认送达</button><button class="button button-quiet button-small" type="button" data-job-action="resolve-skip" data-item-id="${escapeHtml(item.id)}">跳过此人</button></div></div>`;
}

async function refreshTabs() {
  dom['refresh-invite-tabs'].disabled = true;
  try {
    const response = await request('LIST_TABS');
    tabs = Array.isArray(response.tabs) ? response.tabs.filter((tab) => ['douyin', 'weixin'].includes(tab.platform)) : [];
    renderTabs();
    setStepStatus('capture-feedback', activePlatform && !tabs.some((tab) => tab.platform === activePlatform) ? `没有已打开的${platformLabel(activePlatform)}页。` : '标签页已更新；请选择要使用的平台页。');
  } catch (error) {
    setStepStatus('capture-feedback', error?.message || '无法读取标签页，请重试。', 'error');
  } finally {
    dom['refresh-invite-tabs'].disabled = busy;
  }
}

async function captureCurrentPage() {
  const tabId = Number(dom['invite-tab-select'].value);
  const tab = tabs.find((item) => Number(item.id) === tabId && item.platform === activePlatform);
  if (!tab) {
    setStepStatus('capture-feedback', '请先选择当前平台标签页。', 'error');
    return;
  }
  dom['capture-current-page'].disabled = true;
  setStepStatus('capture-feedback', '正在读取当前页候选…');
  try {
    const localIds = new Set(state.creators.map(creatorId));
    captureData = await request('GET_ACTIVE_CAPTURE', { tabId });
    const pageIds = new Set((captureData.candidates || []).map(creatorId));
    selectedCreatorIds = new Set([...selectedCreatorIds].filter((id) => localIds.has(id) || pageIds.has(id)));
    renderRecipients();
    setStepStatus('capture-feedback', `已读取 ${captureData.candidates?.length || 0} 位候选。与本地名单合并显示，勾选后继续即可。`);
  } catch (error) {
    captureData = null;
    renderRecipients();
    setStepStatus('capture-feedback', error?.message || '读取当前页失败，请刷新平台页后重试。', 'error');
  } finally {
    dom['capture-current-page'].disabled = busy || !dom['invite-tab-select'].value;
  }
}

function selectedRecipientAnchor() { return selectedCreators()[0] || null; }
async function changeToSettings() {
  if (!selectedCreators().length || !activeTabId() || jobBlocksNew()) return;
  const selectedIds = selectedCreators().map(creatorId);
  const selectedPageCandidates = selectedIds.map((id) => candidateById.get(id)).filter((candidate) => candidate?.platform === activePlatform);
  if (selectedPageCandidates.length) {
    setStepStatus('capture-feedback', '正在将所选当前页达人收录到本地名单…');
    setBusy(true);
    try {
      const response = await request('UPSERT_CREATORS', { creators: selectedPageCandidates });
      const updatedState = response.state || (await request('GET_STATE')).state;
      if (!Array.isArray(updatedState?.creators)) throw new Error('本地名单更新结果不完整，请重试。');
      state = updatedState;
      const savedIds = new Set(state.creators.map(creatorId));
      const missingIds = selectedIds.filter((id) => !savedIds.has(id));
      if (missingIds.length) throw new Error(`有 ${missingIds.length} 位所选达人未写入本地名单，请重试。`);
      setStepStatus('capture-feedback', `当前页所选达人已收录：新增 ${Number(response.added) || 0} 位，更新 ${Number(response.updated) || 0} 位。`, 'success');
    } catch (error) {
      showAlert(error?.message || '当前页达人收录失败；尚未进入邀约设置。');
      setBusy(false);
      renderAll();
      return;
    }
    setBusy(false);
  }
  step = 2;
  workflowMode = 'new';
  renderAll();
  const anchor = selectedRecipientAnchor();
  const recipientChanged = optionsRecipientId && optionsRecipientId !== creatorId(anchor);
  const tabChanged = optionsTabId && optionsTabId !== String(activeTabId());
  if (!options?.ready || recipientChanged || tabChanged) await loadOptions({ keyword: '', cursor: null, resetCatalog: true });
  else renderSettings();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function activeTabId() {
  const value = dom['invite-tab-select'].value;
  const id = Number(value);
  return value && Number.isSafeInteger(id) ? id : null;
}

function releaseInviteBinding(tabId = activeTabId()) {
  const tabIds = new Set([tabId, job?.tabId].filter((id) => Number.isSafeInteger(id)));
  for (const id of tabIds) void request('INVITE_RELEASE', { tabId: id }).catch(() => {});
}

async function loadOptions({ keyword = productKeyword, cursor = null, resetCatalog = false } = {}) {
  const recipient = selectedRecipientAnchor();
  const tabId = activeTabId();
  if (!recipient || !tabId || !activePlatform) {
    optionsError = '请先选择平台标签页和至少一位达人。';
    renderSettings();
    return false;
  }
  const epoch = ++optionsRequestEpoch;
  optionsLoading = true;
  optionsError = '';
  productKeyword = keyword;
  if (resetCatalog) {
    productPageCursors = [null];
    productPageIndex = 0;
  }
  renderSettings();
  try {
    const response = await request('INVITE_OPTIONS', { tabId, recipientId: creatorId(recipient), ...(keyword ? { keyword } : {}), ...(cursor ? { cursor } : {}) });
    if (epoch !== optionsRequestEpoch) return false;
    const nextOptions = response.options || null;
    if (!nextOptions?.ready) throw new Error(nextOptions?.reason || '官方商品和邀约设置尚未就绪。');
    const contextChanged = options?.contextId && options.contextId !== nextOptions.contextId;
    if (contextChanged) {
      selectedProductIds.clear();
      selectedCategoryIds.clear();
      selectedRightIds.clear();
      productsById.clear();
      productPageCursors = [null];
      productPageIndex = 0;
    }
    options = nextOptions;
    optionsRecipientId = creatorId(recipient);
    optionsTabId = String(tabId);
    for (const product of options.products || []) productsById.set(product.id, product);
    optionsError = '';
    renderSettings();
    renderStartSummary();
    return true;
  } catch (error) {
    if (epoch !== optionsRequestEpoch) return false;
    optionsError = error?.message || '无法读取官方设置，请检查平台页后重试。';
    renderSettings();
    return false;
  } finally {
    if (epoch === optionsRequestEpoch) {
      optionsLoading = false;
      renderSettings();
      renderStartSummary();
    }
  }
}

function onProductSearch(value) {
  productKeyword = value.trim();
  window.clearTimeout(productSearchTimer);
  productSearchTimer = window.setTimeout(() => { void loadOptions({ keyword: productKeyword, cursor: null, resetCatalog: true }); }, 320);
}

function exportFile(name, data, type = 'application/json;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportLatestJob() {
  try {
    const response = await request('INVITE_STATUS');
    const latest = response.job || null;
    if (!latest) { showAlert('当前没有可导出的邀约任务。'); return; }
    const safeJob = { ...latest };
    delete safeJob.approvalToken;
    delete safeJob.contextId;
    exportFile(`达人助手-自动邀约-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), job: safeJob, runtimeError: response.runtimeError || '' }));
    job = latest;
    jobSignature = JSON.stringify(latest);
    runtimeError = response.runtimeError || '';
    renderJob();
    showToast('已导出最新任务状态。');
  } catch (error) {
    if (!isDiagnosticLogged(error)) void reportError(error, { operation: 'EXPORT_INVITE_JOB', code: 'UI_EXCEPTION', surface: 'auto-invite', stage: 'download' });
    showAlert(error?.message || '读取最新任务失败，暂未导出。');
  }
}

async function exportInviteResults() {
  if (busy || resultExportBusy) return;
  resultExportBusy = true;
  const snapshot = {
    epoch: jobOperationEpoch,
    jobId: job?.id || '',
    platform: activePlatform,
    tabId: activeTabId(),
    workflowMode,
    step,
    recipientIds: selectedCreators().map(creatorId).sort().join('\n'),
    configuration: configurationSignature(),
    filter: resultFilter,
  };
  const isCurrent = () => snapshot.epoch === jobOperationEpoch
    && snapshot.jobId === (job?.id || '')
    && snapshot.platform === activePlatform
    && snapshot.tabId === activeTabId()
    && snapshot.workflowMode === workflowMode
    && snapshot.step === step
    && snapshot.recipientIds === selectedCreators().map(creatorId).sort().join('\n')
    && snapshot.configuration === configurationSignature();
  renderJob();
  try {
    const response = await request('INVITE_STATUS');
    if (!isCurrent()) {
      showToast('当前任务或设置已变化，已取消过期导出。');
      return;
    }
    const latest = response.job || null;
    if (!latest) {
      showAlert('当前没有可导出的邀约任务。');
      return;
    }
    if (latest.id !== snapshot.jobId) {
      showToast('当前任务已更换，请等待页面更新后重新导出。');
      return;
    }
    const exportedItems = filterInviteResults(Array.isArray(latest.items) ? latest.items : [], snapshot.filter);
    const csv = inviteResultsToCSV(latest, snapshot.filter);
    const date = new Date().toISOString().slice(0, 10);
    exportFile(`creator-assistant-invite-results-${date}.csv`, csv, 'text/csv;charset=utf-8');
    showToast(exportedItems.length ? `已导出 ${exportedItems.length} 条结果。` : '当前筛选没有结果，已导出空表格。');
  } catch (error) {
    if (!isDiagnosticLogged(error)) void reportError(error, { operation: 'EXPORT_INVITE_RESULTS_CSV', code: 'UI_EXCEPTION', surface: 'auto-invite', stage: 'download' });
    showAlert(error?.message || '刷新或导出当前结果失败，请重试。');
  } finally {
    resultExportBusy = false;
    renderJob();
  }
}

function configurationValue() {
  return {
    message: options?.mode === 'category' ? '' : dom['invite-message'].value.trim(),
    contactName: dom['contact-name'].value.trim(),
    phone: dom['contact-phone'].value.trim(),
    wechat: dom['contact-wechat'].value.trim(),
    productIds: [...selectedProductIds],
    categoryIds: options?.mode === 'category' ? [...selectedCategoryIds] : [],
    rightIds: options?.mode === 'category' ? [...selectedRightIds] : [],
  };
}

function configurationSignature() {
  return JSON.stringify({ platform: activePlatform, tabId: activeTabId(), ids: selectedCreators().map(creatorId), configuration: configurationValue(), intervalSeconds: Number(dom['invite-interval'].value) });
}

function clearStartError() {
  dom['start-error'].textContent = '';
  dom['start-error'].hidden = true;
}
function showStartError(message) {
  dom['start-error'].textContent = message;
  dom['start-error'].hidden = !message;
}

async function startNewInvite(event) {
  if (!event.isTrusted || busy) return;
  const errors = validationErrors();
  if (errors.length) {
    showStartError(errors[0]);
    step = options?.ready ? 2 : 1;
    workflowMode = 'new';
    renderAll();
    return;
  }
  if (jobBlocksNew()) {
    showStartError('当前任务仍在运行，或有结果未知的达人。请先暂停并核对结果。');
    return;
  }
  const tabId = activeTabId();
  const ids = selectedCreators().map(creatorId);
  if (!tabId || !ids.length) {
    showStartError('请重新选择平台页和达人名单。');
    return;
  }
  clearStartError();
  jobOperationEpoch += 1;
  setBusy(true);
  let preparedInThisClick = false;
  try {
    const prepared = await request('INVITE_PREPARE', { tabId, ids, configuration: configurationValue(), intervalSeconds: Number(dom['invite-interval'].value) });
    const preparedJob = prepared.job;
    if (!preparedJob || preparedJob.flowVersion !== 2) throw new Error('任务准备结果无效，未启动邀约。');
    job = preparedJob;
    jobSignature = JSON.stringify(job);
    workflowMode = 'resume';
    step = 2;
    preparedInThisClick = true;
    renderAll();
    const started = await request('INVITE_START', { jobId: preparedJob.id, approvalToken: preparedJob.approvalToken, confirmed: true });
    job = started.job || preparedJob;
    jobSignature = JSON.stringify(job);
    if (job.status === 'prepared') throw new Error('任务已准备好，但尚未启动；可再次点击下方按钮开始。');
    step = job.status === 'prepared' ? 2 : 3;
    if (step === 3) workflowMode = 'resume';
    renderAll();
    if (step === 3) showToast(`已开始 ${ids.length} 位达人的邀约。`);
  } catch (error) {
    showStartError(error?.message || '开始邀约失败，请检查设置后重试。');
    if (preparedInThisClick && job?.status === 'prepared' && job.flowVersion === 2) {
      workflowMode = 'resume';
      step = 2;
    } else {
      workflowMode = 'new';
      step = 2;
    }
  } finally {
    setBusy(false);
    renderAll();
  }
}

async function startExistingJob(event) {
  if (!event.isTrusted || busy || !job?.approvalToken || !job?.id || job.flowVersion !== 2 || hasUnresolvedJobItem()) return;
  if (!['prepared', 'paused'].includes(job.status)) return;
  clearStartError();
  jobOperationEpoch += 1;
  setBusy(true);
  try {
    const response = await request('INVITE_START', { jobId: job.id, approvalToken: job.approvalToken, confirmed: true });
    job = response.job || job;
    jobSignature = JSON.stringify(job);
    if (['running', 'paused', 'completed', 'failed'].includes(job.status)) {
      workflowMode = 'resume';
      step = 3;
    } else if (job.status === 'prepared') {
      workflowMode = 'resume';
      step = 2;
      throw new Error('任务尚未启动，可检查平台页后重试。');
    }
    showToast(job.status === 'running' ? '邀约队列已启动。' : '邀约请求已处理。');
  } catch (error) {
    const message = error?.message || '无法启动当前任务。请检查平台页状态。';
    if (step === 3) showAlert(message); else showStartError(message);
  } finally {
    setBusy(false);
    renderAll();
  }
}

async function pauseJob() {
  if (!job?.id || busy) return;
  jobOperationEpoch += 1;
  setBusy(true);
  try {
    const response = await request('INVITE_PAUSE', { jobId: job.id });
    job = response.job || job;
    jobSignature = JSON.stringify(job);
    showToast('邀约已暂停；正在处理的请求仍会记录结果。');
  } catch (error) {
    showAlert(error?.message || '无法暂停当前任务。');
  } finally {
    setBusy(false);
    renderAll();
  }
}

async function resolveUnknown(itemId, status) {
  if (!job?.id || !itemId || !['succeeded', 'skipped'].includes(status) || busy) return;
  const confirmed = status === 'succeeded'
    ? window.confirm('请先在官方平台核对这位达人确实已收到邀请。确认后只记录为人工标记，不会伪装成平台回执。')
    : window.confirm('确认跳过此人？系统不会自动重试。');
  if (!confirmed) return;
  jobOperationEpoch += 1;
  setBusy(true);
  try {
    const response = await request('INVITE_RESOLVE', { jobId: job.id, itemId, status });
    job = response.job || job;
    jobSignature = JSON.stringify(job);
    showToast(status === 'succeeded' ? '已记录为手工标记送达。' : '已跳过此人，不会自动重试。');
  } catch (error) {
    showAlert(error?.message || '无法处理此条未知结果。');
  } finally {
    setBusy(false);
    renderAll();
  }
}

function beginNewBatch() {
  if (jobBlocksNew()) {
    showAlert('当前任务仍在运行或有结果未知，请先处理。');
    return;
  }
  jobOperationEpoch += 1;
  releaseInviteBinding();
  workflowMode = 'new';
  step = 1;
  activePlatform = '';
  selectedTabId = '';
  selectedCreatorIds.clear();
  captureData = null;
  recipientSearch = '';
  dom['recipient-search'].value = '';
  dom['invite-platform'].value = '';
  resetOptions({ clearInput: true });
  showAlert('');
  renderAll();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderStepNav() {
  const preparedResume = workflowMode === 'resume' && job?.flowVersion === 2 && job.status === 'prepared';
  const startedResume = workflowMode === 'resume' && job?.flowVersion === 2 && ['running', 'paused', 'completed', 'failed'].includes(job.status);
  const current = preparedResume ? 2 : startedResume ? 3 : step;
  for (let index = 1; index <= 3; index += 1) {
    const indicator = dom[`step-indicator-${index}`];
    indicator.classList.toggle('is-current', current === index);
    indicator.classList.toggle('is-complete', current > index);
  }
  dom['step-creators'].hidden = workflowMode === 'resume' || step !== 1;
  dom['step-settings'].hidden = startedResume || (workflowMode === 'new' && step !== 2) || (workflowMode === 'resume' && !preparedResume);
  dom['step-start'].hidden = !startedResume;
}

function renderAll() {
  renderTabs();
  renderRecipients();
  renderSettings();
  renderStepNav();
  renderStartSummary();
  renderJob();
}

async function pollStatus() {
  if (document.visibilityState !== 'visible' || busy) return;
  const epoch = jobOperationEpoch;
  try {
    const response = await request('INVITE_STATUS');
    if (epoch !== jobOperationEpoch || busy) return;
    const next = response.job || null;
    const signature = JSON.stringify(next);
    const jobChanged = signature !== jobSignature;
    const previousRuntimeError = runtimeError;
    runtimeError = response.runtimeError || '';
    if (jobChanged || runtimeError !== previousRuntimeError) {
      job = next;
      jobSignature = signature;
      if (jobChanged && job?.flowVersion === 2 && ['completed', 'failed'].includes(job.status)) { workflowMode = 'new'; step = 1; }
      renderAll();
    } else renderJob();
  } catch (error) {
    if (epoch !== jobOperationEpoch || busy) return;
    runtimeError = error?.message || '本地任务状态暂时无法读取。';
    renderAll();
  }
}

function startPolling() {
  if (pollTimer || document.visibilityState !== 'visible') return;
  pollTimer = window.setInterval(() => { void pollStatus(); }, 2000);
}
function stopPolling() { window.clearInterval(pollTimer); pollTimer = 0; }

function wireEvents() {
  dom['invite-platform'].addEventListener('change', () => {
    activePlatform = dom['invite-platform'].value;
    selectedTabId = '';
    selectedCreatorIds.clear();
    captureData = null;
    recipientSearch = '';
    recipientPage = 1;
    dom['recipient-search'].value = '';
    resetOptions({ clearInput: true });
    setStepStatus('capture-feedback', activePlatform ? `选择一个${platformLabel(activePlatform)}官方页，再读取当前页候选或选本地名单。` : '请选择平台。');
    renderAll();
  });
  dom['invite-tab-select'].addEventListener('change', () => {
    selectedTabId = dom['invite-tab-select'].value;
    captureData = null;
    resetOptions({ clearInput: true });
    setStepStatus('capture-feedback', selectedTabId ? '已选择平台页。读取当前页只会读取候选资料。' : '请选择平台页。');
    renderAll();
  });
  dom['refresh-invite-tabs'].addEventListener('click', refreshTabs);
  dom['capture-current-page'].addEventListener('click', captureCurrentPage);
  dom['recipient-search'].addEventListener('input', (event) => { recipientSearch = event.target.value.trim(); recipientPage = 1; renderRecipients(); });
  dom['recipient-stage-filter'].addEventListener('change', () => { recipientStageFilter = dom['recipient-stage-filter'].value; recipientPage = 1; renderRecipients(); });
  dom['recipient-readiness-filter'].addEventListener('change', () => { recipientReadinessFilter = dom['recipient-readiness-filter'].value; recipientPage = 1; renderRecipients(); });
  dom['select-current-page'].addEventListener('click', () => {
    if (recipientControlsLocked()) return;
    const unselected = visibleRecipientIds.filter((id) => !selectedCreatorIds.has(id));
    const remaining = Math.max(0, 50 - selectedCreatorIds.size);
    if (unselected.length > remaining) {
      showAlert(`本页还有 ${unselected.length} 位未选，当前剩余 ${remaining} 个名额；本页选择未更改。`);
      return;
    }
    for (const id of unselected) selectedCreatorIds.add(id);
    showAlert('');
    renderRecipients();
  });
  dom['clear-current-page'].addEventListener('click', () => {
    if (recipientControlsLocked()) return;
    for (const id of visibleRecipientIds) selectedCreatorIds.delete(id);
    showAlert('');
    renderRecipients();
  });
  dom['clear-recipient-selection'].addEventListener('click', () => {
    if (recipientControlsLocked()) return;
    selectedCreatorIds.clear();
    showAlert('');
    renderRecipients();
  });
  dom['invite-template-select'].addEventListener('change', () => {
    selectedInviteTemplateId = dom['invite-template-select'].value;
    const selected = inviteTemplates.find((template) => template.id === selectedInviteTemplateId);
    if (selected) dom['invite-template-name'].value = selected.name;
    inviteTemplateFeedback = '';
    inviteTemplateFeedbackKind = '';
    renderInviteTemplates();
  });
  dom['invite-template-name'].addEventListener('input', renderInviteTemplates);
  dom['reload-invite-templates'].addEventListener('click', () => { void loadInviteTemplates(); });
  dom['save-invite-template'].addEventListener('click', () => { void saveInviteTemplate(); });
  dom['apply-invite-template'].addEventListener('click', applySelectedInviteTemplate);
  dom['delete-invite-template'].addEventListener('click', () => { void deleteInviteTemplate(); });
  dom['recipient-list'].addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-recipient-id]');
    if (!checkbox) return;
    const id = checkbox.dataset.recipientId;
    if (recipientControlsLocked()) { checkbox.checked = selectedCreatorIds.has(id); return; }
    if (checkbox.checked && !selectedCreatorIds.has(id) && selectedCreatorIds.size >= 50) {
      checkbox.checked = false;
      showAlert('每批最多选择 50 位达人。');
      return;
    }
    if (checkbox.checked) selectedCreatorIds.add(id); else selectedCreatorIds.delete(id);
    showAlert('');
    const anchorId = creatorId(selectedRecipientAnchor() || {});
    if (optionsRecipientId && anchorId !== optionsRecipientId) resetOptions({ clearInput: false });
    renderRecipients();
  });
  dom['recipient-previous'].addEventListener('click', () => { recipientPage = Math.max(1, recipientPage - 1); renderRecipients(); });
  dom['recipient-next'].addEventListener('click', () => { recipientPage += 1; renderRecipients(); });
  dom['continue-settings'].addEventListener('click', () => { void changeToSettings(); });
  dom['back-to-creators'].addEventListener('click', () => {
    if (busy) return;
    releaseInviteBinding();
    resetOptions({ clearInput: false });
    workflowMode = 'new';
    step = 1;
    renderAll();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  dom['retry-options'].addEventListener('click', () => void loadOptions({ keyword: productKeyword, cursor: productPageCursors[productPageIndex] || null }));
  dom['product-search'].addEventListener('input', (event) => onProductSearch(event.target.value));
  dom['product-list'].addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-product-id]');
    if (!checkbox) return;
    const maxProducts = activePlatform === 'douyin' ? 5 : 10;
    if (checkbox.checked && !selectedProductIds.has(checkbox.dataset.productId) && selectedProductIds.size >= maxProducts) {
      checkbox.checked = false;
      showAlert(`最多选择 ${maxProducts} 件商品。`);
      return;
    }
    showAlert('');
    if (checkbox.checked) selectedProductIds.add(checkbox.dataset.productId); else selectedProductIds.delete(checkbox.dataset.productId);
    renderProducts();
    renderStartSummary();
  });
  dom['product-previous'].addEventListener('click', () => {
    if (productPageIndex <= 0) return;
    productPageIndex -= 1;
    void loadOptions({ keyword: productKeyword, cursor: productPageCursors[productPageIndex] || null });
  });
  dom['product-next'].addEventListener('click', () => {
    if (!options?.hasMore || !options.cursor) return;
    productPageCursors = productPageCursors.slice(0, productPageIndex + 1);
    productPageCursors.push(options.cursor);
    productPageIndex += 1;
    void loadOptions({ keyword: productKeyword, cursor: productPageCursors[productPageIndex] });
  });
  dom['category-list'].addEventListener('change', (event) => updateOptionSelection(event, 'category-id', selectedCategoryIds));
  dom['right-list'].addEventListener('change', (event) => updateOptionSelection(event, 'right-id', selectedRightIds));
  for (const id of ['invite-message', 'contact-name', 'contact-phone', 'contact-wechat', 'invite-interval']) {
    dom[id].addEventListener('input', () => { if (id === 'invite-message') dom['message-count'].textContent = `${dom['invite-message'].value.length} / ${options?.platform === 'weixin' ? 200 : 500}`; renderSettings(); renderStartSummary(); });
    dom[id].addEventListener('change', () => { renderSettings(); renderStartSummary(); });
  }
  dom['start-invite-button'].addEventListener('click', (event) => {
    if (workflowMode === 'resume' && job?.status === 'prepared') void startExistingJob(event);
    else void startNewInvite(event);
  });
  dom['job-actions'].addEventListener('click', (event) => {
    const button = event.target.closest('[data-job-action]');
    if (!button || button.disabled || busy || !event.isTrusted) return;
    if (button.dataset.jobAction === 'pause') void pauseJob();
    else if (button.dataset.jobAction === 'resume') void startExistingJob(event);
    else if (button.dataset.jobAction === 'resolve-success') void resolveUnknown(button.dataset.itemId, 'succeeded');
    else if (button.dataset.jobAction === 'resolve-skip') void resolveUnknown(button.dataset.itemId, 'skipped');
    else if (button.dataset.jobAction === 'new-batch') beginNewBatch();
  });
  dom['export-invite-job'].addEventListener('click', exportLatestJob);
  dom['job-results-filter'].addEventListener('change', () => {
    resultFilter = dom['job-results-filter'].value;
    renderJob();
  });
  dom['export-invite-results'].addEventListener('click', exportInviteResults);
  dom['diagnostics-export-button'].addEventListener('click', () => {
    void exportDiagnostics({ button: dom['diagnostics-export-button'], notify: (message, kind) => showToast(message, kind === 'error') });
  });
  dom['invite-toast-region'].addEventListener('click', (event) => { if (event.target.closest('.invite-toast-close')) dom['invite-toast-region'].replaceChildren(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { void pollStatus(); startPolling(); }
    else stopPolling();
  });
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) releaseInviteBinding();
  });
}

async function initialize() {
  wireEvents();
  setBusy(true);
  const [stateResult, tabsResult, jobResult] = await Promise.allSettled([request('GET_STATE'), request('LIST_TABS'), request('INVITE_STATUS')]);
  if (stateResult.status === 'fulfilled') state = stateResult.value.state || { creators: [] };
  else showAlert(`无法读取本地达人库：${stateResult.reason?.message || '请重新打开工作台。'}`);
  if (tabsResult.status === 'fulfilled') tabs = Array.isArray(tabsResult.value.tabs) ? tabsResult.value.tabs.filter((tab) => ['douyin', 'weixin'].includes(tab.platform)) : [];
  else setStepStatus('capture-feedback', tabsResult.reason?.message || '无法读取平台标签页。', 'error');
  if (jobResult.status === 'fulfilled') {
    job = jobResult.value.job || null;
    runtimeError = jobResult.value.runtimeError || '';
    jobSignature = JSON.stringify(job);
    if (job?.flowVersion === 2 && ['prepared', 'paused', 'running'].includes(job.status)) { workflowMode = 'resume'; step = job.status === 'prepared' ? 2 : 3; }
  } else showAlert(`无法读取邀约状态：${jobResult.reason?.message || '请稍后重试。'}`);
  setBusy(false);
  renderAll();
  if (tabsResult.status === 'fulfilled' && !tabs.length) setStepStatus('capture-feedback', '没有已打开的抖音或视频号官方页面。打开平台页后刷新标签页。');
  startPolling();
  void loadInviteTemplates();
}

initialize();
