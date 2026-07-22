import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Link2, MoreVertical, RefreshCw, Edit2, Trash2, Folder, Play, CheckCircle2, AlertCircle, HelpCircle, ChevronLeft, Search, X, Check, FileText } from 'lucide-react';
import Modal from '../Modal';
import FolderSelector, { SelectedFolder } from '../FolderSelector';
import Checkbox from '../ui/Checkbox';
import { useToast } from '../ui/Toast';
import { useDialog } from '../ui/Dialog';

interface Account {
  id: number;
  username: string;
  alias: string | null;
}

interface Subscription {
  id: number;
  name: string;
}

interface StrmDirectory {
  accountId: number;
  folderId: string;
  name: string;
  path: string;
}

interface StrmConfig {
  id: number;
  name: string;
  type: 'normal' | 'subscription';
  accountIds: number[];
  directories: StrmDirectory[];
  subscriptionId: number | null;
  resourceIds: number[];
  localPathPrefix: string | null;
  excludePattern: string | null;
  overwriteExisting: boolean;
  /** 普通配置：是否写入系统中转 /api/stream 地址；订阅固定中转 */
  useStreamProxy: boolean;
  enabled: boolean;
  enableCron: boolean;
  cronExpression: string | null;
  lastCheckTime: string | null;
  lastRunAt: string | null;
}

interface Resource {
  id: number;
  title: string;
}

interface FolderEntry {
  id: string;
  name: string;
  isFolder: boolean;
  path: string;
}

const formatDateTime = (dateStr: string | null) => {
  if (!dateStr) return '从未';
  const date = new Date(dateStr);
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
};

const StrmConfigTab: React.FC = () => {
  const toast = useToast();
  const dialog = useDialog();
  const [configs, setConfigs] = useState<StrmConfig[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<StrmConfig | null>(null);
  const [formData, setFormData] = useState<Partial<StrmConfig>>({
    name: '',
    type: 'normal',
    accountIds: [],
    directories: [],
    subscriptionId: null,
    resourceIds: [],
    localPathPrefix: '',
    excludePattern: '',
    overwriteExisting: false,
    useStreamProxy: true,
    enabled: true,
    enableCron: false,
    cronExpression: ''
  });

  // Folder Selector State
  const [isFolderSelectorOpen, setIsFolderSelectorOpen] = useState(false);
  const [selectorAccountId, setSelectorAccountId] = useState<number | null>(null);
  const [folderStack, setFolderStack] = useState<{ id: string, name: string }[]>([]);
  const [folderEntries, setFolderEntries] = useState<FolderEntry[]>([]);
  const [folderLoading, setFolderLoading] = useState(false);

  // Lazy Share State
  const [isLazyModalOpen, setIsLazyModalOpen] = useState(false);
  const [isLazyFolderSelectorOpen, setIsLazyFolderSelectorOpen] = useState(false);
  const [lazyFormData, setLazyFormData] = useState({
    accountId: '',
    shareLink: '',
    accessCode: '',
    targetFolderId: '',
    targetFolder: '',
    localPathPrefix: '',
    overwriteExisting: false
  });

  const fetchConfigs = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/strm/configs');
      const data = await response.json();
      if (data.success) {
        setConfigs(data.data || []);
      }
    } catch (error) {
      console.error('Failed to fetch STRM configs:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchAccounts = async () => {
    try {
      const response = await fetch('/api/accounts');
      const data = await response.json();
      if (data.success) {
        setAccounts(data.data || []);
      }
    } catch (error) {
      console.error('Failed to fetch accounts:', error);
    }
  };

  const fetchSubscriptions = async () => {
    try {
      const response = await fetch('/api/subscriptions');
      const data = await response.json();
      if (data.success) {
        setSubscriptions(data.data || []);
      }
    } catch (error) {
      console.error('Failed to fetch subscriptions:', error);
    }
  };

  const fetchResources = async (subId: number) => {
    try {
      const response = await fetch(`/api/subscriptions/${subId}/resources`);
      const data = await response.json();
      if (data.success) {
        setResources(data.data || []);
      }
    } catch (error) {
      console.error('Failed to fetch resources:', error);
    }
  };

  useEffect(() => {
    fetchConfigs();
    fetchAccounts();
    fetchSubscriptions();
  }, []);

  useEffect(() => {
    if (openMenuId == null) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('[data-strm-menu]')) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openMenuId]);

  useEffect(() => {
    if (formData.subscriptionId) {
      fetchResources(formData.subscriptionId);
    } else {
      setResources([]);
    }
  }, [formData.subscriptionId]);

  const handleOpenAddModal = () => {
    setEditingConfig(null);
    setFormData({
      name: '',
      type: 'normal',
      accountIds: [],
      directories: [],
      subscriptionId: null,
      resourceIds: [],
      localPathPrefix: '',
      excludePattern: '',
      overwriteExisting: false,
      useStreamProxy: true,
      enabled: true,
      enableCron: false,
      cronExpression: ''
    });
    setIsModalOpen(true);
  };

  const handleEditConfig = (config: StrmConfig) => {
    setEditingConfig(config);
    setFormData({
      ...config,
      useStreamProxy: config.useStreamProxy !== false
    });
    setIsModalOpen(true);
  };

  const handleDeleteConfig = async (id: number) => {
    const ok = await dialog.confirm({
      title: '删除STRM配置',
      message: '确定要删除这个STRM配置吗？',
      confirmText: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const response = await fetch(`/api/strm/configs/${id}`, { method: 'DELETE' });
      const data = await response.json();
      if (data.success) {
        fetchConfigs();
      }
    } catch (error) {
      toast.error('操作失败');
    }
  };

  const handleToggleConfig = async (config: StrmConfig) => {
    try {
      const response = await fetch(`/api/strm/configs/${config.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !config.enabled })
      });
      const data = await response.json();
      if (data.success) {
        fetchConfigs();
      }
    } catch (error) {
      toast.error('操作失败');
    }
  };

  const handleRunConfig = async (id: number) => {
    try {
      const response = await fetch(`/api/strm/configs/${id}/run`, { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        toast.success(data.data || '任务已开始执行');
        fetchConfigs();
      } else {
        toast.error('执行失败: ' + data.error);
      }
    } catch (error) {
      toast.error('操作失败');
    }
  };

  const handleResetTime = async (id: number) => {
    const ok = await dialog.confirm({
      title: '重置增量时间',
      message: '确定要重置该订阅配置的增量时间吗？',
      confirmText: '重置',
      tone: 'warning',
    });
    if (!ok) return;
    try {
      const response = await fetch(`/api/strm/configs/${id}/reset`, { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        toast.success('已重置增量时间');
        fetchConfigs();
      }
    } catch (error) {
      toast.error('操作失败');
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    const isNormal = formData.type === 'normal';
    const useProxy = formData.useStreamProxy !== false;
    if (isNormal && useProxy && !(formData.directories?.length)) {
      toast.warning('系统中转模式请至少指定一个目录（需要云盘 folderId）');
      return;
    }
    try {
      const url = editingConfig ? `/api/strm/configs/${editingConfig.id}` : '/api/strm/configs';
      const response = await fetch(url, {
        method: editingConfig ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          // 订阅固定中转；普通配置按表单
          useStreamProxy: formData.type === 'subscription' ? true : useProxy
        })
      });
      const data = await response.json();
      if (data.success) {
        setIsModalOpen(false);
        fetchConfigs();
      } else {
        toast.error('保存失败: ' + data.error);
      }
    } catch (error) {
      toast.error('操作失败');
    }
  };

  const handleLazySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lazyFormData.accountId || !lazyFormData.shareLink) {
      toast.warning('请选择账号并输入分享链接');
      return;
    }
    try {
      const response = await fetch('/api/strm/lazy-share/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: lazyFormData.accountId,
          shareLink: lazyFormData.shareLink,
          accessCode: lazyFormData.accessCode,
          targetFolderId: lazyFormData.targetFolderId,
          localPathPrefix: lazyFormData.localPathPrefix,
          overwriteExisting: lazyFormData.overwriteExisting
        })
      });
      const data = await response.json();
      if (data.success) {
        toast.success('懒转存生成任务已提交后台执行');
        setIsLazyModalOpen(false);
        setLazyFormData({
          accountId: accounts[0]?.id.toString() || '',
          shareLink: '',
          accessCode: '',
          targetFolderId: '',
          targetFolder: '',
          localPathPrefix: '',
          overwriteExisting: false
        });
      } else {
        toast.error('生成失败: ' + data.error);
      }
    } catch (error) {
      toast.error('操作失败');
    }
  };

  const fetchFolderEntries = async (accountId: number, folderId: string = '') => {
    setFolderLoading(true);
    try {
      const response = await fetch(`/api/file-manager/list?accountId=${accountId}&folderId=${encodeURIComponent(folderId)}`);
      const data = await response.json();
      if (data.success) {
        setFolderEntries((data.data.entries || []).filter((e: any) => e.isFolder));
      }
    } catch (error) {
      console.error('Failed to fetch folders:', error);
    } finally {
      setFolderLoading(false);
    }
  };

  const handleOpenFolderSelector = (accountId: number) => {
    setSelectorAccountId(accountId);
    setFolderStack([]);
    setFolderEntries([]);
    setIsFolderSelectorOpen(true);
    fetchFolderEntries(accountId);
  };

  const handleEnterFolder = (entry: FolderEntry) => {
    const newStack = [...folderStack, { id: entry.id, name: entry.name }];
    setFolderStack(newStack);
    fetchFolderEntries(selectorAccountId!, entry.id);
  };

  const handleGoBack = () => {
    const newStack = [...folderStack];
    newStack.pop();
    setFolderStack(newStack);
    const parentFolder = newStack[newStack.length - 1];
    fetchFolderEntries(selectorAccountId!, parentFolder?.id || '');
  };

  const handleSelectFolder = (folder: SelectedFolder) => {
    const newDirectories = [...(formData.directories || [])];
    const exists = newDirectories.findIndex(d => d.accountId === folder.accountId && d.folderId === folder.id);

    if (exists === -1) {
      newDirectories.push({
        accountId: folder.accountId,
        folderId: folder.id,
        name: folder.name,
        path: folder.path
      });

      if (!formData.accountIds?.includes(folder.accountId)) {
        setFormData({
          ...formData,
          directories: newDirectories,
          accountIds: [...(formData.accountIds || []), folder.accountId]
        });
      } else {
        setFormData({ ...formData, directories: newDirectories });
      }
    }

    setIsFolderSelectorOpen(false);
  };

  const removeDirectory = (index: number) => {
    const newDirs = [...(formData.directories || [])];
    newDirs.splice(index, 1);
    setFormData({ ...formData, directories: newDirs });
  };

  const getAccountLabel = (id: number) => {
    const acc = accounts.find(a => a.id === id);
    if (!acc) return `账号${id}`;
    return acc.alias ? `${acc.username} (${acc.alias})` : acc.username;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex gap-3">
          <button 
            onClick={handleOpenAddModal}
            className="bg-[#0b57d0] text-white px-6 py-2.5 rounded-full text-sm font-medium hover:bg-[#0b57d0]/90 transition-all shadow-sm flex items-center gap-2"
          >
            <Plus size={18} /> 新建配置
          </button>
          <button 
            onClick={() => {
              setLazyFormData(prev => ({ ...prev, accountId: accounts[0]?.id.toString() || '' }));
              setIsLazyModalOpen(true);
            }}
            className="bg-[#d3e3fd] text-[#041e49] px-6 py-2.5 rounded-full text-sm font-medium hover:bg-[#c2e7ff] transition-all shadow-sm flex items-center gap-2"
          >
            <FileText size={18} /> 懒转存STRM生成
          </button>
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200/60 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50/50 border-b border-slate-100">
              <tr>
                <th className="px-6 py-4 font-medium text-slate-500">名称</th>
                <th className="px-6 py-4 font-medium text-slate-500">类型</th>
                <th className="px-6 py-4 font-medium text-slate-500">目标</th>
                <th className="px-6 py-4 font-medium text-slate-500">定时</th>
                <th className="px-6 py-4 font-medium text-slate-500">状态</th>
                <th className="px-6 py-4 font-medium text-slate-500">最后运行</th>
                <th className="px-6 py-4 font-medium text-slate-500 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-6 py-4 text-center text-slate-500">加载中...</td>
                </tr>
              ) : configs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-4 text-center text-slate-500">暂无配置</td>
                </tr>
              ) : configs.map(config => (
                <tr key={config.id} className="hover:bg-slate-50/50 transition-colors group">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-xl ${config.enabled ? 'bg-[#c2e7ff] text-[#001d35]' : 'bg-slate-100 text-slate-400'}`}>
                        <Link2 size={20} />
                      </div>
                      <span className="font-medium text-slate-900">{config.name}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-slate-600">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span>{config.type === 'normal' ? '普通' : '订阅'}</span>
                      {(config.type === 'subscription' || config.useStreamProxy !== false) ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-[#c2e7ff] text-[#001d35]">中转</span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-500">Alist</span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-slate-500 text-xs">
                    {config.type === 'normal' ? (
                      config.directories?.length ? `${config.accountIds.length} 个账号 / ${config.directories.length} 个目录` : `${config.accountIds.length} 个账号 / 全量`
                    ) : (
                      `${subscriptions.find(s => s.id === config.subscriptionId)?.name || config.subscriptionId || '-'} / ${config.resourceIds.length || '全部资源'}`
                    )}
                  </td>
                  <td className="px-6 py-4 text-slate-500 font-mono text-xs">
                    {config.enableCron ? config.cronExpression : '未启用'}
                  </td>
                  <td className="px-6 py-4">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${config.enabled ? 'bg-[#c4eed0] text-[#0d4f1f]' : 'bg-slate-100 text-slate-500'}`}>
                      {config.enabled ? '启用' : '停用'}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-slate-500">
                    {formatDateTime(config.lastRunAt)}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button 
                        onClick={() => handleRunConfig(config.id)}
                        className="p-2 hover:bg-[#0b57d0]/10 rounded-full text-[#0b57d0] transition-colors"
                        title="立即执行"
                      >
                        <Play size={18} />
                      </button>
                      <button 
                        onClick={() => handleEditConfig(config)}
                        className="p-2 hover:bg-slate-100 rounded-full text-slate-500 transition-colors"
                        title="编辑"
                      >
                        <Edit2 size={18} />
                      </button>
                      <div className="relative" data-strm-menu>
                        <button
                          type="button"
                          onClick={() => setOpenMenuId((prev) => (prev === config.id ? null : config.id))}
                          className="p-2 hover:bg-slate-100 rounded-full text-slate-500 transition-colors"
                          aria-label="更多操作"
                          aria-expanded={openMenuId === config.id}
                        >
                          <MoreVertical size={18} />
                        </button>
                        {openMenuId === config.id && (
                          <div className="absolute right-0 top-full mt-1 w-36 bg-white rounded-xl shadow-lg border border-slate-100 py-1 z-[210] dark:bg-slate-900 dark:border-slate-700">
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenuId(null);
                                handleToggleConfig(config);
                              }}
                              className={`w-full px-4 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-2 ${config.enabled ? 'text-orange-600' : 'text-green-600'}`}
                            >
                              {config.enabled ? '停用' : '启用'}
                            </button>
                            {config.type === 'subscription' && (
                              <button
                                type="button"
                                onClick={() => {
                                  setOpenMenuId(null);
                                  handleResetTime(config.id);
                                }}
                                className="w-full px-4 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-2 text-slate-700 dark:text-slate-200"
                              >
                                <RefreshCw size={14} /> 重置时间
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenuId(null);
                                handleDeleteConfig(config.id);
                              }}
                              className="w-full px-4 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-2 text-red-600"
                            >
                              <Trash2 size={14} /> 删除
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal 
        isOpen={isModalOpen} 
        onClose={() => setIsModalOpen(false)} 
        title={editingConfig ? "编辑STRM配置" : "新建STRM配置"}
        footer={null}
      >
        <form onSubmit={handleSaveConfig} className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">配置名称</label>
            <input 
              type="text" 
              value={formData.name}
              onChange={e => setFormData({...formData, name: e.target.value})}
              required 
              className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20" 
              placeholder="例如：电影全量生成"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">生成类型</label>
              <select 
                value={formData.type}
                onChange={e => setFormData({...formData, type: e.target.value as 'normal' | 'subscription'})}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              >
                <option value="normal">普通 (账号/目录)</option>
                <option value="subscription">订阅 (按资源)</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">本地路径前缀 (可选)</label>
              <input
                type="text"
                value={formData.localPathPrefix || ''}
                onChange={e => setFormData({...formData, localPathPrefix: e.target.value})}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder="留空 或 emby（相对 STRM 根，勿填绝对路径）"
              />
              <p className="text-[11px] leading-relaxed text-slate-500">
                相对「应用 STRM 根目录」的前缀，不是宿主机绝对路径。Docker 物理根多为
                <code className="mx-1 rounded bg-slate-100 px-1">/home/strm</code>
                （已挂载到宿主机）。填
                <code className="mx-1 rounded bg-slate-100 px-1">/strm</code>
                或
                <code className="mx-1 rounded bg-slate-100 px-1">strm</code>
                会视为空，避免叠成
                <code className="mx-1 rounded bg-slate-100 px-1">strm/strm</code>
                。最终：STRM根 + 此前缀 + 资源路径。
              </p>
            </div>
          </div>

          {formData.type === 'normal' ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">选择账号</label>
                <div className="flex flex-wrap gap-3 p-4 bg-slate-50 rounded-2xl border border-slate-200">
                  {accounts.map(acc => (
                    <label key={acc.id} className="flex items-center gap-2 cursor-pointer group">
                      <div 
                        onClick={() => {
                          const newIds = [...(formData.accountIds || [])];
                          const index = newIds.indexOf(acc.id);
                          if (index > -1) newIds.splice(index, 1);
                          else newIds.push(acc.id);
                          setFormData({...formData, accountIds: newIds});
                        }}
                        className={`w-5 h-5 rounded border flex items-center justify-center transition-all ${
                          formData.accountIds?.includes(acc.id) ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 bg-white group-hover:border-[#0b57d0]'
                        }`}
                      >
                        {formData.accountIds?.includes(acc.id) && <Check size={14} className="text-white" />}
                      </div>
                      <span className="text-sm text-slate-600">{acc.alias || acc.username}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-slate-700">指定目录 (可选)</label>
                  <div className="flex items-center gap-2">
                    <select 
                      className="text-xs border border-slate-300 rounded-full px-3 py-1 bg-white outline-none"
                      onChange={(e) => {
                        if (e.target.value) handleOpenFolderSelector(Number(e.target.value));
                        e.target.value = '';
                      }}
                    >
                      <option value="">点击账号选择目录...</option>
                      {accounts.filter(a => formData.accountIds?.includes(a.id)).map(acc => (
                        <option key={acc.id} value={acc.id}>{acc.alias || acc.username}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="space-y-2 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                  {!formData.directories?.length ? (
                    <p className="text-xs text-slate-500 italic p-4 text-center bg-slate-50 rounded-2xl border border-dashed border-slate-300">
                      未选择目录，将按账号媒体目录整体生成。
                    </p>
                  ) : (
                    formData.directories.map((dir, idx) => (
                      <div key={idx} className="flex items-center justify-between p-3 bg-white border border-slate-200 rounded-xl group hover:border-[#0b57d0]/30 transition-colors">
                        <div className="flex flex-col min-w-0">
                          <span className="text-sm font-medium text-slate-900 truncate">{dir.name}</span>
                          <span className="text-[10px] text-slate-500 truncate">{getAccountLabel(dir.accountId)} / {dir.path}</span>
                        </div>
                        <button 
                          type="button" 
                          onClick={() => removeDirectory(idx)}
                          className="p-1.5 text-red-500 hover:bg-red-50 rounded-full transition-colors"
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">选择订阅</label>
                <select 
                  value={formData.subscriptionId || ''}
                  onChange={e => setFormData({...formData, subscriptionId: Number(e.target.value), resourceIds: []})}
                  required
                  className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                >
                  <option value="">请选择订阅</option>
                  {subscriptions.map(sub => (
                    <option key={sub.id} value={sub.id}>{sub.name}</option>
                  ))}
                </select>
              </div>

              {formData.subscriptionId && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">选择资源 (可选)</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-4 bg-slate-50 rounded-2xl border border-slate-200 max-h-48 overflow-y-auto custom-scrollbar">
                    {resources.map(res => (
                      <label key={res.id} className="flex items-center gap-2 cursor-pointer group">
                        <div 
                          onClick={() => {
                            const newIds = [...(formData.resourceIds || [])];
                            const index = newIds.indexOf(res.id);
                            if (index > -1) newIds.splice(index, 1);
                            else newIds.push(res.id);
                            setFormData({...formData, resourceIds: newIds});
                          }}
                          className={`w-4 h-4 rounded border flex items-center justify-center transition-all ${
                            formData.resourceIds?.includes(res.id) ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 bg-white group-hover:border-[#0b57d0]'
                          }`}
                        >
                          {formData.resourceIds?.includes(res.id) && <Check size={12} className="text-white" />}
                        </div>
                        <span className="text-xs text-slate-600 truncate" title={res.title}>{res.title}</span>
                      </label>
                    ))}
                    {resources.length === 0 && <p className="col-span-2 text-center text-xs text-slate-500 py-4">该订阅暂无资源</p>}
                  </div>
                  <p className="text-[10px] text-slate-400">不勾选任何资源则生成该订阅下的所有资源。</p>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">排除模式 (正则, 可选)</label>
              <input
                type="text"
                value={formData.excludePattern || ''}
                onChange={e => setFormData({...formData, excludePattern: e.target.value})}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder="\.(txt|pdf)$"
              />
            </div>
            <div className="flex items-end pb-3">
              <Checkbox
                checked={formData.overwriteExisting}
                onChange={(v) => setFormData({ ...formData, overwriteExisting: v })}
                label="覆盖已存在的 .strm 文件"
              />
            </div>
          </div>

          {formData.type === 'normal' ? (
            <div className="p-4 rounded-2xl border border-slate-100 bg-slate-50/50 space-y-2">
              <Checkbox
                checked={formData.useStreamProxy !== false}
                onChange={(v) => setFormData({ ...formData, useStreamProxy: v })}
                label="使用系统中转生成 .strm"
              />
              <p className="text-[11px] text-slate-500 leading-relaxed pl-7">
                写入本系统 <code className="bg-slate-200/80 px-1 rounded">/api/stream</code> 代理地址，播放时实时换取直链，不依赖 Alist。
                中转模式必须指定云盘目录；请在系统设置中配置可被媒体服务器访问的基础地址（baseUrl）。
              </p>
            </div>
          ) : (
            <div className="p-4 rounded-2xl border border-blue-100 bg-blue-50/60">
              <p className="text-[11px] text-blue-800 leading-relaxed">
                订阅配置固定使用系统中转生成 .strm（播放时由服务端换取直链）。
              </p>
            </div>
          )}

          <div className="pt-4 border-t border-slate-100">
            <div className="flex items-center gap-6">
              <Checkbox
                checked={formData.enabled}
                onChange={(v) => setFormData({ ...formData, enabled: v })}
                label="启用配置"
              />
              <Checkbox
                checked={formData.enableCron}
                onChange={(v) => setFormData({ ...formData, enableCron: v })}
                label="定时任务"
              />
            </div>
          </div>

          {formData.enableCron && (
            <div className="space-y-2 animate-in slide-in-from-top-2 duration-200">
              <label className="text-sm font-medium text-slate-700">Cron 表达式</label>
              <input
                type="text"
                value={formData.cronExpression || ''}
                onChange={e => setFormData({ ...formData, cronExpression: e.target.value })}
                placeholder="例如：0 0 * * *"
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
          )}

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => setIsModalOpen(false)}
              className="px-6 py-3 bg-white border border-slate-300 text-slate-700 rounded-full font-medium hover:bg-slate-50 transition-all"
            >
              取消
            </button>
            <button
              type="submit"
              className="px-10 py-3 bg-[#0b57d0] text-white rounded-full font-medium shadow-lg hover:bg-[#0b57d0]/90 transition-all flex items-center gap-2"
            >
              <Check size={20} /> 保存配置
            </button>
          </div>
        </form>
      </Modal>

      <Modal 
        isOpen={isLazyModalOpen} 
        onClose={() => setIsLazyModalOpen(false)} 
        title="懒转存 STRM 生成"
        footer={null}
      >
        <form onSubmit={handleLazySubmit} className="space-y-6">
          <div className="p-4 rounded-2xl border border-blue-100 bg-blue-50/60">
            <p className="text-[11px] text-blue-800 leading-relaxed">
              懒转存 STRM 固定使用系统中转：先写代理地址，播放时再触发转存并返回直链。
            </p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">选择账号</label>
            <select
              value={lazyFormData.accountId}
              onChange={e => setLazyFormData({ ...lazyFormData, accountId: e.target.value })}
              required
              className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
            >
              <option value="">请选择账号...</option>
              {accounts.map(acc => (
                <option key={acc.id} value={acc.id}>{acc.alias || acc.username}</option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
             <label className="text-sm font-medium text-slate-700">分享链接</label>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={lazyFormData.shareLink}
                  onChange={e => setLazyFormData({ ...lazyFormData, shareLink: e.target.value })}
                  required
                  placeholder="分享链接"
                  className="flex-1 px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                />
                <input
                  type="text"
                  value={lazyFormData.accessCode}
                  onChange={e => setLazyFormData({ ...lazyFormData, accessCode: e.target.value })}
                  placeholder="访问码"
                  className="w-28 px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                />
              </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">保存目录</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={lazyFormData.targetFolder || lazyFormData.targetFolderId}
                  readOnly
                  placeholder="根目录"
                  className="flex-1 px-5 py-3 bg-slate-100 border border-slate-300 rounded-2xl text-sm outline-none text-slate-500"
                />
                <button 
                  type="button" 
                  onClick={() => setIsLazyFolderSelectorOpen(true)}
                  disabled={!lazyFormData.accountId}
                  className="px-4 py-3 bg-white border border-slate-300 rounded-2xl text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-50"
                >
                  <Folder size={20} />
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">本地路径前缀 (可选)</label>
              <input
                type="text"
                value={lazyFormData.localPathPrefix || ''}
                onChange={e => setLazyFormData({...lazyFormData, localPathPrefix: e.target.value})}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder="留空 或 emby（相对 STRM 根，勿填绝对路径）"
              />
              <p className="text-[11px] leading-relaxed text-slate-500">
                相对「应用 STRM 根目录」的前缀。物理根在 Docker 中多为
                <code className="mx-1 rounded bg-slate-100 px-1">/home/strm</code>
                。
                <code className="mx-1 rounded bg-slate-100 px-1">/strm</code>
                /
                <code className="mx-1 rounded bg-slate-100 px-1">strm</code>
                会当空前缀，避免
                <code className="mx-1 rounded bg-slate-100 px-1">strm/strm</code>
                。
              </p>
            </div>
          </div>

          <div className="flex items-end pb-3">
              <Checkbox
                checked={lazyFormData.overwriteExisting}
                onChange={(v) => setLazyFormData({ ...lazyFormData, overwriteExisting: v })}
                label="覆盖已存在的 .strm 文件"
              />
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => setIsLazyModalOpen(false)}
              className="px-6 py-3 bg-white border border-slate-300 text-slate-700 rounded-full font-medium hover:bg-slate-50 transition-all"
            >
              取消
            </button>
            <button
              type="submit"
              className="px-10 py-3 bg-[#0b57d0] text-white rounded-full font-medium shadow-lg hover:bg-[#0b57d0]/90 transition-all flex items-center gap-2"
            >
              <Check size={20} /> 立即生成
            </button>
          </div>
        </form>
      </Modal>

      <FolderSelector
        isOpen={isFolderSelectorOpen}
        onClose={() => setIsFolderSelectorOpen(false)}
        title={`选择目录 - ${getAccountLabel(selectorAccountId || 0)}`}
        accountId={selectorAccountId || 0}
        accountName={getAccountLabel(selectorAccountId || 0)}
        onSelect={handleSelectFolder}
      />

      <FolderSelector
        isOpen={isLazyFolderSelectorOpen}
        onClose={() => setIsLazyFolderSelectorOpen(false)}
        title={`选择生成目录`}
        accountId={Number(lazyFormData.accountId)}
        accountName={getAccountLabel(Number(lazyFormData.accountId))}
        onSelect={(folder: SelectedFolder) => {
          setLazyFormData(prev => ({ 
            ...prev, 
            accountId: String(folder.accountId),
            targetFolderId: folder.id, 
            targetFolder: folder.name 
          }));
        }}
      />
    </div>
  );
};

export default StrmConfigTab;
