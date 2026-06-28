import React, { useState, useEffect } from 'react';
import {
  User,
  Files,
  ClipboardList,
  PlayCircle,
  LayoutGrid,
  Rss,
  Link2,
  Settings,
  Monitor,
  Search,
  Bell,
  Menu,
  LogOut,
  MessageSquare,
  Moon,
  Sun,
  Zap,
  Magnet,
  CheckCircle2,
  Clapperboard
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Components ---
import FloatingActions from './components/FloatingActions';
import CreateTaskModal from './components/CreateTaskModal';
import LogConsole from './components/LogConsole';
import CloudSaverModal from './components/CloudSaverModal';
import AIChat from './components/AIChat';

// --- Tabs ---
import AccountTab from './components/tabs/AccountTab';
import TaskTab from './components/tabs/TaskTab';
import FileManagerTab from './components/tabs/FileManagerTab';
import AutoSeriesTab from './components/tabs/AutoSeriesTab';
import OrganizerTab from './components/tabs/OrganizerTab';
import SubscriptionTab from './components/tabs/SubscriptionTab';
import StrmConfigTab from './components/tabs/StrmConfigTab';
import MediaTab from './components/tabs/MediaTab';
import SettingsTab from './components/tabs/SettingsTab';
import CasTab from './components/tabs/CasTab';
import PtTab, { type PtPrefillData } from './components/tabs/PtTab';
import PosterWallTab from './components/tabs/PosterWallTab';
import HdhiveTab from './components/tabs/HdhiveTab';
import { useDialog } from './components/ui/Dialog';

// --- Types ---
export type TabType = 'account' | 'fileManager' | 'task' | 'autoSeries' | 'hdhive' | 'organizer' | 'subscription' | 'strmConfig' | 'media' | 'cas' | 'pt' | 'posterWall' | 'settings';
type ThemeMode = 'light' | 'dark' | 'system';

const appVersionLabel = `v${__APP_VERSION__}`;
const THEME_STORAGE_KEY = 'theme';

const getStoredThemeMode = (): ThemeMode => {
  if (typeof window === 'undefined') {
    return 'system';
  }

  const savedThemeMode = localStorage.getItem(THEME_STORAGE_KEY);
  if (savedThemeMode === 'light' || savedThemeMode === 'dark' || savedThemeMode === 'system') {
    return savedThemeMode;
  }

  return 'system';
};

const getSystemPrefersDark = () => {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

export default function App() {
  const dialog = useDialog();
  const [activeTab, setActiveTab] = useState<TabType>('task');
  const [isCreateTaskOpen, setIsCreateTaskOpen] = useState(false);
  const [isLogsOpen, setIsLogsOpen] = useState(false);
  const [isCloudSaverOpen, setIsCloudSaverOpen] = useState(false);
  const [isAIChatOpen, setIsAIChatOpen] = useState(false);
  const [createTaskInitialData, setCreateTaskInitialData] = useState<any>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [taskRefreshKey, setTaskRefreshKey] = useState(0);
  const [themeMode, setThemeMode] = useState<ThemeMode>(getStoredThemeMode);
  const [systemPrefersDark, setSystemPrefersDark] = useState(getSystemPrefersDark);
  const [isThemeMenuOpen, setIsThemeMenuOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [ptPrefill, setPtPrefill] = useState<PtPrefillData | null>(null);

  const resolvedTheme = themeMode === 'system'
    ? (systemPrefersDark ? 'dark' : 'light')
    : themeMode;
  const isDarkMode = resolvedTheme === 'dark';

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };

    setSystemPrefersDark(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);

    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, []);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(res => res.json())
      .then(data => {
        if (data.success && data.username) {
          setUsername(data.username);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('[data-theme-menu]')) {
        setIsThemeMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsThemeMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }

    localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [isDarkMode, themeMode]);

  const themeOptions: Array<{ value: ThemeMode; label: string; description: string; icon: any }> = [
    { value: 'light', label: '浅色模式', description: '始终使用浅色外观', icon: Sun },
    { value: 'dark', label: '深色模式', description: '始终使用深色外观', icon: Moon },
    {
      value: 'system',
      label: '跟随系统',
      description: `当前系统为${systemPrefersDark ? '深色' : '浅色'}`,
      icon: Monitor
    }
  ];

  const currentThemeLabel = themeMode === 'system'
    ? `跟随系统 (${systemPrefersDark ? '当前深色' : '当前浅色'})`
    : themeMode === 'dark'
      ? '深色模式'
      : '浅色模式';

  const ThemeTriggerIcon = themeMode === 'system'
    ? Monitor
    : themeMode === 'dark'
      ? Moon
      : Sun;

  const handleSelectThemeMode = (nextThemeMode: ThemeMode) => {
    setThemeMode(nextThemeMode);
    setIsThemeMenuOpen(false);
  };

  const tabs: { id: TabType, label: string, icon: any }[] = [
    { id: 'account', label: '账号', icon: User },
    { id: 'fileManager', label: '文件', icon: Files },
    { id: 'task', label: '任务', icon: ClipboardList },
    { id: 'autoSeries', label: '自动追剧', icon: PlayCircle },
    { id: 'hdhive', label: '影巢', icon: Search },
    { id: 'organizer', label: '整理器', icon: LayoutGrid },
    { id: 'subscription', label: '订阅', icon: Rss },
    { id: 'strmConfig', label: 'STRM', icon: Link2 },
    { id: 'cas', label: '秒传', icon: Zap },
    { id: 'pt', label: 'PT', icon: Magnet },
    { id: 'posterWall', label: '海报墙', icon: Clapperboard },
    { id: 'media', label: '媒体', icon: Monitor },
    { id: 'settings', label: '系统', icon: Settings },
  ];

  const activeTabLabel = tabs.find(t => t.id === activeTab)?.label || '控制台';

  const handleOpenCreateTask = (initialData?: any) => {
    setCreateTaskInitialData(initialData || null);
    setIsCreateTaskOpen(true);
  };

  const handleLogout = async () => {
    const ok = await dialog.confirm({
      title: '退出登录',
      message: '确定要退出登录吗？',
      confirmText: '退出',
      tone: 'warning',
    });
    if (!ok) return;
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    } catch (e) {
      window.location.href = '/login';
    }
  };

  const handleFloatingAction = (id: string) => {
    switch (id) {
      case 'createTask':
        handleOpenCreateTask();
        break;
      case 'cloudsaver':
        setIsCloudSaverOpen(true);
        break;
      case 'strm':
        setActiveTab('strmConfig');
        break;
      case 'logs':
        setIsLogsOpen(true);
        break;
      case 'chat':
        setIsAIChatOpen(true);
        break;
      default:
        break;
    }
  };

  return (
    <div className="flex h-screen bg-[var(--bg-surface)] overflow-hidden font-sans transition-colors duration-300">

      {/* Mobile Navigation Drawer Overlay */}
      <AnimatePresence>
        {isMobileMenuOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsMobileMenuOpen(false)}
              className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-40 md:hidden dark:bg-slate-950/70"
            />
            <motion.nav
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
              className="fixed inset-y-0 left-0 w-72 bg-[var(--bg-surface)] flex flex-col z-50 md:hidden shadow-2xl border-r border-[var(--border-color)]"
            >
              <div className="px-6 py-8 border-b border-[var(--border-color)]">
                <h1 className="text-2xl font-medium text-[var(--text-primary)]">天翼自动转存</h1>
                <p className="text-sm text-[var(--text-secondary)] mt-1">{appVersionLabel}</p>
              </div>
              <div className="flex-1 px-3 py-4 space-y-1 overflow-y-auto custom-scrollbar">
                {tabs.map(tab => (
                  <motion.button
                    key={tab.id}
                    onClick={() => {
                      setActiveTab(tab.id);
                      setIsMobileMenuOpen(false);
                    }}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className={`w-full flex items-center gap-4 px-4 py-3.5 rounded-full text-sm font-medium transition-all duration-200 ${
                      activeTab === tab.id
                        ? 'bg-[var(--nav-active-bg)] text-[var(--nav-active-text)]'
                        : 'text-[var(--text-primary)] hover:bg-slate-100/80 dark:hover:bg-slate-800/80'
                    }`}
                  >
                    <tab.icon size={22} className={activeTab === tab.id ? 'text-[var(--nav-active-text)]' : 'text-[var(--text-secondary)]'} />
                    {tab.label}
                  </motion.button>
                ))}
              </div>
              <div className="p-4 border-t border-[var(--border-color)]">
                <motion.button
                  onClick={handleLogout}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className="w-full flex items-center gap-4 px-4 py-3.5 rounded-full text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all duration-200"
                >
                  <LogOut size={22} />
                  退出登录
                </motion.button>
              </div>
            </motion.nav>
          </>
        )}
      </AnimatePresence>

      {/* Desktop Navigation Drawer */}
      <nav className="w-72 bg-[var(--bg-surface)] flex flex-col hidden md:flex z-10 border-r border-[var(--border-color)] shadow-lg">
        <div className="px-8 py-8 border-b border-[var(--border-color)]">
          <h1 className="text-2xl font-medium text-[var(--text-primary)]">天翼自动转存</h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">{appVersionLabel}</p>
        </div>
        <div className="flex-1 px-3 py-6 space-y-1 overflow-y-auto pb-6 custom-scrollbar">
          {tabs.map(tab => (
            <motion.button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              className={`w-full flex items-center gap-4 px-5 py-3.5 rounded-full text-sm font-medium transition-all duration-200 ${
                activeTab === tab.id
                  ? 'bg-[var(--nav-active-bg)] text-[var(--nav-active-text)]'
                  : 'text-[var(--text-primary)] hover:bg-slate-100/80 dark:hover:bg-slate-800/80'
              }`}
            >
              <tab.icon size={22} className={activeTab === tab.id ? 'text-[var(--nav-active-text)]' : 'text-[var(--text-secondary)]'} />
              {tab.label}
            </motion.button>
          ))}
        </div>
        <div className="p-4 border-t border-[var(--border-color)]">
          <motion.button
            onClick={handleLogout}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="w-full flex items-center gap-4 px-5 py-3.5 rounded-full text-sm font-medium text-[var(--text-secondary)] hover:bg-slate-100 dark:hover:bg-slate-800 transition-all duration-200"
          >
            <LogOut size={22} />
            退出登录
          </motion.button>
        </div>
      </nav>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 h-screen relative bg-[var(--bg-main)] rounded-tl-3xl shadow-xl border-l border-t border-[var(--border-color)] transition-colors duration-300">

        {/* Top App Bar */}
        <header className="h-16 flex items-center justify-between px-4 md:px-8 bg-[var(--bg-main)]/95 backdrop-blur-xl z-10 sticky top-0 rounded-tl-3xl transition-all duration-300">
          <div className="flex items-center gap-4">
            <motion.button
              onClick={() => setIsMobileMenuOpen(true)}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="p-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-all duration-200 text-[var(--text-primary)] md:hidden"
            >
              <Menu size={24} />
            </motion.button>
            <h2 className="text-2xl font-medium text-[var(--text-primary)]">{activeTabLabel}</h2>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative" data-theme-menu>
              <motion.button
                type="button"
                onClick={() => setIsThemeMenuOpen((currentState) => !currentState)}
                whileHover={{ scale: 1.05, rotate: 15 }}
                whileTap={{ scale: 0.95 }}
                className="p-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-all duration-200 text-[var(--text-primary)]"
                title={currentThemeLabel}
                aria-label={`主题模式：${currentThemeLabel}`}
                aria-haspopup="menu"
                aria-expanded={isThemeMenuOpen}
              >
                <ThemeTriggerIcon size={22} />
              </motion.button>
              <AnimatePresence>
                {isThemeMenuOpen && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: -10 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: -10 }}
                    transition={{ duration: 0.15 }}
                    className="absolute right-0 top-full mt-2 w-64 rounded-2xl border border-slate-200 bg-white/95 backdrop-blur-xl p-2 shadow-xl dark:border-slate-700 dark:bg-slate-900/95 z-30"
                  >
                    {themeOptions.map((themeOption) => {
                      const OptionIcon = themeOption.icon;
                      const isActive = themeOption.value === themeMode;

                      return (
                        <motion.button
                          key={themeOption.value}
                          type="button"
                          onClick={() => handleSelectThemeMode(themeOption.value)}
                          whileHover={{ scale: 1.02 }}
                          whileTap={{ scale: 0.98 }}
                          className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-all duration-200 ${
                            isActive
                              ? 'bg-[#d3e3fd] text-[#0b57d0] shadow-md dark:bg-[#0b57d0]/20 dark:text-[#8ab4f8]'
                              : 'text-[var(--text-primary)] hover:bg-slate-100 dark:hover:bg-slate-800'
                          }`}
                        >
                          <OptionIcon size={18} className="shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium">{themeOption.label}</div>
                            <div className="text-xs text-[var(--text-secondary)]">{themeOption.description}</div>
                          </div>
                          {isActive && (
                            <motion.div
                              initial={{ scale: 0 }}
                              animate={{ scale: 1 }}
                              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                            >
                              <CheckCircle2 size={16} className="shrink-0" />
                            </motion.div>
                          )}
                        </motion.button>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <motion.button
              onClick={() => setIsAIChatOpen(true)}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="p-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-all duration-200 text-[var(--text-primary)]"
              title="AI 助手"
            >
              <MessageSquare size={22} />
            </motion.button>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="p-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-all duration-200 text-[var(--text-primary)]"
            >
              <Bell size={22} />
            </motion.button>
            <motion.div
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="w-9 h-9 rounded-full bg-[#0b57d0] text-white flex items-center justify-center font-medium text-sm ml-2 cursor-pointer shadow-md hover:shadow-lg transition-all duration-200"
            >
              {username ? username.charAt(0).toUpperCase() : 'U'}
            </motion.div>
          </div>
        </header>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8 pb-32 custom-scrollbar content-scrollable">
          <div className="max-w-6xl mx-auto">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
              >
                {activeTab === 'account' && <AccountTab />}
                {activeTab === 'task' && (
                  <TaskTab
                    key={`task-tab-${taskRefreshKey}`}
                    onCreateTask={(data) => handleOpenCreateTask(data)}
                  />
                )}
                {activeTab === 'fileManager' && <FileManagerTab />}
                {activeTab === 'autoSeries' && <AutoSeriesTab />}
                {activeTab === 'hdhive' && <HdhiveTab onTransfer={handleOpenCreateTask} />}
                {activeTab === 'organizer' && <OrganizerTab />}
                {activeTab === 'subscription' && <SubscriptionTab onTransfer={handleOpenCreateTask} />}
                {activeTab === 'strmConfig' && <StrmConfigTab />}
                {activeTab === 'media' && <MediaTab />}
                {activeTab === 'cas' && <CasTab onNavigate={setActiveTab} />}
                {activeTab === 'pt' && <PtTab prefill={ptPrefill} onPrefillConsumed={() => setPtPrefill(null)} />}
                {activeTab === 'posterWall' && (
                  <PosterWallTab
                    onCreatePtSubscription={(data) => {
                      setPtPrefill(data);
                      setActiveTab('pt');
                    }}
                  />
                )}
                {activeTab === 'settings' && <SettingsTab />}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        <FloatingActions onAction={handleFloatingAction} />
      </main>

      {/* Modals */}
      <CreateTaskModal 
        isOpen={isCreateTaskOpen} 
        onClose={() => {
          setIsCreateTaskOpen(false);
          setCreateTaskInitialData(null);
        }}
        onSuccess={() => {
          setTaskRefreshKey(prev => prev + 1);
          setCreateTaskInitialData(null);
        }}
        initialData={createTaskInitialData}
      />

      <LogConsole 
        isOpen={isLogsOpen} 
        onClose={() => setIsLogsOpen(false)} 
      />

      <CloudSaverModal 
        isOpen={isCloudSaverOpen} 
        onClose={() => setIsCloudSaverOpen(false)} 
        onTransfer={(data) => {
          setIsCloudSaverOpen(false);
          handleOpenCreateTask(data);
        }}
      />

      <AIChat 
        isOpen={isAIChatOpen} 
        onClose={() => setIsAIChatOpen(false)} 
      />
    </div>
  );
}
