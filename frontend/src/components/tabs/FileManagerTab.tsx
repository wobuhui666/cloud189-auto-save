import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Files, ChevronRight, Search, LayoutGrid, MoreVertical, RefreshCw, ArrowLeft, FolderPlus, Move, Trash2, ExternalLink, Copy, FileText, Folder } from 'lucide-react';
import Modal from '../Modal';
import FolderSelector from '../FolderSelector';

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
    console.log(`FileManagerTab: fetchFiles account=${selectedAccountId} folder=${folderId}`);
    try {
      const response = await fetch(`/api/file-manager/list?accountId=${encodeURIComponent(selectedAccountId)}&folderId=${encodeURIComponent(folderId)}`);
      const data = await response.json();
      if (data.success) {
        setEntries(Array.isArray(data.data?.entries) ? data.data.entries : []);
        setDriveLabel(data.data?.driveLabel || '');
        setSelectedIds(new Set());
      } else {
        alert('加载文件失败: ' + data.error);
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
    const folderName = prompt('请输入新目录名称');
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
      } else {
        alert('创建目录失败: ' + data.error);
      }
    } catch (error) {
      alert('创建目录失败');
    }
  };

  const handleRename = async (entry: FileEntry) => {
    const newName = prompt('请输入新的名称', entry.name);
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
      } else {
        alert('重命名失败: ' + data.error);
      }
    } catch (error) {
      alert('重命名失败');
    }
  };

  const handleDelete = async (entriesToDelete: FileEntry[]) => {
    if (!window.confirm(`确定删除选中的 ${entriesToDelete.length} 个项目吗？`)) return;

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
      } else {
        alert('删除失败: ' + data.error);
      }
    } catch (error) {
      alert('删除失败');
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
        alert('移动成功');
        fetchFiles(path[path.length - 1].id);
      } else {
        alert('移动失败: ' + data.error);
      }
    } catch (error) {
      alert('移动失败');
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
          alert('直链已复制');
        }
      } else {
        alert('获取直链失败: ' + data.error);
      }
    } catch (error) {
      alert('获取直链失败');
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

  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      setSelectedIds(new Set(visibleEntries.map(e => e.id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const visibleEntries = entries.filter(e => 
    e.name.toLowerCase().includes(filterKeyword.toLowerCase())
  );

  const selectedEntries = entries.filter(e => selectedIds.has(e.id));
  const selectedAccount = accounts.find(a => String(a.id) === selectedAccountId);

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
        <div className="flex gap-3">
          <button 
            onClick={handleCreateFolder}
            disabled={!selectedAccountId || loading}
            className="bg-[#0b57d0] text-white px-5 py-2.5 rounded-full text-sm font-medium hover:bg-[#0b57d0]/90 transition-all flex items-center gap-2 shadow-sm disabled:opacity-50"
          >
            <Plus size={18} /> 新建目录
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

      <div className="bg-white rounded-3xl border border-slate-200/60 p-4 flex flex-col md:flex-row md:items-center justify-between shadow-sm gap-4">
        <div className="flex items-center flex-wrap gap-1 text-sm text-slate-500 px-2">
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
          <span className="text-sm text-slate-500 font-medium whitespace-nowrap">
            {driveLabel && `${driveLabel} · `}共 {visibleEntries.length} 项
          </span>
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200/60 shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50/50 border-b border-slate-100">
              <tr>
                <th className="px-6 py-4 w-12">
                  <input 
                    type="checkbox" 
                    className="rounded border-slate-400 text-[#0b57d0] focus:ring-[#0b57d0]" 
                    onChange={handleSelectAll}
                    checked={visibleEntries.length > 0 && selectedIds.size === visibleEntries.length}
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
                      <input 
                        type="checkbox" 
                        className="rounded border-slate-400 text-[#0b57d0] focus:ring-[#0b57d0]" 
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
                          className={`font-medium text-slate-900 ${entry.isFolder ? 'cursor-pointer hover:text-[#0b57d0]' : ''}`}
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
                                  alert('已复制 ID');
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
        onSelect={(folder) => handleMove(folder.id)}
      />
    </div>
  );
};

export default FileManagerTab;
