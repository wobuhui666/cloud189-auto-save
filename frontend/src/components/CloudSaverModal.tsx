import React, { useState } from 'react';
import { Search, ExternalLink, Plus, RefreshCw } from 'lucide-react';
import Modal from './Modal';
import { useToast } from './ui/Toast';

interface CloudSaverModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTransfer: (data: any) => void;
}

const CloudSaverModal: React.FC<CloudSaverModalProps> = ({ isOpen, onClose, onTransfer }) => {
  const toast = useToast();
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const handleSearch = async () => {
    if (!keyword.trim() || loading) return;
    setLoading(true);
    setHasSearched(true);
    try {
      const response = await fetch(`/api/cloudsaver/search?keyword=${encodeURIComponent(keyword.trim())}`);
      const data = await response.json();
      if (data.success) {
        setResults(data.data || []);
      } else {
        setResults([]);
        toast.error(data.error || '搜索失败');
      }
    } catch (error) {
      console.error('Search failed:', error);
      setResults([]);
      toast.error('搜索失败，请检查网络或 CloudSaver 配置');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="CloudSaver 资源搜索"
      footer={null}
    >
      <div className="space-y-6">
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <input
              type="text"
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="搜索网盘资源..."
              className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 dark:bg-slate-800/60 dark:border-slate-700"
            />
            <Search size={20} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
          </div>
          <button
            onClick={handleSearch}
            disabled={loading || !keyword.trim()}
            className="px-6 py-3 bg-[#0b57d0] text-white rounded-2xl text-sm font-medium hover:bg-[#0b57d0]/90 transition-all flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? <RefreshCw size={18} className="animate-spin" /> : <Search size={18} />} 搜索
          </button>
        </div>

        <div className="max-h-[400px] overflow-y-auto space-y-3 custom-scrollbar pr-1">
          {loading ? (
            <div className="text-center py-20 text-slate-500">正在搜索优质资源...</div>
          ) : results.length === 0 ? (
            <div className="text-center py-20 text-slate-400">
              {hasSearched ? '未找到相关资源' : '输入关键字开始搜索'}
            </div>
          ) : results.map((res, i) => (
            <div
              key={res.url ? `${res.url}-${res.title || i}` : `result-${i}`}
              className="p-4 bg-white border border-slate-200 rounded-2xl hover:border-[#0b57d0]/30 transition-all group dark:bg-slate-900/60 dark:border-slate-700"
            >
              <div className="flex justify-between items-start gap-4">
                <div className="space-y-1">
                  <h4 className="font-medium text-slate-900 line-clamp-2 leading-snug dark:text-slate-100">{res.title}</h4>
                  <div className="flex items-center gap-3 text-xs text-slate-500">
                    <span>{res.size || '未知大小'}</span>
                    <span>{res.date || '未知日期'}</span>
                  </div>
                </div>
                <button
                  onClick={() => onTransfer({
                    shareLink: res.url,
                    accessCode: res.accessCode || '',
                    taskName: res.title
                  })}
                  className="shrink-0 p-2.5 bg-[#c4eed0] text-[#146c2e] rounded-xl hover:bg-[#b2e7c0] transition-colors"
                  title="一键转存"
                >
                  <Plus size={20} />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="bg-blue-50/50 p-4 rounded-2xl border border-blue-100 flex items-start gap-3 dark:bg-blue-500/10 dark:border-blue-500/20">
          <ExternalLink size={18} className="text-[#0b57d0] shrink-0 mt-0.5" />
          <p className="text-[10px] text-[#0b57d0] leading-relaxed dark:text-blue-300">
            提示：CloudSaver 会检索公开分享的资源。转存前请确保您的账号空间充足。部分资源可能需要提取码。
          </p>
        </div>
      </div>
    </Modal>
  );
};

export default CloudSaverModal;
