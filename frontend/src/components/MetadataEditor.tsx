import React, { useEffect, useMemo, useState } from 'react';
import { Lock, RotateCcw, Save, Sparkles, X } from 'lucide-react';

interface MetadataFile {
  relativePath: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  special: boolean;
  episodeTitle: string;
  targetFileName: string;
  locks?: Record<string, boolean>;
}

interface InspectedFile {
  relativePath: string;
  automatic?: { seasonNumber?: number | null; episodeNumber?: number | null; special?: boolean };
}

interface MetadataOverride {
  version: 1;
  source: 'user';
  work: {
    tmdbId: string; title: string; year: string; mediaType: 'movie' | 'tv' | '';
    category: string; seasonNumber: number | null; seasonName: string; totalEpisodes: number | null;
    locks: Record<string, boolean>;
  };
  template: { defaultSeasonNumber: number | null; episodeOffset: number };
  files: MetadataFile[];
  fingerprint?: string;
}

interface MetadataEditorProps {
  open: boolean;
  title: string;
  endpoint: string;
  onClose: () => void;
  onSaved?: () => void;
}

const blankOverride = (): MetadataOverride => ({
  version: 1,
  source: 'user',
  work: { tmdbId: '', title: '', year: '', mediaType: '', category: '', seasonNumber: null, seasonName: '', totalEpisodes: null, locks: { '*': true } },
  template: { defaultSeasonNumber: 1, episodeOffset: 0 },
  files: []
});

const numberOrNull = (value: string): number | null => value === '' ? null : Number(value);

const MetadataEditor: React.FC<MetadataEditorProps> = ({ open, title, endpoint, onClose, onSaved }) => {
  const [value, setValue] = useState<MetadataOverride>(blankOverride());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ changeCount: number; changes: unknown[] } | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError('');
    fetch(endpoint)
      .then(response => response.json())
      .then(data => {
        if (!data.success) throw new Error(data.error || '读取元数据失败');
        const current = data.data?.override as MetadataOverride | null;
        const inspected = (data.data?.inspection?.files || []) as InspectedFile[];
        const base = current || blankOverride();
        const existing = new Map((base.files || []).map(file => [file.relativePath, file]));
        setValue({
          ...base,
          source: 'user',
          work: { ...blankOverride().work, ...(base.work || {}), locks: { '*': true, ...(base.work?.locks || {}) } },
          template: { ...blankOverride().template, ...(base.template || {}) },
          fingerprint: data.data?.inspection?.fingerprint || base.fingerprint || '',
          files: inspected.map(file => existing.get(file.relativePath) || {
            relativePath: file.relativePath,
            seasonNumber: file.automatic?.seasonNumber ?? base.template?.defaultSeasonNumber ?? 1,
            episodeNumber: file.automatic?.episodeNumber ?? null,
            special: Boolean(file.automatic?.special),
            episodeTitle: '', targetFileName: '', locks: { '*': true }
          })
        });
      })
      .catch(err => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [open, endpoint]);

  const mappedCount = useMemo(() => value.files.filter(file => file.episodeNumber !== null || file.special).length, [value.files]);
  if (!open) return null;

  const updateWork = (field: keyof MetadataOverride['work'], next: string | number | null) => {
    setValue(current => ({ ...current, work: { ...current.work, [field]: next } }));
  };
  const updateFile = (index: number, next: Partial<MetadataFile>) => {
    setValue(current => ({ ...current, files: current.files.map((file, i) => i === index ? { ...file, ...next, locks: { '*': true } } : file) }));
  };
  const fillSeasons = () => setValue(current => ({ ...current, files: current.files.map(file => ({ ...file, seasonNumber: file.special ? 0 : current.template.defaultSeasonNumber, locks: { '*': true } })) }));
  const fillEpisodes = () => {
    let episode = 1 + Number(value.template.episodeOffset || 0);
    setValue(current => ({ ...current, files: current.files.map(file => file.special ? file : ({ ...file, episodeNumber: episode++, locks: { '*': true } })) }));
  };
  const request = async (suffix: string, method: string) => {
    setLoading(true); setError('');
    try {
      const response = await fetch(`${endpoint}${suffix}`, { method, headers: { 'Content-Type': 'application/json' }, ...(method !== 'DELETE' ? { body: JSON.stringify(value) } : {}) });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || '操作失败');
      return data.data;
    } catch (err) {
      setError((err as Error).message); throw err;
    } finally { setLoading(false); }
  };
  const handlePreview = async () => {
    try { const data = await request('/preview', 'POST'); setPreview(data.preview || data); } catch { /* 已展示 */ }
  };
  const handleSave = async () => {
    try {
      const data = await request('', 'PUT');
      if (data?.requiresApply) {
        const applyResponse = await fetch(`${endpoint}/apply`, { method: 'POST' });
        const applyData = await applyResponse.json();
        if (!applyData.success) throw new Error(applyData.error || '应用元数据失败');
      }
      onSaved?.(); onClose();
    } catch (err) { setError((err as Error).message); }
  };
  const handleReset = async () => {
    try { await request('', 'DELETE'); onSaved?.(); onClose(); } catch { /* 已展示 */ }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-slate-950/45 p-4 flex items-center justify-center" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <section className="w-full max-w-6xl max-h-[92vh] overflow-hidden rounded-3xl bg-white shadow-2xl flex flex-col">
        <header className="px-6 py-5 border-b border-slate-200 flex items-center justify-between">
          <div><h2 className="text-lg font-bold text-slate-900">元数据编辑 · {title}</h2><p className="text-xs text-slate-500 mt-1">完整相对路径参与指纹校验；保存前可预演，用户字段会自动锁定。</p></div>
          <button className="p-2 rounded-xl hover:bg-slate-100" onClick={onClose}><X size={20} /></button>
        </header>
        <div className="p-6 overflow-y-auto space-y-5">
          {error && <div className="rounded-xl bg-rose-50 text-rose-700 px-4 py-3 text-sm">{error}</div>}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {([
              ['tmdbId', 'TMDB ID'], ['title', '标题'], ['year', '年份'], ['category', '分类'], ['seasonName', '季度名称']
            ] as const).map(([field, label]) => <label key={field} className="text-xs text-slate-500">{label}<input className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900" value={String(value.work[field] ?? '')} onChange={e => updateWork(field, e.target.value)} /></label>)}
            <label className="text-xs text-slate-500">媒体类型<select className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" value={value.work.mediaType} onChange={e => updateWork('mediaType', e.target.value)}><option value="">自动</option><option value="tv">剧集</option><option value="movie">电影</option></select></label>
            <label className="text-xs text-slate-500">季号<input type="number" min="0" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" value={value.work.seasonNumber ?? ''} onChange={e => updateWork('seasonNumber', numberOrNull(e.target.value))} /></label>
            <label className="text-xs text-slate-500">总集数<input type="number" min="0" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" value={value.work.totalEpisodes ?? ''} onChange={e => updateWork('totalEpisodes', numberOrNull(e.target.value))} /></label>
          </div>
          <div className="flex flex-wrap items-end gap-3 rounded-2xl bg-slate-50 p-4">
            <label className="text-xs text-slate-500">默认季号<input type="number" min="0" className="mt-1 w-24 rounded-xl border border-slate-200 px-3 py-2 text-sm" value={value.template.defaultSeasonNumber ?? ''} onChange={e => setValue(current => ({ ...current, template: { ...current.template, defaultSeasonNumber: numberOrNull(e.target.value) } }))} /></label>
            <label className="text-xs text-slate-500">集号偏移<input type="number" step="0.5" className="mt-1 w-24 rounded-xl border border-slate-200 px-3 py-2 text-sm" value={value.template.episodeOffset} onChange={e => setValue(current => ({ ...current, template: { ...current.template, episodeOffset: Number(e.target.value) || 0 } }))} /></label>
            <button className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" onClick={fillSeasons}>批量季号</button>
            <button className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" onClick={fillEpisodes}>连续集号</button>
            <span className="ml-auto text-xs text-slate-500">已映射 {mappedCount}/{value.files.length}</span>
          </div>
          <div className="overflow-x-auto rounded-2xl border border-slate-200">
            <table className="min-w-[1100px] w-full text-sm"><thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="p-3">完整相对路径</th><th className="p-3">季</th><th className="p-3">集（支持 .5）</th><th className="p-3">SP</th><th className="p-3">集标题</th><th className="p-3">目标主文件名</th><th className="p-3"><Lock size={14} /></th></tr></thead>
              <tbody>{value.files.map((file, index) => <tr key={file.relativePath} className="border-t border-slate-100"><td className="p-3 font-mono text-xs whitespace-nowrap">{file.relativePath}</td><td className="p-2"><input type="number" min="0" className="w-20 rounded-lg border border-slate-200 px-2 py-1.5" value={file.seasonNumber ?? ''} onChange={e => updateFile(index, { seasonNumber: numberOrNull(e.target.value) })} /></td><td className="p-2"><input type="number" min="0" step="0.5" className="w-24 rounded-lg border border-slate-200 px-2 py-1.5" value={file.episodeNumber ?? ''} onChange={e => updateFile(index, { episodeNumber: numberOrNull(e.target.value) })} /></td><td className="p-2"><input type="checkbox" checked={file.special} onChange={e => updateFile(index, { special: e.target.checked, seasonNumber: e.target.checked ? 0 : file.seasonNumber })} /></td><td className="p-2"><input className="w-44 rounded-lg border border-slate-200 px-2 py-1.5" value={file.episodeTitle} onChange={e => updateFile(index, { episodeTitle: e.target.value })} /></td><td className="p-2"><input className="w-52 rounded-lg border border-slate-200 px-2 py-1.5" value={file.targetFileName} onChange={e => updateFile(index, { targetFileName: e.target.value })} /></td><td className="p-3 text-amber-500"><Lock size={14} /></td></tr>)}</tbody>
            </table>
          </div>
          {preview && <div className="rounded-2xl bg-indigo-50 px-4 py-3 text-sm text-indigo-800">预演完成：{preview.changeCount} 项实际变更。{preview.changeCount === 0 ? '不会写入无意义覆盖。' : '确认保存后进入应用流程。'}</div>}
        </div>
        <footer className="px-6 py-4 border-t border-slate-200 flex gap-3 justify-end">
          <button disabled={loading} className="mr-auto rounded-xl px-4 py-2 text-sm text-rose-600 hover:bg-rose-50 flex items-center gap-2" onClick={handleReset}><RotateCcw size={16} />重置</button>
          <button disabled={loading} className="rounded-xl border border-slate-200 px-4 py-2 text-sm flex items-center gap-2" onClick={handlePreview}><Sparkles size={16} />预演</button>
          <button disabled={loading} className="rounded-xl bg-indigo-600 text-white px-4 py-2 text-sm flex items-center gap-2 disabled:opacity-50" onClick={handleSave}><Save size={16} />保存覆盖</button>
        </footer>
      </section>
    </div>
  );
};

export default MetadataEditor;
