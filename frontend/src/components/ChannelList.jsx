
import { useEffect, useRef, useState } from 'react';

import {
  getCurrentProgramme,
  getProgrammeProgress,
} from '../utils/epg';

const ITEM_HEIGHT = 120;
const OVERSCAN = 6;

export default function ChannelList({
  channels,
  selectedKey,
  onSelect,
  favorites,
  onToggleFavorite,
  programmes,
  now,
}) {
  const viewportRef = useRef(null);
  const [height, setHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    setHeight(element.clientHeight);

    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(([entry]) => {
      setHeight(entry.contentRect.height);
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    element.scrollTop = 0;
    setScrollTop(0);
  }, [channels]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element || !selectedKey) return;

    const index = channels.findIndex(
      (item) => item.key === selectedKey
    );

    if (index < 0) return;

    const start = index * ITEM_HEIGHT;
    const end = start + ITEM_HEIGHT;

    if (start < element.scrollTop) {
      element.scrollTop = start;
    } else if (
      end > element.scrollTop + element.clientHeight
    ) {
      element.scrollTop =
        end - element.clientHeight;
    }
  }, [selectedKey, channels]);

  const startIndex = Math.max(
    0,
    Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN
  );

  const visibleCount =
    Math.ceil(height / ITEM_HEIGHT) + OVERSCAN * 2;

  const endIndex = Math.min(
    channels.length,
    startIndex + visibleCount
  );

  const visibleChannels = channels.slice(
    startIndex,
    endIndex
  );

  return (
    <div
      className="tv-list-viewport"
      ref={viewportRef}
      role="listbox"
      aria-label="Каналы"
      onScroll={(event) =>
        setScrollTop(event.currentTarget.scrollTop)
      }
    >
      <div
        style={{
          position: 'relative',
          height: channels.length * ITEM_HEIGHT,
        }}
      >
        {visibleChannels.map((channel, index) => {
          const active = selectedKey === channel.key;
          const favorite = favorites.has(channel.key);

          const programme = getCurrentProgramme(
            programmes,
            channel.key,
            now
          );

          const progress = getProgrammeProgress(
            programme,
            now
          );

          return (
            <div
              key={channel.key}
              className={
                `tv-channel ${active ? 'is-active' : ''}`
              }
              style={{
                position: 'absolute',
                top: (startIndex + index) * ITEM_HEIGHT,
                height: ITEM_HEIGHT,
              }}
              role="option"
              aria-selected={active}
              tabIndex={0}
              onClick={() => onSelect(channel)}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' ||
                  event.key === ' '
                ) {
                  event.preventDefault();
                  onSelect(channel);
                }
              }}
            >
              {channel.logo ? (
                <img
                  className="tv-channel-logo"
                  src={channel.logo}
                  alt=""
                  loading="lazy"
                  onError={(event) => {
                    event.currentTarget.style.display = 'none';
                  }}
                />
              ) : (
                <div className="tv-no-logo">TV</div>
              )}

              <div className="tv-channel-info">
                <div className="tv-channel-name">
                  {channel.name}
                </div>

                <div className="tv-channel-group">
                  {programme?.title
                    ? `${programme.title}${programme.rating?.trim() ? ` (${programme.rating.trim()})` : ''}`
                    : 'Нет программы'}
                </div>

                <div className="tv-epg-progress">
                  <div
                    className="tv-epg-progress-fill"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>

              <button
                type="button"
                className={
                  `tv-channel-favorite ${
                    favorite ? 'is-favorite' : ''
                  }`
                }
                aria-label={
                  favorite
                    ? 'Удалить из избранного'
                    : 'Добавить в избранное'
                }
                title={
                  favorite
                    ? 'Удалить из избранного'
                    : 'Добавить в избранное'
                }
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleFavorite(channel.key);
                }}
              >
                {favorite ? '★' : '☆'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
