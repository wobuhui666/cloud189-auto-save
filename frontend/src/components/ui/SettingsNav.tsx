import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';

export interface SettingsNavItem {
  id: string;
  label: string;
  /** 额外匹配关键词（过滤用） */
  keywords?: string[];
}

interface SettingsNavProps {
  items: SettingsNavItem[];
  /** 过滤变化时回传可见 id 列表，父级用来隐藏 section */
  onVisibleChange?: (visibleIds: string[]) => void;
  className?: string;
}

const SettingsNav: React.FC<SettingsNavProps> = ({ items, onVisibleChange, className = '' }) => {
  const [query, setQuery] = useState('');

  const visibleItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => {
      const hay = [item.label, ...(item.keywords || [])].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [items, query]);

  React.useEffect(() => {
    onVisibleChange?.(visibleItems.map((i) => i.id));
  }, [visibleItems, onVisibleChange]);

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className={`space-y-3 ${className}`}>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-secondary)]" size={16} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="过滤分区…"
          className="w-full pl-10 pr-4 py-2.5 bg-[var(--bg-main)] border border-[var(--border-color)] rounded-full text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 text-[var(--text-primary)]"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {visibleItems.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => scrollTo(item.id)}
            className="px-3 py-1.5 rounded-full text-xs font-medium border border-[var(--border-color)] bg-[var(--bg-main)] text-[var(--text-primary)] hover:bg-[#d3e3fd]/60 hover:border-[#0b57d0]/40 dark:hover:bg-[#0b57d0]/20 transition-colors"
          >
            {item.label}
          </button>
        ))}
        {visibleItems.length === 0 && (
          <span className="text-xs text-[var(--text-secondary)] py-1">无匹配分区</span>
        )}
      </div>
    </div>
  );
};

export default SettingsNav;

/** 滚动到 section；用于跨 Tab 跳转 */
export function scrollToSettingsSection(id: string, retries = 12) {
  const tryScroll = (left: number) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (left > 0) {
      requestAnimationFrame(() => tryScroll(left - 1));
    }
  };
  // 等 Tab 挂载
  setTimeout(() => tryScroll(retries), 50);
}

export const MEDIA_SECTION_STORAGE_KEY = 'media-scroll-section';
