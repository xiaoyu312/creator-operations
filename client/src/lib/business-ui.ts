import type { ContentAssetWorkspaceItem, ContentRightScope, Role } from '../../../shared/types.ts';

export function canManageBusiness(role: Role) {
  return role === 'admin' || role === 'manager';
}

export function splitTags(value: string) {
  return [...new Set(value.split(/[，,\n]/u).map((tag) => tag.trim()).filter(Boolean))];
}

export function parsePositiveCents(value: string) {
  const cents = parseCents(value);
  return cents !== null && cents > 0 ? cents : null;
}

export function parseNonnegativeCents(value: string) {
  return parseCents(value);
}

function parseCents(value: string) {
  const trimmed = value.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/u.exec(trimmed);
  if (!match || match[1].length > 16) return null;
  const wholeCents = BigInt(match[1]) * 100n;
  const fractionalCents = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  const total = wholeCents + fractionalCents;
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
}

export function parseNonnegativeInteger(value: string) {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const number = Number(trimmed);
  return Number.isSafeInteger(number) ? number : null;
}

export function shanghaiMonthValue(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}`;
}

export function isObservedInShanghaiMonth(value: string, month: string, observedAt: string) {
  const timestamp = Date.parse(value);
  const cutoff = Date.parse(observedAt);
  return Number.isFinite(timestamp) && Number.isFinite(cutoff) && timestamp <= cutoff
    && shanghaiMonthValue(new Date(timestamp)) === month;
}

export type RightsPresentation = {
  label: string;
  tone: 'neutral' | 'blue' | 'green' | 'orange' | 'red';
  activeScopes: ContentRightScope[];
};

export function rightsPresentation(asset: ContentAssetWorkspaceItem, now = Date.now()): RightsPresentation {
  if (asset.rightsStatus === 'revoked') return { label: '已撤回', tone: 'red', activeScopes: [] };
  if (asset.rightsStatus === 'unknown') return { label: '授权未核实', tone: 'neutral', activeScopes: [] };
  if (asset.rightsStatus === 'pending') return { label: '待授权', tone: 'orange', activeScopes: [] };

  const startsAt = asset.rightsValidFrom ? Date.parse(asset.rightsValidFrom) : null;
  const endsAt = asset.rightsValidUntil ? Date.parse(asset.rightsValidUntil) : null;
  if (startsAt !== null && Number.isFinite(startsAt) && startsAt > now) {
    return { label: '未来生效', tone: 'blue', activeScopes: [] };
  }
  if (endsAt !== null && Number.isFinite(endsAt) && endsAt <= now) {
    return { label: '授权已过期', tone: 'red', activeScopes: [] };
  }
  if (asset.authorizationEffectiveNow) {
    return { label: '授权生效中', tone: 'green', activeScopes: asset.effectiveRightsScope };
  }
  return { label: '当前无效', tone: 'orange', activeScopes: [] };
}
