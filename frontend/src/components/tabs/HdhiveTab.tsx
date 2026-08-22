import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink, Key, LoaderCircle, Lock, LogOut, Plus, RefreshCw, Search, ShieldAlert, ShieldCheck, Unlock } from 'lucide-react';
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
  pageUrl?: string;
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
  tgtodrive?: {
    enabled: boolean;
    oauthAvailable?: boolean;
    baseUrl: string;
    installId: string;
    authorized: boolean;
    checkedAt: string | null;
    expiresAt: number | null;
    hasUser: boolean;
  };
}

interface HdhiveSearchResponse {
  items: HdhiveItem[];
  directLinkCount: number;
  loginRequired: boolean;
  warning: string;
}

interface HdhiveVerificationChallenge {
  challengeId: string;
  expiresInSeconds: number | null;
  imageUrl: string;
  resource: HdhiveResource;
  taskName: string;
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
  const [verificationChallenge, setVerificationChallenge] = useState<HdhiveVerificationChallenge | null>(null);
  const [verificationAnswer, setVerificationAnswer] = useState('');
  const [verificationLoading, setVerificationLoading] = useState(false);
  const [verificationImageKey, setVerificationImageKey] = useState(0);
  const [loginLoading, setLoginLoading] = useState(false);
  const [syncCookieLoading, setSyncCookieLoading] = useState(false);
  const [checkinLoading, setCheckinLoading] = useState(false);
  const prefillAppliedRef = useRef<HdhivePrefillData | null>(null);
  const canQueryHdhiveResources = Boolean(
    status?.tgtodrive?.authorized
    || status?.signedCustomerApiAvailable
    || status?.hasCookie
    || (status?.hasApiKey && status?.isAuthorized)
  );
  const tgtodriveAuthorized = Boolean(status?.tgtodrive?.authorized);
  const legacyOpenApiAuthorized = Boolean(status?.hasApiKey && status?.isAuthorized);
  const browserBridgeAvailable = Boolean(status?.signedCustomerApiAvailable);
  const cookieAvailable = Boolean(status?.hasCookie);
  const activeConnectionKey = !status?.enabled
    ? null
    : tgtodriveAuthorized
      ? 'tgtodrive'
      : legacyOpenApiAuthorized
        ? 'legacy-openapi'
        : browserBridgeAvailable
          ? 'browser-bridge'
          : cookieAvailable
            ? 'cookie'
            : null;
  const activeConnectionLabel = activeConnectionKey === 'tgtodrive'
    ? 'TgtoDrive OAuth'
    : activeConnectionKey === 'legacy-openapi'
      ? '旧版 OpenAPI OAuth'
      : activeConnectionKey === 'browser-bridge'
        ? 'Browser Bridge'
        : activeConnectionKey === 'cookie'
          ? 'Cookie 网页模式'
          : status?.enabled
            ? '尚未连接'
            : '影巢未启用';
  const connectionChannels = [
    {
      key: 'tgtodrive',
      name: 'TgtoDrive OAuth',
      role: '推荐主通道',
      detail: '用于资源查询、解锁和签到；授权令牌由 TgtoDrive 开放平台托管。',
      state: tgtodriveAuthorized
        ? '已授权'
        : (status?.tgtodrive?.enabled || status?.tgtodrive?.oauthAvailable ? '待授权' : '不可用'),
      available: tgtodriveAuthorized
    },
    {
      key: 'browser-bridge',
      name: 'Browser Bridge',
      role: '备用通道',
      detail: '提供网页签名、账号登录取 Cookie 和资源解锁能力。',
      state: browserBridgeAvailable
        ? '已接入'
        : status?.browserBridge?.enabled
          ? '缺少 Token'
          : '未启用',
      available: browserBridgeAvailable
    },
    {
      key: 'cookie',
      name: 'Cookie 网页模式',
      role: '兜底通道',
      detail: '直接解析影巢网页；能力有限，Cookie 失效后需要重新同步。',
      state: cookieAvailable ? '已配置' : '未配置',
      available: cookieAvailable
    },
    {
      key: 'legacy-openapi',
      name: '旧版 OpenAPI OAuth',
      role: '兼容通道',
      detail: '仅为已有 Client ID 与 API Key 的旧部署保留。',
      state: legacyOpenApiAuthorized
        ? '已授权'
        : status?.hasClient && status?.hasApiKey
          ? '待授权'
          : status?.hasClient || status?.hasApiKey
            ? '配置不完整'
            : '未配置',
      available: legacyOpenApiAuthorized
    }
  ];

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
      if (data.data.mode === 'tgtodrive') {
        toast.info('请在打开的页面中完成影巢授权，授权后本页会自动检测...');
        const startedAt = Date.now();
        const pollTimer = window.setInterval(async () => {
          try {
            const statusResponse = await fetch('/api/hdhive/tgtodrive/status', { cache: 'no-store' });
            const statusData = await statusResponse.json();
            if (statusData.success && statusData.data?.authorized) {
              window.clearInterval(pollTimer);
              toast.success('影巢 TgtoDrive 授权成功');
              loadStatus();
              return;
            }
            if (Date.now() - startedAt > 5 * 60 * 1000) {
              window.clearInterval(pollTimer);
              toast.error('影巢 TgtoDrive 授权超时，请重新发起授权');
            }
          } catch {
            if (Date.now() - startedAt > 5 * 60 * 1000) {
              window.clearInterval(pollTimer);
            }
          }
        }, 3000);
      }
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
        if (data.verificationRequired && data.challengeId && data.challengeImageReady) {
          setVerificationAnswer('');
          setVerificationImageKey(Date.now());
          setVerificationChallenge({
            challengeId: data.challengeId,
            expiresInSeconds: data.challengeExpiresInSeconds ?? null,
            imageUrl: `/api/hdhive/security/challenge-image?challengeId=${encodeURIComponent(data.challengeId)}`,
            resource,
            taskName,
          });
          toast.info('请观察动态画面并输入持续浮现的 5 位字符');
          return;
        }
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

  const handleVerifyChallenge = async () => {
    if (!verificationChallenge) return;
    const answer = verificationAnswer.trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(answer)) {
      toast.warning('请输入完整的 5 位动态验证码');
      return;
    }

    setVerificationLoading(true);
    let verificationAccepted = false;
    try {
      const response = await fetch('/api/hdhive/security/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId: verificationChallenge.challengeId, answer }),
      });
      const data = await response.json();
      if (!data.success) {
        toast.error(data.error || '动态验证码验证失败');
        setVerificationAnswer('');
        return;
      }

      const pending = verificationChallenge;
      verificationAccepted = true;
      setVerificationChallenge(null);
      setVerificationAnswer('');
      toast.success('人机验证通过，正在继续解锁');
      await handleUnlock(pending.resource);
    } catch {
      toast.error('动态验证码验证失败');
    } finally {
      if (!verificationAccepted) setVerificationLoading(false);
    }
  };

  const items = result?.items || [];

  return (
    <div className="space-y-6">
      {verificationChallenge && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-3xl border border-slate-700 bg-slate-900 p-6 text-white shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-semibold">完成人机验证</h3>
                <p className="mt-2 text-sm leading-6 text-slate-300">
                  这张图必须保持动态播放才看得清。观察持续变化的噪点，输入反复浮现的 5 位字符。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setVerificationChallenge(null)}
                disabled={verificationLoading}
                className="rounded-full px-3 py-1 text-sm text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-50"
              >
                关闭
              </button>
            </div>

            <div className="mt-5 overflow-hidden rounded-2xl border border-slate-700 bg-white">
              <img
                key={verificationImageKey}
                src={`${verificationChallenge.imageUrl}&t=${verificationImageKey}`}
                alt="影巢动态验证码"
                className="block aspect-[320/132] w-full object-cover [image-rendering:pixelated]"
              />
            </div>

            <p className="mt-3 text-xs text-slate-400">
              {verificationChallenge.expiresInSeconds
                ? `画面约 ${verificationChallenge.expiresInSeconds} 秒内有效；静止截图不会显示答案。`
                : '静止截图不会显示答案，请直接观察上方动态画面。'}
            </p>

            <input
              value={verificationAnswer}
              onChange={(event) => setVerificationAnswer(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5))}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleVerifyChallenge();
              }}
              autoFocus
              maxLength={5}
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="输入 5 位字符"
              className="mt-5 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-center text-xl tracking-[0.35em] text-white outline-none focus:border-lime-300"
            />

            <div className="mt-4 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setVerificationImageKey(Date.now())}
                disabled={verificationLoading}
                className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
              >
                <RefreshCw size={16} />
                重播画面
              </button>
              <button
                type="button"
                onClick={handleVerifyChallenge}
                disabled={verificationLoading || verificationAnswer.length !== 5}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-lime-300 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-lime-200 disabled:bg-slate-700 disabled:text-slate-400"
              >
                {verificationLoading ? <LoaderCircle size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
                验证并继续
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
              {activeConnectionKey ? <ShieldCheck size={20} className="text-emerald-600" /> : <Key size={20} className="text-[#0b57d0]" />}
              影巢连接
            </h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-sm text-slate-500">当前使用</span>
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-semibold ${activeConnectionKey ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                <span className={`h-2 w-2 rounded-full ${activeConnectionKey ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                {activeConnectionLabel}
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              {status?.enabled ? status.baseUrl : '请先在系统设置中启用影巢资源'}
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
              onClick={handleCheckin}
              disabled={(!status?.signedCustomerApiAvailable && !status?.tgtodrive?.authorized) || checkinLoading}
              className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <ShieldCheck size={16} />
              {checkinLoading ? '签到中' : '签到'}
            </button>
          </div>
        </div>
        <div className="mt-5 divide-y divide-slate-100 border-y border-slate-100">
          {connectionChannels.map(channel => {
            const isActive = activeConnectionKey === channel.key;
            return (
              <div key={channel.key} className="grid gap-3 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900">{channel.name}</span>
                    <span className="text-xs text-slate-500">{channel.role}</span>
                    {isActive && (
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">当前使用</span>
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{channel.detail}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                  <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${channel.available ? 'text-emerald-700' : 'text-slate-500'}`}>
                    <span className={`h-2 w-2 rounded-full ${channel.available ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                    {channel.state}
                  </span>
                  {channel.key === 'tgtodrive' && (
                    <>
                      <button
                        type="button"
                        onClick={handleOAuth}
                        disabled={!status?.tgtodrive?.oauthAvailable}
                        className="inline-flex items-center gap-1.5 rounded-full bg-[#0b57d0] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#0b57d0]/90 disabled:bg-slate-200 disabled:text-slate-500"
                      >
                        <Unlock size={14} />
                        {tgtodriveAuthorized ? '重新授权' : '授权'}
                      </button>
                      {tgtodriveAuthorized && (
                        <button
                          type="button"
                          onClick={handleRevokeOAuth}
                          className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          <LogOut size={14} />
                          撤销
                        </button>
                      )}
                    </>
                  )}
                  {channel.key === 'browser-bridge' && (
                    <>
                      <button
                        type="button"
                        onClick={handlePasswordLogin}
                        disabled={!status?.browserBridge?.canLogin || loginLoading}
                        className="inline-flex items-center gap-1.5 rounded-full bg-[#c4eed0] px-3 py-1.5 text-xs font-medium text-[#146c2e] hover:bg-[#b2e7c0] disabled:bg-slate-200 disabled:text-slate-500"
                      >
                        <Key size={14} />
                        {loginLoading ? '登录中' : '账号登录'}
                      </button>
                      <button
                        type="button"
                        onClick={handleSyncBridgeCookie}
                        disabled={!status?.browserBridge?.hasToken || syncCookieLoading}
                        className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        <RefreshCw size={14} className={syncCookieLoading ? 'animate-spin' : ''} />
                        同步 Cookie
                      </button>
                    </>
                  )}
                  {channel.key === 'legacy-openapi' && !status?.tgtodrive?.enabled && status?.hasClient && status?.hasApiKey && (
                    <>
                      <button
                        type="button"
                        onClick={handleOAuth}
                        className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        <Unlock size={14} />
                        {legacyOpenApiAuthorized ? '重新授权' : '授权'}
                      </button>
                      {legacyOpenApiAuthorized && (
                        <button
                          type="button"
                          onClick={handleRevokeOAuth}
                          className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          <LogOut size={14} />
                          撤销
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
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
                  {resource.pageUrl && (
                    <a
                      href={resource.pageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-2 inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100"
                    >
                      <ExternalLink size={14} />
                      详情
                    </a>
                  )}
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
