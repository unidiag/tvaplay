/* MODULE: 31-playerPage.js */
(function(app, $) {
    "use strict";

    function t(key, params) {
        return app.i18n && typeof app.i18n.t === "function" ?
            app.i18n.t(key, params) : String(key);
    }
    var playlistXHR = null;
    var channels = [];
    var selectedURL = null;
    var fullscreenBox = null;
    var activeVideo = null;
    var playerLoader = null;
    var archiveLoader = null;
    var pageVersion = 0;
    var playbackAttempt = 0;
    var playbackErrorShown = false;
    var epgTimer = null;
    var hlsInstance = null;
    var hlsScriptPending = null;
    // Загружается только на desktop, Smart TV не затрагиваем.
    var HLS_JS_URL =
        "/app/hls.light.min.js";
    var archiveXHR = null;
    var archiveChannel = null;
    var archiveReturnFocus = null;
    var archivePage = null;
    var archivePlayXHR = null;
    var archivePlayGeneration = 0;
    var archivePlayingProgramme = null;
    var archivePlayingURL = null;
    var archivePreviousLiveChannel = null;
    var pendingSearchArchive = null;
    var archiveTimerInterval = null;
    var archiveAutoAdvancePending = false;
    var archiveSeekBufferTimer = null;
    var archiveSeekBufferPending = false;
    var archiveSeekBufferShown = false;
    var archiveSeekBufferGeneration = 0;
    var archiveSeekbarHideTimer = null;
    function getHlsJsURL(url) {
        url = String(url || "");
        // Относительные адреса с нашего сервера.
        if (url.charAt(0) === "/" && url.charAt(1) !== "/") {
            return "https://" + window.location.hostname + url;
        }
        // Абсолютные HTTP-адреса переводим на HTTPS.
        return url.replace(/^http:\/\//i, "https://");
    }
    function getNativeURL(url) {
        url = String(url || "");
        // Относительный адрес: HTTP для старых Smart TV.
        if (url.charAt(0) === "/" && url.charAt(1) !== "/") {
            return "http://" + window.location.host + url;
        }
        // Абсолютные HTTPS-адреса переводим на HTTP.
        return url.replace(/^https:\/\//i, "http://");
    }
    function isDesktopBrowser() {
        var ua = navigator.userAgent || "";
        // Сначала исключаем телевизоры, даже если их UA содержит Linux.
        if (/webOS|Web0S|NetCast|Tizen|SmartTV|SMART-TV|HbbTV|BRAVIA|Viera|Roku|AppleTV|AFT[A-Z0-9]*|Android TV|Google TV/i.test(ua)) {
            return false;
        }
        return /Windows NT|Macintosh|Mac OS X|X11|Linux x86_64|CrOS/i.test(ua) &&
            !/Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    }
    function isHlsURL(url) {
        return /\.m3u8(?:[?#]|$)/i.test(String(url || ""));
    }
    function getHlsJsURL(url) {
        url = String(url || "");
        // Только для HTTPS-приложения.
        if (window.location.protocol === "https:") {
            return url.replace(/^http:\/\//i, "https://");
        }
        return url;
    }
    function canUseHlsJs() {
        var mse = window.MediaSource || window.WebKitMediaSource;
        return isDesktopBrowser() && !!mse &&
            typeof window.Promise === "function" &&
            typeof window.Map === "function" &&
            typeof window.Set === "function";
    }
    // Общая загрузка скрипта; одновременно не вставляем два script.
    function loadHlsJs(callback) {
        if (window.Hls && typeof window.Hls.isSupported === "function") {
            callback(window.Hls.isSupported());
            return;
        }
        if (hlsScriptPending) {
            hlsScriptPending.push(callback);
            return;
        }
        hlsScriptPending = [callback];
        var script = document.createElement("script");
        var completed = false;
        function done(ok) {
            var callbacks;
            var i;
            if (completed) { return; }
            completed = true;
            script.onload = null;
            script.onerror = null;
            callbacks = hlsScriptPending;
            hlsScriptPending = null;
            for (i = 0; i < callbacks.length; i++) {
                callbacks[i](ok);
            }
        }
        script.onload = function() {
            done(!!(window.Hls && window.Hls.isSupported &&
                window.Hls.isSupported()));
        };
        script.onerror = function() { done(false); };
        script.src = HLS_JS_URL;
        document.getElementsByTagName("head")[0].appendChild(script);
    }
    function destroyHls() {
        if (hlsInstance) {
            var old = hlsInstance;
            hlsInstance = null;
            try { old.destroy(); } catch (e) {}
        }
    }
    var LAST_CHANNEL_KEY = "tvaplay_last_channel_id";
    function saveLastChannel(channelId) {
        if (!channelId) {
            return;
        }
        try {
            window.localStorage.setItem(
                LAST_CHANNEL_KEY,
                String(channelId)
            );
        } catch (e) {
            // На старых TV localStorage может быть недоступен.
        }
    }
    function getLastChannel() {
        try {
            return window.localStorage.getItem(
                LAST_CHANNEL_KEY
            ) || "";
        } catch (e) {
            return "";
        }
    }
    function findChannelById(channelId) {
        var i;
        if (!channelId) {
            return null;
        }
        for (i = 0; i < channels.length; i++) {
            if (
                String(channels[i].id) === String(channelId) &&
                isFavoriteVisible(channels[i])
            ) {
                return channels[i];
            }
        }
        return null;
    }
    function parseAttribute(line, name) {
        var re = new RegExp(
            "(?:^|\\s)" + name + '="([^"]*)"',
            "i"
        );
        var match = line.match(re);
        return match ? match[1] : "";
    }
    function parsePlaylist(text) {
        var result = [];
        var lines = String(text || "")
            .replace(/\r/g, "")
            .split("\n");
        var info = null;
        var i;
        for (i = 0; i < lines.length; i++) {
            var line = $.trim(lines[i]);
            if (!line) {
                continue;
            }
            if (line.indexOf("#EXTINF:") === 0) {
                var comma = line.indexOf(",");
                if (comma === -1) {
                    info = null;
                    continue;
                }
                info = {
                    name: $.trim(line.substring(comma + 1)),
                    id: parseAttribute(line, "tvg-id"),
                    logo: parseAttribute(line, "tvg-logo"),
                    group: parseAttribute(line, "group-title"),
                    catchupDays: parseInt(
                        parseAttribute(line, "catchup-days"), 10
                    ) || 0,
                    catchupType: parseAttribute(line, "catchup-type")
                };
                if (!info.name) {
                    info.name = parseAttribute(
                        line, "tvg-name"
                    );
                }
                continue;
            }
            if (line.charAt(0) === "#") {
                continue;
            }
            if (!info) {
                continue;
            }
            // Не выполняем произвольные URL-схемы.
            // Поддерживаем абсолютные HTTP(S) и
            // относительные пути нашего сервера.
            if (!/^https?:\/\//i.test(line) &&
                line.charAt(0) !== "/") {
                info = null;
                continue;
            }
            info.url = line;
            if (!info.name) {
                info.name = t("common.channel_number", {number: result.length + 1});
            }
            result.push(info);
            info = null;
        }
        return result;
    }
    function stopVideo() {
        destroyHls();
        if (!activeVideo) {
            return;
        }
        // Сбрасываем ссылку до load(), чтобы не показывать
        // ошибки при намеренной остановке старого потока.
        var video = activeVideo;
        activeVideo = null;
        try {
            video.pause();
            video.removeAttribute("src");
            video.load();
        } catch (e) {}
    }
    function showPlaybackError($page, message) {
        if (playbackErrorShown) {
            return;
        }
        playbackErrorShown = true;
        if (playerLoader) {
            playerLoader.hide();
        }
        $page.find(".tv-player-status").text("");
        app.snackbar.show(
            message,
            "error",
            true
        );
    }

// Корректное отображение видео в полноэкранном режиме.
function applyFullscreenVideoStyle() {
    if (!fullscreenBox) {
        return;
    }

    var $video = fullscreenBox.find(".tv-player-video");

    var screenWidth = window.innerWidth ||
        document.documentElement.clientWidth;

    var screenHeight = window.innerHeight ||
        document.documentElement.clientHeight;

    if (!screenWidth || !screenHeight) {
        return;
    }

    $video.css({
        "position": "fixed",
        "left": "0",
        "top": "0",
        "right": "auto",
        "bottom": "auto",
        "width": screenWidth + "px",
        "height": screenHeight + "px",
        "max-width": "none",
        "max-height": "none",
        "margin": "0",
        "padding": "0",
        "-webkit-transform": "none",
        "transform": "none",
        "object-fit": "fill"
    });
}



function onFullscreenResize() {
    applyFullscreenVideoStyle();
}




function onPlayerFullscreenKey(event) {
    if (!fullscreenBox) {
        return;
    }

    event = event || window.event;

    var code = event.which || event.keyCode;
    var key = event.key || "";

    var isLeft = code === 37 || key === "ArrowLeft";
    var isRight = code === 39 || key === "ArrowRight";
    var isEnter = code === 13 ||
        key === "Enter" ||
        key === "OK";

    // Архив: перемотка и пауза.
    if (archivePlayingURL && activeVideo) {
        if (isLeft || isRight || isEnter) {
            stopArchiveKeyEvent(event);

            if (isEnter) {
                if (activeVideo.paused || activeVideo.ended) {
                    try {
                        var promise = activeVideo.play();

                        if (promise &&
                            typeof promise.catch === "function") {
                            promise.catch(function() {});
                        }
                    } catch (e) {}
                } else {
                    try {
                        activeVideo.pause();
                    } catch (e) {}
                }
            } else {
                seekFullscreenArchive(
                    isLeft ? -10 : 10
                );
            }

            showFullscreenArchiveSeekbar();
            updateFullscreenArchiveProgress();

            return;
        }
    }

    // Остальные клавиши закрывают полноэкранный режим.
    stopArchiveKeyEvent(event);
    exitPlayerFullscreen();
}





    // Отложенный индикатор для перемотки архива. Быстрые seeks не мигают.
    // Тот же playerLoader, что используется для первоначальной загрузки.
    function stopArchiveSeekBuffering() {
        ++archiveSeekBufferGeneration;
        if (archiveSeekBufferTimer !== null) {
            clearTimeout(archiveSeekBufferTimer);
            archiveSeekBufferTimer = null;
        }
        if (archiveSeekBufferShown && playerLoader) {
            playerLoader.hide();
        }
        archiveSeekBufferShown = false;
        archiveSeekBufferPending = false;
    }

    function beginArchiveSeekBuffering(video) {
        if (!archivePlayingURL || activeVideo !== video) { return; }
        archiveSeekBufferPending = true;
        if (archiveSeekBufferTimer !== null || archiveSeekBufferShown) { return; }

        var generation = archiveSeekBufferGeneration;
        var attempt = playbackAttempt;
        archiveSeekBufferTimer = setTimeout(function() {
            archiveSeekBufferTimer = null;
            if (generation !== archiveSeekBufferGeneration ||
                attempt !== playbackAttempt || !archiveSeekBufferPending ||
                activeVideo !== video || !archivePlayingURL) {
                return;
            }
            // Если данные уже готовы, не показываем кратковременную задержку.
            if (!video.seeking && video.readyState >= 3) {
                finishArchiveSeekBuffering(video);
                return;
            }
            archiveSeekBufferShown = true;
            if (playerLoader) {
                playerLoader.show(t("player.archive_buffering"));
            }
        }, 350);
    }

    function finishArchiveSeekBuffering(video) {
        if (!archiveSeekBufferPending || activeVideo !== video) { return; }
        // seeked может приходить до загрузки кадров в новом месте.
        if (video.seeking || video.readyState < 3) { return; }
        var wasShown = archiveSeekBufferShown;
        stopArchiveSeekBuffering();
        if (wasShown) {
            var $page = $(video).closest(".tv-player-page");
            $page.find(".tv-player-status").text("");
        }
    }

    function fullscreenArchiveDuration(video) {
        if (!video) { return 0; }
        if (isFinite(video.duration) && video.duration > 0) {
            return video.duration;
        }
        return archiveProgrammeDuration(archivePlayingProgramme);
    }

    function seekFullscreenArchive(delta) {
        showFullscreenArchiveSeekbar();
        var video = activeVideo;
        if (!video || !archivePlayingURL) { return; }

        var duration = fullscreenArchiveDuration(video);
        var current = Number(video.currentTime) || 0;
        var target = Math.max(0, current + delta);
        if (duration > 0) {
            // Не доходим до самого конца при перемотке — там срабатывает автопереход.
            target = Math.min(target, Math.max(0, duration - 0.25));
        }

        // Для HLS VOD перемотка доступна только внутри загруженного seekable.
        try {
            if (video.seekable && video.seekable.length) {
                var lower = video.seekable.start(0);
                var upper = video.seekable.end(video.seekable.length - 1);
                target = Math.max(lower, Math.min(target, Math.max(lower, upper - 0.25)));
            }
            if (Math.abs(target - current) >= 0.25) {
                beginArchiveSeekBuffering(video);
                video.currentTime = target;
            }
        } catch (e) {
            finishArchiveSeekBuffering(video);
        }
    }

    function updateFullscreenArchiveProgress() {
        if (!fullscreenBox || !archivePlayingURL || !activeVideo) { return; }
        var video = activeVideo;
        var duration = fullscreenArchiveDuration(video);
        var current = Math.max(0, Number(video.currentTime) || 0);
        var percent = duration > 0 ? Math.min(100, current * 100 / duration) : 0;
        var $bar = fullscreenBox.find(".tv-archive-seekbar");
        $bar.find(".tv-archive-seekbar-fill").css("width", percent + "%");
        $bar.find(".tv-archive-seekbar-clock").text(
            archiveDurationText(current) + " / " + archiveDurationText(duration)
        );
        $bar.find(".tv-archive-seekbar-state").text(video.paused ? "▶" : "Ⅱ");
        $bar.find(".tv-archive-seekbar-title").text(
            archivePlayingProgramme ? (archivePlayingProgramme.title || t("common.no_title")) : ""
        );
        $bar.attr("aria-valuenow", Math.round(percent));
    }

    // Прогресс-бар архива скрывается через 5 секунд воспроизведения.
    // На паузе остаётся видимым независимо от времени ожидания.
    function cancelFullscreenArchiveSeekbarHide() {
        if (archiveSeekbarHideTimer !== null) {
            clearTimeout(archiveSeekbarHideTimer);
            archiveSeekbarHideTimer = null;
        }
    }

    function scheduleFullscreenArchiveSeekbarHide() {
        cancelFullscreenArchiveSeekbarHide();
        if (!fullscreenBox || !archivePlayingURL || !activeVideo ||
            activeVideo.paused || activeVideo.ended || activeVideo.seeking) {
            return;
        }
        var box = fullscreenBox;
        var video = activeVideo;
        archiveSeekbarHideTimer = setTimeout(function() {
            archiveSeekbarHideTimer = null;
            if (fullscreenBox === box && activeVideo === video &&
                archivePlayingURL && !video.paused && !video.seeking &&
                !video.ended) {
                box.removeClass("tv-player-archive-seekbar-visible");
            }
        }, 5000);
    }

    function showFullscreenArchiveSeekbar() {
        cancelFullscreenArchiveSeekbarHide();
        if (!fullscreenBox || !archivePlayingURL) { return; }
        fullscreenBox.addClass("tv-player-archive-seekbar-visible");
        updateFullscreenArchiveProgress();
        scheduleFullscreenArchiveSeekbarHide();
    }

    function updateFullscreenArchiveMode() {
        if (!fullscreenBox) { return; }
        fullscreenBox.toggleClass("tv-player-archive-fullscreen", !!archivePlayingURL);
        if (archivePlayingURL) {
            showFullscreenArchiveSeekbar();
        } else {
            cancelFullscreenArchiveSeekbarHide();
            fullscreenBox.removeClass("tv-player-archive-seekbar-visible");
        }
        updateFullscreenArchiveProgress();
    }

    function enterPlayerFullscreen($videoBox) {
        if (fullscreenBox) {
            return;
        }

        fullscreenBox = $videoBox;

        $videoBox.addClass("tv-player-fullscreen");

        // Применяем корректную геометрию видео.
        applyFullscreenVideoStyle();

        updateFullscreenArchiveMode();

        window.addEventListener(
            "resize",
            onFullscreenResize,
            false
        );

        window.addEventListener(
            "keydown",
            onPlayerFullscreenKey,
            true
        );
    }

    // Возвращаем обычный интерфейс, не останавливая воспроизведение.
    function exitPlayerFullscreen() {
        if (!fullscreenBox) {
            return;
        }
        var $box = fullscreenBox;

        window.removeEventListener(
            "resize",
            onFullscreenResize,
            false
        );

        // Возвращаем оформление видео из основного CSS.
        $box.find(".tv-player-video").css({
            "position": "",
            "left": "",
            "top": "",
            "right": "",
            "bottom": "",
            "width": "",
            "height": "",
            "max-width": "",
            "max-height": "",
            "margin": "",
            "padding": "",
            "-webkit-transform": "",
            "transform": "",
            "object-fit": ""
        });

        cancelFullscreenArchiveSeekbarHide();
        fullscreenBox = null;
        window.removeEventListener("keydown", onPlayerFullscreenKey, true);
        $box.removeClass("tv-player-fullscreen tv-player-archive-fullscreen " +
            "tv-player-archive-seekbar-visible");
        $box.find(".tv-player-fullscreen-button")
            .text("⛶")
            .attr("title", t("player.fullscreen"))
            .attr("aria-label", t("player.fullscreen"));
    }

    // CSS внедряем из модуля, чтобы не требовать изменения общего CSS TVAPLAY.
    function ensureArchiveSeekbarStyles() {
        if (document.getElementById("tvaplay-archive-seekbar-style")) { return; }
        var style = document.createElement("style");
        style.id = "tvaplay-archive-seekbar-style";
        style.type = "text/css";
        style.appendChild(document.createTextNode(
            ".tv-archive-seekbar{display:none;position:absolute;left:4%;right:4%;bottom:26px;" +
            "z-index:120;color:#fff;font-family:Arial,sans-serif;" +
            "background:rgba(0,0,0,.72);border-radius:9px;padding:14px 18px 16px;" +
            "box-sizing:border-box;pointer-events:auto;}" +
            ".tv-player-fullscreen.tv-player-archive-fullscreen.tv-player-archive-seekbar-visible .tv-archive-seekbar{display:block;}" +
            ".tv-archive-seekbar-top{display:-webkit-flex;display:flex;" +
            "-webkit-justify-content:space-between;justify-content:space-between;" +
            "-webkit-align-items:center;align-items:center;margin-bottom:12px;" +
            "font-size:19px;font-weight:bold;position:relative;}" +
            ".tv-archive-seekbar-state,.tv-archive-seekbar-clock{" +
            "position:relative;z-index:1;flex-shrink:0;}" +
            ".tv-archive-seekbar-title{" +
            "position:absolute;left:55px;right:130px;top:50%;" +
            "-webkit-transform:translateY(-50%);transform:translateY(-50%);" +
            "text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
            "font-size:18px;font-weight:normal;pointer-events:none;}" +
            ".tv-archive-seekbar-track{height:10px;border-radius:9px;" +
            "background:rgba(255,255,255,.32);overflow:hidden;cursor:pointer;}" +
            ".tv-archive-seekbar-fill{width:0;height:100%;background:#ff3b4a;border-radius:9px;}" +
            ".tv-archive-seekbar-hint{font-size:13px;opacity:.8;margin-top:9px;}"
        ));
        document.getElementsByTagName("head")[0].appendChild(style);
    }

function playChannel(channel, $page, archiveOptions) {
        var $video = $page.find(".tv-player-video");
        var video = $video.get(0);
        if (!video || !channel) {
            return;
        }
       var attempt = ++playbackAttempt;
       var archiveURL = archiveOptions && archiveOptions.url;
       var streamURL = archiveURL || channel.url;

       playbackErrorShown = false;
        archiveAutoAdvancePending = false;
        stopArchiveTimer();
        stopArchiveSeekBuffering();
        cancelFullscreenArchiveSeekbarHide();
        // Таймер виден только у воспроизводимой архивной передачи.
        // При смене записи скрываем предыдущий, не оставляя отсчёт в других строках.
        $page.find(".tv-archive-programme-timer").hide();
        stopVideo();
       selectedURL = channel.url;
       archivePlayingURL = archiveURL || null;
       archivePlayingProgramme = archiveOptions ? archiveOptions.programme : null;
       updateFullscreenArchiveMode();

       activeVideo = video;
       if (archiveURL) {
           $page.find(".tv-archive-programme-active")
               .find(".tv-archive-programme-timer").show();
       }
       startArchiveTimer($page);
        // Запоминаем выбранный телеканал.
       if (!archiveURL) {
           saveLastChannel(channel.id);
       }
        $page.find(".tv-channel-button")
            .removeClass("tv-channel-playing")
            .removeAttr("aria-current");
        $page.find(".tv-channel-button").filter(function() {
            return $(this).attr("data-url") === channel.url;
        })
            .addClass("tv-channel-playing")
            .attr("aria-current", "true");
        // При переключении канала сразу очищаем старый постер,
        // описание и обновляем информацию о новой передаче.
        updatePlayerEPG($page);
        $page.find(".tv-player-status")
            .text(t("player.connecting"));
        if (playerLoader) {
            playerLoader.show(t("player.connecting"));
        }
        function stillActive() {
            return attempt === playbackAttempt &&
                activeVideo === video &&
               selectedURL === channel.url &&
               archivePlayingURL === (archiveURL || null);
        }
        function startVideo() {
            var promise;
            if (!stillActive()) { return; }
            try {
                promise = video.play();
                if (promise && typeof promise.catch === "function") {
                    promise.catch(function() {
                        if (stillActive()) {
                            showPlaybackError(
                                $page,
                                t("player.start_error")
                            );
                        }
                    });
                }
            } catch (e) {
                if (stillActive()) {
                    showPlaybackError($page, t("player.video_error"));
                }
            }
        }
        function startNative() {
            if (!stillActive()) {
                return;
            }
            // Smart TV: HTTP для прямого эфира и архива.
            var url = getNativeURL(streamURL);
            console.log("[TVAPLAY] Native HLS:", url);
            video.src = url;
            video.load();
            startVideo();
        }
        // На телевизорах используем строго прежний нативный HLS.
       if (!isHlsURL(streamURL) || !canUseHlsJs()) {
            startNative();
            return;
        }
        loadHlsJs(function(supported) {
            var hls;
            if (!stillActive()) { return; }
            if (!supported) {
                // Например, библиотека не загрузилась: пробуем native.
                startNative();
                return;
            }
            try {
                hls = new window.Hls();
                hlsInstance = hls;
                hls.on(window.Hls.Events.MEDIA_ATTACHED, function() {
                    if (stillActive() && hlsInstance === hls) {
                       hls.loadSource(getHlsJsURL(streamURL));
                    }
                });
                hls.on(window.Hls.Events.MANIFEST_PARSED, function() {
                    if (stillActive() && hlsInstance === hls) {
                        startVideo();
                    }
                });
                hls.on(window.Hls.Events.ERROR, function(event, data) {
                    if (!stillActive() || hlsInstance !== hls ||
                        !data || !data.fatal) {
                        return;
                    }
                    showPlaybackError($page, t("player.hls_error", {
                        details: data.details || data.type || t("player.unknown_error")
                    }));
                });
                hls.attachMedia(video);
            } catch (e) {
                destroyHls();
                if (stillActive()) {
                    startNative();
                }
            }
        });
    }
    function updatePlayerEPG($page) {
        var $title = $page.find(".tv-player-channel-title");
        var $description = $page.find(".tv-player-programme-description");
        var $poster = $page.find(".tv-player-programme-poster");
        var channel = null;
        var programme = null;
        var i;
        // Определяем телеканал, который сейчас выбран.
        for (i = 0; i < channels.length; i++) {
            if (channels[i].url === selectedURL) {
                channel = channels[i];
                break;
            }
        }
        if (!channel) {
            $title.text(t("player.no_channel"));
            $description.text("");
            $poster.css("background-image", "none");
            return;
        }
        // Получаем текущую передачу из EPG.
       if (archivePlayingProgramme) {
           programme = archivePlayingProgramme;
       } else if (channel.id && app.epg) {
           programme = app.epg.get(channel.id);
       }
        // По умолчанию показываем название телеканала.
       var title = archivePlayingProgramme
           ? t("player.archive_channel", {name: channel.name})
           : channel.name;
        // Если известно время начала — показываем HH:MM.
        if (programme && programme.start) {
            var startTime = new Date(Number(programme.start));
            if (!isNaN(startTime.getTime())) {
                var hours = startTime.getHours();
                var minutes = startTime.getMinutes();
                title =
                    (hours < 10 ? "0" : "") + hours + ":" +
                    (minutes < 10 ? "0" : "") + minutes;
            }
        }
        if (programme) {
            if (programme.title) {
                title += " — " + programme.title;
            }
            // Возрастной рейтинг, если указан в EPG.
            if (
                programme.rating !== null &&
                programme.rating !== undefined &&
                String(programme.rating) !== ""
            ) {
                title += " (" + programme.rating + ")";
            }
            $description.text(programme.description || "");
            // Постер текущей передачи.
            var icon = String(programme.icon || "");
            if (
                /^https?:\/\//i.test(icon) ||
                (icon.charAt(0) === "/" &&
                icon.charAt(1) !== "/")
            ) {
                // Убираем опасные символы для CSS url().
                icon = icon.replace(/["\\\r\n]/g, "");
                $poster.css(
                    "background-image",
                    'url("' + icon + '")'
                );
            } else {
                $poster.css("background-image", "none");
            }
        } else {
            $description.text("");
            $poster.css("background-image", "none");
        }
        $title.text(title);
    }
    function updateEPG($page) {
        $page.find(".tv-channel-button").each(function() {
            var $button = $(this);
            var channelId = $button.attr("data-channel-id");
            var programme = app.epg.get(channelId);
            var $title = $button.find(".tv-channel-programme");
            var $bar = $button.find(".tv-channel-epg-progress-bar");
            $title.text(programme ? programme.title : "");
            $bar.css(
                "width",
                programme
                    ? app.epg.getProgress(channelId) + "%"
                    : "0%"
            );
        });
        // Обновляем информацию под видеоплеером.
        updatePlayerEPG($page);
    }
    function stopEPG() {
        if (epgTimer !== null) {
            clearInterval(epgTimer);
            epgTimer = null;
        }
    }
    function startEPG($page, version) {
        stopEPG();
        function tick() {
            if (version !== pageVersion) { return; }
            updateEPG($page);
            app.epg.load().done(function() {
                if (version === pageVersion) { updateEPG($page); }
            });
        }
        tick();
        epgTimer = setInterval(tick, 60000);
    }
    function isFavoriteVisible(channel) {
        if (!app.favorites) {
            return true;
        }
        return app.favorites.isVisible(channel.url);
    }
    function hasChannelArchive(channel) {
        return !!channel &&
            channel.catchupType === "tvaplay" &&
            channel.catchupDays > 0;
    }
    function archivePad(n) {
        return n < 10 ? "0" + n : String(n);
    }
    function archiveTime(ms) {
        var d = new Date(ms);
        return archivePad(d.getHours()) + ":" +
            archivePad(d.getMinutes());
    }
    function archiveDateParts(ms) {
        var d = new Date(ms);
        var weekdays = [];
        var months = [];
        var i;
        for (i = 0; i < 7; i++) {
            weekdays.push(t("date.weekdays.d" + i));
        }
        for (i = 0; i < 12; i++) {
            months.push(t("date.months.m" + i));
        }
        return {
            weekday: weekdays[d.getDay()],
            date: d.getDate() + " " + months[d.getMonth()]
        };
    }
    function archiveDate(ms) {
        var d = new Date(ms);
        return archivePad(d.getDate()) + "." +
            archivePad(d.getMonth() + 1) + "." +
            d.getFullYear();
    }
    function normalizeEPGTime(value) {
        var n = Number(value);
        if (!isFinite(n) || n <= 0) {
            return 0;
        }
        // Контракт EPG TVAPLAY: Unix milliseconds.
        return n;
    }
    // URL playlist.m3u is /live/<numeric-channel-id>/index.m3u8.
    // EPG channel.id (tvg-id) is a different identifier.
    function archiveNumericChannelID(channel) {
        var url = String(channel && channel.url || "");
        var match = /\/live\/(\d+)(?:\/|[?#]|$)/.exec(url);
        return match ? parseInt(match[1], 10) : 0;
    }

    function cancelArchivePlayRequest() {
        ++archivePlayGeneration;
        if (archivePlayXHR) {
            var xhr = archivePlayXHR;
            archivePlayXHR = null;
            xhr.abort();
        }
    }

    function findLiveChannel(url) {
        var i;
        for (i = 0; i < channels.length; i++) {
            if (channels[i].url === url) {
                return channels[i];
            }
        }
        return null;
    }

    // Duration (or remaining time) in HH:MM:SS; omit hours when zero.
    function archiveDurationText(seconds) {
        seconds = Math.max(0, Math.ceil(Number(seconds) || 0));
        var hours = Math.floor(seconds / 3600);
        var minutes = Math.floor((seconds % 3600) / 60);
        var rest = seconds % 60;
        return (hours ? archivePad(hours) + ":" : "") +
            archivePad(minutes) + ":" + archivePad(rest);
    }

    function archiveProgrammeDuration(programme) {
        var start = normalizeEPGTime(programme && programme.start);
        var stop = normalizeEPGTime(programme && programme.stop);
        return Math.max(0, (stop - start) / 1000);
    }

    // Only the currently playing programme counts down; the other rows
    // always display their full scheduled length.
    function updateArchiveTimer($page) {
        if (!$page || !archivePlayingProgramme || !archivePlayingURL ||
            !activeVideo) {
            return;
        }

        var $timer = $page.find(".tv-archive-programme-active")
            .find(".tv-archive-programme-timer");
        if (!$timer.length) {
            return;
        }

        var duration = archiveProgrammeDuration(archivePlayingProgramme);
        // VOD manifest may differ slightly from EPG programme boundaries.
        if (isFinite(activeVideo.duration) && activeVideo.duration > 0) {
            duration = activeVideo.duration;
        }
        var position = Number(activeVideo.currentTime) || 0;
        var remaining = activeVideo.ended ? 0 : Math.max(0, duration - position);
        var text = archiveDurationText(remaining);
        if ($timer.text() !== text) {
            $timer.text(text);
        }

        // On reaching 00:00, continue with the next recorded EPG programme.
        // Ignore missing metadata or an unloaded/zero-length video.
        if (remaining <= 0 && duration > 0 &&
            (activeVideo.ended || (position > 0 && !activeVideo.seeking))) {
            advanceArchiveProgramme($page);
        }
    }

    // The archive list is newest-first. Select the chronologically nearest
    // completed programme after the one currently being played.
    function advanceArchiveProgramme($page) {
        if (archiveAutoAdvancePending || !archiveChannel ||
            archivePage !== $page || !archivePlayingProgramme ||
            !archivePlayingURL || !activeVideo) {
            return;
        }

        var currentStart = normalizeEPGTime(archivePlayingProgramme.start);
        var nextStart = Infinity;
        var nextProgramme = null;
        var $nextButton = null;
        var now = new Date().getTime();

        $page.find(".tv-archive-programme").each(function() {
            var programme = $(this).data("archiveProgramme");
            if (!programme || !programme.id) {
                return;
            }

            var start = normalizeEPGTime(programme.start);
            var stop = normalizeEPGTime(programme.stop);
            if (start <= currentStart || start >= nextStart ||
                stop <= start || stop > now) {
                return;
            }

            nextStart = start;
            nextProgramme = programme;
            $nextButton = $(this);
        });

        // No more finished, recorded programmes in the loaded archive list.
        if (!nextProgramme || !$nextButton) {
            return;
        }

        // Prevent repeated triggers from timeupdate, ended and setInterval.
        archiveAutoAdvancePending = true;
        startArchiveProgramme(nextProgramme, $nextButton);
    }

    function stopArchiveTimer() {
        if (archiveTimerInterval !== null) {
            clearInterval(archiveTimerInterval);
            archiveTimerInterval = null;
        }
    }

    function startArchiveTimer($page) {
        stopArchiveTimer();
        if (!archivePlayingURL) {
            return;
        }
        updateArchiveTimer($page);
        archiveTimerInterval = setInterval(function() {
            updateArchiveTimer($page);
        }, 1000);
    }

    // Click / ENTER on the archive programme.
    function startArchiveProgramme(programme, $button) {
        if (!archiveChannel || !archivePage || !programme || !programme.id) {
            return;
        }

        var channel = archiveChannel;
        var $page = archivePage;

        // Повторное ENTER/клик по уже воспроизводимой записи:
        // только полный экран, без запроса API и перезапуска HLS.
        if (archivePlayingURL && activeVideo && archivePlayingProgramme &&
            String(archivePlayingProgramme.id) === String(programme.id)) {
            var $videoBox = $page.find(".tv-player-screen");
            if (!$videoBox.hasClass("tv-player-fullscreen")) {
                enterPlayerFullscreen($videoBox);
            }
            return;
        }

        var channelID = archiveNumericChannelID(channel);
        var token = app.api.getToken();
        var version = pageVersion;

        if (!channelID) {
            app.snackbar.show(t("player.archive_invalid_channel_id"), "error", true);
            return;
        }
        if (!token) {
            app.snackbar.show(t("common.auth_required"), "error", true);
            return;
        }

        cancelArchivePlayRequest();
        var generation = archivePlayGeneration;
        $page.find(".tv-player-status").text(t("player.archive_preparing"));
        if (playerLoader) {
            playerLoader.show(t("player.archive_preparing"));
        }

        archivePlayXHR = $.ajax({
            url: "/api/archive/play",
            type: "POST",
            contentType: "application/json; charset=utf-8",
            dataType: "json",
            headers: { Authorization: "Bearer " + token },
            data: JSON.stringify({
                channel_id: channelID,
                programme_id: Number(programme.id)
            }),
            cache: false,
            timeout: 15000
        }).done(function(data) {
            if (version !== pageVersion ||
                generation !== archivePlayGeneration ||
                archiveChannel !== channel || archivePage !== $page) {
                return;
            }
            if (!data || data.status !== "OK" ||
                typeof data.url !== "string" ||
                data.url.indexOf("/archive/") !== 0) {
                app.snackbar.show(t("player.archive_invalid_url"), "error", true);
                $page.find(".tv-player-status").text("");
                if (playerLoader) { playerLoader.hide(); }
                return;
            }

            // Remember Live stream only when archive playback starts first time.
            if (!archivePlayingURL) {
                archivePreviousLiveChannel = findLiveChannel(selectedURL);
            }

            $page.find(".tv-archive-programme-active")
                .removeClass("tv-archive-programme-active");
            $button.addClass("tv-archive-programme-active");

            playChannel(channel, $page, {
                url: data.url,
                programme: programme
            });
            $button.focus();
        }).fail(function(xhr, status) {
            if (status === "abort" || version !== pageVersion ||
                generation !== archivePlayGeneration) {
                return;
            }
            var response = xhr && xhr.responseJSON;
            var message = response && response.message ||
                t("player.archive_start_error");
            app.snackbar.show(message, "error", true);
            $page.find(".tv-player-status").text("");
            if (playerLoader) { playerLoader.hide(); }
        }).always(function() {
            if (generation === archivePlayGeneration) {
                archivePlayXHR = null;
            }
        });
    }

    function renderArchiveProgrammes($page, programmes, from, to) {
        var $list = $page.find(".tv-archive-list");
        var items = [];
        var i;
        var p;
        var start;
        var stop;
        var currentDate = "";
        $list.empty();
        for (i = 0; i < programmes.length; i++) {
            p = programmes[i];
            start = normalizeEPGTime(p.start);
            stop = normalizeEPGTime(p.stop);
            if (!start || !stop || stop <= start) {
                continue;
            }
            // Передача пересекается с периодом архива.
            if (stop <= from || start >= to) {
                continue;
            }
            items.push(p);
        }
        // Последние передачи показываем первыми.
        items.sort(function(a, b) {
            return Number(b.start) - Number(a.start);
        });
        if (!items.length) {
            $('<div class="tv-player-message"></div>')
                .text(t("player.archive_no_programmes"))
                .appendTo($list);
            return;
        }
        for (i = 0; i < items.length; i++) {
            p = items[i];
            start = Number(p.start);
            stop = Number(p.stop);
            var date = archiveDateParts(start);
            var dateKey = archiveDate(start);
            if (dateKey !== currentDate) {
                currentDate = dateKey;
                var $dateRow = $('<div>', {
                    "class": "tv-archive-date"
                }).appendTo($list);
                // День недели слева.
                $('<span></span>')
                    .text(date.weekday)
                    .appendTo($dateRow);
                // Число и месяц справа.
                $('<span></span>')
                    .text(date.date)
                    .appendTo($dateRow);
            }
            var $item = $('<button>', {
                type: "button",
                "class": "tv-archive-programme",
                "data-focus-id": "archive-" + i
            }).appendTo($list);
            // Keep the original EPG data for automatic chronological playback.
            $item.data("archiveProgramme", p);
            var $row = $('<div>', {
                "class": "tv-archive-programme-row"
            }).appendTo($item);
            // Время начала.
            $('<span>', {
                "class": "tv-archive-programme-time",
                text: archiveTime(start)
            }).appendTo($row);
            // Название передачи.
            $('<span>', {
                "class": "tv-archive-programme-title",
                text: p.title || t("common.no_title")
            }).css({
                "flex": "1 1 auto",
                "min-width": "0"
            }).appendTo($row);

            // Duration stays pinned to the right, even for long titles.
            $row.css({ "display": "flex", "align-items": "center" });
            var durationText = archiveDurationText((stop - start) / 1000);
            $('<span>', {
                "class": "tv-archive-programme-timer",
                "data-duration": durationText,
                text: durationText
            }).css({
                "display": "none",
                "color": "#f44336",
                "font-weight": "700",
                "white-space": "nowrap",
                "flex": "0 0 auto",
                "margin-left": "auto",
                "padding-left": "10px",
                "font-variant-numeric": "tabular-nums"
            }).appendTo($row);
            // Расширенное описание, скрыто по умолчанию.
           if (p.description) {

               $('<div>', {

                   "class": "tv-archive-programme-description",

                   text: p.description

               }).appendTo($item);

           }

           // Buttons already translate ENTER into click.
           (function(programme, $button) {
               $button.on("click", function(event) {
                   event.preventDefault();
                   startArchiveProgramme(programme, $button);
               });
           })(p, $item);
        }
        $list.find(".tv-archive-programme").first().focus();
    }

    function destroyArchiveLoader() {
        if (archiveLoader) {
            archiveLoader.destroy();
            archiveLoader = null;
        }
    }

    function openChannelArchive(channel, $page, $button) {
        if (!hasChannelArchive(channel) || archiveChannel) {
            return;
        }
        // Не открываем архив поверх полноэкранного видео.
        if (fullscreenBox) {
            return;
        }
        archiveChannel = channel;
        archivePage = $page;
        archiveReturnFocus = $button;
        var $sidebar = $page.find(".tv-player-sidebar");
        $sidebar.find(".tv-channel-heading").hide();
        $sidebar.find(".tv-channel-list").hide();
        var $archive = $('<div>', {
            "class": "tv-archive-panel"
        }).appendTo($sidebar);
        var $heading = $('<div>', {
            "class": "tv-archive-heading"
        }).appendTo($archive);
        // Слева только название телеканала.
        $('<span>', {
            "class": "tv-archive-heading-title",
            text: channel.name
        }).appendTo($heading);
        // Справа срок хранения архива.
        $('<span>', {
            "class": "tv-archive-period",
            text: t("player.archive_days", {days: channel.catchupDays})
        }).appendTo($heading);
        var $list = $('<div>', {
            "class": "tv-archive-list"
        }).appendTo($archive);
        // При переходе на другую передачу
        // закрываем ранее раскрытое описание.
        $list.on("focusin", ".tv-archive-programme", function() {
            $list.find(".tv-archive-programme-expanded")
                .not(this)
                .removeClass("tv-archive-programme-expanded");
        });
        // Период, разрешённый playlist.m3u.
        var to = new Date().getTime();
        var from = to -
            channel.catchupDays * 24 * 60 * 60 * 1000;
        if (!channel.id) {
            $list.text(t("player.archive_no_epg_id"));
            return;
        }
        var token = app.api.getToken();
        if (!token) {
            $list.text(t("player.archive_no_auth"));
            return;
        }
        var version = pageVersion;

        // Создаём отдельный лоадер внутри списка архива.
        destroyArchiveLoader();

        archiveLoader = app.loader.create($list);
        archiveLoader.show(t("player.archive_loading"));

        var currentArchiveLoader = archiveLoader;

        archiveXHR = $.ajax({
            url: "/api/epg/archive",
            type: "GET",
            data: {
                channel_id: channel.id,
                from: from,
                to: to
            },
            headers: {
                Authorization: "Bearer " + token
            },
            dataType: "json",
            timeout: 15000,
            cache: false
        })
        .done(function(data) {
            // Защита от ответа после закрытия панели.
            if (
                version !== pageVersion ||
                archiveChannel !== channel ||
                archivePage !== $page
            ) {
                return;
            }
            if (!data || !$.isArray(data.programmes)) {
                $list.text(t("player.archive_epg_error"));
                return;
            }
            renderArchiveProgrammes(
                $page,
                data.programmes,
                from,
                to
            );
            // When opened from the search page, start the requested programme.
            if (pendingSearchArchive &&
                archiveNumericChannelID(channel) === Number(pendingSearchArchive.channel_id)) {
                var wantedID = String(pendingSearchArchive.id);
                var $wanted = $list.find(".tv-archive-programme").filter(function() {
                    var item = $(this).data("archiveProgramme");
                    return item && String(item.id) === wantedID;
                }).first();
                pendingSearchArchive = null;
                if ($wanted.length) {
                    startArchiveProgramme($wanted.data("archiveProgramme"), $wanted);
                } else {
                    app.snackbar.show(t("player.archive_not_available"), "error", true);
                }
            }
        })
        .fail(function(xhr, status) {
            if (status === "abort" || archiveChannel !== channel) {
                return;
            }
            $list.text(
                t("player.archive_load_error", {
                    details: "HTTP " + (xhr ? xhr.status : 0)
                })
            );
        })
        .always(function() {
            // Убираем лоадер после успешной загрузки или ошибки.
            // Не затрагиваем лоадер другого запроса.
            if (archiveLoader === currentArchiveLoader) {
                destroyArchiveLoader();
            }

            if (archiveChannel === channel) {
                archiveXHR = null;
            }
        });
    }
function closeChannelArchive(restoreLive) {
       if (!archiveChannel) {
           return;
       }

       cancelArchivePlayRequest();
       var wasPlayingArchive = !!archivePlayingURL;
       var liveChannel = archivePreviousLiveChannel;
       archivePreviousLiveChannel = null;

       if (archiveXHR) {
            var xhr = archiveXHR;
            archiveXHR = null;
            xhr.abort();
        }
        // Удаляем лоадер при закрытии панели архива.
        destroyArchiveLoader();
        var $page = archivePage;
        var $focus = archiveReturnFocus;
        archiveChannel = null;
        archivePage = null;
        archiveReturnFocus = null;
        if (!$page) {
            return;
        }
        var $sidebar = $page.find(".tv-player-sidebar");
        $sidebar.find(".tv-archive-panel").remove();
        $sidebar.find(".tv-channel-heading").show();
        $sidebar.find(".tv-channel-list").show();
        // Возвращаем фокус на прежний телеканал.
       if (restoreLive !== false && wasPlayingArchive) {
           if (liveChannel) {
               playChannel(liveChannel, $page);
           } else {
               ++playbackAttempt;
               stopVideo();
               archivePlayingURL = null;
               archivePlayingProgramme = null;
               selectedURL = null;
               updatePlayerEPG($page);
           }
       }

       if ($focus && $focus.length) {
           $focus.focus();
       }

    }
    function onPlayerArchiveKey(event) {
        event = event || window.event;
        // Полноэкранное видео имеет приоритет.
        if (fullscreenBox) {
            return;
        }
        var code = event.which || event.keyCode;
        var key = event.key || "";
        var isRight = code === 39 || key === "ArrowRight";
        var isLeft = code === 37 || key === "ArrowLeft";
        var isRed =
            code === 403 ||
            key === "ColorF0Red" ||
            key === "Red";
        // Если открыт архив.
        // Если открыт архив.
        if (archiveChannel) {
            // Влево или красная кнопка — выход к каналам.
            if (isLeft || isRed) {
                stopArchiveKeyEvent(event);
                closeChannelArchive();
                return;
            }
            // Вправо — показать/скрыть описание передачи.
            if (isRight) {
                var $focused = $(document.activeElement)
                    .closest(".tv-archive-programme");
                if ($focused.length) {
                    stopArchiveKeyEvent(event);
                    var $description = $focused.find(
                        ".tv-archive-programme-description"
                    );
                    if ($description.length) {
                        $focused.toggleClass(
                            "tv-archive-programme-expanded"
                        );
                        if ($focused.hasClass("tv-archive-programme-expanded")) {
                            var container = $focused.closest(
                                ".tv-archive-list"
                            ).get(0);
                            var element = $focused.get(0);
                            if (container && element) {
                                // Прокрутка до нижней границы описания.
                                var bottom = element.offsetTop +
                                    element.offsetHeight;
                                var visibleBottom = container.scrollTop +
                                    container.clientHeight;
                                if (bottom > visibleBottom) {
                                    container.scrollTop += bottom - visibleBottom + 8;
                                }
                            }
                        }
                    }
                }
                return;
            }
            return;
        }
        // В обычном списке открываем архив
        // только по Вправо или красной кнопке.
        if (!isRight && !isRed) {
            return;
        }
        var target = event.target || document.activeElement;
        var $button = $(target).closest(".tv-channel-button");
        if (!$button.length) {
            return;
        }
        var url = $button.attr("data-url");
        var channel = null;
        var i;
        for (i = 0; i < channels.length; i++) {
            if (channels[i].url === url) {
                channel = channels[i];
                break;
            }
        }
        // Архив доступен только для каналов с записью.
        if (!hasChannelArchive(channel)) {
            return;
        }
        stopArchiveKeyEvent(event);
        openChannelArchive(
            channel,
            $button.closest(".tv-player-page"),
            $button
        );
    }
    function stopArchiveKeyEvent(event) {
        if (event.preventDefault) {
            event.preventDefault();
        }
        if (event.stopImmediatePropagation) {
            event.stopImmediatePropagation();
        } else if (event.stopPropagation) {
            event.stopPropagation();
        }
        event.cancelBubble = true;
        event.returnValue = false;
    }
    function renderChannels($page) {
        var $list = $page.find(".tv-channel-list");
        var $count = $page.find(".tv-channel-count");
        $list.empty();
        // Формируем список с учётом настроек избранного.
        var visibleChannels = [];
        var i;
        for (i = 0; i < channels.length; i++) {
            if (isFavoriteVisible(channels[i])) {
                visibleChannels.push(channels[i]);
            }
        }
        // Счётчик отображает фактически видимые каналы.
        $count.text(visibleChannels.length);
        if (!visibleChannels.length) {
            var message = channels.length
                ? t("player.favorites_empty")
                : t("player.playlist_empty");
            $('<p class="tv-player-message"></p>')
                .text(message)
                .appendTo($list);
            return;
        }
        $.each(visibleChannels, function(index, channel) {
            var $button = $('<button>', {
                type: "button",
                "class": "tv-channel-button",
                "data-focus-id": "channel-" + index,
                "data-url": channel.url,
                "data-channel-id": channel.id || ""
            }).appendTo($list);
            $('<span class="tv-channel-number"></span>')
                .text(index + 1)
                .appendTo($button);
            // Логотип телеканала из tvg-logo.
            var $logo = $('<span class="tv-channel-logo"></span>')
                .appendTo($button);
            if (channel.logo && /^(https?:\/\/|\/(?!\/))/i.test(channel.logo)) {
                $('<img>', {
                    src: channel.logo,
                    alt: "",
                    loading: "lazy"
                }).appendTo($logo);
            }
            var $details = $('<span class="tv-channel-details"></span>')
                .appendTo($button);
            var $nameRow = $('<span class="tv-channel-name-row"></span>')
                .appendTo($details);
            $('<span class="tv-channel-name"></span>')
                .text(channel.name)
                .appendTo($nameRow);
            if (channel.catchupDays > 0 &&
                channel.catchupType === "tvaplay") {
                $('<span class="tv-channel-record-dot"></span>')
                    .attr(
                        "title",
                        t("player.archive_days", {days: channel.catchupDays})
                    )
                    .appendTo($nameRow);
            }
            $('<span class="tv-channel-programme"></span>')
                .appendTo($details);
            var $progress = $('<span class="tv-channel-epg-progress"></span>')
                .appendTo($details);
            $('<span class="tv-channel-epg-progress-bar"></span>')
                .appendTo($progress);
            if (channel.url === selectedURL) {
                $button.addClass("tv-channel-playing");
            }
            $button.on("click", function(event) {
                event.preventDefault();
                // Повторное нажатие на уже активный канал:
                // разворачиваем видео без перезапуска потока.
                if (
                    channel.url === selectedURL &&
                    activeVideo !== null
                ) {
                    var $videoBox = $page.find(".tv-player-screen");
                    if (!$videoBox.hasClass("tv-player-fullscreen")) {
                        enterPlayerFullscreen($videoBox);
                    }
                    return;
                }
                // Выбран другой канал — обычное переключение.
                playChannel(channel, $page);
            });
        });
        // При первой загрузке предлагаем первый канал.
        // Автоматический старт видео не выполняем.
        $page.find(".tv-player-status")
            .text(t("player.select_channel"));
    }
    function loadPlaylist($page, version) {
        var token = app.api.getToken();
        if (!token) {
            $page.find(".tv-channel-list")
                .text(t("player.archive_no_auth"));
            return;
        }
        $page.find(".tv-channel-list")
            .text(t("player.loading_channels"));
        playlistXHR = $.ajax({
            url: "/playlist.m3u",
            type: "GET",
            headers: {
                Authorization: "Bearer " + token
            },
            dataType: "text",
            timeout: 15000,
            cache: false
        })
        .done(function(text) {
            if (version !== pageVersion) {
                return;
            }
            channels = parsePlaylist(text);
            renderChannels($page);
            startEPG($page, version);
            // Open the channel archive after a search-result selection.
            if (pendingSearchArchive) {
                var desiredChannel = null;
                for (var ci = 0; ci < channels.length; ci++) {
                    if (archiveNumericChannelID(channels[ci]) ===
                        Number(pendingSearchArchive.channel_id)) {
                        desiredChannel = channels[ci];
                        break;
                    }
                }
                if (desiredChannel && hasChannelArchive(desiredChannel)) {
                    var $desiredButton = $page.find(".tv-channel-button").filter(function() {
                        return $(this).attr("data-url") === desiredChannel.url;
                    }).first();
                    openChannelArchive(desiredChannel, $page, $desiredButton);
                    return;
                }
                pendingSearchArchive = null;
                app.snackbar.show(t("player.archive_channel_not_found"), "error", true);
            }
            // Восстанавливаем последний выбранный телеканал.
            var lastChannelId = getLastChannel();
            var lastChannel = findChannelById(lastChannelId);
            if (lastChannel) {
                playChannel(lastChannel, $page);
                var $channelButton = $page.find(
                    ".tv-channel-button"
                ).filter(function() {
                    return $(this).attr("data-channel-id") ===
                        String(lastChannelId);
                }).first();
                if ($channelButton.length) {
                    $channelButton.focus();
                }
            }
        })
        .fail(function(xhr, status) {
            if (version !== pageVersion ||
                status === "abort") {
                return;
            }
            var message = t("player.playlist_load_error");
            if (xhr && xhr.status === 401) {
                message = t("player.session_expired");
            } else if (xhr && xhr.status === 403) {
                message = t("player.playlist_forbidden");
            }
            $page.find(".tv-channel-list")
                .empty()
                .text(message);
        })
        .always(function() {
            if (version === pageVersion) {
                playlistXHR = null;
            }
        });
    }
    function show($root, params) {
        pendingSearchArchive = params && params.searchArchive ? params.searchArchive : null;
        var version = ++pageVersion;
        var $page = $('<div class="tv-player-page"></div>')
            .appendTo($root);
        var $screen = $('<div class="tv-player-main"></div>')
            .appendTo($page);
        var $videoBox = $('<div class="tv-player-screen"></div>')
            .appendTo($screen);
        var $video = $('<video>', {
            "class": "tv-player-video",
            autoplay: false,
            controls: false,
            preload: "none"
        }).appendTo($videoBox);
        playerLoader = app.loader.create($videoBox);
        var $fullscreenButton = $('<button>', {
            type: "button",
            "class": "tv-player-fullscreen-button",
            "aria-label": t("player.fullscreen"),
            title: t("player.fullscreen")
        }).text("⛶").appendTo($videoBox);
        ensureArchiveSeekbarStyles();
        var $seekbar = $('<div class="tv-archive-seekbar" role="progressbar" ' +
            'aria-label="' + t("player.archive_position") + '" aria-valuemin="0" aria-valuemax="100"></div>')
            .appendTo($videoBox);
        var $seekTop = $('<div class="tv-archive-seekbar-top"></div>')
            .appendTo($seekbar);
        $('<span class="tv-archive-seekbar-state"></span>').appendTo($seekTop);
        $('<span class="tv-archive-seekbar-title"></span>').appendTo($seekTop);
        $('<span class="tv-archive-seekbar-clock"></span>').appendTo($seekTop);
        var $seekTrack = $('<div class="tv-archive-seekbar-track"></div>')
            .appendTo($seekbar);
        $('<div class="tv-archive-seekbar-fill"></div>').appendTo($seekTrack);
        $('<div class="tv-archive-seekbar-hint"></div>')
            .text(t("player.archive_remote_help"))
            .appendTo($seekbar);
        // Мышью тоже можно перемотать, не выходя из полноэкранного режима.
        $seekbar.on("click", function(event) { event.stopPropagation(); });
        $seekTrack.on("click", function(event) {
            event.preventDefault();
            event.stopPropagation();
            if (!archivePlayingURL || !activeVideo) { return; }
            var rect = this.getBoundingClientRect();
            var duration = fullscreenArchiveDuration(activeVideo);
            if (rect.width > 0 && duration > 0) {
                var clientX = event.clientX;
                if (event.originalEvent && event.originalEvent.clientX !== undefined) {
                    clientX = event.originalEvent.clientX;
                }
                var fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                seekFullscreenArchive(fraction * duration - (Number(activeVideo.currentTime) || 0));
                updateFullscreenArchiveProgress();
            }
        });
        // Кнопка не должна запускать действия плеера повторно.
        $fullscreenButton.on("click", function(event) {
            event.preventDefault();
            event.stopPropagation();
            if ($videoBox.hasClass("tv-player-fullscreen")) {
                exitPlayerFullscreen();
            } else {
                enterPlayerFullscreen($videoBox);
            }
        });
        $videoBox.on("click", function(event) {
            if (!fullscreenBox) {
                return;
            }
            // Нажатие на саму кнопку уже обрабатывается отдельно.
            if ($(event.target).closest(
                ".tv-player-fullscreen-button"
            ).length) {
                return;
            }
            exitPlayerFullscreen();
        });
        // Информационный блок под видеоплеером.
        var $info = $('<div class="tv-player-info"></div>')
            .appendTo($screen);
        // Фоновый постер текущей передачи.
        $('<div class="tv-player-programme-poster"></div>')
            .appendTo($info);
        // Затемнение поверх постера.
        $('<div class="tv-player-info-overlay"></div>')
            .appendTo($info);
        // Контент поверх фонового изображения.
        var $infoContent = $('<div class="tv-player-info-content"></div>')
            .appendTo($info);
        // Канал — передача (рейтинг).
        $('<div class="tv-player-channel-title"></div>')
            .text(t("player.no_channel"))
            .appendTo($infoContent);
        // Описание передачи.
        $('<div class="tv-player-programme-description"></div>')
            .appendTo($infoContent);
        // Статус загрузки/буферизации.
        $('<div class="tv-player-status"></div>')
            .text(t("player.loading_playlist"))
            .appendTo($infoContent);
        var $sidebar = $('<div class="tv-player-sidebar"></div>')
            .appendTo($page);
        var $heading = $('<div class="tv-channel-heading"></div>')
            .appendTo($sidebar);
        // Заголовок зависит от режима избранного.
        var isFavoritesEnabled = app.favorites &&
            app.favorites.isEnabled();
        $('<span></span>')
            .text(
                isFavoritesEnabled
                    ? t("player.favorites")
                    : t("player.channels")
            )
            .appendTo($heading);
        $('<span class="tv-channel-count"></span>')
            .text("0")
            .appendTo($heading);
        $('<div class="tv-channel-list"></div>')
            .appendTo($sidebar);
        var video = $video.get(0);
        $video.on("loadstart", function() {
            if (activeVideo === video && playerLoader) {
                playerLoader.show(t("player.loading_channel"));
            }
        });
        $video.on("seeking", function() {
            if (activeVideo === video && archivePlayingURL) {
                beginArchiveSeekBuffering(video);
            }
        });
        $video.on("waiting stalled", function() {
            if (activeVideo !== video) { return; }
            if (archivePlayingURL && archiveSeekBufferPending) {
                // После перемотки ждём загрузку нового TS, но не мигаем.
                beginArchiveSeekBuffering(video);
            } else if (playerLoader && video.readyState < 3 && !video.paused) {
                // Старое поведение буферизации для Live и обычного старта.
                playerLoader.show(t("player.buffering"));
            }
        });
        $video.on("loadedmetadata durationchange timeupdate seeking seeked ended", function() {
            if (activeVideo === video) {
                updateArchiveTimer($page);
                updateFullscreenArchiveProgress();
            }
        });
        $video.on("seeked canplay canplaythrough playing timeupdate", function() {
            if (activeVideo === video) {
                finishArchiveSeekBuffering(video);
            }
        });
        $video.on("play pause", function() {
            if (activeVideo !== video) { return; }
            if (archivePlayingURL && fullscreenBox) {
                showFullscreenArchiveSeekbar();
            }
            updateFullscreenArchiveProgress();
        });
        $video.on("playing seeked", function() {
            if (activeVideo === video && archivePlayingURL && fullscreenBox) {
                showFullscreenArchiveSeekbar();
            }
        });
        $video.on("playing timeupdate", function() {
            if (activeVideo === video && !video.paused &&
                !video.seeking && video.readyState >= 3 &&
                !archiveSeekBufferPending) {
                if (playerLoader) {
                    playerLoader.hide();
                }
                $page.find(".tv-player-status").text("");
            }
        });
        $video.on("error", function() {
            if (activeVideo !== video) {
                return;
            }
            showPlaybackError(
                $page,
                t("player.play_error")
            );
        });
        // Перехват клавиш до навигации приложения.
        window.addEventListener(
            "keydown",
            onPlayerArchiveKey,
            true
        );
        // Для Samsung Tizen регистрируем красную кнопку.
        try {
            if (
                window.tizen &&
                window.tizen.tvinputdevice &&
                window.tizen.tvinputdevice.registerKey
            ) {
                window.tizen.tvinputdevice.registerKey(
                    "ColorF0Red"
                );
            }
        } catch (e) {
            // На других платформах регистрация не нужна
            // или не поддерживается.
        }
        loadPlaylist($page, version);
    }
    function hide() {
        pendingSearchArchive = null;
        window.removeEventListener(
            "keydown",
            onPlayerArchiveKey,
            true
        );
       closeChannelArchive(false);
       stopArchiveTimer();
       stopArchiveSeekBuffering();
       cancelFullscreenArchiveSeekbarHide();

       exitPlayerFullscreen();
        ++pageVersion;
        stopEPG();
        if (playlistXHR) {
            playlistXHR.abort();
            playlistXHR = null;
        }
       ++playbackAttempt;
       archivePlayingURL = null;
       archivePlayingProgramme = null;
       archivePreviousLiveChannel = null;
       stopVideo();
        if (playerLoader) {
            playerLoader.destroy();
            playerLoader = null;
        }
    }
    app.pages.register("player", {
        show: show,
        hide: hide
    });
})(TVAPLAY, jQuery)
