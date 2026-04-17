import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Cpu, Files, RefreshCw, Search } from 'lucide-react';
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

interface TaskInitialData {
  id?: number;
  accountId?: string | number;
  shareLink?: string;
  accessCode?: string;
  taskName?: string;
  totalEpisodes?: string | number | null;
  currentEpisodes?: string | number | null;
  targetFolderId?: string;
  targetFolder?: string;
  shareFolderId?: string;
  shareFolderName?: string;
  taskGroup?: string;
  remark?: string;
  matchPattern?: string;
  matchOperator?: string;
  matchValue?: string;
  enableCron?: boolean;
  cronExpression?: string;
  sourceRegex?: string;
  targetRegex?: string;
  tmdbId?: string | number | null;
  enableTaskScraper?: boolean;
  enableLazyStrm?: boolean;
  enableOrganizer?: boolean;
  status?: 'pending' | 'processing' | 'completed' | 'failed';
}

interface SelectedFolder {
  id: string;
  name: string;
  path: string;
  accountId: number;
  accountName: string;
}

interface TaskFormData {
  accountId: string;
  shareLink: string;
  accessCode: string;
  taskName: string;
  totalEpisodes: string;
  currentEpisodes: string;
  targetFolderId: string;
  targetFolder: string;
  shareFolderId: string;
  shareFolderName: string;
  taskGroup: string;
  remark: string;
  matchPattern: string;
  matchOperator: string;
  matchValue: string;
  enableCron: boolean;
  cronExpression: string;
  sourceRegex: string;
  targetRegex: string;
  tmdbId: string;
  enableTaskScraper: boolean;
  enableLazyStrm: boolean;
  enableOrganizer: boolean;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  batchShareLinks: string;
  overwriteFolder: number;
}

interface CreateTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  initialData?: TaskInitialData | null;
}

const normalizeMatchOperator = (matchOperator?: string) => {
  if (matchOperator === 'regex') {
    return 'contains';
  }
  return matchOperator || '';
};

const EMPTY_FORM_DATA: TaskFormData = {
  accountId: '',
  shareLink: '',
  accessCode: '',
  taskName: '',
  totalEpisodes: '',
  currentEpisodes: '0',
  targetFolderId: '',
  targetFolder: '',
  shareFolderId: '',
  shareFolderName: '',
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
  status: 'pending',
  batchShareLinks: '',
  overwriteFolder: 0
};

const readLastTargetFolder = () => {
  const raw = localStorage.getItem('lastTargetFolder');
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      targetFolderId: parsed.lastTargetFolderId || '',
      targetFolder: parsed.lastTargetFolderName || ''
    };
  } catch (error) {
    localStorage.removeItem('lastTargetFolder');
    return null;
  }
};

const createInitialFormData = (initialData?: TaskInitialData | null): TaskFormData => {
  const savedTarget = readLastTargetFolder();
  const baseData: TaskFormData = {
    ...EMPTY_FORM_DATA,
    ...(savedTarget || {})
  };

  if (!initialData) {
    return baseData;
  }

  return {
    ...baseData,
    accountId: initialData.accountId !== undefined ? String(initialData.accountId) : baseData.accountId,
    shareLink: initialData.shareLink || '',
    accessCode: initialData.accessCode || '',
    taskName: initialData.taskName || '',
    totalEpisodes: initialData.totalEpisodes !== undefined && initialData.totalEpisodes !== null ? String(initialData.totalEpisodes) : '',
    currentEpisodes: initialData.currentEpisodes !== undefined && initialData.currentEpisodes !== null ? String(initialData.currentEpisodes) : '0',
    targetFolderId: initialData.targetFolderId || baseData.targetFolderId,
    targetFolder: initialData.targetFolder || baseData.targetFolder,
    shareFolderId: initialData.shareFolderId || '',
    shareFolderName: initialData.shareFolderName || '',
    taskGroup: initialData.taskGroup || '',
    remark: initialData.remark || '',
    matchPattern: initialData.matchPattern || '',
    matchOperator: normalizeMatchOperator(initialData.matchOperator),
    matchValue: initialData.matchValue || '',
    enableCron: Boolean(initialData.enableCron),
    cronExpression: initialData.cronExpression || '',
    sourceRegex: initialData.sourceRegex || '',
    targetRegex: initialData.targetRegex || '',
    tmdbId: initialData.tmdbId !== undefined && initialData.tmdbId !== null ? String(initialData.tmdbId) : '',
    enableTaskScraper: Boolean(initialData.enableTaskScraper),
    enableLazyStrm: Boolean(initialData.enableLazyStrm),
    enableOrganizer: Boolean(initialData.enableOrganizer),
    status: initialData.status || 'pending'
  };
};

const shouldShowAdvancedOptions = (formData: TaskFormData) => {
  return Boolean(
    formData.sourceRegex ||
    formData.targetRegex ||
    formData.matchPattern ||
    formData.matchOperator ||
    formData.matchValue
  );
};

const CreateTaskModal: React.FC<CreateTaskModalProps> = ({ isOpen, onClose, onSuccess, initialData }) => {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [regexPresets, setRegexPresets] = useState<RegexPreset[]>([]);
  const [loading, setLoading] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [shareFolders, setShareFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedFolders, setSelectedFolders] = useState<string[]>([]);
  const [tmdbResults, setTmdbResults] = useState<any[]>([]);
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isFolderSelectorOpen, setIsFolderSelectorOpen] = useState(false);
  const [formData, setFormData] = useState<TaskFormData>(() => createInitialFormData(initialData));

  const isEditing = Boolean(initialData?.id);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const nextFormData = createInitialFormData(initialData);
    setFormData(nextFormData);
    setShareFolders(
      initialData?.shareFolderId && initialData.shareFolderName
        ? [{ id: initialData.shareFolderId, name: initialData.shareFolderName }]
        : []
    );
    setSelectedFolders(initialData?.shareFolderId ? [initialData.shareFolderId] : []);
    setTmdbResults([]);
    setIsBatchMode(false);
    setShowAdvanced(shouldShowAdvancedOptions(nextFormData));
    fetchAccounts(nextFormData.accountId);
    fetchRegexPresets();
  }, [isOpen, initialData]);

  const fetchAccounts = async (preferredAccountId?: string) => {
    try {
      const response = await fetch('/api/accounts');
      const data = await response.json();
      if (data.success) {
        const nextAccounts = Array.isArray(data.data) ? data.data : [];
        setAccounts(nextAccounts);
        setFormData(prev => {
          if (prev.accountId) {
            return prev;
          }

          const fallbackAccountId = preferredAccountId || (nextAccounts[0] ? String(nextAccounts[0].id) : '');
          if (!fallbackAccountId) {
            return prev;
          }

          return {
            ...prev,
            accountId: fallbackAccountId
          };
        });
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
    const preset = regexPresets.find(item => String(item.id) === presetId);
    if (!preset) {
      return;
    }

    setFormData(prev => ({
      ...prev,
      sourceRegex: preset.sourceRegex || prev.sourceRegex,
      targetRegex: preset.targetRegex || prev.targetRegex,
      matchPattern: preset.matchPattern || prev.matchPattern,
      matchOperator: normalizeMatchOperator(preset.matchOperator || prev.matchOperator),
      matchValue: preset.matchValue || prev.matchValue
    }));
    setShowAdvanced(true);
  };

  const handleAccountChange = (accountId: string) => {
    setFormData(prev => ({
      ...prev,
      accountId
    }));

    if (isEditing) {
      return;
    }

    setShareFolders([]);
    setSelectedFolders([]);
  };

  const handleParseShare = async () => {
    if (!formData.shareLink || !formData.accountId || isBatchMode || isEditing) {
      return;
    }

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
        const folders = Array.isArray(data.data) ? data.data : [];
        setShareFolders(folders);
        setSelectedFolders(folders.map((folder: { id: string }) => folder.id));
        if (folders.length > 0 && !formData.taskName) {
          setFormData(prev => ({
            ...prev,
            taskName: folders[0].name
          }));
        }
      }
    } catch (error) {
      console.error('Failed to parse share link:', error);
    } finally {
      setParsing(false);
    }
  };

  const handleSearchTmdb = async () => {
    if (!formData.taskName) {
      return;
    }

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

  const handleSelectTmdb = async (result: { id: number; title: string; type?: string }) => {
    setLoading(true);
    try {
      let totalEpisodes = '';
      if (result.type === 'tv') {
        const response = await fetch(`/api/tmdb/tv/${result.id}`);
        const data = await response.json();
        if (data.success && data.data?.totalEpisodes > 0) {
          totalEpisodes = String(data.data.totalEpisodes);
        }
      }

      setFormData(prev => ({
        ...prev,
        taskName: result.title,
        tmdbId: String(result.id),
        totalEpisodes
      }));
      setTmdbResults([]);
    } catch (error) {
      console.error('Failed to fetch TMDB details:', error);
      setFormData(prev => ({
        ...prev,
        taskName: result.title,
        tmdbId: String(result.id)
      }));
      setTmdbResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);

    try {
      const normalizedMatchOperator = normalizeMatchOperator(formData.matchOperator);
      const normalizedTotalEpisodes = Number(formData.totalEpisodes || 0);
      let endpoint = '/api/tasks';
      let method = 'POST';
      let body: Record<string, unknown> = {
        ...formData,
        totalEpisodes: normalizedTotalEpisodes,
        matchOperator: normalizedMatchOperator
      };

      if (isEditing) {
        const shareFolderId = formData.shareFolderId || selectedFolders[0] || '';
        const shareFolderName =
          formData.shareFolderName ||
          shareFolders.find(folder => folder.id === shareFolderId)?.name ||
          '';

        endpoint = `/api/tasks/${initialData?.id}`;
        method = 'PUT';
        body = {
          resourceName: formData.taskName.trim(),
          realFolderId: formData.targetFolderId,
          realFolderName: formData.targetFolder || formData.targetFolderId,
          currentEpisodes: Number(formData.currentEpisodes || 0),
          totalEpisodes: normalizedTotalEpisodes,
          status: formData.status,
          shareFolderId,
          shareFolderName,
          sourceRegex: formData.sourceRegex,
          targetRegex: formData.targetRegex,
          matchPattern: formData.matchPattern,
          matchOperator: normalizedMatchOperator,
          matchValue: formData.matchValue,
          remark: formData.remark,
          taskGroup: formData.taskGroup,
          tmdbId: formData.tmdbId,
          enableCron: formData.enableCron,
          cronExpression: formData.cronExpression,
          enableTaskScraper: formData.enableTaskScraper,
          enableLazyStrm: formData.enableLazyStrm,
          enableOrganizer: formData.enableOrganizer
        };
      } else if (isBatchMode) {
        endpoint = '/api/tasks/batch-create';
        const blocks = formData.batchShareLinks
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean);
        body = {
          tasks: blocks.map(link => ({
            ...formData,
            shareLink: link,
            taskName: '',
            selectedFolders: []
          }))
        };
      } else {
        body = {
          ...body,
          selectedFolders
        };
      }

      const response = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await response.json();
      if (data.success) {
        localStorage.setItem(
          'lastTargetFolder',
          JSON.stringify({
            lastTargetFolderId: formData.targetFolderId,
            lastTargetFolderName: formData.targetFolder
          })
        );
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

  const selectedAccount = accounts.find(account => String(account.id) === formData.accountId);
  const modalTitle = isEditing ? '修改任务' : (isBatchMode ? '批量创建任务' : '创建任务');

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={modalTitle} footer={null}>
      <form onSubmit={handleSubmit} className="space-y-6">
        {!isEditing && (
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
        )}

        {isEditing && (
          <div className="rounded-2xl border border-[#d3e3fd] bg-[#f8fafd] px-4 py-3 text-sm text-slate-600">
            编辑模式下不会修改分享链接和来源账号，仅更新任务配置和保存目录。
          </div>
        )}

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">选择账号</label>
            <select
              value={formData.accountId}
              onChange={e => handleAccountChange(e.target.value)}
              disabled={isEditing}
              className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 disabled:opacity-70"
            >
              {accounts.map(account => (
                <option key={account.id} value={account.id}>
                  {account.username} ({account.accountType === 'family' ? '家庭云' : '个人云'})
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
                    onChange={e => setFormData(prev => ({ ...prev, shareLink: e.target.value }))}
                    onBlur={handleParseShare}
                    readOnly={isEditing}
                    placeholder="分享链接"
                    className="flex-1 px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 read-only:bg-slate-100 read-only:text-slate-500"
                  />
                  <input
                    type="text"
                    value={formData.accessCode}
                    onChange={e => setFormData(prev => ({ ...prev, accessCode: e.target.value }))}
                    onBlur={handleParseShare}
                    readOnly={isEditing}
                    placeholder="访问码"
                    className="w-28 px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 read-only:bg-slate-100 read-only:text-slate-500"
                  />
                </div>
              </div>

              {parsing && (
                <div className="text-xs text-slate-500">正在解析分享目录...</div>
              )}

              {shareFolders.length > 0 && (
                <div className="space-y-2 p-4 bg-[#f8fafd] rounded-2xl border border-[#d3e3fd]">
                  <label className="text-xs font-bold text-[#0b57d0] uppercase tracking-wider">
                    {isEditing ? '当前分享目录' : '选择要转存的目录'}
                  </label>
                  <div className="space-y-2 max-h-40 overflow-y-auto pr-2 custom-scrollbar">
                    {shareFolders.map(folder => {
                      const checked = selectedFolders.includes(folder.id);
                      return (
                        <label key={folder.id} className="flex items-center gap-3 p-2 hover:bg-white rounded-xl transition-colors cursor-pointer group">
                          <div
                            onClick={() => {
                              if (isEditing) {
                                return;
                              }
                              setSelectedFolders(prev =>
                                prev.includes(folder.id) ? prev.filter(id => id !== folder.id) : [...prev, folder.id]
                              );
                            }}
                            className={`w-5 h-5 rounded border flex items-center justify-center transition-all ${
                              checked
                                ? 'bg-[#0b57d0] border-[#0b57d0]'
                                : 'border-slate-300 bg-white group-hover:border-[#0b57d0]'
                            }`}
                          >
                            {checked && <Check size={14} className="text-white" />}
                          </div>
                          <span className="text-sm text-slate-700 truncate">{folder.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">批量分享内容</label>
              <textarea
                value={formData.batchShareLinks}
                onChange={e => setFormData(prev => ({ ...prev, batchShareLinks: e.target.value }))}
                rows={5}
                placeholder="一行一个分享链接，支持带提取码的粘贴内容"
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 font-mono"
              />
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">任务名称</label>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={formData.taskName}
                  onChange={e => setFormData(prev => ({ ...prev, taskName: e.target.value }))}
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

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">总集数</label>
              <input
                type="number"
                min="0"
                value={formData.totalEpisodes}
                onChange={e => setFormData(prev => ({ ...prev, totalEpisodes: e.target.value }))}
                placeholder="可选"
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
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
                    onClick={() => handleSelectTmdb(result)}
                    className="w-full text-left px-3 py-2 hover:bg-white rounded-xl text-sm text-slate-700 transition-colors flex justify-between items-center group"
                  >
                    <span className="truncate">{result.title} ({result.releaseDate?.substring(0, 4)})</span>
                    <span className="text-[10px] bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity">选择</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {isEditing && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">已更新集数</label>
                <input
                  type="number"
                  min="0"
                  value={formData.currentEpisodes}
                  onChange={e => setFormData(prev => ({ ...prev, currentEpisodes: e.target.value }))}
                  className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">任务状态</label>
                <select
                  value={formData.status}
                  onChange={e => setFormData(prev => ({ ...prev, status: e.target.value as TaskFormData['status'] }))}
                  className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                >
                  <option value="pending">等待中</option>
                  <option value="processing">追剧中</option>
                  <option value="completed">已完结</option>
                  <option value="failed">失败</option>
                </select>
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
                onChange={e => setFormData(prev => ({ ...prev, taskGroup: e.target.value }))}
                placeholder="例如：日更 / 电影"
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">备注</label>
            <textarea
              value={formData.remark}
              onChange={e => setFormData(prev => ({ ...prev, remark: e.target.value }))}
              rows={2}
              className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
            />
          </div>

          <div className="flex flex-wrap gap-4 pt-2">
            <label className="flex items-center gap-2 cursor-pointer group">
              <div
                onClick={() => setFormData(prev => ({ ...prev, enableTaskScraper: !prev.enableTaskScraper }))}
                className={`w-5 h-5 rounded border flex items-center justify-center transition-all ${
                  formData.enableTaskScraper ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 group-hover:border-[#0b57d0]'
                }`}
              >
                {formData.enableTaskScraper && <Check size={14} className="text-white" />}
              </div>
              <span className="text-sm font-medium text-slate-600">启用刮削</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer group">
              <div
                onClick={() => setFormData(prev => ({ ...prev, enableLazyStrm: !prev.enableLazyStrm }))}
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
                onClick={() => setFormData(prev => ({ ...prev, enableOrganizer: !prev.enableOrganizer }))}
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
                onClick={() => setFormData(prev => ({ ...prev, enableCron: !prev.enableCron }))}
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
                onChange={e => setFormData(prev => ({ ...prev, cronExpression: e.target.value }))}
                placeholder="例如：0 0 * * *"
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
          )}

          <div className="pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setShowAdvanced(prev => !prev)}
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
                      onChange={e => setFormData(prev => ({ ...prev, sourceRegex: e.target.value }))}
                      className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono"
                      placeholder="e.g. \\[.*?\\]"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-500">目标正则 (Target Regex)</label>
                    <input
                      type="text"
                      value={formData.targetRegex}
                      onChange={e => setFormData(prev => ({ ...prev, targetRegex: e.target.value }))}
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
                      onChange={e => setFormData(prev => ({ ...prev, matchPattern: e.target.value }))}
                      className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-500">操作符</label>
                    <select
                      value={formData.matchOperator}
                      onChange={e => setFormData(prev => ({ ...prev, matchOperator: e.target.value }))}
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
                      onChange={e => setFormData(prev => ({ ...prev, matchValue: e.target.value }))}
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
            {isEditing ? '保存修改' : (isBatchMode ? '开始批量创建' : '创建任务')}
          </button>
        </div>
      </form>

      <FolderSelector
        isOpen={isFolderSelectorOpen}
        onClose={() => setIsFolderSelectorOpen(false)}
        accountId={Number(formData.accountId)}
        accountName={selectedAccount?.username || ''}
        onSelect={(folder: SelectedFolder) => {
          setFormData(prev => ({
            ...prev,
            accountId: String(folder.accountId),
            targetFolderId: folder.id,
            targetFolder: folder.name
          }));
        }}
      />
    </Modal>
  );
};

export default CreateTaskModal;
