import React, { useState, useEffect } from 'react';
import { Copy, Database, Plus, QrCode, RefreshCw, Trash2 } from 'lucide-react';
import Modal from '../Modal';
import { useToast } from '../ui/Toast';
import { useDialog } from '../ui/Dialog';

interface CapacityInfo {
  totalSize: number;
  usedSize: number;
}

interface Capacity {
  cloudCapacityInfo: CapacityInfo;
  familyCapacityInfo: CapacityInfo;
}

interface Account {
  id: number;
  username: string;
  original_username: string;
  alias: string | null;
  accountType: 'personal' | 'family';
  familyId: string | null;
  familyFolderId: string | null;
  isDefault: boolean;
  capacity: Capacity;
  cloudStrmPrefix: string | null;
  localStrmPrefix: string | null;
  embyPathReplace: string | null;
  password?: string;
  cookies?: string;
}

interface StorageSummary {
  enabled: boolean;
  cloud: { used: number; total: number };
  family: { used: number; total: number };
  accounts: Array<{
    id: number;
    username: string;
    alias?: string;
    accountType: 'personal' | 'family';
    cloud: CapacityInfo;
    family: CapacityInfo;
  }>;
}

const formatBytes = (bytes: number) => {
  if (!bytes || isNaN(bytes)) return '0B';
  if (bytes < 0) return '-' + formatBytes(-bytes);
  
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const base = 1024;
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(base)), units.length - 1);
  const value = bytes / Math.pow(base, exponent);
  
  return value.toFixed(exponent > 0 ? 2 : 0) + units[exponent];
};

const AccountTab: React.FC = () => {
  const toast = useToast();
  const dialog = useDialog();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [storageSummary, setStorageSummary] = useState<StorageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [capacityRefreshing, setCapacityRefreshing] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isQrModalOpen, setIsQrModalOpen] = useState(false);
  const [qrData, setQrData] = useState<any | null>(null);
  const [qrMessage, setQrMessage] = useState('等待扫码');
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [formData, setFormData] = useState({
    username: '',
    password: '',
    cookies: '',
    alias: '',
    accountType: 'personal' as 'personal' | 'family',
    familyId: '',
    familyFolderId: '',
    cloudStrmPrefix: '',
    localStrmPrefix: '',
    embyPathReplace: '',
    validateCode: ''
  });
  const [captchaInfo, setCaptchaInfo] = useState<{ url: string } | null>(null);

  const fetchAccounts = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/accounts');
      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }
      const data = await response.json();
      if (data.success) {
        setAccounts(data.data);
      }
    } catch (error) {
      console.error('Failed to fetch accounts:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchStorageSummary = async () => {
    try {
      const response = await fetch('/api/accounts/storage-summary');
      const data = await response.json();
      if (data.success) {
        setStorageSummary(data.data);
      }
    } catch (error) {
      console.error('Failed to fetch storage summary:', error);
    }
  };

  useEffect(() => {
    fetchAccounts();
    fetchStorageSummary();
  }, []);

  useEffect(() => {
    if (!isQrModalOpen || !qrData) return;

    let stopped = false;
    const pollQrStatus = async () => {
      try {
        const response = await fetch('/api/accounts/qr-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(qrData)
        });
        const data = await response.json();
        if (stopped) return;
        if (!data.success) {
          setQrMessage(data.error || '扫码状态检查失败');
          return;
        }
        setQrMessage(data.message || '等待确认');
        if (data.status === 0) {
          toast.success(`扫码登录成功: ${data.data?.username || ''}`);
          setIsQrModalOpen(false);
          setQrData(null);
          fetchAccounts();
          fetchStorageSummary();
        }
      } catch (error) {
        if (!stopped) {
          setQrMessage('扫码状态检查失败');
        }
      }
    };

    pollQrStatus();
    const timer = window.setInterval(pollQrStatus, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [isQrModalOpen, qrData, toast]);

  const handleOpenAddModal = () => {
    setEditingAccount(null);
    setFormData({
      username: '',
      password: '',
      cookies: '',
      alias: '',
      accountType: 'personal',
      familyId: '',
      familyFolderId: '',
      cloudStrmPrefix: '',
      localStrmPrefix: '',
      embyPathReplace: '',
      validateCode: ''
    });
    setCaptchaInfo(null);
    setIsModalOpen(true);
  };

  const handleEditAccount = (account: Account) => {
    setEditingAccount(account);
    setFormData({
      username: account.username,
      password: '', // Don't fill password for security
      cookies: account.cookies || '',
      alias: account.alias || '',
      accountType: account.accountType || 'personal',
      familyId: account.familyId || '',
      familyFolderId: account.familyFolderId || '',
      cloudStrmPrefix: account.cloudStrmPrefix || '',
      localStrmPrefix: account.localStrmPrefix || '',
      embyPathReplace: account.embyPathReplace || '',
      validateCode: ''
    });
    setCaptchaInfo(null);
    setIsModalOpen(true);
  };

  const handleOpenQrLogin = async () => {
    setQrMessage('正在获取二维码...');
    setQrData(null);
    setIsQrModalOpen(true);
    try {
      const response = await fetch('/api/accounts/qr-code');
      const data = await response.json();
      if (!data.success) {
        toast.error('获取二维码失败: ' + data.error);
        setQrMessage(data.error || '获取二维码失败');
        return;
      }
      setQrData(data.data);
      setQrMessage('等待扫码');
    } catch (error) {
      toast.error('获取二维码失败');
      setQrMessage('获取二维码失败');
    }
  };

  const handleRefreshCapacity = async (accountId?: number) => {
    setCapacityRefreshing(true);
    try {
      const response = await fetch('/api/accounts/refresh-capacity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(accountId ? { accountId } : {})
      });
      const data = await response.json();
      if (data.success) {
        const refreshed = data.data?.refreshed ?? 0;
        const errors = data.data?.errors?.length ?? 0;
        toast.success(`容量刷新完成，成功 ${refreshed} 个${errors ? `，失败 ${errors} 个` : ''}`);
        await fetchAccounts();
        await fetchStorageSummary();
      } else {
        toast.error('容量刷新失败: ' + data.error);
      }
    } catch (error) {
      toast.error('容量刷新失败');
    } finally {
      setCapacityRefreshing(false);
    }
  };

  const handleDeleteAccount = async (id: number) => {
    const ok = await dialog.confirm({
      title: '删除账号',
      message: '确定要删除这个账号吗？',
      confirmText: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const response = await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
      const data = await response.json();
      if (data.success) {
        toast.success('账号删除成功');
        fetchAccounts();
      } else {
        toast.error('账号删除失败: ' + data.error);
      }
    } catch (error) {
      toast.error('操作失败');
    }
  };

  const handleCloneFamilyAccount = async (account: Account) => {
    if ((account.accountType || 'personal') === 'family') {
      toast.warning('该账号已是家庭云');
      return;
    }
    const ok = await dialog.confirm({
      title: '复制家庭账号',
      message: `将基于「${account.alias || account.username}」复制一份家庭云账号（共享登录凭据与 token，不重复登录）。是否继续？`,
      confirmText: '复制',
    });
    if (!ok) return;
    try {
      const response = await fetch(`/api/accounts/${account.id}/clone-family`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          familyId: account.familyId || '',
          familyFolderId: account.familyFolderId || ''
        })
      });
      const data = await response.json();
      if (data.success) {
        const familyId = data.data?.familyId || '';
        toast.success(`已复制家庭账号${familyId ? `（Family ID: ${familyId}）` : ''}`);
        await fetchAccounts();
        await fetchStorageSummary();
      } else {
        toast.error('复制失败: ' + data.error);
      }
    } catch (error) {
      toast.error('复制失败');
    }
  };

  const handleSetDefaultAccount = async (id: number) => {
    try {
      const response = await fetch(`/api/accounts/${id}/default`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await response.json();
      if (data.success) {
        toast.success('设置默认账号成功');
        fetchAccounts();
      } else {
        toast.error('设置默认账号失败: ' + data.error);
      }
    } catch (error) {
      toast.error('操作失败');
    }
  };

  const handleClearRecycleBin = async () => {
    const ok = await dialog.confirm({
      title: '清空回收站',
      message: '确定要清空所有账号的回收站吗？',
      confirmText: '清空',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const response = await fetch('/api/accounts/recycle', { method: 'DELETE' });
      const data = await response.json();
      if (data.success) {
        toast.info('后台任务执行中, 请稍后查看结果');
      } else {
        toast.error('清空回收站失败: ' + data.error);
      }
    } catch (error) {
      toast.error('操作失败');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.username) {
      toast.warning('用户名不能为空');
      return;
    }
    if (!formData.password && !formData.cookies) {
      toast.warning('密码和Cookie不能同时为空');
      return;
    }

    try {
      const body = {
        ...formData,
        id: editingAccount?.id,
        username: editingAccount ? editingAccount.original_username : formData.username,
        familyId: formData.accountType === 'family' ? formData.familyId : ''
      };

      const response = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await response.json();
      if (data.success) {
        toast.success('成功');
        setIsModalOpen(false);
        fetchAccounts();
      } else if (data.code === 'NEED_CAPTCHA') {
        setCaptchaInfo({ url: data.data.captchaUrl });
        toast.warning('请输入验证码后重新提交');
      } else {
        toast.error('操作失败: ' + data.error);
      }
    } catch (error) {
      toast.error('操作失败');
    }
  };

  const updateField = async (id: number, type: 'alias' | 'cloud' | 'local' | 'emby' | 'familyFolder', currentVal: string) => {
    const labels = {
      alias: '新的别名',
      cloud: '新的媒体目录前缀',
      local: '新的本地目录前缀',
      emby: '新的Emby替换路径',
      familyFolder: '家庭中转目录ID'
    };
    const newVal = await dialog.prompt({
      title: labels[type],
      message: `请输入${labels[type]}`,
      defaultValue: currentVal,
    });
    if (newVal === null) return;

    const endpoint = type === 'alias'
      ? `/api/accounts/${id}/alias`
      : type === 'familyFolder'
        ? `/api/accounts/${id}/family-folder`
        : `/api/accounts/${id}/strm-prefix`;
    const body = type === 'alias'
      ? { alias: newVal }
      : type === 'familyFolder'
        ? { familyFolderId: newVal }
        : { strmPrefix: newVal, type: type };

    fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        toast.success('更新成功');
        fetchAccounts();
        fetchStorageSummary();
      } else {
        toast.error('更新失败: ' + data.error);
      }
    })
    .catch(() => toast.error('操作失败'));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex gap-3">
          <button 
            onClick={handleOpenAddModal}
            className="bg-[#0b57d0] text-white px-6 py-2.5 rounded-full text-sm font-medium hover:bg-[#0b57d0]/90 transition-all shadow-sm flex items-center gap-2"
          >
            <Plus size={18} /> 添加账号
          </button>
          <button
            onClick={handleOpenQrLogin}
            className="bg-white border border-slate-200 text-slate-700 px-6 py-2.5 rounded-full text-sm font-medium hover:bg-slate-50 transition-all shadow-sm flex items-center gap-2"
          >
            <QrCode size={18} /> 扫码登录
          </button>
          <button
            onClick={() => handleRefreshCapacity()}
            disabled={capacityRefreshing}
            className="bg-white border border-slate-200 text-slate-700 px-6 py-2.5 rounded-full text-sm font-medium hover:bg-slate-50 transition-all shadow-sm flex items-center gap-2 disabled:opacity-60"
          >
            <RefreshCw size={18} className={capacityRefreshing ? 'animate-spin' : ''} /> 刷新容量
          </button>
          <button 
            onClick={handleClearRecycleBin}
            className="bg-[#f8dada] text-[#900b09] px-6 py-2.5 rounded-full text-sm font-medium hover:bg-[#f8dada]/80 transition-all flex items-center gap-2"
          >
            <Trash2 size={18} /> 清空回收站
          </button>
        </div>
      </div>

      {storageSummary && storageSummary.enabled && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white rounded-3xl border border-slate-200/60 p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <Database size={20} className="text-[#0b57d0]" />
              <span className="text-sm font-semibold text-slate-900">个人容量聚合</span>
            </div>
            <div className="flex items-end justify-between">
              <div>
                <p className="text-2xl font-semibold text-slate-900">{formatBytes(storageSummary.cloud.used)}</p>
                <p className="text-xs text-slate-500 mt-1">总容量 {formatBytes(storageSummary.cloud.total)}</p>
              </div>
              <span className="text-xs text-slate-400">{storageSummary.accounts.length} 个账号</span>
            </div>
            <div className="mt-4 h-2 rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full bg-[#0b57d0]" style={{ width: `${storageSummary.cloud.total ? Math.min(100, storageSummary.cloud.used / storageSummary.cloud.total * 100) : 0}%` }} />
            </div>
          </div>
          <div className="bg-white rounded-3xl border border-slate-200/60 p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <Database size={20} className="text-slate-500" />
              <span className="text-sm font-semibold text-slate-900">家庭容量聚合</span>
            </div>
            <div className="flex items-end justify-between">
              <div>
                <p className="text-2xl font-semibold text-slate-900">{formatBytes(storageSummary.family.used)}</p>
                <p className="text-xs text-slate-500 mt-1">总容量 {formatBytes(storageSummary.family.total)}</p>
              </div>
              <span className="text-xs text-slate-400">含家庭空间</span>
            </div>
            <div className="mt-4 h-2 rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full bg-slate-500" style={{ width: `${storageSummary.family.total ? Math.min(100, storageSummary.family.used / storageSummary.family.total * 100) : 0}%` }} />
            </div>
          </div>
        </div>
      )}
      
      <div className="bg-white rounded-3xl border border-slate-200/60 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50/50 border-b border-slate-100">
              <tr>
                <th className="px-6 py-4 font-medium text-slate-500">操作</th>
                <th className="px-6 py-4 font-medium text-slate-500">用户名</th>
                <th className="px-6 py-4 font-medium text-slate-500">别名</th>
                <th className="px-6 py-4 font-medium text-slate-500">个人容量</th>
                <th className="px-6 py-4 font-medium text-slate-500">家庭容量</th>
                <th className="px-6 py-4 font-medium text-slate-500">家庭中转</th>
                <th className="px-6 py-4 font-medium text-slate-500">媒体目录</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-6 py-4 text-center text-slate-500">加载中...</td>
                </tr>
              ) : !Array.isArray(accounts) || accounts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-4 text-center text-slate-500">暂无账号</td>
                </tr>
              ) : accounts.map(account => {
                if (!account) return null;
                const cloudUsed = account.capacity?.cloudCapacityInfo?.usedSize || 0;
                const cloudTotal = account.capacity?.cloudCapacityInfo?.totalSize || 0;
                const familyUsed = account.capacity?.familyCapacityInfo?.usedSize || 0;
                const familyTotal = account.capacity?.familyCapacityInfo?.totalSize || 0;
                const cloudProgress = cloudTotal > 0 ? (cloudUsed / cloudTotal) * 100 : 0;
                const familyProgress = familyTotal > 0 ? (familyUsed / familyTotal) * 100 : 0;

                return (
                <tr key={account.id} className="hover:bg-slate-50/50 transition-colors group">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <span 
                        className="cursor-pointer text-lg" 
                        onClick={() => handleSetDefaultAccount(account.id)}
                        title="设为默认账号"
                      >
                        {account.isDefault ? '★' : '☆'}
                      </span>
                      <button
                        onClick={() => handleEditAccount(account)}
                        className="text-[#0b57d0] hover:text-[#0b57d0]/80 font-medium transition-colors"
                      >
                        编辑
                      </button>
                      {(account.accountType || 'personal') !== 'family' && (
                        <button
                          onClick={() => handleCloneFamilyAccount(account)}
                          className="text-emerald-700 hover:text-emerald-800 font-medium transition-colors inline-flex items-center gap-1"
                          title="复制一份家庭云账号"
                        >
                          <Copy size={14} /> 复制家庭
                        </button>
                      )}
                      <button
                        onClick={() => handleRefreshCapacity(account.id)}
                        className="text-slate-600 hover:text-[#0b57d0] font-medium transition-colors"
                      >
                        刷新
                      </button>
                      <button
                        onClick={() => handleDeleteAccount(account.id)}
                        className="text-red-600 hover:text-red-800 font-medium transition-colors"
                      >
                        删除
                      </button>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-[#d3e3fd] text-[#041e49] flex items-center justify-center font-bold text-xs">
                        {(account.username || 'U').substring(0, 3)}
                      </div>
                      <div className="flex flex-col">
                        <span className="font-medium text-slate-900">{account.username || '未知'}</span>
                        <span className="text-xs text-slate-500">
                          {account.accountType === 'family' ? '家庭云' : '个人云'}
                          {account.familyId && ` / ${account.familyId}`}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td 
                    className="px-6 py-4 cursor-pointer"
                    onClick={() => updateField(account.id, 'alias', account.alias || '')}
                  >
                    <span className="px-3 py-1 bg-[#d3e3fd] text-[#041e49] rounded-full text-xs font-medium">
                      {account.alias || '无别名'}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex justify-between text-xs text-slate-500">
                        <span>{formatBytes(cloudUsed)}</span>
                        <span>{formatBytes(cloudTotal)}</span>
                      </div>
                      <div className="w-32 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-[#0b57d0]" 
                          style={{ width: `${cloudProgress}%` }}
                        />
                      </div>
                    </div>
                  </td>
                  <td
                    className="px-6 py-4 cursor-pointer"
                    onClick={() => updateField(account.id, 'familyFolder', account.familyFolderId || '')}
                  >
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">
                      {account.familyFolderId || '未设置'}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex justify-between text-xs text-slate-500">
                        <span>{formatBytes(familyUsed)}</span>
                        <span>{formatBytes(familyTotal)}</span>
                      </div>
                      <div className="w-32 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-slate-400" 
                          style={{ width: `${familyProgress}%` }}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col gap-1 text-xs">
                      <span 
                        className="cursor-pointer hover:text-[#0b57d0]"
                        onClick={() => updateField(account.id, 'cloud', account.cloudStrmPrefix || '')}
                      >
                        云端: {account.cloudStrmPrefix || '未设置'}
                      </span>
                      <span 
                        className="cursor-pointer hover:text-[#0b57d0]"
                        onClick={() => updateField(account.id, 'local', account.localStrmPrefix || '')}
                      >
                        本地: {account.localStrmPrefix || '未设置'}
                      </span>
                    </div>
                  </td>
                </tr>
              )})}
            </tbody>
          </table>
        </div>
      </div>

      <Modal 
        isOpen={isModalOpen} 
        onClose={() => setIsModalOpen(false)} 
        title={editingAccount ? "修改账号" : "添加账号"}
      >
        <form id="modal-form" onSubmit={handleSubmit} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">用户名</label>
              <input 
                type="text" 
                value={formData.username}
                onChange={e => setFormData({...formData, username: e.target.value})}
                readOnly={!!editingAccount}
                required 
                className={`w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 ${editingAccount ? 'bg-slate-100' : ''}`} 
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">密码</label>
              <input 
                type="password" 
                value={formData.password}
                onChange={e => setFormData({...formData, password: e.target.value})}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20" 
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">Cookie (可选)</label>
            <textarea 
              rows={3} 
              value={formData.cookies}
              onChange={e => setFormData({...formData, cookies: e.target.value})}
              className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20" 
            />
            <p className="text-xs text-slate-500">密码和 Cookie 至少填写一个，如果都填写，则只有账号密码生效。</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">别名</label>
              <input 
                type="text" 
                value={formData.alias}
                onChange={e => setFormData({...formData, alias: e.target.value})}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20" 
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">账号类型</label>
              <select 
                value={formData.accountType}
                onChange={e => setFormData({...formData, accountType: e.target.value as 'personal' | 'family'})}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              >
                <option value="personal">个人云</option>
                <option value="family">家庭云</option>
              </select>
            </div>
          </div>
          {formData.accountType === 'family' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">Family ID</label>
                <input
                  type="text"
                  value={formData.familyId}
                  onChange={e => setFormData({...formData, familyId: e.target.value})}
                  className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">家庭中转目录ID</label>
                <input
                  type="text"
                  value={formData.familyFolderId}
                  onChange={e => setFormData({...formData, familyFolderId: e.target.value})}
                  className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                  placeholder="留空使用家庭根目录"
                />
              </div>
            </div>
          )}
          {captchaInfo && (
            <div className="space-y-4 p-4 bg-yellow-50 rounded-2xl border border-yellow-100">
              <p className="text-sm font-medium text-yellow-800">请输入验证码</p>
              <div className="flex items-center gap-4">
                <img src={captchaInfo.url} alt="captcha" className="h-10 border rounded-lg" />
                <input 
                  type="text" 
                  value={formData.validateCode}
                  onChange={e => setFormData({...formData, validateCode: e.target.value})}
                  className="flex-1 px-4 py-2 bg-white border border-yellow-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-yellow-500/20" 
                />
              </div>
            </div>
          )}
        </form>
      </Modal>

      <Modal
        isOpen={isQrModalOpen}
        onClose={() => {
          setIsQrModalOpen(false);
          setQrData(null);
        }}
        title="天翼云盘扫码登录"
        footer={(
          <div className="px-8 py-6 flex shrink-0 justify-end gap-3">
            <button
              type="button"
              onClick={() => {
                setIsQrModalOpen(false);
                setQrData(null);
              }}
              className="px-6 py-2.5 rounded-full text-sm font-medium text-[#0b57d0] hover:bg-[#0b57d0]/10 transition-colors"
            >
              关闭
            </button>
          </div>
        )}
      >
        <div className="flex flex-col items-center gap-4 py-4">
          {qrData?.qrUrl ? (
            <img src={qrData.qrUrl} alt="天翼云盘登录二维码" className="h-56 w-56 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm" />
          ) : (
            <div className="flex h-56 w-56 items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-500">
              获取二维码中...
            </div>
          )}
          <div className="text-center">
            <p className="text-sm font-medium text-slate-900">{qrMessage}</p>
            <p className="mt-1 text-xs text-slate-500">使用天翼云盘 App 扫码并确认后会自动添加或更新账号。</p>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default AccountTab;
