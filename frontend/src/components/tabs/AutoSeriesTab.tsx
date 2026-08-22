import React, { useState, useEffect, useRef } from 'react';
import { Plus, PlayCircle, RefreshCw, AlertCircle, CheckCircle2, ArrowLeft, Check, GripVertical, ArrowUp, ArrowDown, Settings, Folder, Save, Trash2, History } from 'lucide-react';
import { Reorder, useDragControls } from 'motion/react';
import Modal from '../Modal';
import FolderSelector, { SelectedFolder } from '../FolderSelector';
import Checkbox from '../ui/Checkbox';
import { useToast } from '../ui/Toast';
import { useDialog } from '../ui/Dialog';

interface Account {
  id: number;
  username: string;
  alias?: string;
}

interface AutoSeriesSettings {
  accountId: string;
  targetFolderId: string;
  targetFolder: string;
  mode: AutoSeriesMode;
  sourcePreferences: SourcePreference[];
  keepCasAfterRestore: boolean;
  allowHdhivePoints: boolean;
  hdhiveMaxPoints: number;
  agentEnabled: boolean;
  toolCallMode: ToolCallMode;
  mediaPreference: {
    preferredGroups: string[];
    blockedKeywords: string[];
    extraRequirement: string;
    fallbackMode: 'strict' | 'next_tier';
    upgradePolicy: 'none' | 'higher_score';
  };
}

type AutoSeriesMode = 'normal' | 'lazy';

interface CandidateResource {
  id?: string;
  slug?: string;
  messageId?: string;
  title: string;
  shareLink: string;
  score?: number;
  source: 'cloudsaver' | 'hdhive' | 'subscription';
  quality?: string;
  sizeFormatted?: string;
  isUnlocked?: boolean;
  isFree?: boolean;
  points?: number | null;
}

type AutoSeriesSource = 'cloudsaver' | 'hdhive' | 'pt' | 'subscription';
interface SourcePreference { source: AutoSeriesSource; enabled: boolean }

const SOURCE_LABELS: Record<AutoSeriesSource, string> = {
  cloudsaver: 'CloudSaver',
  hdhive: '影巢',
  pt: 'PT',
  subscription: '订阅'
};
const DEFAULT_SOURCES: SourcePreference[] = [
  { source: 'cloudsaver', enabled: true },
  { source: 'hdhive', enabled: true },
  { source: 'pt', enabled: true },
  { source: 'subscription', enabled: true }
];

interface SourcePreferenceRowProps {
  item: SourcePreference;
  index: number;
  total: number;
  onMove: (source: AutoSeriesSource, offset: number) => void;
  onToggle: (source: AutoSeriesSource, enabled: boolean) => void;
  onDragEnd: () => void;
}

type ToolCallMode = 'auto' | 'native' | 'json';
interface AutoSeriesIntent {
  id: string;
  title: string;
  status: 'pending' | 'searching' | 'active' | 'no_coverage' | 'retry_wait' | 'failed' | 'paused';
  agentEnabled?: boolean;
  toolCallMode?: ToolCallMode;
  degraded?: boolean;
  lastError?: string;
  taskId?: number | null;
  ptSubscriptionId?: number | null;
  taskIdsJson?: string;
  ptSubscriptionIdsJson?: string;
  coverageJson?: string;
  lastWorkflowRunId?: string;
}

interface MetadataAuditRun {
  id: string;
  status: string;
  summary?: string;
  updatedAt?: string;
  context?: { metadataAudit?: { changed?: boolean; mappedFiles?: number; fingerprint?: string } };
}

interface IntentCoverage {
  coveredEpisodes?: number;
  expectedEpisodes?: number;
  seasons?: Array<{ seasonNumber: number; coveredEpisodes: number; expectedEpisodes: number; complete: boolean }>;
}

const parseIntentCoverage = (value?: string): IntentCoverage | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as IntentCoverage;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const parseIntentIds = (value?: string, legacyId?: number | null): number[] => {
  const ids = new Set<number>();
  if (legacyId) ids.add(Number(legacyId));
  try {
    const parsed = JSON.parse(value || '[]');
    if (Array.isArray(parsed)) {
      parsed.map(Number).filter(Boolean).forEach(id => ids.add(id));
    }
  } catch {}
  return [...ids];
};

const SourcePreferenceRow: React.FC<SourcePreferenceRowProps> = ({ item, index, total, onMove, onToggle, onDragEnd }) => {
  const dragControls = useDragControls();

  return (
    <Reorder.Item
      value={item}
      dragListener={false}
      dragControls={dragControls}
      onDragEnd={onDragEnd}
      whileDrag={{ scale: 1.02, boxShadow: '0 10px 25px rgba(15, 23, 42, 0.14)' }}
      transition={{ type: 'spring', stiffness: 500, damping: 36 }}
      className="flex items-center gap-3 px-4 py-3 rounded-2xl border border-slate-200 bg-white relative z-0"
    >
      <button
        type="button"
        aria-label={`拖动${SOURCE_LABELS[item.source]}调整顺序`}
        title="拖动调整顺序"
        onPointerDown={event => dragControls.start(event)}
        className="-m-2 p-2 text-slate-400 hover:text-slate-700 cursor-grab active:cursor-grabbing touch-none select-none"
      >
        <GripVertical size={17} />
      </button>
      <span className="w-6 h-6 rounded-full bg-slate-100 text-slate-600 text-xs font-bold flex items-center justify-center">{index + 1}</span>
      <span className="flex-1 text-sm font-medium text-slate-800">{SOURCE_LABELS[item.source]}</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={`上移${SOURCE_LABELS[item.source]}`}
          title="上移"
          disabled={index === 0}
          onClick={() => onMove(item.source, -1)}
          className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg disabled:opacity-25 disabled:cursor-not-allowed"
        >
          <ArrowUp size={15} />
        </button>
        <button
          type="button"
          aria-label={`下移${SOURCE_LABELS[item.source]}`}
          title="下移"
          disabled={index === total - 1}
          onClick={() => onMove(item.source, 1)}
          className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg disabled:opacity-25 disabled:cursor-not-allowed"
        >
          <ArrowDown size={15} />
        </button>
      </div>
      <Checkbox checked={item.enabled} onChange={enabled => onToggle(item.source, enabled)} />
    </Reorder.Item>
  );
};

const DEFAULT_AUTO_SERIES_MODE: AutoSeriesMode = 'lazy';
const DEFAULT_HDHIVE_MAX_POINTS = 10;
const AUTO_SERIES_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_BLOCKED_KEYWORDS = ['预告', 'trailer', 'teaser', '样片', 'sample', 'CAM', 'TS'];
const DEFAULT_SETTINGS: AutoSeriesSettings = {
  accountId: '',
  targetFolderId: '',
  targetFolder: '',
  mode: DEFAULT_AUTO_SERIES_MODE,
  sourcePreferences: DEFAULT_SOURCES,
  keepCasAfterRestore: false,
  allowHdhivePoints: false,
  hdhiveMaxPoints: DEFAULT_HDHIVE_MAX_POINTS,
  agentEnabled: false,
  toolCallMode: 'auto',
  mediaPreference: {
    preferredGroups: [],
    blockedKeywords: DEFAULT_BLOCKED_KEYWORDS,
    extraRequirement: '',
    fallbackMode: 'next_tier',
    upgradePolicy: 'higher_score'
  }
};

const hasValidHdhivePointLimit = (value: number) => (
  Number.isSafeInteger(value) && value >= 0
);

const fetchAutoSeries = async (url: string, init?: RequestInit) => {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), AUTO_SERIES_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('自动追剧请求超过 120 秒，请检查已启用的资源来源或稍后重试');
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
};

const readJsonResponse = async (response: Response, fallbackMessage: string) => {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error(response.status === 404
      ? '后端尚未加载自动追剧设置接口，请重启服务后重试'
      : `${fallbackMessage}（HTTP ${response.status}）`);
  }
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.error || `${fallbackMessage}（HTTP ${response.status}）`);
  }
  return data;
};

const waitForAutoSeriesIntent = async (intentId: string): Promise<AutoSeriesIntent> => {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(resolve => window.setTimeout(resolve, 2000));
    const response = await fetch('/api/auto-series/intents');
    const data = await response.json();
    if (!data.success) throw new Error(data.error || '自动追剧后台状态查询失败');
    const intent = (data.data || []).find((item: AutoSeriesIntent) => item.id === intentId);
    if (!intent) throw new Error('追剧 Intent 不存在');
    if (['active', 'no_coverage', 'failed', 'paused'].includes(intent.status)) return intent;
  }
  throw new Error('自动追剧仍在后台处理中，请稍后查看 Intent 列表');
};

interface AutoSeriesTabProps {
  onNavigateHistory: (filters?: { module?: string; subjectType?: string; subjectId?: string | number }) => void;
}

const AutoSeriesTab: React.FC<AutoSeriesTabProps> = ({ onNavigateHistory }) => {
  const toast = useToast();
  const dialog = useDialog();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isFolderSelectorOpen, setIsFolderSelectorOpen] = useState(false);
  const [managingIntent, setManagingIntent] = useState<AutoSeriesIntent | null>(null);
  const [deletingIntent, setDeletingIntent] = useState(false);
  const [deleteOptions, setDeleteOptions] = useState({ deleteTasks: false, deleteCloud: false, deletePtSubscriptions: false });
  const [loading, setLoading] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [searching, setSearching] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [settings, setSettings] = useState<AutoSeriesSettings>(DEFAULT_SETTINGS);
  const [form, setForm] = useState<{
    title: string;
    year: string;
    manualSelect: boolean;
  }>({
    title: '',
    year: '',
    manualSelect: false
  });
  const [candidates, setCandidates] = useState<CandidateResource[]>([]);
  const [intents, setIntents] = useState<AutoSeriesIntent[]>([]);
  const [metadataAudits, setMetadataAudits] = useState<Record<string, MetadataAuditRun[]>>({});
  const [selectedCandidateIndex, setSelectedCandidateIndex] = useState(0);
  const sourcePreferencesRef = useRef(settings.sourcePreferences);
  const [step, setStep] = useState<'form' | 'select'>('form');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    const loadJson = async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url} 请求失败: ${response.status}`);
      return response.json();
    };
    const [accountsResult, settingsResult, intentsResult] = await Promise.allSettled([
      loadJson('/api/accounts'),
      loadJson('/api/auto-series/settings'),
      loadJson('/api/auto-series/intents')
    ]);

    if (accountsResult.status === 'fulfilled' && accountsResult.value.success) {
      setAccounts(accountsResult.value.data);
    } else if (accountsResult.status === 'rejected') {
      console.error('Failed to fetch accounts:', accountsResult.reason);
    }
    if (settingsResult.status === 'fulfilled' && settingsResult.value.success) {
      const nextSettings = { ...DEFAULT_SETTINGS, ...settingsResult.value.data };
      setSettings(nextSettings);
      sourcePreferencesRef.current = nextSettings.sourcePreferences;
    } else if (settingsResult.status === 'rejected') {
      console.error('Failed to fetch settings:', settingsResult.reason);
    }
    if (intentsResult.status === 'fulfilled' && intentsResult.value.success) {
      const nextIntents = intentsResult.value.data || [];
      setIntents(nextIntents);
      const auditEntries = await Promise.all(nextIntents.filter((intent: AutoSeriesIntent) => intent.agentEnabled).slice(0, 20).map(async (intent: AutoSeriesIntent) => {
        try {
          const data = await loadJson(`/api/workflow-runs?intentId=${encodeURIComponent(intent.id)}&type=metadata_audit&limit=5`);
          return [intent.id, data.success ? data.data || [] : []] as const;
        } catch { return [intent.id, []] as const; }
      }));
      setMetadataAudits(Object.fromEntries(auditEntries));
    }
  };

  const resetModal = () => {
    setIsModalOpen(false);
    setForm({
      title: '',
      year: '',
      manualSelect: false
    });
    setCandidates([]);
    setSelectedCandidateIndex(0);
    setStep('form');
  };

  const createTask = async (shareLink?: string, resourceTitle?: string, sources?: AutoSeriesSource[]) => {
    setLoading(true);
    try {
      const response = await fetchAutoSeries('/api/auto-series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          year: form.year,
          ...(sources ? { sources } : {}),
          ...(shareLink ? { shareLink, resourceTitle: resourceTitle || '' } : {})
        })
      });
      const data = await response.json();
      if (data.success) {
        const intentId = String(data.data?.intentId || '');
        if (!intentId) throw new Error('Intent 编号缺失');
        const submittedTitle = form.title.trim();
        const submittedMode = settings.mode;
        resetModal();
        toast.info(`已提交“${submittedTitle}”，正在后台创建，不影响继续操作`, { duration: 5000 });
        void waitForAutoSeriesIntent(intentId).then((intent) => {
          void fetchData();
          if (intent.status === 'failed') {
            toast.error(`自动追剧失败：${intent.title} - ${intent.lastError || '未知错误'}`, { duration: 8000 });
            return;
          }
          if (intent.status === 'no_coverage') {
            toast.info(`${intent.title} 暂无覆盖资源，系统将在每日 03:15 重新搜索`);
            return;
          }
          toast.success(`已激活${submittedMode === 'lazy' ? '懒转存' : '自动'}追剧：${intent.title}${intent.degraded ? '（AI 已降级）' : ''}`);
        }).catch((error) => {
          toast.warning((error as Error).message, { duration: 7000 });
        });
      } else {
        toast.error('自动追剧失败: ' + data.error);
      }
    } catch (error) {
      toast.error('自动追剧失败: ' + (error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const toggleSource = (source: AutoSeriesSource, enabled: boolean) => {
    const next = settings.sourcePreferences.map(item => item.source === source ? { ...item, enabled } : item);
    sourcePreferencesRef.current = next;
    setSettings(current => ({ ...current, sourcePreferences: next }));
  };

  const reorderSource = (items: SourcePreference[], source: AutoSeriesSource, target: AutoSeriesSource) => {
    if (source === target) return items;
    const next = [...items];
    const from = next.findIndex(item => item.source === source);
    const to = next.findIndex(item => item.source === target);
    if (from < 0 || to < 0) return items;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  };

  const moveSourceBy = (source: AutoSeriesSource, offset: number) => {
    const from = settings.sourcePreferences.findIndex(item => item.source === source);
    const target = settings.sourcePreferences[from + offset];
    if (!target) return;
    const next = reorderSource(settings.sourcePreferences, source, target.source);
    sourcePreferencesRef.current = next;
    setSettings(current => ({ ...current, sourcePreferences: next }));
  };

  const handleSourceReorder = (next: SourcePreference[]) => {
    sourcePreferencesRef.current = next;
    setSettings(current => ({ ...current, sourcePreferences: next }));
  };

  const handleSourceDragEnd = () => setSettings(current => ({ ...current, sourcePreferences: sourcePreferencesRef.current }));

  const handleSaveSettings = async () => {
    if (!settings.accountId) return toast.warning('请选择默认追剧账号');
    if (!settings.targetFolderId || !settings.targetFolder) return toast.warning('请选择默认保存目录');
    if (!settings.sourcePreferences.some(item => item.enabled)) return toast.warning('请至少启用一个资源来源');
    if (!hasValidHdhivePointLimit(settings.hdhiveMaxPoints)) return toast.warning('影巢单个资源积分上限必须是大于或等于 0 的整数');
    setSavingSettings(true);
    try {
      const response = await fetch('/api/auto-series/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      const data = await readJsonResponse(response, '保存失败');
      setSettings(data.data);
      sourcePreferencesRef.current = data.data.sourcePreferences;
      setIsSettingsOpen(false);
      toast.success('自动追剧设置已保存');
    } catch (error) {
      toast.error('自动追剧设置保存失败: ' + (error as Error).message);
    } finally {
      setSavingSettings(false);
    }
  };

  const handleCloseSettings = () => {
    setIsSettingsOpen(false);
    void fetchData();
  };

  const handleSearch = async () => {
    if (!form.title.trim()) {
      toast.warning('剧名不能为空');
      return;
    }
    setSearching(true);
    try {
      const params = new URLSearchParams({ title: form.title.trim() });
      if (form.year.trim()) params.append('year', form.year.trim());
      params.append('sources', settings.sourcePreferences.filter(item => item.enabled && item.source !== 'pt').map(item => item.source).join(','));
      params.append('allowHdhivePoints', String(settings.allowHdhivePoints));
      if (settings.allowHdhivePoints) params.append('hdhiveMaxPoints', String(settings.hdhiveMaxPoints));
      const response = await fetchAutoSeries(`/api/auto-series/search?${params.toString()}`);
      const data = await response.json();
      if (data.success) {
        const list: CandidateResource[] = data.data?.resources || [];
        if (!list.length) {
          toast.info('未搜索到可手动选择的网盘资源；PT 来源请关闭“手动选择资源”后创建');
          return;
        }
        setCandidates(list);
        setSelectedCandidateIndex(0);
        setStep('select');
      } else {
        toast.error('资源搜索失败: ' + data.error);
      }
    } catch (error) {
      toast.error('资源搜索失败: ' + (error as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) {
      toast.warning('剧名不能为空');
      return;
    }
    if (!settings.sourcePreferences.some(item => item.enabled)) {
      toast.warning('请至少启用一个资源来源');
      return;
    }
    if (form.manualSelect) {
      await handleSearch();
      return;
    }
    await createTask();
  };

  const handleConfirmSelection = async () => {
    const picked = candidates[selectedCandidateIndex];
    if (!picked || (!picked.shareLink && !picked.slug)) {
      toast.warning('请选择一个资源');
      return;
    }
    setLoading(true);
    try {
      const response = await fetchAutoSeries('/api/auto-series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          year: form.year,
          source: picked.source,
          shareLink: picked.shareLink,
          resourceSlug: picked.slug,
          resourceTitle: picked.title
        })
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || '创建失败');
      const intentId = String(data.data?.intentId || '');
      if (!intentId) throw new Error('Intent 编号缺失');
      const submittedTitle = form.title.trim();
      const submittedSource = picked.source;
      resetModal();
      toast.info(`已提交“${submittedTitle}”，正在后台创建，不影响继续操作`, { duration: 5000 });
      void waitForAutoSeriesIntent(intentId).then((intent) => {
        void fetchData();
        if (intent.status === 'failed') {
          toast.error(`自动追剧失败：${intent.title} - ${intent.lastError || '未知错误'}`, { duration: 8000 });
          return;
        }
        if (intent.status === 'no_coverage') {
          toast.info(`${intent.title} 暂无覆盖资源，系统将在每日 03:15 重试`);
          return;
        }
        toast.success(`已从${SOURCE_LABELS[submittedSource]}激活追剧：${intent.title}`);
      }).catch((error) => {
        toast.warning((error as Error).message, { duration: 7000 });
      });
    } catch (error) {
      toast.error('自动追剧失败: ' + (error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const openIntentManager = (intent: AutoSeriesIntent) => {
    setManagingIntent(intent);
    setDeleteOptions({ deleteTasks: false, deleteCloud: false, deletePtSubscriptions: false });
  };

  const closeIntentManager = () => {
    if (deletingIntent) return;
    setManagingIntent(null);
  };

  const handleIntentStatusToggle = async (intent: AutoSeriesIntent) => {
    try {
      const action = intent.status === 'paused' ? 'resume' : 'pause';
      const response = await fetch(`/api/auto-series/intents/${intent.id}/${action}`, { method: 'POST' });
      const data = await readJsonResponse(response, action === 'resume' ? '恢复失败' : '暂停失败');
      if (managingIntent?.id === intent.id) setManagingIntent(data.data);
      await fetchData();
      toast.success(action === 'resume' ? '追剧 Intent 已恢复' : '追剧 Intent 已暂停');
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const handleIntentRunNow = async (intent: AutoSeriesIntent) => {
    try {
      const response = await fetchAutoSeries(`/api/auto-series/intents/${intent.id}/run`, { method: 'POST' });
      const data = await readJsonResponse(response, '立即运行失败');
      await fetchData();
      toast.success(`已运行：${data.data?.status || intent.title}`);
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const handleDeleteIntent = async () => {
    if (!managingIntent || deletingIntent) return;
    const taskCount = parseIntentIds(managingIntent.taskIdsJson, managingIntent.taskId).length;
    const ptCount = parseIntentIds(managingIntent.ptSubscriptionIdsJson, managingIntent.ptSubscriptionId).length;
    const ok = await dialog.confirm({
      title: '删除追剧 Intent',
      message: deleteOptions.deleteTasks || deleteOptions.deletePtSubscriptions
        ? `确定删除「${managingIntent.title}」？将删除 ${deleteOptions.deleteTasks ? taskCount : 0} 个关联任务、${deleteOptions.deletePtSubscriptions ? ptCount : 0} 个 PT 订阅。${deleteOptions.deleteCloud ? '关联任务的网盘文件也会同步删除。' : ''}`
        : `确定只删除「${managingIntent.title}」的追剧 Intent？关联任务和 PT 订阅会保留并解除关联。`,
      confirmText: deleteOptions.deleteTasks || deleteOptions.deletePtSubscriptions || deleteOptions.deleteCloud ? '删除所选内容' : '删除 Intent',
      tone: 'danger'
    });
    if (!ok) return;
    setDeletingIntent(true);
    try {
      const response = await fetch(`/api/auto-series/intents/${managingIntent.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deleteOptions)
      });
      const data = await readJsonResponse(response, '删除失败');
      setManagingIntent(null);
      await fetchData();
      const deletedTasks = data.data?.deletedTaskIds?.length || 0;
      const deletedPt = data.data?.deletedPtSubscriptionIds?.length || 0;
      toast.success(deletedTasks || deletedPt ? `已删除 Intent，关联任务 ${deletedTasks} 个、PT 订阅 ${deletedPt} 个` : '追剧 Intent 已删除');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setDeletingIntent(false);
    }
  };

  const getAccountName = (id: string) => {
    const account = accounts.find(a => String(a.id) === id);
    return account ? (account.alias || account.username) : id;
  };

  const isConfigured = Boolean(settings.accountId && settings.targetFolderId);

  return (
    <div className="space-y-8">
      {/* Configuration Status Card */}
      <div className={`p-6 rounded-3xl border ${isConfigured ? 'bg-white border-slate-200/60' : 'bg-red-50 border-red-100'} shadow-sm`}>
        <div className="flex items-start gap-4">
          <div className={`p-3 rounded-2xl ${isConfigured ? 'bg-[#d3e3fd] text-[#0b57d0]' : 'bg-red-100 text-red-600'}`}>
            {isConfigured ? <CheckCircle2 size={24} /> : <AlertCircle size={24} />}
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-bold text-slate-900">自动追剧配置状态</h3>
            {isConfigured ? (
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div className="space-y-1">
                  <p className="text-slate-500 font-medium uppercase tracking-wider text-[10px]">默认账号</p>
                  <p className="text-slate-900 font-medium">{getAccountName(settings.accountId)}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-slate-500 font-medium uppercase tracking-wider text-[10px]">默认保存目录</p>
                  <p className="text-slate-900 font-medium truncate" title={settings.targetFolder}>{settings.targetFolder}</p>
                </div>
              </div>
            ) : (
              <p className="text-red-600 text-sm mt-1">
                请先打开本页「追剧设置」，配置默认账号和默认保存目录。
              </p>
            )}
          </div>
          <button
            onClick={fetchData}
            className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-500"
          >
            <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <button
          onClick={() => setIsModalOpen(true)}
          disabled={!isConfigured}
          className="bg-[#0b57d0] text-white px-8 py-3 rounded-full text-sm font-medium hover:bg-[#0b57d0]/90 transition-all shadow-lg hover:shadow-xl flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus size={20} /> 添加追剧
        </button>
        <button
          type="button"
          onClick={() => setIsSettingsOpen(true)}
          className="bg-white border border-slate-300 text-slate-700 px-6 py-3 rounded-full text-sm font-medium hover:bg-slate-50 transition-all flex items-center justify-center gap-2"
        >
          <Settings size={19} /> 追剧设置
        </button>
        <button type="button" onClick={() => onNavigateHistory({ module: 'auto_series' })} className="bg-white border border-slate-300 text-slate-700 px-4 py-3 rounded-full text-sm hover:bg-slate-50 flex items-center justify-center gap-2" title="查看自动追剧历史"><History size={18} /> 历史</button>
        <p className="text-sm text-slate-500 flex items-center gap-2">
          <AlertCircle size={16} className="shrink-0 text-slate-400" />
          本页可管理追剧 Intent；普通转存任务和 PT 下载详情仍可到对应页面查看。
        </p>
      </div>

      {intents.length > 0 && (
        <div className="bg-white rounded-3xl border border-slate-200/60 p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div><h3 className="font-bold text-slate-900">Intent 与元数据审计</h3><p className="text-xs text-slate-500 mt-1">Agent 自动检查并应用差异，不产生人工确认状态。</p></div>
          </div>
          <div className="space-y-3">
            {intents.slice(0, 12).map(intent => {
              const audit = metadataAudits[intent.id]?.[0];
              const coverage = parseIntentCoverage(intent.coverageJson);
              return <div key={intent.id} className="rounded-2xl border border-slate-100 px-4 py-3 flex flex-col md:flex-row md:items-center gap-3">
                <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="font-medium text-sm text-slate-900 truncate">{intent.title}</span><span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{intent.status}</span>{intent.agentEnabled && <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">Agent</span>}</div><p className="text-xs text-slate-500 mt-1">覆盖 {coverage?.coveredEpisodes ?? 0}/{coverage?.expectedEpisodes ?? '?'} · 任务 {intent.taskIdsJson || '[]'}</p></div>
                <div className="md:text-right text-xs">
                  {audit ? <><p className={audit.status === 'completed' ? 'text-emerald-700' : 'text-rose-600'}>{audit.summary || '元数据审计完成'}</p><p className="text-slate-400 mt-1">{audit.updatedAt ? new Date(audit.updatedAt).toLocaleString('zh-CN', { hour12: false }) : ''}</p></> : <p className="text-slate-400">暂无 release 元数据审计</p>}
                </div>
              </div>;
            })}
          </div>
        </div>
      )}

      <div className="bg-white rounded-3xl border border-slate-200/60 p-8 shadow-sm">
        <div className="flex items-start gap-5">
          <div className="w-14 h-14 rounded-2xl bg-[#d3e3fd] flex items-center justify-center text-[#0b57d0] shrink-0">
            <PlayCircle size={28} />
          </div>
          <div className="min-w-0 space-y-2">
            <h3 className="font-bold text-slate-900 text-lg">如何自动追剧</h3>
            <ol className="text-sm text-slate-600 space-y-1.5 list-decimal list-inside leading-relaxed">
              <li>点击「追剧设置」，一次配置账号、目录、模式和选源策略</li>
              <li>点击「添加追剧」，只需填写剧名，必要时手动选择资源</li>
              <li>确认后会创建转存任务，后续追更在「任务」页查看</li>
            </ol>
          </div>
        </div>
      </div>

      <Modal
        isOpen={isModalOpen}
        onClose={resetModal}
        title={step === 'select' ? '选择资源' : '添加自动追剧'}
        footer={null}
      >
        {step === 'form' ? (
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">剧集名称</label>
              <input
                type="text"
                value={form.title}
                onChange={e => setForm({ ...form, title: e.target.value })}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder="例如: 庆余年 第二季"
                required
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">年份 (可选)</label>
              <input
                type="text"
                value={form.year}
                onChange={e => setForm({ ...form, year: e.target.value })}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder="2024"
              />
            </div>

            {/* 手动选择资源开关 —— 默认关闭 */}
            <div className="px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl hover:bg-slate-100/70 transition-colors">
              <Checkbox
                align="start"
                checked={form.manualSelect}
                onChange={(v) => setForm({ ...form, manualSelect: v })}
                label={<span className="text-sm font-medium text-slate-800">手动选择资源</span>}
                description="开启后将先展示候选资源列表，由你确认后再创建任务；关闭则自动挑选最匹配的资源。"
              />
            </div>

            <div className="bg-[#f8fafd] p-4 rounded-2xl border border-slate-100">
              <p className="text-xs text-slate-500 leading-relaxed">
                <span className="font-bold text-[#0b57d0]">当前设置：</span>
                {settings.mode === 'lazy' ? '懒转存' : '自动转存'} · {settings.agentEnabled ? `Agent ${settings.toolCallMode}` : '确定性选源'} · {settings.sourcePreferences.filter(item => item.enabled).map(item => SOURCE_LABELS[item.source]).join(' → ')}。可在弹窗外的「追剧设置」中修改。
              </p>
            </div>

            <div className="flex gap-4 pt-4">
              <button
                type="button"
                onClick={resetModal}
                className="flex-1 px-6 py-3 border border-slate-300 text-slate-700 rounded-full font-medium hover:bg-slate-50 transition-all"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={loading || searching}
                className="flex-1 px-6 py-3 bg-[#0b57d0] text-white rounded-full font-medium hover:bg-[#0b57d0]/90 transition-all shadow-md flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {(loading || searching) && <RefreshCw size={18} className="animate-spin" />}
                {searching
                  ? '正在搜索网盘资源…'
                  : loading
                    ? '正在创建追剧…'
                    : form.manualSelect
                      ? '搜索网盘资源'
                      : '按顺序开始追剧'}
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-5">
            <div className="text-xs text-slate-500">
              共找到 <span className="font-semibold text-slate-800">{candidates.length}</span> 条候选资源，默认选中匹配度最高的一项。
            </div>
            <div className="max-h-[360px] overflow-y-auto space-y-2 pr-1">
              {candidates.map((item, index) => {
                const active = index === selectedCandidateIndex;
                return (
                  <button
                    key={item.shareLink || item.slug || index}
                    type="button"
                    onClick={() => {
                      setSelectedCandidateIndex(index);
                    }}
                    className={`w-full text-left p-4 rounded-2xl border transition-all flex items-start gap-3 ${
                      active
                        ? 'border-[#0b57d0] bg-[#eef4fe] shadow-sm'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <div
                      className={`mt-0.5 w-5 h-5 rounded-full border flex items-center justify-center shrink-0 ${
                        active ? 'border-[#0b57d0] bg-[#0b57d0] text-white' : 'border-slate-300'
                      }`}
                    >
                      {active && <Check size={12} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900 line-clamp-2 leading-snug">{item.title}</div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                        <span className="px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded-md">{SOURCE_LABELS[item.source]}</span>
                        {typeof item.score === 'number' && (
                          <span className="px-1.5 py-0.5 bg-slate-100 rounded-md">匹配度 {item.score}</span>
                        )}
                        {item.quality && <span>{item.quality}</span>}
                        {item.sizeFormatted && <span>{item.sizeFormatted}</span>}
                        {item.source === 'hdhive' && (
                          <span>{item.isUnlocked ? '已解锁' : item.isFree ? '免费可解锁' : `需 ${item.points} 积分`}</span>
                        )}
                        <span className="truncate" title={item.shareLink}>{item.shareLink || '创建时解锁'}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setStep('form')}
                className="px-5 py-3 border border-slate-300 text-slate-700 rounded-full font-medium hover:bg-slate-50 transition-all flex items-center gap-2"
              >
                <ArrowLeft size={16} /> 返回
              </button>
              <button
                type="button"
                onClick={resetModal}
                className="px-5 py-3 border border-slate-300 text-slate-700 rounded-full font-medium hover:bg-slate-50 transition-all"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleConfirmSelection}
                disabled={loading || !candidates[selectedCandidateIndex]}
                className="flex-1 px-6 py-3 bg-[#0b57d0] text-white rounded-full font-medium hover:bg-[#0b57d0]/90 transition-all shadow-md flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {loading && <RefreshCw size={18} className="animate-spin" />}
                {loading ? '正在创建追剧…' : '使用该资源创建任务'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={isSettingsOpen}
        onClose={handleCloseSettings}
        title="自动追剧设置"
        footer={null}
      >
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">默认追剧账号</label>
              <select
              value={settings.accountId}
              onChange={event => setSettings(current => ({
                ...current,
                accountId: event.target.value,
                ...(event.target.value === current.accountId ? {} : { targetFolderId: '', targetFolder: '' })
              }))}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm"
              >
                <option value="">选择默认账号...</option>
                {accounts.map(account => (
                  <option key={account.id} value={account.id}>{account.alias ? `${account.username} (${account.alias})` : account.username}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">默认保存目录</label>
              <div className="flex gap-2">
                <input
                  value={settings.targetFolder || settings.targetFolderId}
                  readOnly
                  placeholder="请选择目录"
                  className="flex-1 min-w-0 px-5 py-3 bg-slate-100 border border-slate-300 rounded-2xl text-sm text-slate-500"
                />
                <button
                  type="button"
                  onClick={() => setIsFolderSelectorOpen(true)}
                  disabled={!settings.accountId}
                  className="px-4 py-3 bg-white border border-slate-300 rounded-2xl text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  title="选择目录"
                >
                  <Folder size={20} />
                </button>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">默认追剧模式</label>
            <select
              value={settings.mode}
              onChange={event => setSettings(current => ({ ...current, mode: event.target.value as AutoSeriesMode }))}
              className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm"
            >
              <option value="lazy">懒转存（生成 STRM，播放时转存）</option>
              <option value="normal">自动转存（保存到网盘）</option>
            </select>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-slate-700">资源来源与回退顺序</label>
              <span className="text-[11px] text-slate-400">拖拽或按钮排序，保存设置后生效</span>
            </div>
            <Reorder.Group axis="y" values={settings.sourcePreferences} onReorder={handleSourceReorder} className="space-y-2">
              {settings.sourcePreferences.map((item, index) => (
                <SourcePreferenceRow
                  key={item.source}
                  item={item}
                  index={index}
                  total={settings.sourcePreferences.length}
                  onMove={moveSourceBy}
                  onToggle={toggleSource}
                  onDragEnd={handleSourceDragEnd}
                />
              ))}
            </Reorder.Group>
            {!settings.sourcePreferences.some(item => item.enabled) && <p className="text-xs text-red-600">请至少启用一个来源。</p>}
          </div>

          <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-2xl space-y-3">
            <Checkbox
              align="start"
              checked={settings.allowHdhivePoints}
              onChange={value => setSettings(current => ({ ...current, allowHdhivePoints: value }))}
              label={<span className="text-sm font-medium text-slate-800">允许消耗影巢积分</span>}
              description="开启后可包含积分资源，解锁前仍会校验单个资源积分上限。"
            />
            {settings.allowHdhivePoints && (
              <div className="pl-8 space-y-1.5">
                <label className="text-xs font-medium text-slate-700">单个资源积分上限</label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={settings.hdhiveMaxPoints}
                  onChange={event => setSettings(current => ({ ...current, hdhiveMaxPoints: Number(event.target.value) }))}
                  className="w-full px-4 py-2.5 bg-white border border-amber-300 rounded-xl text-sm"
                />
              </div>
            )}
          </div>

          <div className="px-4 py-3 bg-blue-50 border border-blue-200 rounded-2xl space-y-3">
            <Checkbox
              align="start"
              checked={settings.agentEnabled}
              onChange={value => setSettings(current => ({ ...current, agentEnabled: value }))}
              label={<span className="text-sm font-medium text-slate-800">启用自主选源 Agent</span>}
              description="AI 不可用或动作非法时自动回退确定性选源。"
            />
            {settings.agentEnabled && (
              <div className="pl-8 space-y-3">
                <div>
                  <label className="text-xs font-medium text-slate-700">工具协议</label>
                  <select
                    value={settings.toolCallMode}
                    onChange={event => setSettings(current => ({ ...current, toolCallMode: event.target.value as ToolCallMode }))}
                    className="mt-1 w-full px-4 py-2.5 bg-white border border-blue-300 rounded-xl text-sm"
                  >
                    <option value="auto">自动（原生优先，失败切换 JSON）</option>
                    <option value="native">仅原生 Tool Calling</option>
                    <option value="json">仅 JSON 动作协议</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-700">偏好字幕组（逗号分隔）</label>
                  <input
                    value={settings.mediaPreference.preferredGroups.join(', ')}
                    onChange={event => setSettings(current => ({ ...current, mediaPreference: { ...current.mediaPreference, preferredGroups: event.target.value.split(',').map(item => item.trim()).filter(Boolean) } }))}
                    className="mt-1 w-full px-4 py-2.5 bg-white border border-blue-300 rounded-xl text-sm"
                    placeholder="例如: LoliHouse, ANi"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-700">排除关键词（逗号分隔）</label>
                  <input
                    value={settings.mediaPreference.blockedKeywords.join(', ')}
                    onChange={event => setSettings(current => ({ ...current, mediaPreference: { ...current.mediaPreference, blockedKeywords: event.target.value.split(',').map(item => item.trim()).filter(Boolean) } }))}
                    className="mt-1 w-full px-4 py-2.5 bg-white border border-blue-300 rounded-xl text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-700">补充画质要求</label>
                  <textarea
                    value={settings.mediaPreference.extraRequirement}
                    onChange={event => setSettings(current => ({ ...current, mediaPreference: { ...current.mediaPreference, extraRequirement: event.target.value } }))}
                    className="mt-1 w-full px-4 py-2.5 bg-white border border-blue-300 rounded-xl text-sm"
                    rows={2}
                    placeholder="例如: 优先简繁字幕，避免杜比视界 Profile 5"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl">
            <Checkbox
              align="start"
              checked={settings.keepCasAfterRestore}
              onChange={value => setSettings(current => ({ ...current, keepCasAfterRestore: value }))}
              label={<span className="text-sm font-medium text-slate-800">归档保留 CAS 存根</span>}
              description="开启后，恢复成功的 .cas 会移动到所选网盘目录下的 _cas 镜像路径。"
            />
          </div>

          <div className="flex gap-4 pt-2">
            <button type="button" onClick={handleCloseSettings} className="flex-1 px-6 py-3 border border-slate-300 text-slate-700 rounded-full font-medium hover:bg-slate-50">取消</button>
            <button type="button" onClick={handleSaveSettings} disabled={savingSettings} className="flex-1 px-6 py-3 bg-[#0b57d0] text-white rounded-full font-medium flex items-center justify-center gap-2 disabled:opacity-60">
              {savingSettings ? <RefreshCw size={18} className="animate-spin" /> : <Save size={18} />}
              {savingSettings ? '保存中…' : '保存设置'}
            </button>
          </div>
        </div>
      </Modal>

      <FolderSelector
        isOpen={isFolderSelectorOpen}
        onClose={() => setIsFolderSelectorOpen(false)}
        accountId={Number(settings.accountId)}
        accountName={getAccountName(settings.accountId)}
        title="选择自动追剧默认保存目录"
        onSelect={(folder: SelectedFolder) => setSettings(current => ({
          ...current,
          accountId: String(folder.accountId),
          targetFolderId: folder.id,
          targetFolder: folder.name
        }))}
      />

      {managingIntent && (
        <Modal
          isOpen={Boolean(managingIntent)}
          onClose={closeIntentManager}
          title="管理追剧 Intent"
          footer={null}
          maxWidthClass="max-w-xl"
        >
          {(() => {
            const taskIds = parseIntentIds(managingIntent.taskIdsJson, managingIntent.taskId);
            const ptSubscriptionIds = parseIntentIds(managingIntent.ptSubscriptionIdsJson, managingIntent.ptSubscriptionId);
            const coverage = parseIntentCoverage(managingIntent.coverageJson);
            return (
              <div className="space-y-5">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <div className="font-medium text-slate-900 truncate">{managingIntent.title}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {managingIntent.status} · {managingIntent.agentEnabled ? `AI ${managingIntent.toolCallMode}` : '确定性'} · 覆盖 {coverage?.coveredEpisodes ?? 0}/{coverage?.expectedEpisodes ?? '?'}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">关联任务 {taskIds.length} 个 · PT 订阅 {ptSubscriptionIds.length} 个</div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => handleIntentStatusToggle(managingIntent)}
                    className="px-4 py-3 rounded-2xl border border-slate-300 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    {managingIntent.status === 'paused' ? '恢复巡检' : '暂停巡检'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleIntentRunNow(managingIntent)}
                    disabled={managingIntent.status === 'paused'}
                    className="px-4 py-3 rounded-2xl bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    立即运行
                  </button>
                </div>

                <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-4 space-y-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-red-800">
                    <Trash2 size={16} /> 删除
                  </div>
                  <Checkbox
                    align="start"
                    checked={deleteOptions.deleteTasks}
                    onChange={value => setDeleteOptions(current => ({ ...current, deleteTasks: value, deleteCloud: value ? current.deleteCloud : false }))}
                    label={<span className="text-sm font-medium text-slate-800">删除关联普通任务（{taskIds.length}）</span>}
                    description="会复用任务页删除逻辑；不勾选时仅解除这些任务与 Intent 的关联。"
                  />
                  <div className={!deleteOptions.deleteTasks ? 'opacity-50 pointer-events-none' : ''}>
                    <Checkbox
                      align="start"
                      checked={deleteOptions.deleteCloud}
                      onChange={value => setDeleteOptions(current => ({ ...current, deleteCloud: value }))}
                      label={<span className="text-sm font-medium text-slate-800">同步删除任务对应网盘文件</span>}
                      description="仅对上方选择删除的普通任务生效；此操作不可恢复。"
                    />
                  </div>
                  <Checkbox
                    align="start"
                    checked={deleteOptions.deletePtSubscriptions}
                    onChange={value => setDeleteOptions(current => ({ ...current, deletePtSubscriptions: value }))}
                    label={<span className="text-sm font-medium text-slate-800">删除关联 PT 订阅（{ptSubscriptionIds.length}）</span>}
                    description="会一并清理该订阅下的 release 记录；不勾选时仅解除关联。"
                  />
                  <div className="flex gap-3 pt-2">
                    <button
                      type="button"
                      onClick={closeIntentManager}
                      disabled={deletingIntent}
                      className="flex-1 px-5 py-3 rounded-full border border-slate-300 text-sm text-slate-700 hover:bg-white disabled:opacity-60"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={handleDeleteIntent}
                      disabled={deletingIntent}
                      className="flex-1 px-5 py-3 rounded-full bg-red-600 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60 flex items-center justify-center gap-2"
                    >
                      {deletingIntent ? <RefreshCw size={16} className="animate-spin" /> : <Trash2 size={16} />}
                      {deletingIntent ? '删除中…' : '删除 Intent'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}
        </Modal>
      )}

      {intents.length > 0 && (
        <div className="bg-white rounded-3xl border border-slate-200/60 p-6 shadow-sm space-y-3">
          <h3 className="font-bold text-slate-900">追剧 Intent</h3>
          {intents.slice(0, 20).map(intent => (
            <div key={intent.id} className="flex items-center gap-3 rounded-2xl border border-slate-200 px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-900 truncate">{intent.title}</div>
                <div className="text-xs text-slate-500">{intent.status}{intent.agentEnabled ? ` · AI ${intent.toolCallMode}` : ' · 确定性'}{intent.degraded ? ' · 已降级' : ''}</div>
                {(() => {
                  const coverage = parseIntentCoverage(intent.coverageJson);
                  if (!coverage?.expectedEpisodes) return null;
                  const tasks = (() => { try { return JSON.parse(intent.taskIdsJson || '[]').length; } catch { return intent.taskId ? 1 : 0; } })();
                  return <div className="text-xs text-blue-600">覆盖 {coverage.coveredEpisodes || 0}/{coverage.expectedEpisodes} 集 · {tasks} 个来源任务</div>;
                })()}
                {intent.lastError && <div className="text-xs text-red-600 truncate" title={intent.lastError}>{intent.lastError}</div>}
              </div>
              <button type="button" onClick={() => handleIntentStatusToggle(intent)} className="px-3 py-1.5 rounded-full border border-slate-300 text-xs">
                {intent.status === 'paused' ? '恢复' : '暂停'}
              </button>
              <button type="button" onClick={() => onNavigateHistory({ subjectType: 'auto_series_intent', subjectId: intent.id })} className="p-2 rounded-full border border-slate-300 text-slate-500 hover:bg-slate-50" title="查看历史" aria-label={`查看${intent.title}历史`}><History size={15} /></button>
              <button type="button" onClick={() => handleIntentRunNow(intent)} className="px-3 py-1.5 rounded-full bg-blue-600 text-white text-xs">立即运行</button>
              <button type="button" onClick={() => openIntentManager(intent)} className="p-2 rounded-full border border-slate-300 text-slate-500 hover:bg-slate-50" title="管理 Intent" aria-label={`管理${intent.title}`}>
                <Settings size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default AutoSeriesTab;
