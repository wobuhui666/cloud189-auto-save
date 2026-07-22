import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Zap,
  Download,
  Search,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Settings,
  Upload,
  FolderArchive,
  List,
  Trash2,
  RotateCcw,
  FolderOpen,
  Folder,
  File,
  FileArchive,
  X
} from 'lucide-react';
import FolderSelector, { SelectedFolder } from '../FolderSelector';
import type { TabType } from '../../App';
import { useDialog } from '../ui/Dialog';
import { useToast } from '../ui/Toast';

interface Account {
  id: number;
  username: string;
  alias: string;
  accountType: string;
}

interface CasConfig {
  enableAutoRestore: boolean;
  deleteCasAfterRestore: boolean;
  deleteSourceAfterGenerate: boolean;
  enableFamilyTransit: boolean;
  familyTransitFirst: boolean;
}

interface ImportJobSummary {
  id: string;
  title: string;
  sourceName: string;
  sourceType: string;
  accountId: number;
  folderId: string;
  folderName?: string;
  mode: 'restore' | 'lazy' | string;
  strmMode: 'none' | 'normal' | 'lazy' | string;
  uploadCasStub?: boolean;
  status: string;
  total: number;
  success: number;
  failed: number;
  skipped: number;
  strmRoot?: string;
  message?: string;
  createdAt?: string;
  updatedAt?: string;
  finishedAt?: string | null;
}

interface ImportJobDetail extends ImportJobSummary {
  entries?: Array<{
    relativePath: string;
    restoreName: string;
    status: string;
    error?: string;
  }>;
}

interface ShareMetadataItem {
  accountId: string;
  shareId: string;
  fileCount: number;
  updatedAt?: string;
}

interface StrmListItem {
  id: string;
  name: string;
  path: string;
  type: 'directory' | 'file' | string;
}

interface CasTabProps {
  onShowToast?: (message: string, type: 'success' | 'error' | 'info') => void;
  onNavigate?: (tab: TabType) => void;
}

const statusLabel = (status: string) => {
  switch (status) {
    case 'pending': return '排队中';
    case 'running': return '执行中';
    case 'completed': return '已完成';
    case 'partial': return '部分成功';
    case 'failed': return '失败';
    default: return status || '-';
  }
};

const statusClass = (status: string) => {
  switch (status) {
    case 'completed': return 'bg-emerald-50 text-emerald-700 border-emerald-100';
    case 'partial': return 'bg-amber-50 text-amber-700 border-amber-100';
    case 'failed': return 'bg-rose-50 text-rose-700 border-rose-100';
    case 'running': return 'bg-blue-50 text-blue-700 border-blue-100';
    default: return 'bg-slate-50 text-slate-600 border-slate-200';
  }
};

const CasTab: React.FC<CasTabProps> = ({ onShowToast, onNavigate }) => {
  const dialog = useDialog();
  const toast = useToast();
  const notify = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    if (onShowToast) {
      onShowToast(message, type);
      return;
    }
    if (type === 'success') toast.success(message);
    else if (type === 'error') toast.error(message);
    else toast.info(message);
  };
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [config, setConfig] = useState<CasConfig>({
    enableAutoRestore: false,
    deleteCasAfterRestore: true,
    deleteSourceAfterGenerate: false,
    enableFamilyTransit: true,
    familyTransitFirst: false
  });

  // paste restore
  const [casContent, setCasContent] = useState('');
  const [restoreName, setRestoreName] = useState('');
  const [targetFolder, setTargetFolder] = useState<SelectedFolder | null>(null);
  const [isFolderSelectorOpen, setIsFolderSelectorOpen] = useState(false);
  const [folderSelectorMode, setFolderSelectorMode] = useState<'restore' | 'import'>('restore');
  const [isRestoring, setIsRestoring] = useState(false);

  // import
  const [importFolder, setImportFolder] = useState<SelectedFolder | null>(null);
  const [importMode, setImportMode] = useState<'restore' | 'lazy'>('restore');
  const [importStrmMode, setImportStrmMode] = useState<'none' | 'normal' | 'lazy'>('normal');
  const [organizeMode, setOrganizeMode] = useState<'library' | 'mirror'>('library');
  const [uploadCasStub, setUploadCasStub] = useState(false);
  const [overwriteStrm, setOverwriteStrm] = useState(false);
  const [importTitle, setImportTitle] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [retryingJobIds, setRetryingJobIds] = useState<string[]>([]);
  const [jobs, setJobs] = useState<ImportJobSummary[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<ImportJobDetail | null>(null);
  const [jobsLoading, setJobsLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // management
  const [shareCaches, setShareCaches] = useState<ShareMetadataItem[]>([]);
  const [strmPath, setStrmPath] = useState('');
  const [strmItems, setStrmItems] = useState<StrmListItem[]>([]);
  const [mgmtLoading, setMgmtLoading] = useState(false);

  useEffect(() => {
    fetchAccounts();
    fetchConfig();
    fetchJobs();
    fetchShareCaches();
    fetchStrmList('');
  }, []);

  // mode linkage defaults
  useEffect(() => {
    if (importMode === 'lazy') {
      setImportStrmMode((prev) => (prev === 'normal' ? 'lazy' : prev));
    } else {
      setImportStrmMode((prev) => (prev === 'lazy' ? 'normal' : prev));
    }
  }, [importMode]);

  // poll running jobs
  useEffect(() => {
    const hasRunning = jobs.some((job) => job.status === 'running' || job.status === 'pending');
    if (!hasRunning && !activeJobId) return;
    const timer = setInterval(() => {
      fetchJobs();
      if (activeJobId) {
        fetchJobDetail(activeJobId);
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [jobs, activeJobId]);

  const selectedAccountLabel = useMemo(() => {
    const acc = accounts.find((a) => a.id === selectedAccountId);
    return acc ? (acc.alias || acc.username) : '';
  }, [accounts, selectedAccountId]);

  const fetchAccounts = async () => {
    try {
      const res = await fetch('/api/accounts');
      const data = await res.json();
      if (data.success) {
        setAccounts(data.data || []);
        if ((data.data || []).length > 0) {
          setSelectedAccountId(data.data[0].id);
        }
      }
    } catch (e) {
      console.error('获取账号列表失败:', e);
    }
  };

  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/cas/auto-restart-config');
      const data = await res.json();
      if (data.success) {
        setConfig(data.data);
      }
    } catch (e) {
      console.error('获取CAS配置失败:', e);
    }
  };

  const fetchJobs = async () => {
    setJobsLoading(true);
    try {
      const res = await fetch('/api/cas/import/jobs');
      const data = await res.json();
      if (data.success) {
        setJobs(data.data || []);
      }
    } catch (e) {
      console.error('获取导入任务失败:', e);
    } finally {
      setJobsLoading(false);
    }
  };

  const fetchJobDetail = async (jobId: string) => {
    try {
      const res = await fetch(`/api/cas/import/jobs/${encodeURIComponent(jobId)}`);
      const data = await res.json();
      if (data.success) {
        setActiveJob(data.data);
      }
    } catch (e) {
      console.error('获取任务详情失败:', e);
    }
  };

  const fetchShareCaches = async () => {
    try {
      const res = await fetch('/api/cas/metadata/share');
      const data = await res.json();
      if (data.success) {
        setShareCaches(data.data || []);
      }
    } catch (e) {
      console.error('获取分享缓存失败:', e);
    }
  };

  const fetchStrmList = async (pathValue: string) => {
    setMgmtLoading(true);
    try {
      const res = await fetch(`/api/cas/import/strm?path=${encodeURIComponent(pathValue || '')}`);
      const data = await res.json();
      if (data.success) {
        setStrmPath(data.data?.path || pathValue || '');
        // 根路径时优先展示 CAS导入 子树提示
        const items = data.data?.items || [];
        const casImportItems = data.data?.casImportItems || [];
        setStrmItems(pathValue ? items : (casImportItems.length ? casImportItems : items));
      }
    } catch (e) {
      console.error('获取 STRM 列表失败:', e);
    } finally {
      setMgmtLoading(false);
    }
  };

  const handleRestore = async () => {
    if (isRestoring) return;
    if (!selectedAccountId || !casContent || !targetFolder) {
      notify('请选择账号、填写存根内容并选择目标目录', 'error');
      return;
    }

    setIsRestoring(true);
    try {
      const res = await fetch('/api/cas/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: selectedAccountId,
          folderId: targetFolder.id,
          casContent: casContent.trim(),
          fileName: restoreName.trim() || undefined
        })
      });
      const data = await res.json();
      if (data.success) {
        notify(`秒传恢复成功: ${data.data.name}`, 'success');
        setCasContent('');
        setRestoreName('');
        setTargetFolder(null);
      } else {
        notify('恢复失败: ' + (data.error || '未知错误'), 'error');
      }
    } catch (e) {
      notify('操作过程中发生错误', 'error');
    } finally {
      setIsRestoring(false);
    }
  };

  const handleImport = async () => {
    if (isImporting) return;
    if (!selectedAccountId || !importFolder || !selectedFile) {
      notify('请选择账号、目标目录并选择 .cas/.zip/.rar 文件', 'error');
      return;
    }

    setIsImporting(true);
    try {
      const form = new FormData();
      form.append('file', selectedFile);
      form.append('accountId', String(selectedAccountId));
      form.append('folderId', importFolder.id);
      form.append('folderName', importFolder.name || '');
      form.append('mode', importMode);
      form.append('strmMode', importStrmMode);
      form.append('organizeMode', organizeMode);
      form.append('uploadCasStub', uploadCasStub ? '1' : '0');
      form.append('overwriteStrm', overwriteStrm ? '1' : '0');
      if (importTitle.trim()) {
        form.append('title', importTitle.trim());
      }

      const res = await fetch('/api/cas/import', {
        method: 'POST',
        body: form
      });
      const data = await res.json();
      if (data.success) {
        notify(`导入任务已创建: ${data.data.title}`, 'success');
        setSelectedFile(null);
        setImportTitle('');
        if (fileInputRef.current) fileInputRef.current.value = '';
        setActiveJobId(data.data.id);
        await fetchJobs();
        await fetchJobDetail(data.data.id);
      } else {
        notify('导入失败: ' + (data.error || '未知错误'), 'error');
      }
    } catch (e) {
      notify('上传过程中发生错误', 'error');
    } finally {
      setIsImporting(false);
    }
  };

  const handleRetryJob = async (jobId: string) => {
    if (retryingJobIds.includes(jobId)) return;
    setRetryingJobIds((ids) => [...ids, jobId]);
    try {
      const res = await fetch(`/api/cas/import/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        notify('已开始重试失败项', 'success');
        setActiveJobId(jobId);
        fetchJobs();
        fetchJobDetail(jobId);
      } else {
        notify(data.error || '重试失败', 'error');
      }
    } catch (e) {
      notify('重试失败', 'error');
    } finally {
      setRetryingJobIds((ids) => ids.filter((id) => id !== jobId));
    }
  };

  const handleDeleteJob = async (job: ImportJobSummary) => {
    const ok = await dialog.confirm({
      title: '删除导入任务',
      message: job.strmRoot
        ? `确认删除导入任务「${job.title}」？\n若该任务生成过 STRM，下一步可选择是否一并删除。`
        : `确认删除导入任务「${job.title}」？`,
      confirmText: '删除',
      tone: 'danger',
    });
    if (!ok) return;

    let alsoDeleteStrm = false;
    if (job.strmRoot) {
      alsoDeleteStrm = await dialog.confirm({
        title: '同时删除 STRM？',
        message: '是否同时删除该任务生成的 STRM 目录？',
        confirmText: '一并删除',
        cancelText: '仅删任务',
        tone: 'warning',
      });
    }

    try {
      const res = await fetch(
        `/api/cas/import/jobs/${encodeURIComponent(job.id)}?deleteStrm=${alsoDeleteStrm ? '1' : '0'}`,
        { method: 'DELETE' }
      );
      const data = await res.json();
      if (data.success) {
        notify('任务已删除', 'success');
        if (activeJobId === job.id) {
          setActiveJobId(null);
          setActiveJob(null);
        }
        fetchJobs();
        fetchStrmList(strmPath);
      } else {
        notify(data.error || '删除失败', 'error');
      }
    } catch (e) {
      notify('删除失败', 'error');
    }
  };

  const handleClearShareCache = async (item?: ShareMetadataItem, all = false) => {
    try {
      const res = await fetch('/api/cas/metadata/share', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(all ? { all: true } : {
          accountId: item?.accountId,
          shareId: item?.shareId
        })
      });
      const data = await res.json();
      if (data.success) {
        notify(all ? '已清理全部分享缓存' : '已清理缓存', 'success');
        fetchShareCaches();
      } else {
        notify(data.error || '清理失败', 'error');
      }
    } catch (e) {
      notify('清理失败', 'error');
    }
  };

  const handleDeleteStrm = async (item: StrmListItem) => {
    if (item.type !== 'directory') {
      notify('当前仅支持删除目录', 'info');
      return;
    }
    const ok = await dialog.confirm({
      title: '删除 STRM 目录',
      message: `确认删除 STRM 目录：${item.path}？`,
      confirmText: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const res = await fetch('/api/cas/import/strm', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: item.path })
      });
      const data = await res.json();
      if (data.success) {
        notify('STRM 目录已删除', 'success');
        fetchStrmList(strmPath);
      } else {
        notify(data.error || '删除失败', 'error');
      }
    } catch (e) {
      notify('删除失败', 'error');
    }
  };

  const openFolderSelector = (mode: 'restore' | 'import') => {
    if (!selectedAccountId) {
      notify('请先选择账号', 'error');
      return;
    }
    setFolderSelectorMode(mode);
    setIsFolderSelectorOpen(true);
  };

  const failedEntries = (activeJob?.entries || []).filter((e) => e.status === 'failed').slice(0, 20);

  return (
    <div className="space-y-6">
      {/* 标题栏 */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold text-slate-900">CAS 秒传</h2>
          <button
            onClick={() => onNavigate?.('media')}
            className="p-2 bg-white border border-slate-300 rounded-full hover:bg-slate-50 transition-all text-slate-600 shadow-sm"
            title="在媒体设置中配置"
          >
            <Settings size={18} />
          </button>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            {config.enableFamilyTransit ? (
              <span className="flex items-center gap-1 text-emerald-600">
                <CheckCircle2 size={14} /> 家庭中转已启用
              </span>
            ) : (
              <span className="flex items-center gap-1 text-slate-400">
                <AlertCircle size={14} /> 家庭中转已禁用
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* 粘贴恢复 */}
        <div className="bg-white rounded-3xl border border-slate-200/60 overflow-hidden shadow-sm">
          <div className="p-6 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <Download className="text-blue-500" size={20} />
              <h3 className="font-bold text-slate-900">秒传恢复</h3>
            </div>
            <p className="text-sm text-slate-500 mt-1">粘贴单个 .cas 存根内容，立即恢复到网盘</p>
          </div>

          <div className="p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">执行账号</label>
              <select
                value={selectedAccountId || ''}
                onChange={(e) => setSelectedAccountId(Number(e.target.value))}
                className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              >
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>{acc.alias || acc.username}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">存根内容 (Base64 或 JSON)</label>
              <textarea
                value={casContent}
                onChange={(e) => setCasContent(e.target.value)}
                placeholder="粘贴 .cas 文件内容..."
                className="w-full px-4 py-3 bg-white border border-slate-300 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 min-h-[120px] font-mono text-xs"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">自定义文件名 (可选)</label>
              <input
                type="text"
                value={restoreName}
                onChange={(e) => setRestoreName(e.target.value)}
                placeholder="不填则使用存根内的文件名"
                className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">存入目录</label>
              <button
                onClick={() => openFolderSelector('restore')}
                className="w-full flex items-center justify-between px-4 py-2.5 bg-white border border-slate-300 rounded-xl text-sm hover:border-[#0b57d0] transition-all"
              >
                <span className={targetFolder ? 'text-slate-900' : 'text-slate-400'}>
                  {targetFolder ? targetFolder.name : '点击选择目标目录'}
                </span>
                <Search size={16} className="text-slate-400" />
              </button>
            </div>

            <button
              onClick={handleRestore}
              disabled={isRestoring || !casContent || !targetFolder}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-[#0b57d0] text-white rounded-xl font-bold text-sm hover:bg-[#0948ad] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isRestoring ? <RefreshCw size={18} className="animate-spin" /> : <Zap size={18} />}
              立即恢复
            </button>
          </div>
        </div>

        {/* 存根导入 */}
        <div className="bg-white rounded-3xl border border-slate-200/60 overflow-hidden shadow-sm">
          <div className="p-6 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <Upload className="text-violet-500" size={20} />
              <h3 className="font-bold text-slate-900">存根导入</h3>
            </div>
            <p className="text-sm text-slate-500 mt-1">上传 .cas / zip / rar 包（含 .cas 目录树），批量秒传并生成 STRM</p>
          </div>

          <div className="p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">选择文件</label>
              {/* 不限制 accept：部分浏览器对未知 MIME 的 .cas 会整项灰掉，无法点选 */}
              <input
                ref={fileInputRef}
                type="file"
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  if (!file) {
                    setSelectedFile(null);
                    return;
                  }
                  const lower = file.name.toLowerCase();
                  if (!(lower.endsWith('.cas') || lower.endsWith('.zip') || lower.endsWith('.rar'))) {
                    notify('仅支持 .cas / .zip / .rar 文件', 'error');
                    e.target.value = '';
                    setSelectedFile(null);
                    return;
                  }
                  setSelectedFile(file);
                }}
                className="hidden"
              />
              {!selectedFile ? (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 hover:border-[#0b57d0] hover:bg-[#0b57d0]/5 transition-all text-left"
                >
                  <div className="w-10 h-10 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-slate-500 shrink-0">
                    <Upload size={18} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-800">点击选择 .cas / .zip / .rar</div>
                    <div className="text-xs text-slate-500 mt-0.5">支持单个存根或含 .cas 的压缩包</div>
                  </div>
                </button>
              ) : (
                <div className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-slate-200 bg-white">
                  <div className="w-10 h-10 rounded-xl bg-[#d3e3fd] text-[#0b57d0] flex items-center justify-center shrink-0">
                    {selectedFile.name.toLowerCase().endsWith('.zip') || selectedFile.name.toLowerCase().endsWith('.rar') ? (
                      <FileArchive size={18} />
                    ) : (
                      <File size={18} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-900 truncate" title={selectedFile.name}>
                      {selectedFile.name}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {(selectedFile.size / 1024).toFixed(1)} KB
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 shrink-0"
                  >
                    更换
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedFile(null);
                      if (fileInputRef.current) {
                        fileInputRef.current.value = '';
                      }
                    }}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 shrink-0"
                    aria-label="清除已选文件"
                  >
                    <X size={16} />
                  </button>
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">任务标题（可选）</label>
              <input
                type="text"
                value={importTitle}
                onChange={(e) => setImportTitle(e.target.value)}
                placeholder="默认使用 zip 名 / 作品名"
                className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">存入目录</label>
              <button
                onClick={() => openFolderSelector('import')}
                className="w-full flex items-center justify-between px-4 py-2.5 bg-white border border-slate-300 rounded-xl text-sm hover:border-[#0b57d0] transition-all"
              >
                <span className={importFolder ? 'text-slate-900' : 'text-slate-400'}>
                  {importFolder ? importFolder.name : '点击选择目标目录'}
                </span>
                <FolderOpen size={16} className="text-slate-400" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">还原模式</label>
                <select
                  value={importMode}
                  onChange={(e) => setImportMode(e.target.value as 'restore' | 'lazy')}
                  className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                >
                  <option value="restore">立即秒传还原</option>
                  <option value="lazy">懒还原（播放时再秒传）</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">目录整理</label>
                <select
                  value={organizeMode}
                  onChange={(e) => setOrganizeMode(e.target.value as 'library' | 'mirror')}
                  className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                >
                  <option value="library">媒体库归档</option>
                  <option value="mirror">镜像 zip 目录</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">STRM</label>
                <select
                  value={importStrmMode}
                  onChange={(e) => setImportStrmMode(e.target.value as 'none' | 'normal' | 'lazy')}
                  className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                >
                  <option value="none">不生成</option>
                  <option value="normal">正常 STRM</option>
                  <option value="lazy">懒 STRM</option>
                </select>
              </div>
            </div>

            <div className="flex flex-col gap-2 text-sm text-slate-600">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={uploadCasStub} onChange={(e) => setUploadCasStub(e.target.checked)} />
                同时把 .cas 存根上传到网盘同目录
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={overwriteStrm} onChange={(e) => setOverwriteStrm(e.target.checked)} />
                覆盖已存在的 STRM
              </label>
            </div>

            <div className="rounded-2xl bg-slate-50 border border-slate-100 px-4 py-3 text-xs text-slate-500 space-y-1">
              <p>账号：{selectedAccountLabel || '未选择'}</p>
              <p>
                {organizeMode === 'library'
                  ? '媒体库归档：STRM/网盘落到 {分类}/{作品名 (年)}/Season XX/...'
                  : '镜像模式：按 zip 内相对路径写入，并加 CAS导入/ 前缀。'}
              </p>
              <p>懒模式不会立刻占网盘实体空间，播放时再秒传恢复。</p>
            </div>

            <button
              onClick={handleImport}
              disabled={isImporting || !selectedFile || !importFolder || !selectedAccountId}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-violet-600 text-white rounded-xl font-bold text-sm hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isImporting ? <RefreshCw size={18} className="animate-spin" /> : <FolderArchive size={18} />}
              开始导入
            </button>
          </div>
        </div>
      </div>

      {/* 导入任务 */}
      <div className="bg-white rounded-3xl border border-slate-200/60 overflow-hidden shadow-sm">
        <div className="p-6 border-b border-slate-100 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <List className="text-slate-700" size={20} />
            <h3 className="font-bold text-slate-900">导入任务</h3>
          </div>
          <button
            onClick={() => { fetchJobs(); if (activeJobId) fetchJobDetail(activeJobId); }}
            className="px-3 py-1.5 text-sm rounded-xl border border-slate-200 hover:bg-slate-50 flex items-center gap-1"
          >
            <RefreshCw size={14} className={jobsLoading ? 'animate-spin' : ''} /> 刷新
          </button>
        </div>

        <div className="p-6 space-y-4">
          {jobs.length === 0 ? (
            <p className="text-sm text-slate-400">暂无导入任务</p>
          ) : (
            <div className="space-y-3">
              {jobs.map((job) => (
                <div key={job.id} className="border border-slate-200 rounded-2xl p-4 hover:border-slate-300 transition-all">
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-slate-900">{job.title}</span>
                        <span className={`text-[11px] px-2 py-0.5 rounded-full border ${statusClass(job.status)}`}>
                          {statusLabel(job.status)}
                        </span>
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-50 text-slate-500 border border-slate-200">
                          {job.mode === 'lazy' ? '懒还原' : '立即还原'} / STRM:{job.strmMode}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 truncate">
                        源：{job.sourceName} · 成功 {job.success}/{job.total} · 失败 {job.failed} · 跳过 {job.skipped}
                      </p>
                      {job.message && <p className="text-xs text-slate-400">{job.message}</p>}
                      {job.strmRoot && <p className="text-[11px] text-slate-400 font-mono">STRM: {job.strmRoot}</p>}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => { setActiveJobId(job.id); fetchJobDetail(job.id); }}
                        className="px-3 py-1.5 text-xs rounded-xl border border-slate-200 hover:bg-slate-50"
                      >
                        详情
                      </button>
                      <button
                        onClick={() => handleRetryJob(job.id)}
                        disabled={job.failed <= 0 || job.status === 'running' || retryingJobIds.includes(job.id)}
                        className="px-3 py-1.5 text-xs rounded-xl border border-slate-200 hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1"
                      >
                        <RotateCcw size={12} /> 重试失败
                      </button>
                      <button
                        onClick={() => handleDeleteJob(job)}
                        className="px-3 py-1.5 text-xs rounded-xl border border-rose-200 text-rose-600 hover:bg-rose-50 flex items-center gap-1"
                      >
                        <Trash2 size={12} /> 删除
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeJob && (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-semibold text-slate-800">任务详情：{activeJob.title}</h4>
                <button onClick={() => { setActiveJob(null); setActiveJobId(null); }} className="text-xs text-slate-500">关闭</button>
              </div>
              <p className="text-xs text-slate-500 mb-3">
                {statusLabel(activeJob.status)} · 成功 {activeJob.success} / 失败 {activeJob.failed} / 跳过 {activeJob.skipped} / 共 {activeJob.total}
              </p>
              {failedEntries.length > 0 ? (
                <div className="space-y-2 max-h-56 overflow-auto">
                  {failedEntries.map((entry) => (
                    <div key={entry.relativePath} className="text-xs bg-white border border-rose-100 rounded-xl px-3 py-2">
                      <div className="font-medium text-rose-700">{entry.restoreName || entry.relativePath}</div>
                      <div className="text-rose-500 mt-0.5">{entry.error || '未知错误'}</div>
                    </div>
                  ))}
                  {(activeJob.entries || []).filter((e) => e.status === 'failed').length > 20 && (
                    <p className="text-[11px] text-slate-400">仅显示前 20 条失败记录</p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-slate-400">暂无失败条目</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 管理区 */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="bg-white rounded-3xl border border-slate-200/60 overflow-hidden shadow-sm">
          <div className="p-6 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FolderArchive className="text-sky-500" size={20} />
              <h3 className="font-bold text-slate-900">导入 STRM</h3>
            </div>
            <button
              onClick={() => fetchStrmList(strmPath)}
              className="px-3 py-1.5 text-sm rounded-xl border border-slate-200 hover:bg-slate-50"
            >
              刷新
            </button>
          </div>
          <div className="p-6 space-y-3">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span>当前路径：</span>
              <code className="bg-slate-50 border border-slate-200 px-2 py-1 rounded-lg">{strmPath || '(根/CAS导入)'}</code>
              {!!strmPath && (
                <button
                  className="text-[#0b57d0]"
                  onClick={() => {
                    const parent = strmPath.split('/').slice(0, -1).join('/');
                    fetchStrmList(parent);
                  }}
                >
                  上级
                </button>
              )}
            </div>
            {mgmtLoading ? (
              <p className="text-sm text-slate-400">加载中...</p>
            ) : strmItems.length === 0 ? (
              <p className="text-sm text-slate-400">暂无内容。导入并生成 STRM 后会出现在这里。</p>
            ) : (
              <div className="space-y-2 max-h-72 overflow-auto">
                {strmItems.map((item) => (
                  <div key={item.id || item.path} className="flex items-center justify-between gap-3 border border-slate-200 rounded-xl px-3 py-2">
                    <button
                      className="text-left text-sm text-slate-700 truncate hover:text-[#0b57d0]"
                      onClick={() => {
                        if (item.type === 'directory') fetchStrmList(item.path);
                      }}
                    >
                      <span className="inline-flex items-center gap-2 min-w-0">
                        {item.type === 'directory' ? (
                          <Folder size={16} className="text-[#0b57d0] shrink-0" />
                        ) : (
                          <File size={16} className="text-slate-400 shrink-0" />
                        )}
                        <span className="truncate">{item.name}</span>
                      </span>
                    </button>
                    {item.type === 'directory' && (
                      <button
                        onClick={() => handleDeleteStrm(item)}
                        className="text-xs text-rose-600 hover:bg-rose-50 px-2 py-1 rounded-lg"
                      >
                        删除
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-slate-200/60 overflow-hidden shadow-sm">
          <div className="p-6 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertCircle className="text-amber-500" size={20} />
              <h3 className="font-bold text-slate-900">分享懒 STRM 缓存</h3>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={fetchShareCaches}
                className="px-3 py-1.5 text-sm rounded-xl border border-slate-200 hover:bg-slate-50"
              >
                刷新
              </button>
              <button
                onClick={async () => {
                  const ok = await dialog.confirm({
                    title: '清理分享缓存',
                    message: '确认清理全部分享 CAS 元数据缓存？',
                    confirmText: '全部清理',
                    tone: 'danger',
                  });
                  if (ok) {
                    handleClearShareCache(undefined, true);
                  }
                }}
                className="px-3 py-1.5 text-sm rounded-xl border border-rose-200 text-rose-600 hover:bg-rose-50"
              >
                全部清理
              </button>
            </div>
          </div>
          <div className="p-6 space-y-2 max-h-80 overflow-auto">
            {shareCaches.length === 0 ? (
              <p className="text-sm text-slate-400">暂无分享链接 CAS 元数据缓存</p>
            ) : (
              shareCaches.map((item) => (
                <div key={`${item.accountId}-${item.shareId}`} className="flex items-center justify-between gap-3 border border-slate-200 rounded-xl px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm text-slate-800 truncate">账号 {item.accountId} / 分享 {item.shareId}</div>
                    <div className="text-[11px] text-slate-400">{item.fileCount} 个文件 · {item.updatedAt || '-'}</div>
                  </div>
                  <button
                    onClick={() => handleClearShareCache(item)}
                    className="text-xs text-rose-600 hover:bg-rose-50 px-2 py-1 rounded-lg shrink-0"
                  >
                    清理
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* 说明 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-blue-50 rounded-3xl border border-blue-100 p-6">
          <div className="flex items-center gap-2 mb-3">
            <AlertCircle className="text-blue-500" size={18} />
            <h3 className="font-bold text-blue-900">什么是 CAS 秒传？</h3>
          </div>
          <div className="space-y-2 text-sm text-blue-800">
            <p><strong>.cas</strong> 存根包含文件名、大小、MD5 与分片 MD5。</p>
            <p>Hash 命中即可恢复，无需上传原片；未命中会失败。</p>
          </div>
        </div>
        <div className="bg-white rounded-3xl border border-slate-200/60 p-6">
          <div className="flex items-center gap-2 mb-3">
            <Zap className="text-amber-500" size={18} />
            <h3 className="font-bold text-slate-900">导入包说明</h3>
          </div>
          <div className="space-y-2 text-sm text-slate-600">
            <p>支持单个 `.cas`，或 zip / rar 内整树 `.cas`（如剧集 Season 目录）。</p>
            <p>立即还原会占用网盘实体；懒还原只写元数据与懒 STRM。</p>
          </div>
        </div>
        <div className="bg-emerald-50 rounded-3xl border border-emerald-100 p-6">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle2 className="text-emerald-500" size={18} />
            <h3 className="font-bold text-emerald-900">当前配置</h3>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <span className={config.enableFamilyTransit ? 'text-emerald-700' : 'text-slate-400'}>
              {config.enableFamilyTransit ? '✓' : '✗'} 家庭中转
            </span>
            <span className={config.familyTransitFirst ? 'text-emerald-700' : 'text-slate-400'}>
              {config.familyTransitFirst ? '✓' : '✗'} 优先中转
            </span>
            <span className={config.deleteCasAfterRestore ? 'text-emerald-700' : 'text-slate-400'}>
              {config.deleteCasAfterRestore ? '✓' : '✗'} 恢复后删CAS
            </span>
            <span className={config.deleteSourceAfterGenerate ? 'text-emerald-700' : 'text-slate-400'}>
              {config.deleteSourceAfterGenerate ? '✓' : '✗'} 生成后删源
            </span>
          </div>
        </div>
      </div>

      <FolderSelector
        isOpen={isFolderSelectorOpen}
        onClose={() => setIsFolderSelectorOpen(false)}
        accountId={selectedAccountId || 0}
        accountName={accounts.find((a) => a.id === selectedAccountId)?.username || ''}
        onSelect={(folder) => {
          if (folderSelectorMode === 'import') {
            setImportFolder(folder);
          } else {
            setTargetFolder(folder);
          }
          setIsFolderSelectorOpen(false);
        }}
        title={folderSelectorMode === 'import' ? '选择导入目录' : '选择存入目录'}
      />
    </div>
  );
};

export default CasTab;
