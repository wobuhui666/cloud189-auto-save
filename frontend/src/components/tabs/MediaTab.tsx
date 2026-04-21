import React, { useState, useEffect } from 'react';
import { 
  Monitor, 
  Cpu, 
  Link2, 
  Tv, 
  Globe, 
  Search, 
  Save, 
  RefreshCw, 
  Plus, 
  Trash2, 
  Edit3,
  Settings,
  AlertCircle
} from 'lucide-react';
import Modal from '../Modal';

interface MediaSettings {
  strm: {
    enable: boolean;
    useStreamProxy: boolean;
  };
  emby: {
    enable: boolean;
    serverUrl: string;
    apiKey: string;
    proxy: {
      enable: boolean;
      port: number;
    };
    prewarm: {
      enable: boolean;
      sessionPollIntervalMs: number;
      dedupeTtlMs: number;
    };
  };
  cloudSaver: {
    baseUrl: string;
    username: string;
    password: string;
  };
  tmdb: {
    enableScraper: boolean;
    tmdbApiKey: string;
  };
  openai: {
    enable: boolean;
    baseUrl: string;
    apiKey: string;
    model: string;
    flowControlEnabled: boolean;
    rename: {
      template: string;
      movieTemplate: string;
    }
  };
  alist: {
    enable: boolean;
    baseUrl: string;
    apiKey: string;
  };
  organizer: {
    categories: {
      tv: string;
      anime: string;
      movie: string;
      variety: string;
      documentary: string;
    }
  };
}

interface RegexPreset {
  name: string;
  description: string;
  sourceRegex: string;
  targetRegex: string;
  matchPattern: string;
  matchOperator: string;
  matchValue: string;
}

const initialSettings: MediaSettings = {
  strm: { enable: false, useStreamProxy: false },
  emby: {
    enable: false,
    serverUrl: '',
    apiKey: '',
    proxy: { enable: false, port: 8097 },
    prewarm: { enable: false, sessionPollIntervalMs: 30000, dedupeTtlMs: 300000 }
  },
  cloudSaver: { baseUrl: '', username: '', password: '' },
  tmdb: { enableScraper: false, tmdbApiKey: '' },
  openai: { 
    enable: false, 
    baseUrl: '', 
    apiKey: '', 
    model: '', 
    flowControlEnabled: false,
    rename: { template: '{name} - {se}{ext}', movieTemplate: '{name} ({year}){ext}' } 
  },
  alist: { enable: false, baseUrl: '', apiKey: '' },
  organizer: {
    categories: {
      tv: '电视剧',
      anime: '动漫',
      movie: '电影',
      variety: '综艺',
      documentary: '纪录片'
    }
  }
};

const MediaTab: React.FC = () => {
  const [settings, setSettings] = useState<MediaSettings>(initialSettings);
  const [regexPresets, setRegexPresets] = useState<RegexPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isRegexModalOpen, setIsRegexModalOpen] = useState(false);
  const [isEditRegexModalOpen, setIsEditRegexModalOpen] = useState(false);
  const [editingPresetIndex, setEditingPresetIndex] = useState<number | null>(null);
  const [regexForm, setRegexForm] = useState<RegexPreset>({
    name: '',
    description: '',
    sourceRegex: '',
    targetRegex: '',
    matchPattern: '',
    matchOperator: 'lt',
    matchValue: ''
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const settingsRes = await fetch('/api/settings');
      const settingsData = await settingsRes.json();
      
      if (settingsData.success) {
        // Merge with initial settings to ensure all nested objects exist
        const fetched = settingsData.data;
        setSettings({
          strm: { ...initialSettings.strm, ...fetched.strm },
          emby: {
            ...initialSettings.emby,
            ...fetched.emby,
            proxy: { ...initialSettings.emby.proxy, ...fetched.emby?.proxy },
            prewarm: { ...initialSettings.emby.prewarm, ...fetched.emby?.prewarm }
          },
          cloudSaver: { ...initialSettings.cloudSaver, ...fetched.cloudSaver },
          tmdb: { ...initialSettings.tmdb, ...fetched.tmdb },
          openai: {
            ...initialSettings.openai,
            ...fetched.openai,
            rename: { ...initialSettings.openai.rename, ...fetched.openai?.rename }
          },
          alist: { ...initialSettings.alist, ...fetched.alist },
          organizer: {
            ...initialSettings.organizer,
            ...fetched.organizer,
            categories: { ...initialSettings.organizer.categories, ...fetched.organizer?.categories }
          },
        });
      }

      try {
        const regexRes = await fetch('/api/settings/regex-presets');
        const regexData = await regexRes.json();
        if (regexData.success) {
          setRegexPresets(regexData.data || []);
        }
      } catch (error) {
        console.error('Failed to fetch regex presets:', error);
      }
    } catch (error) {
      console.error('Failed to fetch media settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await fetch('/api/settings/media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      const data = await response.json();
      if (data.success) {
        alert('媒体设置已成功保存');
      } else {
        alert('保存失败: ' + data.error);
      }
    } catch (error) {
      alert('保存失败: ' + (error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const updateSetting = (path: string, value: any) => {
    const parts = path.split('.');
    setSettings(prev => {
      const newSettings = { ...prev };
      let current: any = newSettings;
      for (let i = 0; i < parts.length - 1; i++) {
        current[parts[i]] = { ...current[parts[i]] };
        current = current[parts[i]];
      }
      current[parts[parts.length - 1]] = value;
      return newSettings;
    });
  };

  const handleRegexSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const newPresets = [...regexPresets];
    if (editingPresetIndex === null) {
      newPresets.push(regexForm);
    } else {
      newPresets[editingPresetIndex] = regexForm;
    }

    try {
      const response = await fetch('/api/settings/regex-presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regexPresets: newPresets })
      });
      const data = await response.json();
      if (data.success) {
        setRegexPresets(newPresets);
        setIsEditRegexModalOpen(false);
      } else {
        alert('保存预设失败: ' + data.error);
      }
    } catch (error) {
      alert('保存预设失败: ' + (error as Error).message);
    }
  };

  const deleteRegexPreset = async (index: number) => {
    if (!confirm('确定要删除这个正则预设吗？')) return;
    const newPresets = regexPresets.filter((_, i) => i !== index);
    try {
      const response = await fetch('/api/settings/regex-presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regexPresets: newPresets })
      });
      const data = await response.json();
      if (data.success) {
        setRegexPresets(newPresets);
      }
    } catch (error) {
      alert('删除预设失败');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw size={32} className="text-[#0b57d0] animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-8 pb-12">
      {/* OpenAI / AI Settings */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-medium text-slate-900 flex items-center gap-3">
            <Cpu size={24} className="text-[#0b57d0]" /> AI 辅助重命名
          </h3>
          <label className="relative inline-flex items-center cursor-pointer">
            <input 
              type="checkbox" 
              className="sr-only peer" 
              checked={settings.openai.enable}
              onChange={(e) => updateSetting('openai.enable', e.target.checked)}
            />
            <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#0b57d0]"></div>
          </label>
        </div>
        
        <div className={`bg-white rounded-3xl border border-slate-200/60 p-8 space-y-6 shadow-sm transition-opacity ${!settings.openai.enable && 'opacity-60 pointer-events-none'}`}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">API 地址</label>
              <input 
                type="text" 
                value={settings.openai.baseUrl}
                onChange={e => updateSetting('openai.baseUrl', e.target.value)}
                placeholder="https://api.openai.com/v1"
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">API Key</label>
              <input 
                type="password" 
                value={settings.openai.apiKey}
                onChange={e => updateSetting('openai.apiKey', e.target.value)}
                placeholder="sk-..."
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">模型名称</label>
              <input 
                type="text" 
                value={settings.openai.model}
                onChange={e => updateSetting('openai.model', e.target.value)}
                placeholder="gpt-3.5-turbo"
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
            <div className="md:col-span-2 space-y-2">
              <label className="text-sm font-medium text-slate-700">剧集命名模板</label>
              <input 
                type="text" 
                value={settings.openai.rename.template}
                onChange={e => updateSetting('openai.rename.template', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4">
            <div className="pr-6">
              <p className="text-sm font-medium text-slate-900">AI API 流控</p>
              <p className="text-xs text-slate-500">开启后会将 AI 请求串行排队，降低上游接口并发压力。</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={settings.openai.flowControlEnabled}
                onChange={e => updateSetting('openai.flowControlEnabled', e.target.checked)}
              />
              <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#0b57d0]"></div>
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">电影命名模板</label>
            <input 
              type="text" 
              value={settings.openai.rename.movieTemplate}
              onChange={e => updateSetting('openai.rename.movieTemplate', e.target.value)}
              className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
            />
          </div>
          <div className="bg-blue-50 p-4 rounded-2xl border border-blue-100 flex gap-3">
            <AlertCircle size={20} className="text-blue-600 shrink-0 mt-0.5" />
            <p className="text-xs text-blue-800 leading-relaxed">
              启用后AI重命名将优先执行。剧集模板示例：<code className="bg-blue-100 px-1.5 py-0.5 rounded text-blue-900">{'{name} - S{s}E{e}{ext}'}</code> → 北上 - S01E01.mkv
            </p>
          </div>
        </div>
      </section>

      {/* STRM Settings */}
      <section className="space-y-4">
        <h3 className="text-xl font-medium text-slate-900 flex items-center gap-3">
          <Link2 size={24} className="text-[#0b57d0]" /> STRM 设置
        </h3>
        <div className="bg-white rounded-3xl border border-slate-200/60 p-8 space-y-6 shadow-sm">
          <div className="flex flex-col gap-4">
            <label className="flex items-center gap-3 cursor-pointer group p-4 rounded-2xl border border-slate-100 bg-slate-50/50 hover:bg-slate-50 transition-colors">
              <div 
                onClick={() => updateSetting('strm.enable', !settings.strm.enable)}
                className={`w-6 h-6 rounded-lg border flex items-center justify-center transition-all ${
                  settings.strm.enable ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 bg-white'
                }`}
              >
                {settings.strm.enable && <div className="w-2.5 h-2.5 bg-white rounded-sm" />}
              </div>
              <div>
                <span className="text-sm font-medium text-slate-900">启用 STRM 生成</span>
                <p className="text-[10px] text-slate-400">允许系统为转存任务生成 .strm 播放文件</p>
              </div>
            </label>
            <label className="flex items-center gap-3 cursor-pointer group p-4 rounded-2xl border border-slate-100 bg-slate-50/50 hover:bg-slate-50 transition-colors">
              <div 
                onClick={() => updateSetting('strm.useStreamProxy', !settings.strm.useStreamProxy)}
                className={`w-6 h-6 rounded-lg border flex items-center justify-center transition-all ${
                  settings.strm.useStreamProxy ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 bg-white'
                }`}
              >
                {settings.strm.useStreamProxy && <div className="w-2.5 h-2.5 bg-white rounded-sm" />}
              </div>
              <div>
                <span className="text-sm font-medium text-slate-900">普通任务使用系统中转</span>
                <p className="text-[10px] text-slate-400">由服务端换取直链，避免临时直链过期</p>
              </div>
            </label>
          </div>
        </div>
      </section>

      {/* Emby Settings */}
      <section className="space-y-4">
        <h3 className="text-xl font-medium text-slate-900 flex items-center gap-3">
          <Tv size={24} className="text-[#0b57d0]" /> Emby 设置
        </h3>
        <div className="bg-white rounded-3xl border border-slate-200/60 p-8 space-y-6 shadow-sm">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Emby 地址</label>
              <input
                type="text"
                value={settings.emby.serverUrl}
                onChange={e => updateSetting('emby.serverUrl', e.target.value)}
                placeholder="http://127.0.0.1:8096"
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">API Key</label>
              <input
                type="password"
                value={settings.emby.apiKey}
                onChange={e => updateSetting('emby.apiKey', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
          </div>
          <div className="space-y-4">
            <div className="flex items-center gap-6 flex-wrap">
              <label className="flex items-center gap-3 cursor-pointer">
                <div
                  onClick={() => updateSetting('emby.enable', !settings.emby.enable)}
                  className={`w-6 h-6 rounded-lg border flex items-center justify-center transition-all ${
                    settings.emby.enable ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 bg-white'
                  }`}
                >
                  {settings.emby.enable && <div className="w-2.5 h-2.5 bg-white rounded-sm" />}
                </div>
                <span className="text-sm font-medium text-slate-900">启用 Emby 入库通知</span>
              </label>
            </div>
            <div className="flex items-center gap-6 flex-wrap">
              <label className="flex items-center gap-3 cursor-pointer">
                <div
                  onClick={() => updateSetting('emby.proxy.enable', !settings.emby.proxy.enable)}
                  className={`w-6 h-6 rounded-lg border flex items-center justify-center transition-all ${
                    settings.emby.proxy.enable ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 bg-white'
                  }`}
                >
                  {settings.emby.proxy.enable && <div className="w-2.5 h-2.5 bg-white rounded-sm" />}
                </div>
                <span className="text-sm font-medium text-slate-900">启用 Emby 反代播放</span>
              </label>
              {settings.emby.proxy.enable && (
                <div className="flex items-center gap-3">
                  <label className="text-sm font-medium text-slate-700">代理端口</label>
                  <input
                    type="number"
                    value={settings.emby.proxy.port}
                    onChange={e => updateSetting('emby.proxy.port', parseInt(e.target.value))}
                    className="w-24 px-4 py-2 bg-slate-50 border border-slate-300 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                  />
                </div>
              )}
            </div>
            <div className="flex items-center gap-6 flex-wrap">
              <label className="flex items-center gap-3 cursor-pointer">
                <div
                  onClick={() => updateSetting('emby.prewarm.enable', !settings.emby.prewarm.enable)}
                  className={`w-6 h-6 rounded-lg border flex items-center justify-center transition-all ${
                    settings.emby.prewarm.enable ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 bg-white'
                  }`}
                >
                  {settings.emby.prewarm.enable && <div className="w-2.5 h-2.5 bg-white rounded-sm" />}
                </div>
                <span className="text-sm font-medium text-slate-900">启用下一集预热</span>
              </label>
            </div>
            {settings.emby.prewarm.enable && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">Sessions 轮询间隔(ms)</label>
                  <input
                    type="number"
                    value={settings.emby.prewarm.sessionPollIntervalMs}
                    onChange={e => updateSetting('emby.prewarm.sessionPollIntervalMs', parseInt(e.target.value) || 30000)}
                    className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">预热去重时长(ms)</label>
                  <input
                    type="number"
                    value={settings.emby.prewarm.dedupeTtlMs}
                    onChange={e => updateSetting('emby.prewarm.dedupeTtlMs', parseInt(e.target.value) || 300000)}
                    className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* CloudSaver Settings */}
      <section className="space-y-4">
        <h3 className="text-xl font-medium text-slate-900 flex items-center gap-3">
          <Monitor size={24} className="text-[#0b57d0]" /> CloudSaver 设置
        </h3>
        <div className="bg-white rounded-3xl border border-slate-200/60 p-8 space-y-6 shadow-sm">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-2 md:col-span-3">
              <label className="text-sm font-medium text-slate-700">服务地址</label>
              <input
                type="text"
                value={settings.cloudSaver.baseUrl}
                onChange={e => updateSetting('cloudSaver.baseUrl', e.target.value)}
                placeholder="http://127.0.0.1:8008"
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">用户名</label>
              <input
                type="text"
                value={settings.cloudSaver.username}
                onChange={e => updateSetting('cloudSaver.username', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">密码</label>
              <input
                type="password"
                value={settings.cloudSaver.password}
                onChange={e => updateSetting('cloudSaver.password', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Alist & TMDB */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-medium text-slate-900 flex items-center gap-3">
              <Globe size={24} className="text-[#0b57d0]" /> Alist 设置
            </h3>
            <label className="relative inline-flex items-center cursor-pointer">
              <input 
                type="checkbox" 
                className="sr-only peer" 
                checked={settings.alist.enable}
                onChange={(e) => updateSetting('alist.enable', e.target.checked)}
              />
              <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#0b57d0]"></div>
            </label>
          </div>
          <div className={`bg-white rounded-3xl border border-slate-200/60 p-6 space-y-4 shadow-sm transition-opacity ${!settings.alist.enable && 'opacity-60 pointer-events-none'}`}>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500 block">Alist 地址</label>
              <input 
                type="text" 
                value={settings.alist.baseUrl}
                onChange={e => updateSetting('alist.baseUrl', e.target.value)}
                placeholder="http://127.0.0.1:5244"
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500 block">Token</label>
              <input 
                type="password" 
                value={settings.alist.apiKey}
                onChange={e => updateSetting('alist.apiKey', e.target.value)}
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-medium text-slate-900 flex items-center gap-3">
              <Search size={24} className="text-[#0b57d0]" /> TMDB 刮削
            </h3>
            <label className="relative inline-flex items-center cursor-pointer">
              <input 
                type="checkbox" 
                className="sr-only peer" 
                checked={settings.tmdb.enableScraper}
                onChange={(e) => updateSetting('tmdb.enableScraper', e.target.checked)}
              />
              <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#0b57d0]"></div>
            </label>
          </div>
          <div className={`bg-white rounded-3xl border border-slate-200/60 p-6 space-y-4 shadow-sm transition-opacity ${!settings.tmdb.enableScraper && 'opacity-60 pointer-events-none'}`}>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500 block">TMDB API Key</label>
              <input 
                type="password" 
                value={settings.tmdb.tmdbApiKey}
                onChange={e => updateSetting('tmdb.tmdbApiKey', e.target.value)}
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
            <p className="text-[10px] text-slate-400">用于在创建任务时自动识别电影/剧集信息。</p>
          </div>
        </section>
      </div>

      {/* Media Organizer Settings */}
      <section className="space-y-4">
        <h3 className="text-xl font-medium text-slate-900 flex items-center gap-3">
          <Settings size={24} className="text-[#0b57d0]" /> 媒体库分类命名
        </h3>
        <div className="bg-white rounded-3xl border border-slate-200/60 p-8 space-y-6 shadow-sm">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {Object.entries(settings.organizer.categories).map(([key, value]) => (
              <div key={key} className="space-y-1">
                <label className="text-xs font-medium text-slate-500 block">
                  {key === 'tv' ? '电视剧' : 
                   key === 'movie' ? '电影' : 
                   key === 'anime' ? '动漫' : 
                   key === 'variety' ? '综艺' : '纪录片'}
                </label>
                <input 
                  type="text" 
                  value={value}
                  onChange={e => updateSetting(`organizer.categories.${key}`, e.target.value)}
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Regex Presets Management */}
      <section className="space-y-4">
        <h3 className="text-xl font-medium text-slate-900 flex items-center gap-3">
          <Settings size={24} className="text-[#0b57d0]" /> 正则预设管理
        </h3>
        <div className="bg-white rounded-3xl border border-slate-200/60 p-8 shadow-sm">
          <div className="flex items-center justify-between mb-6">
            <p className="text-sm text-slate-500">预设常用的重命名和筛选规则，一键套用于任务。</p>
            <button 
              onClick={() => setIsRegexModalOpen(true)}
              className="px-6 py-2.5 bg-[#d3e3fd] text-[#041e49] rounded-full text-sm font-medium hover:bg-[#c2e7ff] transition-all flex items-center gap-2"
            >
              <Monitor size={18} /> 管理预设
            </button>
          </div>
          
          <div className="flex flex-wrap gap-3">
            {regexPresets.map((preset, index) => (
              <div key={index} className="px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium text-slate-600 flex items-center gap-2">
                <RefreshCw size={14} className="text-[#0b57d0]" /> {preset.name}
              </div>
            ))}
            {regexPresets.length === 0 && <p className="text-xs text-slate-400 italic">暂无保存的预设</p>}
          </div>
        </div>
      </section>

      {/* Save Button */}
      <div className="flex justify-end pt-4 gap-4 sticky bottom-8 z-10">
        <button 
          onClick={fetchData}
          className="px-8 py-3 bg-white border border-slate-300 text-slate-700 rounded-full font-medium shadow-lg hover:bg-slate-50 transition-all flex items-center gap-2"
        >
          <RefreshCw size={20} className={loading ? 'animate-spin' : ''} /> 放弃修改
        </button>
        <button 
          onClick={handleSave}
          disabled={saving}
          className="px-10 py-3 bg-[#0b57d0] text-white rounded-full font-medium shadow-lg hover:bg-[#0b57d0]/90 hover:shadow-xl transition-all flex items-center gap-2 disabled:opacity-70"
        >
          {saving ? <RefreshCw size={20} className="animate-spin" /> : <Save size={20} />} 保存媒体设置
        </button>
      </div>

      {/* Regex Management Modal */}
      <Modal
        isOpen={isRegexModalOpen}
        onClose={() => setIsRegexModalOpen(false)}
        title="正则预设管理"
        footer={null}
      >
        <div className="space-y-6 max-h-[70vh] overflow-y-auto pr-2">
          <div className="flex justify-end">
            <button 
              onClick={() => {
                setRegexForm({ name: '', description: '', sourceRegex: '', targetRegex: '', matchPattern: '', matchOperator: 'lt', matchValue: '' });
                setEditingPresetIndex(null);
                setIsEditRegexModalOpen(true);
              }}
              className="bg-[#0b57d0] text-white px-4 py-2 rounded-full text-sm font-medium flex items-center gap-2"
            >
              <Plus size={16} /> 新增预设
            </button>
          </div>
          <div className="space-y-3">
            {regexPresets.map((preset, index) => (
              <div key={index} className="p-4 bg-slate-50 rounded-2xl border border-slate-200 flex items-center justify-between group">
                <div>
                  <h4 className="font-bold text-slate-900 text-sm">{preset.name}</h4>
                  <p className="text-xs text-slate-500 mt-0.5">{preset.description || '无描述'}</p>
                </div>
                <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button 
                    onClick={() => {
                      setRegexForm(preset);
                      setEditingPresetIndex(index);
                      setIsEditRegexModalOpen(true);
                    }}
                    className="p-2 text-slate-600 hover:bg-slate-200 rounded-lg transition-colors"
                  >
                    <Edit3 size={16} />
                  </button>
                  <button 
                    onClick={() => deleteRegexPreset(index)}
                    className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))}
            {regexPresets.length === 0 && <p className="text-center py-8 text-slate-400">暂无预设</p>}
          </div>
        </div>
      </Modal>

      {/* Regex Add/Edit Modal */}
      <Modal
        isOpen={isEditRegexModalOpen}
        onClose={() => setIsEditRegexModalOpen(false)}
        title={editingPresetIndex === null ? "新增正则预设" : "编辑正则预设"}
        footer={null}
      >
        <form onSubmit={handleRegexSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500">名称</label>
              <input 
                type="text" 
                value={regexForm.name}
                onChange={e => setRegexForm({...regexForm, name: e.target.value})}
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500">描述</label>
              <input 
                type="text" 
                value={regexForm.description}
                onChange={e => setRegexForm({...regexForm, description: e.target.value})}
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500">源正则</label>
              <input 
                type="text" 
                value={regexForm.sourceRegex}
                onChange={e => setRegexForm({...regexForm, sourceRegex: e.target.value})}
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500">目标正则</label>
              <input 
                type="text" 
                value={regexForm.targetRegex}
                onChange={e => setRegexForm({...regexForm, targetRegex: e.target.value})}
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-500">筛选模式 (正则)</label>
            <input 
              type="text" 
              value={regexForm.matchPattern}
              onChange={e => setRegexForm({...regexForm, matchPattern: e.target.value})}
              className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500">运算符</label>
              <select 
                value={regexForm.matchOperator}
                onChange={e => setRegexForm({...regexForm, matchOperator: e.target.value})}
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              >
                <option value="lt">小于</option>
                <option value="gt">大于</option>
                <option value="eq">等于</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500">匹配值</label>
              <input 
                type="text" 
                value={regexForm.matchValue}
                onChange={e => setRegexForm({...regexForm, matchValue: e.target.value})}
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
          </div>
          <div className="flex gap-4 pt-4">
            <button 
              type="button"
              onClick={() => setIsEditRegexModalOpen(false)}
              className="flex-1 px-6 py-2.5 border border-slate-300 text-slate-700 rounded-full font-medium"
            >
              取消
            </button>
            <button 
              type="submit"
              className="flex-1 px-6 py-2.5 bg-[#0b57d0] text-white rounded-full font-medium shadow-md"
            >
              保存预设
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

export default MediaTab;
