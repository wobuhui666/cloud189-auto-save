import React, { useState, useEffect } from 'react';
import { Plus, Trash2, MoreVertical } from 'lucide-react';
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
  isDefault: boolean;
  capacity: Capacity;
  cloudStrmPrefix: string | null;
  localStrmPrefix: string | null;
  embyPathReplace: string | null;
  password?: string;
  cookies?: string;
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
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [formData, setFormData] = useState({
    username: '',
    password: '',
    cookies: '',
    alias: '',
    accountType: 'personal' as 'personal' | 'family',
    familyId: '',
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

  useEffect(() => {
    fetchAccounts();
  }, []);

  const handleOpenAddModal = () => {
    setEditingAccount(null);
    setFormData({
      username: '',
      password: '',
      cookies: '',
      alias: '',
      accountType: 'personal',
      familyId: '',
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
      cloudStrmPrefix: account.cloudStrmPrefix || '',
      localStrmPrefix: account.localStrmPrefix || '',
      embyPathReplace: account.embyPathReplace || '',
      validateCode: ''
    });
    setCaptchaInfo(null);
    setIsModalOpen(true);
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

  const updateField = async (id: number, type: 'alias' | 'cloud' | 'local' | 'emby', currentVal: string) => {
    const labels = {
      alias: '新的别名',
      cloud: '新的媒体目录前缀',
      local: '新的本地目录前缀',
      emby: '新的Emby替换路径'
    };
    const newVal = await dialog.prompt({
      title: labels[type],
      message: `请输入${labels[type]}`,
      defaultValue: currentVal,
    });
    if (newVal === null) return;

    const endpoint = type === 'alias' ? `/api/accounts/${id}/alias` : `/api/accounts/${id}/strm-prefix`;
    const body = type === 'alias' ? { alias: newVal } : { strmPrefix: newVal, type: type };

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
            onClick={handleClearRecycleBin}
            className="bg-[#f8dada] text-[#900b09] px-6 py-2.5 rounded-full text-sm font-medium hover:bg-[#f8dada]/80 transition-all flex items-center gap-2"
          >
            <Trash2 size={18} /> 清空回收站
          </button>
        </div>
      </div>
      
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
                <th className="px-6 py-4 font-medium text-slate-500">媒体目录</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-4 text-center text-slate-500">加载中...</td>
                </tr>
              ) : !Array.isArray(accounts) || accounts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-4 text-center text-slate-500">暂无账号</td>
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
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Family ID</label>
              <input 
                type="text" 
                value={formData.familyId}
                onChange={e => setFormData({...formData, familyId: e.target.value})}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20" 
              />
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
    </div>
  );
};

export default AccountTab;
