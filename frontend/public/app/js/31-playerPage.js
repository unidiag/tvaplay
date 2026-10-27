/* MODULE: 31-playerPage.js */

(function(app, $) {
    "use strict";

    var playlistXHR = null;
    var channels = [];
    var selectedURL = null;
    var activeVideo = null;
    var playerLoader = null;
    var pageVersion = 0;
    var playbackAttempt = 0;
    var playbackErrorShown = false;
    var epgTimer = null;
    var hlsInstance = null;
    var hlsScriptPending = null;
    // Загружается только на desktop, Smart TV не затрагиваем.
    var HLS_JS_URL =
        "/app/hls.light.min.js";

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
            if (String(channels[i].id) === String(channelId)) {
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
                    group: parseAttribute(line, "group-title")
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
                info.name = "Телеканал " +
                    (result.length + 1);
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


    function playChannel(channel, $page) {
        var $video = $page.find(".tv-player-video");
        var video = $video.get(0);

        if (!video || !channel) {
            return;
        }

        var attempt = ++playbackAttempt;
        playbackErrorShown = false;        

        stopVideo();

        selectedURL = channel.url;
        activeVideo = video;

        // Запоминаем выбранный телеканал.
        saveLastChannel(channel.id);


        $page.find(".tv-channel-button")
            .removeClass("tv-channel-playing")
            .removeAttr("aria-current");

        $page.find(".tv-channel-button").filter(function() {
            return $(this).attr("data-url") === channel.url;
        })
            .addClass("tv-channel-playing")
            .attr("aria-current", "true");

        $page.find(".tv-player-channel-title")
            .text(channel.name);

        $page.find(".tv-player-status")
            .text("Подключение к телеканалу...");

        if (playerLoader) {
            playerLoader.show("Подключение к телеканалу...");
        }            

        function stillActive() {
            return attempt === playbackAttempt &&
                activeVideo === video &&
                selectedURL === channel.url;
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
                                "Не удалось начать воспроизведение"
                            );
                        }
                    });
                }
            } catch (e) {
                if (stillActive()) {
                    showPlaybackError($page, "Ошибка запуска видеоплеера");
                }
            }
        }

        function startNative() {
            if (!stillActive()) { return; }
            video.src = channel.url;
            video.load();
            startVideo();
        }

        // На телевизорах используем строго прежний нативный HLS.
        if (!isHlsURL(channel.url) || !canUseHlsJs()) {
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
                        hls.loadSource(getHlsJsURL(channel.url));
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
                    showPlaybackError($page, "Ошибка HLS: " +
                        (data.details || data.type || "неизвестная ошибка"));
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

    function updateEPG($page) {
        $page.find(".tv-channel-button").each(function() {
            var $button = $(this);
            var channelId = $button.attr("data-channel-id");
            var programme = app.epg.get(channelId);
            var $title = $button.find(".tv-channel-programme");
            var $bar = $button.find(".tv-channel-epg-progress-bar");

            $title.text(programme ? programme.title : "");
            $bar.css("width", programme ?
                app.epg.getProgress(channelId) + "%" : "0%");
        });
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

    function renderChannels($page) {
        var $list = $page.find(".tv-channel-list");
        var $count = $page.find(".tv-channel-count");

        $list.empty();
        $count.text(channels.length);

        if (!channels.length) {
            $('<p class="tv-player-message"></p>')
                .text("В плейлисте нет телеканалов.")
                .appendTo($list);
            return;
        }

        $.each(channels, function(index, channel) {
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

            $('<span class="tv-channel-name"></span>')
                .text(channel.name)
                .appendTo($details);

            $('<span class="tv-channel-programme"></span>')
                .appendTo($details);

            var $progress = $('<span class="tv-channel-epg-progress"></span>')
                .appendTo($details);

            $('<span class="tv-channel-epg-progress-bar"></span>')
                .appendTo($progress);

            if (channel.url === selectedURL) {
                $button.addClass("tv-channel-playing");
            }

            $button.on("click", function() {
                playChannel(channel, $page);
            });
        });

        // При первой загрузке предлагаем первый канал.
        // Автоматический старт видео не выполняем.
        $page.find(".tv-player-status")
            .text("Выберите телеканал справа");
    }

    function loadPlaylist($page, version) {
        var token = app.api.getToken();

        if (!token) {
            $page.find(".tv-channel-list")
                .text("Требуется авторизация.");
            return;
        }

        $page.find(".tv-channel-list")
            .text("Загрузка телеканалов...");

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

            var message = "Не удалось загрузить телеканалы";

            if (xhr && xhr.status === 401) {
                message = "Сессия истекла. " +
                    "Необходимо обновить авторизацию.";
            } else if (xhr && xhr.status === 403) {
                message = "Доступ к плейлисту запрещён.";
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

    function show($root) {
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

        $('<div class="tv-player-channel-title"></div>')
            .text("Телеканал не выбран")
            .appendTo($screen);

        $('<div class="tv-player-status"></div>')
            .text("Загрузка плейлиста...")
            .appendTo($screen);

        var $sidebar = $('<div class="tv-player-sidebar"></div>')
            .appendTo($page);

        var $heading = $('<div class="tv-channel-heading"></div>')
            .appendTo($sidebar);

        $('<span></span>')
            .text("Телеканалы")
            .appendTo($heading);

        $('<span class="tv-channel-count"></span>')
            .text("0")
            .appendTo($heading);

        $('<div class="tv-channel-list"></div>')
            .appendTo($sidebar);

        var video = $video.get(0);



        $video.on("loadstart", function() {
            if (activeVideo === video && playerLoader) {
                playerLoader.show("Загрузка телеканала...");
            }
        });

        $video.on("waiting", function() {
            if (activeVideo === video && playerLoader) {
                // Показываем буферизацию, только если
                // видеоплеер ещё не располагает
                // достаточным количеством данных.
                if (video.readyState < 3) {
                    playerLoader.show("Буферизация...");
                }
            }
        });

        $video.on("playing timeupdate", function() {
            if (activeVideo === video && !video.paused) {
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
                "Ошибка воспроизведения телеканала"
            );
        });



        loadPlaylist($page, version);
    }

    function hide() {
        ++pageVersion;
        stopEPG();

        if (playlistXHR) {
            playlistXHR.abort();
            playlistXHR = null;
        }

        ++playbackAttempt;
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
