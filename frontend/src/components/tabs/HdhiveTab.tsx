import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink, Key, Lock, LogOut, Plus, RefreshCw, Search, ShieldAlert, ShieldCheck, Unlock } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { useDialog } from '../ui/Dialog';

interface HdhiveItem {
  id: string;
  tmdbId?: string;
  title: string;
  originalTitle?: string;
  year?: string;
  type?: 'movie' | 'tv' | 'unknown' | string;
  overview?: string;
  posterPath?: string;
  videoResolution?: string;
  shareNum?: number;
  pageUrl?: string;
  shareLink?: string;
  accessCode?: string;
}

interface HdhiveResource {
  id: string;
  slug: string;
  title: string;
  cloudType: string;
  cloudTypeName: string;
  sizeFormatted?: string;
  points?: number | null;
  isFree?: boolean;
  expired?: boolean;
  quality?: string[];
  link?: string;
  code?: string;
  isUnlocked?: boolean;
}

interface HdhiveStatus {
  enabled: boolean;
  baseUrl: string;
  hasCookie: boolean;
  hasUsername?: boolean;
  hasPassword?: boolean;
  hasClient: boolean;
  hasApiKey: boolean;
  isAuthorized: boolean;
  needsOAuth: boolean;
  tokenExpiresAt?: number | null;
  signedCustomerApiAvailable?: boolean;
  browserBridge?: {
    enabled: boolean;
    baseUrl: string;
    hasToken: boolean;
    canLogin: boolean;
  };
}

interface HdhiveSearchResponse {
  items: HdhiveItem[];
  directLinkCount: number;
  loginRequired: boolean;
  warning: string;
}

export interface HdhivePrefillData {
  /** 片名关键词 或 TMDB 数字 ID */
  query?: string;
  /** name=按片名搜；tmdbId=按 TMDB ID 查天翼资源 */
  searchMode?: 'name' | 'tmdbId';
  /** tmdbId 模式下的媒体类型 */
  tmdbType?: 'movie' | 'tv';
  /** 是否进入后自动搜索 */
  autoSearch?: boolean;
}

interface HdhiveTabProps {
  onTransfer: (data: any) => void;
  prefill?: HdhivePrefillData | null;
  onPrefillConsumed?: () => void;
}

const buildPosterUrl = (posterPath?: string) => {
  if (!posterPath) return '';
  if (/^https?:\/\//i.test(posterPath)) return posterPath;
  return `https://image.tmdb.org/t/p/w342${posterPath}`;
};

const normalizeType = (type?: string): 'movie' | 'tv' => {
  return type === 'movie' ? 'movie' : 'tv';
};

const getResourcePoints = (resource: HdhiveResource) => {
  return typeof resource.points === 'number' && Number.isFinite(resource.points) ? resource.points : null;
};

const formatResourceCost = (resource: HdhiveResource) => {
  if (resource.isFree) return '免费';
  const points = getResourcePoints(resource);
  return points === null ? '积分未知' : `${points} 积分`;
};

const HdhiveTab: React.FC<HdhiveTabProps> = ({ onTransfer, prefill, onPrefillConsumed }) => {
  const toast = useToast();
  const dialog = useDialog();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<HdhiveSearchResponse | null>(null);
  const [status, setStatus] = useState<HdhiveStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [tmdbType, setTmdbType] = useState<'movie' | 'tv'>('tv');
  const [searchMode, setSearchMode] = useState<'name' | 'tmdbId'>('name');
  const [resources, setResources] = useState<HdhiveResource[]>([]);
  // 当前天翼资源所属的 TMDB ID 与片名（来自 ID 查询或片名结果点“查天翼”），用于给创建的任务命名
  const [resourceTmdbId, setResourceTmdbId] = useState('');
  const [resourceTitle, setResourceTitle] = useState('');
  const [resourceLoading, setResourceLoading] = useState(false);
  const [unlockingSlug, setUnlockingSlug] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [syncCookieLoading, setSyncCookieLoading] = useState(false);
  const [checkinLoading, setCheckinLoading] = useState(false);
  const prefillAppliedRef = useRef<HdhivePrefillData | null>(null);
  const canQueryHdhiveResources = Boolean(
    status?.signedCustomerApiAvailable
    || status?.hasCookie
    || (status?.hasApiKey && status?.isAuthorized)
  );

  const loadStatus = async () => {
    setStatusLoading(true);
    try {
      const response = await fetch('/api/hdhive/status');
      const data = await response.json();
      if (data.success) {
        setStatus(data.data);
      }
    } catch (error) {
      toast.error('读取影巢状态失败');
    } finally {
      setStatusLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'hdhive_oauth_success') {
        toast.success('影巢 OAuth 授权成功');
        loadStatus();
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleOAuth = async () => {
    try {
      const response = await fetch('/api/hdhive/oauth/url');
      const data = await response.json();
      if (!data.success) {
        toast.error(data.error || '获取授权链接失败');
        return;
      }
      window.open(data.data.url, '_blank', 'noopener,noreferrer,width=960,height=720');
    } catch (error) {
      toast.error('获取授权链接失败');
    }
  };

  const handleRevokeOAuth = async () => {
    try {
      const response = await fetch('/api/hdhive/oauth/revoke', { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        toast.success('已撤销影巢 OAuth 授权');
        loadStatus();
      } else {
        toast.error(data.error || '撤销授权失败');
      }
    } catch (error) {
      toast.error('撤销授权失败');
    }
  };

  const handlePasswordLogin = async () => {
    setLoginLoading(true);
    try {
      const response = await fetch('/api/hdhive/login', { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        toast.success('影巢网页登录成功，Cookie 已同步');
        loadStatus();
      } else {
        toast.error(data.error || '影巢网页登录失败');
      }
    } catch (error) {
      toast.error('影巢网页登录失败');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleSyncBridgeCookie = async () => {
    setSyncCookieLoading(true);
    try {
      const response = await fetch('/api/hdhive/bridge/cookies', { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        toast.success('已从 Browser Bridge 同步 Cookie');
        loadStatus();
      } else {
        toast.error(data.error || '同步 Cookie 失败');
      }
    } catch (error) {
      toast.error('同步 Cookie 失败');
    } finally {
      setSyncCookieLoading(false);
    }
  };

  const handleCheckin = async () => {
    setCheckinLoading(true);
    try {
      const response = await fetch('/api/hdhive/checkin', { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        toast.success(data.message || '影巢签到请求已完成');
      } else {
        toast.error(data.message || data.error || '影巢签到失败');
      }
    } catch (error) {
      toast.error('影巢签到失败');
    } finally {
      setCheckinLoading(false);
    }
  };

  const handleSearch = async (searchKeyword = query) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (searchKeyword.trim()) params.set('keyword', searchKeyword.trim());
      params.set('limit', '40');
      const response = await fetch(`/api/hdhive/search?${params.toString()}`);
      const data = await response.json();
      if (!data.success) {
        toast.error(data.error || '影巢搜索失败');
        return;
      }
      setResult(data.data);
      if (data.data?.warning) {
        toast.info(data.data.warning);
      }
    } catch (error) {
      toast.error('影巢搜索失败: ' + (error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // 解析 TMDB 片名用于任务命名（纯 ID 查询时没有现成片名）
  const resolveTmdbTitle = async (type: 'movie' | 'tv', id: string) => {
    try {
      const response = await fetch(`/api/tmdb/${type}/${id}`);
      const data = await response.json();
      if (data.success && data.data?.title) {
        setResourceTitle(data.data.title);
      }
    } catch {
      /* 解析失败则保持回退到资源标题 */
    }
  };

  const handleQueryResources = async (nextType: 'movie' | 'tv' = tmdbType, nextTmdbId = '', nextTitle = '') => {
    const normalizedTmdbId = String(nextTmdbId || '').trim();
    if (!normalizedTmdbId || !/^\d+$/.test(normalizedTmdbId)) {
      toast.warning('TMDB ID 必须是数字');
      return;
    }

    setTmdbType(nextType);
    setResourceLoading(true);
    setResourceTmdbId(normalizedTmdbId);
    // 片名结果点“查天翼”时已带片名，直接用；纯 ID 查询先清空、随后解析
    setResourceTitle(nextTitle || '');
    try {
      const params = new URLSearchParams({ type: nextType, tmdbId: normalizedTmdbId });
      const response = await fetch(`/api/hdhive/resources?${params.toString()}`);
      const data = await response.json();
      if (!data.success) {
        toast.error(data.error || '影巢资源查询失败');
        return;
      }
      setResources(data.data || []);
      if (!data.data?.length) {
        toast.info('未找到天翼云盘资源');
      }
      if (!nextTitle) {
        resolveTmdbTitle(nextType, normalizedTmdbId);
      }
    } catch (error) {
      toast.error('影巢资源查询失败');
    } finally {
      setResourceLoading(false);
    }
  };

  // 统一搜索入口：按所选模式分发——TMDB ID 模式查天翼资源，片名模式走 TMDB 搜索（留空读首页推荐）
  const handleUnifiedSearch = () => {
    const value = query.trim();
    if (searchMode === 'tmdbId') {
      handleQueryResources(tmdbType, value);
    } else {
      handleSearch(value);
    }
  };

  // 海报墙等入口跳转时预填搜索条件（在搜索函数定义之后挂载）
  useEffect(() => {
    if (!prefill) {
      prefillAppliedRef.current = null;
      return;
    }
    if (prefillAppliedRef.current === prefill) return;

    const nextQuery = String(prefill.query || '').trim();
    const nextMode = prefill.searchMode === 'tmdbId' ? 'tmdbId' : 'name';
    const nextType = prefill.tmdbType === 'movie' ? 'movie' : 'tv';
    const shouldAuto = prefill.autoSearch !== false && !!nextQuery;

    setSearchMode(nextMode);
    setTmdbType(nextType);
    setQuery(nextQuery);
    prefillAppliedRef.current = prefill;

    // 等状态提交后再清理父级 prefill，避免重复触发
    const timer = window.setTimeout(() => {
      onPrefillConsumed?.();
      if (shouldAuto) {
        if (nextMode === 'tmdbId') {
          handleQueryResources(nextType, nextQuery);
        } else {
          handleSearch(nextQuery);
        }
      }
    }, 0);

    return () => window.clearTimeout(timer);
    // 仅在 prefill 引用变化时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  const transferShare = (shareLink: string, accessCode: string, taskName: string, tmdbId = '') => {
    onTransfer({
      shareLink,
      accessCode: accessCode || '',
      taskName,
      tmdbId: tmdbId || undefined
    });
  };

  const handleUnlock = async (resource: HdhiveResource) => {
    // 优先用所选媒体的片名给任务命名，缺省回退资源标题；TMDB ID 用于预填表单刮削字段
    const taskName = resourceTitle || resource.title;
    if (resource.link) {
      transferShare(resource.link, resource.code || '', taskName, resourceTmdbId);
      return;
    }

    const points = getResourcePoints(resource);
    if (!resource.isFree && points === null) {
      const confirmed = await dialog.confirm({
        title: '确认解锁影巢资源',
        message: `「${resource.title}」的积分消耗未知，是否继续？`,
        confirmText: '继续解锁',
        tone: 'warning',
      });
      if (!confirmed) return;
    }

    if (!resource.isFree && points !== null && points > 0) {
      const confirmed = await dialog.confirm({
        title: '确认解锁影巢资源',
        message: `解锁「${resource.title}」会消耗 ${points} 积分，是否继续？`,
        confirmText: '解锁',
        tone: 'warning',
      });
      if (!confirmed) return;
    }

    setUnlockingSlug(resource.slug || resource.id);
    try {
      const response = await fetch('/api/hdhive/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: resource.slug || resource.id })
      });
      const data = await response.json();
      if (!data.success) {
        toast.error(data.error || '资源解锁失败');
        return;
      }
      const link = data.data?.link || '';
      if (!link) {
        toast.error('解锁成功但未返回天翼链接');
        return;
      }
      toast.success('资源已解锁，已预填创建任务');
      transferShare(link, data.data?.code || '', taskName, resourceTmdbId);
      loadStatus();
    } catch (error) {
      toast.error('资源解锁失败');
    } finally {
      setUnlockingSlug('');
    }
  };

  const items = result?.items || [];

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
              {status?.isAuthorized ? <ShieldCheck size={20} className="text-emerald-600" /> : <Key size={20} className="text-[#0b57d0]" />}
              影巢 OpenAPI
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              {status?.enabled ? `已启用 · ${status.baseUrl}` : '未启用，请先在系统设置中配置影巢'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={loadStatus}
              disabled={statusLoading}
              className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              <RefreshCw size={16} className={statusLoading ? 'animate-spin' : ''} />
              刷新状态
            </button>
            <button
              type="button"
              onClick={handleOAuth}
              disabled={!status?.hasClient || !status?.hasApiKey}
              className="inline-flex items-center gap-2 rounded-full bg-[#0b57d0] px-4 py-2 text-sm font-medium text-white hover:bg-[#0b57d0]/90 disabled:bg-slate-200 disabled:text-slate-500"
            >
              <Unlock size={16} />
              OAuth 授权
            </button>
            <button
              type="button"
              onClick={handleRevokeOAuth}
              disabled={!status?.isAuthorized}
              className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <LogOut size={16} />
              撤销授权
            </button>
            <button
              type="button"
              onClick={handlePasswordLogin}
              disabled={!status?.browserBridge?.canLogin || loginLoading}
              className="inline-flex items-center gap-2 rounded-full bg-[#c4eed0] px-4 py-2 text-sm font-medium text-[#146c2e] hover:bg-[#b2e7c0] disabled:bg-slate-200 disabled:text-slate-500"
            >
              <Key size={16} />
              {loginLoading ? '登录中' : '账号登录取 Cookie'}
            </button>
            <button
              type="button"
              onClick={handleSyncBridgeCookie}
              disabled={!status?.browserBridge?.hasToken || syncCookieLoading}
              className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw size={16} className={syncCookieLoading ? 'animate-spin' : ''} />
              同步 Cookie
            </button>
            <button
              type="button"
              onClick={handleCheckin}
              disabled={!status?.signedCustomerApiAvailable || checkinLoading}
              className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <ShieldCheck size={16} />
              {checkinLoading ? '签到中' : '签到'}
            </button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
          {[
            ['Cookie', status?.hasCookie ? '已配置' : '未配置'],
            ['Bridge', status?.signedCustomerApiAvailable ? '已接入' : '未接入'],
            ['Client ID', status?.hasClient ? '已配置' : '未配置'],
            ['API Key', status?.hasApiKey ? '已配置' : '未配置'],
            ['OAuth', status?.isAuthorized ? '已授权' : '未授权']
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl bg-slate-50 px-4 py-3">
              <p className="text-xs text-slate-500">{label}</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">{value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#0b57d0]">搜索资源</p>
          <h3 className="mt-1 text-base font-semibold text-slate-900">片名 / TMDB ID 搜索</h3>
          <p className="mt-1 text-sm text-slate-500">
            在框前选择检索方式：片名走 TMDB 搜索（留空读取首页公开推荐）；TMDB ID 按所选类型直接查天翼资源。
          </p>
        </div>
        <div className="flex flex-col gap-4 md:flex-row md:items-center">
          <select
            value={searchMode}
            onChange={e => setSearchMode(e.target.value as 'name' | 'tmdbId')}
            title="选择检索方式"
            className="rounded-2xl border border-slate-300 bg-slate-50 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
          >
            <option value="name">片名</option>
            <option value="tmdbId">TMDB ID</option>
          </select>
          {searchMode === 'tmdbId' && (
            <select
              value={tmdbType}
              onChange={e => setTmdbType(e.target.value as 'movie' | 'tv')}
              title="按 TMDB ID 查询时使用的类型"
              className="rounded-2xl border border-slate-300 bg-slate-50 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
            >
              <option value="tv">剧集</option>
              <option value="movie">电影</option>
            </select>
          )}
          <div className="relative flex-1">
            <Search size={20} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleUnifiedSearch()}
              placeholder={searchMode === 'tmdbId' ? 'TMDB 数字 ID，例如 568160' : '片名或 TMDB 关键词，例如：天气之子'}
              className="w-full rounded-2xl border border-slate-300 bg-slate-50 py-3 pl-12 pr-4 text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
            />
          </div>
          <button
            type="button"
            onClick={handleUnifiedSearch}
            disabled={loading || resourceLoading}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-[#0b57d0] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0b57d0]/90 disabled:opacity-70"
          >
            {(loading || resourceLoading) ? <RefreshCw size={18} className="animate-spin" /> : <Search size={18} />}
            搜索
          </button>
        </div>
        {result?.warning && (
          <div className="mt-4 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <ShieldAlert size={18} className="mt-0.5 shrink-0" />
            <span>{result.warning}</span>
          </div>
        )}
        {resources.length > 0 && (
          <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
            {resources.map(resource => {
              const busy = unlockingSlug === (resource.slug || resource.id);
              return (
                <div key={resource.slug || resource.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className="line-clamp-2 text-sm font-semibold text-slate-900">{resource.title}</h4>
                      <p className="mt-1 text-xs text-slate-500">
                        {[resource.cloudTypeName, resource.sizeFormatted, resource.quality?.join(' / ')].filter(Boolean).join(' · ') || '天翼云盘资源'}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full bg-white px-3 py-1 text-xs text-slate-600">
                      {formatResourceCost(resource)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleUnlock(resource)}
                    disabled={busy || resource.expired}
                    className="mt-4 inline-flex items-center gap-2 rounded-full bg-[#0b57d0] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#0b57d0]/90 disabled:bg-slate-200 disabled:text-slate-500"
                  >
                    {busy ? <RefreshCw size={15} className="animate-spin" /> : <Unlock size={15} />}
                    {resource.link ? '直接转存' : '解锁并转存'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {!loading && items.length === 0 && (
          <div className="col-span-full rounded-3xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">
            在上方输入片名搜索后点“查天翼”，或直接输入 TMDB 数字 ID 查询天翼资源。
          </div>
        )}

        {items.map((item, index) => {
          const posterUrl = buildPosterUrl(item.posterPath);
          const canTransfer = !!item.shareLink;
          const canQueryResources = !!item.tmdbId && ['movie', 'tv'].includes(String(item.type || ''));
          return (
            <div key={`${item.id}-${index}`} className="flex gap-4 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="h-32 w-24 shrink-0 overflow-hidden rounded-2xl bg-slate-100">
                {posterUrl ? (
                  <img src={posterUrl} alt={item.title} className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-xs text-slate-400">无海报</div>
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                <div>
                  <h3 className="line-clamp-2 text-base font-semibold text-slate-900">{item.title}</h3>
                  <p className="mt-1 text-xs text-slate-500">
                    {[item.year, item.type === 'tv' ? '剧集' : item.type === 'movie' ? '电影' : '', item.videoResolution, item.tmdbId ? `TMDB ${item.tmdbId}` : ''].filter(Boolean).join(' · ') || '影巢资源'}
                  </p>
                </div>
                {item.overview && (
                  <p className="line-clamp-2 text-xs leading-relaxed text-slate-500">{item.overview}</p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {item.shareNum ? (
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">{item.shareNum} 个资源</span>
                  ) : null}
                  {canTransfer ? (
                    <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs text-emerald-700">可直接转存</span>
                  ) : (
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">可查 OpenAPI</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {item.pageUrl && (
                    <a
                      href={item.pageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-4 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-200"
                    >
                      <ExternalLink size={15} />
                      详情
                    </a>
                  )}
                  <button
                    type="button"
                    disabled={!canTransfer}
                    onClick={() => transferShare(item.shareLink || '', item.accessCode || '', item.title, item.tmdbId || '')}
                    className="inline-flex items-center gap-1.5 rounded-full bg-[#c4eed0] px-4 py-2 text-xs font-medium text-[#146c2e] transition-colors hover:bg-[#b2e7c0] disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                  >
                    <Plus size={15} />
                    转存
                  </button>
                  <button
                    type="button"
                    disabled={!canQueryResources || !canQueryHdhiveResources}
                    onClick={() => handleQueryResources(normalizeType(item.type), item.tmdbId || item.id, item.title)}
                    className="inline-flex items-center gap-1.5 rounded-full bg-[#d3e3fd] px-4 py-2 text-xs font-medium text-[#0b57d0] transition-colors hover:bg-[#c2e7ff] disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                  >
                    <Lock size={15} />
                    查天翼
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default HdhiveTab;
