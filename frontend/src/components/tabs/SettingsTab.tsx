import React, { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Bell, MessageSquare, Shield, Globe, Cpu, Database, Save, RefreshCw, Key, Plus, Trash2, X, Settings, PlayCircle, Folder, Send, Search } from 'lucide-react';
import Modal from '../Modal';
import FolderSelector, { SelectedFolder } from '../FolderSelector';
import Checkbox from '../ui/Checkbox';
import Switch from '../ui/Switch';
import { useToast } from '../ui/Toast';
import { useDialog } from '../ui/Dialog';
import SettingsNav, { type SettingsNavItem } from '../ui/SettingsNav';

const parseIntOr = (raw: string, fallback: number) => {
  if (raw === '' || raw === '-' ) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
};

interface CustomPushConfig {
  name: string;
  description: string;
  url: string;
  method: 'GET' | 'POST' | 'PUT';
  contentType: string;
  enabled: boolean;
  fields: { type: string; key: string; value: string }[];
}

interface RegexPreset {
  id?: number;
  name: string;
  description: string;
  sourceRegex: string;
  targetRegex: string;
  matchPattern: string;
  matchOperator: string;
  matchValue: string;
}

const normalizeMatchOperator = (matchOperator?: string) => {
  if (matchOperator === 'regex') {
    return 'contains';
  }
  return matchOperator || '';
};

interface SettingsData {
  task: {
    taskExpireDays: number;
    taskCheckCron: string;
    cleanRecycleCron: string;
    lazyFileCleanupCron: string;
    maxRetries: number;
    retryInterval: number;
    enableAutoClearRecycle: boolean;
    enableAutoClearFamilyRecycle: boolean;
    enableAutoCleanLazyFiles: boolean;
    lazyFileRetentionHours: number;
    enableStorageAggregation: boolean;
    enableSessionKeepAlive: boolean;
    sessionKeepAliveCron: string;
    mediaSuffix: string;
    enableOnlySaveMedia: boolean;
    enableAutoCreateFolder: boolean;
    autoCreate: {
      accountId: string;
      targetFolderId: string;
      targetFolder: string;
    }
  };
  wecom: {
    enable: boolean;
    webhook: string;
    hasWebhook?: boolean;
  };
  telegram: {
    enable: boolean;
    proxyDomain: string;
    botToken: string;
    chatId: string;
    notifyOnSuccess?: boolean;
    notifyOnFailure?: boolean;
    notifyOnScrape?: boolean;
    bot: {
      enable: boolean;
      botToken: string;
      hasBotToken?: boolean;
      chatId: string;
      allowedChatIds: string[];
      adminChatIds: string[];
    }
  };
  wxpusher: {
    enable: boolean;
    spt: string;
    hasSpt?: boolean;
  };
  proxy: {
    host: string;
    port: number;
    username: string;
    password: string;
    hasPassword?: boolean;
    services: {
      telegram: boolean;
      tmdb: boolean;
      openai: boolean;
      cloud189: boolean;
      hdhive: boolean;
      customPush: boolean;
    }
  };
  bark: {
    enable: boolean;
    serverUrl: string;
    key: string;
    hasKey?: boolean;
  };
  system: {
    username: string;
    password: string;
    baseUrl: string;
    apiKey: string;
    hasApiKey?: boolean;
  };
  pushplus: {
    enable: boolean;
    token: string;
    hasToken?: boolean;
    topic: string;
    channel: string;
    webhook: string;
    to: string;
  };
  customPush: CustomPushConfig[];
  regexPresets?: RegexPreset[];
  strm?: {
    enable: boolean;
    useStreamProxy: boolean;
  };
  emby?: {
    enable: boolean;
    serverUrl: string;
    apiKey: string;
    proxy: {
      enable: boolean;
      port: number;
    }
  };
  tmdb?: {
    enableScraper: boolean;
    tmdbApiKey: string;
  };
  openai?: {
    enable: boolean;
    baseUrl: string;
    apiKey: string;
    model: string;
    rename?: {
      template: string;
      movieTemplate: string;
    }
  };
  alist?: {
    enable: boolean;
    baseUrl: string;
    apiKey: string;
  };
  hdhive: {
    enabled: boolean;
    baseUrl: string;
    cookie: string;
    hasCookie?: boolean;
    username: string;
    password: string;
    hasPassword?: boolean;
    clientId: string;
    apiKey: string;
    hasApiKey?: boolean;
    resourceUnlockActionId: string;
    browserBridge: {
      enabled: boolean;
      baseUrl: string;
      token: string;
      hasToken?: boolean;
    };
    checkin: {
      enabled: boolean;
      cron: string;
      autoVerify: boolean;
      randomTimeEnabled: boolean;
      randomWindowStart: string;
      randomWindowEnd: string;
    };
  };
}

const initialSettings: SettingsData = {
  task: {
    taskExpireDays: 3,
    taskCheckCron: '0 19-23 * * *',
    cleanRecycleCron: '0 */8 * * *',
    lazyFileCleanupCron: '0 */6 * * *',
    maxRetries: 3,
    retryInterval: 300,
    enableAutoClearRecycle: false,
    enableAutoClearFamilyRecycle: false,
    enableAutoCleanLazyFiles: false,
    lazyFileRetentionHours: 24,
    enableStorageAggregation: true,
    enableSessionKeepAlive: true,
    sessionKeepAliveCron: '0 */4 * * *',
    mediaSuffix: '.mkv;.iso;.ts;.mp4;.avi;.rmvb;.wmv;.m2ts;.mpg;.flv;.rm;.mov',
    enableOnlySaveMedia: true,
    enableAutoCreateFolder: false,
    autoCreate: { accountId: '', targetFolderId: '', targetFolder: '' }
  },
  wecom: { enable: false, webhook: '' },
  telegram: {
    enable: false,
    proxyDomain: '',
    botToken: '',
    chatId: '',
    notifyOnSuccess: true,
    notifyOnFailure: true,
    notifyOnScrape: false,
    bot: { enable: false, botToken: '', chatId: '', allowedChatIds: [], adminChatIds: [] }
  },
  wxpusher: { enable: false, spt: '' },
  proxy: {
    host: '',
    port: 0,
    username: '',
    password: '',
    services: { telegram: false, tmdb: false, openai: false, cloud189: false, hdhive: false, customPush: false }
  },
  bark: { enable: false, serverUrl: '', key: '' },
  system: { username: '', password: '', baseUrl: '', apiKey: '' },
  pushplus: { enable: false, token: '', topic: '', channel: '', webhook: '', to: '' },
  customPush: [],
  regexPresets: [],
  hdhive: {
    enabled: false,
    baseUrl: 'https://hdhive.com',
    cookie: '',
    username: '',
    password: '',
    clientId: '',
    apiKey: '',
    resourceUnlockActionId: '601a2054beb3034dd490287f5aa0d7c801f9e650c7',
    browserBridge: {
      enabled: false,
      baseUrl: '',
      token: ''
    },
    checkin: {
      enabled: false,
      cron: '35 8 * * *',
      autoVerify: true,
      randomTimeEnabled: false,
      randomWindowStart: '08:00',
      randomWindowEnd: '09:00'
    }
  }
};

const SettingsTab: React.FC = () => {
  const toast = useToast();
  const dialog = useDialog();
  const settingsNavItems: SettingsNavItem[] = [
    { id: 'settings-auth', label: '访问认证', keywords: ['认证', '用户名', '密码', 'api'] },
    { id: 'settings-task', label: '任务设置', keywords: ['任务', '过期', '重试', 'cron', '回收站'] },
    { id: 'settings-telegram', label: 'Telegram', keywords: ['telegram', 'tg', 'bot'] },
    { id: 'settings-push', label: '消息推送', keywords: ['推送', '企业微信', 'bark', 'pushplus'] },
    { id: 'settings-proxy', label: '网络代理', keywords: ['代理', 'proxy'] },
    { id: 'settings-hdhive', label: '影巢资源', keywords: ['影巢', 'hdhive'] },
    { id: 'settings-custom-push', label: '自定义推送', keywords: ['自定义推送', 'webhook'] },
    { id: 'settings-regex', label: '正则预设', keywords: ['正则', 'regex'] },
  ];
  const [visibleSectionIds, setVisibleSectionIds] = useState<string[] | null>(null);
  const [settings, setSettings] = useState<SettingsData>(initialSettings);
  const [accounts, setAccounts] = useState<{id: number, username: string, alias?: string}[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [keepAliveRunning, setKeepAliveRunning] = useState(false);

  // Folder Selector State
  const [isFolderSelectorOpen, setIsFolderSelectorOpen] = useState(false);

  // Custom Push Modal State
  const [isPushModalOpen, setIsPushModalOpen] = useState(false);
  const [editingPushIndex, setEditingPushIndex] = useState<number | null>(null);
  const [pushForm, setPushForm] = useState<CustomPushConfig>({
    name: '',
    description: '',
    url: '',
    method: 'POST',
    contentType: 'application/json',
    enabled: true,
    fields: []
  });

  // Regex Preset Modal State
  const [isRegexModalOpen, setIsRegexModalOpen] = useState(false);
  const [editingRegexIndex, setEditingRegexIndex] = useState<number | null>(null);
  const [regexForm, setRegexForm] = useState<RegexPreset>({
    name: '',
    description: '',
    sourceRegex: '',
    targetRegex: '',
    matchPattern: '',
    matchOperator: '',
    matchValue: ''
  });

  useEffect(() => {
    loadSettings();
    loadRegexPresets();
    fetchAccounts();
  }, []);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/settings');
      const data = await response.json();
      if (data.success) {
        const loaded = data.data || {};
        const normalized = {
          ...loaded,
          task: {
            ...initialSettings.task,
            ...(loaded.task || {}),
            autoCreate: {
              ...initialSettings.task.autoCreate,
              ...(loaded.task?.autoCreate || {})
            }
          },
          hdhive: {
            ...initialSettings.hdhive,
            ...(loaded.hdhive || {}),
            cookie: '',
            password: '',
            apiKey: '',
            browserBridge: {
              ...initialSettings.hdhive.browserBridge,
              ...(loaded.hdhive?.browserBridge || {}),
              token: ''
            },
            checkin: {
              ...initialSettings.hdhive.checkin,
              ...(loaded.hdhive?.checkin || {})
            }
          },
          telegram: {
            enable: loaded.telegram?.enable ?? loaded.telegram?.bot?.enable ?? false,
            proxyDomain: loaded.telegram?.proxyDomain || '',
            botToken: '',
            chatId: loaded.telegram?.chatId || loaded.telegram?.bot?.chatId || '',
            notifyOnSuccess: loaded.telegram?.notifyOnSuccess ?? true,
            notifyOnFailure: loaded.telegram?.notifyOnFailure ?? true,
            notifyOnScrape: loaded.telegram?.notifyOnScrape ?? false,
            bot: {
              enable: loaded.telegram?.bot?.enable ?? loaded.telegram?.enable ?? false,
              botToken: '',
              hasBotToken: !!(loaded.telegram?.bot?.hasBotToken || loaded.telegram?.hasBotToken),
              chatId: loaded.telegram?.bot?.chatId || loaded.telegram?.chatId || '',
              allowedChatIds: loaded.telegram?.bot?.allowedChatIds || [],
              adminChatIds: loaded.telegram?.bot?.adminChatIds || [],
            }
          },
          system: {
            ...initialSettings.system,
            ...(loaded.system || {}),
            password: '',
            apiKey: '',
            hasApiKey: !!loaded.system?.hasApiKey,
          },
          wecom: {
            ...initialSettings.wecom,
            ...(loaded.wecom || {}),
            webhook: '',
            hasWebhook: !!loaded.wecom?.hasWebhook,
          },
          bark: {
            ...initialSettings.bark,
            ...(loaded.bark || {}),
            key: '',
            hasKey: !!loaded.bark?.hasKey,
          },
          wxpusher: {
            ...initialSettings.wxpusher,
            ...(loaded.wxpusher || {}),
            spt: '',
            hasSpt: !!loaded.wxpusher?.hasSpt,
          },
          pushplus: {
            ...initialSettings.pushplus,
            ...(loaded.pushplus || {}),
            token: '',
            hasToken: !!loaded.pushplus?.hasToken,
          },
          proxy: {
            ...initialSettings.proxy,
            ...(loaded.proxy || {}),
            password: '',
            hasPassword: !!loaded.proxy?.hasPassword,
            services: {
              ...initialSettings.proxy.services,
              ...(loaded.proxy?.services || {})
            }
          },
          customPush: Array.isArray(loaded.customPush) ? loaded.customPush : initialSettings.customPush,
        };
        setSettings(prev => ({ ...initialSettings, ...normalized, regexPresets: prev.regexPresets }));
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchAccounts = async () => {
    try {
      const response = await fetch('/api/accounts');
      const data = await response.json();
      if (data.success) {
        setAccounts(data.data || []);
      }
    } catch (error) {
      console.error('Failed to fetch accounts:', error);
    }
  };

  const loadRegexPresets = async () => {
    try {
      const response = await fetch('/api/settings/regex-presets');
      const data = await response.json();
      if (data.success) {
        setSettings(prev => ({ ...prev, regexPresets: data.data || [] }));
      }
    } catch (error) {
      console.error('Failed to load regex presets:', error);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const { regexPresets, ...mainSettings } = settings;
      const normalizedSettings = {
        ...mainSettings,
        telegram: {
          ...mainSettings.telegram,
          enable: mainSettings.telegram.bot.enable,
          botToken: mainSettings.telegram.bot.botToken,
          chatId: mainSettings.telegram.bot.chatId,
          bot: {
            ...mainSettings.telegram.bot,
            allowedChatIds: [...new Set((mainSettings.telegram.bot.allowedChatIds || []).map(v => String(v).trim()).filter(Boolean))],
            adminChatIds: [...new Set((mainSettings.telegram.bot.adminChatIds || []).map(v => String(v).trim()).filter(Boolean))],
          }
        }
      };
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(normalizedSettings)
      });
      const data = await response.json();
      if (data.success) {
        // Also save regex presets
        await fetch('/api/settings/regex-presets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ regexPresets })
        });
        toast.success('设置已成功保存');
      } else {
        toast.error('保存失败: ' + data.error);
      }
    } catch (error) {
      console.error('Failed to save settings:', error);
      toast.error('保存失败: ' + (error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const generateApiKey = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let apiKey = '';
    for (let i = 0; i < 32; i++) {
      apiKey += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setSettings(prev => ({
      ...prev,
      system: { ...prev.system, apiKey }
    }));
  };

  const updateSettings = (path: string, value: any) => {
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

  const parseIdList = (raw: string) => [...new Set(raw.split('\n').map(v => v.trim()).filter(Boolean))];

  const testTelegramConfig = async () => {
    try {
      const response = await fetch('/api/settings/telegram/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram: {
            proxyDomain: settings.telegram.proxyDomain,
            bot: {
              enable: settings.telegram.bot.enable,
              botToken: settings.telegram.bot.botToken,
              chatId: settings.telegram.bot.chatId,
              allowedChatIds: settings.telegram.bot.allowedChatIds,
              adminChatIds: settings.telegram.bot.adminChatIds,
            }
          }
        })
      });
      const data = await response.json();
      if (data.success) {
        toast.success('测试消息已发送，请到 Telegram 查看');
      } else {
        toast.error('测试失败: ' + data.error);
      }
    } catch (error) {
      toast.error('测试失败: ' + (error as Error).message);
    }
  };

  const runKeepAlive = async () => {
    setKeepAliveRunning(true);
    try {
      const response = await fetch('/api/accounts/keep-alive', { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        const ok = data.data?.success || 0;
        const failed = data.data?.failed || 0;
        toast.success(`保活完成，成功 ${ok} 个${failed ? `，失败 ${failed} 个` : ''}`);
      } else {
        toast.error('保活失败: ' + data.error);
      }
    } catch (error) {
      toast.error('保活失败: ' + (error as Error).message);
    } finally {
      setKeepAliveRunning(false);
    }
  };

  const proxyServiceLabels: Record<string, string> = {
    telegram: 'Telegram',
    tmdb: 'TMDB',
    openai: 'OpenAI',
    cloud189: '天翼网盘',
    hdhive: '影巢',
    customPush: '自定义推送'
  };

  // Custom Push Handlers
  const handlePushSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const newConfigs = [...(settings.customPush || [])];
    if (editingPushIndex !== null) {
      newConfigs[editingPushIndex] = pushForm;
    } else {
      newConfigs.push(pushForm);
    }
    updateSettings('customPush', newConfigs);
    setIsPushModalOpen(false);
  };

  const deletePushConfig = async (index: number) => {
    const ok = await dialog.confirm({
      title: '删除推送配置',
      message: '确定删除此推送配置吗？',
      confirmText: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    const newConfigs = settings.customPush.filter((_, i) => i !== index);
    updateSettings('customPush', newConfigs);
  };

  const testPush = async (config: CustomPushConfig) => {
    try {
      const response = await fetch('/api/custom-push/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      const data = await response.json();
      if (data.success) toast.success('推送测试成功');
      else toast.error('测试失败: ' + data.error);
    } catch (e) {
      toast.error('测试失败');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw size={32} className="text-[#0b57d0] animate-spin" />
      </div>
    );
  }

  const selectedAccount = accounts.find(a => String(a.id) === settings.task.autoCreate.accountId);

  return (
    <div className="max-w-4xl space-y-8 pb-8">
      <SettingsNav items={settingsNavItems} onVisibleChange={setVisibleSectionIds} />

      {/* System Credentials */}
      <section id="settings-auth" className="space-y-4 scroll-mt-24" hidden={visibleSectionIds != null && !visibleSectionIds.includes('settings-auth')}>
        <h3 className="text-xl font-medium text-slate-900 flex items-center gap-3">
          <Shield size={24} className="text-[#0b57d0]" /> 访问认证
        </h3>
        <div className="bg-white rounded-3xl border border-slate-200/60 p-8 space-y-6 shadow-sm">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">管理员用户名</label>
              <input 
                type="text" 
                value={settings.system.username}
                onChange={(e) => updateSettings('system.username', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">管理员密码</label>
              <input 
                type="password" 
                value={settings.system.password}
                onChange={(e) => updateSettings('system.password', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder="留空则不修改"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">系统 API Key</label>
            <div className="flex gap-3">
              <input
                type="password"
                value={settings.system.apiKey}
                onChange={(e) => updateSettings('system.apiKey', e.target.value)}
                placeholder={settings.system.hasApiKey ? '已保存 API Key；留空不覆盖' : '系统 API Key'}
                className="flex-1 px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
              <button 
                onClick={generateApiKey}
                className="px-6 py-3 bg-[#d3e3fd] text-[#041e49] rounded-2xl text-sm font-medium hover:bg-[#c2e7ff] transition-colors flex items-center gap-2"
              >
                <Key size={18} /> 生成
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Task Settings */}
      <section id="settings-task" className="space-y-4 scroll-mt-24" hidden={visibleSectionIds != null && !visibleSectionIds.includes('settings-task')}>
        <h3 className="text-xl font-medium text-slate-900 flex items-center gap-3">
          <Database size={24} className="text-[#0b57d0]" /> 任务设置
        </h3>
        <div className="bg-white rounded-3xl border border-slate-200/60 p-8 space-y-6 shadow-sm">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">任务过期天数</label>
              <input 
                type="number" 
                value={settings.task.taskExpireDays}
                onChange={(e) => updateSettings('task.taskExpireDays', parseIntOr(e.target.value, 15))}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">最大重试次数</label>
              <input 
                type="number" 
                value={settings.task.maxRetries}
                onChange={(e) => updateSettings('task.maxRetries', parseIntOr(e.target.value, 3))}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">重试间隔 (秒)</label>
              <input 
                type="number" 
                value={settings.task.retryInterval}
                onChange={(e) => updateSettings('task.retryInterval', parseIntOr(e.target.value, 5))}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">任务检查定时 (Cron)</label>
              <input 
                type="text" 
                value={settings.task.taskCheckCron}
                onChange={(e) => updateSettings('task.taskCheckCron', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">回收站清理定时 (Cron)</label>
              <input 
                type="text" 
                value={settings.task.cleanRecycleCron}
                onChange={(e) => updateSettings('task.cleanRecycleCron', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">懒转存清理定时 (Cron)</label>
              <input 
                type="text" 
                value={settings.task.lazyFileCleanupCron}
                onChange={(e) => updateSettings('task.lazyFileCleanupCron', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Session 保活定时 (Cron)</label>
              <input
                type="text"
                value={settings.task.sessionKeepAliveCron}
                onChange={(e) => updateSettings('task.sessionKeepAliveCron', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">懒转存保留时间 (小时)</label>
              <input 
                type="number" 
                value={settings.task.lazyFileRetentionHours}
                onChange={(e) => updateSettings('task.lazyFileRetentionHours', parseIntOr(e.target.value, 24))}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium text-slate-700">媒体文件后缀</label>
              <input 
                type="text" 
                value={settings.task.mediaSuffix}
                onChange={(e) => updateSettings('task.mediaSuffix', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder=".mkv;.mp4;..."
              />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-2">
            <label className="flex items-center gap-3 cursor-pointer group p-4 rounded-2xl border border-slate-100 bg-slate-50/50 hover:bg-slate-50 transition-colors">
              <div 
                onClick={() => updateSettings('task.enableAutoClearRecycle', !settings.task.enableAutoClearRecycle)}
                className={`w-6 h-6 rounded-lg border flex items-center justify-center transition-all ${
                  settings.task.enableAutoClearRecycle ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 bg-white'
                }`}
              >
                {settings.task.enableAutoClearRecycle && <div className="w-2.5 h-2.5 bg-white rounded-sm" />}
              </div>
              <div>
                <span className="text-sm font-medium text-slate-900">自动清空回收站</span>
                <p className="text-[10px] text-slate-400">定期清理个人云回收站</p>
              </div>
            </label>
            <label className="flex items-center gap-3 cursor-pointer group p-4 rounded-2xl border border-slate-100 bg-slate-50/50 hover:bg-slate-50 transition-colors">
              <div 
                onClick={() => updateSettings('task.enableAutoClearFamilyRecycle', !settings.task.enableAutoClearFamilyRecycle)}
                className={`w-6 h-6 rounded-lg border flex items-center justify-center transition-all ${
                  settings.task.enableAutoClearFamilyRecycle ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 bg-white'
                }`}
              >
                {settings.task.enableAutoClearFamilyRecycle && <div className="w-2.5 h-2.5 bg-white rounded-sm" />}
              </div>
              <div>
                <span className="text-sm font-medium text-slate-900">自动清理家庭云回收站</span>
              </div>
            </label>
            <label className="flex items-center gap-3 cursor-pointer group p-4 rounded-2xl border border-slate-100 bg-slate-50/50 hover:bg-slate-50 transition-colors">
              <div 
                onClick={() => updateSettings('task.enableAutoCleanLazyFiles', !settings.task.enableAutoCleanLazyFiles)}
                className={`w-6 h-6 rounded-lg border flex items-center justify-center transition-all ${
                  settings.task.enableAutoCleanLazyFiles ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 bg-white'
                }`}
              >
                {settings.task.enableAutoCleanLazyFiles && <div className="w-2.5 h-2.5 bg-white rounded-sm" />}
              </div>
              <div>
                <span className="text-sm font-medium text-slate-900">自动清理懒转存文件</span>
              </div>
            </label>
            <label className="flex items-center gap-3 cursor-pointer group p-4 rounded-2xl border border-slate-100 bg-slate-50/50 hover:bg-slate-50 transition-colors">
              <div 
                onClick={() => updateSettings('task.enableOnlySaveMedia', !settings.task.enableOnlySaveMedia)}
                className={`w-6 h-6 rounded-lg border flex items-center justify-center transition-all ${
                  settings.task.enableOnlySaveMedia ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 bg-white'
                }`}
              >
                {settings.task.enableOnlySaveMedia && <div className="w-2.5 h-2.5 bg-white rounded-sm" />}
              </div>
              <div>
                <span className="text-sm font-medium text-slate-900">仅转存媒体文件</span>
                <p className="text-[10px] text-slate-400">
                  跳过图片、文档等非媒体文件。推荐开启：图片与视频同批转存时，违规图片可能导致整批失败（InfosecuMD5CheckError）。
                </p>
              </div>
            </label>
            <label className="flex items-center gap-3 cursor-pointer group p-4 rounded-2xl border border-slate-100 bg-slate-50/50 hover:bg-slate-50 transition-colors">
              <div 
                onClick={() => updateSettings('task.enableAutoCreateFolder', !settings.task.enableAutoCreateFolder)}
                className={`w-6 h-6 rounded-lg border flex items-center justify-center transition-all ${
                  settings.task.enableAutoCreateFolder ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 bg-white'
                }`}
              >
                {settings.task.enableAutoCreateFolder && <div className="w-2.5 h-2.5 bg-white rounded-sm" />}
              </div>
              <div>
                <span className="text-sm font-medium text-slate-900">目标文件夹自动创建</span>
              </div>
            </label>
            <label className="flex items-center gap-3 cursor-pointer group p-4 rounded-2xl border border-slate-100 bg-slate-50/50 hover:bg-slate-50 transition-colors">
              <div
                onClick={() => updateSettings('task.enableStorageAggregation', !settings.task.enableStorageAggregation)}
                className={`w-6 h-6 rounded-lg border flex items-center justify-center transition-all ${
                  settings.task.enableStorageAggregation ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 bg-white'
                }`}
              >
                {settings.task.enableStorageAggregation && <div className="w-2.5 h-2.5 bg-white rounded-sm" />}
              </div>
              <div>
                <span className="text-sm font-medium text-slate-900">账号容量聚合</span>
                <p className="text-[10px] text-slate-400">账号页显示多账号容量汇总</p>
              </div>
            </label>
            <label className="flex items-center gap-3 cursor-pointer group p-4 rounded-2xl border border-slate-100 bg-slate-50/50 hover:bg-slate-50 transition-colors">
              <div
                onClick={() => updateSettings('task.enableSessionKeepAlive', !settings.task.enableSessionKeepAlive)}
                className={`w-6 h-6 rounded-lg border flex items-center justify-center transition-all ${
                  settings.task.enableSessionKeepAlive ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 bg-white'
                }`}
              >
                {settings.task.enableSessionKeepAlive && <div className="w-2.5 h-2.5 bg-white rounded-sm" />}
              </div>
              <div>
                <span className="text-sm font-medium text-slate-900">账号 Session 保活</span>
                <p className="text-[10px] text-slate-400">定时刷新账号会话</p>
              </div>
            </label>
          </div>

          <div className="flex justify-end border-t border-slate-100 pt-4">
            <button
              type="button"
              onClick={runKeepAlive}
              disabled={keepAliveRunning}
              className="px-5 py-3 bg-white border border-slate-300 rounded-2xl text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors flex items-center gap-2 disabled:opacity-60"
            >
              <RefreshCw size={18} className={keepAliveRunning ? 'animate-spin' : ''} />
              立即执行账号保活
            </button>
          </div>

          {/* Auto Series Defaults */}
          <div className="pt-6 border-t border-slate-100 space-y-4">
            <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <PlayCircle size={18} className="text-[#0b57d0]" /> 自动追剧默认配置
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">默认追剧账号</label>
                <select 
                  value={settings.task.autoCreate.accountId}
                  onChange={(e) => updateSettings('task.autoCreate.accountId', e.target.value)}
                  className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                >
                  <option value="">选择默认账号...</option>
                  {accounts.map(acc => (
                    <option key={acc.id} value={acc.id}>{acc.alias ? `${acc.username} (${acc.alias})` : acc.username}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">默认保存目录</label>
                <div className="flex gap-2">
                  <input 
                    type="text" 
                    value={settings.task.autoCreate.targetFolder || settings.task.autoCreate.targetFolderId}
                    readOnly
                    placeholder="根目录"
                    className="flex-1 px-5 py-3 bg-slate-100 border border-slate-300 rounded-2xl text-sm outline-none text-slate-500"
                  />
                  <button 
                    type="button" 
                    onClick={() => setIsFolderSelectorOpen(true)}
                    disabled={!settings.task.autoCreate.accountId}
                    className="px-4 py-3 bg-white border border-slate-300 rounded-2xl text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-50"
                  >
                    <Folder size={20} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Telegram Bot Settings */}
      <section id="settings-telegram" className="space-y-4 scroll-mt-24" hidden={visibleSectionIds != null && !visibleSectionIds.includes('settings-telegram')}>
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-medium text-slate-900 flex items-center gap-3">
            <Send size={24} className="text-[#0b57d0]" /> Telegram 机器人
          </h3>
          <Switch
            checked={settings.telegram.bot.enable}
            onChange={(v) => {
              updateSettings('telegram.bot.enable', v);
              updateSettings('telegram.enable', v);
            }}
          />
        </div>
        <div className={`bg-white rounded-3xl border border-slate-200/60 p-8 space-y-6 shadow-sm transition-opacity ${!settings.telegram.bot.enable && 'opacity-60 pointer-events-none'}`}>
          <div className="text-xs text-slate-500 bg-slate-50 p-4 rounded-2xl border border-slate-100 leading-relaxed space-y-2">
            <p>启用后，你可以通过 Telegram 机器人直接管理任务、切换账号、搜索资源以及接收任务状态推送。</p>
            <p>1. Bot Token 可通过 @BotFather 创建机器人后获取。</p>
            <p>2. Chat ID 需要先给机器人发消息，再从更新记录或测试消息里确认。</p>
            <p>3. 允许使用的 Chat ID 用于白名单，管理员 Chat ID 额外拥有删除、重试、执行全部等权限。</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Bot Token</label>
              <input
                type="password"
                value={settings.telegram.bot.botToken}
                onChange={(e) => {
                  updateSettings('telegram.bot.botToken', e.target.value);
                  updateSettings('telegram.botToken', e.target.value);
                }}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder={settings.telegram.bot.hasBotToken ? '已保存 Bot Token；留空不覆盖' : '123456789:ABCDefgh...'}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">默认 Chat ID</label>
              <input
                type="text"
                value={settings.telegram.bot.chatId}
                onChange={(e) => {
                  updateSettings('telegram.bot.chatId', e.target.value);
                  updateSettings('telegram.chatId', e.target.value);
                }}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder="例如：123456789"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium text-slate-700">反代 API 域名 (可选)</label>
              <input
                type="text"
                value={settings.telegram.proxyDomain}
                onChange={(e) => updateSettings('telegram.proxyDomain', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder="例如：https://api.telegram.org 或你自己的反代地址"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium text-slate-700">允许使用的 Chat ID 列表</label>
              <textarea
                value={(settings.telegram.bot.allowedChatIds || []).join('\n')}
                onChange={(e) => updateSettings('telegram.bot.allowedChatIds', parseIdList(e.target.value))}
                rows={4}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder="一行一个 Chat ID；为空时回退到上方默认 Chat ID"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium text-slate-700">管理员 Chat ID 列表</label>
              <textarea
                value={(settings.telegram.bot.adminChatIds || []).join('\n')}
                onChange={(e) => updateSettings('telegram.bot.adminChatIds', parseIdList(e.target.value))}
                rows={3}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder="一行一个 Chat ID；为空时默认允许用户都拥有管理员权限"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
            <label className="flex items-center gap-3 cursor-pointer group p-4 rounded-2xl border border-slate-100 bg-slate-50/50 hover:bg-slate-50 transition-colors">
              <div
                onClick={() => updateSettings('telegram.notifyOnSuccess', !settings.telegram.notifyOnSuccess)}
                className={`w-6 h-6 rounded-lg border flex items-center justify-center transition-all ${
                  settings.telegram.notifyOnSuccess ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 bg-white'
                }`}
              >
                {settings.telegram.notifyOnSuccess && <div className="w-2.5 h-2.5 bg-white rounded-sm" />}
              </div>
              <div>
                <span className="text-sm font-medium text-slate-900">成功通知</span>
              </div>
            </label>
            <label className="flex items-center gap-3 cursor-pointer group p-4 rounded-2xl border border-slate-100 bg-slate-50/50 hover:bg-slate-50 transition-colors">
              <div
                onClick={() => updateSettings('telegram.notifyOnFailure', !settings.telegram.notifyOnFailure)}
                className={`w-6 h-6 rounded-lg border flex items-center justify-center transition-all ${
                  settings.telegram.notifyOnFailure ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 bg-white'
                }`}
              >
                {settings.telegram.notifyOnFailure && <div className="w-2.5 h-2.5 bg-white rounded-sm" />}
              </div>
              <div>
                <span className="text-sm font-medium text-slate-900">失败通知</span>
              </div>
            </label>
            <label className="flex items-center gap-3 cursor-pointer group p-4 rounded-2xl border border-slate-100 bg-slate-50/50 hover:bg-slate-50 transition-colors">
              <div
                onClick={() => updateSettings('telegram.notifyOnScrape', !settings.telegram.notifyOnScrape)}
                className={`w-6 h-6 rounded-lg border flex items-center justify-center transition-all ${
                  settings.telegram.notifyOnScrape ? 'bg-[#0b57d0] border-[#0b57d0]' : 'border-slate-300 bg-white'
                }`}
              >
                {settings.telegram.notifyOnScrape && <div className="w-2.5 h-2.5 bg-white rounded-sm" />}
              </div>
              <div>
                <span className="text-sm font-medium text-slate-900">刮削通知</span>
              </div>
            </label>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={testTelegramConfig}
              className="px-5 py-3 bg-white border border-slate-300 rounded-2xl text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              测试配置
            </button>
          </div>
        </div>
      </section>

      {/* Push Notifications */}
      <section id="settings-push" className="space-y-4 scroll-mt-24" hidden={visibleSectionIds != null && !visibleSectionIds.includes('settings-push')}>
        <h3 className="text-xl font-medium text-slate-900 flex items-center gap-3">
          <Bell size={24} className="text-[#b3261e]" /> 消息推送
        </h3>
        <div className="bg-white rounded-3xl border border-slate-200/60 p-8 space-y-6 shadow-sm">
          {/* WeCom */}
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-xl bg-[#d3e3fd] text-[#0b57d0] flex items-center justify-center">
                  <MessageSquare size={20} />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-900">企业微信推送</p>
                  <p className="text-xs text-slate-500">通过 Webhook 推送任务状态</p>
                </div>
              </div>
              <Switch checked={settings.wecom.enable} onChange={(v) => updateSettings('wecom.enable', v)} />
            </div>
            {settings.wecom.enable && (
              <div className="px-4 animate-in slide-in-from-top-2 duration-200">
                <label className="text-xs font-medium text-slate-500 mb-1 block">Webhook URL</label>
                <input
                  type="password"
                  value={settings.wecom.webhook}
                  onChange={(e) => updateSettings('wecom.webhook', e.target.value)}
                  className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                  placeholder={settings.wecom.hasWebhook ? '已保存 Webhook；留空不覆盖' : 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...'}
                />
              </div>
            )}
          </div>

          {/* Bark */}
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-xl bg-[#e8def8] text-[#6750a4] flex items-center justify-center">
                  <Bell size={20} />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-900">Bark 推送</p>
                  <p className="text-xs text-slate-500">iOS Bark App，服务端地址 + 设备 Key</p>
                </div>
              </div>
              <Switch checked={settings.bark.enable} onChange={(v) => updateSettings('bark.enable', v)} />
            </div>
            {settings.bark.enable && (
              <div className="px-4 grid grid-cols-1 md:grid-cols-2 gap-4 animate-in slide-in-from-top-2 duration-200">
                <div>
                  <label className="text-xs font-medium text-slate-500 mb-1 block">Server URL</label>
                  <input
                    type="text"
                    value={settings.bark.serverUrl}
                    onChange={(e) => updateSettings('bark.serverUrl', e.target.value)}
                    className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                    placeholder="https://api.day.app"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-500 mb-1 block">Device Key</label>
                  <input
                    type="password"
                    value={settings.bark.key}
                    onChange={(e) => updateSettings('bark.key', e.target.value)}
                    className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                    placeholder={settings.bark.hasKey ? '已保存设备 Key；留空不覆盖' : 'Bark 设备 Key'}
                  />
                </div>
              </div>
            )}
          </div>

          {/* WxPusher */}
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-xl bg-[#d3e3fd] text-[#0b57d0] flex items-center justify-center">
                  <MessageSquare size={20} />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-900">WxPusher</p>
                  <p className="text-xs text-slate-500">简单推送 SPT，微信接收通知</p>
                </div>
              </div>
              <Switch checked={settings.wxpusher.enable} onChange={(v) => updateSettings('wxpusher.enable', v)} />
            </div>
            {settings.wxpusher.enable && (
              <div className="px-4 animate-in slide-in-from-top-2 duration-200">
                <label className="text-xs font-medium text-slate-500 mb-1 block">SPT</label>
                <input
                  type="password"
                  value={settings.wxpusher.spt}
                  onChange={(e) => updateSettings('wxpusher.spt', e.target.value)}
                  className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                  placeholder={settings.wxpusher.hasSpt ? '已保存 SPT；留空不覆盖' : 'WxPusher 简单推送 SPT'}
                />
              </div>
            )}
          </div>

          {/* PushPlus */}
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-xl bg-[#c4eed0] text-[#0f5223] flex items-center justify-center">
                  <Bell size={20} />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-900">PushPlus</p>
                  <p className="text-xs text-slate-500">Token 推送，可选群组与渠道</p>
                </div>
              </div>
              <Switch checked={settings.pushplus.enable} onChange={(v) => updateSettings('pushplus.enable', v)} />
            </div>
            {settings.pushplus.enable && (
              <div className="px-4 grid grid-cols-1 md:grid-cols-2 gap-4 animate-in slide-in-from-top-2 duration-200">
                <div className="md:col-span-2">
                  <label className="text-xs font-medium text-slate-500 mb-1 block">Token</label>
                  <input
                    type="password"
                    value={settings.pushplus.token}
                    onChange={(e) => updateSettings('pushplus.token', e.target.value)}
                    className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                    placeholder={settings.pushplus.hasToken ? '已保存 Token；留空不覆盖' : 'PushPlus token'}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-500 mb-1 block">Topic（群组，可选）</label>
                  <input
                    type="text"
                    value={settings.pushplus.topic}
                    onChange={(e) => updateSettings('pushplus.topic', e.target.value)}
                    className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-500 mb-1 block">Channel</label>
                  <input
                    type="text"
                    value={settings.pushplus.channel}
                    onChange={(e) => updateSettings('pushplus.channel', e.target.value)}
                    className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                    placeholder="wechat / webhook / cp / sms / mail"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-500 mb-1 block">Webhook（channel=webhook 时）</label>
                  <input
                    type="text"
                    value={settings.pushplus.webhook}
                    onChange={(e) => updateSettings('pushplus.webhook', e.target.value)}
                    className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-500 mb-1 block">To（好友令牌，可选）</label>
                  <input
                    type="text"
                    value={settings.pushplus.to}
                    onChange={(e) => updateSettings('pushplus.to', e.target.value)}
                    className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Network Proxy */}
      <section id="settings-proxy" className="space-y-4 scroll-mt-24" hidden={visibleSectionIds != null && !visibleSectionIds.includes('settings-proxy')}>
        <h3 className="text-xl font-medium text-slate-900 flex items-center gap-3">
          <Globe size={24} className="text-[#0b57d0]" /> 网络代理
        </h3>
        <div className="bg-white rounded-3xl border border-slate-200/60 p-8 space-y-6 shadow-sm">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">代理地址</label>
              <input 
                type="text" 
                value={settings.proxy.host}
                onChange={(e) => updateSettings('proxy.host', e.target.value)}
                placeholder="127.0.0.1"
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">代理端口</label>
              <input 
                type="number" 
                value={settings.proxy.port}
                onChange={(e) => updateSettings('proxy.port', parseIntOr(e.target.value, 0))}
                placeholder="7890"
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">代理用户名</label>
              <input 
                type="text" 
                value={settings.proxy.username}
                onChange={(e) => updateSettings('proxy.username', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">代理密码</label>
              <input
                type="password"
                value={settings.proxy.password}
                onChange={(e) => updateSettings('proxy.password', e.target.value)}
                placeholder={settings.proxy.hasPassword ? '已保存密码；留空不覆盖' : '代理密码'}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
          </div>
          <div className="pt-2">
            <p className="text-xs font-medium text-slate-500 mb-3">代理服务选择</p>
            <div className="flex flex-wrap gap-3">
              {Object.keys(proxyServiceLabels).map(service => (
                <button
                  key={service}
                  type="button"
                  onClick={() => updateSettings(`proxy.services.${service}`, !(settings.proxy.services as any)[service])}
                  className={`px-4 py-2 rounded-xl text-xs font-medium border transition-all ${
                    (settings.proxy.services as any)[service]
                      ? 'bg-[#0b57d0] text-white border-[#0b57d0]'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                  }`}
                >
                  {proxyServiceLabels[service]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* HDHive */}
      <section id="settings-hdhive" className="space-y-4 scroll-mt-24" hidden={visibleSectionIds != null && !visibleSectionIds.includes('settings-hdhive')}>
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-medium text-slate-900 flex items-center gap-3">
            <Search size={24} className="text-[#0b57d0]" /> 影巢资源
          </h3>
          <Switch checked={settings.hdhive.enabled} onChange={(v) => updateSettings('hdhive.enabled', v)} />
        </div>
        <div className={`bg-white rounded-3xl border border-slate-200/60 p-8 space-y-6 shadow-sm transition-opacity ${!settings.hdhive.enabled && 'opacity-60'}`}>
          <div className="text-xs text-slate-500 bg-slate-50 p-4 rounded-2xl border border-slate-100 leading-relaxed">
            支持 Cookie 网页解析、OpenAPI OAuth 和 Browser Bridge 签名网页模式。敏感凭证如已保存或通过环境变量配置，可保持输入框为空。
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">影巢站点地址</label>
              <input
                type="url"
                value={settings.hdhive.baseUrl}
                onChange={(e) => updateSettings('hdhive.baseUrl', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder="https://hdhive.com"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Client ID</label>
              <input
                type="text"
                value={settings.hdhive.clientId}
                onChange={(e) => updateSettings('hdhive.clientId', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder="OpenAPI Client ID"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">网页登录账号</label>
              <input
                type="text"
                value={settings.hdhive.username}
                onChange={(e) => updateSettings('hdhive.username', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder="邮箱或用户名，用于 Browser Bridge 登录取 Cookie"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">网页登录密码</label>
              <input
                type="password"
                value={settings.hdhive.password}
                onChange={(e) => updateSettings('hdhive.password', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder={settings.hdhive.hasPassword ? '已保存密码；留空不覆盖' : '用于 Browser Bridge 登录取 Cookie'}
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium text-slate-700">Cookie</label>
              <textarea
                rows={3}
                value={settings.hdhive.cookie}
                onChange={(e) => updateSettings('hdhive.cookie', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder={settings.hdhive.hasCookie ? '已保存 Cookie；留空不覆盖' : '用于网页登录解析，留空则不启用 Cookie 模式'}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Browser Bridge 地址</label>
              <input
                type="url"
                value={settings.hdhive.browserBridge.baseUrl}
                onChange={(e) => updateSettings('hdhive.browserBridge.baseUrl', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder="https://hdhive-browser-bridge.onrender.com"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Browser Bridge Token</label>
              <input
                type="password"
                value={settings.hdhive.browserBridge.token}
                onChange={(e) => updateSettings('hdhive.browserBridge.token', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder={settings.hdhive.browserBridge.hasToken ? '已保存 Token；留空不覆盖' : '必须与 Render BRIDGE_TOKEN 一致'}
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4">
                <div>
                  <div className="text-sm font-medium text-slate-700">启用 Browser Bridge 签名模式</div>
                  <div className="mt-1 text-xs text-slate-500">用于 `/api/customer/*`、网页登录取 Cookie、签到和资源解锁。</div>
                </div>
                <Switch checked={settings.hdhive.browserBridge.enabled} onChange={(v) => updateSettings('hdhive.browserBridge.enabled', v)} />
              </div>
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium text-slate-700">API Key</label>
              <input
                type="password"
                value={settings.hdhive.apiKey}
                onChange={(e) => updateSettings('hdhive.apiKey', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder="OpenAPI API Key；留空不覆盖已保存值"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium text-slate-700">资源解锁 Action ID</label>
              <input
                type="text"
                value={settings.hdhive.resourceUnlockActionId}
                onChange={(e) => updateSettings('hdhive.resourceUnlockActionId', e.target.value)}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder="Next-Action ID，影巢部署轮换后可在这里更新"
              />
            </div>
            <div className="space-y-3 md:col-span-2">
              <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4">
                <div>
                  <div className="text-sm font-medium text-slate-700">每日自动签到</div>
                  <div className="mt-1 text-xs text-slate-500">依赖 Browser Bridge 签名模式，按下方 Cron 定时调用影巢签到接口并推送积分结果。</div>
                </div>
                <Switch checked={settings.hdhive.checkin.enabled} onChange={(v) => updateSettings('hdhive.checkin.enabled', v)} />
              </div>
              {settings.hdhive.checkin.enabled && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <div className="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-5 py-3">
                      <div>
                        <div className="text-sm font-medium text-slate-700">随机签到时间</div>
                        <div className="mt-1 text-xs text-slate-500">开启后每天在时间窗口内随机一次，关闭后按固定 Cron 执行。</div>
                      </div>
                      <Switch checked={settings.hdhive.checkin.randomTimeEnabled} onChange={(v) => updateSettings('hdhive.checkin.randomTimeEnabled', v)} />
                    </div>
                  </div>
                  <div className="flex items-end">
                    <div className="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-5 py-3">
                      <div>
                        <div className="text-sm font-medium text-slate-700">自动过人机校验</div>
                        <div className="mt-1 text-xs text-slate-500">遇到 space_captcha 时让 Bridge 浏览器侧自动验证。</div>
                      </div>
                      <Switch checked={settings.hdhive.checkin.autoVerify} onChange={(v) => updateSettings('hdhive.checkin.autoVerify', v)} />
                    </div>
                  </div>
                  {settings.hdhive.checkin.randomTimeEnabled ? (
                    <>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-slate-700">开始时间</label>
                        <input
                          type="time"
                          value={settings.hdhive.checkin.randomWindowStart}
                          onChange={(e) => updateSettings('hdhive.checkin.randomWindowStart', e.target.value)}
                          className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-slate-700">结束时间</label>
                        <input
                          type="time"
                          value={settings.hdhive.checkin.randomWindowEnd}
                          onChange={(e) => updateSettings('hdhive.checkin.randomWindowEnd', e.target.value)}
                          className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                        />
                      </div>
                    </>
                  ) : (
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-slate-700">签到 Cron</label>
                      <input
                        type="text"
                        value={settings.hdhive.checkin.cron}
                        onChange={(e) => updateSettings('hdhive.checkin.cron', e.target.value)}
                        className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                        placeholder="35 8 * * *（默认每天 08:35）"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Custom Push Management */}
      <section id="settings-custom-push" className="space-y-4 scroll-mt-24" hidden={visibleSectionIds != null && !visibleSectionIds.includes('settings-custom-push')}>
        <h3 className="text-xl font-medium text-slate-900 flex items-center gap-3">
          <Bell size={24} className="text-[#b3261e]" /> 自定义推送列表
        </h3>
        <div className="bg-white rounded-3xl border border-slate-200/60 p-8 space-y-6 shadow-sm">
          <div className="flex justify-end">
            <button 
              type="button"
              onClick={() => {
                setEditingPushIndex(null);
                setPushForm({ name: '', description: '', url: '', method: 'POST', contentType: 'application/json', enabled: true, fields: [] });
                setIsPushModalOpen(true);
              }}
              className="px-4 py-2 bg-[#d3e3fd] text-[#041e49] rounded-xl text-sm font-medium hover:bg-[#c2e7ff] transition-colors flex items-center gap-2"
            >
              <Plus size={18} /> 添加推送
            </button>
          </div>
          
          <div className="space-y-3">
            {(settings.customPush || []).length === 0 ? (
              <div className="text-center py-8 text-slate-400 italic text-sm">暂未配置自定义推送</div>
            ) : (
              settings.customPush.map((push, index) => (
                <div key={index} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100 group">
                  <div className="flex items-center gap-4">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${push.enabled ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-500'}`}>
                      <Bell size={20} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate">{push.name}</p>
                      <p className="text-xs text-slate-500 truncate max-w-[300px]">{push.description || push.url}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button 
                      type="button"
                      onClick={() => testPush(push)}
                      className="p-2 hover:bg-white rounded-full text-[#0b57d0] transition-colors"
                      title="测试"
                    >
                      <RefreshCw size={18} />
                    </button>
                    <button 
                      type="button"
                      onClick={() => {
                        setEditingPushIndex(index);
                        setPushForm(push);
                        setIsPushModalOpen(true);
                      }}
                      className="p-2 hover:bg-white rounded-full text-slate-500 transition-colors"
                    >
                      <Settings size={18} />
                    </button>
                    <button 
                      type="button"
                      onClick={() => deletePushConfig(index)}
                      className="p-2 hover:bg-white rounded-full text-red-500 transition-colors"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {/* Regex Presets Management */}
      <section id="settings-regex" className="space-y-4 scroll-mt-24" hidden={visibleSectionIds != null && !visibleSectionIds.includes('settings-regex')}>
        <h3 className="text-xl font-medium text-slate-900 flex items-center gap-3">
          <Cpu size={24} className="text-[#0b57d0]" /> 正则预设列表
        </h3>
        <div className="bg-white rounded-3xl border border-slate-200/60 p-8 space-y-6 shadow-sm">
          <div className="flex justify-end">
            <button 
              type="button"
              onClick={() => {
                setEditingRegexIndex(null);
                setRegexForm({ name: '', description: '', sourceRegex: '', targetRegex: '', matchPattern: '', matchOperator: '', matchValue: '' });
                setIsRegexModalOpen(true);
              }}
              className="px-4 py-2 bg-[#d3e3fd] text-[#041e49] rounded-xl text-sm font-medium hover:bg-[#c2e7ff] transition-colors flex items-center gap-2"
            >
              <Plus size={18} /> 添加预设
            </button>
          </div>

          <div className="space-y-3">
            {(settings.regexPresets || []).length === 0 ? (
              <div className="text-center py-8 text-slate-400 italic text-sm">暂未配置正则预设</div>
            ) : (
              settings.regexPresets.map((preset, index) => (
                <div key={index} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100 group">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-xl bg-[#d3e3fd] text-[#0b57d0] flex items-center justify-center">
                      <Cpu size={20} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate">{preset.name}</p>
                      <p className="text-xs text-slate-500 truncate max-w-[300px]">{preset.description || `${preset.sourceRegex} -> ${preset.targetRegex}`}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button 
                      type="button"
                      onClick={() => {
                        setEditingRegexIndex(index);
                        setRegexForm({
                          ...preset,
                          matchOperator: normalizeMatchOperator(preset.matchOperator)
                        });
                        setIsRegexModalOpen(true);
                      }}
                      className="p-2 hover:bg-white rounded-full text-slate-500 transition-colors"
                    >
                      <Settings size={18} />
                    </button>
                    <button 
                      type="button"
                      onClick={async () => {
                        const ok = await dialog.confirm({
                          title: '删除正则预设',
                          message: '确定删除此正则预设吗？',
                          confirmText: '删除',
                          tone: 'danger',
                        });
                        if (!ok) return;
                        const newPresets = settings.regexPresets!.filter((_, i) => i !== index);
                        updateSettings('regexPresets', newPresets);
                      }}
                      className="p-2 hover:bg-white rounded-full text-red-500 transition-colors"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <div className="flex justify-end pt-4 gap-4 sticky bottom-8 z-10 pr-20 md:pr-24">
        <button 
          type="button"
          onClick={loadSettings}
          className="px-8 py-3 bg-white border border-slate-300 text-slate-700 rounded-full font-medium shadow-lg hover:bg-slate-50 transition-all flex items-center gap-2"
        >
          <RefreshCw size={20} className={loading ? 'animate-spin' : ''} /> 放弃修改
        </button>
        <button 
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="px-10 py-3 bg-[#0b57d0] text-white rounded-full font-medium shadow-lg hover:bg-[#0b57d0]/90 hover:shadow-xl transition-all flex items-center gap-2 disabled:opacity-70"
        >
          {saving ? <RefreshCw size={20} className="animate-spin" /> : <Save size={20} />} 保存设置
        </button>
      </div>

      <Modal 
        isOpen={isPushModalOpen} 
        onClose={() => setIsPushModalOpen(false)} 
        title={editingPushIndex !== null ? "编辑推送配置" : "添加推送配置"}
        footer={null}
      >
        <form onSubmit={handlePushSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500">名称</label>
              <input type="text" value={pushForm.name} onChange={e => setPushForm({...pushForm, name: e.target.value})} required className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500">方法</label>
              <select value={pushForm.method} onChange={e => setPushForm({...pushForm, method: e.target.value as any})} className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm">
                <option value="POST">POST</option>
                <option value="GET">GET</option>
                <option value="PUT">PUT</option>
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-500">Webhook URL</label>
            <input type="url" value={pushForm.url} onChange={e => setPushForm({...pushForm, url: e.target.value})} required className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm" />
          </div>

          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <label className="text-xs font-medium text-slate-500">字段配置 (支持 {"{{"}content{"}}"})</label>
              <button 
                type="button" 
                onClick={() => setPushForm({...pushForm, fields: [...pushForm.fields, {type:'string', key:'', value:''}]})} 
                className="text-[#0b57d0] text-xs font-medium flex items-center gap-1"
              >
                <Plus size={14} /> 添加
              </button>
            </div>
            <div className="space-y-2">
              {pushForm.fields.map((f, i) => (
                <div key={i} className="flex gap-2 items-start bg-slate-50 p-2 rounded-xl border border-slate-100">
                  <select 
                    value={f.type} 
                    onChange={e => {
                      const newFields = [...pushForm.fields];
                      newFields[i].type = e.target.value;
                      setPushForm({...pushForm, fields: newFields});
                    }} 
                    className="bg-transparent text-xs outline-none"
                  >
                    <option value="string">String</option>
                    <option value="json">JSON</option>
                  </select>
                  <input 
                    placeholder="Key" 
                    value={f.key} 
                    onChange={e => {
                      const newFields = [...pushForm.fields];
                      newFields[i].key = e.target.value;
                      setPushForm({...pushForm, fields: newFields});
                    }} 
                    className="flex-1 bg-transparent text-xs outline-none border-b border-slate-200" 
                  />
                  <input 
                    placeholder="Value" 
                    value={f.value} 
                    onChange={e => {
                      const newFields = [...pushForm.fields];
                      newFields[i].value = e.target.value;
                      setPushForm({...pushForm, fields: newFields});
                    }} 
                    className="flex-[2] bg-transparent text-xs outline-none border-b border-slate-200" 
                  />
                  <button 
                    type="button" 
                    onClick={() => setPushForm({...pushForm, fields: pushForm.fields.filter((_, idx) => idx !== i)})} 
                    className="text-red-400"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <Checkbox
            checked={pushForm.enabled}
            onChange={(v) => setPushForm({ ...pushForm, enabled: v })}
            label="启用此推送"
          />

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
            <button type="button" onClick={() => setIsPushModalOpen(false)} className="px-6 py-2.5 rounded-full text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors">取消</button>
            <button type="submit" className="px-8 py-2.5 bg-[#0b57d0] text-white rounded-full text-sm font-medium shadow-sm hover:bg-[#0b57d0]/90 transition-all">保存配置</button>
          </div>
        </form>
      </Modal>

      <Modal 
        isOpen={isRegexModalOpen} 
        onClose={() => setIsRegexModalOpen(false)} 
        title={editingRegexIndex !== null ? "编辑正则预设" : "添加正则预设"}
        footer={null}
      >
        <form onSubmit={(e) => {
          e.preventDefault();
          const normalizedRegexForm = {
            ...regexForm,
            matchOperator: normalizeMatchOperator(regexForm.matchOperator)
          };
          const newPresets = [...(settings.regexPresets || [])];
          if (editingRegexIndex !== null) newPresets[editingRegexIndex] = normalizedRegexForm;
          else newPresets.push(normalizedRegexForm);
          updateSettings('regexPresets', newPresets);
          setIsRegexModalOpen(false);
        }} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500">预设名称</label>
              <input type="text" value={regexForm.name} onChange={e => setRegexForm({...regexForm, name: e.target.value})} required className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm" placeholder="例如：去广告后缀" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500">匹配模式</label>
              <input type="text" value={regexForm.matchPattern} onChange={e => setRegexForm({...regexForm, matchPattern: e.target.value})} className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm" placeholder="文件名匹配 (可选)" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500">源正则 (Source Regex)</label>
              <input type="text" value={regexForm.sourceRegex} onChange={e => setRegexForm({...regexForm, sourceRegex: e.target.value})} required className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm font-mono" placeholder="\[.*?\]" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500">目标替换 (Target Regex)</label>
              <input type="text" value={regexForm.targetRegex} onChange={e => setRegexForm({...regexForm, targetRegex: e.target.value})} className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm font-mono" placeholder="留空则删除" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500">匹配操作符</label>
              <select value={regexForm.matchOperator} onChange={e => setRegexForm({...regexForm, matchOperator: e.target.value})} className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm">
                <option value="">请选择</option>
                <option value="lt">小于 (Size)</option>
                <option value="gt">大于 (Size)</option>
                <option value="eq">等于 (Size)</option>
                <option value="contains">包含</option>
                <option value="notContains">不包含</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500">匹配值 (Match Value)</label>
              <input type="text" value={regexForm.matchValue} onChange={e => setRegexForm({...regexForm, matchValue: e.target.value})} className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-500">描述</label>
            <input type="text" value={regexForm.description} onChange={e => setRegexForm({...regexForm, description: e.target.value})} className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm" placeholder="简单说明预设用途" />
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
            <button type="button" onClick={() => setIsRegexModalOpen(false)} className="px-6 py-2.5 rounded-full text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors">取消</button>
            <button type="submit" className="px-8 py-2.5 bg-[#0b57d0] text-white rounded-full text-sm font-medium shadow-sm hover:bg-[#0b57d0]/90 transition-all">保存预设</button>
          </div>
        </form>
      </Modal>

      <FolderSelector
        isOpen={isFolderSelectorOpen}
        onClose={() => setIsFolderSelectorOpen(false)}
        accountId={Number(settings.task.autoCreate.accountId)}
        accountName={selectedAccount?.username || ''}
        title="选择自动追剧默认保存目录"
        onSelect={(folder: SelectedFolder) => {
          updateSettings('task.autoCreate.accountId', String(folder.accountId));
          updateSettings('task.autoCreate.targetFolderId', folder.id);
          updateSettings('task.autoCreate.targetFolder', folder.name);
        }}
      />
    </div>
  );
};

export default SettingsTab;
