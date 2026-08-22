import React, { useState, useEffect, useRef } from 'react';
import { Plus, RefreshCw, RotateCcw, Trash2, Edit2, Folder, Magnet, AlertCircle, CheckCircle2, Power, Settings as SettingsIcon, Download, Upload, Search, ChevronRight, ChevronDown, Loader2, Wand2, Filter, Tags, History, ListChecks, Play, Clock3, Gauge } from 'lucide-react';
import Modal from '../Modal';
import PTSearchModal, { type PtSubscriptionPrefill } from '../PTSearchModal';
import FolderSelector, { SelectedFolder } from '../FolderSelector';
import Checkbox from '../ui/Checkbox';
import { useToast } from '../ui/Toast';
import { useDialog } from '../ui/Dialog';
import MetadataEditor from '../MetadataEditor';

interface SearchResult { id: string; title: string; cover: string; url: string; source: string; directRss?: boolean; preview?: string[]; groups?: GroupResult[]; }
interface GroupResult { name: string; rssUrl: string; itemCount?: number; source: string; }
interface FeedPreviewItem { title: string; rawTitle?: string; subgroup?: string; episodeLabel?: string; seasonNumber?: number; resolution?: string; quality?: string; size?: number; volumeFactor?: string; }

interface Account { id: number; username: string; alias?: string; }
interface SourcePreset { key: string; label: string; description: string; defaultRssUrl: string; }

interface PtSubscription {
  id: number;
  name: string;
  sourcePreset: string;
  rssUrl: string;
  includePattern: string;
  excludePattern: string;
  qualityPattern: string;
  resolutionPattern: string;
  effectPattern: string;
  sizeMinMB: number;
  sizeMaxMB: number;
  seedersMin: number;
  freeOnly: boolean;
  episodeDedup: boolean;
  standbyRssJson: string;
  coexist: boolean;
  downloadNew: boolean;
  delayedDownloadMinutes: number;
  notDownloadEpisodes: string;
  skipHalfEpisode: boolean;
  customEpisode: boolean;
  customEpisodeRegex: string;
  customEpisodeGroupIndex: number;
  episodeOffset: number;
  omit: boolean;
  missingEpisodesJson: string;
  totalEpisodeNumber: number;
  currentEpisodeNumber: number;
  autoDisabled: boolean;
  globalExclude: boolean;
  accountId: number;
  targetFolderId: string;
  targetFolder: string;
  enabled: boolean;
  lastCheckTime: string | null;
  lastStatus: string;
  lastMessage: string;
  releaseCount: number;
}

interface PtRelease {
  id: number;
  subscriptionId: number;
  title: string;
  status: string;
  progress?: number;
  qbTorrentHash: string;
  downloadPath: string;
  cloudFolderName: string;
  lastError: string;
  size?: number;
  seeders?: number;
  peers?: number;
  grabs?: number;
  downloadVolumeFactor?: number | null;
  uploadVolumeFactor?: number | null;
  rawTitle?: string;
  subgroup?: string;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  episodeLabel?: string;
  resolution?: string;
  quality?: string;
  releaseTagsJson?: string;
  publishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  downloader?: {
    state: string;
    progress?: number;
    downloadSpeed?: number;
    uploadSpeed?: number;
    eta?: number;
    seeds?: number;
    peers?: number;
    availability?: number;
    amountLeft?: number;
    isQueued?: boolean;
    isStopped?: boolean;
  } | null;
}

interface DownloaderSettings {
  type: string;
  baseUrl: string;
  username: string;
  password: string;
  hasPassword?: boolean;
  categoryPrefix: string;
  tagPrefix: string;
  forceStart: boolean;
  insecureSkipTlsVerify: boolean;
}

interface StrmOrganizeSettings {
  enabled: boolean;
  mode: 'regex' | 'ai';
  categoryFolder: string;
  fileTemplate: string;
  seasonRegex: string;
  episodeRegex: string;
  defaultSeason: number;
}

interface PtSettings {
  mikanBaseUrl: string;
  downloadRoot: string;
  pollCron: string;
  globalExcludePattern: string;
  cleanupEnabled: boolean;
  cleanupCron: string;
  retryIntervalSec: number;
  autoDeleteSource: boolean;
  deleteCloudSource: boolean;
  enableStrm: boolean;
  strmOrganize: StrmOrganizeSettings;
  downloader: DownloaderSettings;
}

const DEFAULT_FORM = {
  name: '',
  sourcePreset: 'generic',
  rssUrl: '',
  includePattern: '',
  excludePattern: '',
  qualityPattern: '',
  resolutionPattern: '',
  effectPattern: '',
  sizeMinMB: 0,
  sizeMaxMB: 0,
  seedersMin: 0,
  freeOnly: false,
  episodeDedup: false,
  standbyRssJson: '',
  coexist: false,
  downloadNew: false,
  delayedDownloadMinutes: 0,
  notDownloadEpisodes: '',
  skipHalfEpisode: false,
  customEpisode: false,
  customEpisodeRegex: '',
  customEpisodeGroupIndex: 1,
  episodeOffset: 0,
  omit: false,
  totalEpisodeNumber: 0,
  autoDisabled: false,
  globalExclude: true,
  accountId: 0,
  targetFolderId: '',
  targetFolder: '',
  enabled: true
};

const PT_DIR_MEMORY_KEY = 'ptLastUsedDir';
const getLastUsedDir = () => {
  try { const r = localStorage.getItem(PT_DIR_MEMORY_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
};

const formatDateTime = (s: string | null) => {
  if (!s) return '从未';
  return new Date(s).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

const formatSize = (bytes?: number) => {
  const n = Number(bytes || 0);
  if (!n || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n < 1024 ** 4) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  return `${(n / 1024 / 1024 / 1024 / 1024).toFixed(2)} TB`;
};

const formatSpeed = (bytesPerSecond?: number) => {
  const speed = Number(bytesPerSecond || 0);
  return speed > 0 && Number.isFinite(speed) ? `${formatSize(speed)}/s` : '0 B/s';
};

const formatEpisodeBadge = (rel: PtRelease): string => {
  const season = Number(rel.seasonNumber || 0);
  const episode = rel.episodeLabel || (rel.episodeNumber ? String(rel.episodeNumber).padStart(2, '0') : '');
  if (!episode) return '';
  return `S${String(season || 1).padStart(2, '0')}E${episode}`;
};

const parseMissingEpisodes = (sub: PtSubscription): number[] => {
  try {
    const parsed = JSON.parse(sub.missingEpisodesJson || '[]');
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
};

const statusColor = (status: string) => {
  switch (status) {
    case 'completed': return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300';
    case 'downloading':
    case 'downloaded':
    case 'uploading': return 'bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300';
    case 'failed':
    case 'upload_failed': return 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300';
    case 'pending': return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
    default: return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
  }
};

const statusAccent = (status: string) => {
  if (status === 'completed') return 'bg-emerald-500';
  if (['failed', 'upload_failed'].includes(status)) return 'bg-red-500';
  if (status === 'pending') return 'bg-slate-400';
  return 'bg-[#0b57d0]';
};

const statusLabel = (status: string) => {
  const map: Record<string, string> = {
    pending: '排队中',
    downloading: '下载中',
    downloaded: '已下载',
    uploading: '秒传中',
    completed: '已完成',
    failed: '失败',
    upload_failed: '秒传失败'
  };
  return map[status] || status;
};

const downloaderStateLabel = (state?: string) => {
  const map: Record<string, string> = {
    queuedDL: 'qB 排队',
    stalledDL: '等待连接',
    forcedDL: '强制下载',
    downloading: '正在下载',
    metaDL: '获取元数据',
    checkingDL: '校验文件',
    stoppedDL: '已停止',
    pausedDL: '已暂停',
    missingFiles: '文件丢失',
    error: '下载器错误',
    missing: '任务不存在',
    cleaned: 'qB 已清理'
  };
  return state ? (map[state] || state) : '未投递';
};

const downloaderStateColor = (state?: string) => {
  if (!state) return 'text-slate-400 dark:text-slate-500';
  if (['downloading', 'forcedDL', 'metaDL', 'checkingDL'].includes(state)) return 'text-blue-600 dark:text-blue-400';
  if (state === 'cleaned') return 'text-emerald-700 dark:text-emerald-400';
  if (['queuedDL', 'stalledDL'].includes(state)) return 'text-amber-600 dark:text-amber-400';
  if (['missingFiles', 'error', 'missing', 'stoppedDL', 'pausedDL'].includes(state)) return 'text-red-600 dark:text-red-400';
  return 'text-slate-500 dark:text-slate-400';
};

const isActiveRelease = (release: PtRelease) => ['pending', 'downloading', 'downloaded', 'uploading'].includes(release.status);

export interface PtPrefillData {
  name: string;
  rssUrl: string;
  sourcePreset: string;
}

interface PtTabProps {
  prefill?: PtPrefillData | null;
  onPrefillConsumed?: () => void;
  onNavigateHistory: (filters?: { module?: string; subjectType?: string; subjectId?: string | number }) => void;
}

const PtTab: React.FC<PtTabProps> = ({ prefill, onPrefillConsumed, onNavigateHistory }) => {
  const toast = useToast();
  const dialog = useDialog();
  const [subs, setSubs] = useState<PtSubscription[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [presets, setPresets] = useState<SourcePreset[]>([]);
  const [loading, setLoading] = useState(true);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<PtSubscription | null>(null);
  const [formData, setFormData] = useState({ ...DEFAULT_FORM });
  const [isSaving, setIsSaving] = useState(false);
  const [isDeduping, setIsDeduping] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showSourceDetails, setShowSourceDetails] = useState(false);
  const [feedPreviewItems, setFeedPreviewItems] = useState<FeedPreviewItem[]>([]);
  const [feedPreviewLoading, setFeedPreviewLoading] = useState(false);
  const [feedPreviewError, setFeedPreviewError] = useState('');
  const [aiRequirement, setAiRequirement] = useState('');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiExplanation, setAiExplanation] = useState('');

  const [folderSelectorOpen, setFolderSelectorOpen] = useState(false);

  const [managementView, setManagementView] = useState<'subscriptions' | 'releases'>('subscriptions');
  const [subscriptionQuery, setSubscriptionQuery] = useState('');
  const [allReleases, setAllReleases] = useState<PtRelease[]>([]);
  const [transferStats, setTransferStats] = useState({ downloadSpeed: 0, cloudUploadSpeed: 0 });
  const [releaseQuery, setReleaseQuery] = useState('');
  const [releaseStatusFilter, setReleaseStatusFilter] = useState<'all' | 'active' | 'failed' | 'completed'>('all');
  const [releaseSubscriptionFilter, setReleaseSubscriptionFilter] = useState('all');
  const [releaseActionId, setReleaseActionId] = useState<number | null>(null);
  const [processingReleases, setProcessingReleases] = useState(false);
  const [rebuildingAll, setRebuildingAll] = useState(false);
  const [releasesLoading, setReleasesLoading] = useState(false);
  const [metadataTarget, setMetadataTarget] = useState<{ type: 'subscription' | 'release'; id: number; title: string } | null>(null);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<PtSettings | null>(null);
  const [proxyServices, setProxyServices] = useState<Record<string, boolean>>({});
  const [testStatus, setTestStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testingMikan, setTestingMikan] = useState(false);
  const [mikanTestStatus, setMikanTestStatus] = useState<{ ok: boolean; message: string } | null>(null);

  // 搜索状态
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  // 顶部「搜索创建」入口的弹窗（与海报墙复用同组件）
  const [isExternalSearchOpen, setIsExternalSearchOpen] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchGroups, setSearchGroups] = useState<GroupResult[]>([]);
  const [searchStep, setSearchStep] = useState<'search' | 'groups'>('search');
  const [searchSelectedTitle, setSearchSelectedTitle] = useState('');
  const [aggregateSearch, setAggregateSearch] = useState(true);

  // 字幕组文件预览状态
  const [previewGroupIdx, setPreviewGroupIdx] = useState<number | null>(null);
  const [groupItems, setGroupItems] = useState<any[]>([]);
  const [groupItemsLoading, setGroupItemsLoading] = useState(false);

  const fetchSubs = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/pt/subscriptions');
      const d = await r.json();
      if (d.success) setSubs(d.data || []);
    } finally {
      setLoading(false);
    }
  };

  const fetchMeta = async () => {
    try {
      const [accR, presetR] = await Promise.all([
        fetch('/api/accounts').then(r => r.json()),
        fetch('/api/pt/sources/presets').then(r => r.json())
      ]);
      if (accR.success) setAccounts(accR.data || []);
      if (presetR.success) setPresets(presetR.data || []);
    } catch { /* 静默处理 */ }
  };

  const fetchSettings = async () => {
    const r = await fetch('/api/settings');
    const d = await r.json();
    if (d.success) {
      const pt = d.data?.pt || {};
      const cas = d.data?.cas || {};
      const svc = d.data?.proxy?.services || {};
      const strmOrg = pt.strmOrganize || {};
      setSettings({
        mikanBaseUrl: pt.mikanBaseUrl || 'https://mikanani.kas.pub',
        downloadRoot: pt.downloadRoot || '',
        pollCron: pt.pollCron || '*/15 * * * *',
        globalExcludePattern: pt.globalExcludePattern || '',
        cleanupEnabled: pt.cleanupEnabled !== false,
        cleanupCron: pt.cleanupCron || '0 */6 * * *',
        retryIntervalSec: Number(pt.retryIntervalSec || 300),
        autoDeleteSource: pt.autoDeleteSource !== false,
        deleteCloudSource: !!cas.deleteSourceAfterGenerate,
        enableStrm: pt.enableStrm !== false,
        strmOrganize: {
          enabled: strmOrg.enabled || false,
          mode: strmOrg.mode || 'regex',
          categoryFolder: strmOrg.categoryFolder || '动漫',
          fileTemplate: strmOrg.fileTemplate || '{title} S{season}E{episode}',
          seasonRegex: strmOrg.seasonRegex || '',
          episodeRegex: strmOrg.episodeRegex || '',
          defaultSeason: Number(strmOrg.defaultSeason || 1)
        },
        downloader: {
          type: pt.downloader?.type || 'qbittorrent',
          baseUrl: pt.downloader?.baseUrl || '',
          username: pt.downloader?.username || '',
          password: '',
          hasPassword: !!pt.downloader?.hasPassword,
          categoryPrefix: pt.downloader?.categoryPrefix || 'pt-sub-',
          tagPrefix: pt.downloader?.tagPrefix || 'pt-rel-',
          forceStart: pt.downloader?.forceStart !== false,
          insecureSkipTlsVerify: !!pt.downloader?.insecureSkipTlsVerify
        }
      });
      setProxyServices({
        ptMikan: !!svc.ptMikan,
        ptAnibt: !!svc.ptAnibt,
        ptAnimegarden: !!svc.ptAnimegarden,
        ptNyaa: !!svc.ptNyaa,
        ptDmhy: !!svc.ptDmhy
      });
    }
  };

  useEffect(() => {
    fetchSubs();
    fetchMeta();
    fetchAllReleases();
  }, []);

  // 当外部传入预填数据（如海报墙跳转过来），自动打开创建对话框并填充
  const prefillAppliedRef = useRef<PtPrefillData | null>(null);
  useEffect(() => {
    if (!prefill) {
      prefillAppliedRef.current = null;
      return;
    }
    if (accounts.length === 0) return; // 等账号加载完再打开
    if (prefillAppliedRef.current === prefill) return;

    setEditing(null);
    const lastDir = getLastUsedDir();
    setFormData({
      ...DEFAULT_FORM,
      name: prefill.name || '',
      rssUrl: prefill.rssUrl || '',
      sourcePreset: prefill.sourcePreset || 'generic',
      accountId: lastDir?.accountId || accounts[0]?.id || 0,
      targetFolderId: lastDir?.targetFolderId || '',
      targetFolder: lastDir?.targetFolder || '',
    });
    setShowAdvanced(false);
    setShowSourceDetails(false);
    setIsModalOpen(true);
    prefillAppliedRef.current = prefill;
    // 等弹窗状态提交后再清理父级 prefill，避免重复触发
    const timer = window.setTimeout(() => {
      onPrefillConsumed?.();
    }, 0);
    return () => window.clearTimeout(timer);
    // 仅在 prefill 引用变化或账号到位时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, accounts.length]);

  // PT 页面驻留期间持续刷新全局传输速度和任务状态。
  useEffect(() => {
    const interval = setInterval(() => { void fetchAllReleases(true); }, 5000);
    return () => clearInterval(interval);
  }, []);

  const openAdd = () => {
    setEditing(null);
    const lastDir = getLastUsedDir();
    setFormData({
      ...DEFAULT_FORM,
      accountId: lastDir?.accountId || accounts[0]?.id || 0,
      targetFolderId: lastDir?.targetFolderId || '',
      targetFolder: lastDir?.targetFolder || '',
    });
    setShowAdvanced(false);
    setShowSourceDetails(true);
    setFeedPreviewItems([]);
    setFeedPreviewError('');
    setAiRequirement('');
    setAiExplanation('');
    setIsModalOpen(true);
  };

  const openEdit = (sub: PtSubscription) => {
    setEditing(sub);
    const globalExclude = sub.globalExclude !== false && String(sub.globalExclude) !== '0';
    setFormData({
      name: sub.name,
      sourcePreset: sub.sourcePreset || 'generic',
      rssUrl: sub.rssUrl || '',
      includePattern: sub.includePattern || '',
      excludePattern: sub.excludePattern || '',
      qualityPattern: sub.qualityPattern || '',
      resolutionPattern: sub.resolutionPattern || '',
      effectPattern: sub.effectPattern || '',
      sizeMinMB: Number(sub.sizeMinMB) || 0,
      sizeMaxMB: Number(sub.sizeMaxMB) || 0,
      seedersMin: Number(sub.seedersMin) || 0,
      freeOnly: !!sub.freeOnly,
      episodeDedup: !!sub.episodeDedup,
      standbyRssJson: sub.standbyRssJson || '',
      coexist: !!sub.coexist,
      downloadNew: !!sub.downloadNew,
      delayedDownloadMinutes: Number(sub.delayedDownloadMinutes) || 0,
      notDownloadEpisodes: sub.notDownloadEpisodes || '',
      skipHalfEpisode: !!sub.skipHalfEpisode,
      customEpisode: !!sub.customEpisode,
      customEpisodeRegex: sub.customEpisodeRegex || '',
      customEpisodeGroupIndex: Number(sub.customEpisodeGroupIndex) || 1,
      episodeOffset: Number(sub.episodeOffset) || 0,
      omit: !!sub.omit,
      totalEpisodeNumber: Number(sub.totalEpisodeNumber) || 0,
      autoDisabled: !!sub.autoDisabled,
      globalExclude,
      accountId: sub.accountId,
      targetFolderId: sub.targetFolderId,
      targetFolder: sub.targetFolder,
      enabled: sub.enabled
    });
    setShowAdvanced(
      !!(sub.qualityPattern || sub.resolutionPattern || sub.effectPattern
        || sub.sizeMinMB || sub.sizeMaxMB || sub.seedersMin || sub.freeOnly || sub.episodeDedup
        || sub.standbyRssJson || sub.coexist || sub.downloadNew || sub.delayedDownloadMinutes
        || sub.notDownloadEpisodes || sub.skipHalfEpisode || sub.customEpisode || sub.episodeOffset
        || sub.omit || sub.totalEpisodeNumber || sub.autoDisabled || !globalExclude)
    );
    setShowSourceDetails(true);
    setIsModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return; // 防连点重入
    if (!formData.accountId) { toast.warning('请选择天翼云盘账号'); return; }
    setIsSaving(true);
    try {
      const url = editing ? `/api/pt/subscriptions/${editing.id}` : '/api/pt/subscriptions';
      const r = await fetch(url, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      const d = await r.json();
      if (d.success) {
        localStorage.setItem(PT_DIR_MEMORY_KEY, JSON.stringify({
          accountId: formData.accountId,
          targetFolderId: formData.targetFolderId,
          targetFolder: formData.targetFolder,
        }));
        setIsModalOpen(false);
        fetchSubs();
        // 新增订阅后显示自动刷新结果
        if (!editing && d.refreshResult) {
          const count = d.refreshResult.processed ?? 0;
          if (count > 0) {
            toast.success(`订阅已添加，本次新增 ${count} 条 release`);
          }
        }
      } else {
        toast.error('保存失败: ' + d.error);
      }
    } catch {
      toast.error('操作失败');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    const ok = await dialog.confirm({
      title: '删除订阅',
      message: '删除订阅会一并清理其 release 记录\n（不会立即删除 qb 中已经在下的任务）',
      confirmText: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const r = await fetch(`/api/pt/subscriptions/${id}`, { method: 'DELETE' });
      const d = await r.json();
      if (d.success) fetchSubs();
      else toast.error('删除失败: ' + d.error);
    } catch { toast.error('网络错误'); }
  };

  const handleDedupe = async () => {
    if (isDeduping) return;
    const ok = await dialog.confirm({
      title: '合并重复订阅',
      message: '将合并 (账号 + RSS URL) 完全相同的订阅，保留最早一条，其余删除并把 release 转移过去。',
      confirmText: '继续',
      tone: 'warning',
    });
    if (!ok) return;
    setIsDeduping(true);
    try {
      const r = await fetch('/api/pt/subscriptions/dedupe', { method: 'POST' });
      const d = await r.json();
      if (d.success) {
        const removed = d.data?.removed ?? 0;
        const merged = d.data?.mergedReleases ?? 0;
        if (removed === 0) {
          toast.info('未发现重复订阅');
        } else {
          toast.success(`已合并 ${removed} 条重复订阅，迁移 ${merged} 条 release`);
        }
        fetchSubs();
      } else {
        toast.error('清理失败: ' + d.error);
      }
    } catch {
      toast.error('网络错误');
    } finally {
      setIsDeduping(false);
    }
  };

  const handleToggle = async (sub: PtSubscription) => {
    try {
      const r = await fetch(`/api/pt/subscriptions/${sub.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !sub.enabled })
      });
      const d = await r.json();
      if (d.success) fetchSubs();
    } catch { toast.error('网络错误'); }
  };

  const handleRefresh = async (id: number) => {
    try {
      const r = await fetch(`/api/pt/subscriptions/${id}/refresh`, { method: 'POST' });
      const d = await r.json();
      if (d.success) {
        toast.success(`本次新增 ${d.data?.processed ?? 0} 条`);
        fetchSubs();
      } else {
        toast.error('刷新失败: ' + d.error);
      }
    } catch { toast.error('网络错误'); }
  };

  const fetchAllReleases = async (silent = false) => {
    if (!silent) setReleasesLoading(true);
    try {
      const r = await fetch('/api/pt/releases?limit=500');
      const d = await r.json();
      if (d.success) {
        const releases = d.data || [];
        setAllReleases(releases);
        setTransferStats({
          downloadSpeed: Number(d.transferStats?.downloadSpeed ?? releases.reduce((total: number, release: PtRelease) => total + Number(release.downloader?.downloadSpeed || 0), 0)),
          cloudUploadSpeed: Number(d.transferStats?.cloudUploadSpeed || 0)
        });
      }
      else if (!silent) toast.error('读取下载任务失败: ' + d.error);
    } catch {
      if (!silent) toast.error('读取下载任务失败');
    } finally {
      if (!silent) setReleasesLoading(false);
    }
  };

  const openReleases = (sub: PtSubscription) => {
    setReleaseSubscriptionFilter(String(sub.id));
    setReleaseStatusFilter('all');
    setManagementView('releases');
    void fetchAllReleases();
  };

  const handleRetryRelease = async (id: number) => {
    setReleaseActionId(id);
    try {
      const r = await fetch(`/api/pt/releases/${id}/retry`, { method: 'POST' });
      const d = await r.json();
      if (d.success) {
        toast.success('任务已重新投递');
        await fetchAllReleases(true);
      }
      else toast.error('重试失败: ' + d.error);
    } catch { toast.error('网络错误'); }
    finally { setReleaseActionId(null); }
  };

  const handleDeleteRelease = async (id: number) => {
    const ok = await dialog.confirm({
      title: '删除 Release',
      message: '删除 release 同时会从 qb 中删掉对应任务（含本地文件）',
      confirmText: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    setReleaseActionId(id);
    try {
      const r = await fetch(`/api/pt/releases/${id}`, { method: 'DELETE' });
      const d = await r.json();
      if (d.success) {
        toast.success('Release 已删除');
        await fetchAllReleases(true);
        await fetchSubs();
      }
      else toast.error('删除失败: ' + d.error);
    } catch { toast.error('网络错误'); }
    finally { setReleaseActionId(null); }
  };

  const handleRebuildStrm = async (id: number) => {
    try {
      const r = await fetch(`/api/pt/releases/${id}/rebuild-strm`, { method: 'POST' });
      const d = await r.json();
      if (d.success) toast.success(`STRM 已重建（${d.data?.files ?? 0} 个文件）`);
      else toast.error('重建失败: ' + d.error);
    } catch { toast.error('网络错误'); }
  };

  const handleRebuildAllStrm = async () => {
    const ok = await dialog.confirm({
      title: '重建全部 STRM',
      message: '将从已保存的清单为所有「已完成」的 release 重新生成 STRM（不重新下载/上传，只补回缺失、不动已存在）。若启用 AI 整理会重新消耗 AI 额度。确认继续？',
      confirmText: '重建',
    });
    if (!ok) return;
    setRebuildingAll(true);
    try {
      const r = await fetch('/api/pt/releases/rebuild-strm-all', { method: 'POST' });
      const d = await r.json();
      if (d.success) {
        const s = d.data || {};
        toast.success(`重建完成：成功 ${s.ok}，跳过 ${s.skipped}，失败 ${s.failed}（共 ${s.total}）`);
        fetchAllReleases(true);
      } else toast.error('重建失败: ' + d.error);
    } catch { toast.error('网络错误'); }
    finally { setRebuildingAll(false); }
  };

  const handleProcessReleases = async () => {
    setProcessingReleases(true);
    try {
      const r = await fetch('/api/pt/process', { method: 'POST' });
      const d = await r.json();
      if (d.success) {
        const processed = d.data?.processed ?? 0;
        toast.success(d.data?.skipped ? '后台正在处理任务' : `已检查 ${processed} 个任务`);
        await fetchAllReleases(true);
      } else {
        toast.error('处理失败: ' + d.error);
      }
    } catch {
      toast.error('处理失败');
    } finally {
      setProcessingReleases(false);
    }
  };

  const openSettings = async () => {
    await fetchSettings();
    setTestStatus(null);
    setIsSettingsOpen(true);
  };

  const handleSaveSettings = async () => {
    if (!settings) return;
    try {
      const cur = await fetch('/api/settings').then(r => r.json());
      if (!cur.success) { toast.error('读取设置失败'); return; }
      const merged = {
        ...cur.data,
        pt: settings,
        proxy: { ...cur.data.proxy, services: { ...cur.data.proxy?.services, ...proxyServices } }
      };
      const r = await fetch('/api/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(merged)
      });
      const d = await r.json();
      if (d.success) {
        toast.success('设置已保存');
        setIsSettingsOpen(false);
      } else {
        toast.error('保存失败: ' + d.error);
      }
    } catch {
      toast.error('保存失败');
    }
  };

  const handleTestDownloader = async () => {
    if (!settings) return;
    setTesting(true);
    try {
      // 先把当前编辑中的下载器配置临时保存（否则后端读到的是旧值）
      const cur = await fetch('/api/settings').then(r => r.json());
      if (cur.success) {
        await fetch('/api/settings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...cur.data, pt: settings, proxy: { ...cur.data.proxy, services: { ...cur.data.proxy?.services, ...proxyServices } } })
        });
      }
      const r = await fetch('/api/pt/downloader/test', { method: 'POST' });
      const d = await r.json();
      const result = d.data || { ok: false, message: d.error || '测试失败' };
      setTestStatus(result);
    } finally {
      setTesting(false);
    }
  };

  const handleTestMikan = async () => {
    if (!settings?.mikanBaseUrl.trim()) return;
    setTestingMikan(true);
    setMikanTestStatus(null);
    try {
      const r = await fetch('/api/pt/sources/mikan/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: settings.mikanBaseUrl })
      });
      const d = await r.json();
      setMikanTestStatus(d.success
        ? { ok: true, message: `连接成功，耗时 ${d.data?.elapsedMs ?? 0} ms` }
        : { ok: false, message: d.error || '连接失败' });
    } catch {
      setMikanTestStatus({ ok: false, message: '连接失败' });
    } finally {
      setTestingMikan(false);
    }
  };

  const handleSearch = async () => {
    if (!searchKeyword.trim()) return;
    setSearchLoading(true);
    setSearchResults([]);
    setSearchGroups([]);
    setSearchStep('search');
    try {
      const endpoint = aggregateSearch
        ? `/api/pt/sources/search-all?keyword=${encodeURIComponent(searchKeyword)}`
        : `/api/pt/sources/search?preset=${encodeURIComponent(formData.sourcePreset)}&keyword=${encodeURIComponent(searchKeyword)}`;
      const r = await fetch(endpoint);
      const text = await r.text();
      let d: any;
      try { d = JSON.parse(text); } catch { throw new Error(`服务器返回非 JSON: ${text.slice(0, 200)}`); }
      if (d.success) setSearchResults(d.data || []);
      else toast.error(d.error || '搜索失败');
    } catch (e: any) {
      toast.error(e.message || '搜索失败');
    } finally {
      setSearchLoading(false);
    }
  };

  const handleSelectAnime = async (anime: SearchResult) => {
    setSearchSelectedTitle(anime.title);

    // Nyaa/dmhy 等直接返回 RSS URL 的站点，字幕组已在搜索结果中
    if (anime.directRss) {
      if (anime.groups && anime.groups.length > 0) {
        setSearchGroups(anime.groups);
        setSearchStep('groups');
      } else {
        setFormData({
          ...formData,
          rssUrl: anime.url,
          name: formData.name || anime.title
        });
        setIsSearchOpen(false);
        setSearchKeyword('');
        setSearchResults([]);
        setSearchStep('search');
      }
      return;
    }

    if (anime.groups && anime.groups.length > 0) {
      setSearchGroups(anime.groups);
      setSearchStep('groups');
      return;
    }

    setSearchLoading(true);
    setSearchGroups([]);
    setSearchStep('groups');
    try {
      const params = anime.source === 'mikan'
        ? `bangumiUrl=${encodeURIComponent(anime.url)}`
        : `bgmId=${encodeURIComponent(anime.id)}`;
      const r = await fetch(`/api/pt/sources/groups?preset=${encodeURIComponent(anime.source)}&${params}`);
      const text = await r.text();
      let d: any;
      try { d = JSON.parse(text); } catch { throw new Error(`服务器返回非 JSON: ${text.slice(0, 200)}`); }
      if (d.success) setSearchGroups(d.data || []);
      else toast.error(d.error || '获取字幕组失败');
    } catch (e: any) {
      toast.error(e.message || '获取字幕组失败');
    } finally {
      setSearchLoading(false);
    }
  };

  const handleSelectGroup = (group: GroupResult) => {
    setFormData({
      ...formData,
      rssUrl: group.rssUrl,
      name: `${searchSelectedTitle} - ${group.name}`
    });
    setIsSearchOpen(false);
    setSearchKeyword('');
    setSearchResults([]);
    setSearchGroups([]);
    setSearchStep('search');
  };

  const loadFeedPreview = async (rssUrl = formData.rssUrl, sourcePreset = formData.sourcePreset) => {
    if (!rssUrl.trim()) {
      toast.warning('请先填写 RSS URL');
      return;
    }
    setFeedPreviewLoading(true);
    setFeedPreviewError('');
    try {
      const r = await fetch(`/api/pt/sources/group-items?rssUrl=${encodeURIComponent(rssUrl)}&preset=${encodeURIComponent(sourcePreset)}`);
      const text = await r.text();
      let d: any;
      try { d = JSON.parse(text); } catch { throw new Error(`服务器返回非 JSON: ${text.slice(0, 120)}`); }
      if (!d.success) throw new Error(d.error || 'RSS 拉取失败');
      setFeedPreviewItems(Array.isArray(d.data) ? d.data : []);
    } catch (error: any) {
      setFeedPreviewItems([]);
      setFeedPreviewError(error.message || 'RSS 拉取失败');
    } finally {
      setFeedPreviewLoading(false);
    }
  };

  const generateFilterPatterns = async () => {
    if (!feedPreviewItems.length) {
      toast.warning('请先加载文件列表，再让 AI 根据真实标题生成正则');
      return;
    }
    setAiGenerating(true);
    setAiExplanation('');
    try {
      const r = await fetch('/api/pt/sources/generate-filter-patterns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          requirement: aiRequirement,
          titles: feedPreviewItems.map(item => item.rawTitle || item.title)
        })
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || 'AI 生成失败');
      setFormData(current => ({
        ...current,
        includePattern: d.data?.includePattern || '',
        excludePattern: d.data?.excludePattern || ''
      }));
      setAiExplanation(d.data?.explanation || '正则已生成，可直接查看下方匹配预览。');
    } catch (error: any) {
      toast.error(error.message || 'AI 生成失败');
    } finally {
      setAiGenerating(false);
    }
  };

  const previewMatch = (item: FeedPreviewItem) => {
    const title = String(item.rawTitle || item.title || '');
    try {
      const included = !formData.includePattern.trim() || new RegExp(formData.includePattern, 'i').test(title);
      const excluded = !!formData.excludePattern.trim() && new RegExp(formData.excludePattern, 'i').test(title);
      return included && !excluded;
    } catch {
      return false;
    }
  };

  const invalidPattern = (() => {
    try {
      if (formData.includePattern.trim()) new RegExp(formData.includePattern, 'i');
      if (formData.excludePattern.trim()) new RegExp(formData.excludePattern, 'i');
      return '';
    } catch (error: any) {
      return error.message || '正则格式无效';
    }
  })();

  const handlePreviewGroup = async (idx: number, group: GroupResult) => {
    if (previewGroupIdx === idx) { setPreviewGroupIdx(null); return; }
    setPreviewGroupIdx(idx);
    setGroupItemsLoading(true);
    setGroupItems([]);
    try {
      const r = await fetch(`/api/pt/sources/group-items?rssUrl=${encodeURIComponent(group.rssUrl)}&preset=${encodeURIComponent(group.source)}`);
      const d = await r.json();
      if (d.success) setGroupItems(d.data || []);
    } catch { setGroupItems([]); }
    finally { setGroupItemsLoading(false); }
  };

  // 顶部「搜索创建」选完后：直接打开本地创建对话框并预填
  const handleExternalSearchSubmit = (data: PtSubscriptionPrefill) => {
    setIsExternalSearchOpen(false);
    setEditing(null);
    const lastDir = getLastUsedDir();
    setFormData({
      ...DEFAULT_FORM,
      name: data.name,
      rssUrl: data.rssUrl,
      sourcePreset: data.sourcePreset,
      includePattern: data.includePattern || '',
      accountId: lastDir?.accountId || accounts[0]?.id || 0,
      targetFolderId: lastDir?.targetFolderId || '',
      targetFolder: lastDir?.targetFolder || '',
    });
    setShowAdvanced(false);
    setShowSourceDetails(false);
    setIsModalOpen(true);
    void loadFeedPreview(data.rssUrl, data.sourcePreset);
  };

  const filteredSubs = subs.filter(sub => {
    const query = subscriptionQuery.trim().toLowerCase();
    if (!query) return true;
    return [sub.name, sub.sourcePreset, sub.targetFolder, sub.lastMessage]
      .some(value => String(value || '').toLowerCase().includes(query));
  });
  const releaseCounts = {
    all: allReleases.length,
    active: allReleases.filter(isActiveRelease).length,
    failed: allReleases.filter(rel => ['failed', 'upload_failed'].includes(rel.status)).length,
    completed: allReleases.filter(rel => rel.status === 'completed').length
  };
  const filteredReleases = allReleases.filter(rel => {
    if (releaseSubscriptionFilter !== 'all' && String(rel.subscriptionId) !== releaseSubscriptionFilter) return false;
    if (releaseStatusFilter === 'active' && !isActiveRelease(rel)) return false;
    if (releaseStatusFilter === 'failed' && !['failed', 'upload_failed'].includes(rel.status)) return false;
    if (releaseStatusFilter === 'completed' && rel.status !== 'completed') return false;
    const query = releaseQuery.trim().toLowerCase();
    if (!query) return true;
    const subscriptionName = subs.find(sub => sub.id === rel.subscriptionId)?.name || '';
    return [rel.title, rel.subgroup, rel.lastError, subscriptionName]
      .some(value => String(value || '').toLowerCase().includes(query));
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <div className="ui-card-muted inline-flex self-start rounded-2xl p-1" role="tablist" aria-label="PT 管理视图">
            <button
              type="button"
              role="tab"
              aria-selected={managementView === 'subscriptions'}
              onClick={() => setManagementView('subscriptions')}
              className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all ${managementView === 'subscriptions' ? 'bg-[var(--bg-main)] text-[#0b57d0] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
            >
              <Magnet size={17} /> 订阅 <span className="tabular-nums">{subs.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={managementView === 'releases'}
              onClick={() => { setManagementView('releases'); void fetchAllReleases(); }}
              className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all ${managementView === 'releases' ? 'bg-[var(--bg-main)] text-[#0b57d0] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
            >
              <ListChecks size={17} /> 下载任务 <span className="tabular-nums">{releaseCounts.active}</span>
            </button>
          </div>
          <div className="ui-card-muted grid grid-cols-2 self-start overflow-hidden rounded-2xl" aria-label="PT 总传输速度">
            <div className="flex min-w-[132px] items-center gap-2.5 px-3.5 py-2">
              <Download size={17} className="shrink-0 text-[#0b57d0]" />
              <div className="min-w-0">
                <div className="text-[10px] text-[var(--text-secondary)]">PT 下载</div>
                <div className="truncate text-sm font-semibold tabular-nums text-[var(--text-primary)]" title={formatSpeed(transferStats.downloadSpeed)}>{formatSpeed(transferStats.downloadSpeed)}</div>
              </div>
            </div>
            <div className="flex min-w-[132px] items-center gap-2.5 border-l border-[var(--border-color)] px-3.5 py-2">
              <Upload size={17} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
              <div className="min-w-0">
                <div className="text-[10px] text-[var(--text-secondary)]">天翼上传</div>
                <div className="truncate text-sm font-semibold tabular-nums text-[var(--text-primary)]" title={formatSpeed(transferStats.cloudUploadSpeed)}>{formatSpeed(transferStats.cloudUploadSpeed)}</div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {managementView === 'subscriptions' ? <>
            <button type="button" onClick={() => setIsExternalSearchOpen(true)} className="flex items-center gap-2 rounded-full bg-[#0b57d0] px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[#0b57d0]/90">
              <Search size={17} /> 搜索并创建
            </button>
            <button type="button" onClick={openAdd} className="ui-card flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-slate-50 dark:hover:bg-slate-800">
              <Plus size={16} /> 手动添加
            </button>
            <button type="button" onClick={handleDedupe} disabled={isDeduping} className="ui-card flex items-center gap-2 rounded-full px-4 py-2.5 text-sm text-[var(--text-secondary)] transition-colors hover:bg-slate-50 disabled:opacity-50 dark:hover:bg-slate-800" title="清理重复订阅">
              <Wand2 size={16} className={isDeduping ? 'animate-pulse' : ''} /> {isDeduping ? '清理中' : '清理重复'}
            </button>
          </> : <>
            <button type="button" onClick={handleProcessReleases} disabled={processingReleases} className="flex items-center gap-2 rounded-full bg-[#0b57d0] px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[#0b57d0]/90 disabled:opacity-50">
              <Play size={17} className={processingReleases ? 'animate-pulse' : ''} /> {processingReleases ? '处理中' : '立即处理'}
            </button>
            <button type="button" onClick={handleRebuildAllStrm} disabled={rebuildingAll} className="ui-card flex items-center gap-2 rounded-full px-4 py-2.5 text-sm text-[var(--text-secondary)] transition-colors hover:bg-slate-50 disabled:opacity-50 dark:hover:bg-slate-800">
              <RotateCcw size={16} className={rebuildingAll ? 'animate-spin' : ''} /> 重建全部 STRM
            </button>
          </>}
          <button type="button" onClick={openSettings} className="ui-card flex h-10 w-10 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:text-[#0b57d0]" title="PT 设置" aria-label="PT 设置"><SettingsIcon size={18} /></button>
          <button type="button" onClick={() => onNavigateHistory({ module: 'pt' })} className="ui-card flex h-10 w-10 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:text-[#0b57d0]" title="查看 PT 历史" aria-label="查看 PT 历史"><History size={18} /></button>
        </div>
      </div>

      {managementView === 'subscriptions' ? <div className="ui-card overflow-hidden shadow-sm">
        <div className="flex flex-col gap-3 border-b border-[var(--border-color)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-md">
            <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={subscriptionQuery} onChange={event => setSubscriptionQuery(event.target.value)} placeholder="搜索名称、来源或目录" className="ui-input w-full rounded-full py-2.5 pl-11 pr-4 text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20" />
          </div>
          <button type="button" onClick={fetchSubs} disabled={loading} className="ui-input flex h-10 w-10 shrink-0 items-center justify-center self-end rounded-full text-[var(--text-secondary)] transition-colors hover:text-[#0b57d0] disabled:opacity-50 sm:self-auto" title="刷新订阅" aria-label="刷新订阅">
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-100 bg-slate-50/50 text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400">
              <tr>
                <th className="px-6 py-4 font-medium">名称</th>
                <th className="px-6 py-4 font-medium">来源</th>
                <th className="px-6 py-4 font-medium">目标</th>
                <th className="px-6 py-4 font-medium">状态</th>
                <th className="px-6 py-4 font-medium">最后检查</th>
                <th className="px-6 py-4 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
              {loading ? (
                <tr><td colSpan={6} className="px-6 py-10 text-center text-[var(--text-secondary)]">加载中...</td></tr>
              ) : filteredSubs.length === 0 ? (
                <tr><td colSpan={6} className="px-6 py-10 text-center text-[var(--text-secondary)]">暂无 PT 订阅</td></tr>
              ) : filteredSubs.map(sub => {
                const missingEpisodes = parseMissingEpisodes(sub);
                return (
                <tr key={sub.id} className="transition-colors hover:bg-slate-50/60 dark:hover:bg-slate-800/50">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${sub.enabled ? 'bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300' : 'bg-slate-100 text-slate-400 dark:bg-slate-800'}`}><Magnet size={20} /></div>
                      <div className="min-w-0">
                        <div className="max-w-[180px] truncate font-medium ui-title" title={sub.name}>{sub.name}</div>
                        {!sub.enabled && <span className="text-[10px] font-bold text-red-500">已禁用</span>}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-xs">
                    <div className="font-medium text-[var(--text-primary)]">{sub.sourcePreset}</div>
                    <div className="max-w-[220px] truncate font-mono text-[var(--text-secondary)]" title={sub.rssUrl}>{sub.rssUrl || '-'}</div>
                  </td>
                  <td className="px-6 py-4 text-xs text-[var(--text-secondary)]">
                    <div className="max-w-[220px] truncate text-[var(--text-primary)]" title={sub.targetFolder}>{sub.targetFolder || sub.targetFolderId}</div>
                    <div>共 {sub.releaseCount || 0} 条{sub.totalEpisodeNumber > 0 && ` · 进度 ${sub.currentEpisodeNumber || 0}/${sub.totalEpisodeNumber}`}</div>
                    {missingEpisodes.length > 0 && <div className="mt-1 max-w-[220px] truncate text-[10px] text-amber-600 dark:text-amber-400" title={missingEpisodes.join(', ')}>缺集 {missingEpisodes.slice(0, 6).join(', ')}{missingEpisodes.length > 6 ? '…' : ''}</div>}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-1.5 text-xs text-[var(--text-primary)]" title={sub.lastMessage || ''}>
                      {sub.lastStatus === 'ok' && <CheckCircle2 size={14} className="text-emerald-600" />}
                      {sub.lastStatus === 'error' && <AlertCircle size={14} className="text-red-600" />}
                      <span>{sub.lastStatus || 'unknown'}</span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-xs text-[var(--text-secondary)]">{formatDateTime(sub.lastCheckTime)}</td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => openReleases(sub)} className="rounded-full p-2 text-[#0b57d0] transition-colors hover:bg-[#0b57d0]/10" title="查看下载任务" aria-label="查看下载任务"><Folder size={18} /></button>
                      <button onClick={() => onNavigateHistory({ subjectType: 'pt_subscription', subjectId: sub.id })} className="rounded-full p-2 text-[var(--text-secondary)] transition-colors hover:bg-slate-100 dark:hover:bg-slate-800" title="查看历史" aria-label={`查看${sub.name}历史`}><History size={18} /></button>
                      <button onClick={() => handleRefresh(sub.id)} className="rounded-full p-2 text-[var(--text-secondary)] transition-colors hover:bg-slate-100 dark:hover:bg-slate-800" title="立即拉取" aria-label="立即拉取"><RefreshCw size={18} /></button>
                      <button onClick={() => handleToggle(sub)} className={`rounded-full p-2 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800 ${sub.enabled ? 'text-amber-600' : 'text-emerald-600'}`} title={sub.enabled ? '停用' : '启用'} aria-label={sub.enabled ? '停用' : '启用'}><Power size={18} /></button>
                      <button onClick={() => openEdit(sub)} className="rounded-full p-2 text-[var(--text-secondary)] transition-colors hover:bg-slate-100 dark:hover:bg-slate-800" title="编辑" aria-label="编辑"><Edit2 size={18} /></button>
                      <button onClick={() => setMetadataTarget({ type: 'subscription', id: sub.id, title: sub.name })} className="rounded-full p-2 text-[var(--text-secondary)] transition-colors hover:bg-slate-100 dark:hover:bg-slate-800" title="元数据模板" aria-label="元数据模板"><Tags size={18} /></button>
                      <button onClick={() => handleDelete(sub.id)} className="rounded-full p-2 text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-950/40" title="删除" aria-label="删除"><Trash2 size={18} /></button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div> : (
        <div className="space-y-4">
          <div className="ui-card p-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Filter size={16} className="mx-1 text-[var(--text-secondary)]" />
              {([
                ['all', '全部', releaseCounts.all],
                ['active', '进行中', releaseCounts.active],
                ['failed', '需处理', releaseCounts.failed],
                ['completed', '已完成', releaseCounts.completed]
              ] as const).map(([value, label, count]) => (
                <button key={value} type="button" onClick={() => setReleaseStatusFilter(value)} className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${releaseStatusFilter === value ? 'border-[#0b57d0] bg-[#d3e3fd] text-[#0b57d0] dark:bg-[#0b57d0]/20 dark:text-blue-300' : 'border-transparent text-[var(--text-secondary)] hover:border-[var(--border-color)] hover:text-[var(--text-primary)]'}`}>
                  {label} <span className="ml-1 tabular-nums">{count}</span>
                </button>
              ))}
            </div>
            <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={releaseQuery} onChange={event => setReleaseQuery(event.target.value)} placeholder="搜索标题、字幕组、订阅或错误" className="ui-input w-full rounded-full py-2.5 pl-11 pr-4 text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20" />
              </div>
              <select value={releaseSubscriptionFilter} onChange={event => setReleaseSubscriptionFilter(event.target.value)} className="ui-input min-w-0 rounded-full px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 lg:min-w-[240px]">
                <option value="all">全部订阅</option>
                {subs.map(sub => <option key={sub.id} value={String(sub.id)}>{sub.name}</option>)}
              </select>
              <button type="button" onClick={() => fetchAllReleases()} disabled={releasesLoading} className="ui-input flex h-10 w-10 shrink-0 items-center justify-center self-end rounded-full text-[var(--text-secondary)] transition-colors hover:text-[#0b57d0] disabled:opacity-50 lg:self-auto" title="刷新下载状态" aria-label="刷新下载状态">
                <RefreshCw size={18} className={releasesLoading ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>

          {releasesLoading && allReleases.length === 0 ? (
            <div className="ui-card py-16 text-center text-sm text-[var(--text-secondary)]">加载下载状态...</div>
          ) : filteredReleases.length === 0 ? (
            <div className="ui-card py-16 text-center text-sm text-[var(--text-secondary)]">没有符合条件的下载任务</div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {filteredReleases.map(rel => {
                const subscription = subs.find(sub => sub.id === rel.subscriptionId);
                const qbt = rel.downloader;
                const progress = Math.max(0, Math.min(100, Number(qbt?.progress ?? rel.progress ?? 0)));
                const speed = Number(qbt?.downloadSpeed || 0);
                const isWorking = ['downloading', 'forcedDL', 'metaDL', 'checkingDL'].includes(qbt?.state || '');
                return (
                  <article key={rel.id} className="ui-card group relative overflow-hidden p-5 shadow-sm transition-shadow hover:shadow-md">
                    <div className={`absolute inset-y-4 left-0 w-1.5 rounded-r-full ${statusAccent(rel.status)}`} />
                    <div className="flex flex-col gap-5 pl-3 xl:flex-row xl:items-center xl:justify-between">
                      <div className="flex min-w-0 flex-1 items-start gap-4">
                        <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${statusColor(rel.status)}`}>
                          {rel.status === 'completed' ? <CheckCircle2 size={22} /> : ['failed', 'upload_failed'].includes(rel.status) ? <AlertCircle size={22} /> : <Download size={22} />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="max-w-full truncate text-base font-semibold ui-title" title={rel.title}>{rel.title}</h3>
                            <span className={`inline-flex rounded-md px-2.5 py-1 text-[11px] font-bold ${statusColor(rel.status)}`}>{statusLabel(rel.status)}</span>
                            {formatEpisodeBadge(rel) && <span className="rounded-md bg-[#d3e3fd] px-2 py-1 font-mono text-[10px] font-bold text-[#0b57d0] dark:bg-[#0b57d0]/20 dark:text-blue-300">{formatEpisodeBadge(rel)}</span>}
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-secondary)]">
                            <span className="max-w-[320px] truncate" title={subscription?.name || ''}>{subscription?.name || `订阅 #${rel.subscriptionId}`}</span>
                            {formatSize(rel.size) && <span>{formatSize(rel.size)}</span>}
                            <span>{formatDateTime(rel.updatedAt)}</span>
                          </div>
                          {rel.lastError && <div className="mt-3 line-clamp-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300" title={rel.lastError}>{rel.lastError}</div>}
                        </div>
                      </div>

                      <div className="shrink-0 xl:w-[430px]">
                        <div className="flex items-center justify-between gap-4">
                          <div className={`flex min-w-0 items-center gap-1.5 text-xs font-medium ${downloaderStateColor(qbt?.state)}`}>
                            {isWorking ? <Gauge size={15} /> : <Clock3 size={15} />}
                            <span className="truncate">{downloaderStateLabel(qbt?.state)}</span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button onClick={() => setMetadataTarget({ type: 'release', id: rel.id, title: rel.title })} className="rounded-full p-2 text-[var(--text-secondary)] transition-colors hover:bg-slate-100 hover:text-[#0b57d0] dark:hover:bg-slate-800" title="编辑元数据" aria-label="编辑元数据"><Tags size={17} /></button>
                            {rel.status !== 'completed' && <button onClick={() => handleRetryRelease(rel.id)} disabled={releaseActionId === rel.id} className="rounded-full p-2 text-[#0b57d0] transition-colors hover:bg-blue-50 disabled:opacity-50 dark:hover:bg-blue-950/40" title="重试或唤醒" aria-label="重试或唤醒"><RefreshCw size={17} className={releaseActionId === rel.id ? 'animate-spin' : ''} /></button>}
                            {rel.status === 'completed' && <button onClick={() => handleRebuildStrm(rel.id)} className="rounded-full p-2 text-[#0b57d0] transition-colors hover:bg-blue-50 dark:hover:bg-blue-950/40" title="重建 STRM" aria-label="重建 STRM"><RotateCcw size={17} /></button>}
                            <button onClick={() => handleDeleteRelease(rel.id)} disabled={releaseActionId === rel.id} className="rounded-full p-2 text-red-500 transition-colors hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-950/40" title="删除任务与本地文件" aria-label="删除任务与本地文件"><Trash2 size={17} /></button>
                          </div>
                        </div>
                        <div className="mt-3">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-semibold tabular-nums text-[var(--text-primary)]">{progress}%</span>
                            <span className="tabular-nums text-[var(--text-secondary)]">{speed > 0 ? `${formatSize(speed)}/s` : '-'}</span>
                          </div>
                          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className={`h-full rounded-full transition-all ${statusAccent(rel.status)}`} style={{ width: `${progress}%` }} /></div>
                        </div>
                        <div className="mt-3 grid grid-cols-3 divide-x divide-[var(--border-color)] text-center text-xs">
                          <div><div className="font-semibold tabular-nums text-[var(--text-primary)]">{qbt?.seeds ?? rel.seeders ?? 0}</div><div className="mt-0.5 text-[var(--text-secondary)]">做种</div></div>
                          <div><div className="font-semibold tabular-nums text-[var(--text-primary)]">{qbt?.peers ?? rel.peers ?? 0}</div><div className="mt-0.5 text-[var(--text-secondary)]">连接</div></div>
                          <div><div className="font-semibold tabular-nums text-[var(--text-primary)]">{qbt?.availability != null ? qbt.availability.toFixed(1) : '-'}</div><div className="mt-0.5 text-[var(--text-secondary)]">可用性</div></div>
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 添加/编辑订阅 */}
      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={editing ? '编辑 PT 订阅' : '添加 PT 订阅'} footer={null} maxWidthClass="max-w-4xl" contentClassName="px-5 md:px-8 pb-6 max-h-[72vh] overflow-y-auto">
        <form onSubmit={handleSave} className="space-y-5">
          {!editing && !showSourceDetails && (
            <div className="rounded-2xl border border-[#0b57d0]/20 bg-[#eef4ff] px-4 py-3">
              <div className="text-sm font-medium text-[#0b3a86]">资源已选择</div>
              <div className="mt-1 text-xs text-slate-600 truncate" title={formData.rssUrl}>
                {presets.find(p => p.key === formData.sourcePreset)?.label || formData.sourcePreset} · RSS 已自动配置
              </div>
            </div>
          )}
          <div className="space-y-2">
            <label className="text-sm font-medium ui-title">订阅名称</label>
            <input type="text" required value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })}
              className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20" />
          </div>

          {!editing && (
            <div className="rounded-2xl border border-slate-200 p-4 space-y-4">
              <div className="text-sm font-medium ui-title">保存位置</div>
              <div className="space-y-2">
                <label className="text-xs ui-muted">天翼云盘账号</label>
                <select value={formData.accountId} onChange={e => setFormData({ ...formData, accountId: Number(e.target.value), targetFolderId: '', targetFolder: '' })}
                  className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none" required>
                  <option value={0}>请选择</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.alias?.trim() || a.username}</option>)}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-xs ui-muted">目标目录</label>
                <div className="flex gap-2">
                  <input type="text" readOnly value={formData.targetFolder || formData.targetFolderId} placeholder="选择资源要保存到的目录"
                    className="flex-1 min-w-0 px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none" />
                  <button type="button" onClick={() => formData.accountId ? setFolderSelectorOpen(true) : toast.warning('请先选择账号')}
                    className="px-5 py-3 border border-slate-300 rounded-2xl text-sm font-medium hover:bg-slate-50 shrink-0">选择目录</button>
                </div>
              </div>
            </div>
          )}

          {!editing && (
            <button type="button" onClick={() => setShowSourceDetails(v => !v)}
              className="w-full flex items-center justify-between px-4 py-3 rounded-2xl bg-slate-50 hover:bg-slate-100 text-sm font-medium ui-title">
              <span>RSS 来源与过滤规则</span>
              {showSourceDetails ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
          )}

          {(editing || showSourceDetails) && <>
          <div className="space-y-2">
            <label className="text-sm font-medium ui-title">RSS 来源</label>
            <select value={formData.sourcePreset} onChange={e => {
              const preset = presets.find(p => p.key === e.target.value);
              setFormData({
                ...formData,
                sourcePreset: e.target.value,
                rssUrl: formData.rssUrl || preset?.defaultRssUrl || ''
              });
            }} className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none">
              {presets.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
            <p className="text-xs ui-muted">{presets.find(p => p.key === formData.sourcePreset)?.description || ''}</p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium ui-title">RSS URL</label>
            <div className="flex gap-2">
              <input type="text" value={formData.rssUrl} onChange={e => setFormData({ ...formData, rssUrl: e.target.value })}
                placeholder={presets.find(p => p.key === formData.sourcePreset)?.defaultRssUrl || ''}
                className="flex-1 px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 font-mono text-xs" />
              {['mikan', 'anibt', 'animegarden', 'nyaa', 'dmhy'].includes(formData.sourcePreset) && (
                <button type="button" onClick={() => { setIsSearchOpen(true); setSearchStep('search'); setSearchResults([]); setSearchGroups([]); setSearchKeyword(''); }}
                  className="px-4 py-3 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-2xl text-sm text-slate-600 transition-colors flex items-center gap-1.5 shrink-0">
                  <Search size={16} /> 搜索
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium ui-title">包含正则（可选）</label>
              <input type="text" value={formData.includePattern} onChange={e => setFormData({ ...formData, includePattern: e.target.value })}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none font-mono text-xs"
                placeholder="例如: 1080p|2160p" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium ui-title">排除正则（可选）</label>
              <input type="text" value={formData.excludePattern} onChange={e => setFormData({ ...formData, excludePattern: e.target.value })}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none font-mono text-xs"
                placeholder="例如: cam|ts.x264" />
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 overflow-hidden">
            <div className="p-4 bg-slate-50 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium ui-title">文件列表与正则预览</div>
                  <div className="text-xs ui-muted mt-0.5">先读取当前 RSS，再填写要求让 AI 生成包含/排除正则。</div>
                </div>
                <button type="button" onClick={() => void loadFeedPreview()} disabled={feedPreviewLoading}
                  className="px-4 py-2 rounded-full text-xs font-medium border border-[#0b57d0]/30 text-[#0b57d0] hover:bg-[#0b57d0]/10 disabled:opacity-50 inline-flex items-center gap-1.5">
                  {feedPreviewLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  {feedPreviewLoading ? '读取中' : '加载文件列表'}
                </button>
              </div>
              <div className="flex flex-col md:flex-row gap-2">
                <input type="text" value={aiRequirement} onChange={e => setAiRequirement(e.target.value)}
                  placeholder="告诉 AI 你想要什么，例如：只要简体 1080p，排除合集和繁体"
                  className="flex-1 px-4 py-2.5 bg-white border border-slate-300 rounded-2xl text-xs outline-none focus:ring-2 focus:ring-[#0b57d0]/20" />
                <button type="button" onClick={generateFilterPatterns} disabled={aiGenerating || !feedPreviewItems.length}
                  className="px-4 py-2.5 rounded-full text-xs font-medium bg-[#0b57d0] text-white hover:bg-[#0b57d0]/90 disabled:opacity-50 inline-flex items-center justify-center gap-1.5">
                  {aiGenerating ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                  {aiGenerating ? 'AI 生成中' : 'AI 生成正则'}
                </button>
              </div>
              {aiExplanation && <div className="text-xs text-[#0b3a86] bg-[#eef4ff] rounded-xl px-3 py-2">{aiExplanation}</div>}
              {invalidPattern && <div className="text-xs text-red-600">正则无效：{invalidPattern}</div>}
              {feedPreviewError && <div className="text-xs text-red-600">{feedPreviewError}</div>}
            </div>
            {feedPreviewItems.length > 0 && (
              <div className="max-h-64 overflow-y-auto divide-y divide-slate-100 bg-white">
                <div className="sticky top-0 z-10 px-4 py-2 bg-white/95 backdrop-blur text-xs ui-muted border-b border-slate-100">
                  当前规则匹配 {invalidPattern ? 0 : feedPreviewItems.filter(previewMatch).length} / {feedPreviewItems.length} 条
                </div>
                {feedPreviewItems.map((item, index) => {
                  const matched = !invalidPattern && previewMatch(item);
                  const meta = [item.subgroup, item.resolution, item.quality, formatSize(item.size)].filter(Boolean).join(' · ');
                  return (
                    <div key={`${item.title}-${index}`} className={`px-4 py-2.5 flex items-start gap-3 ${matched ? '' : 'opacity-45'}`}>
                      <span className={`mt-0.5 shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium ${matched ? 'bg-[#c4eed0] text-[#0d4f1f]' : 'bg-slate-100 text-slate-500'}`}>
                        {matched ? '保留' : '过滤'}
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs font-mono text-slate-700 break-all">{item.title}</div>
                        {meta && <div className="text-[10px] text-slate-400 mt-0.5">{meta}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-slate-200 overflow-hidden">
            <button type="button" onClick={() => setShowAdvanced(v => !v)}
              className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors text-sm font-medium ui-title">
              <span className="flex items-center gap-2"><Filter size={14} /> 高级规则（过滤 / 去重 / 备用 RSS / 集数）</span>
              {showAdvanced ? <ChevronDown size={16} className="text-slate-500" /> : <ChevronRight size={16} className="text-slate-500" />}
            </button>
            {showAdvanced && (
              <div className="p-4 space-y-4 bg-white">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs ui-muted">分辨率正则</label>
                    <input type="text" value={formData.resolutionPattern}
                      onChange={e => setFormData({ ...formData, resolutionPattern: e.target.value })}
                      placeholder="例如: 1080p|2160p"
                      className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-xs outline-none font-mono" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs ui-muted">质量正则</label>
                    <input type="text" value={formData.qualityPattern}
                      onChange={e => setFormData({ ...formData, qualityPattern: e.target.value })}
                      placeholder="例如: BluRay|WEB-DL"
                      className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-xs outline-none font-mono" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs ui-muted">特效正则</label>
                    <input type="text" value={formData.effectPattern}
                      onChange={e => setFormData({ ...formData, effectPattern: e.target.value })}
                      placeholder="例如: HDR|DV|Dolby"
                      className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-xs outline-none font-mono" />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs ui-muted">最小体积 (MB)</label>
                    <input type="number" min={0} value={formData.sizeMinMB}
                      onChange={e => setFormData({ ...formData, sizeMinMB: Number(e.target.value) || 0 })}
                      placeholder="0 = 不限"
                      className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-xs outline-none" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs ui-muted">最大体积 (MB)</label>
                    <input type="number" min={0} value={formData.sizeMaxMB}
                      onChange={e => setFormData({ ...formData, sizeMaxMB: Number(e.target.value) || 0 })}
                      placeholder="0 = 不限"
                      className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-xs outline-none" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs ui-muted">最少做种数</label>
                    <input type="number" min={0} value={formData.seedersMin}
                      onChange={e => setFormData({ ...formData, seedersMin: Number(e.target.value) || 0 })}
                      placeholder="0 = 不限"
                      className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-xs outline-none" />
                  </div>
                </div>

                <Checkbox
                  size="sm"
                  checked={formData.freeOnly}
                  onChange={(v) => setFormData({ ...formData, freeOnly: v })}
                  label="仅免费 (Free) 资源"
                  labelClassName="text-sm text-slate-700"
                />
                <Checkbox
                  size="sm"
                  checked={formData.episodeDedup}
                  onChange={(v) => setFormData({ ...formData, episodeDedup: v })}
                  label="按季集去重"
                  labelClassName="text-sm text-slate-700"
                />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Checkbox
                    size="sm"
                    checked={formData.coexist}
                    onChange={(v) => setFormData({ ...formData, coexist: v, episodeDedup: v ? true : formData.episodeDedup })}
                    label="多字幕组共存"
                    labelClassName="text-sm text-slate-700"
                  />
                  <Checkbox
                    size="sm"
                    checked={formData.downloadNew}
                    onChange={(v) => setFormData({ ...formData, downloadNew: v })}
                    label="只下载最新发布批次"
                    labelClassName="text-sm text-slate-700"
                  />
                  <Checkbox
                    size="sm"
                    checked={formData.skipHalfEpisode}
                    onChange={(v) => setFormData({ ...formData, skipHalfEpisode: v })}
                    label="跳过 .5 番外集"
                    labelClassName="text-sm text-slate-700"
                  />
                  <Checkbox
                    size="sm"
                    checked={formData.globalExclude}
                    onChange={(v) => setFormData({ ...formData, globalExclude: v })}
                    label="启用全局排除规则"
                    labelClassName="text-sm text-slate-700"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs ui-muted">备用 RSS</label>
                  <textarea
                    rows={3}
                    value={formData.standbyRssJson}
                    onChange={e => setFormData({ ...formData, standbyRssJson: e.target.value })}
                    placeholder="一行一个：字幕组名|RSS URL|集数偏移&#10;也支持 JSON 数组 [{&quot;label&quot;:&quot;A组&quot;,&quot;url&quot;:&quot;https://...&quot;,&quot;offset&quot;:0}]"
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-xs outline-none font-mono"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs ui-muted">延迟下载(分钟)</label>
                    <input type="number" min={0} value={formData.delayedDownloadMinutes}
                      onChange={e => setFormData({ ...formData, delayedDownloadMinutes: Number(e.target.value) || 0 })}
                      placeholder="0 = 不延迟"
                      className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-xs outline-none" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs ui-muted">不下载集数</label>
                    <input type="text" value={formData.notDownloadEpisodes}
                      onChange={e => setFormData({ ...formData, notDownloadEpisodes: e.target.value })}
                      placeholder="1, 3, 7-9"
                      className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-xs outline-none font-mono" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs ui-muted">集数偏移</label>
                    <input type="number" step="0.5" value={formData.episodeOffset}
                      onChange={e => setFormData({ ...formData, episodeOffset: Number(e.target.value) || 0 })}
                      placeholder="0"
                      className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-xs outline-none" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs ui-muted">总集数</label>
                    <input type="number" min={0} value={formData.totalEpisodeNumber}
                      onChange={e => setFormData({ ...formData, totalEpisodeNumber: Number(e.target.value) || 0 })}
                      placeholder="0 = 不限制"
                      className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-xs outline-none" />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Checkbox
                    size="sm"
                    checked={formData.omit}
                    onChange={(v) => setFormData({ ...formData, omit: v })}
                    label="记录缺集"
                    labelClassName="text-sm text-slate-700"
                  />
                  <Checkbox
                    size="sm"
                    checked={formData.autoDisabled}
                    onChange={(v) => setFormData({ ...formData, autoDisabled: v })}
                    label="达到总集数后自动停用"
                    labelClassName="text-sm text-slate-700"
                  />
                </div>

                <div className="rounded-2xl border border-slate-100 bg-slate-50 p-3 space-y-3">
                  <Checkbox
                    size="sm"
                    checked={formData.customEpisode}
                    onChange={(v) => setFormData({ ...formData, customEpisode: v })}
                    label="使用自定义集数正则"
                    labelClassName="text-sm text-slate-700"
                  />
                  {formData.customEpisode && (
                    <div className="grid grid-cols-1 md:grid-cols-[1fr_120px] gap-3">
                      <div className="space-y-1.5">
                        <label className="text-xs ui-muted">集数提取正则</label>
                        <input type="text" value={formData.customEpisodeRegex}
                          onChange={e => setFormData({ ...formData, customEpisodeRegex: e.target.value })}
                          placeholder="例如: 第(\\d+)话"
                          className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-2xl text-xs outline-none font-mono" />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs ui-muted">分组序号</label>
                        <input type="number" min={0} value={formData.customEpisodeGroupIndex}
                          onChange={e => setFormData({ ...formData, customEpisodeGroupIndex: Number(e.target.value) || 1 })}
                          className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-2xl text-xs outline-none" />
                      </div>
                    </div>
                  )}
                </div>
                <p className="text-xs text-slate-400">
                  匹配标题、描述、标签全文。作用域规则可写作 {'{{字幕组}}:正则'}；RSS 不提供体积/做种数时，相关数值过滤自动跳过。
                </p>
              </div>
            )}
          </div>
          </>}

          {editing && <div className="space-y-2">
            <label className="text-sm font-medium ui-title">天翼云盘账号</label>
            <select value={formData.accountId} onChange={e => setFormData({ ...formData, accountId: Number(e.target.value), targetFolderId: '', targetFolder: '' })}
              className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none" required>
              <option value={0}>请选择</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.alias?.trim() || a.username}</option>)}
            </select>
          </div>}

          {editing && <div className="space-y-2">
            <label className="text-sm font-medium ui-title">目标目录</label>
            <div className="flex gap-2">
              <input type="text" readOnly value={formData.targetFolder || formData.targetFolderId} placeholder="点击右侧按钮选择目录"
                className="flex-1 px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none" />
              <button type="button" onClick={() => formData.accountId ? setFolderSelectorOpen(true) : toast.warning('请先选择账号')}
                className="px-5 py-3 border border-slate-300 rounded-2xl text-sm font-medium hover:bg-slate-50">选择</button>
            </div>
          </div>}

          <Checkbox
            checked={formData.enabled}
            onChange={(v) => setFormData({ ...formData, enabled: v })}
            label="启用此订阅"
          />

          <div className="flex justify-end gap-3 pt-4">
            <button type="button" onClick={() => setIsModalOpen(false)} disabled={isSaving} className="px-6 py-2.5 rounded-full text-sm font-medium text-[#0b57d0] hover:bg-[#0b57d0]/10 disabled:opacity-50 disabled:cursor-not-allowed">取消</button>
            <button type="submit" disabled={isSaving || !formData.targetFolderId} className="px-6 py-2.5 rounded-full text-sm font-medium bg-[#0b57d0] text-white hover:bg-[#0b57d0]/90 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed">{isSaving ? '创建中...' : editing ? '保存修改' : '创建订阅'}</button>
          </div>
        </form>
      </Modal>

      <FolderSelector
        isOpen={folderSelectorOpen}
        onClose={() => setFolderSelectorOpen(false)}
        accountId={formData.accountId}
        accountName={(() => { const acc = accounts.find(a => a.id === formData.accountId); return acc ? (acc.alias?.trim() || acc.username) : ''; })()}
        onSelect={(folder: SelectedFolder) => {
          setFormData({ ...formData, targetFolderId: folder.id, targetFolder: folder.path || folder.name });
          setFolderSelectorOpen(false);
        }}
      />

      <MetadataEditor
        open={Boolean(metadataTarget)}
        title={metadataTarget?.title || ''}
        endpoint={metadataTarget ? `/api/pt/${metadataTarget.type === 'subscription' ? 'subscriptions' : 'releases'}/${metadataTarget.id}/metadata` : ''}
        onClose={() => setMetadataTarget(null)}
        onSaved={() => { void fetchSubs(); void fetchAllReleases(true); }}
      />

      {/* PT 设置 */}
      <Modal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} title="PT 设置" footer={null}>
        {!settings ? <div className="text-center text-slate-500 py-8">加载中...</div> : (
          <div className="space-y-5">
            <div className="rounded-2xl border border-slate-200 p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-800"><Search size={16} /> Mikan 站点</div>
              <p className="text-xs text-slate-500">用于番剧搜索、字幕组选择和 RSS 拉取。首选地址不可用时会自动尝试内置镜像。</p>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="url"
                  value={settings.mikanBaseUrl}
                  onChange={e => {
                    setSettings({ ...settings, mikanBaseUrl: e.target.value });
                    setMikanTestStatus(null);
                  }}
                  placeholder="https://mikanani.kas.pub"
                  className="flex-1 min-w-0 px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none font-mono text-xs"
                />
                <button type="button" onClick={handleTestMikan} disabled={testingMikan || !settings.mikanBaseUrl.trim()}
                  className="px-5 py-2.5 rounded-full border border-slate-300 text-sm hover:bg-slate-50 disabled:opacity-50 shrink-0">
                  {testingMikan ? '测试中...' : '测试地址'}
                </button>
              </div>
              {mikanTestStatus && (
                <div className={`text-xs ${mikanTestStatus.ok ? 'text-green-600' : 'text-red-600'}`}>{mikanTestStatus.message}</div>
              )}
              <div className="text-[11px] text-slate-400">推荐：mikanani.kas.pub；也可填写 mikanime.tv 或其他完整镜像地址。</div>
            </div>

            <div className="rounded-2xl border border-slate-200 p-4 space-y-4">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-800"><Download size={16} /> 下载客户端</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2 md:col-span-2">
                  <label className="text-xs ui-muted">类型</label>
                  <select value={settings.downloader.type} onChange={e => setSettings({ ...settings, downloader: { ...settings.downloader, type: e.target.value } })}
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none">
                    <option value="qbittorrent">qBittorrent</option>
                  </select>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <label className="text-xs ui-muted">WebUI 地址</label>
                  <input type="text" value={settings.downloader.baseUrl} onChange={e => setSettings({ ...settings, downloader: { ...settings.downloader, baseUrl: e.target.value } })}
                    placeholder="http://192.168.1.10:8080"
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none font-mono text-xs" />
                </div>
                <div className="space-y-2">
                  <label className="text-xs ui-muted">用户名</label>
                  <input type="text" value={settings.downloader.username} onChange={e => setSettings({ ...settings, downloader: { ...settings.downloader, username: e.target.value } })}
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none" />
                </div>
                <div className="space-y-2">
                  <label className="text-xs ui-muted">密码</label>
                  <input
                    type="password"
                    value={settings.downloader.password}
                    onChange={e => setSettings({ ...settings, downloader: { ...settings.downloader, password: e.target.value } })}
                    placeholder={settings.downloader.hasPassword ? '已保存密码；留空不覆盖' : 'qBittorrent 密码'}
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs ui-muted">分类前缀</label>
                  <input type="text" value={settings.downloader.categoryPrefix} onChange={e => setSettings({ ...settings, downloader: { ...settings.downloader, categoryPrefix: e.target.value } })}
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none" />
                </div>
                <div className="space-y-2">
                  <label className="text-xs ui-muted">标签前缀</label>
                  <input type="text" value={settings.downloader.tagPrefix} onChange={e => setSettings({ ...settings, downloader: { ...settings.downloader, tagPrefix: e.target.value } })}
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none" />
                </div>
                <div className="md:col-span-2">
                  <Checkbox
                    size="sm"
                    checked={settings.downloader.forceStart}
                    onChange={(v) => setSettings({ ...settings, downloader: { ...settings.downloader, forceStart: v } })}
                    label="PT 任务强制启动（绕过 qB 活跃任务队列限制）"
                    labelClassName="text-sm text-slate-700"
                  />
                  <p className="ml-6 mt-1 text-[11px] text-slate-400">建议开启；只作用于本系统创建的 PT 任务，不修改 qB 全局队列设置。</p>
                </div>
                <div className="md:col-span-2">
                  <Checkbox
                    size="sm"
                    checked={settings.downloader.insecureSkipTlsVerify}
                    onChange={(v) => setSettings({ ...settings, downloader: { ...settings.downloader, insecureSkipTlsVerify: v } })}
                    label="允许自签 HTTPS（跳过证书校验）"
                    labelClassName="text-sm text-slate-700"
                  />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button type="button" onClick={handleTestDownloader} disabled={testing}
                  className="px-5 py-2 rounded-full border border-slate-300 text-sm hover:bg-slate-50 disabled:opacity-50">
                  {testing ? '测试中...' : '测试连接'}
                </button>
                {testStatus && (
                  <span className={`text-xs ${testStatus.ok ? 'text-green-600' : 'text-red-600'}`}>{testStatus.message}</span>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 p-4 space-y-4">
              <div className="text-sm font-medium text-slate-800">下载与定时</div>
              <div className="space-y-2">
                <label className="text-xs ui-muted">下载根目录（容器内可见路径）</label>
                <input type="text" value={settings.downloadRoot} onChange={e => setSettings({ ...settings, downloadRoot: e.target.value })}
                  placeholder="例如：/downloads/pt" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none font-mono text-xs" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-xs ui-muted">RSS 拉取 cron</label>
                  <input type="text" value={settings.pollCron} onChange={e => setSettings({ ...settings, pollCron: e.target.value })}
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none font-mono text-xs" />
                </div>
                <div className="space-y-2">
                  <label className="text-xs ui-muted">清理 cron</label>
                  <input type="text" value={settings.cleanupCron} onChange={e => setSettings({ ...settings, cleanupCron: e.target.value })}
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none font-mono text-xs" />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-xs ui-muted">全局排除正则</label>
                <textarea
                  rows={3}
                  value={settings.globalExcludePattern}
                  onChange={e => setSettings({ ...settings, globalExcludePattern: e.target.value })}
                  placeholder="一行一个正则；订阅开启“启用全局排除规则”后生效"
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none font-mono text-xs"
                />
              </div>
              <Checkbox
                size="sm"
                checked={settings.cleanupEnabled}
                onChange={(v) => setSettings({ ...settings, cleanupEnabled: v })}
                label="已完成 release 自动清理 qb 任务和本地文件"
                labelClassName="text-sm text-slate-700"
              />
              <Checkbox
                size="sm"
                className="mt-2"
                checked={settings.autoDeleteSource}
                onChange={(v) => setSettings({ ...settings, autoDeleteSource: v })}
                label="生成 .cas 后自动删除本地源文件"
                labelClassName="text-sm text-slate-700"
              />
              <div className="flex items-center gap-2 mt-2 ml-6">
                <span className={`text-xs ${settings.deleteCloudSource ? 'text-emerald-600' : 'text-slate-400'}`}>
                  {settings.deleteCloudSource ? '✓ 网盘源文件会在 CAS 生成后自动删除' : '网盘源文件删除请在「媒体」选项卡中配置「生成后删除源文件」'}
                </span>
              </div>
              <Checkbox
                size="sm"
                className="mt-2"
                checked={settings.enableStrm}
                onChange={(v) => setSettings({ ...settings, enableStrm: v })}
                label="上传完成后自动生成 STRM 文件"
                labelClassName="text-sm text-slate-700"
              />
            </div>

            <div className="rounded-2xl border border-slate-200 p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-slate-800">网盘与 STRM 整理</div>
                <Checkbox
                  size="sm"
                  checked={settings.strmOrganize.enabled}
                  onChange={(v) => setSettings({ ...settings, strmOrganize: { ...settings.strmOrganize, enabled: v } })}
                  label="启用整理"
                  labelClassName="text-sm text-slate-700"
                />
              </div>

              {settings.strmOrganize.enabled && (
                <>
                  <p className="text-xs text-slate-500">
                    上传文件会直接按媒体库目录整理，STRM 复用同一路径；上传生成的 CAS 存根保存到目标目录下的 _cas 镜像目录。
                  </p>
                  <div className="space-y-2">
                    <label className="text-xs ui-muted">整理模式</label>
                    <select value={settings.strmOrganize.mode}
                      onChange={e => setSettings({ ...settings, strmOrganize: { ...settings.strmOrganize, mode: e.target.value as 'regex' | 'ai' } })}
                      className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none">
                      <option value="regex">正则解析（轻量级，不依赖 AI）</option>
                      <option value="ai">AI+TMDB（需要配置 AI 和 TMDB）</option>
                    </select>
                  </div>

                  {settings.strmOrganize.mode === 'regex' && (
                    <>
                      <div className="space-y-2">
                        <label className="text-xs ui-muted">分类目录名</label>
                        <input type="text" value={settings.strmOrganize.categoryFolder}
                          onChange={e => setSettings({ ...settings, strmOrganize: { ...settings.strmOrganize, categoryFolder: e.target.value } })}
                          placeholder="动漫"
                          className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs ui-muted">文件名模板</label>
                        <input type="text" value={settings.strmOrganize.fileTemplate}
                          onChange={e => setSettings({ ...settings, strmOrganize: { ...settings.strmOrganize, fileTemplate: e.target.value } })}
                          placeholder="{title} S{season}E{episode}"
                          className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none font-mono text-xs" />
                        <p className="text-xs text-slate-400">可用变量: {'{title}'} {'{season}'} {'{episode}'} {'{subgroup}'} {'{resolution}'} {'{original}'}</p>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <label className="text-xs ui-muted">季度提取正则（留空用默认）</label>
                          <input type="text" value={settings.strmOrganize.seasonRegex}
                            onChange={e => setSettings({ ...settings, strmOrganize: { ...settings.strmOrganize, seasonRegex: e.target.value } })}
                            placeholder="S(\d{1,2})|第(\d+)季"
                            className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none font-mono text-xs" />
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs ui-muted">集数提取正则（留空用默认）</label>
                          <input type="text" value={settings.strmOrganize.episodeRegex}
                            onChange={e => setSettings({ ...settings, strmOrganize: { ...settings.strmOrganize, episodeRegex: e.target.value } })}
                            placeholder="第\d+[话話集]|EP?\d+"
                            className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none font-mono text-xs" />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs ui-muted">默认季度（当无法提取时）</label>
                        <input type="number" value={settings.strmOrganize.defaultSeason} min={1}
                          onChange={e => setSettings({ ...settings, strmOrganize: { ...settings.strmOrganize, defaultSeason: Number(e.target.value) } })}
                          className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none" />
                      </div>
                    </>
                  )}

                  {settings.strmOrganize.mode === 'ai' && (
                    <div className="text-xs ui-muted bg-slate-50 p-3 rounded-xl">
                      AI 模式需要在系统设置中配置 OpenAI 和 TMDB API Key。上传前只解析一次，网盘与 STRM 共用识别结果和目录结构。
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="border-t border-slate-200 pt-4 mt-4">
              <h3 className="text-sm font-medium ui-title mb-3">站点代理（需在系统设置中配置代理服务器）</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {[
                  { key: 'ptMikan', label: '蜜柑计划' },
                  { key: 'ptAnibt', label: 'AniBT' },
                  { key: 'ptAnimegarden', label: 'AnimeGarden' },
                  { key: 'ptNyaa', label: 'Nyaa' },
                  { key: 'ptDmhy', label: '动漫花园' }
                ].map(item => (
                  <div key={item.key} className="p-2 rounded-lg hover:bg-slate-50 transition-colors">
                    <Checkbox
                      size="sm"
                      checked={!!proxyServices[item.key]}
                      onChange={(v) => setProxyServices({ ...proxyServices, [item.key]: v })}
                      label={item.label}
                      labelClassName="text-sm text-slate-700"
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => setIsSettingsOpen(false)} className="px-6 py-2.5 rounded-full text-sm font-medium text-[#0b57d0] hover:bg-[#0b57d0]/10">取消</button>
              <button type="button" onClick={handleSaveSettings} className="px-6 py-2.5 rounded-full text-sm font-medium bg-[#0b57d0] text-white hover:bg-[#0b57d0]/90 shadow-sm">保存设置</button>
            </div>
          </div>
        )}
      </Modal>

      {/* 搜索 RSS */}
      <Modal isOpen={isSearchOpen} onClose={() => { setIsSearchOpen(false); setSearchKeyword(''); setSearchResults([]); setSearchGroups([]); setSearchStep('search'); setSearchSelectedTitle(''); }} title={searchStep === 'search' ? '搜索番剧' : `选择字幕组 - ${searchSelectedTitle}`} footer={null}>
        <div className="space-y-4">
          {searchStep === 'search' && (
            <>
              <div className="flex gap-2">
                <input type="text" value={searchKeyword} onChange={e => setSearchKeyword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSearch()}
                  placeholder="输入番剧名称搜索..."
                  className="flex-1 px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20" />
                <button type="button" onClick={handleSearch} disabled={searchLoading}
                  className="px-5 py-3 bg-[#0b57d0] text-white rounded-2xl text-sm font-medium hover:bg-[#0b57d0]/90 disabled:opacity-50 flex items-center gap-2">
                  {searchLoading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                  搜索
                </button>
              </div>
              <div className="flex items-center gap-2 px-1">
                <Checkbox
                  size="sm"
                  checked={aggregateSearch}
                  onChange={setAggregateSearch}
                  label="聚合搜索（同时搜索所有源）"
                  labelClassName="text-sm text-slate-600"
                />
              </div>
              <div className="max-h-96 overflow-y-auto space-y-2">
                {searchResults.length === 0 && !searchLoading && (
                  <p className="text-center text-slate-400 text-sm py-8">
                    {searchKeyword ? '无搜索结果' : '支持 Mikan、AniBT、AnimeGarden、Nyaa、动漫花园搜索'}
                  </p>
                )}
                {searchResults.map((anime) => (
                  <button key={anime.id} type="button" onClick={() => handleSelectAnime(anime)}
                    className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-slate-50 border border-slate-200 text-left transition-colors">
                    {anime.cover && <img src={anime.cover} alt="" className="w-12 h-16 object-cover rounded-lg bg-slate-100" />}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-800 truncate">{anime.title}</div>
                      <div className="text-xs text-slate-400">{anime.source}{anime.directRss ? (anime.groups && anime.groups.length > 0 ? ` · ${anime.groups.length} 个字幕组` : ' · 点击直接使用') : ''}</div>
                      {anime.preview && anime.preview.length > 0 && (
                        <div className="mt-1 space-y-0.5">
                          {anime.preview.map((t, i) => (
                            <div key={i} className="text-xs text-slate-400 truncate">· {t}</div>
                          ))}
                        </div>
                      )}
                    </div>
                    <ChevronRight size={16} className="text-slate-400 shrink-0" />
                  </button>
                ))}
              </div>
            </>
          )}
          {searchStep === 'groups' && (
            <>
              <button type="button" onClick={() => setSearchStep('search')}
                className="text-sm text-[#0b57d0] hover:underline">&larr; 返回搜索</button>
              <div className="max-h-96 overflow-y-auto space-y-2">
                {searchGroups.length === 0 && !searchLoading && (
                  <p className="text-center text-slate-400 text-sm py-8">未找到字幕组</p>
                )}
                {searchGroups.map((group, idx) => (
                  <div key={idx}>
                    <div className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-slate-50 border border-slate-200 text-left transition-colors">
                      <button type="button" onClick={() => handleSelectGroup(group)} className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-slate-800">{group.name}</div>
                        {group.itemCount != null && <div className="text-xs text-slate-400">{group.itemCount} 个资源</div>}
                      </button>
                      <button type="button" onClick={(e) => { e.stopPropagation(); handlePreviewGroup(idx, group); }}
                        className="ml-2 px-3 py-1.5 text-xs ui-muted hover:text-[#0b57d0] hover:bg-[#0b57d0]/10 rounded-full transition-colors">
                        {previewGroupIdx === idx ? '收起' : '预览'}
                      </button>
                    </div>
                    {previewGroupIdx === idx && (
                      <div className="ml-4 mt-1 mb-2 space-y-1">
                        {groupItemsLoading ? (
                          <div className="text-xs text-slate-400 py-2"><Loader2 size={12} className="animate-spin inline mr-1" />加载中...</div>
                        ) : groupItems.length === 0 ? (
                          <div className="text-xs text-slate-400 py-2">暂无资源</div>
                        ) : (
                          <div className="max-h-48 overflow-y-auto space-y-1">
                            {groupItems.map((item: any, i: number) => {
                              const episode = item.episodeLabel
                                ? `S${String(item.seasonNumber || 1).padStart(2, '0')}E${item.episodeLabel}`
                                : '';
                              const meta = [item.subgroup, episode, item.resolution, item.quality, formatSize(item.size), item.volumeFactor]
                                .filter(Boolean)
                                .join(' · ');
                              return (
                                <div key={i} className="text-xs text-slate-600 py-0.5" title={item.title}>
                                  <div className="truncate">{item.title}</div>
                                  {meta && <div className="text-[10px] text-slate-400 truncate">{meta}</div>}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {searchLoading && (
                  <div className="flex items-center justify-center gap-2 py-8 text-slate-400 text-sm">
                    <Loader2 size={16} className="animate-spin" /> 获取字幕组中...
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* 顶部「搜索创建」入口：复用与海报墙相同的搜索弹窗 */}
      <PTSearchModal
        isOpen={isExternalSearchOpen}
        onClose={() => setIsExternalSearchOpen(false)}
        defaultKeyword=""
        isAnime
        autoSearchOnOpen={false}
        onCreatePtSubscription={handleExternalSearchSubmit}
      />
    </div>
  );
};

export default PtTab;
