
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  VideoPlayer,
  VideoSkin,
} from "@videojs/react/video";

import {
  HlsJsVideo,
} from "@videojs/react/media/hlsjs-video";

import "@videojs/react/video/skin.css";

const STREAM_URL = `${
  (process.env.REACT_APP_URL || "").replace(/\/+$/, "")
}/hls/DOMASH/index.m3u8`;

const PLAYER_KEY = "tvaplay_player";

const PLAYER_TYPES = [
  { value: "html5", label: "HTML5" },
  { value: "hlsjs", label: "hls.js" },
  { value: "videojs", label: "Video.js 10" },
];

// ============================================
// Общие функции
// ============================================

function getSavedPlayer() {
  try {
    const saved = localStorage.getItem(PLAYER_KEY);

    return PLAYER_TYPES.some(
      (p) => p.value === saved
    )
      ? saved
      : "html5";
  } catch {
    return "html5";
  }
}

function getVideoInfo(video) {
  if (!video) return null;

  const buffered = [];

  try {
    for (
      let i = 0;
      i < video.buffered.length;
      i++
    ) {
      buffered.push({
        start: video.buffered.start(i),
        end: video.buffered.end(i),
      });
    }
  } catch (err) {
    console.warn("Cannot read video buffer:", err);
  }

  return {
    errorCode: video.error?.code ?? null,
    errorMessage: video.error?.message ?? null,

    currentSrc: video.currentSrc,
    currentTime: video.currentTime,
    duration: video.duration,

    readyState: video.readyState,
    networkState: video.networkState,

    paused: video.paused,
    muted: video.muted,
    seeking: video.seeking,

    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,

    buffered,
  };
}

function logVideoError(engine, video) {
  const info = getVideoInfo(video);

  console.group(`${engine}: MEDIA ERROR`);

  console.error("Video state:", info);

  switch (video?.error?.code) {
    case 1:
      console.error("MEDIA_ERR_ABORTED");
      break;

    case 2:
      console.error("MEDIA_ERR_NETWORK");
      break;

    case 3:
      console.error(
        "MEDIA_ERR_DECODE: ошибка декодирования"
      );
      break;

    case 4:
      console.error(
        "MEDIA_ERR_SRC_NOT_SUPPORTED"
      );
      break;

    default:
      console.error(
        "Неизвестная ошибка HTMLVideoElement"
      );
  }

  console.groupEnd();
}

// Попытка автозапуска.
// При блокировке звука браузером используем muted.
async function tryAutoPlay(video) {
  if (!video) return;

  try {
    video.muted = false;
    await video.play();
  } catch (err) {
    if (err?.name === "AbortError") return;

    if (err?.name === "NotAllowedError") {
      try {
        video.muted = true;
        await video.play();
      } catch (e) {
        if (e?.name !== "AbortError") {
          console.warn("Autoplay:", e);
        }
      }
    } else {
      console.warn("Autoplay:", err);
    }
  }
}

// ============================================
// Диагностика HTMLVideoElement
//
// Работает и тогда, когда video создаётся
// дочерним компонентом Video.js асинхронно.
// ============================================

function useVideoDiagnostics(containerRef, engine) {
  useEffect(() => {
    const container = containerRef.current;

    if (!container) return;

    let observedVideo = null;

    const onError = () => {
      if (observedVideo) {
        logVideoError(engine, observedVideo);
      }
    };

    const onStalled = () => {
      if (observedVideo) {
        console.warn(`${engine}: stalled`, {
          currentTime: observedVideo.currentTime,
          readyState: observedVideo.readyState,
        });
      }
    };

    const onWaiting = () => {
      if (observedVideo) {
        console.log(`${engine}: waiting`, {
          currentTime: observedVideo.currentTime,
        });
      }
    };

    const onPlaying = () => {
      if (observedVideo) {
        console.log(`${engine}: playing`, {
          currentTime: observedVideo.currentTime,
          width: observedVideo.videoWidth,
          height: observedVideo.videoHeight,
        });
      }
    };

    const detach = () => {
      if (!observedVideo) return;

      observedVideo.removeEventListener(
        "error",
        onError
      );

      observedVideo.removeEventListener(
        "stalled",
        onStalled
      );

      observedVideo.removeEventListener(
        "waiting",
        onWaiting
      );

      observedVideo.removeEventListener(
        "playing",
        onPlaying
      );

      observedVideo = null;
    };

    const attach = () => {
      const video = container.querySelector("video");

      if (video === observedVideo) return;

      detach();

      if (!video) return;

      observedVideo = video;

      video.addEventListener("error", onError);
      video.addEventListener("stalled", onStalled);
      video.addEventListener("waiting", onWaiting);
      video.addEventListener("playing", onPlaying);

      console.log(
        `${engine}: video element detected`,
        video
      );

      if (video.error) {
        logVideoError(engine, video);
      }
    };

    attach();

    const observer = new MutationObserver(attach);

    observer.observe(container, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
      detach();
    };
  }, [containerRef, engine]);
}

// ============================================
// HTML5 Native HLS
// ============================================

function NativePlayer() {
  const containerRef = useRef(null);
  const videoRef = useRef(null);

  useVideoDiagnostics(containerRef, "HTML5");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const supported = Boolean(
      video.canPlayType(
        "application/vnd.apple.mpegurl"
      ) ||
      video.canPlayType(
        "application/x-mpegURL"
      )
    );

    console.log("HTML5 Native HLS:", supported);

    if (!supported) {
      console.warn(
        "HTML5: браузер не поддерживает Native HLS"
      );
      return;
    }

    video.src = STREAM_URL;
    video.load();

    tryAutoPlay(video);

    return () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, []);

  return (
    <div ref={containerRef} className="tv-media">
      <video
        ref={videoRef}
        controls
        playsInline
        preload="auto"
        className="tv-html5-video"
      />
    </div>
  );
}

// ============================================
// hls.js
// ============================================

function HlsJsPlayer() {
  const containerRef = useRef(null);
  const videoRef = useRef(null);

  useVideoDiagnostics(containerRef, "hls.js");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    let hls = null;
    let recoveryCount = 0;

    const init = async () => {
      try {
        const { default: Hls } = await import("hls.js");

        if (cancelled) return;

        if (!Hls.isSupported()) {
          console.error(
            "hls.js: MSE не поддерживается"
          );
          return;
        }

        console.log("hls.js version:", Hls.version);

        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 30,
        });

        hls.on(
          Hls.Events.MEDIA_ATTACHED,
          () => {
            if (!cancelled) {
              hls?.loadSource(STREAM_URL);
            }
          }
        );

        hls.on(
          Hls.Events.MANIFEST_PARSED,
          () => {
            if (!cancelled) {
              tryAutoPlay(video);
            }
          }
        );

        hls.on(
          Hls.Events.ERROR,
          (_event, data) => {
            if (cancelled) return;

            console.group("hls.js ERROR");

            console.error({
              type: data.type,
              details: data.details,
              fatal: data.fatal,
              reason: data.reason,
              response: data.response,
              fragment: data.frag?.url,
              error: data.error,
            });

            console.log(
              "HTML5 state:",
              getVideoInfo(video)
            );

            console.groupEnd();

            if (!data.fatal) return;

            if (
              data.type ===
              Hls.ErrorTypes.MEDIA_ERROR
            ) {
              // Ограничиваем количество попыток
              // восстановления декодера.
              if (recoveryCount < 2) {
                recoveryCount++;
                hls?.recoverMediaError();
              } else {
                console.error(
                  "hls.js: recovery limit reached"
                );
              }
            } else if (
              data.type ===
              Hls.ErrorTypes.NETWORK_ERROR
            ) {
              console.error(
                "hls.js: fatal network error"
              );
              hls?.stopLoad();
            }
          }
        );

        hls.attachMedia(video);
      } catch (err) {
        if (!cancelled) {
          console.error(
            "hls.js initialization error:",
            err
          );
        }
      }
    };

    init();

    return () => {
      cancelled = true;

      if (hls) {
        hls.destroy();
        hls = null;
      }

      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, []);

  return (
    <div ref={containerRef} className="tv-media">
      <video
        ref={videoRef}
        controls
        playsInline
        preload="auto"
        className="tv-html5-video"
      />
    </div>
  );
}

// ============================================
// Video.js 10 с HlsJsVideo
// ============================================

function VideoJs10Player() {
  const containerRef = useRef(null);

  // Новый диагностический хук.
  // Отслеживает внутренний <video>,
  // включая ошибки декодирования и MSE.
  useVideoDiagnostics(
    containerRef,
    "Video.js 10"
  );

  return (
    <div
      ref={containerRef}
      className="tv-media"
    >
      <VideoPlayer>
        <VideoSkin className="tv-videojs-skin">
          <HlsJsVideo
            src={STREAM_URL}
            autoPlay
            muted
            playsInline
            preload="auto"
            onError={(event) => {
              console.error(
                "Video.js 10 component error:",
                event
              );
            }}
          />
        </VideoSkin>
      </VideoPlayer>
    </div>
  );
}

// ============================================
// Выбор движка
// ============================================

function PlayerSurface({ type }) {
  if (type === "html5") {
    return <NativePlayer />;
  }

  if (type === "hlsjs") {
    return <HlsJsPlayer />;
  }

  if (type === "videojs") {
    return <VideoJs10Player />;
  }

  return null;
}

// ============================================
// SmartTVTest
// ============================================

export default function SmartTVTest() {
  const [playerType, setPlayerType] = useState(
    getSavedPlayer
  );

  const [focusedId, setFocusedId] =
    useState("video");

  const controlsRef = useRef({
    video: null,
    player: null,
    reload: null,
    link: null,
  });

  const focusControl = useCallback((id) => {
    const element = controlsRef.current[id];

    if (element) {
      element.focus();
      setFocusedId(id);
    }
  }, []);

  const changePlayer = useCallback((type) => {
    if (!PLAYER_TYPES.some((p) => p.value === type)) {
      return;
    }

    try {
      localStorage.setItem(PLAYER_KEY, type);
    } catch {
      // localStorage может быть недоступен
    }

    setPlayerType(type);
  }, []);

  // ----------------------------------------
  // Управление видео
  // ----------------------------------------

  const getVideo = useCallback(() => {
    return controlsRef.current.video?.querySelector(
      "video"
    );
  }, []);

  const play = useCallback(() => {
    const video = getVideo();

    if (!video) return;

    Promise.resolve(video.play()).catch((err) => {
      if (err?.name !== "AbortError") {
        console.error("Play error:", err);
      }
    });
  }, [getVideo]);

  const pause = useCallback(() => {
    getVideo()?.pause();
  }, [getVideo]);

  const togglePlay = useCallback(() => {
    const video = getVideo();

    if (!video) return;

    if (video.paused) {
      play();
    } else {
      pause();
    }
  }, [getVideo, play, pause]);

  // ----------------------------------------
  // Пульт Smart TV
  // ----------------------------------------

  useEffect(() => {
    const handleKeyDown = (event) => {
      const key = event.key;
      const code = event.keyCode || event.which;

      const left =
        key === "ArrowLeft" || code === 37;

      const right =
        key === "ArrowRight" || code === 39;

      const up =
        key === "ArrowUp" || code === 38;

      const down =
        key === "ArrowDown" || code === 40;

      const enter =
        key === "Enter" || code === 13;

      const back =
        key === "Escape" ||
        key === "Back" ||
        key === "BrowserBack" ||
        key === "GoBack" ||
        code === 27 ||
        code === 10009 ||
        code === 461;

      const mediaPlay =
        key === "MediaPlay" || code === 415;

      const mediaPause =
        key === "MediaPause" || code === 19;

      const mediaToggle =
        key === "MediaPlayPause" ||
        code === 179 ||
        code === 10252;

      if (
        mediaPlay ||
        mediaPause ||
        mediaToggle
      ) {
        event.preventDefault();

        if (mediaPlay) {
          play();
        } else if (mediaPause) {
          pause();
        } else {
          togglePlay();
        }

        return;
      }

      if (back) {
        event.preventDefault();
        focusControl("video");
        return;
      }

      const active = document.activeElement;

      const activeId =
        Object.entries(controlsRef.current)
          .find(([, el]) =>
            el &&
            (el === active || el.contains(active))
          )?.[0] || "video";

      // Область видеоплеера
      if (activeId === "video") {
        // Не перехватываем управление внутренними
        // элементами VideoSkin.
        if (
          active !== controlsRef.current.video
        ) {
          return;
        }

        if (down) {
          event.preventDefault();
          focusControl("player");
        } else if (enter) {
          event.preventDefault();
          togglePlay();
        }

        return;
      }

      // Селектор движка
      if (activeId === "player") {
        if (left || right) {
          event.preventDefault();

          const index = PLAYER_TYPES.findIndex(
            (p) => p.value === playerType
          );

          const direction = right ? 1 : -1;

          const next =
            (index + direction +
              PLAYER_TYPES.length) %
            PLAYER_TYPES.length;

          changePlayer(PLAYER_TYPES[next].value);
          return;
        }

        if (up) {
          event.preventDefault();
          focusControl("video");
          return;
        }

        if (down) {
          event.preventDefault();
          focusControl("reload");
          return;
        }

        return;
      }

      // Перезагрузка страницы
      if (activeId === "reload") {
        if (up) {
          event.preventDefault();
          focusControl("player");
        } else if (down) {
          event.preventDefault();
          focusControl("link");
        } else if (enter) {
          event.preventDefault();
          window.location.reload();
        }

        return;
      }

      // Ссылка на HLS
      if (activeId === "link") {
        if (up) {
          event.preventDefault();
          focusControl("reload");
        }
      }
    };

    window.addEventListener(
      "keydown",
      handleKeyDown,
      true
    );

    return () => {
      window.removeEventListener(
        "keydown",
        handleKeyDown,
        true
      );
    };
  }, [
    playerType,
    changePlayer,
    focusControl,
    play,
    pause,
    togglePlay,
  ]);

  // Установка фокуса при первом открытии
  useEffect(() => {
    const timer = setTimeout(() => {
      focusControl("video");
    }, 300);

    return () => clearTimeout(timer);
  }, [focusControl]);

  const focusStyle = (id) => ({
    outline:
      focusedId === id
        ? "3px solid #00bcd4"
        : "3px solid transparent",

    outlineOffset: 3,

    boxShadow:
      focusedId === id
        ? "0 0 14px rgba(0,188,212,0.5)"
        : "none",
  });

  return (
    <div style={{ padding: 20 }}>
      {/* Видео */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div
          ref={(el) => {
            controlsRef.current.video = el;
          }}
          tabIndex={0}
          onFocus={() => setFocusedId("video")}
          style={{
            width: "100%",
            maxWidth: 640,
            aspectRatio: "16 / 9",
            backgroundColor: "#000",
            borderRadius: 8,
            overflow: "hidden",
            ...focusStyle("video"),
          }}
        >
          <PlayerSurface
            key={playerType}
            type={playerType}
          />
        </div>
      </div>

      {/* HLS URL */}
      <div
        style={{
          textAlign: "center",
          marginTop: 12,
          overflowWrap: "anywhere",
        }}
      >
        <a
          ref={(el) => {
            controlsRef.current.link = el;
          }}
          href={STREAM_URL}
          target="_blank"
          rel="noreferrer"
          onFocus={() => setFocusedId("link")}
          style={focusStyle("link")}
        >
          {STREAM_URL}
        </a>
      </div>

      {/* Панель управления */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          gap: 12,
          marginTop: 20,
          flexWrap: "wrap",
        }}
      >
        <label htmlFor="player-select">
          Плеер:
        </label>

        <select
          id="player-select"
          ref={(el) => {
            controlsRef.current.player = el;
          }}
          value={playerType}
          onFocus={() => setFocusedId("player")}
          onChange={(e) => {
            changePlayer(e.target.value);
          }}
          style={{
            padding: "8px 12px",
            fontSize: 16,
            borderRadius: 6,
            cursor: "pointer",
            ...focusStyle("player"),
          }}
        >
          {PLAYER_TYPES.map((p) => (
            <option
              key={p.value}
              value={p.value}
            >
              {p.label}
            </option>
          ))}
        </select>

        <button
          ref={(el) => {
            controlsRef.current.reload = el;
          }}
          onFocus={() => setFocusedId("reload")}
          onClick={() => window.location.reload()}
          style={{
            padding: "8px 16px",
            fontSize: 16,
            cursor: "pointer",
            borderRadius: 6,
            ...focusStyle("reload"),
          }}
        >
          ↻ Перезагрузить страницу
        </button>
      </div>

      <style>
        {`
          .tv-media {
            width: 100%;
            height: 100%;
            background: #000;
          }

          .tv-html5-video {
            display: block;
            width: 100%;
            height: 100%;
            object-fit: contain;
            background: #000;
          }

          .tv-media video-player,
          .tv-media video-skin,
          .tv-videojs-skin {
            display: block;
            width: 100%;
            height: 100%;
          }

          .tv-media video {
            max-width: 100%;
          }
        `}
      </style>
    </div>
  );
}
