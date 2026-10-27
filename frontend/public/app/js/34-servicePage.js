/* MODULE: 34-servicePage.js */

(function(app, $) {
    "use strict";

    var activeSection = "account";
    var selectedLanguage = "ru";
    var speedXHR = null;
    var speedTimer = null;

    var sections = [
        { id: "account", title: "Личный кабинет" },
        { id: "speed", title: "Тест скорости" },
        { id: "devices", title: "Устройства" },
        { id: "settings", title: "Настройки" },
        { id: "exit", title: "Выход" }
    ];






    function getDeviceName(userAgent) {
        var ua = String(userAgent || "");
        var platform = "Неизвестная платформа";
        var browser = "Неизвестный браузер";
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







    function formatSessionDate(value) {
        if (!value) {
            return "Неизвестно";
        }

        var date = new Date(value);

        if (isNaN(date.getTime())) {
            return "Неизвестно";
        }

        function pad(number) {
            return number < 10 ? "0" + number : String(number);
        }

        return pad(date.getDate()) + "." +
            pad(date.getMonth() + 1) + "." +
            date.getFullYear() + ", " +
            pad(date.getHours()) + ":" +
            pad(date.getMinutes());
    }














    function timeAgo(value) {
        if (!value) {
            return "";
        }

        var date = new Date(value);

        if (isNaN(date.getTime())) {
            return "";
        }

        // Используем время сервера TVAPLAY.
        var now = app.clock.getTime() || new Date();

        var seconds = Math.max(
            0,
            Math.floor((now.getTime() - date.getTime()) / 1000)
        );

        var minutes = Math.floor(seconds / 60);
        var hours = Math.floor(seconds / 3600);
        var days = Math.floor(seconds / 86400);
        var months = Math.floor(days / 30);

        if (minutes < 1) {
            return "только что";
        }

        if (minutes < 60) {
            return minutes + " мин. назад";
        }

        if (hours < 24) {
            return hours + " ч. назад";
        }

        if (days < 30) {
            return days + " дн. назад";
        }

        if (days < 365) {
            return months + " мес. назад";
        }

        return "более года назад";
    }














    function addInfo($container, title, value) {
        var $row = $('<div class="tv-service-info-row"></div>')
            .appendTo($container);

        $('<div class="tv-service-info-label"></div>')
            .text(title)
            .appendTo($row);

        $('<div class="tv-service-info-value"></div>')
            .text(value == null || value === ""
                ? "Недоступно"
                : String(value))
            .appendTo($row);
    }

    function showAccount($content) {
        $('<h1>Личный кабинет</h1>')
            .appendTo($content);

        var $info = $('<div></div>').appendTo($content);

        addInfo($info, "Баланс", "Нет данных");
        addInfo($info, "Тарифный план", "Нет данных");
        addInfo($info, "Статус подписки", "Нет данных");

        $('<p class="tv-service-note"></p>')
            .text("Информация будет доступна после подключения API.")
            .appendTo($content);
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
            return "Низкая скорость. " +
                "Возможны зависания SD-каналов. " +
                "Для Full HD скорости недостаточно.";
        }

        if (mbps < 10) {
            return "Скорости достаточно для SD-каналов. " +
                "При просмотре Full HD возможны зависания.";
        }

        return "Хорошая скорость. " +
            "Подходит для просмотра SD и Full HD телеканалов.";
    }


    function showSpeed($content) {
        $('<h1>Тест скорости</h1>')
            .appendTo($content);

        $('<p class="tv-service-note"></p>')
            .text(
                "Для качественного просмотра рекомендуется скорость 5-10 Мбит/с. "+
                "Некоторые Full HD телеканалы требуют скорость не менее 15 Мбит/с."
            )
            .appendTo($content);

        var $result = $('<div class="tv-speed-result"></div>')
            .text("—")
            .appendTo($content);

        $('<div class="tv-speed-unit">Мбит/с</div>')
            .appendTo($content);

        var $progress = $('<div class="tv-speed-progress"></div>')
            .appendTo($content);

        var $progressBar = $('<div class="tv-speed-progress-bar"></div>')
            .appendTo($progress);

        var $status = $('<p class="tv-speed-status"></p>')
            .text("Нажмите кнопку для начала измерения")
            .appendTo($content);

        var $button = $('<button>', {
            type: "button",
            "class": "tv-speed-button",
            "data-focus-id": "speed-start",
            text: "Начать тест"
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
                setStatus("Нет токена авторизации");
                return;
            }

            var xhr = new XMLHttpRequest();

            var started = new Date().getTime();
            var received = 0;
            var finished = false;

            speedXHR = xhr;

            $button.prop("disabled", true);
            $button.text("Измерение...");

            $result.text("0.0");
            $progressBar.css("width", "0%");
            setStatus("Получение данных...");

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
                            "Измерение завершено по времени. " +
                            assessment
                        );
                    } else {
                        setStatus(assessment);
                    }

                } else {
                    $result.text("—");

                    setStatus(
                        error || "Недостаточно данных для измерения"
                    );
                }

                $button.prop("disabled", false);
                $button.text("Повторить тест");
            }

            speedTimer = setTimeout(function() {
                if (finished) {
                    return;
                }

                // Останавливаем измерение через 10 секунд.
                finish("Время измерения истекло");
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
                finish("Браузер не поддерживает тест скорости");
                return;
            }

            if (xhr.responseType !== "arraybuffer") {
                clearTimeout(speedTimer);
                speedTimer = null;
                finish("Браузер не поддерживает тест скорости");
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
                    finish("Ошибка сервера: HTTP " + xhr.status);
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
                    finish("Ошибка соединения с сервером");
                }
            };

            xhr.send();
        });
    }





















    function revokeDevice(device, $button, onSuccess) {
        var isCurrent = device.uid === app.device.getId();

        // Предотвращаем повторное нажатие.
        $button.prop("disabled", true);
        $button.text("Удаление...");

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
                "Сессия удалена",
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
                    : "Ошибка удаления сессии",
                "error",
                true
            );
        })
        .always(function() {
            $button.prop("disabled", false);
            $button.text("Удалить");
        });
    }





    function showDevices($content) {

        $content.empty();

        $('<h1>Устройства</h1>')
            .appendTo($content);

        var $summary = $('<p class="tv-service-devices-summary"></p>')
            .text("Загрузка устройств...")
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
                    "Подключено устройств: " +
                    count + " из " + maxDev
                );

                if (!devices.length) {
                    $('<p class="tv-service-note"></p>')
                        .text("Активных устройств нет.")
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
                            .text("Это устройство")
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
                        "UID",
                        device.uid || "Неизвестно"
                    );

                    addInfo(
                        $details,
                        "IP-адрес",
                        (device.ip || "Неизвестно") +
                        " · " +
                        (device.country || "?")
                    );


                    var $row = $('<div class="tv-service-info-row tv-device-login-row"></div>')
                        .appendTo($details);

                    // Левая колонка: подпись и время.
                    var $loginInfo = $('<div class="tv-device-login-info"></div>')
                        .appendTo($row);

                    $('<div class="tv-service-info-label"></div>')
                        .text("Время входа")
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
                        text: "Удалить"
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

                $summary.text("Не удалось загрузить устройства.");

                $('<p class="tv-service-note"></p>')
                    .text(
                        error && error.message
                            ? error.message
                            : "Ошибка получения сессий"
                    )
                    .appendTo($list);
            });
    }












    function showSettings($content) {
        $('<h1>Настройки</h1>').appendTo($content);

        var $row = $('<div class="tv-service-info-row"></div>')
            .appendTo($content);

        $('<label>', {
            "class": "tv-service-info-label",
            "for": "tv-service-language",
            text: "Язык"
        }).appendTo($row);

        var $select = $('<select>', {
            id: "tv-service-language",
            "class": "tv-service-language-select",
            "data-focus-id": "service-language"
        }).appendTo($row);

        var languages = [
            { id: "be", name: "Беларуская" },
            { id: "ru", name: "Русский" },
            { id: "en", name: "English" },
            { id: "es", name: "Español" }
        ];
        var i;

        for (i = 0; i < languages.length; i++) {
            $('<option>', {
                value: languages[i].id,
                text: languages[i].name
            }).appendTo($select);
        }

        $select.val(selectedLanguage);
        $select.on("change", function() {
            var language = $select.val();
            var i;

            for (i = 0; i < languages.length; i++) {
                if (languages[i].id === language) {
                    selectedLanguage = language;
                    app.snackbar.show(
                        "Выбран язык: " + languages[i].name,
                        "success",
                        true
                    );
                    return;
                }
            }
        });
    }

    function showExit($content) {
        $('<h1>Выход из приложения</h1>')
            .appendTo($content);

        $('<p class="tv-service-note"></p>')
            .text(
                "Приложение будет закрыто. " +
                "Авторизация на устройстве сохранится."
            )
            .appendTo($content);

        $('<button type="button" ' +
            'class="tv-service-exit-button" ' +
            'data-focus-id="service-exit-confirm">' +
            'Закрыть TVAPLAY' +
          '</button>')
            .appendTo($content)
            .on('click', exitApplication);
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
                "Закрытие приложения не поддерживается",
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
                text: sections[i].title
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

        renderSection($page, activeSection);
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

