import { useEffect, useRef, useState } from 'react';
const ITEM_HEIGHT = 68;
const OVERSCAN = 6;

export default function ChannelList({ channels, selectedKey, onSelect, favorites, onToggleFavorite }) {
  const viewportRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(500);
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (viewportRef.current) viewportRef.current.scrollTop = 0; setScrollTop(0); }, [channels]);
  useEffect(() => {
    const element = viewportRef.current;
    if (!element || !selectedKey) return;
    const index = channels.findIndex((item) => item.key === selectedKey);
    if (index < 0) return;
    const start = index * ITEM_HEIGHT;
    const end = start + ITEM_HEIGHT;
    if (start < element.scrollTop) element.scrollTop = start;
    else if (end > element.scrollTop + element.clientHeight) element.scrollTop = end - element.clientHeight;
  }, [selectedKey, channels]);
  const first = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
  const last = Math.min(channels.length, Math.ceil((scrollTop + height) / ITEM_HEIGHT) + OVERSCAN);
  return (
    <div className="tv-list-viewport" ref={viewportRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} role="listbox" aria-label="Каналы">
      <div style={{ height: channels.length * ITEM_HEIGHT, position: 'relative' }}>
        {channels.slice(first, last).map((channel, offset) => (
          <div key={channel.key} className={`tv-channel ${channel.key === selectedKey ? 'is-active' : ''}`}
            style={{ top: (first + offset) * ITEM_HEIGHT, height: ITEM_HEIGHT }} role="option" aria-selected={channel.key === selectedKey}>
            <button className="tv-channel-main" onClick={() => onSelect(channel)} title={channel.name}>
              <span className="tv-channel-index">{first + offset + 1}</span>
              {channel.logo ? <img src={channel.logo} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} /> : <span className="tv-no-logo">TV</span>}
              <span className="tv-channel-text"><strong>{channel.name}</strong><small>{channel.group}</small></span>
            </button>
            <button className={`tv-star ${favorites.has(channel.url) ? 'starred' : ''}`} aria-label="Избранное" title="Избранное" onClick={() => onToggleFavorite(channel.url)}>{favorites.has(channel.url) ? '★' : '☆'}</button>
          </div>
        ))}
      </div>
    </div>
  );
}
