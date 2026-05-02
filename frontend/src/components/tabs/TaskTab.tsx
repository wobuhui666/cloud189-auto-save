import React, { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Plus, ChevronRight, Filter, Search, RefreshCw, Files, PlayCircle, MoreVertical, CheckCircle2, AlertCircle, Clock, Trash2, ClipboardList, Edit3 } from 'lucide-react';
import { motion } from 'motion/react';

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
  enableTaskScraper?: boolean;
  enableLazyStrm: boolean;
  enableOrganizer: boolean;
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

const TASK_FEATURE_FILTERS: Array<{
  key: string;
  label: string;
  matches: (task: Task) => boolean;
}> = [
  { key: 'feature:lazy-strm', label: '懒STRM', matches: (task) => task.enableLazyStrm },
  { key: 'feature:cron', label: '定时任务', matches: (task) => Boolean(task.enableCron) },
  { key: 'feature:organizer', label: '整理器', matches: (task) => task.enableOrganizer }
];

const getTaskFilterKeys = (task: Task) => {
  const filterKeys: string[] = [];
  const groupName = task.taskGroup?.trim();

  if (groupName) {
    filterKeys.push(`group:${groupName}`);
  }

  TASK_FEATURE_FILTERS.forEach((filterTag) => {
    if (filterTag.matches(task)) {
      filterKeys.push(filterTag.key);
    }
  });

  return filterKeys;
};

const TaskTab: React.FC<TaskTabProps> = ({ onCreateTask }) => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTaskIds, setSelectedTaskIds] = useState<number[]>([]);
  const [activeTagFilters, setActiveTagFilters] = useState<string[]>([]);
  const [batchStatus, setBatchStatus] = useState<TaskStatus>('pending');
  const [isBatchUpdatingStatus, setIsBatchUpdatingStatus] = useState(false);
  const [deleteCloud, setDeleteCloud] = useState(false);
  const [isTopMenuOpen, setIsTopMenuOpen] = useState(false);
  const [openTaskMenuId, setOpenTaskMenuId] = useState<number | null>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; right: number } | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/tasks?status=${statusFilter}&search=${encodeURIComponent(searchTerm)}`);
      const data = await response.json();
      if (data.success) {
        setTasks(data.data || []);
        setSelectedTaskIds([]);
      }
    } catch (error) {
      console.error('Failed to fetch tasks:', error);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, searchTerm]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

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

  const availableTagFilters: TaskFilterTag[] = [
    ...TASK_FEATURE_FILTERS
      .filter((filterTag) => tasks.some((task) => filterTag.matches(task)))
      .map((filterTag) => ({
        key: filterTag.key,
        label: filterTag.label,
        tone: 'feature' as const
      })),
    ...Array.from(
      new Set(
        tasks
          .map((task) => task.taskGroup?.trim())
          .filter((taskGroup): taskGroup is string => Boolean(taskGroup))
      )
    )
      .sort((left, right) => left.localeCompare(right, 'zh-CN'))
      .map((taskGroup) => ({
        key: `group:${taskGroup}`,
        label: taskGroup,
        tone: 'group' as const
      }))
  ];

  const filteredTasks = tasks.filter((task) => {
    if (activeTagFilters.length === 0) {
      return true;
    }

    const taskFilterKeys = new Set(getTaskFilterKeys(task));
    return activeTagFilters.every((filterKey) => taskFilterKeys.has(filterKey));
  });

  const allVisibleSelected = filteredTasks.length > 0 && selectedTaskIds.length === filteredTasks.length;

  useEffect(() => {
    const availableTagKeys = new Set(availableTagFilters.map((filterTag) => filterTag.key));
    setActiveTagFilters((currentFilters) => currentFilters.filter((filterKey) => availableTagKeys.has(filterKey)));
  }, [tasks]);

  const handleExecuteTask = async (id: number) => {
    try {
      const response = await fetch(`/api/tasks/${id}/execute`, { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        fetchTasks();
      }
    } catch (error) {
      console.error('Failed to execute task:', error);
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
      enableCron: Boolean(task.enableCron)
    });
  };

  const handleDeleteTask = async (id: number) => {
    if (!window.confirm(deleteCloud ? '确定要删除这个任务并且从网盘中也删除吗？' : '确定要删除这个任务吗？')) return;
    try {
      const response = await fetch(`/api/tasks/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteCloud })
      });
      const data = await response.json();
      if (data.success) {
        fetchTasks();
      }
    } catch (error) {
      console.error('Failed to delete task:', error);
    }
  };

  const handleExecuteAll = async () => {
    if (!window.confirm('确定要执行所有任务吗？')) return;
    try {
      const response = await fetch('/api/tasks/executeAll', { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        alert('任务已在后台执行, 请稍后查看结果');
      }
    } catch (error) {
      console.error('Failed to execute all tasks:', error);
    }
  };

  const handleBatchDelete = async () => {
    if (selectedTaskIds.length === 0) return;
    if (!window.confirm(deleteCloud ? '确定要删除选中任务并且从网盘中也删除吗？' : '确定要删除选中的任务吗？')) return;
    try {
      const response = await fetch('/api/tasks/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: selectedTaskIds, deleteCloud })
      });
      const data = await response.json();
      if (data.success) {
        setSelectedTaskIds([]);
        fetchTasks();
      }
    } catch (error) {
      console.error('Failed to batch delete tasks:', error);
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
        fetchTasks();
      } else {
        alert(data.error || '批量更新状态失败');
      }
    } catch (error) {
      console.error('Failed to batch update task status:', error);
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
    if (selectedTaskIds.length === 0) return;
    const overwrite = window.confirm('是否覆盖已存在的STRM文件');
    try {
      const response = await fetch('/api/tasks/strm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: selectedTaskIds, overwrite })
      });
      const data = await response.json();
      if (data.success) {
        alert('任务后台执行中, 请稍后查看结果');
      }
    } catch (error) {
      console.error('Failed to generate STRM:', error);
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
                    setIsTopMenuOpen(false);
                    handleExecuteAll();
                  }}
                  className="w-full text-left px-4 py-2 hover:bg-slate-50 text-sm text-slate-700 transition-colors"
                >
                  执行所有任务
                </button>
                <button
                  onClick={() => {
                    setIsTopMenuOpen(false);
                    handleGenerateStrm();
                  }}
                  disabled={selectedTaskIds.length === 0}
                  className="w-full text-left px-4 py-2 hover:bg-slate-50 text-sm text-[#0b57d0] transition-colors disabled:opacity-50"
                >
                  生成 STRM
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
            onClick={fetchTasks}
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

        <span className="text-sm text-slate-500">
          已选 {selectedTaskIds.length} 项
        </span>

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
            disabled={selectedTaskIds.length === 0 || isBatchUpdatingStatus}
            className="rounded-full bg-[#0b57d0] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#0b57d0]/90 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
          >
            {isBatchUpdatingStatus ? '设置中...' : '批量设状态'}
          </button>
        </div>

        <label className="flex items-center gap-2 cursor-pointer group">
          <div
            onClick={() => setDeleteCloud(!deleteCloud)}
            className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
              deleteCloud
                ? 'bg-red-500 border-red-500'
                : 'border-slate-400 group-hover:border-red-500'
            }`}
          >
            {deleteCloud && <div className="w-2 h-2 bg-white rounded-sm" />}
          </div>
          <span className="text-sm font-medium text-slate-600">同步删除网盘</span>
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

          return (
            <div 
              key={task.id}
              className={`rounded-3xl border bg-white p-6 shadow-sm transition-all hover:shadow-md group relative overflow-hidden ${
                isSelected ? 'border-[#0b57d0] ring-1 ring-[#0b57d0]/20' : 'border-slate-200/60'
              } ${task.status === 'completed' ? 'opacity-80' : ''}`}
            >
              <div 
                className="absolute top-0 left-0 w-8 h-8 cursor-pointer z-10"
                onClick={() => toggleTaskSelection(task.id)}
              >
                <div className={`m-3 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                  isSelected ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 bg-white/80'
                }`}>
                  {isSelected && <div className="w-1.5 h-1.5 bg-white rounded-sm" />}
                </div>
              </div>

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
                      <h3 className="font-bold text-slate-900 text-lg truncate max-w-[300px]" title={taskName}>{taskName}</h3>
                      {getStatusBadge(task.status)}
                      {task.enableLazyStrm && <span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded text-[10px] font-bold">懒STRM</span>}
                      {task.enableCron && <span className="px-2 py-0.5 bg-violet-100 text-violet-700 rounded text-[10px] font-bold">定时任务</span>}
                      {task.enableOrganizer && <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded text-[10px] font-bold">整理器</span>}
                    </div>
                    <p className="text-sm text-slate-500 mt-1">
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
                    <div className="text-sm font-bold text-slate-900">{task.currentEpisodes} / {task.totalEpisodes > 0 ? task.totalEpisodes : '?'} 集</div>
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
                      className="p-2 hover:bg-slate-100 rounded-full text-slate-500 hover:text-[#0b57d0] transition-colors"
                      title="立即执行"
                    >
                      <RefreshCw size={18} />
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
                          className="fixed w-32 bg-white border border-slate-200 rounded-xl shadow-lg py-1 z-[9999]"
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
            <p className="text-slate-500 font-medium">
              {tasks.length === 0 ? '暂无任务' : '没有匹配当前筛选条件的任务'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default TaskTab;
