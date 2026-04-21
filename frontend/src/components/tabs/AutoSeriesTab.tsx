import React, { useState, useEffect } from 'react';
import { Plus, Search, PlayCircle, RefreshCw, AlertCircle, CheckCircle2, X, ArrowLeft, Check } from 'lucide-react';
import Modal from '../Modal';

interface Account {
  id: number;
  username: string;
  alias?: string;
}

interface AutoSeriesSettings {
  accountId: string;
  targetFolderId: string;
  targetFolder: string;
}

type AutoSeriesMode = 'normal' | 'lazy';

interface CandidateResource {
  messageId?: string;
  title: string;
  shareLink: string;
  score?: number;
}

const DEFAULT_AUTO_SERIES_MODE: AutoSeriesMode = 'lazy';

const AutoSeriesTab: React.FC = () => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [defaults, setDefaults] = useState<AutoSeriesSettings | null>(null);
  const [form, setForm] = useState<{
    title: string;
    year: string;
    mode: AutoSeriesMode;
    manualSelect: boolean;
  }>({
    title: '',
    year: '',
    mode: DEFAULT_AUTO_SERIES_MODE,
    manualSelect: false
  });
  const [candidates, setCandidates] = useState<CandidateResource[]>([]);
  const [selectedLink, setSelectedLink] = useState<string>('');
  const [step, setStep] = useState<'form' | 'select'>('form');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [accountsRes, settingsRes] = await Promise.all([
        fetch('/api/accounts'),
        fetch('/api/settings')
      ]);
      const accountsData = await accountsRes.json();
      const settingsData = await settingsRes.json();
      
      if (accountsData.success) setAccounts(accountsData.data);
      if (settingsData.success) setDefaults(settingsData.data.task.autoCreate);
    } catch (error) {
      console.error('Failed to fetch data:', error);
    }
  };

  const resetModal = () => {
    setIsModalOpen(false);
    setForm({ title: '', year: '', mode: DEFAULT_AUTO_SERIES_MODE, manualSelect: false });
    setCandidates([]);
    setSelectedLink('');
    setStep('form');
  };

  const createTask = async (shareLink?: string, resourceTitle?: string) => {
    setLoading(true);
    try {
      const response = await fetch('/api/auto-series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          year: form.year,
          mode: form.mode,
          ...(shareLink ? { shareLink, resourceTitle: resourceTitle || '' } : {})
        })
      });
      const data = await response.json();
      if (data.success) {
        const resultMode: AutoSeriesMode = data.data?.mode === 'normal' ? 'normal' : form.mode;
        alert(data.data?.taskCount > 0
          ? `已创建${resultMode === 'lazy' ? '懒转存' : '自动'}任务：${data.data.taskName}`
          : `已生成懒转存STRM：${data.data.taskName}`);
        resetModal();
      } else {
        alert('自动追剧失败: ' + data.error);
      }
    } catch (error) {
      alert('自动追剧失败: ' + (error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = async () => {
    if (!form.title.trim()) {
      alert('剧名不能为空');
      return;
    }
    setSearching(true);
    try {
      const params = new URLSearchParams({ title: form.title.trim() });
      if (form.year.trim()) params.append('year', form.year.trim());
      const response = await fetch(`/api/auto-series/search?${params.toString()}`);
      const data = await response.json();
      if (data.success) {
        const list: CandidateResource[] = data.data?.resources || [];
        if (!list.length) {
          alert('未搜索到可用资源');
          return;
        }
        setCandidates(list);
        setSelectedLink(list[0]?.shareLink || '');
        setStep('select');
      } else {
        alert('资源搜索失败: ' + data.error);
      }
    } catch (error) {
      alert('资源搜索失败: ' + (error as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) {
      alert('剧名不能为空');
      return;
    }
    if (form.manualSelect) {
      await handleSearch();
      return;
    }
    await createTask();
  };

  const handleConfirmSelection = async () => {
    if (!selectedLink) {
      alert('请选择一个资源');
      return;
    }
    const picked = candidates.find(item => item.shareLink === selectedLink);
    await createTask(selectedLink, picked?.title);
  };

  const getAccountName = (id: string) => {
    const account = accounts.find(a => String(a.id) === id);
    return account ? (account.alias || account.username) : id;
  };

  const isConfigured = defaults?.accountId && defaults?.targetFolderId;

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
                  <p className="text-slate-900 font-medium">{getAccountName(defaults.accountId)}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-slate-500 font-medium uppercase tracking-wider text-[10px]">默认保存目录</p>
                  <p className="text-slate-900 font-medium truncate" title={defaults.targetFolder}>{defaults.targetFolder}</p>
                </div>
              </div>
            ) : (
              <p className="text-red-600 text-sm mt-1">
                请先到“系统”页配置自动追剧默认账号和默认保存目录。
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

      <div className="flex items-center justify-between">
        <button 
          onClick={() => setIsModalOpen(true)}
          className="bg-[#0b57d0] text-white px-8 py-3 rounded-full text-sm font-medium hover:bg-[#0b57d0]/90 transition-all shadow-lg hover:shadow-xl flex items-center gap-2"
        >
          <Plus size={20} /> 添加追剧
        </button>
        <div className="relative w-72">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input 
            type="text" 
            placeholder="搜索剧集..." 
            className="pl-12 pr-4 py-3 bg-white border border-slate-200 rounded-full text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 w-full shadow-sm"
          />
        </div>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Placeholder cards to show design */}
        <div className="bg-white rounded-3xl border border-slate-200/60 p-8 shadow-sm group hover:shadow-md transition-all">
          <div className="flex items-start justify-between mb-6">
            <div className="w-16 h-16 rounded-2xl bg-[#d3e3fd] flex items-center justify-center text-[#0b57d0] group-hover:scale-110 transition-transform">
              <PlayCircle size={32} />
            </div>
            <span className="px-4 py-1.5 bg-[#c4eed0] text-[#0d4f1f] rounded-full text-xs font-bold uppercase tracking-wider">自动追剧中</span>
          </div>
          <h3 className="font-bold text-slate-900 text-xl mb-1">通过添加任务启动</h3>
          <p className="text-sm text-slate-500">点击上方按钮，输入想追的剧名</p>
          <div className="mt-8 pt-6 border-t border-slate-100">
            <div className="flex items-center gap-2 text-slate-400 text-xs">
              <AlertCircle size={14} />
              <span>本页仅提供快速创建功能</span>
            </div>
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

            <div className="grid grid-cols-2 gap-4">
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
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">模式</label>
                <select
                  value={form.mode}
                  onChange={e => setForm({ ...form, mode: e.target.value as AutoSeriesMode })}
                  className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                >
                  <option value="lazy">懒转存 (生成STRM)</option>
                  <option value="normal">自动转存 (下载文件)</option>
                </select>
              </div>
            </div>

            {/* 手动选择资源开关 —— 默认关闭 */}
            <label className="flex items-start gap-3 px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl cursor-pointer hover:bg-slate-100/70 transition-colors">
              <input
                type="checkbox"
                checked={form.manualSelect}
                onChange={e => setForm({ ...form, manualSelect: e.target.checked })}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-[#0b57d0] focus:ring-[#0b57d0]/40"
              />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-800">手动选择资源</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  开启后将先展示候选资源列表，由你确认后再创建任务；关闭则自动挑选最匹配的资源。
                </div>
              </div>
            </label>

            <div className="bg-[#f8fafd] p-4 rounded-2xl border border-slate-100">
              <p className="text-xs text-slate-500 leading-relaxed">
                <span className="font-bold text-[#0b57d0]">说明：</span>
                系统将根据剧名在网盘资源中搜索并自动创建转存任务。如果选择“懒转存”，则优先生成 STRM 文件而不占用网盘空间。
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
                {form.manualSelect ? '搜索资源' : '开始追剧'}
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
                const active = item.shareLink === selectedLink;
                return (
                  <button
                    key={item.shareLink || index}
                    type="button"
                    onClick={() => setSelectedLink(item.shareLink)}
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
                        {typeof item.score === 'number' && (
                          <span className="px-1.5 py-0.5 bg-slate-100 rounded-md">匹配度 {item.score}</span>
                        )}
                        <span className="truncate" title={item.shareLink}>{item.shareLink}</span>
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
                disabled={loading || !selectedLink}
                className="flex-1 px-6 py-3 bg-[#0b57d0] text-white rounded-full font-medium hover:bg-[#0b57d0]/90 transition-all shadow-md flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {loading && <RefreshCw size={18} className="animate-spin" />}
                使用该资源创建任务
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default AutoSeriesTab;
