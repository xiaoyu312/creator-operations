import type { Platform } from '@shared/types';
import { Grid2X2 } from 'lucide-react';
import { platformLabel, type CreatorPlatformFilter } from '../lib/platform-presentation';
import '../platform-tabs.css';

const displayOrder: readonly Platform[] = ['douyin', 'kuaishou', 'channels', 'xiaohongshu'];

export function PlatformMark({ platform }: { platform: CreatorPlatformFilter }) {
  return <span className="platform-brand-mark" data-platform={platform} aria-hidden="true">
    {platform === 'all' ? <Grid2X2 size={16} strokeWidth={2} />
      : platform === 'douyin' ? <svg viewBox="0 0 24 24" fill="none"><path d="M14.2 3v11.1a4.3 4.3 0 1 1-3.8-4.2v3a1.5 1.5 0 1 0 1 1.4V3h2.8Zm0 0c.4 2.5 1.9 4 4.8 4.2v2.7c-2.1-.2-3.7-.9-4.8-2" fill="currentColor" /></svg>
      : platform === 'kuaishou' ? <svg viewBox="0 0 24 24" fill="none"><circle cx="8" cy="6.4" r="3.2" stroke="currentColor" strokeWidth="2" /><circle cx="15" cy="6.4" r="3.2" stroke="currentColor" strokeWidth="2" /><rect x="4.5" y="11" width="11" height="9" rx="2.3" stroke="currentColor" strokeWidth="2" /><path d="m16 13 4-2v9l-4-2" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>
      : platform === 'channels' ? <svg viewBox="0 0 24 24" fill="none"><path d="M12 19C9 12 6 4 3.7 5.5c-3.8 3.6 1.6 15.3 7.4 12.8 4-1.7 10.5-9.5 8.7-12.8C18 2.4 15.3 9 12 19Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      : <span className="platform-xhs-wordmark">小红书</span>}
  </span>;
}

interface PlatformTabsProps {
  value: CreatorPlatformFilter;
  onChange: (value: CreatorPlatformFilter) => void;
  allowAll?: boolean;
  variant?: 'line' | 'pill' | 'segment';
  label?: string;
}

export default function PlatformTabs({ value, onChange, allowAll = true, variant = 'line', label = '平台筛选' }: PlatformTabsProps) {
  const options: CreatorPlatformFilter[] = allowAll ? ['all', ...displayOrder] : [...displayOrder];
  return <div className={`platform-switch platform-switch--${variant}`} role="group" aria-label={label}>
    {options.map((platform) => <button
      key={platform}
      type="button"
      className={`platform-switch-button${value === platform ? ' is-active' : ''}`}
      aria-pressed={value === platform}
      onClick={() => onChange(platform)}
    ><PlatformMark platform={platform} /><span>{platform === 'all' ? (variant === 'segment' ? '全部' : '全部平台') : platformLabel(platform)}</span></button>)}
  </div>;
}
