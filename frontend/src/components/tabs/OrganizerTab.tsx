import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Search, RefreshCw, Clock, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useToast } from '../ui/Toast';

interface Account {
  id: number;
  username: string;
  accountType: 'personal' | 'family';
}

interface OrganizerTask {
  id: number;
  resourceName: string;
  shareFolderName?: string;
  account: Account;
  enableOrganizer: boolean;
  lastOrganizedAt: string | null;
  lastOrganizeError: string | null;
}

const OrganizerTab: React.FC = () => {
  const toast = useToast();
  const [tasks, setTasks] = useState<OrganizerTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningTaskIds, setRunningTaskIds] = useState<number[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(searchTerm.trim());
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchTerm]);

  const fetchTasks = useCallback(async (keyword = debouncedSearch) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/organizer/tasks?search=${encodeURIComponent(keyword)}`);
      const data = await response.json();
      if (data.success) {
        setTasks(data.data || []);
      } else {
        toast.error(data.error || '加载整理任务失败');
      }
    } catch (error) {
      console.error('Failed to fetch organizer tasks:', error);
      toast.error('加载整理任务失败');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, toast]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const handleRunTask = async (taskId: number) => {
    if (runningTaskIds.includes(taskId)) return;
    setRunningTaskIds((ids) => [...ids, taskId]);
    try {
      const response = await fetch(`/api/organizer/tasks/${taskId}/run`, { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        toast.success(data.data?.message || '整理完成');
        fetchTasks();
      } else {
        toast.error('执行整理失败: ' + data.error);
      }
    } catch (error) {
      toast.error('执行整理失败');
    } finally {
      setRunningTaskIds((ids) => ids.filter((id) => id !== taskId));
    }
  };

  const formatDateTime = (dateStr: string | null) => {
    if (!dateStr) return '从未执行';
    const date = new Date(dateStr);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <h2 className="text-xl font-bold ui-title">整理器任务</h2>
        <div className="flex items-center gap-3">
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input
              type="text"
              placeholder="搜索任务..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  if (debounceRef.current) clearTimeout(debounceRef.current);
                  setDebouncedSearch(searchTerm.trim());
                }
              }}
              className="pl-10 pr-4 py-2 bg-white border border-slate-300 rounded-full text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 w-full"
            />
          </div>
          <button
            onClick={() => fetchTasks()}
            className="p-2 bg-white border border-slate-300 rounded-full hover:bg-slate-50 transition-all text-slate-600 shadow-sm"
          >
            <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="ui-card overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50/50 border-b border-slate-100">
              <tr>
                <th className="px-6 py-4 font-medium text-slate-500">操作</th>
                <th className="px-6 py-4 font-medium text-slate-500">任务名称</th>
                <th className="px-6 py-4 font-medium text-slate-500">账号</th>
                <th className="px-6 py-4 font-medium text-slate-500">状态</th>
                <th className="px-6 py-4 font-medium text-slate-500">最后整理</th>
                <th className="px-6 py-4 font-medium text-slate-500">错误信息</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && tasks.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                    <RefreshCw className="animate-spin mx-auto mb-2" />
                    加载中...
                  </td>
                </tr>
              ) : tasks.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-slate-500">暂无任务</td>
                </tr>
              ) : (
                tasks.map((task) => {
                  const isRunning = runningTaskIds.includes(task.id);
                  return (
                    <tr key={task.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="px-6 py-4">
                        <button
                          onClick={() => handleRunTask(task.id)}
                          disabled={isRunning}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-[#0b57d0] text-white hover:bg-[#0b57d0]/90 disabled:opacity-50"
                        >
                          {isRunning ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />}
                          {isRunning ? '执行中' : '执行整理'}
                        </button>
                      </td>
                      <td className="px-6 py-4 font-medium ui-title">
                        <div>{task.resourceName}</div>
                        {task.shareFolderName && (
                          <div className="text-xs text-slate-400 mt-0.5">{task.shareFolderName}</div>
                        )}
                      </td>
                      <td className="px-6 py-4 text-slate-600">
                        {task.account?.username || '-'}
                        <span className="ml-1 text-xs text-slate-400">
                          ({task.account?.accountType === 'family' ? '家庭云' : '个人云'})
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        {task.enableOrganizer ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600 text-xs font-medium">
                            <CheckCircle2 size={14} /> 已启用
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-slate-400 text-xs font-medium">
                            <Clock size={14} /> 未启用
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-slate-500 text-xs whitespace-nowrap">
                        {formatDateTime(task.lastOrganizedAt)}
                      </td>
                      <td className="px-6 py-4 text-xs text-red-500 max-w-[200px] truncate" title={task.lastOrganizeError || ''}>
                        {task.lastOrganizeError ? (
                          <span className="inline-flex items-center gap-1">
                            <AlertCircle size={12} /> {task.lastOrganizeError}
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default OrganizerTab;
