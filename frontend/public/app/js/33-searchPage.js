/* MODULE: 33-searchPage.js */
(function(app, $) {
    "use strict";

    function t(key, params) {
        return app.i18n && typeof app.i18n.t === "function" ?
            app.i18n.t(key, params) : String(key);
    }

    var searchXHR = null;
    var debounceTimer = null;
    var searchVersion = 0;
    var lastResults = [];

    // Кэш страницы поиска хранится 1 час в рамках вкладки/приложения.
    var SEARCH_CACHE_KEY = "tvaplay_archive_search_v1";
    var SEARCH_CACHE_TTL = 60 * 60 * 1000;
    var searchCache = null;
    var activePage = null;
    var requestGeneration = 0;



    // Возвращает параметры фильтра избранного.
    function getFavoritesFilter() {
        if (!app.favorites ||
            !app.favorites.isEnabled()) {
            return {
                enabled: false,
                ids: [],
                key: "all"
            };
        }

        var ids = app.favorites.getChannelIDs();

        return {
            enabled: true,
            ids: ids,
            key: "favorites:" + ids.join(",")
        };
    }




    function getSearchCache() {
        var cache = searchCache;
        if (!cache) {
            try {
                cache = JSON.parse(window.sessionStorage.getItem(SEARCH_CACHE_KEY) || "null");
            } catch (e) { cache = null; }
        }
        if (!cache || !cache.savedAt ||
            new Date().getTime() - cache.savedAt >= SEARCH_CACHE_TTL ||
            new Date().getTime() < cache.savedAt ||
            cache.favoritesKey !== getFavoritesFilter().key) {
            searchCache = null;
            try { window.sessionStorage.removeItem(SEARCH_CACHE_KEY); } catch (e) {}
            return null;
        }
        searchCache = cache;
        return cache;
    }

    function saveSearchCache(cache) {
        searchCache = cache;
        try {
            window.sessionStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify(cache));
        } catch (e) {
            // На старых TV sessionStorage может быть недоступен.
            // В таком случае сохраняем кэш хотя бы в памяти.
        }
    }

    function saveSearchPageState($page) {
        var cache = getSearchCache();
        if (!cache || !$page || !$page.length) { return; }
        cache.input = String($page.find(".tv-search-input").val() || "");
        cache.channel = String($page.find(".tv-search-select").val() || "");
        cache.scrollTop = $("#tv-page").scrollTop() || 0;
        var focused = document.activeElement;
        if (focused && $.contains($page.get(0), focused)) {
            cache.focusID = $(focused).attr("data-focus-id") || "";
        }
        // savedAt не обновляется при возвращении на страницу:
        // кэш истечёт через час после ответа сервера.
        saveSearchCache(cache);
    }

    function pad(n) {
        return n < 10 ? "0" + n : String(n);
    }

    function dateTime(ms) {
        var d = new Date(Number(ms));
        if (isNaN(d.getTime())) { return "—"; }

        // Сравниваем календарные дни, а не количество часов:
        // это корректно и при переходе на летнее/зимнее время.
        var now = new Date();
        var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        var day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        var yesterday = new Date(today.getTime());
        var beforeYesterday = new Date(today.getTime());
        yesterday.setDate(yesterday.getDate() - 1);
        beforeYesterday.setDate(beforeYesterday.getDate() - 2);

        var label;
        if (day.getTime() === today.getTime()) {
            label = t("search.today");
        } else if (day.getTime() === yesterday.getTime()) {
            label = t("search.yesterday");
        } else if (day.getTime() === beforeYesterday.getTime()) {
            label = t("search.day_before_yesterday");
        } else {
            label = pad(d.getDate()) + "." + pad(d.getMonth() + 1) +
                "." + d.getFullYear();
        }
        return t("search.date_at", {date: label, time: pad(d.getHours()) + ":" + pad(d.getMinutes())});
    }

    // Без .html(): выделение запроса не превращает данные EPG в HTML.
    function appendHighlighted($target, value, query) {
        var source = String(value || "");
        var needle = $.trim(String(query || ""));
        if (!needle) {
            $target.text(source);
            return;
        }
        var lowerSource = source.toLowerCase();
        var lowerNeedle = needle.toLowerCase();
        var from = 0;
        var at;
        while ((at = lowerSource.indexOf(lowerNeedle, from)) !== -1) {
            if (at > from) {
                $target.append(document.createTextNode(source.substring(from, at)));
            }
            $("<span>", { "class": "tv-search-highlight" })
                .text(source.substr(at, needle.length)).appendTo($target);
            from = at + needle.length;
        }
        if (from < source.length) {
            $target.append(document.createTextNode(source.substring(from)));
        }
    }

    function duration(start, stop) {
        var seconds = Math.max(0, Math.round((Number(stop) - Number(start)) / 1000));
        var hours = Math.floor(seconds / 3600);
        var minutes = Math.floor(seconds % 3600 / 60);
        return hours ? t("search.duration_hours_minutes", {hours: hours, minutes: pad(minutes)}) : t("search.duration_minutes", {minutes: minutes});
    }

    function render($page, items, query) {
        var $list = $page.find(".tv-search-list").empty();
        var i;
        lastResults = items;
        if (!items.length) {
            return;
        }
        for (i = 0; i < items.length; i++) {
            (function(p, index) {
                var $button = $("<button>", {
                    type: "button",
                    "class": "tv-search-result",
                    "data-focus-id": "search-result-" + index
                }).appendTo($list);
                // Постер как полупрозрачный фон, аналогично плееру.
                var icon = String(p.icon || "");
                if (/^https?:\/\//i.test(icon) ||
                    (icon.charAt(0) === "/" && icon.charAt(1) !== "/")) {
                    icon = icon.replace(/["\\\r\n]/g, "");
                    $("<span>", { "class": "tv-search-result-poster", "aria-hidden": "true" })
                        .css("background-image", 'url("' + icon + '")')
                        .appendTo($button);
                }

                // Текст слева, логотип телеканала справа (100x100).
                var $layout = $("<span>", {
                    "class": "tv-search-result-layout"
                }).appendTo($button);
                var $content = $("<span>", {
                    "class": "tv-search-result-content"
                }).appendTo($layout);

                var channelLogo = String(p.channel_logo || "");
                if (/^https?:\/\//i.test(channelLogo) ||
                    (channelLogo.charAt(0) === "/" && channelLogo.charAt(1) !== "/")) {
                    // Отдельный слот гарантирует 100x100 на старых TV.
                    var $logoBox = $("<span>", {
                        "class": "tv-search-result-channel-logo-box",
                        "aria-hidden": "true"
                    }).appendTo($layout);
                    $layout.addClass("tv-search-result-has-logo");
                    $("<img>", {
                        "class": "tv-search-result-channel-logo",
                        src: channelLogo,
                        alt: ""
                    }).on("error", function() {
                        $logoBox.remove();
                        $layout.removeClass("tv-search-result-has-logo");
                    }).appendTo($logoBox);
                }
                var title = p.title || t("common.no_title");
                if (p.rating !== null && p.rating !== undefined &&
                    String(p.rating) !== "") {
                    title += " (" + p.rating + ")";
                }
                var $title = $("<span>", { "class": "tv-search-result-title" })
                    .appendTo($content);
                appendHighlighted($title, title, query);

                var $meta = $("<span>", { "class": "tv-search-result-meta" })
                    .appendTo($content);
                $("<span>", { "class": "tv-search-result-date" })
                    .text(dateTime(p.start)).appendTo($meta);
                $("<span>", { "class": "tv-search-result-duration" })
                    .text(duration(p.start, p.stop)).appendTo($meta);
                if (p.description) {
                    var $description = $("<span>", {
                        "class": "tv-search-result-description"
                    }).appendTo($content);
                    appendHighlighted($description, p.description, query);
                }
                $button.on("click", function(event) {
                    event.preventDefault();
                    app.pages.open("player", { searchArchive: p });
                });
            })(items[i], i);
        }
    }

    function populateChannels($page, channels) {
        var $select = $page.find(".tv-search-select");
        var previous = $select.val() || "";
        $select.empty();
        $("<option>", {
            value: "",
            text: t(
                app.favorites && app.favorites.isEnabled()
                    ? "search.all_favorites"
                    : "search.all_channels_short"
            )
        }).appendTo($select);
        $.each(channels || [], function(_, channel) {
            $("<option>", {
                value: String(channel.id),
                text: channel.name
            }).appendTo($select);
        });
        $select.val(previous);
        if ($select.val() === null) { $select.val(""); }
    }

    function doSearch($page, version) {
        if (version !== searchVersion) { return; }
        var q = $.trim($page.find(".tv-search-input").val());
        var channelID = $page.find(".tv-search-select").val() || "";

        var favorites = getFavoritesFilter();

        var requestData = {
            q: q,
            channel_id: channelID,
            limit: 100
        };

        if (favorites.enabled) {
            requestData.channel_ids = favorites.ids.length
                ? favorites.ids.join(",")
                : "0";
        }

        // Отложенные ответы предыдущих запросов больше не актуальны.
        var request = ++requestGeneration;
        if (searchXHR) {
            searchXHR.abort();
            searchXHR = null;
        }
        if (q.length > 0 && q.length < 2) {
            $page.find(".tv-search-status").text(t("search.min_chars"));
            $page.find(".tv-search-list").empty();
            return;
        }
        var token = app.api.getToken();
        if (!token) {
            $page.find(".tv-search-status").text(t("common.not_authorized"));
            return;
        }
        $page.find(".tv-search-status").text(t("search.loading"));
        searchXHR = $.ajax({
            url: "/api/archive/search",
            type: "GET",
            data: requestData,
            headers: { Authorization: "Bearer " + token },
            dataType: "json",
            timeout: 20000,
            cache: false
        }).done(function(data) {
            if (version !== searchVersion || request !== requestGeneration) { return; }
            if (!data || data.status !== "OK" || !$.isArray(data.programmes)) {
                $page.find(".tv-search-status").text(t("search.bad_response"));
                return;
            }
            populateChannels($page, data.channels);
            // Запоминаем ответ и фильтры даже для пустых результатов.
            saveSearchCache({
                savedAt: new Date().getTime(),
                favoritesKey: favorites.key,
                query: q,
                channel: channelID,
                input: String($page.find(".tv-search-input").val() || ""),
                channels: data.channels || [],
                programmes: data.programmes,
                scrollTop: $("#tv-page").scrollTop() || 0,
                focusID: ""
            });
            if (!q) {
                $page.find(".tv-search-status")
                    .text(t("search.type_query"));
                $page.find(".tv-search-list").empty();
                return;
            }
            render($page, data.programmes, q);
            $page.find(".tv-search-status")
                .text(t("search.count", {count: data.programmes.length}) +
                      (data.programmes.length === 100 ? t("search.first_100") : ""));
        }).fail(function(xhr, status) {
            if (version !== searchVersion || request !== requestGeneration ||
                status === "abort") { return; }
            var message = xhr && xhr.responseJSON && xhr.responseJSON.message;
            $page.find(".tv-search-status")
                .text(message || t("search.failed_http", {status: xhr ? xhr.status : 0}));
        }).always(function() {
            if (version === searchVersion && request === requestGeneration) {
                searchXHR = null;
            }
        });
    }

    function show($root) {
        var version = ++searchVersion;
        var $page = $('<div class="tv-search-page"></div>').appendTo($root);
        $('<h1 class="tv-search-title"></h1>').text(t("search.title")).appendTo($page);
        var $form = $('<form class="tv-search-form"></form>').appendTo($page);
        $('<input>', {
            type: "search", "class": "tv-search-input",
            placeholder: t("search.placeholder"), "aria-label": t("search.input_label"),
            "data-focus-id": "search-input", maxlength: 100
        }).appendTo($form);

        $('<select>', {
            "class": "tv-search-select",
            "aria-label": t("search.channel_label"),
            "data-focus-id": "search-channel"
        }).appendTo($form).append(
            $('<option>', {
                value: "",
                text: t(
                    app.favorites && app.favorites.isEnabled()
                        ? "search.all_favorites"
                        : "search.all_channels_short"
                )
            })
        );

        $('<button>', {
            type: "submit", "class": "tv-search-submit",
            "data-focus-id": "search-submit", text: t("search.submit")
        }).appendTo($form);
        $('<div class="tv-search-status" aria-live="polite"></div>').appendTo($page);
        $('<div class="tv-search-list"></div>').appendTo($page);
        activePage = $page;
        $form.on("submit", function(event) {
            event.preventDefault();
            clearTimeout(debounceTimer);
            doSearch($page, version);
        });
        $form.on("change", ".tv-search-select", function() {
            doSearch($page, version);
        });
        $form.on("input", ".tv-search-input", function() {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(function() {
                doSearch($page, version);
            }, 500);
        });
        var cache = getSearchCache();
        if (cache) {
            var input = cache.input !== undefined ? cache.input : cache.query;
            $page.find(".tv-search-input").val(input || "");
            populateChannels($page, cache.channels || []);
            $page.find(".tv-search-select").val(cache.channel || "");
            if ($page.find(".tv-search-select").val() === null) {
                $page.find(".tv-search-select").val("");
            }
            // Показываем кэш без API-запроса только для той же пары
            // запрос + выбранный канал, по которой пришёл ответ.
            if ($.trim(String(input || "")) === cache.query &&
                ($page.find(".tv-search-select").val() || "") === cache.channel &&
                $.isArray(cache.programmes)) {
                if (cache.query) {
                    render($page, cache.programmes, cache.query);
                    $page.find(".tv-search-status").text(
                        t("search.count", {count: cache.programmes.length}) +
                        (cache.programmes.length === 100 ?
                            t("search.first_100") : "")
                    );
                } else {
                    $page.find(".tv-search-status").text(
                        t("search.type_query")
                    );
                }
            } else {
                doSearch($page, version);
            }
            // Дожидаемся завершения app.pages.open(), чтобы не потерять
            // позицию прокрутки страницы после восстановления фокуса.
            setTimeout(function() {
                if (version === searchVersion) {
                    $("#tv-page").scrollTop(cache.scrollTop || 0);
                }
            }, 0);
        } else {
            doSearch($page, version);
        }
    }

    function hide() {
        saveSearchPageState(activePage);
        activePage = null;
        ++searchVersion;
        ++requestGeneration;
        clearTimeout(debounceTimer);
        debounceTimer = null;
        if (searchXHR) {
            searchXHR.abort();
            searchXHR = null;
        }
        lastResults = [];
    }

    // Перерисовываем только поисковую страницу. Кэш и запрос не сбрасываются.
    // Register after modules load; old TV bundles may order 04-i18n.js later.
    $(function() {
        if (!app.i18n || typeof app.i18n.onChange !== "function") {
            return;
        }
        app.i18n.onChange(function() {
        if (!activePage || !activePage.length ||
            !$.contains(document.documentElement, activePage[0])) { return; }
        var $page = activePage;
        var cache = getSearchCache();
        var focusID = document.activeElement &&
            $(document.activeElement).attr("data-focus-id");
        var scroll = $("#tv-page").scrollTop();
        var chosen = $page.find(".tv-search-select").val() || "";
        $page.find(".tv-search-title").text(t("search.title"));
        $page.find(".tv-search-input")
            .attr("placeholder", t("search.placeholder"))
            .attr("aria-label", t("search.input_label"));
        $page.find(".tv-search-select").attr("aria-label", t("search.channel_label"));
        $page.find(".tv-search-submit").text(t("search.submit"));
        // Используем уже загруженные каналы, без сетевого запроса.
        if (cache && cache.channels) {
            populateChannels($page, cache.channels);
        } else {
            $page.find(".tv-search-select option:first").text(
                t(
                    app.favorites && app.favorites.isEnabled()
                        ? "search.all_favorites"
                        : "search.all_channels_short"
                )
            );
        }
        $page.find(".tv-search-select").val(chosen);
        if (cache && cache.query && $.isArray(cache.programmes)) {
            render($page, cache.programmes, cache.query);
            $page.find(".tv-search-status").text(
                t("search.count", {count: cache.programmes.length}) +
                (cache.programmes.length === 100 ? t("search.first_100") : "")
            );
        } else if (cache && !cache.query) {
            $page.find(".tv-search-status").text(t("search.type_query"));
        }
        if (focusID) {
            $page.find("[data-focus-id]").filter(function() {
                return $(this).attr("data-focus-id") === focusID;
            }).first().focus();
        }
        $("#tv-page").scrollTop(scroll);
        });
    });

    app.pages.register("search", { show: show, hide: hide });
})(TVAPLAY, jQuery);
