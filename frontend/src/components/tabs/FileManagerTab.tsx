import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Files, ChevronRight, Search, MoreVertical, RefreshCw, ArrowLeft, Move, Trash2, ExternalLink, Copy, FileText, Folder, FolderTree, FileVideo } from 'lucide-react';
import FolderSelector, { SelectedFolder } from '../FolderSelector';
import Modal from '../Modal';
import Checkbox from '../ui/Checkbox';
import { useToast } from '../ui/Toast';
import { useDialog } from '../ui/Dialog';

interface Account {
  id: number;
  username: string;
  alias: string | null;
  accountType: 'personal' | 'family';
  original_username: string;
  isDefault: boolean;
}

interface FileEntry {
  id: string;
  name: string;
  isFolder: boolean;
  size: number;
  lastOpTime: string;
  ext?: string;
}

interface PathSegment {
  id: string;
  name: string;
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

const FileManagerTab: React.FC = () => {
  const toast = useToast();
  const dialog = useDialog();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [path, setPath] = useState<PathSegment[]>([{ id: '-11', name: '全部文件' }]);
  const [loading, setLoading] = useState(false);
  const [filterKeyword, setFilterKeyword] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [driveLabel, setDriveLabel] = useState('');
  const [isFolderSelectorOpen, setIsFolderSelectorOpen] = useState(false);
  const [openFileMenuId, setOpenFileMenuId] = useState<string | null>(null);
  const [isOrganizeOpen, setIsOrganizeOpen] = useState(false);
  const [organizeGeneratingStrm, setOrganizeGeneratingStrm] = useState(true);
  const [organizeUseAi, setOrganizeUseAi] = useState(true);
  const [organizeDeleteEmptySource, setOrganizeDeleteEmptySource] = useState(true);
  const [organizeSubmitting, setOrganizeSubmitting] = useState(false);
  const [isGenerateStrmOpen, setIsGenerateStrmOpen] = useState(false);
  /** selected-name: path=文件夹名；full-path: 面包屑完整相对路径 */
  const [strmPathMode, setStrmPathMode] = useState<'selected-name' | 'full-path'>('selected-name');
  const [strmOverwrite, setStrmOverwrite] = useState(false);
  const [strmLocalPathPrefix, setStrmLocalPathPrefix] = useState('');
  const [strmSubmitting, setStrmSubmitting] = useState(false);

  const fetchAccounts = async () => {
    try {
      const response = await fetch('/api/accounts');
      const data = await response.json();
      if (data.success) {
        const availableAccounts = (Array.isArray(data.data) ? data.data : []).filter((a: Account) => !a.original_username.startsWith('n_'));
        setAccounts(availableAccounts);
        if (availableAccounts.length > 0) {
          const defaultAcc = availableAccounts.find((a: Account) => a.isDefault) || availableAccounts[0];
          setSelectedAccountId(String(defaultAcc.id));
        }
      }
    } catch (error) {
      console.error('Failed to fetch accounts:', error);
    }
  };

  const fetchFiles = useCallback(async (folderId: string) => {
    if (!selectedAccountId) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/file-manager/list?accountId=${encodeURIComponent(selectedAccountId)}&folderId=${encodeURIComponent(folderId)}`);
      const data = await response.json();
      if (data.success) {
        setEntries(Array.isArray(data.data?.entries) ? data.data.entries : []);
        setDriveLabel(data.data?.driveLabel || '');
        setSelectedIds(new Set());
      } else {
        toast.error('加载文件失败: ' + data.error);
      }
    } catch (error) {
      console.error('Failed to fetch files:', error);
    } finally {
      setLoading(false);
    }
  }, [selectedAccountId]);

  useEffect(() => {
    fetchAccounts();
  }, []);

  useEffect(() => {
    if (selectedAccountId) {
      fetchFiles(path[path.length - 1].id);
    }
  }, [selectedAccountId, fetchFiles]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('[data-file-item-menu]')) {
        setOpenFileMenuId(null);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenFileMenuId(null);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const handleAccountChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedAccountId(e.target.value);
    setPath([{ id: '-11', name: '全部文件' }]);
  };

  const handleNavigate = (folderId: string, name: string) => {
    const newPath = [...path, { id: folderId, name }];
    setPath(newPath);
    fetchFiles(folderId);
  };

  const handleBreadcrumbClick = (index: number) => {
    if (index === path.length - 1) return;
    const newPath = path.slice(0, index + 1);
    setPath(newPath);
    fetchFiles(newPath[newPath.length - 1].id);
  };

  const handleBack = () => {
    if (path.length <= 1) return;
    const newPath = path.slice(0, -1);
    setPath(newPath);
    fetchFiles(newPath[newPath.length - 1].id);
  };

  const handleRefresh = () => {
    fetchFiles(path[path.length - 1].id);
  };

  const handleCreateFolder = async () => {
    const folderName = await dialog.prompt({
      title: '新建目录',
      message: '请输入新目录名称',
      placeholder: '例如：新建文件夹',
      validate: (v) => !v.trim() ? '名称不能为空' : null,
    });
    if (!folderName || !folderName.trim()) return;

    try {
      const response = await fetch('/api/file-manager/folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: selectedAccountId,
          parentFolderId: path[path.length - 1].id,
          folderName: folderName.trim()
        })
      });
      const data = await response.json();
      if (data.success) {
        fetchFiles(path[path.length - 1].id);
        toast.success('目录创建成功');
      } else {
        toast.error('创建目录失败: ' + data.error);
      }
    } catch (error) {
      toast.error('创建目录失败');
    }
  };

  const handleRename = async (entry: FileEntry) => {
    const newName = await dialog.prompt({
      title: '重命名',
      message: '请输入新的名称',
      defaultValue: entry.name,
      validate: (v) => !v.trim() ? '名称不能为空' : null,
    });
    if (!newName || !newName.trim() || newName === entry.name) return;

    try {
      const response = await fetch('/api/file-manager/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: selectedAccountId,
          fileId: entry.id,
          destFileName: newName.trim()
        })
      });
      const data = await response.json();
      if (data.success) {
        fetchFiles(path[path.length - 1].id);
        toast.success('重命名成功');
      } else {
        toast.error('重命名失败: ' + data.error);
      }
    } catch (error) {
      toast.error('重命名失败');
    }
  };

  const handleDelete = async (entriesToDelete: FileEntry[]) => {
    const ok = await dialog.confirm({
      title: '删除文件',
      message: `确定删除选中的 ${entriesToDelete.length} 个项目吗？`,
      confirmText: '删除',
      tone: 'danger',
    });
    if (!ok) return;

    try {
      const response = await fetch('/api/file-manager/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: selectedAccountId,
          entries: entriesToDelete.map(e => ({ id: e.id, name: e.name, isFolder: e.isFolder }))
        })
      });
      const data = await response.json();
      if (data.success) {
        fetchFiles(path[path.length - 1].id);
        toast.success('删除成功');
      } else {
        toast.error('删除失败: ' + data.error);
      }
    } catch (error) {
      toast.error('删除失败');
    }
  };

  const handleMove = async (targetFolderId: string) => {
    try {
      const entriesToMove = selectedEntries.map(e => ({ id: e.id, name: e.name, isFolder: e.isFolder }));
      const response = await fetch('/api/file-manager/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: selectedAccountId,
          entries: entriesToMove,
          targetFolderId
        })
      });
      const data = await response.json();
      if (data.success) {
        toast.success('移动成功');
        fetchFiles(path[path.length - 1].id);
      } else {
        toast.error('移动失败: ' + data.error);
      }
    } catch (error) {
      toast.error('移动失败');
    }
  };

  const handleOpenOrganize = () => {
    if (selectedEntries.length === 0) return;
    setOrganizeGeneratingStrm(true);
    setOrganizeUseAi(true);
    setOrganizeDeleteEmptySource(true);
    setIsOrganizeOpen(true);
  };

  const handleOrganize = async () => {
    if (!selectedAccountId || selectedEntries.length === 0 || organizeSubmitting) return;
    setOrganizeSubmitting(true);
    try {
      const count = selectedEntries.length;
      const response = await fetch('/api/file-manager/organize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: selectedAccountId,
          parentFolderId: path[path.length - 1].id,
          items: selectedEntries.map((entry) => ({
            id: entry.id,
            name: entry.name,
            isFolder: entry.isFolder,
          })),
          useAi: organizeUseAi,
          generateStrm: organizeGeneratingStrm,
          deleteEmptySource: organizeDeleteEmptySource,
        }),
      });
      const data = await response.json();
      if (!data.success) {
        toast.error('整理提交失败: ' + (data.error || '未知错误'));
        return;
      }

      // 后端立即返回，实际整理在后台跑；结果看日志
      toast.info(
        data.data?.message
          || `已提交 ${count} 项整理到后台执行，完成后请刷新目录查看`
      );
      setIsOrganizeOpen(false);
      setSelectedIds(new Set());
    } catch (error) {
      toast.error('整理提交失败');
    } finally {
      setOrganizeSubmitting(false);
    }
  };

  const handleGetLink = async (entry: FileEntry, open = false) => {
    try {
      const response = await fetch(`/api/file-manager/download-link?accountId=${encodeURIComponent(selectedAccountId)}&fileId=${encodeURIComponent(entry.id)}`);
      const data = await response.json();
      if (data.success) {
        if (open) {
          window.open(data.data.url, '_blank');
        } else {
          await navigator.clipboard.writeText(data.data.url);
          toast.success('直链已复制');
        }
      } else {
        toast.error('获取直链失败: ' + data.error);
      }
    } catch (error) {
      toast.error('获取直链失败');
    }
  };

  const toggleSelect = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const visibleEntries = entries.filter(e =>
    e.name.toLowerCase().includes(filterKeyword.toLowerCase())
  );
  const visibleSelectedCount = visibleEntries.filter((e) => selectedIds.has(e.id)).length;

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      // 并入可见项，保留筛选外已选
      setSelectedIds((prev) => {
        const next = new Set(prev);
        visibleEntries.forEach((e) => next.add(e.id));
        return next;
      });
    } else {
      // 只取消当前可见项
      setSelectedIds((prev) => {
        const next = new Set(prev);
        visibleEntries.forEach((e) => next.delete(e.id));
        return next;
      });
    }
  };

  const selectedEntries = entries.filter(e => selectedIds.has(e.id));
  const selectedFolders = selectedEntries.filter((entry) => entry.isFolder);
  const selectedAccount = accounts.find(a => String(a.id) === selectedAccountId);

  /** 去掉「全部文件」根段后的浏览路径名 */
  const breadcrumbNames = path.slice(1).map((segment) => segment.name).filter(Boolean);

  const buildStrmRelativePath = (folderName: string) => {
    if (strmPathMode === 'full-path') {
      return [...breadcrumbNames, folderName].filter(Boolean).join('/');
    }
    return folderName;
  };

  const strmPathPreviews = selectedFolders.map((folder) => buildStrmRelativePath(folder.name));

  const handleOpenGenerateStrm = () => {
    if (selectedFolders.length === 0) {
      toast.warning('请先勾选至少一个文件夹');
      return;
    }
    setStrmPathMode('selected-name');
    setStrmOverwrite(false);
    setStrmLocalPathPrefix('');
    setIsGenerateStrmOpen(true);
  };

  const handleGenerateStrm = async () => {
    if (!selectedAccountId || selectedFolders.length === 0 || strmSubmitting) return;
    setStrmSubmitting(true);
    try {
      const directories = selectedFolders.map((folder) => ({
        folderId: folder.id,
        name: folder.name,
        path: buildStrmRelativePath(folder.name),
      }));
      const response = await fetch('/api/file-manager/generate-strm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: selectedAccountId,
          directories,
          localPathPrefix: strmLocalPathPrefix.trim(),
          overwriteExisting: strmOverwrite,
        }),
      });
      const data = await response.json();
      if (!data.success) {
        toast.error('STRM 提交失败: ' + (data.error || '未知错误'));
        return;
      }
      toast.info(
        data.data?.message
          || `已提交 ${directories.length} 个目录生成 STRM，后台执行中`
      );
      setIsGenerateStrmOpen(false);
      setSelectedIds(new Set());
    } catch (error) {
      toast.error('STRM 提交失败');
    } finally {
      setStrmSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <select 
            value={selectedAccountId}
            onChange={handleAccountChange}
            className="bg-white border border-slate-300 rounded-full px-5 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 min-w-[200px]"
          >
            {accounts.length === 0 ? (
              <option value="">暂无可用账号</option>
            ) : (
              accounts.map(acc => (
                <option key={acc.id} value={acc.id}>
                  {acc.alias ? `${acc.username} (${acc.alias})` : acc.username}
                </option>
              ))
            )}
          </select>
          <button 
            onClick={handleBack}
            disabled={path.length <= 1 || loading}
            className="bg-white border border-slate-300 px-5 py-2.5 rounded-full text-sm font-medium hover:bg-slate-50 transition-all flex items-center gap-2 text-slate-700 disabled:opacity-50"
          >
            <ArrowLeft size={18} /> 返回上级
          </button>
          <button 
            onClick={handleRefresh}
            disabled={!selectedAccountId || loading}
            className="bg-white border border-slate-300 px-5 py-2.5 rounded-full text-sm font-medium hover:bg-slate-50 transition-all flex items-center gap-2 text-slate-700 disabled:opacity-50"
          >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} /> 刷新
          </button>
        </div>
        <div className="flex gap-3 flex-wrap">
          <button
            onClick={handleCreateFolder}
            disabled={!selectedAccountId || loading}
            className="bg-[#0b57d0] text-white px-5 py-2.5 rounded-full text-sm font-medium hover:bg-[#0b57d0]/90 transition-all flex items-center gap-2 shadow-sm disabled:opacity-50"
          >
            <Plus size={18} /> 新建目录
          </button>
          <button
            onClick={handleOpenOrganize}
            disabled={selectedIds.size === 0 || loading || organizeSubmitting}
            className="bg-[#e8f0fe] text-[#0b57d0] px-5 py-2.5 rounded-full text-sm font-medium hover:bg-[#d3e3fd] transition-all flex items-center gap-2 disabled:opacity-50"
          >
            <FolderTree size={18} /> 整理选中
          </button>
          <button
            onClick={handleOpenGenerateStrm}
            disabled={selectedFolders.length === 0 || loading || strmSubmitting}
            className="bg-[#e6f4ea] text-[#137333] px-5 py-2.5 rounded-full text-sm font-medium hover:bg-[#ceead6] transition-all flex items-center gap-2 disabled:opacity-50"
          >
            <FileVideo size={18} /> 生成STRM
          </button>
          <button
            onClick={() => setIsFolderSelectorOpen(true)}
            disabled={selectedIds.size === 0 || loading}
            className="bg-[#d3e3fd] text-[#041e49] px-5 py-2.5 rounded-full text-sm font-medium hover:bg-[#c2e7ff] transition-all flex items-center gap-2 disabled:opacity-50"
          >
            <Move size={18} /> 移动选中
          </button>
          <button
            onClick={() => handleDelete(selectedEntries)}
            disabled={selectedIds.size === 0 || loading}
            className="bg-[#f8dada] text-[#900b09] px-5 py-2.5 rounded-full text-sm font-medium hover:bg-[#f8dada]/80 transition-all flex items-center gap-2 disabled:opacity-50"
          >
            <Trash2 size={18} /> 删除选中
          </button>
        </div>
      </div>

      <div className="ui-card p-4 flex flex-col md:flex-row md:items-center justify-between shadow-sm gap-4">
        <div className="flex items-center flex-wrap gap-1 text-sm ui-muted px-2">
          <Files size={18} className="mr-1" />
          {path.map((segment, index) => (
            <React.Fragment key={segment.id}>
              {index > 0 && <ChevronRight size={16} />}
              <span 
                className={`cursor-pointer font-medium hover:text-[#0b57d0] ${index === path.length - 1 ? 'text-slate-900' : ''}`}
                onClick={() => handleBreadcrumbClick(index)}
              >
                {segment.name}
              </span>
            </React.Fragment>
          ))}
        </div>
        <div className="flex items-center gap-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input 
              type="text" 
              placeholder="筛选当前目录..." 
              value={filterKeyword}
              onChange={e => setFilterKeyword(e.target.value)}
              className="pl-10 pr-4 py-2 bg-slate-50 border border-slate-300 rounded-full text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 w-56"
            />
          </div>
          <span className="text-sm ui-muted font-medium whitespace-nowrap">
            {driveLabel && `${driveLabel} · `}共 {visibleEntries.length} 项
          </span>
        </div>
      </div>

      <div className="ui-card shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50/50 border-b border-slate-100">
              <tr>
                <th className="px-6 py-4 w-12">
                  <Checkbox
                    size="sm"
                    onChange={handleSelectAll}
                    checked={visibleEntries.length > 0 && visibleSelectedCount === visibleEntries.length}
                    indeterminate={visibleSelectedCount > 0 && visibleSelectedCount < visibleEntries.length}
                  />
                </th>
                <th className="px-6 py-4 font-medium text-slate-500">名称</th>
                <th className="px-6 py-4 font-medium text-slate-500">类型</th>
                <th className="px-6 py-4 font-medium text-slate-500">大小</th>
                <th className="px-6 py-4 font-medium text-slate-500">更新时间</th>
                <th className="px-6 py-4 font-medium text-slate-500 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && entries.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                    <RefreshCw className="animate-spin mx-auto mb-2" />
                    加载中...
                  </td>
                </tr>
              ) : visibleEntries.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                    暂无文件
                  </td>
                </tr>
              ) : (
                visibleEntries.map(entry => (
                  <tr key={entry.id} className="hover:bg-slate-50/50 transition-colors group">
                    <td className="px-6 py-4">
                      <Checkbox
                        size="sm"
                        checked={selectedIds.has(entry.id)}
                        onChange={() => toggleSelect(entry.id)}
                      />
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-xl ${entry.isFolder ? 'bg-[#d3e3fd] text-[#0b57d0]' : 'bg-slate-100 text-slate-500'}`}>
                          {entry.isFolder ? <Folder size={20} /> : <FileText size={20} />}
                        </div>
                        <span 
                          className={`font-medium ui-title ${entry.isFolder ? 'cursor-pointer hover:text-[#0b57d0]' : ''}`}
                          onClick={() => entry.isFolder && handleNavigate(entry.id, entry.name)}
                        >
                          {entry.name}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-slate-500">
                      {entry.isFolder ? '文件夹' : (entry.ext?.replace('.', '').toUpperCase() || '文件')}
                    </td>
                    <td className="px-6 py-4 text-slate-500">{entry.isFolder ? '-' : formatBytes(entry.size)}</td>
                    <td className="px-6 py-4 text-slate-500">{entry.lastOpTime}</td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {!entry.isFolder && (
                          <>
                            <button 
                              onClick={() => handleGetLink(entry, true)}
                              className="p-2 hover:bg-slate-100 rounded-full text-slate-500 hover:text-[#0b57d0] transition-colors"
                              title="打开直链"
                            >
                              <ExternalLink size={18} />
                            </button>
                            <button 
                              onClick={() => handleGetLink(entry, false)}
                              className="p-2 hover:bg-slate-100 rounded-full text-slate-500 hover:text-[#0b57d0] transition-colors"
                              title="复制直链"
                            >
                              <Copy size={18} />
                            </button>
                          </>
                        )}
                        <div className="relative" data-file-item-menu>
                          <button
                            type="button"
                            onClick={() => setOpenFileMenuId(prev => prev === entry.id ? null : entry.id)}
                            className="p-2 hover:bg-slate-100 rounded-full text-slate-500 hover:text-slate-900 transition-colors"
                          >
                            <MoreVertical size={18} />
                          </button>
                          {openFileMenuId === entry.id && (
                            <div className="absolute right-0 top-full mt-1 w-32 bg-white border border-slate-200 rounded-xl shadow-lg py-1 z-50">
                              <button
                                onClick={() => {
                                  setOpenFileMenuId(null);
                                  navigator.clipboard.writeText(entry.id);
                                  toast.success('已复制 ID');
                                }}
                                className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-sm text-slate-700 transition-colors"
                              >
                                复制 ID
                              </button>
                              <button
                                onClick={() => {
                                  setOpenFileMenuId(null);
                                  handleRename(entry);
                                }}
                                className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-sm text-slate-700 transition-colors"
                              >
                                重命名
                              </button>
                              <button
                                onClick={() => {
                                  setOpenFileMenuId(null);
                                  handleDelete([entry]);
                                }}
                                className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-sm text-red-600 transition-colors"
                              >
                                删除
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <FolderSelector
        isOpen={isFolderSelectorOpen}
        onClose={() => setIsFolderSelectorOpen(false)}
        accountId={Number(selectedAccountId)}
        accountName={selectedAccount?.username || ''}
        title="选择移动目标目录"
        onSelect={(folder: SelectedFolder) => {
          if (folder.accountId !== Number(selectedAccountId)) {
            toast.warning('不能跨账号移动文件，请选择当前账号下的目标目录');
            return;
          }
          handleMove(folder.id);
        }}
      />

      <Modal
        isOpen={isOrganizeOpen}
        onClose={() => {
          if (!organizeSubmitting) setIsOrganizeOpen(false);
        }}
        title="整理选中项"
        maxWidthClass="max-w-lg"
        footer={
          <div className="px-8 py-6 flex shrink-0 justify-end gap-3">
            <button
              type="button"
              onClick={() => setIsOrganizeOpen(false)}
              disabled={organizeSubmitting}
              className="px-6 py-2.5 rounded-full text-sm font-medium text-[#0b57d0] hover:bg-[#0b57d0]/10 transition-colors disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleOrganize}
              disabled={organizeSubmitting || selectedEntries.length === 0}
              className="px-6 py-2.5 rounded-full text-sm font-medium bg-[#0b57d0] text-white hover:bg-[#0b57d0]/90 transition-colors shadow-sm disabled:opacity-50"
            >
              {organizeSubmitting ? '整理中…' : '开始整理'}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
            选中的 <span className="font-medium text-[var(--text-primary)]">{selectedEntries.length}</span> 个顶层项将各自识别为独立作品，
            归档到当前目录下的{' '}
            <code className="text-xs bg-[var(--bg-main)] border border-[var(--modal-border)] text-[var(--text-primary)] px-1.5 py-0.5 rounded">
              分类/作品名 (年份)
            </code>{' '}
            结构。提交后后台执行，不卡住页面；不创建转存任务。
          </p>
          <div className="rounded-2xl border border-[var(--modal-border)] bg-[var(--bg-main)]/60 p-4 space-y-1 max-h-36 overflow-y-auto">
            {selectedEntries.map((entry) => (
              <div key={entry.id} className="text-sm text-[var(--text-primary)] flex items-center gap-2">
                {entry.isFolder ? (
                  <Folder size={14} className="text-[#0b57d0] dark:text-blue-400 shrink-0" />
                ) : (
                  <FileText size={14} className="text-[var(--text-secondary)] shrink-0" />
                )}
                <span className="truncate">{entry.name}</span>
              </div>
            ))}
          </div>
          <div className="space-y-3">
            <Checkbox
              size="sm"
              checked={organizeGeneratingStrm}
              onChange={(checked) => setOrganizeGeneratingStrm(checked)}
              label="生成 STRM"
              labelClassName="text-sm font-medium text-[var(--text-primary)]"
            />
            <Checkbox
              size="sm"
              checked={organizeUseAi}
              onChange={(checked) => setOrganizeUseAi(checked)}
              label="使用 AI 识别命名"
              labelClassName="text-sm font-medium text-[var(--text-primary)]"
            />
            <Checkbox
              size="sm"
              checked={organizeDeleteEmptySource}
              onChange={(checked) => setOrganizeDeleteEmptySource(checked)}
              label="删除搬空后的源文件夹"
              description="仅当选中项是文件夹且整理后目录内已无文件/子目录时删除，不会动分类目标目录"
              labelClassName="text-sm font-medium text-[var(--text-primary)]"
            />
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={isGenerateStrmOpen}
        onClose={() => {
          if (!strmSubmitting) setIsGenerateStrmOpen(false);
        }}
        title="生成 STRM"
        maxWidthClass="max-w-lg"
        footer={
          <div className="px-8 py-6 flex shrink-0 justify-end gap-3">
            <button
              type="button"
              onClick={() => setIsGenerateStrmOpen(false)}
              disabled={strmSubmitting}
              className="px-6 py-2.5 rounded-full text-sm font-medium text-[#0b57d0] hover:bg-[#0b57d0]/10 transition-colors disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleGenerateStrm}
              disabled={strmSubmitting || selectedFolders.length === 0}
              className="px-6 py-2.5 rounded-full text-sm font-medium bg-[#137333] text-white hover:bg-[#0f5f29] transition-colors shadow-sm disabled:opacity-50"
            >
              {strmSubmitting ? '提交中…' : '开始生成'}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
            对选中的{' '}
            <span className="font-medium text-[var(--text-primary)]">{selectedFolders.length}</span>{' '}
            个文件夹按云盘现有子树镜像生成 STRM，不移动、不重命名、不创建任务。提交后后台执行。
          </p>

          <div className="rounded-2xl border border-[var(--modal-border)] bg-[var(--bg-main)]/60 p-4 space-y-1 max-h-36 overflow-y-auto">
            {selectedFolders.map((folder, index) => (
              <div key={folder.id} className="text-sm text-[var(--text-primary)] flex items-start gap-2">
                <Folder size={14} className="text-[#0b57d0] dark:text-blue-400 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="truncate font-medium">{folder.name}</div>
                  <div className="text-xs text-[var(--text-secondary)] truncate">
                    将写入: strm/{strmPathPreviews[index] || folder.name}/...
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium text-[var(--text-primary)]">本地路径模式</div>
            <label className="flex items-start gap-3 cursor-pointer select-none">
              <input
                type="radio"
                name="strm-path-mode"
                className="mt-1"
                checked={strmPathMode === 'selected-name'}
                onChange={() => setStrmPathMode('selected-name')}
              />
              <span className="text-sm text-[var(--text-primary)]">
                仅用选中目录名
                <span className="block text-xs text-[var(--text-secondary)] mt-0.5">
                  emby 下选「电影」→ strm/电影/...（忽略上级 emby）
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 cursor-pointer select-none">
              <input
                type="radio"
                name="strm-path-mode"
                className="mt-1"
                checked={strmPathMode === 'full-path'}
                onChange={() => setStrmPathMode('full-path')}
              />
              <span className="text-sm text-[var(--text-primary)]">
                完整浏览路径
                <span className="block text-xs text-[var(--text-secondary)] mt-0.5">
                  emby 下选「电影」→ strm/emby/电影/...
                </span>
              </span>
            </label>
          </div>

          <div className="space-y-3">
            <Checkbox
              size="sm"
              checked={strmOverwrite}
              onChange={(checked) => setStrmOverwrite(checked)}
              label="覆盖已有 STRM"
              description="关闭时跳过已存在的 .strm 文件"
              labelClassName="text-sm font-medium text-[var(--text-primary)]"
            />
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-[var(--text-primary)]">
                本地路径前缀（可选）
              </label>
              <input
                type="text"
                value={strmLocalPathPrefix}
                onChange={(e) => setStrmLocalPathPrefix(e.target.value)}
                placeholder="留空 = 使用账号 localStrmPrefix"
                className="w-full px-4 py-2.5 rounded-2xl border border-[var(--modal-border)] bg-[var(--bg-main)] text-sm text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default FileManagerTab;
