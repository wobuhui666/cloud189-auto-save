import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Clapperboard,
  Film,
  Tv,
  Star,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Download,
  Plus,
  Loader2,
  RefreshCw,
  Globe,
  Bookmark,
  Trash2,
  Play,
} from 'lucide-react';
import { getDoubanHotMovies, getDoubanHotTV, searchDouban } from '../../lib/douban.client';
import { getBangumiToday, getBangumiByWeekday, getBangumiRanking } from '../../lib/bangumi.client';
import Modal from '../Modal';
import PTSearchModal from '../PTSearchModal';

// === 类型定义 ===
interface MediaItem {
  id: string;
  title: string;
  poster: string;
  rate: string;
  year: string;
  type: 'movie' | 'tv' | 'anime' | 'variety';
  source: 'douban' | 'tmdb' | 'bangumi';
  overview?: string;
}

type MediaSource = 'douban' | 'tmdb' | 'bangumi';

interface SourcePreset {
  key: string;
  label: string;
}

// === 来源徽章配色 ===
const SOURCE_BADGE: Record<MediaSource, { label: string; cls: string }> = {
  douban: { label: '豆瓣', cls: 'bg-[#0b57d0]/85 text-white' },
  tmdb: { label: 'TMDB', cls: 'bg-[#0b57d0]/85 text-white' },
  bangumi: { label: '番组', cls: 'bg-[#0b57d0]/85 text-white' },
};

// === PosterCard 组件 ===
interface PosterCardProps {
  item: MediaItem;
  onSelect: (item: MediaItem) => void;
}

const PosterCard: React.FC<PosterCardProps> = ({ item, onSelect }) => {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);

  return (
    <motion.div
      className="relative flex-shrink-0 w-[130px] sm:w-[150px] cursor-pointer group"
      whileHover={{ scale: 1.04, y: -4 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      onClick={() => onSelect(item)}
    >
      {/* 海报图片 */}
      <div className="relative aspect-[2/3] rounded-2xl overflow-hidden bg-slate-100 dark:bg-slate-800 shadow-sm group-hover:shadow-lg ring-1 ring-slate-200/60 dark:ring-slate-700/60 transition-shadow">
        {!imageError && item.poster ? (
          <>
            {!imageLoaded && (
              <div className="absolute inset-0 animate-pulse bg-slate-200 dark:bg-slate-700" />
            )}
            <img
              src={item.poster}
              alt={item.title}
              className={`w-full h-full object-cover transition-opacity duration-300 ${imageLoaded ? 'opacity-100' : 'opacity-0'}`}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              onLoad={() => setImageLoaded(true)}
              onError={() => setImageError(true)}
            />
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-200 to-slate-300 dark:from-slate-700 dark:to-slate-800">
            <Clapperboard className="w-10 h-10 text-slate-400 dark:text-slate-500" />
          </div>
        )}

        {/* 悬浮渐变遮罩 */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-end p-3">
          <div className="text-white text-xs font-medium w-full text-center backdrop-blur-[2px]">
            点击查看详情
          </div>
        </div>

        {/* 评分徽章 */}
        {item.rate && (
          <div className="absolute top-2 right-2 bg-black/65 backdrop-blur-md text-amber-300 text-[11px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 shadow-sm">
            <Star className="w-3 h-3 fill-current" />
            {item.rate}
          </div>
        )}

        {/* 来源徽章 */}
        <div className="absolute top-2 left-2">
          <span className={`backdrop-blur-md text-[10px] font-medium px-2 py-0.5 rounded-full shadow-sm ${SOURCE_BADGE[item.source].cls}`}>
            {SOURCE_BADGE[item.source].label}
          </span>
        </div>
      </div>

      {/* 标题和年份 */}
      <div className="mt-2.5 px-0.5">
        <div className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate" title={item.title}>
          {item.title}
        </div>
        {item.year && (
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {item.year}
          </div>
        )}
      </div>
    </motion.div>
  );
};

// === ScrollableRow 组件 ===
interface ScrollableRowProps {
  title: string;
  items: MediaItem[];
  loading: boolean;
  onSelect: (item: MediaItem) => void;
}

const ScrollableRow: React.FC<ScrollableRowProps> = ({ title, items, loading, onSelect }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showLeft, setShowLeft] = useState(false);
  const [showRight, setShowRight] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const checkScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setShowLeft(el.scrollLeft > 10);
    setShowRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 10);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    checkScroll();
    el.addEventListener('scroll', checkScroll);
    const observer = new ResizeObserver(checkScroll);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', checkScroll);
      observer.disconnect();
    };
  }, [items, checkScroll]);

  const scroll = (direction: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction === 'left' ? -600 : 600, behavior: 'smooth' });
  };

  return (
    <div className="mb-2" onMouseEnter={() => setIsHovered(true)} onMouseLeave={() => setIsHovered(false)}>
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-3 px-1">
        <h3 className="text-base font-medium text-slate-800 dark:text-slate-200 flex items-center gap-2">
          <span className="inline-block w-1 h-4 rounded-full bg-[#0b57d0]" />
          {title}
        </h3>
      </div>

      {/* 滚动容器 */}
      <div className="relative">
        {/* 左箭头 */}
        <AnimatePresence>
          {showLeft && isHovered && (
            <motion.button
              key="left-arrow"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={{ duration: 0.18 }}
              className="absolute left-0 top-1/2 -translate-y-1/2 z-10 w-10 h-10 bg-white/95 dark:bg-slate-800/95 backdrop-blur-md rounded-full shadow-lg ring-1 ring-slate-200 dark:ring-slate-700 flex items-center justify-center hover:bg-white dark:hover:bg-slate-700 transition-colors"
              onClick={() => scroll('left')}
              aria-label="向左滚动"
            >
              <ChevronLeft className="w-5 h-5 text-slate-600 dark:text-slate-300" />
            </motion.button>
          )}
        </AnimatePresence>

        {/* 内容 */}
        <div
          ref={scrollRef}
          className="flex gap-4 overflow-x-auto scrollbar-hide pb-3 -mx-1 px-1"
          style={{ scrollSnapType: 'x mandatory' }}
        >
          {loading ? (
            Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex-shrink-0 w-[130px] sm:w-[150px]">
                <div className="aspect-[2/3] rounded-2xl bg-slate-200 dark:bg-slate-700 animate-pulse ring-1 ring-slate-200/60 dark:ring-slate-700/60" />
                <div className="mt-2.5 h-4 bg-slate-200 dark:bg-slate-700 rounded animate-pulse w-3/4" />
                <div className="mt-1.5 h-3 bg-slate-200 dark:bg-slate-700 rounded animate-pulse w-1/2" />
              </div>
            ))
          ) : items.length > 0 ? (
            items.map((item) => (
              <PosterCard key={`${item.source}-${item.id}`} item={item} onSelect={onSelect} />
            ))
          ) : (
            <div className="flex items-center justify-center w-full py-10 text-sm text-slate-400 dark:text-slate-500">
              暂无数据
            </div>
          )}
        </div>

        {/* 右箭头 */}
        <AnimatePresence>
          {showRight && isHovered && (
            <motion.button
              key="right-arrow"
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={{ duration: 0.18 }}
              className="absolute right-0 top-1/2 -translate-y-1/2 z-10 w-10 h-10 bg-white/95 dark:bg-slate-800/95 backdrop-blur-md rounded-full shadow-lg ring-1 ring-slate-200 dark:ring-slate-700 flex items-center justify-center hover:bg-white dark:hover:bg-slate-700 transition-colors"
              onClick={() => scroll('right')}
              aria-label="向右滚动"
            >
              <ChevronRight className="w-5 h-5 text-slate-600 dark:text-slate-300" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

// === MediaDetailModal 组件 ===
interface MediaDetailModalProps {
  item: MediaItem | null;
  isOpen: boolean;
  onClose: () => void;
  onAddAutoSeries: (item: MediaItem) => void;
  onPTSearch: (item: MediaItem) => void;
  addingSeries: boolean;
}

const MediaDetailModal: React.FC<MediaDetailModalProps> = ({
  item,
  isOpen,
  onClose,
  onAddAutoSeries,
  onPTSearch,
  addingSeries,
}) => {
  if (!item) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={item.title} footer={null}>
      <div className="flex flex-col gap-5">
        {/* 海报和基本信息 */}
        <div className="flex gap-5">
          <div className="flex-shrink-0 w-32 aspect-[2/3] rounded-2xl overflow-hidden bg-slate-100 dark:bg-slate-800 ring-1 ring-slate-200/60 dark:ring-slate-700/60 shadow-sm">
            {item.poster ? (
              <img src={item.poster} alt={item.title} className="w-full h-full object-cover" referrerPolicy="no-referrer-when-downgrade" />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <Clapperboard className="w-12 h-12 text-slate-400" />
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-xl font-medium text-slate-900 dark:text-slate-100 mb-3 break-words">{item.title}</h3>
            <div className="flex flex-wrap gap-2 mb-3">
              {item.rate && (
                <span className="inline-flex items-center gap-1 text-xs font-medium bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 px-2.5 py-1 rounded-full">
                  <Star className="w-3.5 h-3.5 fill-current" />
                  {item.rate}
                </span>
              )}
              {item.year && (
                <span className="inline-flex items-center gap-1 text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-2.5 py-1 rounded-full">
                  <Calendar className="w-3.5 h-3.5" />
                  {item.year}
                </span>
              )}
              <span className="inline-flex items-center gap-1 text-xs font-medium bg-[#d3e3fd] dark:bg-[#0b57d0]/20 text-[#0b57d0] dark:text-[#8ab4f8] px-2.5 py-1 rounded-full">
                <Globe className="w-3.5 h-3.5" />
                {item.source === 'douban' ? '豆瓣' : item.source === 'tmdb' ? 'TMDB' : '番组计划'}
              </span>
            </div>
            {item.overview && (
              <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-400 line-clamp-5">{item.overview}</p>
            )}
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex flex-col sm:flex-row gap-3 pt-4 border-t border-slate-200 dark:border-slate-700">
          <button
            onClick={() => onAddAutoSeries(item)}
            disabled={addingSeries}
            className="flex-1 flex items-center justify-center gap-2 px-5 py-2.5 rounded-full text-sm font-medium bg-[#0b57d0] hover:bg-[#0b57d0]/90 disabled:bg-[#0b57d0]/60 text-white shadow-sm transition-colors"
          >
            {addingSeries ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            {addingSeries ? '添加中…' : '添加自动追剧'}
          </button>
          <button
            onClick={() => onPTSearch(item)}
            className="flex-1 flex items-center justify-center gap-2 px-5 py-2.5 rounded-full text-sm font-medium bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
          >
            <Download className="w-4 h-4" />
            搜索下载
          </button>
        </div>
      </div>
    </Modal>
  );
};

// === 数据源切换 Tab 组件 ===
interface SourceTabProps {
  active: MediaSource;
  onChange: (s: MediaSource) => void;
}

const SOURCE_TABS: Array<{ id: MediaSource; label: string; icon: any }> = [
  { id: 'douban', label: '豆瓣', icon: Film },
  { id: 'tmdb', label: 'TMDB', icon: Tv },
  { id: 'bangumi', label: '番组计划', icon: Calendar },
];

const SourceTabs: React.FC<SourceTabProps> = ({ active, onChange }) => (
  <div className="inline-flex gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-full">
    {SOURCE_TABS.map((tab) => {
      const Icon = tab.icon;
      const isActive = active === tab.id;
      return (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`relative flex items-center gap-2 px-4 sm:px-5 py-2 rounded-full text-sm font-medium transition-colors ${
            isActive
              ? 'bg-white dark:bg-slate-900 text-[#0b57d0] dark:text-[#8ab4f8] shadow-sm'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
          }`}
        >
          <Icon className="w-4 h-4" />
          {tab.label}
        </button>
      );
    })}
  </div>
);

// === Chip 标签按钮 ===
interface ChipProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

const Chip: React.FC<ChipProps> = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    className={`flex-shrink-0 px-3.5 py-1.5 rounded-full text-xs font-medium transition-colors border ${
      active
        ? 'border-[#0b57d0] bg-[#d3e3fd] text-[#0b57d0] dark:bg-[#0b57d0]/20 dark:text-[#8ab4f8] dark:border-[#0b57d0]/40'
        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800'
    }`}
  >
    {children}
  </button>
);

// === 主组件 ===
interface PosterWallTabProps {
  onCreatePtSubscription?: (data: { name: string; rssUrl: string; sourcePreset: string }) => void;
}

const PosterWallTab: React.FC<PosterWallTabProps> = ({ onCreatePtSubscription }) => {
  const [activeSource, setActiveSource] = useState<MediaSource>('douban');
  const [loading, setLoading] = useState(false);

  // 豆瓣数据
  const [doubanHotMovies, setDoubanHotMovies] = useState<MediaItem[]>([]);
  const [doubanHotTV, setDoubanHotTV] = useState<MediaItem[]>([]);
  const [doubanTag, setDoubanTag] = useState('热门');

  // TMDB 数据 - 拆分为电影 / 剧集两行（同一分类下分别加载）
  const [tmdbMovies, setTmdbMovies] = useState<MediaItem[]>([]);
  const [tmdbTV, setTmdbTV] = useState<MediaItem[]>([]);
  const [tmdbCategory, setTmdbCategory] = useState('trending');

  // Bangumi 数据
  const [bangumiToday, setBangumiToday] = useState<MediaItem[]>([]);
  const [bangumiWeekday, setBangumiWeekday] = useState<MediaItem[]>([]);
  const [bangumiRanking, setBangumiRanking] = useState<MediaItem[]>([]);
  // 'today' | 'ranking' | '1'..'7' （星期）
  const [bangumiCategory, setBangumiCategory] = useState<string>('today');

  // 弹窗状态
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isPTSearchOpen, setIsPTSearchOpen] = useState(false);

  // 自动追剧状态
  const [addingSeries, setAddingSeries] = useState(false);

  // 榜单订阅弹窗状态
  const [isSubscribeOpen, setIsSubscribeOpen] = useState(false);

  // 豆瓣标签列表
  const doubanTags = ['热门', '最新', '经典', '豆瓣高分', '冷门佳片', '华语', '欧美', '韩国', '日本', '动作', '喜剧', '爱情', '科幻', '悬疑', '恐怖', '治愈'];

  // TMDB 分类列表（trending/top_rated 走对应接口，其它走 discover）
  const tmdbCategories: Array<{ key: string; label: string; movieGenre?: string; tvGenre?: string }> = [
    { key: 'trending', label: '本周趋势' },
    { key: 'top_rated', label: '高分佳作' },
    { key: 'genre:action', label: '动作', movieGenre: '28', tvGenre: '10759' },
    { key: 'genre:comedy', label: '喜剧', movieGenre: '35', tvGenre: '35' },
    { key: 'genre:scifi', label: '科幻', movieGenre: '878', tvGenre: '10765' },
    { key: 'genre:animation', label: '动画', movieGenre: '16', tvGenre: '16' },
    { key: 'genre:drama', label: '剧情', movieGenre: '18', tvGenre: '18' },
    { key: 'genre:romance', label: '爱情', movieGenre: '10749' },
    { key: 'genre:mystery', label: '悬疑', movieGenre: '9648', tvGenre: '9648' },
    { key: 'genre:horror', label: '恐怖', movieGenre: '27' },
    { key: 'genre:crime', label: '犯罪', movieGenre: '80', tvGenre: '80' },
    { key: 'genre:doc', label: '纪录片', movieGenre: '99', tvGenre: '99' },
  ];

  // Bangumi 分类列表
  const bangumiCategories: Array<{ key: string; label: string }> = [
    { key: 'today', label: '今日放送' },
    { key: 'ranking', label: '排行榜' },
    { key: '1', label: '周一' },
    { key: '2', label: '周二' },
    { key: '3', label: '周三' },
    { key: '4', label: '周四' },
    { key: '5', label: '周五' },
    { key: '6', label: '周六' },
    { key: '7', label: '周日' },
  ];

  // 将 TMDB 后端数据归一化到 MediaItem
  const normalizeTMDBItem = (item: any, fallbackType?: 'movie' | 'tv'): MediaItem => {
    const dateStr: string = item.releaseDate || item.release_date || item.first_air_date || '';
    const yearMatch = dateStr.match(/(\d{4})/);
    const rawType = item.type || item.media_type || fallbackType || 'movie';
    const type: MediaItem['type'] = rawType === 'tv' ? 'tv' : 'movie';
    return {
      id: String(item.id),
      title: item.title || item.name || '未知标题',
      poster: item.posterPath || item.poster_path || '',
      rate:
        typeof item.voteAverage === 'number'
          ? item.voteAverage.toFixed(1)
          : item.vote_average
            ? Number(item.vote_average).toFixed(1)
            : '',
      year: yearMatch ? yearMatch[1] : '',
      type,
      source: 'tmdb',
      overview: item.overview || '',
    };
  };

  // 加载豆瓣数据（按 tag 真实切换）
  const loadDoubanData = useCallback(async (tag: string) => {
    setLoading(true);
    try {
      let movies: MediaItem[];
      let tv: MediaItem[];
      if (tag === '热门') {
        [movies, tv] = await Promise.all([getDoubanHotMovies(), getDoubanHotTV()]);
      } else {
        // 其他标签使用搜索接口
        [movies, tv] = await Promise.all([
          searchDouban(tag, 'movie'),
          searchDouban(tag, 'tv'),
        ]);
      }
      setDoubanHotMovies(movies);
      setDoubanHotTV(tv);
    } catch (e) {
      console.error('加载豆瓣数据失败:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  // 加载 TMDB 数据（根据 category 决定走哪个接口）
  const loadTMDBData = useCallback(
    async (categoryKey: string) => {
      setLoading(true);
      try {
        const cat = tmdbCategories.find((c) => c.key === categoryKey) || tmdbCategories[0];

        // 抽取分页结果数组，兼容 { results } 和直接数组两种结构
        const pickResults = (res: any): any[] => {
          if (!res?.success) return [];
          if (Array.isArray(res.data?.results)) return res.data.results;
          if (Array.isArray(res.data)) return res.data;
          return [];
        };

        if (cat.key === 'trending') {
          // 取 trending 第 1+2 页拼成 ~40 条
          const [p1, p2] = await Promise.all([
            fetch('/api/tmdb/trending/all/week').then((r) => r.json()).catch(() => null),
            fetch('/api/tmdb/trending/all/week?page=2').then((r) => r.json()).catch(() => null),
          ]);
          const all = [...pickResults(p1), ...pickResults(p2)];
          const items = all.map((x) => normalizeTMDBItem(x));
          setTmdbMovies(items.filter((x) => x.type === 'movie'));
          setTmdbTV(items.filter((x) => x.type === 'tv'));
        } else if (cat.key === 'top_rated') {
          const [m1, m2, t1, t2] = await Promise.all([
            fetch('/api/tmdb/movie/top_rated').then((r) => r.json()).catch(() => null),
            fetch('/api/tmdb/movie/top_rated?page=2').then((r) => r.json()).catch(() => null),
            fetch('/api/tmdb/tv/top_rated').then((r) => r.json()).catch(() => null),
            fetch('/api/tmdb/tv/top_rated?page=2').then((r) => r.json()).catch(() => null),
          ]);
          const mList = [...pickResults(m1), ...pickResults(m2)];
          const tList = [...pickResults(t1), ...pickResults(t2)];
          setTmdbMovies(mList.map((x) => normalizeTMDBItem(x, 'movie')));
          setTmdbTV(tList.map((x) => normalizeTMDBItem(x, 'tv')));
        } else {
          // 分类：discover，电影 + 剧集 各取两页
          const movieFetch = (page: number) =>
            cat.movieGenre
              ? fetch(`/api/tmdb/discover/movie?with_genres=${cat.movieGenre}&sort_by=popularity.desc&page=${page}`)
                  .then((r) => r.json())
                  .catch(() => null)
              : Promise.resolve(null);
          const tvFetch = (page: number) =>
            cat.tvGenre
              ? fetch(`/api/tmdb/discover/tv?with_genres=${cat.tvGenre}&sort_by=popularity.desc&page=${page}`)
                  .then((r) => r.json())
                  .catch(() => null)
              : Promise.resolve(null);
          const [m1, m2, t1, t2] = await Promise.all([movieFetch(1), movieFetch(2), tvFetch(1), tvFetch(2)]);
          const mList = [...pickResults(m1), ...pickResults(m2)];
          const tList = [...pickResults(t1), ...pickResults(t2)];
          setTmdbMovies(mList.map((x) => normalizeTMDBItem(x, 'movie')));
          setTmdbTV(tList.map((x) => normalizeTMDBItem(x, 'tv')));
        }
      } catch (e) {
        console.error('加载 TMDB 数据失败:', e);
        setTmdbMovies([]);
        setTmdbTV([]);
      } finally {
        setLoading(false);
      }
    },
    // tmdbCategories 是组件内常量，不用作依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // 加载 Bangumi 今日
  const loadBangumiToday = useCallback(async () => {
    setLoading(true);
    try {
      const today = await getBangumiToday();
      setBangumiToday(today);
    } catch (e) {
      console.error('加载 Bangumi 今日数据失败:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  // 加载 Bangumi 指定星期数据
  const loadBangumiWeekday = useCallback(async (weekdayId: number) => {
    setLoading(true);
    try {
      const items = await getBangumiByWeekday(weekdayId);
      setBangumiWeekday(items);
    } catch (e) {
      console.error('加载 Bangumi 星期数据失败:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  // 加载 Bangumi 排行榜
  const loadBangumiRanking = useCallback(async () => {
    setLoading(true);
    try {
      const items = await getBangumiRanking(60);
      setBangumiRanking(items);
    } catch (e) {
      console.error('加载 Bangumi 排行榜失败:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  // 切换数据源 / 切换标签 / 切换星期 — 单一 effect 防止重复请求
  useEffect(() => {
    if (activeSource === 'douban') {
      loadDoubanData(doubanTag);
    } else if (activeSource === 'tmdb') {
      loadTMDBData(tmdbCategory);
    } else if (activeSource === 'bangumi') {
      if (bangumiCategory === 'today') {
        loadBangumiToday();
      } else if (bangumiCategory === 'ranking') {
        loadBangumiRanking();
      } else {
        const weekId = parseInt(bangumiCategory, 10);
        if (!Number.isNaN(weekId)) {
          loadBangumiWeekday(weekId);
        }
      }
    }
  }, [
    activeSource,
    doubanTag,
    tmdbCategory,
    bangumiCategory,
    loadDoubanData,
    loadTMDBData,
    loadBangumiToday,
    loadBangumiWeekday,
    loadBangumiRanking,
  ]);

  // 处理海报点击
  const handleSelect = (item: MediaItem) => {
    setSelectedItem(item);
    setIsDetailOpen(true);
  };

  // 添加自动追剧
  const handleAddAutoSeries = async (item: MediaItem) => {
    setAddingSeries(true);
    try {
      const r = await fetch('/api/auto-series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: item.title,
          year: item.year,
          mode: 'lazy',
        }),
      });
      const data = await r.json();
      if (data.success) {
        alert('自动追剧任务已添加！');
        setIsDetailOpen(false);
      } else {
        alert(`添加失败: ${data.error || '未知错误'}`);
      }
    } catch (e: any) {
      alert(`添加失败: ${e.message}`);
    } finally {
      setAddingSeries(false);
    }
  };

  // PT 搜索
  const handlePTSearch = (_item: MediaItem) => {
    setIsDetailOpen(false);
    setIsPTSearchOpen(true);
  };

  // 手动刷新当前激活源
  const handleRefresh = () => {
    if (activeSource === 'douban') {
      loadDoubanData(doubanTag);
    } else if (activeSource === 'tmdb') {
      loadTMDBData(tmdbCategory);
    } else if (activeSource === 'bangumi') {
      if (bangumiCategory === 'today') loadBangumiToday();
      else if (bangumiCategory === 'ranking') loadBangumiRanking();
      else {
        const weekId = parseInt(bangumiCategory, 10);
        if (!Number.isNaN(weekId)) loadBangumiWeekday(weekId);
      }
    }
  };

  // 当前 TMDB 分类标签（用于章节标题）
  const currentTmdbCategoryLabel =
    tmdbCategories.find((c) => c.key === tmdbCategory)?.label || '本周趋势';

  // 渲染内容
  const renderContent = () => {
    switch (activeSource) {
      case 'douban':
        return (
          <div className="space-y-6">
            {/* 豆瓣标签筛选 */}
            <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
              {doubanTags.map((tag) => (
                <Chip key={tag} active={doubanTag === tag} onClick={() => setDoubanTag(tag)}>
                  {tag}
                </Chip>
              ))}
            </div>

            <ScrollableRow
              title={doubanTag === '热门' ? '热门电影' : `${doubanTag} · 电影`}
              items={doubanHotMovies}
              loading={loading}
              onSelect={handleSelect}
            />
            <ScrollableRow
              title={doubanTag === '热门' ? '热门剧集' : `${doubanTag} · 剧集`}
              items={doubanHotTV}
              loading={loading}
              onSelect={handleSelect}
            />
          </div>
        );

      case 'tmdb':
        return (
          <div className="space-y-6">
            {/* TMDB 分类筛选 */}
            <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
              {tmdbCategories.map((cat) => (
                <Chip key={cat.key} active={tmdbCategory === cat.key} onClick={() => setTmdbCategory(cat.key)}>
                  {cat.label}
                </Chip>
              ))}
            </div>

            <ScrollableRow
              title={`${currentTmdbCategoryLabel} · 电影`}
              items={tmdbMovies}
              loading={loading}
              onSelect={handleSelect}
            />
            <ScrollableRow
              title={`${currentTmdbCategoryLabel} · 剧集`}
              items={tmdbTV}
              loading={loading}
              onSelect={handleSelect}
            />
          </div>
        );

      case 'bangumi': {
        let bangumiTitle = '今日放送';
        let bangumiList: MediaItem[] = [];
        if (bangumiCategory === 'today') {
          bangumiTitle = '今日放送';
          bangumiList = bangumiToday;
        } else if (bangumiCategory === 'ranking') {
          bangumiTitle = '动画排行榜';
          bangumiList = bangumiRanking;
        } else {
          const w = bangumiCategories.find((c) => c.key === bangumiCategory);
          bangumiTitle = w ? `${w.label}放送` : '放送';
          bangumiList = bangumiWeekday;
        }

        return (
          <div className="space-y-6">
            {/* 分类筛选 */}
            <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
              {bangumiCategories.map((cat) => (
                <Chip key={cat.key} active={bangumiCategory === cat.key} onClick={() => setBangumiCategory(cat.key)}>
                  {cat.label}
                </Chip>
              ))}
            </div>

            <ScrollableRow title={bangumiTitle} items={bangumiList} loading={loading} onSelect={handleSelect} />
          </div>
        );
      }
    }
  };

  // 当前激活的"榜单"信息（提供给订阅弹窗）
  const currentListInfo = (() => {
    if (activeSource === 'douban') {
      return { source: 'douban' as const, category: doubanTag, label: `豆瓣 · ${doubanTag}` };
    }
    if (activeSource === 'tmdb') {
      const cat = tmdbCategories.find((c) => c.key === tmdbCategory);
      // discover 分类用 'genre:movieId:tvId' 持久化，否则保留 trending/top_rated
      let category = tmdbCategory;
      if (cat?.key.startsWith('genre:')) {
        category = `genre:${cat.movieGenre || ''}:${cat.tvGenre || ''}`;
      }
      return { source: 'tmdb' as const, category, label: `TMDB · ${cat?.label || tmdbCategory}` };
    }
    // bangumi
    const bcat = bangumiCategories.find((c) => c.key === bangumiCategory);
    return { source: 'bangumi' as const, category: bangumiCategory, label: `番组计划 · ${bcat?.label || bangumiCategory}` };
  })();

  return (
    <div className="space-y-6 pb-12">
      {/* 顶部工具栏 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h3 className="text-xl font-medium text-slate-900 dark:text-slate-100 flex items-center gap-3">
            <Clapperboard size={24} className="text-[#0b57d0]" />
            海报墙
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <SourceTabs active={activeSource} onChange={setActiveSource} />
          <button
            onClick={() => setIsSubscribeOpen(true)}
            className="p-2.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-full hover:bg-[#d3e3fd] dark:hover:bg-[#0b57d0]/15 hover:text-[#0b57d0] transition-all text-slate-600 dark:text-slate-300 shadow-sm"
            title="订阅本榜单"
            aria-label="订阅本榜单"
          >
            <Bookmark size={18} />
          </button>
          <button
            onClick={handleRefresh}
            className="p-2.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-full hover:bg-slate-50 dark:hover:bg-slate-700 transition-all text-slate-600 dark:text-slate-300 shadow-sm"
            title="刷新"
            aria-label="刷新"
          >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* 内容卡片容器 */}
      <section className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/60 dark:border-slate-700/60 shadow-sm p-5 sm:p-6">
        {renderContent()}
      </section>

      {/* 详情弹窗 */}
      <MediaDetailModal
        item={selectedItem}
        isOpen={isDetailOpen}
        onClose={() => setIsDetailOpen(false)}
        onAddAutoSeries={handleAddAutoSeries}
        onPTSearch={handlePTSearch}
        addingSeries={addingSeries}
      />

      {/* PT 搜索弹窗 */}
      <PTSearchModal
        isOpen={isPTSearchOpen}
        onClose={() => setIsPTSearchOpen(false)}
        defaultKeyword={selectedItem?.title || ''}
        isAnime={selectedItem?.source === 'bangumi' || selectedItem?.type === 'anime'}
        autoSearchOnOpen
        titleSuffix={selectedItem?.title}
        onCreatePtSubscription={(data) => {
          onCreatePtSubscription?.(data);
        }}
      />

      {/* 榜单订阅弹窗 */}
      <ListSubscribeModal
        isOpen={isSubscribeOpen}
        onClose={() => setIsSubscribeOpen(false)}
        currentSource={currentListInfo.source}
        currentCategory={currentListInfo.category}
        currentLabel={currentListInfo.label}
      />
    </div>
  );
};

// === 榜单订阅管理弹窗 ===
interface ListSubscribeModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentSource: 'douban' | 'tmdb' | 'bangumi';
  currentCategory: string;
  currentLabel: string;
}

interface ListSubscription {
  id: string;
  name: string;
  enabled: boolean;
  source: 'douban' | 'tmdb' | 'bangumi';
  category: string;
  cron: string;
  mode: 'lazy' | 'normal';
  fallbackToPt: boolean;
  ptPreset: string;
  limit: number;
  remark?: string;
  lastRunAt?: string | null;
  lastResult?: any;
}

const CRON_PRESETS: Array<{ value: string; label: string }> = [
  { value: '0 8 * * *', label: '每天 8:00' },
  { value: '0 */6 * * *', label: '每 6 小时' },
  { value: '0 0 * * 1', label: '每周一 0:00' },
  { value: '*/30 * * * *', label: '每 30 分钟' },
];

const ListSubscribeModal: React.FC<ListSubscribeModalProps> = ({
  isOpen,
  onClose,
  currentSource,
  currentCategory,
  currentLabel,
}) => {
  const [subs, setSubs] = useState<ListSubscription[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 表单字段
  const [name, setName] = useState('');
  const [cronExpr, setCronExpr] = useState('0 8 * * *');
  const [mode, setMode] = useState<'lazy' | 'normal'>('lazy');
  const [fallbackToPt, setFallbackToPt] = useState(true);
  const [ptPreset, setPtPreset] = useState('nyaa');
  const [limit, setLimit] = useState(20);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/list-subscriptions');
      const d = await r.json();
      if (d?.success) setSubs(d.data || []);
      else setError(d?.error || '加载失败');
    } catch (e: any) {
      setError(e?.message || '请求失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchAll();
      setName(currentLabel);
      setCronExpr('0 8 * * *');
      setMode('lazy');
      setFallbackToPt(true);
      setPtPreset('nyaa');
      setLimit(20);
      setError(null);
    }
  }, [isOpen, currentLabel, fetchAll]);

  const handleCreate = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/list-subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          source: currentSource,
          category: currentCategory,
          cron: cronExpr,
          mode,
          fallbackToPt,
          ptPreset,
          limit,
        }),
      });
      const d = await r.json();
      if (d?.success) {
        await fetchAll();
      } else {
        setError(d?.error || '创建失败');
      }
    } catch (e: any) {
      setError(e?.message || '请求失败');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (sub: ListSubscription) => {
    try {
      const r = await fetch(`/api/list-subscriptions/${sub.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...sub, enabled: !sub.enabled }),
      });
      const d = await r.json();
      if (d?.success) await fetchAll();
      else alert(d?.error || '更新失败');
    } catch (e: any) {
      alert(e?.message || '请求失败');
    }
  };

  const handleDelete = async (sub: ListSubscription) => {
    if (!confirm(`确定删除订阅「${sub.name}」吗？`)) return;
    try {
      const r = await fetch(`/api/list-subscriptions/${sub.id}`, { method: 'DELETE' });
      const d = await r.json();
      if (d?.success) await fetchAll();
      else alert(d?.error || '删除失败');
    } catch (e: any) {
      alert(e?.message || '请求失败');
    }
  };

  const handleRun = async (sub: ListSubscription) => {
    try {
      const r = await fetch(`/api/list-subscriptions/${sub.id}/run`, { method: 'POST' });
      const d = await r.json();
      if (d?.success) {
        const s = d.data || {};
        alert(`执行完成：抓取 ${s.totalFetched ?? 0} 条 / 新增 ${s.newItems ?? 0} 条 / 自动追剧 ${s.autoSeries ?? 0} / PT ${s.pt ?? 0} / 失败 ${s.failed ?? 0}`);
        await fetchAll();
      } else {
        alert(d?.error || '执行失败');
      }
    } catch (e: any) {
      alert(e?.message || '请求失败');
    }
  };

  const formatTime = (iso?: string | null) => {
    if (!iso) return '从未运行';
    try {
      return new Date(iso).toLocaleString('zh-CN');
    } catch {
      return iso;
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="榜单订阅" footer={null}>
      <div className="space-y-5">
        {/* 新建订阅区 */}
        <section className="space-y-3 p-4 rounded-2xl bg-slate-50 dark:bg-slate-800 border border-slate-200/60 dark:border-slate-700/60">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-slate-800 dark:text-slate-100 flex items-center gap-2">
              <Bookmark className="w-4 h-4 text-[#0b57d0]" />
              订阅当前榜单 · <span className="text-[#0b57d0]">{currentLabel}</span>
            </h4>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-slate-500 dark:text-slate-400">订阅名称</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-xl outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-slate-500 dark:text-slate-400">运行频率（cron）</label>
              <select
                value={cronExpr}
                onChange={(e) => setCronExpr(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-xl outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              >
                {CRON_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label} ({p.value})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-slate-500 dark:text-slate-400">每次抓取条数</label>
              <input
                type="number"
                min={1}
                max={100}
                value={limit}
                onChange={(e) => setLimit(Math.min(100, Math.max(1, parseInt(e.target.value) || 20)))}
                className="w-full px-3 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-xl outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-slate-500 dark:text-slate-400">追剧模式</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as 'lazy' | 'normal')}
                className="w-full px-3 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-xl outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
              >
                <option value="lazy">懒转存（推荐）</option>
                <option value="normal">普通追剧</option>
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={fallbackToPt}
                onChange={(e) => setFallbackToPt(e.target.checked)}
                className="w-4 h-4 text-[#0b57d0] rounded focus:ring-[#0b57d0]"
              />
              自动追剧失败时回退到 PT
            </label>
            {fallbackToPt && (
              <select
                value={ptPreset}
                onChange={(e) => setPtPreset(e.target.value)}
                className="px-3 py-1.5 text-xs bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full outline-none"
              >
                <option value="nyaa">PT 优先：Nyaa</option>
                <option value="dmhy">PT 优先：动漫花园</option>
                <option value="mikan">PT 优先：Mikan</option>
                <option value="animegarden">PT 优先：AnimeGarden</option>
                <option value="anibt">PT 优先：AniBT</option>
              </select>
            )}
          </div>

          {error && (
            <div className="text-xs px-3 py-2 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-200/60 dark:border-red-500/20 text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleCreate}
              disabled={saving || !name.trim()}
              className="px-5 py-2 rounded-full text-sm font-medium bg-[#0b57d0] hover:bg-[#0b57d0]/90 disabled:bg-[#0b57d0]/50 text-white shadow-sm transition-colors flex items-center gap-2"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              创建订阅
            </button>
          </div>
        </section>

        {/* 现有订阅列表 */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-slate-800 dark:text-slate-100">已有订阅</h4>
            <button
              type="button"
              onClick={fetchAll}
              className="p-1.5 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 transition-colors"
              title="刷新列表"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-8 text-sm text-slate-400">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              加载中…
            </div>
          ) : subs.length === 0 ? (
            <div className="text-center py-8 text-sm text-slate-400 dark:text-slate-500">暂无订阅，使用上方表单创建</div>
          ) : (
            <ul className="space-y-2 max-h-72 overflow-y-auto custom-scrollbar pr-1">
              {subs.map((sub) => {
                const last = sub.lastResult;
                return (
                  <li
                    key={sub.id}
                    className={`p-3 rounded-2xl border transition-colors ${sub.enabled ? 'bg-white dark:bg-slate-800/60 border-slate-200/60 dark:border-slate-700/60' : 'bg-slate-50 dark:bg-slate-800/30 border-slate-200/40 dark:border-slate-700/40 opacity-70'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{sub.name}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                            {sub.source}
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#d3e3fd] text-[#0b57d0] dark:bg-[#0b57d0]/20 dark:text-[#8ab4f8]">
                            {sub.category}
                          </span>
                          {!sub.enabled && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-300 text-slate-700 dark:bg-slate-600 dark:text-slate-200">
                              已停用
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                          {sub.cron} · {sub.mode === 'lazy' ? '懒转存' : '普通'}
                          {sub.fallbackToPt && ` · 失败回退 ${sub.ptPreset || 'nyaa'}`}
                        </div>
                        <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">
                          上次：{formatTime(sub.lastRunAt)}
                          {last && (
                            <>
                              {' '}· 抓取 {last.totalFetched ?? 0} / 新 {last.newItems ?? 0}
                              {' '}· 追剧 {last.autoSeries ?? 0} / PT {last.pt ?? 0} / 失败 {last.failed ?? 0}
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex-shrink-0 flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleRun(sub)}
                          className="p-1.5 rounded-full text-slate-500 dark:text-slate-400 hover:bg-[#d3e3fd] dark:hover:bg-[#0b57d0]/15 hover:text-[#0b57d0] transition-colors"
                          title="立即运行"
                          aria-label="立即运行"
                        >
                          <Play className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggle(sub)}
                          className={`px-2 py-1 rounded-full text-[10px] font-medium transition-colors ${sub.enabled ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-slate-200 text-slate-600 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-300'}`}
                          title={sub.enabled ? '点击停用' : '点击启用'}
                        >
                          {sub.enabled ? '启用中' : '已停用'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(sub)}
                          className="p-1.5 rounded-full text-slate-500 dark:text-slate-400 hover:bg-red-50 dark:hover:bg-red-500/10 hover:text-red-600 transition-colors"
                          title="删除"
                          aria-label="删除"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 提示 */}
        <div className="text-[11px] text-slate-400 dark:text-slate-500 px-1">
          按 cron 周期拉取榜单，新条目优先尝试自动追剧；失败且开启回退则改走 PT（取首个可用 directRss）。需先在「系统」中配置自动追剧默认账号 / 目录。
        </div>
      </div>
    </Modal>
  );
};

export default PosterWallTab;
