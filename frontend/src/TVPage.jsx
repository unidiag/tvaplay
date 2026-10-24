
import { useEffect, useMemo, useState } from 'react';

import ChannelList from './components/ChannelList';
import VideoPlayer from './components/VideoPlayer';
import usePlaylist from './hooks/usePlaylist';
import useEPG from './hooks/useEPG';
import { getCurrentProgramme } from './utils/epg';

import './styles.css';
import useFavorites from './hooks/useFavorites';

const FAVORITES = 'tvaplay.tv.favorites.v2';
const LAST = 'tvaplay.tv.last.v2';

const readJSON = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};

export default function TVPage({ onLogout }) {
  const { channels, loading, error } = usePlaylist();
  const {
    programmes,
    now,
    error: epgError,
  } = useEPG();

  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('Все');
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  const [favorites, setFavorites] = useState(
    () => new Set(readJSON(FAVORITES, []))
  );

  const [selectedKey, setSelectedKey] = useState(
    () => localStorage.getItem(LAST) || ''
  );

  const groups = useMemo(
    () => ['Все', ...new Set(channels.map((c) => c.group))],
    [channels]
  );

  const selected = useMemo(
    () => channels.find((c) => c.key === selectedKey) || null,
    [channels, selectedKey]
  );

  const currentProgramme = getCurrentProgramme(
    programmes,
    selectedKey,
    now
  );

  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();

    return channels.filter((c) =>
      (group === 'Все' || c.group === group) &&
      (!favoritesOnly || favorites.has(c.key)) &&
      (!q || c.name.toLocaleLowerCase().includes(q))
    );
  }, [channels, query, group, favoritesOnly, favorites]);

  const select = (channel) => {
    setSelectedKey(channel.key);
    localStorage.setItem(LAST, channel.key);
  };

  const toggleFavorite = (key) => {
    setFavorites((prev) => {
      const next = new Set(prev);

      if (next.has(key)) next.delete(key);
      else next.add(key);

      localStorage.setItem(
        FAVORITES,
        JSON.stringify([...next])
      );

      return next;
    });
  };







  useFavorites({
    // Короткое нажатие:
    // Добавить или удалить текущий канал.
    onShortPress: () => {
      if (!selected) return;

      toggleFavorite(selected.key);
    },

    // Длинное нажатие:
    // Включить или выключить режим избранного.
    onLongPress: () => {
      setFavoritesOnly((prev) => !prev);
    },
  });







  useEffect(() => {
    const handler = (event) => {
      if (
        ['INPUT', 'SELECT', 'TEXTAREA'].includes(
          document.activeElement?.tagName
        )
      ) return;

      if (
        event.key !== 'ArrowUp' &&
        event.key !== 'ArrowDown'
      ) return;

      event.preventDefault();

      if (!visible.length) return;

      const pos = visible.findIndex(
        (c) => c.key === selectedKey
      );

      const next = event.key === 'ArrowDown'
        ? Math.min(visible.length - 1, pos + 1)
        : Math.max(
            0,
            pos < 0 ? 0 : pos - 1
          );

      select(visible[next]);
    };

    window.addEventListener('keydown', handler);

    return () =>
      window.removeEventListener('keydown', handler);
  }, [visible, selectedKey]);

  return (
    <main className="tv-root">
      <header className="tv-header">
        <div className="tv-brand">
          <img
            src="/logo192.png"
            alt=""
            className="tv-brand-logo"
          />

          <strong>TVAPLAY</strong>
          <span>Телевидение</span>
        </div>


        <button
          type="button"
          className="tv-logout"
          onClick={onLogout}
        >
          Выйти
        </button>
      </header>

      <div className="tv-layout">
        <VideoPlayer
          channel={selected}
          programme={currentProgramme}
          now={now}
        />

        <aside className="tv-sidebar">

          <input
            className="tv-search"
            placeholder="Поиск канала…"
            aria-label="Поиск канала"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          <div className="tv-filters">
            <select
              aria-label="Группа"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
            >
              {groups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>

            <button
              className={
                favoritesOnly ? 'is-filtered' : ''
              }
              onClick={() =>
                setFavoritesOnly((v) => !v)
              }
            >
              ★ Избранное
            </button>
          </div>

          {loading ? (
            <p className="tv-message">
              Загружаем плейлист…
            </p>
          ) : error ? (
            <p className="tv-message tv-error-text">
              Ошибка загрузки: {error}
            </p>
          ) : visible.length ? (
            <ChannelList
              channels={visible}
              selectedKey={selectedKey}
              onSelect={select}
              favorites={favorites}
              onToggleFavorite={toggleFavorite}
              programmes={programmes}
              now={now}
            />
          ) : (
            <p className="tv-message">
              Каналы не найдены
            </p>
          )}

          {epgError && (
            <div
              className="tv-epg-warning"
              title={epgError}
            >
              Программа передач временно недоступна
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
