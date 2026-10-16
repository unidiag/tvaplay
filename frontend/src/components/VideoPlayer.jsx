import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

export default function VideoPlayer({ channel }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !channel) return;
    let hls;
    let active = true;
    setStatus('loading');
    setError('');
    video.pause();
    video.removeAttribute('src');
    video.load();
    const play = () => video.play().then(() => { if (active) setStatus('playing'); })
      .catch((err) => { if (active) { setStatus('paused'); setError(`Нажмите Play для запуска: ${err.message}`); } });

    if (Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 45 });
      hls.on(Hls.Events.MANIFEST_PARSED, play);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!active || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else { setStatus('error'); setError(`Ошибка потока: ${data.details}`); hls.destroy(); hls = null; }
      });
      hls.loadSource(channel.url);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = channel.url;
      video.addEventListener('loadedmetadata', play, { once: true });
    } else {
      setStatus('error'); setError('HLS не поддерживается этим браузером');
    }
    return () => {
      active = false;
      hls?.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [channel, retry]);

  return (
    <section className="tv-player" aria-label="Видеоплеер">
      <div className="tv-screen">
        <video ref={videoRef} playsInline autoPlay muted={muted} controls onError={() => { setStatus('error'); setError('Не удалось воспроизвести поток'); }} />
        {!channel && <div className="tv-overlay">Выберите канал справа</div>}
        {channel && status === 'loading' && <div className="tv-overlay">Подключение к эфиру…</div>}
        {channel && status === 'error' && <div className="tv-overlay tv-error"><span>{error}</span><button onClick={() => setRetry((n) => n + 1)}>Повторить</button></div>}
      </div>
      <div className="tv-player-footer">
        <div className="tv-current"><span className="tv-live">LIVE</span><strong>{channel?.name || 'Нет канала'}</strong><small>{channel?.group || 'Выберите канал'}</small></div>
        <div className="tv-player-buttons">
          <button onClick={() => { const v = videoRef.current; if (!v) return; if (v.paused) v.play().catch(() => {}); else v.pause(); }} title="Play / Pause">⏯</button>
          <button onClick={() => setMuted((v) => !v)} title="Звук">{muted ? '🔇' : '🔊'}</button>
          <button onClick={() => { const v = videoRef.current; if (v?.requestFullscreen) v.requestFullscreen().catch(() => {}); }} title="Полный экран видео">⛶</button>
        </div>
      </div>
    </section>
  );
}
