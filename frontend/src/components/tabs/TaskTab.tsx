import React, { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Plus, ChevronRight, Filter, Search, RefreshCw, Files, PlayCircle, MoreVertical, CheckCircle2, AlertCircle, Clock, Trash2, ClipboardList, Edit3 } from 'lucide-react';
import { motion } from 'motion/react';
import { useToast } from '../ui/Toast';
import { useDialog } from '../ui/Dialog';

interface Account {
  id: number;
  username: string;
  accountType: 'family' | 'personal';
}

interface Task {
  id: number;
  resourceName: string;
  shareFolderId?: string;
  shareFolderName?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  account: Account;
  taskGroup?: string;
  shareLink: string;
  targetFolderId: string;
  realFolderName?: string;
  realFolderId?: string;
  currentEpisodes: number;
  totalEpisodes: number | null;
  lastFileUpdateTime: string | null;
  remark?: string;
  sourceRegex?: string;
  targetRegex?: string;
  matchPattern?: string;
  matchOperator?: string;
  matchValue?: string;
  cronExpression?: string;
  tmdbId?: string;
  videoType?: 'movie' | 'tv';
  manualSeason?: number | null;
  tmdbTitle?: string;
  manualTmdbBound?: boolean;
  enableTaskScraper?: boolean;
  enableLazyStrm: boolean;
  enableOrganizer: boolean;
  keepCasAfterRestore?: boolean;
  enableCron: boolean;
}

interface TaskTabProps {
  onCreateTask: (initialData?: any) => void;
}

type TaskStatus = Task['status'];

interface TaskFilterTag {
  key: string;
  label: string;
  tone: 'group' | 'feature';
}

const TASK_STATUS_OPTIONS: Array<{ value: 'all' | TaskStatus; label: string }> = [
  { value: 'all', label: '全部任务' },
  { value: 'pending', label: '等待中' },
  { value: 'processing', label: '追剧中' },
  { value: 'completed', label: '已完结' },
  { value: 'failed', label: '失败' }
];
const TASK_PAGE_SIZE = 50;

const TASK_FEATURE_FILTERS: Array<{
  key: string;
  label: string;
  matches: (task: Task) => boolean;
}> = [
  { key: 'feature:lazy-strm', label: '懒STRM', matches: (task) => task.enableLazyStrm },
  { key: 'feature:cron', label: '定时任务', matches: (task) => Boolean(task.enableCron) },
  { key: 'feature:organizer', label: '整理器', matches: (task) => task.enableOrganizer },
  { key: 'feature:keep-cas', label: '保留CAS', matches: (task) => Boolean(task.keepCasAfterRestore) }
];

const TaskTab: React.FC<TaskTabProps> = ({ onCreateTask }) => {
  const toast = useToast();
  const dialog = useDialog();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('');
  const [page, setPage] = useState(1);
  const [totalTasks, setTotalTasks] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [selectedTaskIds, setSelectedTaskIds] = useState<number[]>([]);
  const [activeTagFilters, setActiveTagFilters] = useState<string[]>([]);
  const [batchStatus, setBatchStatus] = useState<TaskStatus>('pending');
  const [isBatchUpdatingStatus, setIsBatchUpdatingStatus] = useState(false);
  const [executingTaskIds, setExecutingTaskIds] = useState<number[]>([]);
  const [isExecutingAll, setIsExecutingAll] = useState(false);
  const [isStrmBusy, setIsStrmBusy] = useState(false);
  const [deleteCloud, setDeleteCloud] = useState(false);
  const [isTopMenuOpen, setIsTopMenuOpen] = useState(false);
  const [openTaskMenuId, setOpenTaskMenuId] = useState<number | null>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; right: number } | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const [filterGroups, setFilterGroups] = useState<string[]>([]);

  const fetchTasks = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        page: String(page),
        pageSize: String(TASK_PAGE_SIZE)
      });
      if (debouncedSearchTerm) {
        params.set('search', debouncedSearchTerm);
      }
      const featureKeys = activeTagFilters
        .filter((key) => key.startsWith('feature:'))
        .map((key) => key.slice('feature:'.length));
      const groupKeys = activeTagFilters
        .filter((key) => key.startsWith('group:'))
        .map((key) => key.slice('group:'.length));
      if (featureKeys.length > 0) {
        params.set('features', featureKeys.join(','));
      }
      // 多分组时取第一个精确匹配（UI 芯片为 AND；多 group 罕见，用 search 补）
      if (groupKeys.length === 1) {
        params.set('taskGroup', groupKeys[0]);
      } else if (groupKeys.length > 1) {
        params.set('taskGroup', groupKeys[0]);
      }
      const response = await fetch(`/api/tasks?${params.toString()}`, { signal });
      const data = await response.json();
      if (data.success) {
        setTasks(data.data || []);
        const nextTotal = Number(data.pagination?.total || 0);
        const nextTotalPages = Math.max(1, Number(data.pagination?.totalPages || 1));
        setTotalTasks(nextTotal);
        setTotalPages(nextTotalPages);
        setSelectedTaskIds([]);
        if (page > nextTotalPages) {
          setPage(nextTotalPages);
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      console.error('Failed to fetch tasks:', error);
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [statusFilter, debouncedSearchTerm, page, activeTagFilters]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearchTerm(searchTerm.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchTerm]);

  useEffect(() => {
    setPage(1);
  }, [statusFilter, debouncedSearchTerm, activeTagFilters]);

  useEffect(() => {
    const controller = new AbortController();
    fetchTasks(controller.signal);
    return () => controller.abort();
  }, [fetchTasks]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/tasks/filter-options');
        const data = await res.json();
        if (!cancelled && data.success) {
          setFilterGroups(Array.isArray(data.data?.groups) ? data.data.groups : []);
        }
      } catch {
        // ignore — chips 仍可用固定 feature
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('[data-task-top-menu]')) {
        setIsTopMenuOpen(false);
      }
      if (!target?.closest('[data-task-item-menu]') && !target?.closest('[data-task-item-menu-dropdown]')) {
        setOpenTaskMenuId(null);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsTopMenuOpen(false);
        setOpenTaskMenuId(null);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  useLayoutEffect(() => {
    if (openTaskMenuId !== null && menuButtonRef.current) {
      const rect = menuButtonRef.current.getBoundingClientRect();
      setDropdownPos({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    } else {
      setDropdownPos(null);
    }
  }, [openTaskMenuId]);

  // feature 固定展示；group 来自全库 filter-options（不再仅当前页）
  const availableTagFilters: TaskFilterTag[] = [
    ...TASK_FEATURE_FILTERS.map((filterTag) => ({
      key: filterTag.key,
      label: filterTag.label,
      tone: 'feature' as const
    })),
    ...filterGroups.map((taskGroup) => ({
      key: `group:${taskGroup}`,
      label: taskGroup,
      tone: 'group' as const
    }))
  ];

  // 服务端已按标签筛选，列表直接用 tasks
  const filteredTasks = tasks;

  const allVisibleSelected =
    filteredTasks.length > 0 &&
    filteredTasks.every((task) => selectedTaskIds.includes(task.id));
  const pageStart = totalTasks === 0 ? 0 : (page - 1) * TASK_PAGE_SIZE + 1;
  const pageEnd = Math.min(page * TASK_PAGE_SIZE, totalTasks);

  useEffect(() => {
    const availableTagKeys = new Set(availableTagFilters.map((filterTag) => filterTag.key));
    setActiveTagFilters((currentFilters) => currentFilters.filter((filterKey) => availableTagKeys.has(filterKey)));
  }, [tasks]);

  const handleExecuteTask = async (id: number) => {
    if (executingTaskIds.includes(id)) {
      return;
    }

    setExecutingTaskIds((currentIds) => [...currentIds, id]);
    try {
      const response = await fetch(`/api/tasks/${id}/execute`, { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        fetchTasks();
      } else {
        toast.error(data.error || '任务执行失败');
      }
    } catch (error) {
      console.error('Failed to execute task:', error);
      toast.error('任务执行失败');
    } finally {
      setExecutingTaskIds((currentIds) => currentIds.filter((taskId) => taskId !== id));
    }
  };

  const handleEditTask = (task: Task) => {
    onCreateTask({
      id: task.id,
      accountId: String(task.account.id),
      shareLink: task.shareLink,
      accessCode: '',
      taskName: task.resourceName,
      totalEpisodes: task.totalEpisodes !== null && task.totalEpisodes !== undefined && task.totalEpisodes > 0 ? String(task.totalEpisodes) : '',
      currentEpisodes: String(task.currentEpisodes || 0),
      targetFolderId: task.realFolderId || task.targetFolderId,
      targetFolder: task.realFolderName || '',
      shareFolderId: task.shareFolderId || '',
      shareFolderName: task.shareFolderName || '',
      taskGroup: task.taskGroup || '',
      remark: task.remark || '',
      matchPattern: task.matchPattern || '',
      matchOperator: task.matchOperator || '',
      matchValue: task.matchValue || '',
      sourceRegex: task.sourceRegex || '',
      targetRegex: task.targetRegex || '',
      tmdbId: task.tmdbId || '',
      status: task.status,
      cronExpression: task.cronExpression || '',
      enableTaskScraper: Boolean(task.enableTaskScraper),
      enableLazyStrm: task.enableLazyStrm,
      enableOrganizer: task.enableOrganizer,
      keepCasAfterRestore: Boolean(task.keepCasAfterRestore),
      enableCron: Boolean(task.enableCron)
    });
  };

  const handleDeleteTask = async (id: number) => {
    const ok = await dialog.confirm({
      title: '删除任务',
      message: deleteCloud
        ? '确定删除这个任务，并同步从网盘删除对应文件？此操作不可恢复。'
        : '确定删除这个任务记录吗？（默认只删任务，不删网盘。如需同步删网盘，请先勾选工具条「同步删除网盘」。）',
      confirmText: deleteCloud ? '删除任务和网盘' : '删除',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const response = await fetch(`/api/tasks/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteCloud })
      });
      const data = await response.json();
      if (data.success) {
        toast.success(deleteCloud ? '任务已删除（含网盘）' : '任务已删除');
        fetchTasks();
      } else {
        toast.error(data.error || '删除失败');
      }
    } catch (error) {
      console.error('Failed to delete task:', error);
      toast.error('删除失败');
    }
  };

  const handleClearTaskCache = async (task: Task) => {
    const ok = await dialog.confirm({
      title: '清理任务缓存',
      message: `确定清理「${task.resourceName}」的转存记录缓存吗？清理后后续执行会重新检查文件。`,
      confirmText: '清理',
      tone: 'warning',
    });
    if (!ok) return;
    try {
      const response = await fetch(`/api/tasks/${task.id}/clear-cache`, { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        toast.success('任务缓存已清理');
      } else {
        toast.error(data.error || '清理缓存失败');
      }
    } catch (error) {
      toast.error('清理缓存失败');
    }
  };

  const handleManualTmdbBind = async (task: Task) => {
    const tmdbId = await dialog.prompt({
      title: '手动绑定 TMDB',
      message: '请输入 TMDB ID',
      defaultValue: task.tmdbId || '',
      validate: (value) => value.trim() ? null : 'TMDB ID 不能为空'
    });
    if (tmdbId === null) return;

    const videoType = await dialog.prompt({
      title: '媒体类型',
      message: '请输入 movie 或 tv',
      defaultValue: task.videoType || 'tv',
      validate: (value) => ['movie', 'tv'].includes(value.trim()) ? null : '只能填写 movie 或 tv'
    });
    if (videoType === null) return;

    let manualSeason: string | null = '';
    if (videoType.trim() === 'tv') {
      manualSeason = await dialog.prompt({
        title: '手动季度',
        message: '请输入季度号；留空则自动从任务名推断',
        defaultValue: task.manualSeason ? String(task.manualSeason) : '',
        validate: (value) => !value.trim() || Number(value) > 0 ? null : '季度必须大于 0'
      });
      if (manualSeason === null) return;
    }

    const title = await dialog.prompt({
      title: '显示标题',
      message: '可选：自定义 TMDB 标题；留空使用 TMDB 返回标题',
      defaultValue: task.tmdbTitle || task.resourceName || ''
    });
    if (title === null) return;

    try {
      const response = await fetch(`/api/tasks/${task.id}/manual-tmdb`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tmdbId: tmdbId.trim(),
          videoType: videoType.trim(),
          manualSeason: manualSeason?.trim() || '',
          title: title.trim()
        })
      });
      const data = await response.json();
      if (data.success) {
        toast.success(`TMDB 绑定成功${data.data?.cascaded ? `，级联 ${data.data.cascaded} 个任务` : ''}`);
        fetchTasks();
      } else {
        toast.error(data.error || 'TMDB 绑定失败');
      }
    } catch (error) {
      toast.error('TMDB 绑定失败');
    }
  };

  const handleExecuteAll = async () => {
    if (isExecutingAll) {
      return;
    }
    const ok = await dialog.confirm({
      title: '执行所有任务',
      message: '确定要执行所有任务吗？',
      confirmText: '确认',
      tone: 'warning',
    });
    if (!ok) return;
    setIsExecutingAll(true);
    try {
      const response = await fetch('/api/tasks/executeAll', { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        toast.info('任务已在后台执行, 请稍后查看结果');
      } else {
        toast.error(data.error || '执行所有任务失败');
      }
    } catch (error) {
      console.error('Failed to execute all tasks:', error);
      toast.error('执行所有任务失败');
    } finally {
      setIsExecutingAll(false);
    }
  };

  const handleBatchDelete = async () => {
    if (selectedTaskIds.length === 0) return;
    const count = selectedTaskIds.length;
    const ok = await dialog.confirm({
      title: '批量删除任务',
      message: deleteCloud
        ? `确定删除选中的 ${count} 个任务，并同步从网盘删除对应文件？此操作不可恢复。`
        : `确定删除选中的 ${count} 个任务记录吗？（默认只删任务。如需同步删网盘，请先勾选「同步删除网盘」。）`,
      confirmText: deleteCloud ? '删除任务和网盘' : '删除',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const response = await fetch('/api/tasks/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: selectedTaskIds, deleteCloud })
      });
      const data = await response.json();
      if (data.success) {
        toast.success(deleteCloud ? `已删除 ${count} 个任务（含网盘）` : `已删除 ${count} 个任务`);
        setSelectedTaskIds([]);
        fetchTasks();
      } else {
        toast.error(data.error || '批量删除失败');
      }
    } catch (error) {
      console.error('Failed to batch delete tasks:', error);
      toast.error('批量删除失败');
    }
  };

  const handleBatchStatusUpdate = async () => {
    if (selectedTaskIds.length === 0 || isBatchUpdatingStatus) return;

    setIsBatchUpdatingStatus(true);
    try {
      const response = await fetch('/api/tasks/batch/status', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: selectedTaskIds, status: batchStatus })
      });
      const data = await response.json();
      if (data.success) {
        toast.success(`已更新 ${selectedTaskIds.length} 个任务状态`);
        fetchTasks();
      } else {
        toast.error(data.error || '批量更新状态失败');
      }
    } catch (error) {
      console.error('Failed to batch update task status:', error);
      toast.error('批量更新状态失败');
    } finally {
      setIsBatchUpdatingStatus(false);
    }
  };

  const toggleTagFilter = (filterKey: string) => {
    setSelectedTaskIds([]);
    setActiveTagFilters((currentFilters) =>
      currentFilters.includes(filterKey)
        ? currentFilters.filter((currentFilter) => currentFilter !== filterKey)
        : [...currentFilters, filterKey]
    );
  };

  const toggleTaskSelection = (id: number) => {
    setSelectedTaskIds(prev => 
      prev.includes(id) ? prev.filter(taskId => taskId !== id) : [...prev, id]
    );
  };

  const handleSelectAll = () => {
    if (allVisibleSelected) {
      setSelectedTaskIds([]);
    } else {
      setSelectedTaskIds(filteredTasks.map((task) => task.id));
    }
  };

  const formatDateTime = (dateStr: string | null) => {
    if (!dateStr) return '未更新';
    const date = new Date(dateStr);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  };

  const getStatusBadge = (status: Task['status']) => {
    switch (status) {
      case 'processing':
        return <span className="px-2.5 py-1 bg-[#d3e3fd] text-[#041e49] rounded-md text-xs font-bold uppercase tracking-wider">追剧中</span>;
      case 'completed':
        return <span className="px-2.5 py-1 bg-[#c4eed0] text-[#0d4f1f] rounded-md text-xs font-bold uppercase tracking-wider">已完结</span>;
      case 'failed':
        return <span className="px-2.5 py-1 bg-[#f9dedc] text-[#410002] rounded-md text-xs font-bold uppercase tracking-wider">失败</span>;
      default:
        return <span className="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-md text-xs font-bold uppercase tracking-wider">等待中</span>;
    }
  };

  const getStatusIcon = (status: Task['status']) => {
    switch (status) {
      case 'processing': return <PlayCircle size={24} />;
      case 'completed': return <CheckCircle2 size={24} />;
      case 'failed': return <AlertCircle size={24} />;
      default: return <Clock size={24} />;
    }
  };

  const getStatusColorClass = (status: Task['status']) => {
    switch (status) {
      case 'processing': return 'bg-[#0b57d0]';
      case 'completed': return 'bg-[#146c2e]';
      case 'failed': return 'bg-[#b3261e]';
      default: return 'bg-slate-400';
    }
  };

  const getStatusBgClass = (status: Task['status']) => {
    switch (status) {
      case 'processing': return 'bg-[#d3e3fd] text-[#0b57d0]';
      case 'completed': return 'bg-[#c4eed0] text-[#146c2e]';
      case 'failed': return 'bg-[#f9dedc] text-[#b3261e]';
      default: return 'bg-slate-100 text-slate-500';
    }
  };

  const handleGenerateStrm = async () => {
    if (selectedTaskIds.length === 0 || isStrmBusy) return;
    const overwrite = await dialog.confirm({
      title: '生成 STRM',
      message: '是否覆盖已存在的 STRM 文件？',
      confirmText: '确认',
      tone: 'warning',
    });
    if (isStrmBusy) return;
    setIsStrmBusy(true);
    try {
      const response = await fetch('/api/tasks/strm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: selectedTaskIds, overwrite })
      });
      const data = await response.json();
      if (data.success) {
        toast.info('任务后台执行中, 请稍后查看结果');
      } else {
        toast.error(data.error || '生成失败');
      }
    } catch (error) {
      console.error('Failed to generate STRM:', error);
      toast.error('生成 STRM 失败');
    } finally {
      setIsStrmBusy(false);
    }
  };

  const handleRebuildStrm = async () => {
    if (selectedTaskIds.length === 0 || isStrmBusy) return;
    const confirmed = await dialog.confirm({
      title: '重建 STRM',
      message: `将按当前媒体库规则重建 ${selectedTaskIds.length} 个任务的 STRM。\n路径变化时会清理旧目录。是否继续？`,
      confirmText: '重建',
      tone: 'warning',
    });
    if (!confirmed || isStrmBusy) return;
    const refreshLayout = await dialog.confirm({
      title: '刷新布局？',
      message: '是否强制重新分析媒体库布局？（否=使用已锁定布局，更稳定）',
      confirmText: '强制重分析',
      cancelText: '使用锁定布局',
      tone: 'warning',
    });
    if (isStrmBusy) return;
    setIsStrmBusy(true);
    try {
      const response = await fetch('/api/tasks/strm/rebuild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskIds: selectedTaskIds,
          overwrite: true,
          refreshLayout: !!refreshLayout,
          deleteOld: true
        })
      });
      const data = await response.json();
      if (data.success) {
        toast.info('重建任务已开始后台执行，请稍后查看结果');
      } else {
        toast.error(data.error || '重建失败');
      }
    } catch (error) {
      console.error('Failed to rebuild STRM:', error);
      toast.error('重建 STRM 失败');
    } finally {
      setIsStrmBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex gap-3">
          <button 
            onClick={() => onCreateTask()}
            className="bg-[#0b57d0] text-white px-6 py-2.5 rounded-full text-sm font-medium hover:bg-[#0b57d0]/90 transition-all shadow-sm flex items-center gap-2"
          >
            <Plus size={18} /> 创建任务
          </button>
          <div className="relative" data-task-top-menu>
            <button
              type="button"
              onClick={() => setIsTopMenuOpen(prev => !prev)}
              className="bg-white border border-slate-300 px-6 py-2.5 rounded-full text-sm font-medium hover:bg-slate-50 transition-all flex items-center gap-2 text-slate-700"
            >
              更多操作 <ChevronRight size={16} className={`transition-transform ${isTopMenuOpen ? 'rotate-180' : 'rotate-90'}`} />
            </button>
            {isTopMenuOpen && (
              <div className="absolute top-full left-0 mt-1 w-48 bg-white border border-slate-200 rounded-2xl shadow-xl py-2 z-50">
                <button
                  onClick={() => {
                    if (isExecutingAll) {
                      return;
                    }
                    setIsTopMenuOpen(false);
                    handleExecuteAll();
                  }}
                  disabled={isExecutingAll}
                  className="w-full text-left px-4 py-2 hover:bg-slate-50 text-sm text-slate-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isExecutingAll ? '执行中...' : '执行所有任务'}
                </button>
                <button
                  onClick={() => {
                    setIsTopMenuOpen(false);
                    handleGenerateStrm();
                  }}
                  disabled={selectedTaskIds.length === 0 || isStrmBusy}
                  className="w-full text-left px-4 py-2 hover:bg-slate-50 text-sm text-[#0b57d0] transition-colors disabled:opacity-50"
                >
                  {isStrmBusy ? '处理中...' : '生成 STRM'}
                </button>
                <button
                  onClick={() => {
                    setIsTopMenuOpen(false);
                    handleRebuildStrm();
                  }}
                  disabled={selectedTaskIds.length === 0 || isStrmBusy}
                  className="w-full text-left px-4 py-2 hover:bg-slate-50 text-sm text-violet-700 transition-colors disabled:opacity-50"
                >
                  {isStrmBusy ? '处理中...' : '重建 STRM'}
                </button>
                <button
                  onClick={() => {
                    setIsTopMenuOpen(false);
                    handleBatchDelete();
                  }}
                  disabled={selectedTaskIds.length === 0}
                  className="w-full text-left px-4 py-2 hover:bg-slate-50 text-sm text-red-600 transition-colors disabled:opacity-50"
                >
                  批量删除选中
                </button>
              </div>
            )}
          </div>
        </div>
        
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Filter className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <select 
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="pl-11 pr-8 py-2.5 bg-white border border-slate-300 rounded-full text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 appearance-none min-w-[140px]"
            >
              {TASK_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="relative flex-1 min-w-[240px]">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input 
              type="text" 
              placeholder="搜索资源名称、账号、备注..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-11 pr-4 py-2.5 bg-white border border-slate-300 rounded-full text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 w-full"
            />
          </div>
          <button 
            onClick={() => fetchTasks()}
            className="p-2.5 bg-white border border-slate-300 rounded-full hover:bg-slate-50 transition-all text-slate-600 shadow-sm"
          >
            <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 px-2">
        <label className="flex items-center gap-2 cursor-pointer group">
          <div
            onClick={handleSelectAll}
            className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
              allVisibleSelected
                ? 'bg-[#0b57d0] border-[#0b57d0]'
                : 'border-slate-400 group-hover:border-[#0b57d0]'
            }`}
          >
            {allVisibleSelected && <div className="w-2 h-2 bg-white rounded-sm" />}
          </div>
          <span className="text-sm font-medium text-slate-600">
            全选
            {filteredTasks.length > 0 ? ` (${filteredTasks.length})` : ''}
          </span>
        </label>

        <span className="text-sm ui-muted">
          已选 {selectedTaskIds.length} 项
        </span>

        <span className="text-sm ui-muted">
          显示 {pageStart}-{pageEnd} / {totalTasks} 项
        </span>

        {selectedTaskIds.length > 0 && (
          <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-2 py-1.5 shadow-sm">
            <select
              value={batchStatus}
              onChange={(e) => setBatchStatus(e.target.value as TaskStatus)}
              className="bg-transparent px-2 py-1 text-sm text-slate-700 outline-none"
            >
              {TASK_STATUS_OPTIONS.filter((option) => option.value !== 'all').map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleBatchStatusUpdate}
              disabled={isBatchUpdatingStatus}
              className="rounded-full bg-[#0b57d0] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#0b57d0]/90 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
            >
              {isBatchUpdatingStatus ? '设置中...' : '批量设状态'}
            </button>
          </div>
        )}

        <label
          className={`flex items-center gap-2 cursor-pointer group select-none rounded-full px-3 py-1.5 border transition-colors ${
            deleteCloud
              ? 'border-red-300 bg-red-50 text-red-700'
              : 'border-transparent text-slate-600'
          }`}
          onClick={() => setDeleteCloud((prev) => !prev)}
        >
          <div
            className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
              deleteCloud
                ? 'bg-red-500 border-red-500'
                : 'border-slate-400 group-hover:border-red-500'
            }`}
          >
            {deleteCloud && <div className="w-2 h-2 bg-white rounded-sm" />}
          </div>
          <span className="text-sm font-medium">
            {deleteCloud ? '已开启：删除任务将同步删网盘' : '同步删除网盘'}
          </span>
        </label>
      </div>

      {availableTagFilters.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-2">
          <span className="text-sm font-medium text-slate-500">筛选标签</span>
          {availableTagFilters.map((filterTag) => {
            const isActive = activeTagFilters.includes(filterTag.key);
            return (
              <button
                key={filterTag.key}
                type="button"
                onClick={() => toggleTagFilter(filterTag.key)}
                className={`rounded-full border px-3 py-1.5 text-xs font-bold transition-colors ${
                  isActive
                    ? 'border-[#0b57d0] bg-[#d3e3fd] text-[#0b57d0]'
                    : filterTag.tone === 'feature'
                      ? 'border-amber-200 bg-amber-50 text-amber-700 hover:border-amber-300'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                }`}
              >
                {filterTag.label}
              </button>
            );
          })}
          {activeTagFilters.length > 0 && (
            <button
              type="button"
              onClick={() => setActiveTagFilters([])}
              className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700"
            >
              清空筛选
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4">
        {Array.isArray(filteredTasks) && filteredTasks.map(task => {
          if (!task) return null;
          const taskName = task.shareFolderName ? `${task.resourceName}/${task.shareFolderName}` : (task.resourceName || 'Unknown Resource');
          const progress = (task.totalEpisodes && task.totalEpisodes > 0) ? (task.currentEpisodes / task.totalEpisodes) * 100 : 0;
          const isSelected = selectedTaskIds.includes(task.id);
          const isExecuting = executingTaskIds.includes(task.id);

          return (
            <div 
              key={task.id}
              className={`rounded-3xl border bg-white p-6 shadow-sm transition-all hover:shadow-md group relative overflow-hidden ${
                isSelected ? 'border-[#0b57d0] ring-1 ring-[#0b57d0]/20' : 'border-slate-200/60'
              } ${task.status === 'completed' ? 'opacity-80' : ''}`}
            >
              <button
                type="button"
                className="absolute top-0 left-0 z-10 flex h-12 w-12 items-center justify-center"
                onClick={() => toggleTaskSelection(task.id)}
                aria-label={isSelected ? '取消选择任务' : '选择任务'}
                aria-pressed={isSelected}
              >
                <div className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${
                  isSelected ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 bg-white/80'
                }`}>
                  {isSelected && <div className="w-1.5 h-1.5 bg-white rounded-sm" />}
                </div>
              </button>

              <div
                className={`absolute left-0 top-4 bottom-4 w-1.5 rounded-r-full ${getStatusColorClass(task.status)} pointer-events-none`}
              />
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pl-6">
                <div className="flex items-start gap-4">
                  <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 ${getStatusBgClass(task.status)}`}>
                    {getStatusIcon(task.status)}
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-bold ui-title text-lg truncate max-w-[300px]" title={taskName}>{taskName}</h3>
                      {getStatusBadge(task.status)}
                      {task.enableLazyStrm && <span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded text-[10px] font-bold">懒STRM</span>}
                      {task.enableCron && <span className="px-2 py-0.5 bg-violet-100 text-violet-700 rounded text-[10px] font-bold">定时任务</span>}
                      {task.enableOrganizer && <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded text-[10px] font-bold">整理器</span>}
                      {task.keepCasAfterRestore && <span className="px-2 py-0.5 bg-sky-100 text-sky-700 rounded text-[10px] font-bold">保留CAS</span>}
                    </div>
                    <p className="text-sm ui-muted mt-1">
                      账号: {task.account?.username || '未知账号'} • 分组: {task.taskGroup || '-'}
                    </p>
                    <div className="flex items-center gap-4 mt-3">
                      <div className="flex items-center gap-2 text-sm text-slate-600 bg-slate-50 px-3 py-1.5 rounded-lg">
                        <Files size={16} className="text-slate-400" />
                        <span className="truncate max-w-[250px]">更新目录: {task.realFolderName || task.realFolderId || '-'}</span>
                      </div>
                      <span className="text-xs text-slate-400">最后更新: {formatDateTime(task.lastFileUpdateTime)}</span>
                    </div>
                  </div>
                </div>
                
                <div className="flex flex-col items-end gap-3">
                  <div className="text-right">
                    <div className="text-sm font-bold ui-title">{task.currentEpisodes} / {task.totalEpisodes > 0 ? task.totalEpisodes : '?'} 集</div>
                    <div className="w-36 h-2 bg-slate-100 rounded-full mt-2 overflow-hidden">
                      <motion.div 
                        initial={{ width: 0 }}
                        animate={{ width: `${progress}%` }}
                        className={`h-full ${getStatusColorClass(task.status)} rounded-full`}
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button 
                      onClick={() => handleExecuteTask(task.id)}
                      disabled={isExecuting}
                      className="p-2 hover:bg-slate-100 rounded-full text-slate-500 hover:text-[#0b57d0] transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-slate-500"
                      title="立即执行"
                    >
                      <RefreshCw size={18} className={isExecuting ? 'animate-spin' : ''} />
                    </button>
                    <div className="relative" data-task-item-menu>
                      <button
                        type="button"
                        ref={openTaskMenuId === task.id ? menuButtonRef : undefined}
                        onClick={() => setOpenTaskMenuId(prev => prev === task.id ? null : task.id)}
                        className="p-2 hover:bg-slate-100 rounded-full text-slate-500 hover:text-slate-900 transition-colors"
                      >
                        <MoreVertical size={18} />
                      </button>
                      {openTaskMenuId === task.id && dropdownPos && createPortal(
                        <div
                          data-task-item-menu-dropdown
                          className="fixed w-44 bg-white border border-slate-200 rounded-xl shadow-lg py-1 z-[9999]"
                          style={{ top: dropdownPos.top, right: dropdownPos.right }}
                        >
                          <button
                            onClick={() => {
                              setOpenTaskMenuId(null);
                              handleEditTask(task);
                            }}
                            className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-sm text-slate-700 transition-colors flex items-center gap-2"
                          >
                            <Edit3 size={14} /> 修改任务
                          </button>
                          <button
                            onClick={() => {
                              setOpenTaskMenuId(null);
                              handleClearTaskCache(task);
                            }}
                            className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-sm text-slate-700 transition-colors flex items-center gap-2"
                          >
                            <RefreshCw size={14} /> 清理缓存
                          </button>
                          <button
                            onClick={() => {
                              setOpenTaskMenuId(null);
                              handleManualTmdbBind(task);
                            }}
                            className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-sm text-slate-700 transition-colors flex items-center gap-2"
                          >
                            <Search size={14} /> 绑定 TMDB
                          </button>
                          <button
                            onClick={() => {
                              setOpenTaskMenuId(null);
                              handleDeleteTask(task.id);
                            }}
                            className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-sm text-red-600 transition-colors flex items-center gap-2"
                          >
                            <Trash2 size={14} /> 删除任务
                          </button>
                        </div>,
                        document.body
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {filteredTasks.length === 0 && !loading && (
          <div className="text-center py-20 bg-slate-50 rounded-3xl border border-dashed border-slate-300">
            <ClipboardList size={48} className="mx-auto text-slate-300 mb-4" />
            <p className="ui-muted font-medium">
              {tasks.length === 0 ? '暂无任务' : '没有匹配当前筛选条件的任务'}
            </p>
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex flex-col items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm sm:flex-row">
          <span className="text-sm ui-muted">
            第 {page} / {totalPages} 页，每页 {TASK_PAGE_SIZE} 项
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((currentPage) => Math.max(1, currentPage - 1))}
              disabled={page <= 1 || loading}
              className="rounded-full border border-slate-300 px-4 py-2 text-sm font-medium ui-title transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              上一页
            </button>
            <button
              type="button"
              onClick={() => setPage((currentPage) => Math.min(totalPages, currentPage + 1))}
              disabled={page >= totalPages || loading}
              className="rounded-full border border-slate-300 px-4 py-2 text-sm font-medium ui-title transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              下一页
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default TaskTab;
