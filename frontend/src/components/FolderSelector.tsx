import React, { useState, useEffect } from 'react';
import { Folder, ChevronLeft, RefreshCw, Star, Trash2, Check } from 'lucide-react';
import Modal from './Modal';

interface FolderEntry {
  id: string;
  name: string;
  isFolder: boolean;
  path: string;
}

interface FavoriteFolder {
  id: string;
  name: string;
  path: string;
  accountId: number;
  accountName: string;
}

export interface SelectedFolder {
  id: string;
  name: string;
  path: string;
  accountId: number;
  accountName: string;
}

interface FolderSelectorProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (folder: SelectedFolder) => void;
  accountId: number;
  accountName: string;
  title?: string;
}

const FolderSelector: React.FC<FolderSelectorProps> = ({ 
  isOpen, 
  onClose, 
  onSelect, 
  accountId, 
  accountName,
  title = "选择目录"
}) => {
  const [folderStack, setFolderStack] = useState<{ id: string, name: string }[]>([]);
  const [folderEntries, setFolderEntries] = useState<FolderEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [favorites, setFavorites] = useState<FavoriteFolder[]>([]);
  const [showFavorites, setShowFavorites] = useState(false);

  useEffect(() => {
    if (isOpen && accountId) {
      setFolderStack([]);
      fetchFolderEntries('');
      loadFavorites();
    }
  }, [isOpen, accountId]);

  const loadFavorites = () => {
    const saved = localStorage.getItem('folderFavorites');
    if (saved) {
      try {
        setFavorites(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to parse favorites', e);
      }
    }
  };

  const saveFavorite = (folder: { id: string, name: string, path: string }) => {
    const newFavorites = [...favorites];
    const exists = newFavorites.find(f => f.id === folder.id && f.accountId === accountId);
    if (!exists) {
      newFavorites.push({
        ...folder,
        accountId,
        accountName
      });
      setFavorites(newFavorites);
      localStorage.setItem('folderFavorites', JSON.stringify(newFavorites));
    }
  };

  const removeFavorite = (e: React.MouseEvent, id: string, accId: number) => {
    e.stopPropagation();
    const newFavorites = favorites.filter(f => !(f.id === id && f.accountId === accId));
    setFavorites(newFavorites);
    localStorage.setItem('folderFavorites', JSON.stringify(newFavorites));
  };

  const fetchFolderEntries = async (folderId: string = '') => {
    setLoading(true);
    try {
      const response = await fetch(`/api/file-manager/list?accountId=${accountId}&folderId=${encodeURIComponent(folderId)}`);
      const data = await response.json();
      if (data.success) {
        setFolderEntries((data.data.entries || []).filter((e: any) => e.isFolder));
      }
    } catch (error) {
      console.error('Failed to fetch folders:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleEnterFolder = (entry: FolderEntry) => {
    const newStack = [...folderStack, { id: entry.id, name: entry.name }];
    setFolderStack(newStack);
    fetchFolderEntries(entry.id);
  };

  const handleGoBack = () => {
    const newStack = [...folderStack];
    newStack.pop();
    setFolderStack(newStack);
    const parentFolder = newStack[newStack.length - 1];
    fetchFolderEntries(parentFolder?.id || '');
  };

  const handleConfirmSelect = (entry?: FolderEntry) => {
    let folderId = '';
    let folderName = '根目录';
    let folderPath = '/';
    
    if (entry) {
        folderId = entry.id;
        folderName = entry.name;
        folderPath = '/' + folderStack.map(s => s.name).concat(entry.name).join('/');
    } else if (folderStack.length > 0) {
        const last = folderStack[folderStack.length - 1];
        folderId = last.id;
        folderName = last.name;
        folderPath = '/' + folderStack.map(s => s.name).join('/');
    } else {
        folderId = '-11';
        folderName = '全部文件';
        folderPath = '/';
    }

    onSelect({
      id: folderId,
      name: folderName,
      path: folderPath,
      accountId,
      accountName
    });
    onClose();
  };

  const isFavorited = (id: string) => {
    return favorites.some(f => f.id === id && f.accountId === accountId);
  };

  const toggleFavorite = (e: React.MouseEvent, entry: FolderEntry) => {
    e.stopPropagation();
    const folderPath = '/' + folderStack.map(s => s.name).concat(entry.name).join('/');
    if (isFavorited(entry.id)) {
      removeFavorite(e, entry.id, accountId);
    } else {
      saveFavorite({ id: entry.id, name: entry.name, path: folderPath });
    }
  };

  const toggleCurrentFavorite = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (folderStack.length === 0) return;
    const last = folderStack[folderStack.length - 1];
    const folderPath = '/' + folderStack.map(s => s.name).join('/');
    if (isFavorited(last.id)) {
      removeFavorite(e, last.id, accountId);
    } else {
      saveFavorite({ id: last.id, name: last.name, path: folderPath });
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`${title} - ${accountName}`}
      footer={
        <div className="px-8 py-6 flex justify-between items-center border-t border-slate-100 bg-slate-50/50">
          <button 
            onClick={() => setShowFavorites(!showFavorites)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              showFavorites ? 'bg-amber-100 text-amber-700' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
          >
            <Star size={18} fill={showFavorites ? "currentColor" : "none"} />
            收藏夹 ({favorites.length})
          </button>
          <div className="flex gap-3">
            <button 
              onClick={() => handleConfirmSelect()} 
              className="px-6 py-2.5 rounded-full text-sm font-medium bg-[#0b57d0] text-white hover:bg-[#0b57d0]/90 transition-colors shadow-sm flex items-center gap-2"
            >
              <Check size={18} /> 选择当前目录
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {showFavorites ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-medium text-slate-700 flex items-center gap-2">
                <Star size={18} className="text-amber-500" fill="currentColor" /> 收藏的目录
              </h4>
              <button onClick={() => setShowFavorites(false)} className="text-sm text-[#0b57d0] hover:underline">返回浏览</button>
            </div>
            <div className="max-h-[400px] overflow-y-auto rounded-2xl border border-slate-100 divide-y divide-slate-50">
              {favorites.length === 0 ? (
                <div className="py-12 text-center text-slate-400 italic text-sm">暂无收藏的目录</div>
              ) : (
                favorites.map((fav, i) => (
                  <div 
                    key={i} 
                    className="flex items-center justify-between p-4 hover:bg-slate-50 transition-colors group cursor-pointer"
                    onClick={() => {
                      if (fav.accountId === accountId) {
                        // If same account, we could try to navigate there, but for now just select
                        onSelect({
                          id: fav.id,
                          name: fav.name,
                          path: fav.path,
                          accountId: fav.accountId,
                          accountName: fav.accountName
                        });
                        onClose();
                      }
                    }}
                  >
                    <div className="flex flex-col min-w-0">
                      <span className="text-sm font-medium text-slate-900 truncate">{fav.name}</span>
                      <span className="text-[10px] text-slate-500 truncate">{fav.accountName} : {fav.path}</span>
                    </div>
                    <button 
                      onClick={(e) => removeFavorite(e, fav.id, fav.accountId)}
                      className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-all opacity-0 group-hover:opacity-100"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 p-2 bg-slate-50 rounded-2xl overflow-x-auto text-xs text-slate-500 whitespace-nowrap scrollbar-none">
              <button onClick={() => { setFolderStack([]); fetchFolderEntries(''); }} className="hover:text-slate-900 shrink-0">根目录</button>
              {folderStack.map((folder, i) => (
                <React.Fragment key={folder.id}>
                  <span>/</span>
                  <button 
                    onClick={() => {
                      const newStack = folderStack.slice(0, i + 1);
                      setFolderStack(newStack);
                      fetchFolderEntries(folder.id);
                    }}
                    className={i === folderStack.length - 1 ? 'text-slate-900 font-medium' : 'hover:text-slate-900'}
                  >
                    {folder.name}
                  </button>
                </React.Fragment>
              ))}
            </div>

            <div className="flex items-center gap-2">
              {folderStack.length > 0 && (
                <button 
                  onClick={handleGoBack}
                  className="p-2.5 hover:bg-slate-100 rounded-2xl text-slate-600 transition-colors border border-slate-200"
                >
                  <ChevronLeft size={20} />
                </button>
              )}
              <div className="flex-1 font-medium text-slate-700 text-sm truncate flex items-center gap-2">
                {folderStack.length === 0 ? '根目录' : folderStack[folderStack.length - 1].name}
                {folderStack.length > 0 && (
                   <button 
                    onClick={toggleCurrentFavorite}
                    className="p-1 hover:bg-slate-100 rounded-full transition-colors"
                  >
                    <Star 
                      size={16} 
                      className={isFavorited(folderStack[folderStack.length-1].id) ? 'text-amber-500' : 'text-slate-300'} 
                      fill={isFavorited(folderStack[folderStack.length-1].id) ? 'currentColor' : 'none'}
                    />
                  </button>
                )}
              </div>
              <button 
                onClick={() => fetchFolderEntries(folderStack[folderStack.length-1]?.id || '')}
                className="p-2.5 hover:bg-slate-100 rounded-2xl text-slate-500 transition-colors border border-slate-200"
                title="刷新"
              >
                <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>

            <div className="max-h-[400px] overflow-y-auto rounded-2xl border border-slate-100">
              <table className="w-full text-left text-sm">
                <tbody className="divide-y divide-slate-100">
                  {loading ? (
                    <tr>
                      <td className="px-4 py-12 text-center text-slate-500">
                        <RefreshCw size={24} className="animate-spin mx-auto mb-2 opacity-20" />
                        加载中...
                      </td>
                    </tr>
                  ) : folderEntries.length === 0 ? (
                    <tr>
                      <td className="px-4 py-12 text-center text-slate-500">当前目录没有子目录</td>
                    </tr>
                  ) : folderEntries.map(entry => (
                    <tr key={entry.id} className="hover:bg-slate-50/50 transition-colors group">
                      <td 
                        className="px-4 py-3 font-medium text-slate-900 cursor-pointer flex items-center gap-3"
                        onClick={() => handleEnterFolder(entry)}
                      >
                        <Folder size={18} className="text-[#0b57d0]" />
                        <span className="truncate flex-1">{entry.name}</span>
                        <button 
                          onClick={(e) => toggleFavorite(e, entry)}
                          className="p-1.5 hover:bg-white rounded-full transition-all opacity-0 group-hover:opacity-100"
                        >
                          <Star 
                            size={16} 
                            className={isFavorited(entry.id) ? 'text-amber-500' : 'text-slate-300'} 
                            fill={isFavorited(entry.id) ? 'currentColor' : 'none'}
                          />
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            handleConfirmSelect(entry);
                          }}
                          className="px-3 py-1.5 bg-[#0b57d0]/10 text-[#0b57d0] hover:bg-[#0b57d0]/20 rounded-xl text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          选择
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};

export default FolderSelector;
