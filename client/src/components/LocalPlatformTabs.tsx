import { Link, useLocation } from 'react-router-dom';
import { BookOpen, CircleHelp, Grid2X2, Music2, Play, Video } from 'lucide-react';
import type { WorkbookPlatform } from '@shared/workbook';

const platformTabs: Array<{ platform: WorkbookPlatform | ''; label: string }> = [
  { platform: '', label: '全部' },
  { platform: 'douyin', label: '抖音' },
  { platform: 'channels', label: '视频号' },
  { platform: 'xiaohongshu', label: '小红书' },
  { platform: 'kuaishou', label: '快手' },
  { platform: 'unknown', label: '待核对' },
];

export default function LocalPlatformTabs({ unknownCount = 0 }: { unknownCount?: number }) {
  const location = useLocation();
  const selectedPlatform = new URLSearchParams(location.search).get('platform') ?? '';
  const currentPath = location.pathname;

  return <nav className="local-platform-tabs" aria-label="平台筛选">
    {platformTabs.map(({ platform, label }) => {
      const PlatformIcon = platform === 'douyin' ? Music2 : platform === 'channels' ? Video
        : platform === 'xiaohongshu' ? BookOpen : platform === 'kuaishou' ? Play
          : platform === 'unknown' ? CircleHelp : Grid2X2;
      const nextParams = new URLSearchParams(location.search);
      if (platform) nextParams.set('platform', platform); else nextParams.delete('platform');
      const query = nextParams.toString();
      return <Link
        key={platform}
        to={`${currentPath}${query ? `?${query}` : ''}`}
        className={`local-platform-tab${selectedPlatform === platform ? ' is-active' : ''}`}
        aria-current={selectedPlatform === platform ? 'page' : undefined}
      ><span className="local-platform-mark" data-platform={platform || 'all'} aria-hidden="true"><PlatformIcon size={12} strokeWidth={1.8} /></span>{label}{platform === 'unknown' && unknownCount > 0 && <span className="local-platform-tab-badge">{unknownCount.toLocaleString('zh-CN')}</span>}</Link>;
    })}
  </nav>;
}
