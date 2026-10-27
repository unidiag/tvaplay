
import { useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
  getProgrammeProgress,
  formatEPGTime,
  formatMinutes,
} from '../utils/epg';




// Определяем телевизионную платформу по User-Agent.
function isSmartTV() {
  const ua = navigator.userAgent || '';

  return /SmartTV|Smart-TV|Tizen|Web0S|WebOS|webOS|NetCast|HbbTV|Viera|BRAVIA|GoogleTV|Android TV|AFTB|AFTT|AppleTV|Roku|VIDAA|Hisense|PhilipsTV|MediaStationX/i.test(ua);
}

// Проверяем нативную поддержку HLS.
function supportsNativeHLS(video) {
  if (!video) return false;

  return Boolean(
    video.canPlayType('application/vnd.apple.mpegurl') ||
    video.canPlayType('application/x-mpegURL')
  );
}

// Режим из URL: auto, native, hlsjs.
function getPlayerMode() {
  const mode = new URLSearchParams(
    window.location.search
  ).get('player');

  return ['native', 'hlsjs'].includes(mode)
    ? mode
    : 'auto';
}

export default function VideoPlayer({ channel, programme, now }) {
  const videoRef = useRef(null);

  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [retry, setRetry] = useState(0);
  const [engine, setEngine] = useState('');
  const [showEngine, setShowEngine] = useState(false);

  const channelKey = channel?.key;
  const channelUrl = channel?.url;

  const playerMode = useMemo(() => getPlayerMode(), []);
  const smartTV = useMemo(() => isSmartTV(), []);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.muted = muted;
  }, [muted]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls = null;
    let active = true;


    let engineTimer = null;

    const showEngineTemporarily = () => {
      clearTimeout(engineTimer);

      setShowEngine(false);

      // Показываем индикатор при запуске видео.
      setShowEngine(true);

      engineTimer = setTimeout(() => {
        if (active) {
          setShowEngine(false);
        }
      }, 3000);
    };




    const resetVideo = () => {
      video.pause();

      video.removeAttribute('src');
      video.removeAttribute('crossorigin');

      video.load();
    };


    resetVideo();

    if (!channelUrl) {
      setStatus('idle');
      setError('');
      setEngine('');
      return;
    }

    setStatus('loading');
    setError('');







    





    const nativeSupported = supportsNativeHLS(video);
    const hlsjsSupported = Hls.isSupported();

    let selectedEngine = '';

    if (playerMode === 'native') {
      // Принудительный HTML5.
      selectedEngine = 'native';
    } else if (playerMode === 'hlsjs') {
      // Принудительный hls.js, если доступен.
      selectedEngine = hlsjsSupported ? 'hlsjs' : '';
    } else if (smartTV) {
      // На телевизорах приоритет HTML5.
      selectedEngine = 'native';
    } else if (hlsjsSupported) {
      // На компьютерах приоритет hls.js.
      selectedEngine = 'hlsjs';
    } else if (nativeSupported) {
      // Резервный вариант для Safari и других браузеров.
      selectedEngine = 'native';
    }

    const useNative = selectedEngine === 'native';

    setEngine(selectedEngine);

    console.log('[TV Player]', {
      channel: channelKey,
      mode: playerMode,
      smartTV,
      nativeSupported,
      hlsjsSupported,
      engine: selectedEngine,
    });
















    const play = async () => {
      if (!active) return;

      try {
        await video.play();

        if (active) {
          setStatus('playing');
          setError('');
        }
      } catch (err) {
        if (!active) return;

        setStatus('paused');
        setError(`Нажмите Play: ${err.message}`);
      }
    };


    const handlePlaying = () => {
      if (!active) return;

      setStatus('playing');
      setError('');

      // Показываем тип плеера на 5 секунд.
      showEngineTemporarily();
    };


    const handleWaiting = () => {
      if (active) setStatus('loading');
    };

    const handlePause = () => {
      if (active) setStatus('paused');
    };

    const handleError = () => {
      if (!active) return;

      const mediaError = video.error;

      setStatus('error');
      setError(
        mediaError
          ? `Ошибка HTML5 (${mediaError.code})`
          : 'Ошибка воспроизведения'
      );
    };

    video.addEventListener('playing', handlePlaying);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('pause', handlePause);
    video.addEventListener('error', handleError);

    if (useNative) {
      // HTML5: передаём HLS напрямую встроенному
      // видеоплееру телевизора.
      video.addEventListener('loadedmetadata', play, {
        once: true,
      });

      video.src = channelUrl;
      video.load();





    } else if (selectedEngine === 'hlsjs') {
      let networkRetries = 0;
      let mediaRetries = 0;

hls = new Hls({
  enableWorker: true,
  lowLatencyMode: false,
  backBufferLength: 30,
  startLevel: -1,
});

      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        if (!active) return;

        console.log('[HLS] Media attached:', channelKey);
        hls?.loadSource(channelUrl);
      });

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!active) return;

        console.log('[HLS] Manifest parsed:', channelKey);
        play();
      });

      hls.on(Hls.Events.FRAG_LOADED, () => {
        networkRetries = 0;
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!active || !data.fatal) return;

        console.error('[HLS] Fatal error:', {
          channel: channelKey,
          type: data.type,
          details: data.details,
          response: data.response,
        });

        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (networkRetries < 3) {
            networkRetries++;
            setStatus('loading');

            hls?.startLoad();
            return;
          }

          setStatus('error');
          setError(`Сетевая ошибка HLS: ${data.details}`);

        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (mediaRetries < 2) {
            mediaRetries++;
            hls?.recoverMediaError();
            return;
          }

          setStatus('error');
          setError(`Ошибка декодирования HLS: ${data.details}`);

        } else {
          setStatus('error');
          setError(`Ошибка HLS: ${data.details}`);
        }

        hls?.destroy();
        hls = null;
      });

      hls.attachMedia(video);

    } else {
      setStatus('error');
      setError('HLS не поддерживается этим браузером');
    }






    return () => {
      active = false;

      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('error', handleError);
      video.removeEventListener('loadedmetadata', play);

      hls?.destroy();
      resetVideo();
    };
  }, [channelKey, channelUrl, retry, playerMode, smartTV]);

  const togglePlay = async () => {
    const video = videoRef.current;
    if (!video || !channelUrl) return;

    if (video.paused) {
      try {
        await video.play();
        setStatus('playing');
        setError('');
      } catch (err) {
        setStatus('paused');
        setError(err.message);
      }
    } else {
      video.pause();
      setStatus('paused');
    }
  };

  const toggleMuted = () => {
    setMuted((prev) => !prev);
  };

  const toggleFullscreen = async () => {
    const video = videoRef.current;
    if (!video) return;

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (video.requestFullscreen) {
        await video.requestFullscreen();
      } else if (video.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
      }
    } catch (err) {
      console.error('Fullscreen error:', err);
    }
  };






  const progress = getProgrammeProgress(programme, now);

  const elapsed = programme
    ? formatMinutes(now - programme.start)
    : 0;

  const remaining = programme
    ? formatMinutes(programme.stop - now)
    : 0;












  return (
    <section
      className="tv-player"
      aria-label="Видеоплеер"
    >
      <div className="tv-screen">
        <video
          ref={videoRef}
          playsInline
          autoPlay
          muted={muted}
          controls={false}
          disablePictureInPicture
          disableRemotePlayback
          controlsList="nodownload nofullscreen noremoteplayback"
        />

        {channel && engine && (
          <div
            className={`tv-player-engine ${
              showEngine ? 'is-visible' : ''
            }`}
            aria-hidden="true"
          >
            {engine === 'native' ? 'HTML5' : 'hls.js'}
          </div>
        )}

        {!channel && (
          <div className="tv-overlay">
            Выберите телеканал
          </div>
        )}

        {channel && status === 'loading' && (
          <div className="player-spinner" role="status" aria-label="Подключение к эфиру" />
        )}

        {channel && status === 'error' && (
          <div className="tv-overlay tv-error">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setRetry((n) => n + 1)}
            >
              Повторить
            </button>
          </div>
        )}



        <div className="tv-player-buttons">
          <button
            type="button"
            onClick={togglePlay}
            title="Play / Pause"
            disabled={!channel}
          >
            ⏯
          </button>

          <button
            type="button"
            onClick={toggleMuted}
            title="Звук"
          >
            {muted ? '🔇' : '🔊'}
          </button>

          <button
            type="button"
            onClick={toggleFullscreen}
            title="Полный экран"
            disabled={!channel}
          >
            ⛶
          </button>
        </div>



      </div>











      <div
        className="tv-player-footer"
        style={
          programme?.icon
            ? {
                '--programme-poster': `url("${programme.icon}")`,
              }
            : undefined
        }
      >
        <div className="tv-player-details">
          <div className="tv-player-heading">
            <span className="tv-live">LIVE</span>

            <strong className="tv-player-channel-name">
              {channel?.name || 'Нет канала'}
            </strong>


            {programme && (
              <span className="tv-programme-time">
                {formatEPGTime(programme.start)}
                {' – '}
                {formatEPGTime(programme.stop)}
              </span>
            )}
          </div>

          {programme ? (
            <div className="tv-programme-details">
              <div className="tv-programme-title">
                {programme.title}
                {programme.rating?.trim() && (
                  <> ({programme.rating.trim()})</>
                )}
              </div>

              {programme.description && (
                <p className="tv-programme-description">
                  {programme.description}
                </p>
              )}

              <div className="tv-programme-progress">
                <div
                  className="tv-programme-progress-fill"
                  style={{ width: `${progress}%` }}
                />
              </div>

              <div className="tv-programme-progress-info">
                <span>Прошло {elapsed} мин</span>
                <span>Осталось {remaining} мин</span>
              </div>
            </div>
          ) : (
            <div className="tv-programme-no-data">
              {channel
                ? 'Нет информации о текущей передаче'
                : 'Выберите канал'}
            </div>
          )}
        </div>


      </div>













    </section>
  );
}
