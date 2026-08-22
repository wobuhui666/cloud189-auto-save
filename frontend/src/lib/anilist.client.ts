export interface AniListItem {
  id: string;
  title: string;
  poster: string;
  rate: string;
  year: string;
  overview?: string;
  genres?: string[];
  source: 'anilist';
  type: 'anime';
}

export interface AniListQuery {
  sort?: 'TRENDING_DESC' | 'POPULARITY_DESC' | 'SCORE_DESC' | 'START_DATE_DESC';
  format?: string;
  season?: string;
  seasonYear?: string;
  genre?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export async function getAniListAnime(query: AniListQuery = {}): Promise<AniListItem[]> {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== '') params.set(key, String(value));
  });
  try {
    const response = await fetch(`/api/anilist/anime?${params.toString()}`);
    const json = await response.json();
    if (!response.ok || !json?.success || !Array.isArray(json.data?.results)) return [];
    return json.data.results.map((item: any): AniListItem => ({
      id: String(item.id),
      title: item.title || '未命名动画',
      poster: item.poster || '',
      rate: item.rate || '',
      year: item.year || '',
      overview: item.overview || '',
      genres: Array.isArray(item.genres) ? item.genres : [],
      source: 'anilist',
      type: 'anime',
    }));
  } catch (error) {
    console.error('获取 AniList 动漫失败:', error);
    return [];
  }
}
