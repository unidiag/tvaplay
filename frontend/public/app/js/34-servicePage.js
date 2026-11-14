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
    function showBalanceQR() {
        // Не создаём несколько окон одновременно.
        if ($(".tv-balance-modal").length) {
            return;
        }
        var $previousFocus = $(document.activeElement);
        var $modal = $('<div>', {
            "class": "tv-balance-modal",
            role: "dialog",
            "aria-modal": "true"
        }).appendTo("body");
        var $dialog = $('<div>', {
            "class": "tv-balance-dialog"
        }).appendTo($modal);
        $('<h2>')
            .text(t("service.account.topup_title"))
            .appendTo($dialog);
        var $image = $('<img>', {
            "class": "tv-balance-qr",
            alt: t("service.account.topup_title")
        }).appendTo($dialog);
        var $status = $('<p>', {
            "class": "tv-balance-status",
            text: t("common.loading")
        }).appendTo($dialog);
        var $close = $('<button>', {
            type: "button",
            "class": "tv-balance-close",
            "data-focus-id": "balance-close",
            text: t("common.close")
        }).appendTo($dialog);
        function closeModal() {
            $(document).off("keydown.balanceQR");
            $image.off("load error");
            app.modalFocus.close($modal);
            $modal.remove();
            if ($previousFocus.length &&
                $.contains(document, $previousFocus[0])) {
                $previousFocus.focus();
            }
        }
        $close.on("click", closeModal);
        app.modalFocus.open($modal, $close);
        // Закрытие кнопкой Back / Escape.
        $(document).on("keydown.balanceQR", function(e) {
            var key = e.which || e.keyCode;
            if (key === 27 || key === 8 ||
                key === 461 || key === 10009) {
                e.preventDefault();
                e.stopPropagation();
                closeModal();
            }
        });
        $image.on("load", function() {
            $status.hide();
        });
        $image.on("error", function() {
            $status.text(t("service.account.topup_error"));
        });
        // Случайное значение против кеширования.
        var nonce = Math.floor(Math.random() * 1000000000);
        $image.attr("src", "/up_balance.jpg?r=" + nonce);
        $close.focus();
    }
    function showBalanceTransactions() {
        // Защита от повторного открытия.
        if ($(".tv-transactions-modal").length) {
            return;
        }
        var $previousFocus = $(document.activeElement);
        var request = null;
        var closed = false;
        var $modal = $('<div>', {
            "class": "tv-balance-modal tv-transactions-modal",
            role: "dialog",
            "aria-modal": "true"
        }).appendTo("body");
        var $dialog = $('<div>', {
            "class": "tv-balance-dialog tv-transactions-dialog"
        }).appendTo($modal);
        $('<h2>')
            .text(t("service.account.transactions.title"))
            .appendTo($dialog);
        var $list = $('<div>', {
            "class": "tv-transactions-list"
        }).appendTo($dialog);
        var $status = $('<p>', {
            "class": "tv-balance-status",
            text: t("common.loading")
        }).appendTo($list);
        var $close = $('<button>', {
            type: "button",
            "class": "tv-balance-close",
            "data-focus-id": "transactions-close",
            text: t("common.close")
        }).appendTo($dialog);
        function closeModal() {
            if (closed) {
                return;
            }
            closed = true;
            $(document).off("keydown.balanceTransactions");
            // Отменяем запрос, только если API поддерживает abort().
            if (request && typeof request.abort === "function") {
                request.abort();
            }
            request = null;
            app.modalFocus.close($modal);
            $modal.remove();
            // Возвращаем фокус на кнопку «Детализация».
            if ($previousFocus.length &&
                $.contains(document, $previousFocus[0])) {
                $previousFocus.focus();
            }
        }
        $close.on("click", closeModal);
        app.modalFocus.open($modal, $close);
        // Back / Escape на телевизоре и компьютере.
        $(document).on("keydown.balanceTransactions", function(e) {
            var key = e.which || e.keyCode;
            if (key === 27 || key === 8 ||
                key === 461 || key === 10009) {
                e.preventDefault();
                e.stopPropagation();
                closeModal();
            }
        });
        // Отображение суммы без float64.
        // Всегда две цифры после точки.
        function formatAmount(value) {
            var amount = $.trim(String(value || ""));
            var match = amount.match(
                /^(-?)([0-9]+)(?:\.([0-9]{1,2}))?$/
            );
            if (!match) {
                return "—";
            }
            var fraction = (match[3] || "") + "00";
            fraction = fraction.substring(0, 2);
            var isZero = /^0+$/.test(match[2]) &&
                fraction === "00";
            var sign = isZero ? "" :
                (match[1] === "-" ? "−" : "+");
            return sign + match[2] + "." + fraction;
        }
        function renderTransactions(items) {
            $list.empty();
            if (!items || !items.length) {
                $('<p>', {
                    "class": "tv-balance-status",
                    text: t("service.account.transactions.empty")
                }).appendTo($list);
                return;
            }
            $.each(items, function(index, item) {
                if (!item) {
                    return;
                }
                var amount = String(item.amount || "");
                var negative = amount.charAt(0) === "-";
                var type = String(item.type || "");
                var name = t(
                    "service.account.transactions.types." + type
                );
                if (!type ||
                    name === "service.account.transactions.types." + type) {
                    name = type || t("common.unknown");
                }
                var $row = $('<div>', {
                    "class": "tv-transaction-row"
                }).appendTo($list);
                // Дата и время слева.
                $('<span>', {
                    "class": "tv-transaction-date",
                    text: formatSessionDate(item.created_at)
                }).appendTo($row);
                // Название операции по центру.
                $('<span>', {
                    "class": "tv-transaction-name",
                    text: name
                }).appendTo($row);
                // Сумма справа.
                $('<span>', {
                    "class": "tv-transaction-amount" +
                        (negative
                            ? " tv-transaction-negative"
                            : " tv-transaction-positive"),
                    text: formatAmount(amount)
                }).appendTo($row);
            });
        }
        // Загружаем только операции авторизованного пользователя.
        request = app.api("accountTransactions", {})
            .done(function(data) {
                if (closed) {
                    return;
                }
                if (!data || !$.isArray(data.transactions)) {
                    $status.text(
                        t("service.account.transactions.error")
                    );
                    return;
                }
                renderTransactions(data.transactions);
            })
            .fail(function(error) {
                if (closed) {
                    return;
                }
                $status.text(
                    error && error.message
                        ? error.message
                        : t("service.account.transactions.error")
                );
            });
        $close.focus();
    }
    // Обновляет личный кабинет после изменения
    // статуса абонента или подключённых пакетов.
    function refreshAccount($content, focusId) {
        if (activeSection !== "account" ||
            !$content ||
            !$content.length ||
            !$.contains(document, $content[0])) {
            return;
        }
        // Удаляем старые данные.
        $content.empty();
        // Повторно запрашиваем accountInfo.
        showAccount($content, focusId);
    }
    function showAccount($content, focusId) {
        $('<h1>')
            .text(t("service.sections.account"))
            .appendTo($content);
        var $info = $('<div></div>').appendTo($content);
        var $loading = $('<p class="tv-service-note"></p>')
            .text(t("common.loading"))
            .appendTo($info);
        var requestContent = $content[0];
        function isActive() {
            return activeSection === "account" &&
                $.contains(requestContent, $info[0]);
        }
        app.api("accountInfo", {})
            .done(function(data) {
                if (!isActive()) {
                    return;
                }
                $info.empty();



                // Нижняя надпись личного кабинета.
                var copyright = String(data.copyright || "");

                // Удаляем предыдущую надпись, если она существует.
                var $service = $content.closest(".tv-service");

                $service.find(".tv-account-copyright").remove();

                if ($.trim(copyright) !== "") {
                    // Разрешаем только теги <b> и </b>.
                    // Остальной HTML выводится безопасно как текст.
                    var safeHTML = $("<div>")
                        .text(copyright)
                        .html()
                        .replace(/&lt;b&gt;/gi, "<b>")
                        .replace(/&lt;\/b&gt;/gi, "</b>");

                    $("<div>", {
                        "class": "tv-account-package-price tv-account-copyright"
                    })
                        .html(safeHTML)
                        .appendTo($service);
                }


                var balance = t("common.no_data");
                if (data.balance !== null &&
                    data.balance !== undefined) {
                    balance = String(data.balance);
                    if (data.currency) {
                        balance += " " + data.currency;
                    }
                }
                var $phoneRow = $(
                    '<div class="tv-service-info-row tv-account-phone-row"></div>'
                ).appendTo($info);
                var $phoneInfo = $(
                    '<div class="tv-account-phone-info"></div>'
                ).appendTo($phoneRow);
                $('<div class="tv-service-info-label"></div>')
                    .text(t("service.account.phone"))
                    .appendTo($phoneInfo);
                var $phoneValue = $(
                    '<div class="tv-service-info-value"></div>'
                ).appendTo($phoneInfo);
                // Номер телефона.
                $('<span></span>')
                    .text(data.phone || t("common.no_data"))
                    .appendTo($phoneValue);
                // Идентификатор абонента во внешнем биллинге.
                // Показываем рядом с телефоном, если задан.
                // Идентификатор лицевого счёта во внешнем биллинге.
                // Лицевой счёт во внешнем биллинге.
                var billingID = data.billing_id;
                var billingText = t("service.account.billing_id") + ": ";
                if (billingID !== null &&
                    billingID !== undefined &&
                    Number(billingID) > 0) {
                    billingText += String(billingID);
                } else {
                    billingText += t("service.account.billing_id_not_found");
                }
                $('<span class="tv-account-package-price"></span>')
                    .text(" (" + billingText + ")")
                    .appendTo($phoneValue);
                var $logoutButton = $('<button>', {
                    type: "button",
                    "class": "tv-account-logout-button",
                    "data-focus-id": "account-logout",
                    text: t("service.account.logout")
                }).appendTo($phoneRow);
                $logoutButton.on("click", function() {
                    accountLogout($logoutButton);
                });
                // Дополнительная информация об абоненте.
                // Показываем отдельной строкой только при наличии текста.
                if (data.info !== null &&
                    data.info !== undefined &&
                    $.trim(String(data.info)) !== "") {
                    addInfo(
                        $info,
                        t("service.account.info"),
                        $.trim(String(data.info))
                    );
                }
                var $balanceRow = $(
                    '<div class="tv-service-info-row tv-account-balance-row"></div>'
                ).appendTo($info);
                var $balanceInfo = $(
                    '<div class="tv-account-balance-info"></div>'
                ).appendTo($balanceRow);
                $('<div class="tv-service-info-label"></div>')
                    .text(t("service.account.balance"))
                    .appendTo($balanceInfo);
                var $balanceValue = $(
                    '<div class="tv-service-info-value"></div>'
                ).appendTo($balanceInfo);
                // Текущий баланс.
                $('<span></span>')
                    .text(balance)
                    .appendTo($balanceValue);
                // Ежедневная абонентская плата.
                if (data.daily_charge !== null &&
                    data.daily_charge !== undefined &&
                    data.daily_charge !== "") {
                    var dailyCharge = Number(data.daily_charge);
                    if (isFinite(dailyCharge) && dailyCharge >= 0) {
                        $('<span class="tv-account-package-price"></span>')
                            .text(
                                " (" + dailyCharge.toFixed(2) +
                                " " + (data.currency || "руб") +
                                "/" + t("service.account.day") + ")"
                            )
                            .appendTo($balanceValue);
                    }
                }
                var $topupButton = $('<button>', {
                    type: "button",
                    "class": "tv-account-topup-button",
                    "data-focus-id": "account-topup",
                    text: t("service.account.topup")
                }).appendTo($balanceRow);
                $topupButton.on("click", function() {
                    showBalanceQR();
                });
                // Кнопка детализации баланса.
                var $transactionsButton = $('<button>', {
                    type: "button",
                    "class": "tv-account-transactions-button",
                    "data-focus-id": "account-transactions",
                    text: t("service.account.transactions.button")
                }).appendTo($balanceRow);
                $transactionsButton.on("click", function() {
                    showBalanceTransactions();
                });
                var $packagesRow = $(
                    '<div class="tv-service-info-row"></div>'
                ).appendTo($info);
                $('<div class="tv-service-info-label"></div>')
                    .text(t("service.account.packages"))
                    .appendTo($packagesRow);
                var $packagesValue = $(
                    '<div class="tv-service-info-value"></div>'
                ).appendTo($packagesRow);
                if ($.isArray(data.packages) && data.packages.length) {
                    var shown = 0;
                    $.each(data.packages, function(i, pkg) {
                        if (!pkg || !pkg.name) {
                            return;
                        }
                        var $item;
                        if (pkg.optional === true) {
                            // Весь пакет становится фокусируемым.
                            // Label позволяет переключать checkbox
                            // нажатием на любую часть строки.
                            $item = $('<label>', {
                                "class": "tv-account-package-item tv-account-package-selectable",
                                tabindex: 0,
                                "data-focus-id": "account-package-" + pkg.id
                            }).appendTo($packagesValue);
                        } else {
                            // Обязательный пакет — только отображение.
                            $item = $(
                                '<div class="tv-account-package-item"></div>'
                            ).appendTo($packagesValue);
                        }
                        var $checkbox = null;
                        if (pkg.optional === true) {
                            $checkbox = $('<input>', {
                                type: "checkbox",
                                "class": "tv-account-package-checkbox",
                                tabindex: -1
                            }).appendTo($item);
                            $checkbox.prop("checked", pkg.selected === true);
                            // Сохраняем изменение на сервере.
                            $checkbox.on("change", function() {
                                var $control = $(this);
                                var previous = !$control.prop("checked");
                                var next = $control.prop("checked");
                                // Запрещаем повторные нажатия
                                // до завершения запроса.
                                $control.prop("disabled", true);
                                app.api("accountPackageToggle", {
                                    package_id: String(pkg.id),
                                    enabled: next ? "1" : "0"
                                })
                                .done(function(result) {
                                    var selected = result.selected === true;
                                    $control.prop("checked", selected);
                                    pkg.selected = selected;
                                    app.snackbar.show(
                                        selected
                                            ? t("service.account.package_enabled")
                                            : t("service.account.package_disabled"),
                                        "success",
                                        true
                                    );
                                    // Перезагружаем данные личного кабинета,
                                    // включая новую ежедневную стоимость.
                                    refreshAccount(
                                        $content,
                                        "account-package-" + pkg.id
                                    );
                                })
                                .fail(function(error) {
                                    // При ошибке восстанавливаем
                                    // прежнее состояние чекбокса.
                                    $control.prop("checked", previous);
                                    if (error &&
                                        error.status === "PACKAGE_DISABLE_LIMIT") {
                                        $control.prop("checked", true);
                                        app.snackbar.show(
                                            error.disable_available_at
                                                ? t("service.account.package_disable_available_from", {
                                                    date: error.disable_available_at
                                                })
                                                : t("service.account.package_save_error"),
                                            "warning",
                                            true
                                        );
                                        return;
                                    }
                                    app.snackbar.show(
                                        error && error.message
                                            ? error.message
                                            : t("service.account.package_save_error"),
                                        "error",
                                        true
                                    );
                                })
                                .always(function() {
                                    $control.prop("disabled", false);
                                });
                            });
                        }
                        $('<span class="tv-account-package-name"></span>')
                            .text(pkg.name)
                            .appendTo($item);
                        if (pkg.monthly_price !== null &&
                            pkg.monthly_price !== undefined &&
                            pkg.monthly_price !== "") {
                            $('<span class="tv-account-package-price"></span>')
                                .text("(" + pkg.monthly_price +
                                    (data.currency ? " " + data.currency + "/" + t("service.account.month") : "") + ")")
                                .appendTo($item);
                        }
                        if (pkg.channel_count !== null &&
                            pkg.channel_count !== undefined) {
                            $('<span class="tv-account-package-count"></span>')
                                .text(t("service.account.channels_short", {
                                    count: pkg.channel_count
                                }))
                                .appendTo($item);
                        }
                        shown++;
                    });
                    if (!shown) {
                        $packagesValue.text(t("common.no_data"));
                    }
                } else {
                    $packagesValue.text(t("common.no_data"));
                }
                var statusNames = {
                    "0": "inactive",
                    "1": "active",
                    "2": "premium"
                };
                var statusCode = String(data.user_status);
                var pauseAvailable = data.pause_available === true;
                var pauseNextDate = String(data.pause_next_date || "");
                var $statusRow = $(
                    '<div class="tv-service-info-row tv-account-status-row"></div>'
                ).appendTo($info);
                var $statusInfo = $(
                    '<div class="tv-account-status-info"></div>'
                ).appendTo($statusRow);
                $('<div class="tv-service-info-label"></div>')
                    .text(t("service.account.status"))
                    .appendTo($statusInfo);
                var $statusValue = $(
                    '<div class="tv-service-info-value"></div>'
                ).appendTo($statusInfo);
                var $pauseButton = null;
                function updateAccountStatus() {
                    var statusKey = statusNames[statusCode];
                    var statusText = statusKey
                        ? t("service.account.statuses." + statusKey)
                        : t("common.unknown");
                    // Для Премиум показываем процент скидки.
                    if (statusCode === "2") {
                        var discount = Number(data.discount);
                        if (data.discount !== null &&
                            data.discount !== undefined &&
                            data.discount !== "" &&
                            isFinite(discount) &&
                            discount > 0 &&
                            discount <= 100) {
                            statusText += " (-" + discount + "%)";
                        }
                    }
                    $statusValue.text(statusText);
                    if ($pauseButton) {
                        var paused = statusCode === "0";
                        $pauseButton
                            .text(
                                paused
                                    ? t("service.account.resume")
                                    : t("service.account.pause")
                            )
                            .toggleClass(
                                "tv-account-resume-button",
                                paused
                            );
                    }
                }
                // Управление доступно только для статусов 0 и 1.
                if (statusCode === "0" || statusCode === "1") {
                    $pauseButton = $('<button>', {
                        type: "button",
                        "class": "tv-account-pause-button",
                        "data-focus-id": "account-pause"
                    }).appendTo($statusRow);
                    $pauseButton.on("click", function() {
                        if ($pauseButton.prop("disabled")) {
                            return;
                        }
                        var action = statusCode === "1"
                            ? "pause"
                            : "resume";
                        // Лимит постановки на паузу уже использован.
                        // Кнопку оставляем видимой.
                        if (action === "pause" && !pauseAvailable) {
                            app.snackbar.show(
                                pauseNextDate
                                    ? t("service.account.pause_available_from", {
                                        date: pauseNextDate
                                    })
                                    : t("service.account.status_save_error"),
                                "warning",
                                true
                            );
                            return;
                        }
                        $pauseButton.prop("disabled", true);
                        app.api("accountPauseToggle", {
                            action: action
                        })
                        .done(function(result) {
                            var next = String(result.user_status);
                            if (next !== "0" && next !== "1") {
                                app.snackbar.show(
                                    t("service.account.status_save_error"),
                                    "error",
                                    true
                                );
                                return;
                            }
                            statusCode = next;
                            pauseAvailable = result.pause_available === true;
                            updateAccountStatus();
                            app.snackbar.show(
                                statusCode === "0"
                                    ? t("service.account.paused")
                                    : t("service.account.resumed"),
                                "success",
                                true
                            );
                            // Повторно загружаем accountInfo.
                            // Обновятся статус и ежедневная стоимость.
                            refreshAccount(
                                $content,
                                "account-pause"
                            );
                        })
                        .fail(function(error) {
                            if (error && error.status === "INSUFFICIENT_BALANCE") {
                                app.snackbar.show(
                                    action === "resume"
                                        ? t("service.account.resume_balance_required")
                                        : t("service.account.pause_balance_required"),
                                    "warning",
                                    true
                                );
                                return;
                            }                        
                            if (error && error.status === "PAUSE_LIMIT") {
                                pauseAvailable = false;
                                if (error.pause_next_date) {
                                    pauseNextDate = String(
                                        error.pause_next_date
                                    );
                                }
                                app.snackbar.show(
                                    pauseNextDate
                                        ? t("service.account.pause_available_from", {
                                            date: pauseNextDate
                                        })
                                        : t("service.account.status_save_error"),
                                    "warning",
                                    true
                                );
                                return;
                            }
                            app.snackbar.show(
                                error && error.message
                                    ? error.message
                                    : t("service.account.status_save_error"),
                                "error",
                                true
                            );
                        })
                        .always(function() {
                            $pauseButton.prop("disabled", false);
                        });
                    });
                }
                updateAccountStatus();
                // Восстанавливаем фокус после обновления
                // для удобства управления с пульта Smart TV.
                if (focusId) {
                    $info.find('[data-focus-id="' + focusId + '"]')
                        .first()
                        .focus();
                }
            })
            .fail(function(error) {
                if (!isActive()) {
                    return;
                }
                $loading.text(
                    error && error.message
                        ? error.message
                        : t("common.network_error")
                );
            });
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
    function accountLogout($button) {
        // Получаем список устройств текущего абонента.
        $button.prop("disabled", true);
        app.api("accountDevices", {})
            .done(function(data) {
                var current = null;
                var devices = data.devices || [];
                var i;
                for (i = 0; i < devices.length; i++) {
                    if (devices[i].uid === app.device.getId()) {
                        current = devices[i];
                        break;
                    }
                }
                if (!current) {
                    app.snackbar.show(
                        t("service.devices.sessions_error"),
                        "error",
                        true
                    );
                    $button.prop("disabled", false);
                    return;
                }
                // Используем существующую логику удаления.
                revokeDevice(current, $button);
            })
            .fail(function(error) {
                app.snackbar.show(
                    error && error.message
                        ? error.message
                        : t("service.devices.sessions_error"),
                    "error",
                    true
                );
                $button.prop("disabled", false);
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

        // ============================================
        // Тема оформления TV UI
        // ============================================

        var $themeRow = $('<div>', {
            "class": "tv-service-info-row"
        }).appendTo($content);

        var themeLabel = t("service.settings.theme");

        if (themeLabel === "service.settings.theme") {
            themeLabel = "Тема оформления";
        }

        $('<label>', {
            "class": "tv-service-info-label",
            "for": "tv-service-theme",
            text: themeLabel
        }).appendTo($themeRow);

        var $themeSelect = $('<select>', {
            id: "tv-service-theme",
            "class": "tv-service-language-select",
            "data-focus-id": "service-theme"
        }).appendTo($themeRow);

        // Получаем темы из 00-core.js.
        $.each(app.theme.list(), function(index, theme) {
            $('<option>', {
                value: theme.id,
                text: theme.label
            }).appendTo($themeSelect);
        });

        // Отображаем выбранную тему.
        $themeSelect.val(app.theme.get());

        // Смена темы без перезагрузки страницы.
        $themeSelect.on("change", function() {
            var selected = $themeSelect.val();

            if (!app.theme.set(selected)) {
                $themeSelect.val(app.theme.get());
            }
        });


        // ============================================
        // Выбор движка воспроизведения
        // ============================================
        var PLAYER_MODE_KEY = "tvaplay_player_mode";
        // Строка настройки под выбором языка.
        var $playerRow = $('<div>', {
            "class": "tv-service-info-row"
        }).appendTo($content);
        $('<label>', {
            "class": "tv-service-info-label",
            "for": "tv-service-player",
            text: t("service.settings.player")
        }).appendTo($playerRow);
        var $playerSelect = $('<select>', {
            id: "tv-service-player",
            "class": "tv-service-language-select",
            "data-focus-id": "service-player"
        }).appendTo($playerRow);
        // Создаём варианты в соответствии с переводами.
        $('<option>', {
            value: "auto",
            text: t("service.settings.player_auto")
        }).appendTo($playerSelect);
        $('<option>', {
            value: "hlsjs",
            text: t("service.settings.player_hlsjs")
        }).appendTo($playerSelect);
        $('<option>', {
            value: "html5",
            text: t("service.settings.player_html5")
        }).appendTo($playerSelect);
        // Читаем ранее сохранённый режим.
        var savedPlayerMode = "auto";
        try {
            savedPlayerMode = window.localStorage.getItem(
                PLAYER_MODE_KEY
            ) || "auto";
        } catch (e) {
            savedPlayerMode = "auto";
        }
        // Защита от неизвестных значений.
        if (savedPlayerMode !== "auto" &&
            savedPlayerMode !== "hlsjs" &&
            savedPlayerMode !== "html5") {
            savedPlayerMode = "auto";
        }
        $playerSelect.val(savedPlayerMode);
        // Сохраняем выбранное значение.
        $playerSelect.on("change", function() {
            var previous = savedPlayerMode;
            var mode = String($playerSelect.val() || "auto");
            try {
                window.localStorage.setItem(
                    PLAYER_MODE_KEY,
                    mode
                );
                savedPlayerMode = mode;
                app.snackbar.show(
                    t("service.settings.player_selected"),
                    "success",
                    true
                );
            } catch (e) {
                $playerSelect.val(previous);
                app.snackbar.show(
                    t("service.settings.player_save_error"),
                    "error",
                    true
                );
            }
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

        // Убираем надпись при смене раздела.
        $page.find(".tv-account-copyright").remove();

        $page.toggleClass(
            "tv-service-account-active",
            section === "account"
        );


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
