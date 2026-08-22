import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Copy,
  Filter,
  History,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { lockBodyScroll, unlockBodyScroll } from '../../lib/bodyScrollLock';
import { getOverlayZIndex, popOverlay, pushOverlay } from '../../lib/overlayStack';

export interface HistoryFilters {
  keyword?: string;
  module?: string;
  action?: string;
  status?: string;
  accountId?: string | number;
  subjectType?: string;
  subjectId?: string | number;
  correlationId?: string;
}

interface AuditRun {
  id: string;
  correlationId: string;
  parentRunId?: string;
  module: string;
  trigger: string;
  subjectType: string;
  subjectId: string;
  subjectName: string;
  accountId?: number | null;
  status: string;
  summary: string;
  changeCount: number;
  failureCount: number;
  startedAt: string;
  finishedAt?: string | null;
  metadata?: Record<string, unknown>;
}

interface AuditEvent {
  id: number;
  sequence: number;
  type: string;
  level: string;
  phase: string;
  message: string;
  error?: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

interface AuditOperation {
  id: number;
  sequence: number;
  action: string;
  status: string;
  sourcePath?: string;
  targetPath?: string;
  reason?: string;
  decisionSource?: string;
  attempts?: number;
  error?: string;
  before?: unknown;
  after?: unknown;
  verification?: unknown;
  createdAt: string;
}

interface AuditDetail {
  run: AuditRun;
  events: AuditEvent[];
  operations: AuditOperation[];
  relatedRuns: AuditRun[];
}

interface FilterOptions {
  modules: string[];
  actions: string[];
  statuses: string[];
  accounts: Array<{ id: number; label: string }>;
}

interface HistoryTabProps {
  initialFilters?: HistoryFilters;
}

const PAGE_SIZE = 50;
const MODULE_LABELS: Record<string, string> = {
  auto_series: '自动追剧',
  transfer: '转存',
  task: '任务',
  organizer: '整理器',
  pt: 'PT',
  cas: 'CAS',
  strm: 'STRM',
  emby: '媒体库通知',
  workflow: '工作流',
  system: '系统',
};
const ACTION_LABELS: Record<string, string> = {
  identify: '识别',
  classify: '分类',
  rename: '重命名',
  move: '移动',
  upgrade: '洗版',
  upload: '上传',
  delete: '删除',
  strm: 'STRM',
  notify: '通知',
  skip: '跳过',
};
const STATUS_LABELS: Record<string, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  partial: '部分完成',
  interrupted: '已中断',
  skipped: '已跳过',
  retrying: '等待重试',
  retry_wait: '等待重试',
  no_coverage: '无覆盖',
  pending: '等待中',
};

const formatDateTime = (value?: string | null) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() > Date.now() + 24 * 60 * 60 * 1000) return '-';
  return date.toLocaleString('zh-CN', { hour12: false });
};

const formatDuration = (run: AuditRun) => {
  const start = new Date(run.startedAt).getTime();
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
};

const statusClass = (status: string) => {
  if (status === 'completed') return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/25 dark:text-emerald-300';
  if (status === 'running' || status === 'pending') return 'bg-blue-50 text-blue-700 dark:bg-blue-900/25 dark:text-blue-300';
  if (status === 'failed') return 'bg-red-50 text-red-700 dark:bg-red-900/25 dark:text-red-300';
  return 'bg-amber-50 text-amber-700 dark:bg-amber-900/25 dark:text-amber-300';
};

const stringifyValue = (value: unknown) => {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
};

const PathValue: React.FC<{ value?: string; onCopy: (value: string) => void; copied: string }> = ({ value, onCopy, copied }) => {
  if (!value) return null;
  return (
    <div className="ui-card-muted flex min-w-0 items-start gap-2 px-3 py-2">
      <code className="min-w-0 flex-1 break-all text-xs text-[var(--text-primary)]">{value}</code>
      <button type="button" onClick={() => onCopy(value)} className="shrink-0 text-[var(--text-secondary)] hover:text-[#0b57d0]" title="复制路径" aria-label="复制路径">
        {copied === value ? <Check size={15} /> : <Copy size={15} />}
      </button>
    </div>
  );
};

const HistoryTab: React.FC<HistoryTabProps> = ({ initialFilters = {} }) => {
  const [filters, setFilters] = useState<HistoryFilters>(initialFilters);
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<AuditRun[]>([]);
  const [stats, setStats] = useState({ runs: 0, changes: 0, failures: 0, running: 0 });
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [options, setOptions] = useState<FilterOptions>({ modules: [], actions: [], statuses: [], accounts: [] });
  const [detail, setDetail] = useState<AuditDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [copied, setCopied] = useState('');
  const [drawerZ, setDrawerZ] = useState({ backdrop: 150, panel: 151 });

  useEffect(() => {
    setFilters(initialFilters);
    setPage(1);
  }, [initialFilters]);

  const queryString = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== null && String(value).trim()) params.set(key, String(value).trim());
    });
    if (startAt) params.set('startAt', new Date(startAt).toISOString());
    if (endAt) params.set('endAt', new Date(endAt).toISOString());
    return params.toString();
  }, [filters, startAt, endAt, page]);

  const loadRuns = useCallback(async (silent = false, signal?: AbortSignal) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch(`/api/audit-runs?${queryString}`, { signal });
      const payload = await response.json();
      if (!payload.success) throw new Error(payload.error || '加载历史失败');
      setItems(payload.data.items || []);
      setStats(payload.data.stats || { runs: 0, changes: 0, failures: 0, running: 0 });
      setPages(Math.max(1, Number(payload.data.pages || 1)));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) console.error(error);
    } finally {
      if (!silent && !signal?.aborted) setLoading(false);
    }
  }, [queryString]);

  const loadDetail = useCallback(async (id: string, silent = false) => {
    if (!silent) setDetailLoading(true);
    try {
      const response = await fetch(`/api/audit-runs/${encodeURIComponent(id)}`);
      const payload = await response.json();
      if (!payload.success) throw new Error(payload.error || '加载审计详情失败');
      setDetail(payload.data);
    } catch (error) {
      console.error(error);
    } finally {
      if (!silent) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadRuns(false, controller.signal);
    return () => controller.abort();
  }, [loadRuns]);

  useEffect(() => {
    fetch('/api/audit-filter-options')
      .then(response => response.json())
      .then(payload => { if (payload.success) setOptions(payload.data); })
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (stats.running <= 0) return;
    const timer = window.setInterval(() => {
      loadRuns(true);
      if (detail?.run.status === 'running') loadDetail(detail.run.id, true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [stats.running, detail?.run.id, detail?.run.status, loadRuns, loadDetail]);

  useEffect(() => {
    if (!detail) return;
    lockBodyScroll();
    const overlayId = pushOverlay({ kind: 'drawer', onEscape: () => setDetail(null) });
    setDrawerZ(getOverlayZIndex(overlayId, 'drawer'));
    return () => {
      popOverlay(overlayId);
      unlockBodyScroll();
    };
  }, [Boolean(detail)]);

  const updateFilter = (key: keyof HistoryFilters, value: string) => {
    setFilters(current => ({ ...current, [key]: value || undefined }));
    setPage(1);
  };

  const copyPath = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(value);
    window.setTimeout(() => setCopied(current => current === value ? '' : current), 1200);
  };

  const resetFilters = () => {
    setFilters({});
    setStartAt('');
    setEndAt('');
    setPage(1);
  };

  const hasFilters = Object.values(filters).some(Boolean) || startAt || endAt;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-bold ui-title">全链路历史</h2>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">实际变更、判断依据与失败结果</p>
        </div>
        <button type="button" onClick={() => loadRuns()} className="inline-flex h-10 items-center justify-center gap-2 rounded-full border border-slate-300 bg-white px-4 text-sm text-slate-600 shadow-sm transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800">
          <RefreshCw size={17} className={loading ? 'animate-spin' : ''} />
          刷新
        </button>
      </div>

      <section className="ui-card overflow-hidden shadow-sm">
        <div className="grid grid-cols-2 divide-x divide-y divide-[var(--border-color)] md:grid-cols-4 md:divide-y-0">
          {[
            ['运行', stats.runs],
            ['实际变更', stats.changes],
            ['失败操作', stats.failures],
            ['进行中', stats.running],
          ].map(([label, value]) => (
            <div key={String(label)} className="px-5 py-4">
              <div className="text-xs text-[var(--text-secondary)]">{label}</div>
              <div className="mt-1 text-xl font-semibold text-[var(--text-primary)]">{value}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="ui-card space-y-4 p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="relative xl:col-span-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-secondary)]" size={17} />
            <input value={filters.keyword || ''} onChange={event => updateFilter('keyword', event.target.value)} placeholder="主体、摘要、ID 或关联链路" className="ui-input h-10 w-full rounded-2xl pl-10 pr-3 text-sm outline-none focus:border-[#0b57d0]" />
          </label>
          <input type="datetime-local" value={startAt} onChange={event => { setStartAt(event.target.value); setPage(1); }} className="ui-input h-10 rounded-2xl px-3 text-sm" aria-label="开始时间" />
          <input type="datetime-local" value={endAt} onChange={event => { setEndAt(event.target.value); setPage(1); }} className="ui-input h-10 rounded-2xl px-3 text-sm" aria-label="结束时间" />
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          <select value={filters.module || ''} onChange={event => updateFilter('module', event.target.value)} className="ui-input h-10 min-w-0 rounded-2xl px-3 text-sm">
            <option value="">全部模块</option>
            {options.modules.map(value => <option key={value} value={value}>{MODULE_LABELS[value] || value}</option>)}
          </select>
          <select value={filters.action || ''} onChange={event => updateFilter('action', event.target.value)} className="ui-input h-10 min-w-0 rounded-2xl px-3 text-sm">
            <option value="">全部动作</option>
            {options.actions.map(value => <option key={value} value={value}>{ACTION_LABELS[value] || value}</option>)}
          </select>
          <select value={filters.status || ''} onChange={event => updateFilter('status', event.target.value)} className="ui-input h-10 min-w-0 rounded-2xl px-3 text-sm">
            <option value="">全部状态</option>
            {options.statuses.map(value => <option key={value} value={value}>{STATUS_LABELS[value] || value}</option>)}
          </select>
          <select value={String(filters.accountId || '')} onChange={event => updateFilter('accountId', event.target.value)} className="ui-input h-10 min-w-0 rounded-2xl px-3 text-sm">
            <option value="">全部账号</option>
            {options.accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}
          </select>
          {hasFilters && (
            <button type="button" onClick={resetFilters} className="col-span-2 inline-flex h-10 items-center justify-center gap-2 text-sm text-[var(--text-secondary)] hover:text-[#0b57d0] md:col-span-1">
              <Filter size={16} /> 清除筛选
            </button>
          )}
        </div>
      </section>

      <section className="ui-card overflow-hidden shadow-sm">
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full table-fixed text-left text-sm">
            <thead className="border-b border-slate-100 bg-slate-50/50 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400">
              <tr>
                <th className="w-40 px-4 py-3 font-medium">时间</th>
                <th className="w-[28%] px-4 py-3 font-medium">业务主体</th>
                <th className="w-28 px-4 py-3 font-medium">模块</th>
                <th className="w-28 px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">摘要</th>
                <th className="w-28 px-4 py-3 text-right font-medium">变更 / 失败</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
              {items.map(run => (
                <tr key={run.id} onClick={() => loadDetail(run.id)} className="cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <td className="px-5 py-4 align-top text-xs text-slate-500 dark:text-slate-400">{formatDateTime(run.startedAt)}</td>
                  <td className="px-5 py-4 align-top">
                    <div className="truncate font-medium text-[var(--text-primary)]">{run.subjectName || `${run.subjectType} ${run.subjectId}` || '系统运行'}</div>
                    <div className="mt-1 truncate text-xs text-[var(--text-secondary)]">{run.trigger || 'system'} · {formatDuration(run)}</div>
                  </td>
                  <td className="px-5 py-4 align-top text-[var(--text-primary)]">{MODULE_LABELS[run.module] || run.module}</td>
                  <td className="px-5 py-4 align-top"><span className={`inline-flex rounded-md px-2.5 py-1 text-xs font-bold ${statusClass(run.status)}`}>{STATUS_LABELS[run.status] || run.status}</span></td>
                  <td className="px-5 py-4 align-top text-[var(--text-secondary)]"><div className="line-clamp-2 break-words">{run.summary || '暂无摘要'}</div></td>
                  <td className="px-5 py-4 text-right align-top"><span className="text-emerald-600">{run.changeCount}</span><span className="mx-1 text-[var(--text-secondary)]">/</span><span className={run.failureCount ? 'text-red-600' : 'text-[var(--text-secondary)]'}>{run.failureCount}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="divide-y divide-slate-100 dark:divide-slate-700 md:hidden">
          {items.map(run => (
            <button key={run.id} type="button" onClick={() => loadDetail(run.id)} className="block w-full px-4 py-4 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-[var(--text-primary)]">{run.subjectName || `${run.subjectType} ${run.subjectId}` || '系统运行'}</div>
                  <div className="mt-1 text-xs text-[var(--text-secondary)]">{formatDateTime(run.startedAt)} · {MODULE_LABELS[run.module] || run.module}</div>
                </div>
                <span className={`shrink-0 rounded-md px-2.5 py-1 text-xs font-bold ${statusClass(run.status)}`}>{STATUS_LABELS[run.status] || run.status}</span>
              </div>
              <p className="mt-2 line-clamp-2 break-words text-sm text-[var(--text-secondary)]">{run.summary || '暂无摘要'}</p>
              <div className="mt-2 text-xs text-[var(--text-secondary)]">变更 {run.changeCount} · 失败 {run.failureCount}</div>
            </button>
          ))}
        </div>

        {!loading && items.length === 0 && <div className="px-4 py-16 text-center text-sm text-[var(--text-secondary)]"><History className="mx-auto mb-3" size={28} />暂无匹配的历史记录</div>}
        {loading && items.length === 0 && <div className="px-4 py-16 text-center text-sm text-[var(--text-secondary)]"><RefreshCw className="mx-auto mb-3 animate-spin" size={24} />加载中</div>}
      </section>

      <div className="flex items-center justify-between text-sm text-[var(--text-secondary)]">
        <span>第 {page} / {pages} 页，每页 {PAGE_SIZE} 条</span>
        <div className="flex gap-2">
          <button type="button" disabled={page <= 1} onClick={() => setPage(current => Math.max(1, current - 1))} className="rounded-full border border-slate-300 bg-white p-2 text-slate-600 shadow-sm transition-colors hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800" title="上一页" aria-label="上一页"><ChevronLeft size={17} /></button>
          <button type="button" disabled={page >= pages} onClick={() => setPage(current => Math.min(pages, current + 1))} className="rounded-full border border-slate-300 bg-white p-2 text-slate-600 shadow-sm transition-colors hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800" title="下一页" aria-label="下一页"><ChevronRight size={17} /></button>
        </div>
      </div>

      {createPortal(
        <AnimatePresence>
          {(detail || detailLoading) && (
            <>
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setDetail(null)} style={{ zIndex: drawerZ.backdrop }} className="fixed inset-0 bg-slate-950/45" />
              <motion.aside initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', bounce: 0, duration: 0.35 }} style={{ zIndex: drawerZ.panel }} className="fixed inset-y-0 right-0 flex w-full max-w-2xl flex-col rounded-l-[28px] border-l border-[var(--modal-border)] bg-[var(--modal-bg)] shadow-2xl">
                <header className="flex h-16 shrink-0 items-center justify-between border-b border-[var(--border-color)] px-4 md:px-6">
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold text-[var(--text-primary)]">{detail?.run.subjectName || '审计详情'}</h3>
                    {detail && <p className="mt-0.5 truncate text-xs text-[var(--text-secondary)]">{detail.run.id}</p>}
                  </div>
                  <button type="button" onClick={() => setDetail(null)} className="shrink-0 p-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]" title="关闭" aria-label="关闭"><X size={21} /></button>
                </header>

                <div className="flex-1 overflow-y-auto px-4 py-5 md:px-6">
                  {detailLoading && !detail ? (
                    <div className="py-20 text-center text-[var(--text-secondary)]"><RefreshCw className="mx-auto animate-spin" /></div>
                  ) : detail && (
                    <div className="space-y-7">
                      <section className="grid grid-cols-2 gap-x-5 gap-y-4 border-b border-[var(--border-color)] pb-6 text-sm">
                        <div><div className="text-xs text-[var(--text-secondary)]">状态</div><div className="mt-1 text-[var(--text-primary)]">{STATUS_LABELS[detail.run.status] || detail.run.status}</div></div>
                        <div><div className="text-xs text-[var(--text-secondary)]">模块</div><div className="mt-1 text-[var(--text-primary)]">{MODULE_LABELS[detail.run.module] || detail.run.module}</div></div>
                        <div><div className="text-xs text-[var(--text-secondary)]">开始</div><div className="mt-1 text-[var(--text-primary)]">{formatDateTime(detail.run.startedAt)}</div></div>
                        <div><div className="text-xs text-[var(--text-secondary)]">耗时</div><div className="mt-1 text-[var(--text-primary)]">{formatDuration(detail.run)}</div></div>
                        <div className="col-span-2"><div className="text-xs text-[var(--text-secondary)]">摘要</div><div className="mt-1 break-words text-[var(--text-primary)]">{detail.run.summary || '暂无摘要'}</div></div>
                      </section>

                      {detail.relatedRuns.length > 1 && (
                        <section>
                          <h4 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">关联链路</h4>
                          <div className="border-l border-[var(--border-color)] pl-4">
                            {detail.relatedRuns.map(run => (
                              <button key={run.id} type="button" onClick={() => loadDetail(run.id)} className="relative block w-full pb-4 text-left last:pb-0">
                                <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-[#0b57d0] bg-[var(--bg-surface)]" />
                                <div className="flex items-center justify-between gap-3"><span className="truncate text-sm text-[var(--text-primary)]">{run.subjectName || MODULE_LABELS[run.module] || run.module}</span><span className="shrink-0 text-xs text-[var(--text-secondary)]">{STATUS_LABELS[run.status] || run.status}</span></div>
                                <div className="mt-1 text-xs text-[var(--text-secondary)]">{formatDateTime(run.startedAt)} · {MODULE_LABELS[run.module] || run.module}</div>
                              </button>
                            ))}
                          </div>
                        </section>
                      )}

                      <section>
                        <h4 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">阶段事件</h4>
                        {detail.events.length ? <div className="space-y-3">
                          {detail.events.map(event => (
                            <div key={event.id} className="flex gap-3 border-b border-[var(--border-color)] pb-3 last:border-b-0">
                              <div className="pt-0.5">{event.level === 'error' ? <AlertCircle size={17} className="text-red-500" /> : <CircleDashed size={17} className="text-[#0b57d0]" />}</div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-start justify-between gap-3"><span className="break-words text-sm text-[var(--text-primary)]">{event.message}</span><span className="shrink-0 text-xs text-[var(--text-secondary)]">#{event.sequence}</span></div>
                                <div className="mt-1 text-xs text-[var(--text-secondary)]">{event.phase || event.type} · {formatDateTime(event.createdAt)}</div>
                                {event.error && <pre className="mt-2 whitespace-pre-wrap break-all text-xs text-red-600">{event.error}</pre>}
                                {event.data && Object.keys(event.data).length > 0 && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--bg-main)] p-2 text-xs text-[var(--text-secondary)]">{stringifyValue(event.data)}</pre>}
                              </div>
                            </div>
                          ))}
                        </div> : <p className="text-sm text-[var(--text-secondary)]">暂无阶段事件</p>}
                      </section>

                      <section>
                        <h4 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">逐文件操作</h4>
                        {detail.operations.length ? <div className="space-y-4">
                          {detail.operations.map(operation => (
                            <article key={operation.id} className="border-b border-[var(--border-color)] pb-4 last:border-b-0">
                              <div className="flex items-center justify-between gap-3">
                                <div className="flex min-w-0 items-center gap-2"><span className="rounded bg-[var(--bg-main)] px-2 py-1 text-xs font-medium text-[var(--text-primary)]">{ACTION_LABELS[operation.action] || operation.action}</span><span className={`text-xs ${operation.status === 'failed' ? 'text-red-600' : 'text-[var(--text-secondary)]'}`}>{STATUS_LABELS[operation.status] || operation.status}</span></div>
                                <span className="shrink-0 text-xs text-[var(--text-secondary)]">#{operation.sequence}{operation.attempts && operation.attempts > 1 ? ` · ${operation.attempts} 次` : ''}</span>
                              </div>
                              <div className="mt-3 space-y-2">
                                <PathValue value={operation.sourcePath} onCopy={copyPath} copied={copied} />
                                <PathValue value={operation.targetPath} onCopy={copyPath} copied={copied} />
                              </div>
                              {operation.reason && <p className="mt-2 break-words text-xs text-[var(--text-secondary)]">原因：{operation.reason}</p>}
                              {operation.decisionSource && <p className="mt-1 text-xs text-[var(--text-secondary)]">决策来源：{operation.decisionSource}</p>}
                              {operation.error && <pre className="mt-2 whitespace-pre-wrap break-all text-xs text-red-600">{operation.error}</pre>}
                              {(operation.before != null || operation.after != null || operation.verification != null) && (
                                <details className="mt-2 text-xs text-[var(--text-secondary)]">
                                  <summary className="cursor-pointer select-none">变更值与验证</summary>
                                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all bg-[var(--bg-main)] p-3">{stringifyValue({ before: operation.before, after: operation.after, verification: operation.verification })}</pre>
                                </details>
                              )}
                            </article>
                          ))}
                        </div> : <p className="text-sm text-[var(--text-secondary)]">历史数据或本次运行没有逐文件变更</p>}
                      </section>
                    </div>
                  )}
                </div>
              </motion.aside>
            </>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
};

export default HistoryTab;
