import React, { useState, useEffect } from 'react';
import { Files, Search, RefreshCw, X, Check, ChevronDown, ChevronUp, Cpu } from 'lucide-react';
import Modal from './Modal';
import FolderSelector from './FolderSelector';

interface Account {
  id: number;
  username: string;
  accountType: 'family' | 'personal';
}

interface RegexPreset {
  id: number;
  name: string;
  sourceRegex: string;
  targetRegex: string;
  matchPattern: string;
  matchOperator: string;
  matchValue: string;
}

interface CreateTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  initialData?: any;
}

const normalizeMatchOperator = (matchOperator?: string) => {
  if (matchOperator === 'regex') {
    return 'contains';
  }
  return matchOperator || '';
};

const CreateTaskModal: React.FC<CreateTaskModalProps> = ({ isOpen, onClose, onSuccess, initialData }) => {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [regexPresets, setRegexPresets] = useState<RegexPreset[]>([]);
  const [loading, setLoading] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [shareFolders, setShareFolders] = useState<any[]>([]);
  const [selectedFolders, setSelectedFolders] = useState<string[]>([]);
  const [tmdbResults, setTmdbResults] = useState<any[]>([]);
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isFolderSelectorOpen, setIsFolderSelectorOpen] = useState(false);

  const [formData, setFormData] = useState({
    accountId: '',
    shareLink: '',
    accessCode: '',
    taskName: '',
    totalEpisodes: '',
    targetFolderId: '',
    targetFolder: '',
    taskGroup: '',
    remark: '',
    matchPattern: '',
    matchOperator: '',
    matchValue: '',
    enableCron: false,
    cronExpression: '',
    sourceRegex: '',
    targetRegex: '',
    tmdbId: '',
    enableTaskScraper: false,
    enableLazyStrm: false,
    enableOrganizer: false,
    batchShareLinks: '',
    overwriteFolder: 0
  });

  useEffect(() => {
    if (isOpen) {
      fetchAccounts();
      fetchRegexPresets();
      if (initialData) {
        setFormData(prev => ({
          ...prev,
          ...initialData,
          matchOperator: normalizeMatchOperator(initialData.matchOperator)
        }));
      } else {
        // Try to load last target folder from localStorage
        const lastTarget = localStorage.getItem('lastTargetFolder');
        if (lastTarget) {
          try {
            const { lastTargetFolderId, lastTargetFolderName } = JSON.parse(lastTarget);
            setFormData(prev => ({
              ...prev,
              targetFolderId: lastTargetFolderId,
              targetFolder: lastTargetFolderName
            }));
          } catch (e) {
            localStorage.removeItem('lastTargetFolder');
          }
        }
      }
    }
  }, [isOpen, initialData]);

  const fetchAccounts = async () => {
    try {
      const response = await fetch('/api/accounts');
      const data = await response.json();
      if (data.success) {
        setAccounts(data.data);
        if (data.data.length > 0 && !formData.accountId) {
          setFormData(prev => ({ ...prev, accountId: String(data.data[0].id) }));
        }
      }
    } catch (error) {
      console.error('Failed to fetch accounts:', error);
    }
  };

  const fetchRegexPresets = async () => {
    try {
      const response = await fetch('/api/settings/regex-presets');
      const data = await response.json();
      if (data.success) {
        setRegexPresets(data.data || []);
      }
    } catch (error) {
      console.error('Failed to fetch regex presets:', error);
    }
  };

  const handleApplyPreset = (presetId: string) => {
    const preset = regexPresets.find(p => String(p.id) === presetId);
    if (preset) {
      setFormData(prev => ({
        ...prev,
        sourceRegex: preset.sourceRegex || prev.sourceRegex,
        targetRegex: preset.targetRegex || prev.targetRegex,
        matchPattern: preset.matchPattern || prev.matchPattern,
        matchOperator: normalizeMatchOperator(preset.matchOperator || prev.matchOperator),
        matchValue: preset.matchValue || prev.matchValue
      }));
    }
  };

  const handleParseShare = async () => {
    if (!formData.shareLink || !formData.accountId || isBatchMode) return;
    setParsing(true);
    try {
      const response = await fetch('/api/share/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shareLink: formData.shareLink,
          accessCode: formData.accessCode,
          accountId: formData.accountId
        })
      });
      const data = await response.json();
      if (data.success) {
        setShareFolders(data.data);
        setSelectedFolders(data.data.map((f: any) => f.id));
        if (data.data.length > 0 && !formData.taskName) {
          setFormData(prev => ({ ...prev, taskName: data.data[0].name }));
        }
      }
    } catch (error) {
      console.error('Failed to parse share link:', error);
    } finally {
      setParsing(false);
    }
  };

  const handleSearchTmdb = async () => {
    if (!formData.taskName) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/tmdb/search?keyword=${encodeURIComponent(formData.taskName)}`);
      const data = await response.json();
      if (data.success) {
        setTmdbResults(data.data || []);
      }
    } catch (error) {
      console.error('Failed to search TMDB:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      let endpoint = '/api/tasks';
      let method = 'POST';
      let body: any = {
        ...formData,
        matchOperator: normalizeMatchOperator(formData.matchOperator)
      };

      if (isBatchMode) {
        endpoint = '/api/tasks/batch-create';
        const blocks = formData.batchShareLinks.split('\n').filter(l => l.trim());
        body = {
          tasks: blocks.map(link => ({
            ...formData,
            shareLink: link,
            taskName: '', 
            selectedFolders: []
          }))
        };
      } else {
        body.selectedFolders = selectedFolders;
      }

      const response = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await response.json();
      if (data.success) {
        // Save last target folder
        localStorage.setItem('lastTargetFolder', JSON.stringify({
          lastTargetFolderId: formData.targetFolderId,
          lastTargetFolderName: formData.targetFolder
        }));
        onSuccess();
        onClose();
      } else {
        alert('提交失败: ' + data.error);
      }
    } catch (error) {
      console.error('Failed to submit task:', error);
      alert('提交失败');
    } finally {
      setLoading(false);
    }
  };

  const selectedAccount = accounts.find(a => String(a.id) === formData.accountId);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={isBatchMode ? "批量创建任务" : "创建任务"}>
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="flex items-center justify-between bg-slate-50 p-1 rounded-2xl border border-slate-200">
          <button
            type="button"
            onClick={() => setIsBatchMode(false)}
            className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all ${!isBatchMode ? 'bg-white shadow-sm text-[#0b57d0]' : 'text-slate-500 hover:text-slate-700'}`}
          >
            单个任务
          </button>
          <button
            type="button"
            onClick={() => setIsBatchMode(true)}
            className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all ${isBatchMode ? 'bg-white shadow-sm text-[#0b57d0]' : 'text-slate-500 hover:text-slate-700'}`}
          >
            批量创建
          </button>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">选择账号</label>
            <select
              value={formData.accountId}
              onChange={e => setFormData({ ...formData, accountId: e.target.value })}
              className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
            >
              {accounts.map(acc => (
                <option key={acc.id} value={acc.id}>
                  {acc.username} ({acc.accountType === 'family' ? '家庭云' : '个人云'})
                </option>
              ))}
            </select>
          </div>

          {!isBatchMode ? (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">分享链接</label>
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={formData.shareLink}
                    onChange={e => setFormData({ ...formData, shareLink: e.target.value })}
                    onBlur={handleParseShare}
                    placeholder="分享链接"
                    className="flex-1 px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                  />
                  <input
                    type="text"
                    value={formData.accessCode}
                    onChange={e => setFormData({ ...formData, accessCode: e.target.value })}
                    onBlur={handleParseShare}
                    placeholder="访问码"
                    className="w-28 px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                  />
                </div>
              </div>

              {shareFolders.length > 0 && (
                <div className="space-y-2 p-4 bg-[#f8fafd] rounded-2xl border border-[#d3e3fd]">
                  <label className="text-xs font-bold text-[#0b57d0] uppercase tracking-wider">选择要转存的目录</label>
                  <div className="space-y-2 max-h-40 overflow-y-auto pr-2 custom-scrollbar">
                    {shareFolders.map(folder => (
                      <label key={folder.id} className="flex items-center gap-3 p-2 hover:bg-white rounded-xl transition-colors cursor-pointer group">
                        <div 
                          onClick={() => {
                            setSelectedFolders(prev => 
                              prev.includes(folder.id) ? prev.filter(id => id !== folder.id) : [...prev, folder.id]
                            );
                          }}
                          className={`w-5 h-5 rounded border flex items-center justify-center transition-all ${
                            selectedFolders.includes(folder.id) 
                              ? 'bg-[#0b57d0] border-[#0b57d0]' 
                              : 'border-slate-300 bg-white group-hover:border-[#0b57d0]'
                          }`}
                        >
                          {selectedFolders.includes(folder.id) && <Check size={14} className="text-white" />}
                        </div>
                        <span className="text-sm text-slate-700 truncate">{folder.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">批量分享内容</label>
              <textarea
                value={formData.batchShareLinks}
                onChange={e => setFormData({ ...formData, batchShareLinks: e.target.value })}
                rows={5}
                placeholder="一行一个分享链接，支持带提取码的粘贴内容"
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 font-mono"
              />
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">任务名称</label>
            <div className="flex gap-3">
              <input
                type="text"
                value={formData.taskName}
                onChange={e => setFormData({ ...formData, taskName: e.target.value })}
                className="flex-1 px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
              <button
                type="button"
                onClick={handleSearchTmdb}
                className="px-4 py-3 bg-white border border-slate-300 rounded-2xl text-slate-600 hover:bg-slate-50 transition-colors"
              >
                <Search size={20} />
              </button>
            </div>
          </div>

          {tmdbResults.length > 0 && (
            <div className="space-y-2 p-4 bg-slate-50 rounded-2xl border border-slate-200">
              <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">TMDB 搜索结果</label>
              <div className="space-y-1 max-h-40 overflow-y-auto custom-scrollbar">
                {tmdbResults.map(result => (
                  <button
                    key={result.id}
                    type="button"
                    onClick={() => {
                      setFormData(prev => ({ ...prev, taskName: result.title, tmdbId: String(result.id) }));
                      setTmdbResults([]);
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-white rounded-xl text-sm text-slate-700 transition-colors flex justify-between items-center group"
                  >
                    <span className="truncate">{result.title} ({result.releaseDate?.substring(0, 4)})</span>
                    <span className="text-[10px] bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity">选择</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">保存目录</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={formData.targetFolder || formData.targetFolderId}
                  readOnly
                  placeholder="根目录"
                  className="flex-1 px-5 py-3 bg-slate-100 border border-slate-300 rounded-2xl text-sm outline-none text-slate-500"
                />
                <button 
                  type="button" 
                  onClick={() => setIsFolderSelectorOpen(true)}
                  className="px-4 py-3 bg-white border border-slate-300 rounded-2xl text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  <Files size={20} />
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">任务分组</label>
              <input
                type="text"
                value={formData.taskGroup}
                onChange={e => setFormData({ ...formData, taskGroup: e.target.value })}
                placeholder="例如：日更 / 电影"
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-4 pt-2">
            <label className="flex items-center gap-2 cursor-pointer group">
              <div 
                onClick={() => setFormData({ ...formData, enableLazyStrm: !formData.enableLazyStrm })}
                className={`w-5 h-5 rounded border flex items-center justify-center transition-all ${
                  formData.enableLazyStrm ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 group-hover:border-[#0b57d0]'
                }`}
              >
                {formData.enableLazyStrm && <Check size={14} className="text-white" />}
              </div>
              <span className="text-sm font-medium text-slate-600">懒 STRM</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer group">
              <div 
                onClick={() => setFormData({ ...formData, enableOrganizer: !formData.enableOrganizer })}
                className={`w-5 h-5 rounded border flex items-center justify-center transition-all ${
                  formData.enableOrganizer ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 group-hover:border-[#0b57d0]'
                }`}
              >
                {formData.enableOrganizer && <Check size={14} className="text-white" />}
              </div>
              <span className="text-sm font-medium text-slate-600">自动整理</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer group">
              <div 
                onClick={() => setFormData({ ...formData, enableCron: !formData.enableCron })}
                className={`w-5 h-5 rounded border flex items-center justify-center transition-all ${
                  formData.enableCron ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 group-hover:border-[#0b57d0]'
                }`}
              >
                {formData.enableCron && <Check size={14} className="text-white" />}
              </div>
              <span className="text-sm font-medium text-slate-600">定时任务</span>
            </label>
          </div>

          {formData.enableCron && (
            <div className="space-y-2 animate-in slide-in-from-top-2 duration-200">
              <label className="text-sm font-medium text-slate-700">Cron 表达式</label>
              <input
                type="text"
                value={formData.cronExpression}
                onChange={e => setFormData({ ...formData, cronExpression: e.target.value })}
                placeholder="例如：0 0 * * *"
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
          )}

          {/* Advanced Options */}
          <div className="pt-2 border-t border-slate-100">
            <button 
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors"
            >
              {showAdvanced ? <ChevronUp size={18} /> : <ChevronDown size={18} />} 高级配置 (正则过滤/替换)
            </button>
            
            {showAdvanced && (
              <div className="mt-4 space-y-4 animate-in slide-in-from-top-2 duration-200 p-4 bg-slate-50 rounded-2xl border border-slate-200">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
                    <Cpu size={14} /> 正则预设
                  </label>
                  <select 
                    onChange={e => handleApplyPreset(e.target.value)}
                    className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none"
                  >
                    <option value="">选择预设直接应用...</option>
                    {regexPresets.map(preset => (
                      <option key={preset.id} value={preset.id}>{preset.name}</option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-500">源正则 (Source Regex)</label>
                    <input 
                      type="text" 
                      value={formData.sourceRegex}
                      onChange={e => setFormData({...formData, sourceRegex: e.target.value})}
                      className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono"
                      placeholder="e.g. \[.*?\]"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-500">目标正则 (Target Regex)</label>
                    <input 
                      type="text" 
                      value={formData.targetRegex}
                      onChange={e => setFormData({...formData, targetRegex: e.target.value})}
                      className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-500">匹配模式 (Match Pattern)</label>
                    <input 
                      type="text" 
                      value={formData.matchPattern}
                      onChange={e => setFormData({...formData, matchPattern: e.target.value})}
                      className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-500">操作符</label>
                    <select 
                      value={formData.matchOperator}
                      onChange={e => setFormData({...formData, matchOperator: e.target.value})}
                      className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-xs"
                    >
                      <option value="">请选择</option>
                      <option value="lt">小于 (lt)</option>
                      <option value="gt">大于 (gt)</option>
                      <option value="eq">等于 (eq)</option>
                      <option value="contains">包含 (contains)</option>
                      <option value="notContains">不包含 (notContains)</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-500">匹配值 (Match Value)</label>
                    <input 
                      type="text" 
                      value={formData.matchValue}
                      onChange={e => setFormData({...formData, matchValue: e.target.value})}
                      className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-xs"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-6 py-3 bg-white border border-slate-300 text-slate-700 rounded-full font-medium hover:bg-slate-50 transition-all"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={loading}
            className="px-10 py-3 bg-[#0b57d0] text-white rounded-full font-medium shadow-lg hover:bg-[#0b57d0]/90 transition-all flex items-center gap-2 disabled:opacity-70"
          >
            {loading ? <RefreshCw size={20} className="animate-spin" /> : <Check size={20} />} 
            {isBatchMode ? "开始批量创建" : "创建任务"}
          </button>
        </div>
      </form>

      <FolderSelector
        isOpen={isFolderSelectorOpen}
        onClose={() => setIsFolderSelectorOpen(false)}
        accountId={Number(formData.accountId)}
        accountName={selectedAccount?.username || ''}
        onSelect={(folder) => setFormData(prev => ({ 
            ...prev, 
            targetFolderId: folder.id, 
            targetFolder: folder.name 
        }))}
      />
    </Modal>
  );
};

export default CreateTaskModal;
