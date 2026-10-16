import { useEffect, useMemo, useState } from 'react';
import ChannelList from './components/ChannelList';
import VideoPlayer from './components/VideoPlayer';
import usePlaylist from './hooks/usePlaylist';
import './styles.css';

const readJSON = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const FAVORITES = 'tvaplay.tv.favorites';
const LAST = 'tvaplay.tv.last';

export default function TVPage() {
  const { channels, loading, error, refresh } = usePlaylist();
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('Все');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [favorites, setFavorites] = useState(() => new Set(readJSON(FAVORITES, [])));
  const [selectedUrl, setSelectedUrl] = useState(() => localStorage.getItem(LAST) || '');
  const groups = useMemo(() => ['Все', ...new Set(channels.map((c) => c.group))], [channels]);
  const selected = useMemo(() => channels.find((c) => c.url === selectedUrl) || null, [channels, selectedUrl]);
  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return channels.filter((c) => (group === 'Все' || c.group === group) && (!favoritesOnly || favorites.has(c.url)) && (!q || c.name.toLocaleLowerCase().includes(q)));
  }, [channels, query, group, favoritesOnly, favorites]);
  const select = (channel) => { setSelectedUrl(channel.url); localStorage.setItem(LAST, channel.url); };
  const toggleFavorite = (url) => setFavorites((prev) => { const next = new Set(prev); if (next.has(url)) next.delete(url); else next.add(url); localStorage.setItem(FAVORITES, JSON.stringify([...next])); return next; });

  useEffect(() => {
    const handler = (event) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        if (!visible.length) return;
        const pos = visible.findIndex((c) => c.url === selectedUrl);
        const next = event.key === 'ArrowDown' ? Math.min(visible.length - 1, pos + 1) : Math.max(0, pos < 0 ? 0 : pos - 1);
        select(visible[next]);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visible, selectedUrl]);

  return (
    <main className="tv-root">
      <header className="tv-header"><div className="tv-brand">◉ <strong>TVA PLAY</strong><span>Телевидение</span></div><span className="tv-counter">{channels.length.toLocaleString('ru-RU')} каналов</span></header>
      <div className="tv-layout">
        <VideoPlayer channel={selected} />
        <aside className="tv-sidebar">
          <div className="tv-sidebar-head"><h2>Каналы <small>{visible.length}</small></h2><button onClick={refresh} title="Обновить плейлист">↻</button></div>
          <input className="tv-search" placeholder="Поиск канала…" aria-label="Поиск канала" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="tv-filters"><select aria-label="Группа" value={group} onChange={(e) => setGroup(e.target.value)}>{groups.map((g) => <option key={g} value={g}>{g}</option>)}</select><button className={favoritesOnly ? 'is-filtered' : ''} onClick={() => setFavoritesOnly((v) => !v)}>★ Избранное</button></div>
          {loading ? <p className="tv-message">Загружаем плейлист…</p> : error ? <p className="tv-message tv-error-text">Ошибка загрузки: {error}</p> : visible.length ? <ChannelList channels={visible} selectedKey={selected?.key} onSelect={select} favorites={favorites} onToggleFavorite={toggleFavorite} /> : <p className="tv-message">Каналы не найдены</p>}
        </aside>
      </div>
    </main>
  );
}
