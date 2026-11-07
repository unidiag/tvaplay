
/* MODULE: 32-favoritesPage.js */

(function(app, $) {
    "use strict";

    function t(key, params) {
        return app.i18n && typeof app.i18n.t === "function" ?
            app.i18n.t(key, params) : String(key);
    }

    // group-title в M3U — ключ категории, а не её перевод.
    function categoryName(group) {
        var key = String(group || "general").toLowerCase();
        var translationKey = "categories." + key;
        var name = t(translationKey);
        return name && name !== translationKey ? name : key;
    }

    var STORAGE_KEY = "tvaplay_favorites_v1";
    var enabled = false;
    var selected = {};
    var playlistXHR = null;
    var pageVersion = 0;

    // -----------------------------
    // Хранение настроек
    // -----------------------------

    function loadSettings() {
        var raw;
        var data;
        var i;

        try {
            raw = window.localStorage.getItem(STORAGE_KEY);

            if (!raw) {
                return;
            }

            data = JSON.parse(raw);
            enabled = data.enabled === true;
            selected = {};

            if (data.channels && data.channels.length) {
                for (i = 0; i < data.channels.length; i++) {
                    selected[String(data.channels[i])] = true;
                }
            }
        } catch (e) {
            enabled = false;
            selected = {};
        }
    }

    function saveSettings() {
        var urls = [];
        var url;

        for (url in selected) {
            if (selected.hasOwnProperty(url) && selected[url]) {
                urls.push(url);
            }
        }

        try {
            window.localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify({
                    enabled: enabled,
                    channels: urls
                })
            );
        } catch (e) {
            if (app.snackbar && app.snackbar.show) {
                app.snackbar.show(
                    t("favorites.save_error"),
                    "warning",
                    true
                );
            }
        }
    }

    // Общий API для страницы "Каналы".
    app.favorites = {
        isEnabled: function() {
            return enabled;
        },

        has: function(url) {
            return selected[String(url)] === true;
        },

        isVisible: function(url) {
            return !enabled || selected[String(url)] === true;
        },

        setEnabled: function(value) {
            enabled = !!value;
            saveSettings();
        },

        setSelected: function(url, value) {
            url = String(url || "");

            if (!url) {
                return;
            }

            if (value) {
                selected[url] = true;
            } else {
                delete selected[url];
            }

            saveSettings();
        },

        count: function() {
            var count = 0;
            var url;

            for (url in selected) {
                if (selected.hasOwnProperty(url) && selected[url]) {
                    count++;
                }
            }

            return count;
        }
    };

    loadSettings();

    // -----------------------------
    // Парсер M3U
    // -----------------------------

    function parseAttribute(line, name) {
        var re = new RegExp(
            "(?:^|\\s)" + name + '="([^"]*)"',
            "i"
        );
        var match = line.match(re);

        return match ? match[1] : "";
    }

    function parsePlaylist(text) {
        var lines = String(text || "")
            .replace(/\r/g, "")
            .split("\n");

        var channels = [];
        var info = null;
        var i;
        var line;
        var comma;

        for (i = 0; i < lines.length; i++) {
            line = $.trim(lines[i]);

            if (!line) {
                continue;
            }

            if (line.indexOf("#EXTINF:") === 0) {
                comma = line.indexOf(",");

                if (comma < 0) {
                    info = null;
                    continue;
                }

                info = {
                    name: $.trim(line.substring(comma + 1)),
                    logo: parseAttribute(line, "tvg-logo"),
                    group: parseAttribute(line, "group-title")
                };

                if (!info.name) {
                    info.name = parseAttribute(line, "tvg-name");
                }

                continue;
            }

            if (line.charAt(0) === "#") {
                continue;
            }

            if (!info) {
                continue;
            }

            // Только HTTP(S) и относительные URL.
            if (
                !/^https?:\/\//i.test(line) &&
                !(line.charAt(0) === "/" && line.charAt(1) !== "/")
            ) {
                info = null;
                continue;
            }

            info.url = line;
            info.name = info.name || t("common.channel_number", {number: channels.length + 1});
            info.group = info.group || "general";

            channels.push(info);
            info = null;
        }

        return channels;
    }

    // -----------------------------
    // Отображение страницы
    // -----------------------------

    function renderChannels($page, channels) {
        var $list = $page.find(".tv-favorites-list");
        var $counter = $page.find(".tv-favorites-counter");

        var groups = {};
        var groupNames = [];
        var i;
        var group;
        var channel;

        $list.empty();

        function updateCounter() {
            $counter.text(
                t("favorites.count", {count: app.favorites.count()})
            );
        }

        updateCounter();

        if (!channels.length) {
            $('<p class="tv-service-note"></p>')
                .text(t("favorites.playlist_empty"))
                .appendTo($list);
            return;
        }

        // Группируем, сохраняя порядок из плейлиста.
        for (i = 0; i < channels.length; i++) {
            channel = channels[i];
            group = channel.group || "general";

            if (!Object.prototype.hasOwnProperty.call(groups, group)) {
                groups[group] = [];
                groupNames.push(group);
            }

            groups[group].push(channel);
        }

        // Создание одного телеканала.
        function appendChannel($container, item, index) {
            var checked = app.favorites.has(item.url);

            var $button = $('<button>', {
                type: "button",
                "class": "tv-favorites-channel",
                "data-focus-id": "favorite-channel-" + index,
                role: "checkbox",
                "aria-checked": checked ? "true" : "false"
            }).appendTo($container);

            var $check = $('<span>', {
                "class": "tv-favorites-check",
                "aria-hidden": "true"
            }).appendTo($button);

            $check.text(checked ? "✓" : "");

            var $logo = $('<span>', {
                "class": "tv-favorites-logo"
            }).appendTo($button);

            if (
                item.logo &&
                (
                    /^https?:\/\//i.test(item.logo) ||
                    (
                        item.logo.charAt(0) === "/" &&
                        item.logo.charAt(1) !== "/"
                    )
                )
            ) {
                $('<img>', {
                    src: item.logo,
                    alt: ""
                }).appendTo($logo);
            }

            $('<span>', {
                "class": "tv-favorites-channel-name",
                text: item.name
            }).appendTo($button);

            function updateState(value) {
                $button.attr(
                    "aria-checked",
                    value ? "true" : "false"
                );

                $button.toggleClass(
                    "tv-favorites-selected",
                    value
                );

                $check.text(value ? "✓" : "");
            }

            updateState(checked);

            $button.on("click", function(event) {
                event.preventDefault();

                var next = !app.favorites.has(item.url);

                app.favorites.setSelected(item.url, next);
                updateState(next);
                updateCounter();
            });
        }

        // Вывод категорий.
        for (i = 0; i < groupNames.length; i++) {
            group = groupNames[i];

            var $section = $('<div>', {
                "class": "tv-favorites-group"
            }).appendTo($list);

            $('<div>', {
                "class": "tv-favorites-group-title",
                "data-category-key": group,
                "data-category-count": groups[group].length,
                text: categoryName(group) + " (" + groups[group].length + ")"
            }).appendTo($section);

            var $items = $('<div>', {
                "class": "tv-favorites-group-items"
            }).appendTo($section);

            for (var j = 0; j < groups[group].length; j++) {
                appendChannel(
                    $items,
                    groups[group][j],
                    channels.indexOf(groups[group][j])
                );
            }
        }
    }

    function loadPlaylist($page, version) {
        var token = app.api.getToken();

        var $list = $page.find(".tv-favorites-list");

        if (!token) {
            $list.text(t("player.archive_no_auth"));
            return;
        }

        $list.text(t("player.loading_channels"));

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

            renderChannels($page, parsePlaylist(text));
        })
        .fail(function(xhr, status) {
            if (
                version !== pageVersion ||
                status === "abort"
            ) {
                return;
            }

            $list.text(
                xhr && xhr.status === 401
                    ? t("favorites.session_expired")
                    : t("favorites.playlist_error")
            );
        })
        .always(function() {
            if (version === pageVersion) {
                playlistXHR = null;
            }
        });
    }

    function show($root) {
        var version = ++pageVersion;

        var $page = $('<div>', {
            "class": "tv-favorites-page"
        }).appendTo($root);

        $('<h1>').text(t("favorites.title"))
            .appendTo($page);

        // Главный переключатель.
        var $toggle = $('<button>', {
            type: "button",
            "class": "tv-favorites-toggle",
            "data-focus-id": "favorites-enabled",
            role: "checkbox"
        }).appendTo($page);

        var $toggleCheck = $('<span>', {
            "class": "tv-favorites-toggle-check",
            "aria-hidden": "true"
        }).appendTo($toggle);

        $('<span>', {
            text: t("favorites.toggle")
        }).appendTo($toggle);

        function refreshToggle() {
            var on = app.favorites.isEnabled();

            $toggle.attr(
                "aria-checked",
                on ? "true" : "false"
            );

            $toggle.toggleClass(
                "tv-favorites-toggle-active",
                on
            );

            $toggleCheck.text(on ? "✓" : "");
        }

        refreshToggle();

        $toggle.on("click", function(event) {
            event.preventDefault();

            app.favorites.setEnabled(
                !app.favorites.isEnabled()
            );

            refreshToggle();
        });

        $('<p>', {
            "class": "tv-favorites-hint",
            text: t("favorites.hint")
        }).appendTo($page);

        $('<div>', {
            "class": "tv-favorites-counter"
        }).appendTo($page);

        $('<div>', {
            "class": "tv-favorites-list"
        }).appendTo($page);

        loadPlaylist($page, version);
    }

    function hide() {
        ++pageVersion;

        if (playlistXHR) {
            playlistXHR.abort();
            playlistXHR = null;
        }
    }

    // Переводим только заголовки, без повторного запроса M3U и перерисовки кнопок.
    // Подписка ставится после инициализации i18n (модули должны загружаться по порядку).
    if (app.i18n && typeof app.i18n.onChange === "function") {
        app.i18n.onChange(function() {
            $(".tv-favorites-group-title").each(function() {
                var $title = $(this);
                var key = $title.attr("data-category-key") || "general";
                var count = $title.attr("data-category-count") || "0";
                $title.text(categoryName(key) + " (" + count + ")");
            });
        });
    }

    app.pages.register("favorites", {
        show: show,
        hide: hide
    });

})(TVAPLAY, jQuery);
