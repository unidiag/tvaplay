/* MODULE: 34-servicePage.js */

(function(app, $) {

    "use strict";

    var activeSection = "account";

    // Язык хранится в localStorage внутри app.i18n.

    var speedXHR = null;

    var speedTimer = null;

    function t(key, params) {
        return app.i18n && typeof app.i18n.t === "function" ?
            app.i18n.t(key, params) : String(key);
    }

    var sections = [

        { id: "account" },

        { id: "speed" },

        { id: "devices" },

        { id: "settings" },

        { id: "exit" }

    ];

    function getDeviceName(userAgent) {

        var ua = String(userAgent || "");

        var platform = t("service.devices.unknown_platform");

        var browser = t("service.devices.unknown_browser");

        var match;

        if (/webOS|Web0S|NetCast/i.test(ua)) {

            platform = "LG webOS";

        } else if (/Tizen/i.test(ua)) {

            platform = "Samsung Tizen";

        } else if (/Android TV|Google TV/i.test(ua)) {

            platform = "Android TV";

        } else if (/Android/i.test(ua)) {

            platform = "Android";

        } else if (/Windows/i.test(ua)) {

            platform = "Windows";

        } else if (/Macintosh|Mac OS/i.test(ua)) {

            platform = "macOS";

        } else if (/Linux/i.test(ua)) {

            platform = "Linux";

        }

        match = ua.match(/Edg(?:e|A|iOS)?\/([\d.]+)/i);

        if (match) {

            browser = "Edge " + match[1];

        } else {

            match = ua.match(/(?:Chrome|CriOS)\/([\d.]+)/i);

            if (match) {

                browser = "Chrome " + match[1];

            } else {

                match = ua.match(/Firefox\/([\d.]+)/i);

                if (match) {

                    browser = "Firefox " + match[1];

                } else {

                    match = ua.match(/Version\/([\d.]+).*Safari/i);

                    if (match) {

                        browser = "Safari " + match[1];

                    } else if (/Mozilla\/[\d.]+/i.test(ua)) {

                        browser = "Mozilla";

                    }

                }

            }

        }

        return platform + " · " + browser;

    }

    function parseSessionDate(value) {

        if (value === null || value === undefined || value === "") {

            return null;

        }

        // Unix timestamp в миллисекундах.

        if (typeof value === "number") {

            var numericDate = new Date(value);

            return isNaN(numericDate.getTime()) ? null : numericDate;

        }

        var str = String(value).trim();

        // RFC3339 / RFC3339Nano, включая часовой пояс Go.

        var match = str.match(

            /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):?(\d{2}))$/i

        );

        if (!match) {

            return null;

        }

        var milliseconds = parseInt(

            ((match[7] || "") + "000").substring(0, 3), 10

        );

        var timestamp = Date.UTC(

            Number(match[1]),

            Number(match[2]) - 1,

            Number(match[3]),

            Number(match[4]),

            Number(match[5]),

            Number(match[6]),

            milliseconds

        );

        if (match[8].toUpperCase() !== "Z") {

            var offset = Number(match[10]) * 60 + Number(match[11]);

            if (Number(match[10]) > 23 || Number(match[11]) > 59) {

                return null;

            }

            timestamp -= (match[9] === "+" ? 1 : -1) *

                offset * 60000;

        }

        var date = new Date(timestamp);

        return isNaN(date.getTime()) ? null : date;

    }

    function formatSessionDate(value) {

        var date = parseSessionDate(value);

        if (!date) {

            return t("common.unknown");

        }

        function pad(n) {

            return n < 10 ? "0" + n : String(n);

        }

        return pad(date.getDate()) + "." +

            pad(date.getMonth() + 1) + "." +

            date.getFullYear() + ", " +

            pad(date.getHours()) + ":" +

            pad(date.getMinutes());

    }

    function timeAgo(value) {

        var date = parseSessionDate(value);

        if (!date) {

            return "";

        }

        // Сравниваем реальные Unix timestamps.

        // app.clock.getTime() здесь использовать нельзя.

        var diff = Date.now() - date.getTime();

        if (diff < 0) {

            return t("service.devices.time.clock_skew");

        }

        var seconds = Math.floor(diff / 1000);

        var minutes = Math.floor(seconds / 60);

        var hours = Math.floor(seconds / 3600);

        var days = Math.floor(seconds / 86400);

        var months = Math.floor(days / 30);

        if (minutes < 1) {

            return t("service.devices.time.just_now");

        }

        if (minutes < 60) {

            return t("service.devices.time.minutes_ago", {count: minutes});

        }

        if (hours < 24) {

            return t("service.devices.time.hours_ago", {count: hours});

        }

        if (days < 30) {

            return t("service.devices.time.days_ago", {count: days});

        }

        if (days < 365) {

            return t("service.devices.time.months_ago", {count: months});

        }

        return t("service.devices.time.over_year");

    }

    function addInfo($container, title, value) {

        var $row = $('<div class="tv-service-info-row"></div>')

            .appendTo($container);

        $('<div class="tv-service-info-label"></div>')

            .text(title)

            .appendTo($row);

        $('<div class="tv-service-info-value"></div>')

            .text(value == null || value === ""

                ? t("common.unavailable")

                : String(value))

            .appendTo($row);

    }

    function showAccount($content) {

        $('<h1>').text(t("service.sections.account"))

            .appendTo($content);

        var $info = $('<div></div>').appendTo($content);

        addInfo($info, t("service.account.phone"), t("common.no_data"));
        addInfo($info, t("service.account.balance"), t("common.no_data"));
        addInfo($info, t("service.account.packages"), t("common.no_data"));
        addInfo($info, t("service.account.status"), t("common.no_data"));

    }

    function stopSpeedTest() {

        if (speedTimer !== null) {

            clearTimeout(speedTimer);

            speedTimer = null;

        }

        if (speedXHR) {

            var xhr = speedXHR;

            speedXHR = null;

            xhr.abort();

        }

    }

    function getSpeedAssessment(mbps) {

        if (mbps < 3) {

            return t("service.speed.low");

        }

        if (mbps < 10) {

            return t("service.speed.medium");

        }

        return t("service.speed.good");

    }

    function showSpeed($content) {

        $('<h1>').text(t("service.sections.speed"))

            .appendTo($content);

        $('<p class="tv-service-note"></p>')

            .text(

                t("service.speed.hint")

            )

            .appendTo($content);

        var $result = $('<div class="tv-speed-result"></div>')

            .text("—")

            .appendTo($content);

        $('<div class="tv-speed-unit"></div>').text(t("service.speed.unit"))

            .appendTo($content);

        var $progress = $('<div class="tv-speed-progress"></div>')

            .appendTo($content);

        var $progressBar = $('<div class="tv-speed-progress-bar"></div>')

            .appendTo($progress);

        var $status = $('<p class="tv-speed-status"></p>')

            .text(t("service.speed.start_hint"))

            .appendTo($content);

        var $button = $('<button>', {

            type: "button",

            "class": "tv-speed-button",

            "data-focus-id": "speed-start",

            text: t("service.speed.start")

        }).appendTo($content);

        function setStatus(message) {

            if ($content.closest("body").length) {

                $status.text(message);

            }

        }

        function showMbps(bytes, milliseconds) {

            if (milliseconds <= 0) {

                return;

            }

            var mbps = bytes * 8 / milliseconds / 1000;

            if (isFinite(mbps)) {

                $result.text(mbps.toFixed(1));

            }

        }

        $button.on("click", function() {

            if (speedXHR) {

                return;

            }

            var token = app.api.getToken();

            if (!token) {

                setStatus(t("service.speed.no_token"));

                return;

            }

            var xhr = new XMLHttpRequest();

            var started = new Date().getTime();

            var received = 0;

            var finished = false;

            speedXHR = xhr;

            $button.prop("disabled", true);

            $button.text(t("service.speed.testing"));

            $result.text("0.0");

            $progressBar.css("width", "0%");

            setStatus(t("service.speed.receiving"));

            function finish(error) {

                if (finished) {

                    return;

                }

                finished = true;

                if (speedTimer !== null) {

                    clearTimeout(speedTimer);

                    speedTimer = null;

                }

                if (speedXHR === xhr) {

                    speedXHR = null;

                }

                var elapsed = new Date().getTime() - started;

                if (received >= 256 * 1024 && elapsed > 0) {

                    showMbps(received, elapsed);

                    var mbps = received * 8 / elapsed / 1000;

                    var assessment = getSpeedAssessment(mbps);

                    if (error) {

                        setStatus(

                            t("service.speed.timeout_result", {assessment: assessment})

                        );

                    } else {

                        setStatus(assessment);

                    }

                } else {

                    $result.text("—");

                    setStatus(

                        error || t("service.speed.insufficient_data")

                    );

                }

                $button.prop("disabled", false);

                $button.text(t("service.speed.retry"));

            }

            speedTimer = setTimeout(function() {

                if (finished) {

                    return;

                }

                // Останавливаем измерение через 10 секунд.

                finish(t("service.speed.timeout"));

                xhr.abort();

            }, 10000);

            xhr.open(

                "GET",

                "/api/speedtest?t=" + started,

                true

            );

            xhr.setRequestHeader(

                "Authorization",

                "Bearer " + token

            );

            // Не сохраняем бинарные данные в строку.

            try {

                xhr.responseType = "arraybuffer";

            } catch (e) {

                clearTimeout(speedTimer);

                speedTimer = null;

                finish(t("service.speed.unsupported"));

                return;

            }

            if (xhr.responseType !== "arraybuffer") {

                clearTimeout(speedTimer);

                speedTimer = null;

                finish(t("service.speed.unsupported"));

                return;

            }

            xhr.onprogress = function(event) {

                if (finished) {

                    return;

                }

                received = event.loaded;

                var elapsed = new Date().getTime() - started;

                showMbps(received, elapsed);

                if (event.lengthComputable && event.total > 0) {

                    var percent = Math.min(

                        100,

                        received * 100 / event.total

                    );

                    $progressBar.css(

                        "width",

                        percent.toFixed(1) + "%"

                    );

                }

            };

            xhr.onload = function() {

                clearTimeout(speedTimer);

                speedTimer = null;

                if (finished) {

                    return;

                }

                if (xhr.status !== 200) {

                    finish(t("common.http_error", {status: xhr.status}));

                    return;

                }

                if (xhr.response) {

                    received = xhr.response.byteLength;

                }

                $progressBar.css("width", "100%");

                finish(null);

            };

            xhr.onerror = function() {

                if (!finished) {

                    finish(t("common.network_error"));

                }

            };

            xhr.send();

        });

    }

    function revokeDevice(device, $button, onSuccess) {

        var isCurrent = device.uid === app.device.getId();

        // Предотвращаем повторное нажатие.

        $button.prop("disabled", true);

        $button.text(t("service.devices.deleting"));

        app.api("accountDeviceRevoke", {

            id: String(device.id)

        })

        .done(function(data) {

            // Удалена текущая сессия.

            if (isCurrent) {

                app.api.clearTokens();

                app.setAuthorized(false);

                return;

            }

            app.snackbar.show(

                t("service.devices.deleted"),

                "success",

                true

            );

            // Перезагружаем список устройств.

            if (typeof onSuccess === "function") {

                onSuccess();

            }

        })

        .fail(function(error) {

            app.snackbar.show(

                error && error.message

                    ? error.message

                    : t("service.devices.delete_error"),

                "error",

                true

            );

        })

        .always(function() {

            $button.prop("disabled", false);

            $button.text(t("service.devices.delete"));

        });

    }

    function showDevices($content) {

        $content.empty();

        $('<h1>').text(t("service.sections.devices"))

            .appendTo($content);

        var $summary = $('<p class="tv-service-devices-summary"></p>')

            .text(t("service.devices.loading"))

            .appendTo($content);

        var $list = $('<div class="tv-service-devices"></div>')

            .appendTo($content);

        // Защита от устаревшего ответа при переключении меню.

        var requestContent = $content[0];

        app.api("accountDevices", {})

            .done(function(data) {

                if (!$list.length ||

                    !$.contains(requestContent, $list[0])) {

                    return;

                }

                $list.empty();

                var devices = data.devices || [];

                var count = data.count || 0;

                var maxDev = data.max_dev || 1;

                // Текущее устройство всегда отображаем первым.

                // Остальные устройства сохраняют исходный порядок.

                devices = devices.slice().sort(function(a, b) {

                    if (!!a.current === !!b.current) {

                        return 0;

                    }

                    return a.current ? -1 : 1;

                });

                $summary.text(

                    t("service.devices.count", {count: count, max: maxDev})

                );

                if (!devices.length) {

                    $('<p class="tv-service-note"></p>')

                        .text(t("service.devices.empty"))

                        .appendTo($list);

                    return;

                }

                $.each(devices, function(index, device) {

                    var $card = $('<div class="tv-device-card"></div>')

                        .appendTo($list);

                    var $header = $('<div class="tv-device-header"></div>')

                        .appendTo($card);

                    $('<div class="tv-device-title"></div>')

                        .text(getDeviceName(device.user_agent))

                        .appendTo($header);

                    if (device.current) {

                        $('<span class="tv-device-current"></span>')

                            .text(t("service.devices.current"))

                            .appendTo($header);

                    }

                    // Порядковый номер устройства справа.

                    $('<span class="tv-device-number"></span>')

                        .text(index + 1)

                        .appendTo($header);

                    var $details = $('<div></div>')

                        .appendTo($card);

                    addInfo(

                        $details,

                        t("service.devices.uid"),

                        device.uid || t("common.unknown")

                    );

                    addInfo(

                        $details,

                        t("service.devices.ip"),

                        (device.ip || t("common.unknown")) +

                        " · " +

                        (device.country || "?")

                    );

                    var $row = $('<div class="tv-service-info-row tv-device-login-row"></div>')

                        .appendTo($details);

                    // Левая колонка: подпись и время.

                    var $loginInfo = $('<div class="tv-device-login-info"></div>')

                        .appendTo($row);

                    $('<div class="tv-service-info-label"></div>')

                        .text(t("service.devices.login_time"))

                        .appendTo($loginInfo);

                    var $value = $('<div class="tv-service-info-value"></div>')

                        .appendTo($loginInfo);

                    $('<span></span>')

                        .text(formatSessionDate(device.created_at))

                        .appendTo($value);

                    var ago = timeAgo(device.created_at);

                    if (ago) {

                        $('<span class="tv-device-time-ago"></span>')

                            .text(" (" + ago + ")")

                            .appendTo($value);

                    }

                    // Правая колонка: кнопка удаления.

                    var $deleteButton = $('<button>', {

                        type: "button",

                        "class": "tv-device-delete-button",

                        "data-focus-id": "device-delete-" + device.id,

                        text: t("service.devices.delete")

                    }).appendTo($row);

                    $deleteButton.on("click", function() {

                        revokeDevice(device, $deleteButton, function() {

                            showDevices($content);

                        });

                    });

                });

            })

            .fail(function(error) {

                if (!$list.length ||

                    !$.contains(requestContent, $list[0])) {

                    return;

                }

                $summary.text(t("service.devices.load_error"));

                $('<p class="tv-service-note"></p>')

                    .text(

                        error && error.message

                            ? error.message

                            : t("service.devices.sessions_error")

                    )

                    .appendTo($list);

            });

    }

    function showSettings($content) {
        $('<h1>').text(t("service.sections.settings")).appendTo($content);

        var $row = $('<div class="tv-service-info-row"></div>')
            .appendTo($content);

        $('<label>', {
            "class": "tv-service-info-label",
            "for": "tv-service-language",
            text: t("service.settings.language")
        }).appendTo($row);

        var $select = $('<select>', {
            id: "tv-service-language",
            "class": "tv-service-language-select",
            "data-focus-id": "service-language"
        }).appendTo($row);

        var languages = [];
        function populateLanguages() {
            var previous = $select.val();
            languages = app.i18n.getLanguages();
            $select.empty();
            $.each(languages, function(_, lang) {
                $('<option>', {value: lang.id, text: lang.name}).appendTo($select);
            });
            // Preserve the current choice; avoid resetting it on refresh.
            var current = app.i18n.getLanguage();
            $select.val(current);
            if ($select.val() === null) {
                $select.val(previous);
            }
        }
        populateLanguages();

        // On a previous network error the manager has only the English
        // fallback. Retry when Settings is opened, without reloading the page.
        if (languages.length <= 1 &&
                typeof app.i18n.refreshLanguages === "function") {
            app.i18n.refreshLanguages().done(function() {
                if ($select.closest("body").length) {
                    populateLanguages();
                }
            });
        }

        $select.on("change", function() {
            var next = $select.val();
            var previous = app.i18n.getLanguage();
            var selectedName = "";
            var i;
            if (next === previous) { return; }
            for (i = 0; i < languages.length; i++) {
                if (languages[i].id === next) {
                    selectedName = languages[i].name;
                    break;
                }
            }
            $select.prop("disabled", true);
            app.i18n.setLanguage(next).done(function() {
                // Refresh headings and active section, keeping the same page.
                var $page = $content.closest(".tv-service");
                if ($page.length) {
                    renderSection($page, "settings");
                    $page.find("#tv-service-language").focus();
                }
                app.snackbar.show(t("service.settings.language_selected", {
                    name: selectedName
                }), "success", true);
            }).fail(function() {
                $select.prop("disabled", false).val(previous);
                app.snackbar.show(t("service.settings.language_load_error"),
                    "error", true);
            });
        });
    }

    function showExit($content) {

        $('<h1>').text(t("service.exit.title"))

            .appendTo($content);

        $('<p class="tv-service-note"></p>')

            .text(

                t("service.exit.hint")

            )

            .appendTo($content);

        // Контейнер для кнопок.

        var $actions = $('<div class="tv-service-exit-actions"></div>')

            .appendTo($content);

        // Кнопка перезапуска.

        $('<button>', {

            type: "button",

            "class": "tv-service-restart-button",

            "data-focus-id": "service-restart",

            text: t("service.exit.restart")

        })

            .appendTo($actions)

            .on("click", function() {

                window.location.replace("/");

            });

        // Существующая кнопка выхода.

        $('<button>', {

            type: "button",

            "class": "tv-service-exit-button",

            "data-focus-id": "service-exit-confirm",

            text: t("service.exit.close")

        })

            .appendTo($actions)

            .on("click", exitApplication);

    }

    function exitApplication() {

        // Tizen

        try {

            if (window.tizen &&

                window.tizen.application) {

                window.tizen.application

                    .getCurrentApplication()

                    .exit();

                return;

            }

        } catch (e) {}

        // Обычный браузер или совместимая TV-платформа.

        // window.close() может быть запрещён системой.

        try {

            window.close();

        } catch (e2) {}

        // Если платформа не поддерживает закрытие,

        // приложение останется открытым.

        if (app.snackbar && app.snackbar.show) {

            app.snackbar.show(

                t("service.exit.unsupported"),

                "warning",

                true

            );

        }

    }

    function renderSection($page, section) {

        var $content = $page.find(".tv-service-content");

        if (activeSection === "speed") {

            stopSpeedTest();

        }

        $content.empty();

        activeSection = section;
        $page.find(".tv-service-menu-button").each(function() {
            var id = $(this).attr("data-section");
            $(this).text(t("service.sections." + id));
        });

        $page.find(".tv-service-menu-button")

            .removeClass("tv-service-menu-active")

            .removeAttr("aria-current");

        $page.find(".tv-service-menu-button")

            .filter(function() {

                return $(this).attr("data-section") === section;

            })

            .addClass("tv-service-menu-active")

            .attr("aria-current", "page");

        if (section === "account") {

            showAccount($content);

        } else if (section === "speed") {

            showSpeed($content);

        } else if (section === "devices") {

            showDevices($content);

        } else if (section === "settings") {

            showSettings($content);

        } else if (section === "exit") {

            showExit($content);

        }

    }

    function show($root) {

        var $page = $('<div class="tv-service"></div>')

            .appendTo($root);

        var $menu = $('<div class="tv-service-menu"></div>')

            .appendTo($page);

        $('<div class="tv-service-content"></div>')

            .appendTo($page);

        var i;

        for (i = 0; i < sections.length; i++) {

            $('<button>', {

                type: "button",

                "class": "tv-service-menu-button",

                "data-section": sections[i].id,

                "data-focus-id": "service-" + sections[i].id,

                text: t("service.sections." + sections[i].id)

            }).appendTo($menu);

        }

        $menu.on(

            "click",

            ".tv-service-menu-button",

            function() {

                renderSection(

                    $page,

                    $(this).attr("data-section")

                );

            }

        );

        // Dictionaries load asynchronously. Display after initialization.
        var languageReady = app.i18n && typeof app.i18n.init === "function" ?
            app.i18n.init() : $.Deferred().resolve().promise();
        languageReady.done(function() {
            if ($page.closest("body").length) {
                renderSection($page, activeSection);
            }
        }).fail(function() {
            // Dictionary URLs must be reachable; missing strings use key fallback.
            if ($page.closest("body").length) {
                renderSection($page, activeSection);
            }
        });

    }

    function hide() {

        stopSpeedTest();

    }

    app.pages.register("service", {

        show: show,

        hide: hide

    });

})(TVAPLAY, jQuery);

;

