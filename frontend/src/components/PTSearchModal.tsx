import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Clapperboard,
  Download,
  Eye,
  Loader2,
} from 'lucide-react';
import Modal from './Modal';

export interface PtSubscriptionPrefill {
  name: string;
  rssUrl: string;
  sourcePreset: string;
}

interface SourcePreset {
  key: string;
  label: string;
}

export interface PTSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 默认搜索词（海报墙传入条目标题；PT 标签页可不传） */
  defaultKeyword?: string;
  /** 是否动漫上下文（false 时显示「非动漫源」警告） */
  isAnime?: boolean;
  /** 弹窗打开时是否立即用 defaultKeyword 触发一次聚合搜索 */
  autoSearchOnOpen?: boolean;
  /** 标题后缀（用于显示当前条目名等） */
  titleSuffix?: string;
  /** 选中后的回调：调用方负责打开 PT 订阅创建框并预填 */
  onCreatePtSubscription: (data: PtSubscriptionPrefill) => void;
}

const SEARCHABLE_PRESET_KEYS = new Set(['mikan', 'anibt', 'animegarden', 'nyaa', 'dmhy']);

const PRESET_BADGE: Record<string, string> = {
  mikan: 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300',
  anibt: 'bg-pink-100 text-pink-700 dark:bg-pink-500/15 dark:text-pink-300',
  animegarden: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  nyaa: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
  dmhy: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
};

const PTSearchModal: React.FC<PTSearchModalProps> = ({
  isOpen,
  onClose,
  defaultKeyword = '',
  isAnime = true,
  autoSearchOnOpen = false,
  titleSuffix,
  onCreatePtSubscription,
}) => {
  const [presets, setPresets] = useState<SourcePreset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string>('all');
  const [keyword, setKeyword] = useState<string>(defaultKeyword);
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 字幕组步骤
  const [step, setStep] = useState<'search' | 'groups'>('search');
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groups, setGroups] = useState<any[]>([]);
  const [selectedAnime, setSelectedAnime] = useState<any | null>(null);

  // 字幕组文件预览
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  const [previewItems, setPreviewItems] = useState<any[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);

  // 关闭时全部重置；打开时同步 defaultKeyword
  useEffect(() => {
    if (!isOpen) {
      setResults([]);
      setSearched(false);
      setError(null);
      setStep('search');
      setGroups([]);
      setSelectedAnime(null);
      setPreviewIdx(null);
      setPreviewItems([]);
      return;
    }
    setKeyword(defaultKeyword);
  }, [isOpen, defaultKeyword]);

  // 拉预设
  useEffect(() => {
    if (!isOpen) return;
    fetch('/api/pt/sources/presets')
      .then((r) => r.json())
      .then((data) => {
        if (data?.success && Array.isArray(data.data)) {
          const searchable = (data.data as SourcePreset[]).filter((p) => SEARCHABLE_PRESET_KEYS.has(p.key));
          setPresets(searchable);
        }
      })
      .catch(() => {});
  }, [isOpen]);

  const runSearch = useCallback(async (kw: string, preset: string) => {
    const k = kw.trim();
    if (!k) return;
    setLoading(true);
    setSearched(true);
    setError(null);
    setResults([]);
    setStep('search');
    try {
      const endpoint =
        preset === 'all'
          ? `/api/pt/sources/search-all?keyword=${encodeURIComponent(k)}`
          : `/api/pt/sources/search?preset=${encodeURIComponent(preset)}&keyword=${encodeURIComponent(k)}`;
      const r = await fetch(endpoint);
      const text = await r.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`服务返回非 JSON：${text.slice(0, 120)}`);
      }
      if (data?.success) {
        setResults(Array.isArray(data.data) ? data.data : []);
      } else {
        setError(data?.error || '搜索失败');
      }
    } catch (e: any) {
      setError(e?.message || '请求失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // 自动触发搜索（仅当 autoSearchOnOpen 且 defaultKeyword 非空）
  useEffect(() => {
    if (isOpen && autoSearchOnOpen && defaultKeyword.trim()) {
      runSearch(defaultKeyword, 'all');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, defaultKeyword, autoSearchOnOpen]);

  // 选搜索结果：directRss 直走；否则进字幕组
  const handleSelectAnime = async (anime: any) => {
    const sourceKey: string = anime.source || selectedPreset;
    if (anime.directRss && anime.url) {
      onCreatePtSubscription({
        name: anime.title || defaultKeyword,
        rssUrl: anime.url,
        sourcePreset: sourceKey,
      });
      onClose();
      return;
    }
    setSelectedAnime(anime);
    setStep('groups');
    setGroups([]);
    setError(null);
    setGroupsLoading(true);
    try {
      const params =
        sourceKey === 'mikan'
          ? `bangumiUrl=${encodeURIComponent(anime.url || '')}`
          : `bgmId=${encodeURIComponent(anime.id || '')}`;
      const r = await fetch(`/api/pt/sources/groups?preset=${encodeURIComponent(sourceKey)}&${params}`);
      const text = await r.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`服务返回非 JSON：${text.slice(0, 120)}`);
      }
      if (data?.success) {
        setGroups(Array.isArray(data.data) ? data.data : []);
      } else {
        setError(data?.error || '获取字幕组失败');
      }
    } catch (e: any) {
      setError(e?.message || '获取字幕组失败');
    } finally {
      setGroupsLoading(false);
    }
  };

  const handleSelectGroup = (group: any) => {
    if (!group?.rssUrl) return;
    const baseTitle = selectedAnime?.title || defaultKeyword || '';
    const groupName = group.name || '';
    onCreatePtSubscription({
      name: groupName ? `${baseTitle} - ${groupName}`.trim() : baseTitle,
      rssUrl: group.rssUrl,
      sourcePreset: group.source || selectedAnime?.source || selectedPreset,
    });
    onClose();
  };

  const backToSearch = () => {
    setStep('search');
    setGroups([]);
    setSelectedAnime(null);
    setError(null);
    setPreviewIdx(null);
    setPreviewItems([]);
  };

  // 切换字幕组的文件预览（同一项再点为收起）
  const togglePreview = async (idx: number, group: any) => {
    if (previewIdx === idx) {
      setPreviewIdx(null);
      setPreviewItems([]);
      return;
    }
    setPreviewIdx(idx);
    setPreviewItems([]);
    setPreviewLoading(true);
    try {
      const r = await fetch(
        `/api/pt/sources/group-items?rssUrl=${encodeURIComponent(group.rssUrl || '')}&preset=${encodeURIComponent(group.source || selectedAnime?.source || selectedPreset)}`
      );
      const text = await r.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`服务返回非 JSON：${text.slice(0, 120)}`);
      }
      if (data?.success) {
        setPreviewItems(Array.isArray(data.data) ? data.data : []);
      } else {
        setPreviewItems([]);
      }
    } catch {
      setPreviewItems([]);
    } finally {
      setPreviewLoading(false);
    }
  };

  const titleSearch = titleSuffix ? `搜索下载 · ${titleSuffix}` : '搜索资源';
  const titleGroups = `选择字幕组 · ${selectedAnime?.title || titleSuffix || ''}`;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={step === 'groups' ? titleGroups : titleSearch}
      footer={null}
    >
      <div className="space-y-4">
        {/* 非动漫源提示 */}
        {step === 'search' && !isAnime && (
          <div className="flex items-start gap-2 px-4 py-3 rounded-2xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200/60 dark:border-amber-500/20 text-xs text-amber-800 dark:text-amber-300">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>当前 PT 源主要面向动漫资源（Mikan / AniBT / Nyaa / 动漫花园 等），对电影/电视剧搜索结果可能为空。</span>
          </div>
        )}

        {/* 搜索栏（仅 search 步骤） */}
        {step === 'search' && (
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runSearch(keyword, selectedPreset);
              }}
              placeholder="搜索关键词（番剧名 / 中日英文）"
              autoFocus
              className="flex-1 px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-2xl text-sm text-slate-800 dark:text-slate-200 outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
            />
            <select
              value={selectedPreset}
              onChange={(e) => setSelectedPreset(e.target.value)}
              className="sm:w-44 px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-2xl text-sm text-slate-800 dark:text-slate-200 outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
            >
              <option value="all">全网聚合（推荐）</option>
              {presets.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => runSearch(keyword, selectedPreset)}
              disabled={loading || !keyword.trim()}
              className="px-5 py-2.5 rounded-full text-sm font-medium bg-[#0b57d0] hover:bg-[#0b57d0]/90 disabled:bg-[#0b57d0]/50 disabled:cursor-not-allowed text-white shadow-sm transition-colors flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              搜索
            </button>
          </div>
        )}

        {/* 字幕组返回栏 */}
        {step === 'groups' && (
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={backToSearch}
              className="inline-flex items-center gap-1 text-sm text-[#0b57d0] hover:underline"
            >
              <ChevronLeft className="w-4 h-4" />
              返回搜索结果
            </button>
            <span className="text-xs text-slate-400 dark:text-slate-500">选择一个字幕组即可创建订阅</span>
          </div>
        )}

        {/* 错误 */}
        {error && (
          <div className="px-4 py-3 rounded-2xl bg-red-50 dark:bg-red-500/10 border border-red-200/60 dark:border-red-500/20 text-xs text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {/* 列表 */}
        <div className="max-h-80 overflow-y-auto custom-scrollbar space-y-2 pr-1">
          {step === 'search' ? (
            loading ? (
              <div className="flex items-center justify-center py-10 text-slate-400 dark:text-slate-500">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                搜索中…
              </div>
            ) : searched && results.length === 0 && !error ? (
              <div className="text-center py-10 text-sm text-slate-400 dark:text-slate-500">未找到结果</div>
            ) : !searched ? (
              <div className="text-center py-10 text-sm text-slate-400 dark:text-slate-500">输入关键词后点击「搜索」</div>
            ) : (
              results.map((r, i) => {
                const sourceKey: string = r.source || selectedPreset;
                const sourceLabel = (presets.find((p) => p.key === sourceKey)?.label) || sourceKey;
                const badgeCls = PRESET_BADGE[sourceKey] || 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300';
                const directRss = !!r.directRss;
                return (
                  <button
                    type="button"
                    key={`${sourceKey}-${r.id || i}`}
                    onClick={() => handleSelectAnime(r)}
                    className="w-full flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-800 rounded-2xl hover:bg-[#d3e3fd] dark:hover:bg-[#0b57d0]/15 hover:ring-1 hover:ring-[#0b57d0]/40 transition-colors text-left group"
                  >
                    {r.cover ? (
                      <img
                        src={r.cover}
                        alt=""
                        className="w-12 h-16 object-cover rounded-lg flex-shrink-0 bg-slate-200 dark:bg-slate-700"
                        referrerPolicy="no-referrer-when-downgrade"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    ) : (
                      <div className="w-12 h-16 rounded-lg flex-shrink-0 bg-slate-200 dark:bg-slate-700 flex items-center justify-center">
                        <Clapperboard className="w-5 h-5 text-slate-400" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">{r.title}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${badgeCls}`}>{sourceLabel}</span>
                        {directRss && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                            直 RSS
                          </span>
                        )}
                        {typeof r.itemCount === 'number' && r.itemCount > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200 font-medium">
                            {r.itemCount} 个资源
                          </span>
                        )}
                        {!directRss && Array.isArray(r.groups) && r.groups.length > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200 font-medium">
                            {r.groups.length} 个字幕组
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-xs text-[#0b57d0] group-hover:underline">
                          {directRss ? '点击直接创建订阅 →' : '点击选择字幕组 →'}
                        </span>
                        {r.url && (
                          <a
                            href={r.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-xs text-slate-500 dark:text-slate-400 hover:text-[#0b57d0] hover:underline"
                          >
                            查看详情
                          </a>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })
            )
          ) : groupsLoading ? (
            <div className="flex items-center justify-center py-10 text-slate-400 dark:text-slate-500">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              加载字幕组…
            </div>
          ) : groups.length === 0 && !error ? (
            <div className="text-center py-10 text-sm text-slate-400 dark:text-slate-500">未找到字幕组</div>
          ) : (
            groups.map((g, i) => {
              const isOpen = previewIdx === i;
              return (
                <div
                  key={`${g.rssUrl || ''}-${i}`}
                  className={`bg-slate-50 dark:bg-slate-800 rounded-2xl transition-colors ${isOpen ? 'ring-1 ring-[#0b57d0]/40' : 'hover:bg-[#d3e3fd] dark:hover:bg-[#0b57d0]/15 hover:ring-1 hover:ring-[#0b57d0]/40'}`}
                >
                  <div className="flex items-center justify-between p-3 gap-2">
                    {/* 主区：点击选中创建订阅 */}
                    <button
                      type="button"
                      onClick={() => handleSelectGroup(g)}
                      className="flex-1 min-w-0 text-left group"
                      title="使用此 RSS 创建订阅"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
                          {g.name || '未命名字幕组'}
                        </span>
                        {typeof g.itemCount === 'number' && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#d3e3fd] text-[#0b57d0] dark:bg-[#0b57d0]/20 dark:text-[#8ab4f8] font-medium">
                            {g.itemCount} 个资源
                          </span>
                        )}
                      </div>
                      {g.rssUrl && (
                        <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 truncate">
                          {g.rssUrl}
                        </div>
                      )}
                    </button>

                    {/* 预览按钮 */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePreview(i, g);
                      }}
                      className={`flex-shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs transition-colors ${
                        isOpen
                          ? 'bg-[#0b57d0]/10 text-[#0b57d0] dark:bg-[#0b57d0]/20'
                          : 'text-slate-500 dark:text-slate-400 hover:bg-slate-200/70 dark:hover:bg-slate-700'
                      }`}
                      title={isOpen ? '收起文件预览' : '查看文件名'}
                    >
                      <Eye className="w-3.5 h-3.5" />
                      预览
                      {isOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>

                    {/* 使用 RSS 提示 */}
                    <span className="flex-shrink-0 text-xs text-[#0b57d0]">使用此 RSS →</span>
                  </div>

                  {/* 文件预览列表 */}
                  {isOpen && (
                    <div className="px-4 pb-3 -mt-1">
                      {previewLoading ? (
                        <div className="flex items-center text-xs text-slate-400 dark:text-slate-500 py-2">
                          <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                          加载文件列表…
                        </div>
                      ) : previewItems.length === 0 ? (
                        <div className="text-xs text-slate-400 dark:text-slate-500 py-2">该 RSS 暂无可见资源</div>
                      ) : (
                        <ul className="max-h-44 overflow-y-auto custom-scrollbar space-y-1 pr-1 border-t border-slate-200/60 dark:border-slate-700/60 pt-2">
                          {previewItems.map((it: any, j: number) => (
                            <li
                              key={j}
                              className="text-xs text-slate-600 dark:text-slate-300 truncate font-mono"
                              title={it.title}
                            >
                              <span className="text-slate-400 dark:text-slate-500 mr-1">·</span>
                              {it.title || '(无标题)'}
                            </li>
                          ))}
                          {previewItems.length >= 20 && (
                            <li className="text-[10px] text-slate-400 dark:text-slate-500 pt-1">
                              仅展示前 {previewItems.length} 条，更多请查看 RSS 源
                            </li>
                          )}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {step === 'search' && searched && results.length > 0 && (
          <div className="text-[11px] text-slate-400 dark:text-slate-500 px-1">
            提示：「直 RSS」标记的会直接创建订阅；其它结果会进入字幕组选择步骤。
          </div>
        )}
      </div>
    </Modal>
  );
};

export default PTSearchModal;
