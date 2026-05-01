import React, { useState, useEffect } from 'react';
import { Plus, RefreshCw, Trash2, Edit2, Folder, Magnet, AlertCircle, CheckCircle2, Power, Settings as SettingsIcon, Download, Search, ChevronRight, Loader2 } from 'lucide-react';
import Modal from '../Modal';
import FolderSelector, { SelectedFolder } from '../FolderSelector';

interface SearchResult { id: string; title: string; cover: string; url: string; source: string; directRss?: boolean; preview?: string[]; groups?: GroupResult[]; }
interface GroupResult { name: string; rssUrl: string; itemCount?: number; source: string; }

interface Account { id: number; username: string; alias?: string; }
interface SourcePreset { key: string; label: string; description: string; defaultRssUrl: string; }

interface PtSubscription {
  id: number;
  name: string;
  sourcePreset: string;
  rssUrl: string;
  includePattern: string;
  excludePattern: string;
  accountId: number;
  targetFolderId: string;
  targetFolder: string;
  enabled: boolean;
  lastCheckTime: string | null;
  lastStatus: string;
  lastMessage: string;
  releaseCount: number;
}

interface PtRelease {
  id: number;
  subscriptionId: number;
  title: string;
  status: string;
  qbTorrentHash: string;
  downloadPath: string;
  cloudFolderName: string;
  lastError: string;
  createdAt: string;
  updatedAt: string;
}

interface DownloaderSettings {
  type: string;
  baseUrl: string;
  username: string;
  password: string;
  categoryPrefix: string;
  tagPrefix: string;
  insecureSkipTlsVerify: boolean;
}

interface StrmOrganizeSettings {
  enabled: boolean;
  mode: 'regex' | 'ai';
  categoryFolder: string;
  fileTemplate: string;
  seasonRegex: string;
  episodeRegex: string;
  defaultSeason: number;
}

interface PtSettings {
  downloadRoot: string;
  pollCron: string;
  cleanupEnabled: boolean;
  cleanupCron: string;
  retryIntervalSec: number;
  autoDeleteSource: boolean;
  deleteCloudSource: boolean;
  enableStrm: boolean;
  strmOrganize: StrmOrganizeSettings;
  downloader: DownloaderSettings;
}

const DEFAULT_FORM = {
  name: '',
  sourcePreset: 'generic',
  rssUrl: '',
  includePattern: '',
  excludePattern: '',
  accountId: 0,
  targetFolderId: '',
  targetFolder: '',
  enabled: true
};

const PT_DIR_MEMORY_KEY = 'ptLastUsedDir';
const getLastUsedDir = () => {
  try { const r = localStorage.getItem(PT_DIR_MEMORY_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
};

const formatDateTime = (s: string | null) => {
  if (!s) return '从未';
  return new Date(s).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

const statusColor = (status: string) => {
  switch (status) {
    case 'completed': return 'bg-[#c4eed0] text-[#0d4f1f]';
    case 'downloading':
    case 'downloaded':
    case 'uploading': return 'bg-[#cfe1ff] text-[#0b3a86]';
    case 'failed':
    case 'upload_failed': return 'bg-[#f9dadc] text-[#b3261e]';
    case 'pending': return 'bg-slate-100 text-slate-500';
    default: return 'bg-slate-100 text-slate-500';
  }
};

const statusLabel = (status: string) => {
  const map: Record<string, string> = {
    pending: '排队中',
    downloading: '下载中',
    downloaded: '已下载',
    uploading: '秒传中',
    completed: '已完成',
    failed: '失败',
    upload_failed: '秒传失败'
  };
  return map[status] || status;
};

const PtTab: React.FC = () => {
  const [subs, setSubs] = useState<PtSubscription[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [presets, setPresets] = useState<SourcePreset[]>([]);
  const [loading, setLoading] = useState(true);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<PtSubscription | null>(null);
  const [formData, setFormData] = useState({ ...DEFAULT_FORM });

  const [folderSelectorOpen, setFolderSelectorOpen] = useState(false);

  const [isReleasesOpen, setIsReleasesOpen] = useState(false);
  const [currentSub, setCurrentSub] = useState<PtSubscription | null>(null);
  const [releases, setReleases] = useState<PtRelease[]>([]);
  const [releasesLoading, setReleasesLoading] = useState(false);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<PtSettings | null>(null);
  const [proxyServices, setProxyServices] = useState<Record<string, boolean>>({});
  const [testStatus, setTestStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // 搜索状态
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchGroups, setSearchGroups] = useState<GroupResult[]>([]);
  const [searchStep, setSearchStep] = useState<'search' | 'groups'>('search');
  const [searchSelectedTitle, setSearchSelectedTitle] = useState('');

  const fetchSubs = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/pt/subscriptions');
      const d = await r.json();
      if (d.success) setSubs(d.data || []);
    } finally {
      setLoading(false);
    }
  };

  const fetchMeta = async () => {
    try {
      const [accR, presetR] = await Promise.all([
        fetch('/api/accounts').then(r => r.json()),
        fetch('/api/pt/sources/presets').then(r => r.json())
      ]);
      if (accR.success) setAccounts(accR.data || []);
      if (presetR.success) setPresets(presetR.data || []);
    } catch { /* 静默处理 */ }
  };

  const fetchSettings = async () => {
    const r = await fetch('/api/settings');
    const d = await r.json();
    if (d.success) {
      const pt = d.data?.pt || {};
      const cas = d.data?.cas || {};
      const svc = d.data?.proxy?.services || {};
      const strmOrg = pt.strmOrganize || {};
      setSettings({
        downloadRoot: pt.downloadRoot || '',
        pollCron: pt.pollCron || '*/15 * * * *',
        cleanupEnabled: pt.cleanupEnabled !== false,
        cleanupCron: pt.cleanupCron || '0 */6 * * *',
        retryIntervalSec: Number(pt.retryIntervalSec || 300),
        autoDeleteSource: pt.autoDeleteSource !== false,
        deleteCloudSource: !!cas.deleteSourceAfterGenerate,
        enableStrm: pt.enableStrm !== false,
        strmOrganize: {
          enabled: strmOrg.enabled || false,
          mode: strmOrg.mode || 'regex',
          categoryFolder: strmOrg.categoryFolder || '动漫',
          fileTemplate: strmOrg.fileTemplate || '{title} S{season}E{episode}',
          seasonRegex: strmOrg.seasonRegex || '',
          episodeRegex: strmOrg.episodeRegex || '',
          defaultSeason: Number(strmOrg.defaultSeason || 1)
        },
        downloader: {
          type: pt.downloader?.type || 'qbittorrent',
          baseUrl: pt.downloader?.baseUrl || '',
          username: pt.downloader?.username || '',
          password: pt.downloader?.password || '',
          categoryPrefix: pt.downloader?.categoryPrefix || 'pt-sub-',
          tagPrefix: pt.downloader?.tagPrefix || 'pt-rel-',
          insecureSkipTlsVerify: !!pt.downloader?.insecureSkipTlsVerify
        }
      });
      setProxyServices({
        ptMikan: !!svc.ptMikan,
        ptAnibt: !!svc.ptAnibt,
        ptAnimegarden: !!svc.ptAnimegarden,
        ptNyaa: !!svc.ptNyaa,
        ptDmhy: !!svc.ptDmhy
      });
    }
  };

  useEffect(() => {
    fetchSubs();
    fetchMeta();
  }, []);

  const openAdd = () => {
    setEditing(null);
    const lastDir = getLastUsedDir();
    setFormData({
      ...DEFAULT_FORM,
      accountId: lastDir?.accountId || accounts[0]?.id || 0,
      targetFolderId: lastDir?.targetFolderId || '',
      targetFolder: lastDir?.targetFolder || '',
    });
    setIsModalOpen(true);
  };

  const openEdit = (sub: PtSubscription) => {
    setEditing(sub);
    setFormData({
      name: sub.name,
      sourcePreset: sub.sourcePreset || 'generic',
      rssUrl: sub.rssUrl || '',
      includePattern: sub.includePattern || '',
      excludePattern: sub.excludePattern || '',
      accountId: sub.accountId,
      targetFolderId: sub.targetFolderId,
      targetFolder: sub.targetFolder,
      enabled: sub.enabled
    });
    setIsModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.accountId) { alert('请选择天翼云盘账号'); return; }
    try {
      const url = editing ? `/api/pt/subscriptions/${editing.id}` : '/api/pt/subscriptions';
      const r = await fetch(url, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      const d = await r.json();
      if (d.success) {
        localStorage.setItem(PT_DIR_MEMORY_KEY, JSON.stringify({
          accountId: formData.accountId,
          targetFolderId: formData.targetFolderId,
          targetFolder: formData.targetFolder,
        }));
        setIsModalOpen(false);
        fetchSubs();
      } else {
        alert('保存失败: ' + d.error);
      }
    } catch {
      alert('操作失败');
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('删除订阅会一并清理其 release 记录（不会立即删除 qb 中已经在下的任务）。继续？')) return;
    try {
      const r = await fetch(`/api/pt/subscriptions/${id}`, { method: 'DELETE' });
      const d = await r.json();
      if (d.success) fetchSubs();
      else alert('删除失败: ' + d.error);
    } catch { alert('网络错误'); }
  };

  const handleToggle = async (sub: PtSubscription) => {
    try {
      const r = await fetch(`/api/pt/subscriptions/${sub.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !sub.enabled })
      });
      const d = await r.json();
      if (d.success) fetchSubs();
    } catch { alert('网络错误'); }
  };

  const handleRefresh = async (id: number) => {
    try {
      const r = await fetch(`/api/pt/subscriptions/${id}/refresh`, { method: 'POST' });
      const d = await r.json();
      if (d.success) {
        alert(`本次新增 ${d.data?.processed ?? 0} 条`);
        fetchSubs();
      } else {
        alert('刷新失败: ' + d.error);
      }
    } catch { alert('网络错误'); }
  };

  const openReleases = async (sub: PtSubscription) => {
    setCurrentSub(sub);
    setReleases([]);
    setIsReleasesOpen(true);
    setReleasesLoading(true);
    try {
      const r = await fetch(`/api/pt/subscriptions/${sub.id}/releases`);
      const d = await r.json();
      if (d.success) setReleases(d.data || []);
    } finally {
      setReleasesLoading(false);
    }
  };

  const refreshReleases = async () => {
    if (!currentSub) return;
    try {
      const r = await fetch(`/api/pt/subscriptions/${currentSub.id}/releases`);
      const d = await r.json();
      if (d.success) setReleases(d.data || []);
    } catch { /* 静默处理 */ }
  };

  const handleRetryRelease = async (id: number) => {
    try {
      const r = await fetch(`/api/pt/releases/${id}/retry`, { method: 'POST' });
      const d = await r.json();
      if (d.success) refreshReleases();
      else alert('重试失败: ' + d.error);
    } catch { alert('网络错误'); }
  };

  const handleDeleteRelease = async (id: number) => {
    if (!confirm('删除 release 同时会从 qb 中删掉对应任务（含本地文件），是否继续？')) return;
    try {
      const r = await fetch(`/api/pt/releases/${id}`, { method: 'DELETE' });
      const d = await r.json();
      if (d.success) refreshReleases();
      else alert('删除失败: ' + d.error);
    } catch { alert('网络错误'); }
  };

  const openSettings = async () => {
    await fetchSettings();
    setTestStatus(null);
    setIsSettingsOpen(true);
  };

  const handleSaveSettings = async () => {
    if (!settings) return;
    try {
      const cur = await fetch('/api/settings').then(r => r.json());
      if (!cur.success) { alert('读取设置失败'); return; }
      const merged = {
        ...cur.data,
        pt: settings,
        proxy: { ...cur.data.proxy, services: { ...cur.data.proxy?.services, ...proxyServices } }
      };
      const r = await fetch('/api/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(merged)
      });
      const d = await r.json();
      if (d.success) {
        alert('设置已保存');
        setIsSettingsOpen(false);
      } else {
        alert('保存失败: ' + d.error);
      }
    } catch {
      alert('保存失败');
    }
  };

  const handleTestDownloader = async () => {
    if (!settings) return;
    setTesting(true);
    try {
      // 先把当前编辑中的下载器配置临时保存（否则后端读到的是旧值）
      const cur = await fetch('/api/settings').then(r => r.json());
      if (cur.success) {
        await fetch('/api/settings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...cur.data, pt: settings, proxy: { ...cur.data.proxy, services: { ...cur.data.proxy?.services, ...proxyServices } } })
        });
      }
      const r = await fetch('/api/pt/downloader/test', { method: 'POST' });
      const d = await r.json();
      const result = d.data || { ok: false, message: d.error || '测试失败' };
      setTestStatus(result);
    } finally {
      setTesting(false);
    }
  };

  const handleSearch = async () => {
    if (!searchKeyword.trim()) return;
    setSearchLoading(true);
    setSearchResults([]);
    setSearchGroups([]);
    setSearchStep('search');
    try {
      const r = await fetch(`/api/pt/sources/search?preset=${encodeURIComponent(formData.sourcePreset)}&keyword=${encodeURIComponent(searchKeyword)}`);
      const text = await r.text();
      let d: any;
      try { d = JSON.parse(text); } catch { throw new Error(`服务器返回非 JSON: ${text.slice(0, 200)}`); }
      if (d.success) setSearchResults(d.data || []);
      else alert(d.error || '搜索失败');
    } catch (e: any) {
      alert(e.message || '搜索失败');
    } finally {
      setSearchLoading(false);
    }
  };

  const handleSelectAnime = async (anime: SearchResult) => {
    setSearchSelectedTitle(anime.title);

    // Nyaa/dmhy 等直接返回 RSS URL 的站点，字幕组已在搜索结果中
    if (anime.directRss) {
      if (anime.groups && anime.groups.length > 0) {
        setSearchGroups(anime.groups);
        setSearchStep('groups');
      } else {
        setFormData({
          ...formData,
          rssUrl: anime.url,
          name: formData.name || anime.title
        });
        setIsSearchOpen(false);
        setSearchKeyword('');
        setSearchResults([]);
        setSearchStep('search');
      }
      return;
    }

    setSearchLoading(true);
    setSearchGroups([]);
    setSearchStep('groups');
    try {
      const params = anime.source === 'mikan'
        ? `bangumiUrl=${encodeURIComponent(anime.url)}`
        : `bgmId=${encodeURIComponent(anime.id)}`;
      const r = await fetch(`/api/pt/sources/groups?preset=${encodeURIComponent(anime.source)}&${params}`);
      const text = await r.text();
      let d: any;
      try { d = JSON.parse(text); } catch { throw new Error(`服务器返回非 JSON: ${text.slice(0, 200)}`); }
      if (d.success) setSearchGroups(d.data || []);
      else alert(d.error || '获取字幕组失败');
    } catch (e: any) {
      alert(e.message || '获取字幕组失败');
    } finally {
      setSearchLoading(false);
    }
  };

  const handleSelectGroup = (group: GroupResult) => {
    setFormData({
      ...formData,
      rssUrl: group.rssUrl,
      name: `${searchSelectedTitle} - ${group.name}`
    });
    setIsSearchOpen(false);
    setSearchKeyword('');
    setSearchResults([]);
    setSearchGroups([]);
    setSearchStep('search');
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <button onClick={openAdd} className="bg-[#0b57d0] text-white px-6 py-2.5 rounded-full text-sm font-medium hover:bg-[#0b57d0]/90 transition-all shadow-sm flex items-center gap-2">
            <Plus size={18} /> 添加 PT 订阅
          </button>
          <button onClick={openSettings} className="border border-slate-200 px-5 py-2.5 rounded-full text-sm font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-2">
            <SettingsIcon size={16} /> PT 设置
          </button>
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200/60 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50/50 border-b border-slate-100">
              <tr>
                <th className="px-6 py-4 font-medium text-slate-500">名称</th>
                <th className="px-6 py-4 font-medium text-slate-500">来源</th>
                <th className="px-6 py-4 font-medium text-slate-500">目标</th>
                <th className="px-6 py-4 font-medium text-slate-500">状态</th>
                <th className="px-6 py-4 font-medium text-slate-500">最后检查</th>
                <th className="px-6 py-4 font-medium text-slate-500 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={6} className="px-6 py-4 text-center text-slate-500">加载中...</td></tr>
              ) : subs.length === 0 ? (
                <tr><td colSpan={6} className="px-6 py-4 text-center text-slate-500">暂无 PT 订阅</td></tr>
              ) : subs.map(sub => (
                <tr key={sub.id} className="hover:bg-slate-50/50 transition-colors">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-xl ${sub.enabled ? 'bg-[#cfe1ff] text-[#0b3a86]' : 'bg-slate-100 text-slate-400'}`}>
                        <Magnet size={20} />
                      </div>
                      <div className="flex flex-col">
                        <span className="font-medium text-slate-900 truncate max-w-[160px]" title={sub.name}>{sub.name}</span>
                        {!sub.enabled && <span className="text-[10px] text-red-500 font-bold uppercase">已禁用</span>}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-xs">
                    <div className="font-medium text-slate-700">{sub.sourcePreset}</div>
                    <div className="font-mono text-slate-400 truncate max-w-[220px]" title={sub.rssUrl}>{sub.rssUrl || '-'}</div>
                  </td>
                  <td className="px-6 py-4 text-xs text-slate-600">
                    <div className="truncate max-w-[200px]" title={sub.targetFolder}>{sub.targetFolder || sub.targetFolderId}</div>
                    <div className="text-slate-400">共 {sub.releaseCount || 0} 条</div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-1.5" title={sub.lastMessage || ''}>
                      {sub.lastStatus === 'ok' && <CheckCircle2 size={14} className="text-[#0d4f1f]" />}
                      {sub.lastStatus === 'error' && <AlertCircle size={14} className="text-[#b3261e]" />}
                      <span className="text-xs">{sub.lastStatus || 'unknown'}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-slate-500 text-xs">{formatDateTime(sub.lastCheckTime)}</td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => openReleases(sub)} className="p-2 hover:bg-[#0b57d0]/10 rounded-full text-[#0b57d0]" title="查看 release"><Folder size={18} /></button>
                      <button onClick={() => handleRefresh(sub.id)} className="p-2 hover:bg-slate-100 rounded-full text-slate-500" title="立即拉取"><RefreshCw size={18} /></button>
                      <button onClick={() => handleToggle(sub)} className={`p-2 hover:bg-slate-100 rounded-full ${sub.enabled ? 'text-orange-500' : 'text-green-600'}`} title={sub.enabled ? '停用' : '启用'}><Power size={18} /></button>
                      <button onClick={() => openEdit(sub)} className="p-2 hover:bg-slate-100 rounded-full text-slate-500" title="编辑"><Edit2 size={18} /></button>
                      <button onClick={() => handleDelete(sub.id)} className="p-2 hover:bg-slate-100 rounded-full text-red-500" title="删除"><Trash2 size={18} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 添加/编辑订阅 */}
      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={editing ? '编辑 PT 订阅' : '添加 PT 订阅'} footer={null}>
        <form onSubmit={handleSave} className="space-y-5">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">订阅名称</label>
            <input type="text" required value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })}
              className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20" />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">RSS 来源</label>
            <select value={formData.sourcePreset} onChange={e => {
              const preset = presets.find(p => p.key === e.target.value);
              setFormData({
                ...formData,
                sourcePreset: e.target.value,
                rssUrl: formData.rssUrl || preset?.defaultRssUrl || ''
              });
            }} className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none">
              {presets.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
            <p className="text-xs text-slate-500">{presets.find(p => p.key === formData.sourcePreset)?.description || ''}</p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">RSS URL</label>
            <div className="flex gap-2">
              <input type="text" value={formData.rssUrl} onChange={e => setFormData({ ...formData, rssUrl: e.target.value })}
                placeholder={presets.find(p => p.key === formData.sourcePreset)?.defaultRssUrl || ''}
                className="flex-1 px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 font-mono text-xs" />
              {['mikan', 'anibt', 'animegarden', 'nyaa', 'dmhy'].includes(formData.sourcePreset) && (
                <button type="button" onClick={() => { setIsSearchOpen(true); setSearchStep('search'); setSearchResults([]); setSearchGroups([]); setSearchKeyword(''); }}
                  className="px-4 py-3 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-2xl text-sm text-slate-600 transition-colors flex items-center gap-1.5 shrink-0">
                  <Search size={16} /> 搜索
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">包含正则（可选）</label>
              <input type="text" value={formData.includePattern} onChange={e => setFormData({ ...formData, includePattern: e.target.value })}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none font-mono text-xs"
                placeholder="例如: 1080p|2160p" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">排除正则（可选）</label>
              <input type="text" value={formData.excludePattern} onChange={e => setFormData({ ...formData, excludePattern: e.target.value })}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none font-mono text-xs"
                placeholder="例如: cam|ts.x264" />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">天翼云盘账号</label>
            <select value={formData.accountId} onChange={e => setFormData({ ...formData, accountId: Number(e.target.value), targetFolderId: '', targetFolder: '' })}
              className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none" required>
              <option value={0}>请选择</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.alias?.trim() || a.username}</option>)}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">目标目录</label>
            <div className="flex gap-2">
              <input type="text" readOnly value={formData.targetFolder || formData.targetFolderId} placeholder="点击右侧按钮选择目录"
                className="flex-1 px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none" />
              <button type="button" onClick={() => formData.accountId ? setFolderSelectorOpen(true) : alert('请先选择账号')}
                className="px-5 py-3 border border-slate-300 rounded-2xl text-sm font-medium hover:bg-slate-50">选择</button>
            </div>
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={formData.enabled} onChange={e => setFormData({ ...formData, enabled: e.target.checked })}
              className="w-4 h-4 rounded border-slate-300 text-[#0b57d0]" />
            <span className="text-sm font-medium text-slate-700">启用此订阅</span>
          </label>

          <div className="flex justify-end gap-3 pt-4">
            <button type="button" onClick={() => setIsModalOpen(false)} className="px-6 py-2.5 rounded-full text-sm font-medium text-[#0b57d0] hover:bg-[#0b57d0]/10">取消</button>
            <button type="submit" className="px-6 py-2.5 rounded-full text-sm font-medium bg-[#0b57d0] text-white hover:bg-[#0b57d0]/90 shadow-sm">保存</button>
          </div>
        </form>
      </Modal>

      <FolderSelector
        isOpen={folderSelectorOpen}
        onClose={() => setFolderSelectorOpen(false)}
        accountId={formData.accountId}
        accountName={(() => { const acc = accounts.find(a => a.id === formData.accountId); return acc ? (acc.alias?.trim() || acc.username) : ''; })()}
        onSelect={(folder: SelectedFolder) => {
          setFormData({ ...formData, targetFolderId: folder.id, targetFolder: folder.path || folder.name });
          setFolderSelectorOpen(false);
        }}
      />

      {/* releases 弹窗 */}
      <Modal isOpen={isReleasesOpen} onClose={() => setIsReleasesOpen(false)} title={`${currentSub?.name || '订阅'} 的 release`}>
        <div className="min-h-[400px]">
          <div className="flex justify-end mb-3">
            <button onClick={refreshReleases} className="px-4 py-2 rounded-full border border-slate-200 text-sm hover:bg-slate-50 flex items-center gap-2">
              <RefreshCw size={16} className={releasesLoading ? 'animate-spin' : ''} /> 刷新
            </button>
          </div>
          <div className="rounded-2xl border border-slate-100 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50/50 border-b border-slate-100">
                <tr>
                  <th className="px-4 py-3 font-medium text-slate-500">标题</th>
                  <th className="px-4 py-3 font-medium text-slate-500">状态</th>
                  <th className="px-4 py-3 font-medium text-slate-500">qb hash</th>
                  <th className="px-4 py-3 font-medium text-slate-500">更新时间</th>
                  <th className="px-4 py-3 font-medium text-slate-500 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {releasesLoading ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">加载中...</td></tr>
                ) : releases.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">暂无 release</td></tr>
                ) : releases.map(rel => (
                  <tr key={rel.id} className="hover:bg-slate-50/50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900 truncate max-w-[300px]" title={rel.title}>{rel.title}</div>
                      {rel.lastError && <div className="text-[11px] text-red-500 mt-0.5 truncate max-w-[300px]" title={rel.lastError}>{rel.lastError}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded-full text-xs ${statusColor(rel.status)}`}>{statusLabel(rel.status)}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-[10px] text-slate-400">{rel.qbTorrentHash ? rel.qbTorrentHash.slice(0, 12) + '…' : '-'}</td>
                    <td className="px-4 py-3 text-slate-500 text-xs">{formatDateTime(rel.updatedAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <button onClick={() => handleRetryRelease(rel.id)} className="p-1.5 hover:bg-slate-100 rounded-full text-slate-500" title="重试"><RefreshCw size={14} /></button>
                        <button onClick={() => handleDeleteRelease(rel.id)} className="p-1.5 hover:bg-slate-100 rounded-full text-red-500" title="删除"><Trash2 size={14} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Modal>

      {/* PT 设置 */}
      <Modal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} title="PT 设置" footer={null}>
        {!settings ? <div className="text-center text-slate-500 py-8">加载中...</div> : (
          <div className="space-y-5">
            <div className="rounded-2xl border border-slate-200 p-4 space-y-4">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-800"><Download size={16} /> 下载客户端</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2 md:col-span-2">
                  <label className="text-xs text-slate-500">类型</label>
                  <select value={settings.downloader.type} onChange={e => setSettings({ ...settings, downloader: { ...settings.downloader, type: e.target.value } })}
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none">
                    <option value="qbittorrent">qBittorrent</option>
                  </select>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <label className="text-xs text-slate-500">WebUI 地址</label>
                  <input type="text" value={settings.downloader.baseUrl} onChange={e => setSettings({ ...settings, downloader: { ...settings.downloader, baseUrl: e.target.value } })}
                    placeholder="http://192.168.1.10:8080"
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none font-mono text-xs" />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-slate-500">用户名</label>
                  <input type="text" value={settings.downloader.username} onChange={e => setSettings({ ...settings, downloader: { ...settings.downloader, username: e.target.value } })}
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none" />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-slate-500">密码</label>
                  <input type="password" value={settings.downloader.password} onChange={e => setSettings({ ...settings, downloader: { ...settings.downloader, password: e.target.value } })}
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none" />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-slate-500">分类前缀</label>
                  <input type="text" value={settings.downloader.categoryPrefix} onChange={e => setSettings({ ...settings, downloader: { ...settings.downloader, categoryPrefix: e.target.value } })}
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none" />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-slate-500">标签前缀</label>
                  <input type="text" value={settings.downloader.tagPrefix} onChange={e => setSettings({ ...settings, downloader: { ...settings.downloader, tagPrefix: e.target.value } })}
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none" />
                </div>
                <label className="flex items-center gap-2 md:col-span-2 cursor-pointer">
                  <input type="checkbox" checked={settings.downloader.insecureSkipTlsVerify}
                    onChange={e => setSettings({ ...settings, downloader: { ...settings.downloader, insecureSkipTlsVerify: e.target.checked } })}
                    className="w-4 h-4 rounded border-slate-300 text-[#0b57d0]" />
                  <span className="text-sm">允许自签 HTTPS（跳过证书校验）</span>
                </label>
              </div>
              <div className="flex items-center gap-3">
                <button type="button" onClick={handleTestDownloader} disabled={testing}
                  className="px-5 py-2 rounded-full border border-slate-300 text-sm hover:bg-slate-50 disabled:opacity-50">
                  {testing ? '测试中...' : '测试连接'}
                </button>
                {testStatus && (
                  <span className={`text-xs ${testStatus.ok ? 'text-green-600' : 'text-red-600'}`}>{testStatus.message}</span>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 p-4 space-y-4">
              <div className="text-sm font-medium text-slate-800">下载与定时</div>
              <div className="space-y-2">
                <label className="text-xs text-slate-500">下载根目录（容器内可见路径）</label>
                <input type="text" value={settings.downloadRoot} onChange={e => setSettings({ ...settings, downloadRoot: e.target.value })}
                  placeholder="例如：/downloads/pt" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none font-mono text-xs" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-xs text-slate-500">RSS 拉取 cron</label>
                  <input type="text" value={settings.pollCron} onChange={e => setSettings({ ...settings, pollCron: e.target.value })}
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none font-mono text-xs" />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-slate-500">清理 cron</label>
                  <input type="text" value={settings.cleanupCron} onChange={e => setSettings({ ...settings, cleanupCron: e.target.value })}
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none font-mono text-xs" />
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={settings.cleanupEnabled}
                  onChange={e => setSettings({ ...settings, cleanupEnabled: e.target.checked })}
                  className="w-4 h-4 rounded border-slate-300 text-[#0b57d0]" />
                <span className="text-sm">已完成 release 自动清理 qb 任务和本地文件</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer mt-2">
                <input type="checkbox" checked={settings.autoDeleteSource}
                  onChange={e => setSettings({ ...settings, autoDeleteSource: e.target.checked })}
                  className="w-4 h-4 rounded border-slate-300 text-[#0b57d0]" />
                <span className="text-sm">生成 .cas 后自动删除本地源文件</span>
              </label>
              <div className="flex items-center gap-2 mt-2 ml-6">
                <span className={`text-xs ${settings.deleteCloudSource ? 'text-emerald-600' : 'text-slate-400'}`}>
                  {settings.deleteCloudSource ? '✓ 网盘源文件会在 CAS 生成后自动删除' : '网盘源文件删除请在「媒体」选项卡中配置「生成后删除源文件」'}
                </span>
              </div>
              <label className="flex items-center gap-2 cursor-pointer mt-2">
                <input type="checkbox" checked={settings.enableStrm}
                  onChange={e => setSettings({ ...settings, enableStrm: e.target.checked })}
                  className="w-4 h-4 rounded border-slate-300 text-[#0b57d0]" />
                <span className="text-sm">上传完成后自动生成 STRM 文件</span>
              </label>
            </div>

            <div className="rounded-2xl border border-slate-200 p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-slate-800">STRM 文件整理</div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={settings.strmOrganize.enabled}
                    onChange={e => setSettings({ ...settings, strmOrganize: { ...settings.strmOrganize, enabled: e.target.checked } })}
                    className="w-4 h-4 rounded border-slate-300 text-[#0b57d0]" />
                  <span className="text-sm">启用整理</span>
                </label>
              </div>

              {settings.strmOrganize.enabled && (
                <>
                  <div className="space-y-2">
                    <label className="text-xs text-slate-500">整理模式</label>
                    <select value={settings.strmOrganize.mode}
                      onChange={e => setSettings({ ...settings, strmOrganize: { ...settings.strmOrganize, mode: e.target.value as 'regex' | 'ai' } })}
                      className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none">
                      <option value="regex">正则解析（轻量级，不依赖 AI）</option>
                      <option value="ai">AI+TMDB（需要配置 AI 和 TMDB）</option>
                    </select>
                  </div>

                  {settings.strmOrganize.mode === 'regex' && (
                    <>
                      <div className="space-y-2">
                        <label className="text-xs text-slate-500">分类目录名</label>
                        <input type="text" value={settings.strmOrganize.categoryFolder}
                          onChange={e => setSettings({ ...settings, strmOrganize: { ...settings.strmOrganize, categoryFolder: e.target.value } })}
                          placeholder="动漫"
                          className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs text-slate-500">文件名模板</label>
                        <input type="text" value={settings.strmOrganize.fileTemplate}
                          onChange={e => setSettings({ ...settings, strmOrganize: { ...settings.strmOrganize, fileTemplate: e.target.value } })}
                          placeholder="{title} S{season}E{episode}"
                          className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none font-mono text-xs" />
                        <p className="text-xs text-slate-400">可用变量: {'{title}'} {'{season}'} {'{episode}'} {'{subgroup}'} {'{resolution}'} {'{original}'}</p>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <label className="text-xs text-slate-500">季度提取正则（留空用默认）</label>
                          <input type="text" value={settings.strmOrganize.seasonRegex}
                            onChange={e => setSettings({ ...settings, strmOrganize: { ...settings.strmOrganize, seasonRegex: e.target.value } })}
                            placeholder="S(\d{1,2})|第(\d+)季"
                            className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none font-mono text-xs" />
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs text-slate-500">集数提取正则（留空用默认）</label>
                          <input type="text" value={settings.strmOrganize.episodeRegex}
                            onChange={e => setSettings({ ...settings, strmOrganize: { ...settings.strmOrganize, episodeRegex: e.target.value } })}
                            placeholder="第\d+[话話集]|EP?\d+"
                            className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none font-mono text-xs" />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs text-slate-500">默认季度（当无法提取时）</label>
                        <input type="number" value={settings.strmOrganize.defaultSeason} min={1}
                          onChange={e => setSettings({ ...settings, strmOrganize: { ...settings.strmOrganize, defaultSeason: Number(e.target.value) } })}
                          className="w-full px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none" />
                      </div>
                    </>
                  )}

                  {settings.strmOrganize.mode === 'ai' && (
                    <div className="text-xs text-slate-500 bg-slate-50 p-3 rounded-xl">
                      AI 模式需要在系统设置中配置 OpenAI 和 TMDB API Key。整理器会自动识别番剧信息并整理目录结构。
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="border-t border-slate-200 pt-4 mt-4">
              <h3 className="text-sm font-medium text-slate-700 mb-3">站点代理（需在系统设置中配置代理服务器）</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {[
                  { key: 'ptMikan', label: '蜜柑计划' },
                  { key: 'ptAnibt', label: 'AniBT' },
                  { key: 'ptAnimegarden', label: 'AnimeGarden' },
                  { key: 'ptNyaa', label: 'Nyaa' },
                  { key: 'ptDmhy', label: '动漫花园' }
                ].map(item => (
                  <label key={item.key} className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-slate-50">
                    <input type="checkbox" checked={!!proxyServices[item.key]}
                      onChange={e => setProxyServices({ ...proxyServices, [item.key]: e.target.checked })}
                      className="w-4 h-4 rounded border-slate-300 text-[#0b57d0]" />
                    <span className="text-sm">{item.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => setIsSettingsOpen(false)} className="px-6 py-2.5 rounded-full text-sm font-medium text-[#0b57d0] hover:bg-[#0b57d0]/10">取消</button>
              <button type="button" onClick={handleSaveSettings} className="px-6 py-2.5 rounded-full text-sm font-medium bg-[#0b57d0] text-white hover:bg-[#0b57d0]/90 shadow-sm">保存设置</button>
            </div>
          </div>
        )}
      </Modal>

      {/* 搜索 RSS */}
      <Modal isOpen={isSearchOpen} onClose={() => { setIsSearchOpen(false); setSearchKeyword(''); setSearchResults([]); setSearchGroups([]); setSearchStep('search'); setSearchSelectedTitle(''); }} title={searchStep === 'search' ? '搜索番剧' : `选择字幕组 - ${searchSelectedTitle}`} footer={null}>
        <div className="space-y-4">
          {searchStep === 'search' && (
            <>
              <div className="flex gap-2">
                <input type="text" value={searchKeyword} onChange={e => setSearchKeyword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSearch()}
                  placeholder="输入番剧名称搜索..."
                  className="flex-1 px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20" />
                <button type="button" onClick={handleSearch} disabled={searchLoading}
                  className="px-5 py-3 bg-[#0b57d0] text-white rounded-2xl text-sm font-medium hover:bg-[#0b57d0]/90 disabled:opacity-50 flex items-center gap-2">
                  {searchLoading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                  搜索
                </button>
              </div>
              <div className="max-h-96 overflow-y-auto space-y-2">
                {searchResults.length === 0 && !searchLoading && (
                  <p className="text-center text-slate-400 text-sm py-8">
                    {searchKeyword ? '无搜索结果' : '支持 Mikan、AniBT、AnimeGarden、Nyaa、动漫花园搜索'}
                  </p>
                )}
                {searchResults.map((anime) => (
                  <button key={anime.id} type="button" onClick={() => handleSelectAnime(anime)}
                    className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-slate-50 border border-slate-200 text-left transition-colors">
                    {anime.cover && <img src={anime.cover} alt="" className="w-12 h-16 object-cover rounded-lg bg-slate-100" />}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-800 truncate">{anime.title}</div>
                      <div className="text-xs text-slate-400">{anime.source}{anime.directRss ? (anime.groups && anime.groups.length > 0 ? ` · ${anime.groups.length} 个字幕组` : ' · 点击直接使用') : ''}</div>
                      {anime.preview && anime.preview.length > 0 && (
                        <div className="mt-1 space-y-0.5">
                          {anime.preview.map((t, i) => (
                            <div key={i} className="text-xs text-slate-400 truncate">· {t}</div>
                          ))}
                        </div>
                      )}
                    </div>
                    <ChevronRight size={16} className="text-slate-400 shrink-0" />
                  </button>
                ))}
              </div>
            </>
          )}
          {searchStep === 'groups' && (
            <>
              <button type="button" onClick={() => setSearchStep('search')}
                className="text-sm text-[#0b57d0] hover:underline">&larr; 返回搜索</button>
              <div className="max-h-96 overflow-y-auto space-y-2">
                {searchGroups.length === 0 && !searchLoading && (
                  <p className="text-center text-slate-400 text-sm py-8">未找到字幕组</p>
                )}
                {searchGroups.map((group, idx) => (
                  <button key={idx} type="button" onClick={() => handleSelectGroup(group)}
                    className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-slate-50 border border-slate-200 text-left transition-colors">
                    <div>
                      <div className="text-sm font-medium text-slate-800">{group.name}</div>
                      {group.itemCount != null && <div className="text-xs text-slate-400">{group.itemCount} 个资源</div>}
                    </div>
                    <span className="text-xs text-[#0b57d0] font-medium">使用此 RSS</span>
                  </button>
                ))}
                {searchLoading && (
                  <div className="flex items-center justify-center gap-2 py-8 text-slate-400 text-sm">
                    <Loader2 size={16} className="animate-spin" /> 获取字幕组中...
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
};

export default PtTab;
