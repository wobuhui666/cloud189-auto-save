import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Rss, MoreVertical, RefreshCw, Edit2, Trash2, Folder, ExternalLink, Search, ChevronLeft, Play, Info, CheckCircle2, AlertCircle, HelpCircle } from 'lucide-react';
import Modal from '../Modal';

interface Subscription {
  id: number;
  name: string;
  uuid: string;
  remark: string | null;
  enabled: boolean;
  selectedShareCodes?: string[];
  resourceCount: number;
  validResourceCount: number;
  lastRefreshStatus: 'success' | 'warning' | 'failed' | 'unknown';
  lastRefreshMessage: string | null;
  lastRefreshTime: string | null;
  availableAccountCount: number;
  totalAccountCount: number;
}

interface ResourceAccount {
  id: number;
  name: string;
}

interface VerifyDetail {
  accountName: string;
  status: 'valid' | 'invalid';
  error: string | null;
}

interface Resource {
  id: number;
  subscriptionId: number;
  title: string;
  shareLink: string;
  accessCode: string | null;
  isFolder: boolean;
  verifyStatus: 'valid' | 'invalid' | 'unknown';
  lastVerifyError: string | null;
  availableAccounts: ResourceAccount[];
  verifyDetails: VerifyDetail[];
  lastVerifiedAt: string | null;
  updatedAt: string | null;
}

interface BrowserEntry {
  id: string;
  name: string;
  isFolder: boolean;
  canSave: boolean;
}

interface PreviewInfo {
  uuid: string;
  looksLikeUuid: boolean;
  accountCount: number;
  defaultAccount: { id: number; name: string } | null;
  canCreate: boolean;
  existingSubscription: { id: number; name: string; enabled: boolean } | null;
  remoteResourceCount?: number | null;
  remoteSubscriptionDetected?: boolean;
  recommendation: string;
}

interface RemoteSubscriptionResource {
  id: string;
  title: string;
  shareCode: string;
  shareLink: string;
  isFolder: boolean;
  shareId: string;
  shareType: string;
  createDate: string | null;
  lastOpTime: string | null;
}

interface SubscriptionTabProps {
  onTransfer?: (initialData: any) => void;
}

const SUBSCRIPTION_MENU_WIDTH = 128;
const SUBSCRIPTION_MENU_VIEWPORT_GAP = 12;

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

const normalizeShareCodes = (values: string[] = []) => Array.from(new Set(
  values
    .map(value => String(value || '').trim())
    .filter(Boolean)
));

const SubscriptionTab: React.FC<SubscriptionTabProps> = ({ onTransfer }) => {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [openSubscriptionMenuId, setOpenSubscriptionMenuId] = useState<number | null>(null);
  const [subscriptionMenuPosition, setSubscriptionMenuPosition] = useState<{ top: number; left: number } | null>(null);
  
  // Subscription Modal State
  const [isSubModalOpen, setIsSubModalOpen] = useState(false);
  const [editingSub, setEditingSub] = useState<Subscription | null>(null);
  const [subFormData, setSubFormData] = useState({
    uuid: '',
    name: '',
    remark: '',
    enabled: true,
    selectedShareCodes: [] as string[]
  });
  const [previewInfo, setPreviewInfo] = useState<PreviewInfo | null>(null);
  const [isRemoteSelectorOpen, setIsRemoteSelectorOpen] = useState(false);
  const [remoteSelectorLoading, setRemoteSelectorLoading] = useState(false);
  const [remoteSelectorItems, setRemoteSelectorItems] = useState<RemoteSubscriptionResource[]>([]);
  const [remoteSelectorKeyword, setRemoteSelectorKeyword] = useState('');
  const [remoteSelectorPageNum, setRemoteSelectorPageNum] = useState(1);
  const [remoteSelectorTotalCount, setRemoteSelectorTotalCount] = useState(0);
  const [remoteSelectorTotalPages, setRemoteSelectorTotalPages] = useState(0);
  const [remoteSelectorSelectedShareCodes, setRemoteSelectorSelectedShareCodes] = useState<string[]>([]);
  const [remoteSelectorUuid, setRemoteSelectorUuid] = useState('');
  const remoteSelectorPageSize = 20;

  // Resources Modal State
  const [isResModalOpen, setIsResModalOpen] = useState(false);
  const [currentSub, setCurrentSub] = useState<Subscription | null>(null);
  const [resources, setResources] = useState<Resource[]>([]);
  const [resLoading, setResLoading] = useState(false);

  // Add Resource Modal State
  const [isAddResModalOpen, setIsAddResModalOpen] = useState(false);
  const [resFormData, setResFormData] = useState({
    title: '',
    shareLink: '',
    accessCode: ''
  });

  // Browser Modal State
  const [isBrowserOpen, setIsBrowserOpen] = useState(false);
  const [browserResourceId, setBrowserResourceId] = useState<number | null>(null);
  const [browserTitle, setBrowserTitle] = useState('');
  const [browserStack, setBrowserStack] = useState<{ id: string, name: string }[]>([]);
  const [browserEntries, setBrowserEntries] = useState<BrowserEntry[]>([]);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserKeyword, setBrowserKeyword] = useState('');

  // Details Modal State
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [detailResource, setDetailResource] = useState<Resource | null>(null);

  const fetchSubscriptions = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/subscriptions');
      const data = await response.json();
      if (data.success) {
        setSubscriptions(data.data || []);
      }
    } catch (error) {
      console.error('Failed to fetch subscriptions:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSubscriptions();
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('[data-subscription-item-menu]')) {
        setOpenSubscriptionMenuId(null);
        setSubscriptionMenuPosition(null);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenSubscriptionMenuId(null);
        setSubscriptionMenuPosition(null);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (openSubscriptionMenuId === null) {
      return;
    }

    const closeMenu = () => {
      setOpenSubscriptionMenuId(null);
      setSubscriptionMenuPosition(null);
    };

    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [openSubscriptionMenuId]);

  const handlePreviewUuid = async (uuid: string) => {
    if (!uuid.trim()) {
      setPreviewInfo(null);
      return;
    }
    try {
      const response = await fetch(`/api/subscriptions/preview?uuid=${encodeURIComponent(uuid.trim())}`);
      const data = await response.json();
      if (data.success) {
        setPreviewInfo(data.data);
      }
    } catch (error) {
      console.error('Preview failed:', error);
    }
  };

  const handleOpenAddSub = () => {
    setEditingSub(null);
    setSubFormData({ uuid: '', name: '', remark: '', enabled: true, selectedShareCodes: [] });
    setPreviewInfo(null);
    setIsSubModalOpen(true);
  };

  const handleEditSub = (sub: Subscription) => {
    setEditingSub(sub);
    setSubFormData({
      uuid: sub.uuid,
      name: sub.name || '',
      remark: sub.remark || '',
      enabled: sub.enabled,
      selectedShareCodes: normalizeShareCodes(sub.selectedShareCodes || [])
    });
    setPreviewInfo(null);
    setIsSubModalOpen(true);
    handlePreviewUuid(sub.uuid);
  };

  const handleSaveSub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSub && previewInfo && !previewInfo.canCreate) {
      if (!confirm('预检查建议不创建，确定要继续吗？')) return;
    }
    try {
      const url = editingSub ? `/api/subscriptions/${editingSub.id}` : '/api/subscriptions';
      const response = await fetch(url, {
        method: editingSub ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subFormData)
      });
      const data = await response.json();
      if (data.success) {
        setIsSubModalOpen(false);
        fetchSubscriptions();
      } else {
        alert('保存失败: ' + data.error);
      }
    } catch (error) {
      alert('操作失败');
    }
  };

  const fetchRemoteSubscriptionResources = async (pageNum: number = 1, keyword: string = remoteSelectorKeyword) => {
    if (!subFormData.uuid.trim()) {
      alert('请先填写 UUID / 订阅主页链接');
      return;
    }

    setRemoteSelectorLoading(true);
    try {
      const query = new URLSearchParams({
        uuid: subFormData.uuid.trim(),
        pageNum: String(pageNum),
        pageSize: String(remoteSelectorPageSize),
        keyword: keyword.trim()
      });
      const response = await fetch(`/api/subscriptions/remote-resources?${query.toString()}`);
      const data = await response.json();
      if (data.success) {
        setRemoteSelectorItems(data.data?.items || []);
        setRemoteSelectorPageNum(data.data?.pageNum || pageNum);
        setRemoteSelectorTotalCount(data.data?.count || 0);
        setRemoteSelectorTotalPages(data.data?.totalPages || 0);
        setRemoteSelectorUuid(data.data?.uuid || '');
      } else {
        alert('加载订阅链接失败: ' + data.error);
      }
    } catch (error) {
      alert('加载订阅链接失败');
    } finally {
      setRemoteSelectorLoading(false);
    }
  };

  const handleOpenRemoteSelector = async () => {
    setRemoteSelectorKeyword('');
    setRemoteSelectorPageNum(1);
    setRemoteSelectorItems([]);
    setRemoteSelectorTotalCount(0);
    setRemoteSelectorTotalPages(0);
    setRemoteSelectorUuid('');
    setRemoteSelectorSelectedShareCodes(normalizeShareCodes(subFormData.selectedShareCodes));
    setIsRemoteSelectorOpen(true);
    fetchRemoteSubscriptionResources(1, '');
  };

  const handleToggleRemoteShareCode = (shareCode: string) => {
    setRemoteSelectorSelectedShareCodes(prev => (
      prev.includes(shareCode)
        ? prev.filter(code => code !== shareCode)
        : [...prev, shareCode]
    ));
  };

  const handleApplyRemoteSelector = () => {
    setSubFormData(prev => ({
      ...prev,
      selectedShareCodes: normalizeShareCodes(remoteSelectorSelectedShareCodes)
    }));
    setIsRemoteSelectorOpen(false);
  };

  const handleDeleteSub = async (id: number) => {
    if (!confirm('确定要删除这个订阅吗？对应资源也会一起删除')) return;
    try {
      const response = await fetch(`/api/subscriptions/${id}`, { method: 'DELETE' });
      const data = await response.json();
      if (data.success) {
        fetchSubscriptions();
      }
    } catch (error) {
      alert('操作失败');
    }
  };

  const handleToggleSub = async (sub: Subscription) => {
    try {
      const response = await fetch(`/api/subscriptions/${sub.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !sub.enabled })
      });
      const data = await response.json();
      if (data.success) {
        fetchSubscriptions();
      }
    } catch (error) {
      alert('操作失败');
    }
  };

  const handleRefreshSub = async (id: number) => {
    try {
      const response = await fetch(`/api/subscriptions/${id}/refresh`, { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        fetchSubscriptions();
        if (isResModalOpen && currentSub?.id === id) {
          fetchResources(id);
        }
        const result = data.data || {};
        alert(`订阅校验完成，可用 ${result.validResourceCount || 0} 个，异常 ${result.invalidResourceCount || 0} 个`);
      }
    } catch (error) {
      alert('操作失败');
    }
  };

  const closeSubscriptionMenu = () => {
    setOpenSubscriptionMenuId(null);
    setSubscriptionMenuPosition(null);
  };

  const handleToggleSubscriptionMenu = (subId: number, event: React.MouseEvent<HTMLButtonElement>) => {
    if (openSubscriptionMenuId === subId) {
      closeSubscriptionMenu();
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const left = Math.max(
      SUBSCRIPTION_MENU_VIEWPORT_GAP,
      Math.min(
        rect.right - SUBSCRIPTION_MENU_WIDTH,
        window.innerWidth - SUBSCRIPTION_MENU_WIDTH - SUBSCRIPTION_MENU_VIEWPORT_GAP
      )
    );

    setSubscriptionMenuPosition({
      top: rect.bottom + 4,
      left
    });
    setOpenSubscriptionMenuId(subId);
  };

  const activeSubscriptionMenu = openSubscriptionMenuId === null
    ? null
    : subscriptions.find(item => item.id === openSubscriptionMenuId) || null;

  const fetchResources = async (subId: number) => {
    setResLoading(true);
    try {
      const response = await fetch(`/api/subscriptions/${subId}/resources`);
      const data = await response.json();
      if (data.success) {
        setResources(data.data || []);
      }
    } catch (error) {
      console.error('Failed to fetch resources:', error);
    } finally {
      setResLoading(false);
    }
  };

  const handleOpenResources = (sub: Subscription) => {
    setCurrentSub(sub);
    fetchResources(sub.id);
    setIsResModalOpen(true);
  };

  const handleSaveResource = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentSub) return;
    try {
      const response = await fetch(`/api/subscriptions/${currentSub.id}/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resFormData)
      });
      const data = await response.json();
      if (data.success) {
        setIsAddResModalOpen(false);
        fetchResources(currentSub.id);
        fetchSubscriptions();
      } else {
        alert('保存失败: ' + data.error);
      }
    } catch (error) {
      alert('操作失败');
    }
  };

  const handleDeleteResource = async (id: number) => {
    if (!confirm('确定要删除这个资源吗？')) return;
    try {
      const response = await fetch(`/api/subscriptions/resources/${id}`, { method: 'DELETE' });
      const data = await response.json();
      if (data.success) {
        if (currentSub) fetchResources(currentSub.id);
        fetchSubscriptions();
      }
    } catch (error) {
      alert('操作失败');
    }
  };

  const fetchBrowserEntries = async (resId: number, folderId: string = '', keyword: string = '') => {
    setBrowserLoading(true);
    try {
      const response = await fetch(`/api/subscriptions/resources/${resId}/browse?folderId=${encodeURIComponent(folderId)}&keyword=${encodeURIComponent(keyword)}`);
      const data = await response.json();
      if (data.success) {
        setBrowserEntries(data.data || []);
      }
    } catch (error) {
      console.error('Failed to browse resources:', error);
    } finally {
      setBrowserLoading(false);
    }
  };

  const handleOpenBrowser = (resource: Resource) => {
    setBrowserResourceId(resource.id);
    setBrowserTitle(resource.title);
    setBrowserStack([]);
    setBrowserKeyword('');
    setBrowserEntries([]);
    setIsBrowserOpen(true);
    fetchBrowserEntries(resource.id);
  };

  const handleEnterFolder = (entry: BrowserEntry) => {
    const newStack = [...browserStack, { id: entry.id, name: entry.name }];
    setBrowserStack(newStack);
    setBrowserKeyword('');
    fetchBrowserEntries(browserResourceId!, entry.id);
  };

  const handleGoBack = () => {
    const newStack = [...browserStack];
    newStack.pop();
    setBrowserStack(newStack);
    setBrowserKeyword('');
    const parentFolder = newStack[newStack.length - 1];
    fetchBrowserEntries(browserResourceId!, parentFolder?.id || '');
  };

  const handleSearchBrowser = () => {
    const currentFolder = browserStack[browserStack.length - 1];
    fetchBrowserEntries(browserResourceId!, currentFolder?.id || '', browserKeyword);
  };

  const handleRefreshBrowser = () => {
    const currentFolder = browserStack[browserStack.length - 1];
    fetchBrowserEntries(browserResourceId!, currentFolder?.id || '', browserKeyword);
  };

  const handleTransfer = (resId: number, entry?: BrowserEntry) => {
    const resource = resources.find(r => r.id === resId);
    if (!resource) return;
    
    if (onTransfer) {
      onTransfer({
        shareLink: resource.shareLink,
        accessCode: resource.accessCode || '',
        taskName: entry?.name || resource.title,
        shareFolderId: entry?.canSave ? entry.id : null
      });
      setIsBrowserOpen(false);
      setIsResModalOpen(false);
    } else {
      alert('转存组件未就绪');
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'success': return <CheckCircle2 size={16} className="text-[#0d4f1f]" />;
      case 'warning': return <AlertCircle size={16} className="text-[#7d5700]" />;
      case 'failed': return <AlertCircle size={16} className="text-[#b3261e]" />;
      default: return <HelpCircle size={16} className="text-slate-400" />;
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'success': return '正常';
      case 'warning': return '部分异常';
      case 'failed': return '异常';
      default: return '未校验';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'success': return 'bg-[#c4eed0] text-[#0d4f1f]';
      case 'warning': return 'bg-[#ffdf99] text-[#7d5700]';
      case 'failed': return 'bg-[#f9dadc] text-[#b3261e]';
      default: return 'bg-slate-100 text-slate-500';
    }
  };

  const getVerifyStatusColor = (status: string) => {
    switch (status) {
      case 'valid': return 'text-green-600';
      case 'invalid': return 'text-red-600';
      default: return 'text-slate-400';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <button 
          onClick={handleOpenAddSub}
          className="bg-[#0b57d0] text-white px-6 py-2.5 rounded-full text-sm font-medium hover:bg-[#0b57d0]/90 transition-all shadow-sm flex items-center gap-2"
        >
          <Plus size={18} /> 添加订阅
        </button>
      </div>
      
      <div className="bg-white rounded-3xl border border-slate-200/60 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50/50 border-b border-slate-100">
              <tr>
                <th className="px-6 py-4 font-medium text-slate-500">名称</th>
                <th className="px-6 py-4 font-medium text-slate-500">UUID</th>
                <th className="px-6 py-4 font-medium text-slate-500">资源数</th>
                <th className="px-6 py-4 font-medium text-slate-500">状态</th>
                <th className="px-6 py-4 font-medium text-slate-500">账号覆盖</th>
                <th className="px-6 py-4 font-medium text-slate-500">最后检查</th>
                <th className="px-6 py-4 font-medium text-slate-500 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-6 py-4 text-center text-slate-500">加载中...</td>
                </tr>
              ) : subscriptions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-4 text-center text-slate-500">暂无订阅</td>
                </tr>
              ) : subscriptions.map(sub => (
                <tr key={sub.id} className="hover:bg-slate-50/50 transition-colors group">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-xl ${getStatusColor(sub.lastRefreshStatus)}`}>
                        <Rss size={20} />
                      </div>
                      <div className="flex flex-col">
                        <span className="font-medium text-slate-900 truncate max-w-[150px]" title={sub.name}>{sub.name}</span>
                        {!sub.enabled && <span className="text-[10px] text-red-500 font-bold uppercase">已禁用</span>}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 font-mono text-xs text-slate-500">{sub.uuid}</td>
                  <td className="px-6 py-4 text-slate-600">{sub.resourceCount}</td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-1.5" title={sub.lastRefreshMessage || ''}>
                      {getStatusIcon(sub.lastRefreshStatus)}
                      <span className="text-xs font-medium">
                        {getStatusText(sub.lastRefreshStatus)} ({sub.validResourceCount}/{sub.resourceCount})
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-slate-600">
                    {sub.availableAccountCount}/{sub.totalAccountCount}
                  </td>
                  <td className="px-6 py-4 text-slate-500">{formatDateTime(sub.lastRefreshTime)}</td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button 
                        onClick={() => handleOpenResources(sub)}
                        className="p-2 hover:bg-[#0b57d0]/10 rounded-full text-[#0b57d0] transition-colors"
                        title="查看资源"
                      >
                        <Folder size={18} />
                      </button>
                      <button 
                        onClick={() => handleRefreshSub(sub.id)}
                        className="p-2 hover:bg-slate-100 rounded-full text-slate-500 transition-colors"
                        title="立即校验"
                      >
                        <RefreshCw size={18} />
                      </button>
                      <div className="relative" data-subscription-item-menu>
                        <button
                          type="button"
                          onClick={(event) => handleToggleSubscriptionMenu(sub.id, event)}
                          className="p-2 hover:bg-slate-100 rounded-full text-slate-500 hover:text-slate-900 transition-colors"
                          aria-label={`打开 ${sub.name} 的操作菜单`}
                          aria-expanded={openSubscriptionMenuId === sub.id}
                        >
                          <MoreVertical size={18} />
                        </button>
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
        isOpen={isSubModalOpen} 
        onClose={() => setIsSubModalOpen(false)} 
        title={editingSub ? "编辑订阅" : "添加订阅"}
      >
        <form id="modal-form" onSubmit={handleSaveSub} className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">UUID / 订阅主页链接</label>
            <input 
              type="text" 
              value={subFormData.uuid}
              onChange={e => {
                setSubFormData({
                  ...subFormData,
                  uuid: e.target.value,
                  selectedShareCodes: []
                });
                setPreviewInfo(null);
              }}
              onBlur={e => handlePreviewUuid(e.target.value)}
              required 
              className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20" 
              placeholder="支持直接粘贴 UUID 或 21cn 订阅主页链接"
            />
            <p className="text-xs leading-relaxed text-slate-500">
              例如：<span className="font-mono">https://content.21cn.com/h5/subscrip/index.html#/pages/own-home/index?uuid=...</span>
            </p>
            {previewInfo && (
              <div className="mt-2 p-4 bg-slate-100 rounded-2xl space-y-2 text-xs border border-slate-200">
                <div className="flex justify-between">
                  <span className="text-slate-500">UUID 格式</span>
                  <span className={previewInfo.looksLikeUuid ? 'text-green-600' : 'text-red-600'}>
                    {previewInfo.looksLikeUuid ? '通过' : '可疑'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">可用账号</span>
                  <span>{previewInfo.accountCount} {previewInfo.defaultAccount && `(默认: ${previewInfo.defaultAccount.name})`}</span>
                </div>
                {previewInfo.remoteSubscriptionDetected && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">远程资源</span>
                    <span>{previewInfo.remoteResourceCount ?? 0}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-slate-500">结论</span>
                  <span className={previewInfo.canCreate ? 'text-green-600' : 'text-orange-600'}>
                    {previewInfo.canCreate ? '可以创建' : '建议先处理提示项'}
                  </span>
                </div>
                {previewInfo.existingSubscription && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">已有订阅</span>
                    <span>{previewInfo.existingSubscription.name} ({previewInfo.existingSubscription.enabled ? '启用' : '停用'})</span>
                  </div>
                )}
                <div className="pt-1 text-slate-700 leading-relaxed">
                  <strong>建议:</strong> {previewInfo.recommendation}
                </div>
              </div>
            )}
            {previewInfo?.remoteSubscriptionDetected && (
              <div className="mt-3 p-4 bg-[#f8fbff] rounded-2xl border border-[#d7e7ff] space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-slate-900">订阅内链接选择</div>
                    <div className="text-xs text-slate-500 mt-1">
                      当前已选 {subFormData.selectedShareCodes.length} 项，未选择时默认全量同步。
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleOpenRemoteSelector}
                      className="px-4 py-2 rounded-full text-xs font-medium bg-[#0b57d0] text-white hover:bg-[#0b57d0]/90 transition-colors"
                    >
                      选择订阅链接
                    </button>
                    <button
                      type="button"
                      onClick={() => setSubFormData({ ...subFormData, selectedShareCodes: [] })}
                      disabled={subFormData.selectedShareCodes.length === 0}
                      className="px-4 py-2 rounded-full text-xs font-medium border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-40"
                    >
                      清空选择
                    </button>
                  </div>
                </div>
                {subFormData.selectedShareCodes.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {subFormData.selectedShareCodes.slice(0, 8).map(shareCode => (
                      <span
                        key={shareCode}
                        className="px-3 py-1 rounded-full bg-white border border-[#d7e7ff] text-[11px] font-mono text-slate-600"
                      >
                        {shareCode}
                      </span>
                    ))}
                    {subFormData.selectedShareCodes.length > 8 && (
                      <span className="px-3 py-1 rounded-full bg-white border border-[#d7e7ff] text-[11px] text-slate-500">
                        +{subFormData.selectedShareCodes.length - 8} 项
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">名称 (可选)</label>
            <input 
              type="text" 
              value={subFormData.name}
              onChange={e => setSubFormData({...subFormData, name: e.target.value})}
              className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20" 
              placeholder="默认为 UUID 或自动获取"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">备注</label>
            <textarea 
              value={subFormData.remark}
              onChange={e => setSubFormData({...subFormData, remark: e.target.value})}
              className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20" 
              rows={2}
            />
          </div>
          <label className="flex items-center gap-3 cursor-pointer">
            <input 
              type="checkbox" 
              checked={subFormData.enabled}
              onChange={e => setSubFormData({...subFormData, enabled: e.target.checked})}
              className="w-4 h-4 rounded border-slate-300 text-[#0b57d0] focus:ring-[#0b57d0]/20"
            />
            <span className="text-sm font-medium text-slate-700">启用此订阅</span>
          </label>
        </form>
      </Modal>

      <Modal
        isOpen={isRemoteSelectorOpen}
        onClose={() => setIsRemoteSelectorOpen(false)}
        title="选择订阅里的链接"
        footer={
          <div className="px-8 py-6 flex justify-between gap-3 border-t border-slate-100">
            <div className="text-xs text-slate-500 self-center">
              已选 {remoteSelectorSelectedShareCodes.length} 项
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setIsRemoteSelectorOpen(false)}
                className="px-6 py-2.5 rounded-full text-sm font-medium text-[#0b57d0] hover:bg-[#0b57d0]/10 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleApplyRemoteSelector}
                className="px-6 py-2.5 rounded-full text-sm font-medium bg-[#0b57d0] text-white hover:bg-[#0b57d0]/90 transition-colors shadow-sm"
              >
                应用选择
              </button>
            </div>
          </div>
        }
      >
        <div className="space-y-4 pt-6">
          <div className="rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-3 text-xs text-slate-600">
            <div className="font-medium text-slate-900">UUID</div>
            <div className="mt-1 font-mono break-all">{remoteSelectorUuid || subFormData.uuid || '-'}</div>
            <div className="mt-2 text-slate-500">
              保存后仅同步勾选的链接；如果不勾选，则仍按整个订阅全量同步。
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex-1 relative">
              <input
                type="text"
                value={remoteSelectorKeyword}
                onChange={e => setRemoteSelectorKeyword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && fetchRemoteSubscriptionResources(1, remoteSelectorKeyword)}
                placeholder="按标题搜索订阅里的链接"
                className="w-full pl-12 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
              <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
            </div>
            <button
              type="button"
              onClick={() => fetchRemoteSubscriptionResources(1, remoteSelectorKeyword)}
              className="px-4 py-2.5 bg-[#0b57d0] text-white rounded-2xl text-sm font-medium hover:bg-[#0b57d0]/90 transition-colors"
            >
              搜索
            </button>
            <button
              type="button"
              onClick={() => {
                setRemoteSelectorKeyword('');
                fetchRemoteSubscriptionResources(1, '');
              }}
              className="px-4 py-2.5 border border-slate-200 rounded-2xl text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
            >
              重置
            </button>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>远程共 {remoteSelectorTotalCount} 项</span>
            <span>第 {remoteSelectorPageNum} / {Math.max(remoteSelectorTotalPages, 1)} 页</span>
          </div>

          <div className="max-h-[420px] overflow-y-auto rounded-2xl border border-slate-100">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50/70 sticky top-0 backdrop-blur-sm border-b border-slate-100">
                <tr>
                  <th className="px-4 py-3 font-medium text-slate-500 w-12">选择</th>
                  <th className="px-4 py-3 font-medium text-slate-500">资源</th>
                  <th className="px-4 py-3 font-medium text-slate-500">类型</th>
                  <th className="px-4 py-3 font-medium text-slate-500">分享码</th>
                  <th className="px-4 py-3 font-medium text-slate-500">更新时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {remoteSelectorLoading ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-500">加载中...</td>
                  </tr>
                ) : remoteSelectorItems.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-500">当前没有可选链接</td>
                  </tr>
                ) : remoteSelectorItems.map(item => (
                  <tr key={item.shareCode} className="hover:bg-slate-50/60 transition-colors">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={remoteSelectorSelectedShareCodes.includes(item.shareCode)}
                        onChange={() => handleToggleRemoteShareCode(item.shareCode)}
                        className="w-4 h-4 rounded border-slate-300 text-[#0b57d0] focus:ring-[#0b57d0]/20"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <span className="font-medium text-slate-900 break-all">{item.title}</span>
                        <a
                          href={item.shareLink}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[11px] text-[#0b57d0] hover:underline"
                        >
                          打开详情链接
                        </a>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-500 text-xs">{item.isFolder ? '文件夹' : '文件'}</td>
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-500 break-all">{item.shareCode}</td>
                    <td className="px-4 py-3 text-[11px] text-slate-500">
                      {formatDateTime(item.lastOpTime || item.createDate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => fetchRemoteSubscriptionResources(remoteSelectorPageNum - 1, remoteSelectorKeyword)}
              disabled={remoteSelectorPageNum <= 1 || remoteSelectorLoading}
              className="px-4 py-2 rounded-full border border-slate-200 text-sm text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-40"
            >
              上一页
            </button>
            <button
              type="button"
              onClick={() => fetchRemoteSubscriptionResources(remoteSelectorPageNum + 1, remoteSelectorKeyword)}
              disabled={remoteSelectorPageNum >= remoteSelectorTotalPages || remoteSelectorLoading || remoteSelectorTotalPages === 0}
              className="px-4 py-2 rounded-full border border-slate-200 text-sm text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={isResModalOpen}
        onClose={() => setIsResModalOpen(false)}
        title={`${currentSub?.name || '订阅'} 的资源`}
        footer={
          <div className="px-8 py-6 flex justify-between gap-3 border-t border-slate-100">
            <button 
              onClick={() => handleRefreshSub(currentSub!.id)}
              className="px-6 py-2.5 rounded-full text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors flex items-center gap-2"
            >
              <RefreshCw size={16} /> 全部校验
            </button>
            <div className="flex gap-3">
              <button 
                onClick={() => setIsResModalOpen(false)} 
                className="px-6 py-2.5 rounded-full text-sm font-medium text-[#0b57d0] hover:bg-[#0b57d0]/10 transition-colors"
              >
                关闭
              </button>
              <button 
                onClick={() => setIsAddResModalOpen(true)}
                className="px-6 py-2.5 rounded-full text-sm font-medium bg-[#0b57d0] text-white hover:bg-[#0b57d0]/90 transition-colors shadow-sm flex items-center gap-2"
              >
                <Plus size={16} /> 添加资源
              </button>
            </div>
          </div>
        }
      >
        <div className="min-h-[400px] overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-slate-50/50 border-b border-slate-100">
              <tr>
                <th className="px-4 py-3 font-medium text-slate-500">资源</th>
                <th className="px-4 py-3 font-medium text-slate-500">类型</th>
                <th className="px-4 py-3 font-medium text-slate-500">状态</th>
                <th className="px-4 py-3 font-medium text-slate-500">可用账号</th>
                <th className="px-4 py-3 font-medium text-slate-500">最后校验</th>
                <th className="px-4 py-3 font-medium text-slate-500">更新于</th>
                <th className="px-4 py-3 font-medium text-slate-500 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {resLoading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">加载中...</td>
                </tr>
              ) : resources.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">暂无资源</td>
                </tr>
              ) : resources.map(res => (
                <tr key={res.id} className="hover:bg-slate-50/50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex flex-col max-w-[200px]">
                      <span className="font-medium text-slate-900 truncate" title={res.title}>{res.title}</span>
                      <a 
                        href={res.shareLink} 
                        target="_blank" 
                        rel="noreferrer" 
                        className="text-[10px] text-[#0b57d0] flex items-center gap-1 hover:underline truncate"
                      >
                        <ExternalLink size={10} /> 原始链接
                      </a>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs">{res.isFolder ? '文件夹' : '文件'}</td>
                  <td className="px-4 py-3">
                    <div 
                      className={`flex items-center gap-1 cursor-help ${getVerifyStatusColor(res.verifyStatus)}`}
                      title={res.lastVerifyError || '暂无说明'}
                      onClick={() => {
                        setDetailResource(res);
                        setIsDetailsOpen(true);
                      }}
                    >
                      <span className="text-xs font-medium">
                        {res.verifyStatus === 'valid' ? '可用' : res.verifyStatus === 'invalid' ? '失效' : '未知'}
                      </span>
                      <Info size={12} />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-600 text-xs">
                    {res.availableAccounts && res.availableAccounts.length > 0 
                      ? res.availableAccounts.map(a => a.name).join(' / ') 
                      : '-'}
                  </td>
                  <td className="px-4 py-3 text-slate-400 text-[10px]">{formatDateTime(res.lastVerifiedAt)}</td>
                  <td className="px-4 py-3 text-slate-400 text-[10px]">{formatDateTime(res.updatedAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button 
                        onClick={() => handleOpenBrowser(res)}
                        className="p-1.5 hover:bg-slate-100 rounded-full text-slate-500"
                        title="浏览内容"
                      >
                        <Folder size={16} />
                      </button>
                      <button 
                        onClick={() => handleTransfer(res.id)}
                        className="p-1.5 hover:bg-slate-100 rounded-full text-[#0b57d0]"
                        title="转存"
                      >
                        <Play size={16} />
                      </button>
                      <button 
                        onClick={() => handleDeleteResource(res.id)}
                        className="p-1.5 hover:bg-slate-100 rounded-full text-red-500"
                        title="删除"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>

      <Modal
        isOpen={isAddResModalOpen}
        onClose={() => setIsAddResModalOpen(false)}
        title="添加订阅资源"
        footer={null}
      >
        <form id="res-modal-form" onSubmit={handleSaveResource} className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">资源标题 (可选)</label>
            <input 
              type="text" 
              value={resFormData.title}
              onChange={e => setResFormData({...resFormData, title: e.target.value})}
              className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20" 
              placeholder="不填则自动获取"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">分享链接</label>
            <input 
              type="text" 
              value={resFormData.shareLink}
              onChange={e => setResFormData({...resFormData, shareLink: e.target.value})}
              required
              className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20" 
              placeholder="https://cloud.189.cn/t/..."
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">访问码 (可选)</label>
            <input 
              type="text" 
              value={resFormData.accessCode}
              onChange={e => setResFormData({...resFormData, accessCode: e.target.value})}
              className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20" 
              placeholder="4位数字"
            />
          </div>
          <div className="flex justify-end gap-3 pt-4">
            <button 
              type="button"
              onClick={() => setIsAddResModalOpen(false)} 
              className="px-6 py-2.5 rounded-full text-sm font-medium text-[#0b57d0] hover:bg-[#0b57d0]/10 transition-colors"
            >
              取消
            </button>
            <button 
              type="submit"
              className="px-6 py-2.5 rounded-full text-sm font-medium bg-[#0b57d0] text-white hover:bg-[#0b57d0]/90 transition-colors shadow-sm"
            >
              确认添加
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={isBrowserOpen}
        onClose={() => setIsBrowserOpen(false)}
        title={`资源浏览 - ${browserTitle}`}
        footer={null}
      >
        <div className="space-y-4">
          <div className="flex items-center gap-2 p-2 bg-slate-50 rounded-2xl overflow-x-auto text-xs text-slate-500 whitespace-nowrap scrollbar-none">
            <span className="shrink-0">{browserTitle}</span>
            {browserStack.map((folder, i) => (
              <React.Fragment key={folder.id}>
                <span>/</span>
                <span className={i === browserStack.length - 1 ? 'text-slate-900 font-medium' : ''}>{folder.name}</span>
              </React.Fragment>
            ))}
          </div>

          <div className="flex items-center gap-2">
            {browserStack.length > 0 && (
              <button 
                onClick={handleGoBack}
                className="p-2.5 hover:bg-slate-100 rounded-2xl text-slate-600 transition-colors border border-slate-200"
              >
                <ChevronLeft size={20} />
              </button>
            )}
            <div className="flex-1 relative">
              <input 
                type="text" 
                value={browserKeyword}
                onChange={e => setBrowserKeyword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearchBrowser()}
                placeholder="搜索资源..."
                className="w-full pl-12 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
              <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
            </div>
            <button 
              onClick={handleSearchBrowser}
              className="px-4 py-2.5 bg-[#0b57d0] text-white rounded-2xl text-sm font-medium hover:bg-[#0b57d0]/90 transition-colors"
            >
              搜索
            </button>
            <button 
              onClick={handleRefreshBrowser}
              className="p-2.5 hover:bg-slate-100 rounded-2xl text-slate-500 transition-colors border border-slate-200"
              title="刷新"
            >
              <RefreshCw size={20} className={browserLoading ? 'animate-spin' : ''} />
            </button>
          </div>

          <div className="max-h-[400px] overflow-y-auto rounded-2xl border border-slate-100">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50/50 sticky top-0 backdrop-blur-sm border-b border-slate-100">
                <tr>
                  <th className="px-4 py-3 font-medium text-slate-500">名称</th>
                  <th className="px-4 py-3 font-medium text-slate-500">类型</th>
                  <th className="px-4 py-3 font-medium text-slate-500 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {browserLoading ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-slate-500">加载中...</td>
                  </tr>
                ) : browserEntries.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-slate-500">当前目录没有内容</td>
                  </tr>
                ) : browserEntries.map(entry => (
                  <tr key={entry.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-4 py-3 font-medium text-slate-900 truncate max-w-[200px]" title={entry.name}>{entry.name}</td>
                    <td className="px-4 py-3 text-slate-500 text-xs">{entry.isFolder ? '目录' : '文件'}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {entry.isFolder && (
                          <button 
                            onClick={() => handleEnterFolder(entry)}
                            className="px-3 py-1.5 hover:bg-[#0b57d0]/10 text-[#0b57d0] rounded-xl text-xs font-medium"
                          >
                            进入
                          </button>
                        )}
                        {entry.canSave && (
                          <button 
                            onClick={() => handleTransfer(browserResourceId!, entry)}
                            className="px-3 py-1.5 bg-[#fabb05]/10 text-[#7d5700] hover:bg-[#fabb05]/20 rounded-xl text-xs font-medium"
                          >
                            转存
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={isDetailsOpen}
        onClose={() => setIsDetailsOpen(false)}
        title={`校验详情 - ${detailResource?.title}`}
        footer={
          <div className="px-8 py-6 flex justify-end border-t border-slate-100">
            <button 
              onClick={() => setIsDetailsOpen(false)} 
              className="px-6 py-2.5 rounded-full text-sm font-medium text-[#0b57d0] hover:bg-[#0b57d0]/10 transition-colors"
            >
              关闭
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          {!detailResource?.verifyDetails || detailResource.verifyDetails.length === 0 ? (
            <div className="text-center py-8 text-slate-500">暂无账号级校验记录</div>
          ) : (
            <div className="rounded-2xl border border-slate-100 overflow-hidden">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50/50 border-b border-slate-100">
                  <tr>
                    <th className="px-4 py-3 font-medium text-slate-500">账号</th>
                    <th className="px-4 py-3 font-medium text-slate-500">状态</th>
                    <th className="px-4 py-3 font-medium text-slate-500">说明</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {detailResource.verifyDetails.map((detail, i) => (
                    <tr key={i}>
                      <td className="px-4 py-3 font-medium">{detail.accountName}</td>
                      <td className="px-4 py-3 font-medium">
                        <span className={detail.status === 'valid' ? 'text-green-600' : 'text-red-600'}>
                          {detail.status === 'valid' ? '可用' : '失败'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-500 break-all">{detail.error || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Modal>
      {activeSubscriptionMenu && subscriptionMenuPosition && typeof document !== 'undefined' && createPortal(
          <div
            className="fixed w-32 bg-white rounded-xl shadow-lg border border-slate-100 py-1 z-[210]"
            style={subscriptionMenuPosition}
            data-subscription-item-menu
          >
            <button
              onClick={() => {
                closeSubscriptionMenu();
                handleEditSub(activeSubscriptionMenu);
              }}
              className="w-full px-4 py-2 text-left text-sm hover:bg-slate-50 flex items-center gap-2"
            >
              <Edit2 size={14} /> 编辑
            </button>
            <button
              onClick={() => {
                closeSubscriptionMenu();
                handleToggleSub(activeSubscriptionMenu);
              }}
              className={`w-full px-4 py-2 text-left text-sm hover:bg-slate-50 flex items-center gap-2 ${activeSubscriptionMenu.enabled ? 'text-orange-600' : 'text-green-600'}`}
            >
              {activeSubscriptionMenu.enabled ? '停用' : '启用'}
            </button>
            <button
              onClick={() => {
                closeSubscriptionMenu();
                handleDeleteSub(activeSubscriptionMenu.id);
              }}
              className="w-full px-4 py-2 text-left text-sm hover:bg-slate-50 flex items-center gap-2 text-red-600"
            >
              <Trash2 size={14} /> 删除
            </button>
          </div>,
          document.body
        )}
    </div>
  );
};

export default SubscriptionTab;
