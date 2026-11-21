/* MODULE: 99-app.js */
(function(app, $) {
    "use strict";

    function t(key, params) {
        return app.i18n && typeof app.i18n.t === "function" ?
            app.i18n.t(key, params) : String(key);
    }

    var handshakePending = false;
    var handshakeCompleted = false;
    var authorized = false;

    var tokenRefreshTimer = null;

    var TOKEN_REFRESH_INTERVAL = 8 * 60 * 1000;
    var TOKEN_REFRESH_RETRY = 60 * 1000;

    function stopTokenRefresh() {
        if (tokenRefreshTimer !== null) {
            clearTimeout(tokenRefreshTimer);
            tokenRefreshTimer = null;
        }
    }

    function scheduleTokenRefresh(delay) {
        stopTokenRefresh();

        if (!authorized) {
            return;
        }

        tokenRefreshTimer = setTimeout(function() {
            tokenRefreshTimer = null;

            if (!authorized) {
                return;
            }

            app.api.refresh()
                .done(function() {
                    if (!authorized) {
                        return;
                    }

                    // JWT обновлён. Следующее обновление
                    // через восемь минут.
                    scheduleTokenRefresh(TOKEN_REFRESH_INTERVAL);
                })
                .fail(function(error) {
                    if (!authorized) {
                        return;
                    }

                    if (error &&
                        error.status === "NO_REFRESH_TOKEN") {
                        app.api.clearTokens();
                        app.setAuthorized(false);
                        return;
                    }

                    // Ошибка сети или временная ошибка API.
                    // Сохраняем авторизацию и повторяем позже.
                    scheduleTokenRefresh(TOKEN_REFRESH_RETRY);
                });
        }, delay);
    }

    function startTokenRefresh() {
        scheduleTokenRefresh(TOKEN_REFRESH_INTERVAL);
    }











    function startHandshake() {
        if (handshakePending || handshakeCompleted) {
            return;
        }

        handshakePending = true;

        app.api("guestHandshake", {})
            .done(function(data) {
                handshakePending = false;

                // Название бренда из настроек сервера.
                setBrandName(data && data.brandname);

                // Copyright is supplied by Go in guestHandshake.
                app.loginCopyright = data &&
                    typeof data.copyright === "string" ?
                    $.trim(data.copyright) : "";
                $(".tv-login-copyright")
                    .text(app.loginCopyright)
                    .toggle(!!app.loginCopyright);

                // Версия приложения.
                if (data && data.version) {
                    app.ui.setLoginVersion(data.version);
                }

                // Синхронизация часов с сервером.
                if (data && data.time &&
                    app.clock.setTime(data.time)) {

                    app.clock.start(function(time) {
                        $("#server-clock").text(time);
                    });
                } else {
                    $("#server-clock").text("--:--:--");
                }

                // Проверка географического доступа.
                if (data.allowed !== true) {
                    var ip = data.ip || t("app.unknown_ip");
                    var country = data.country || "UNKNOWN";

                    handshakeCompleted = false;

                    $("#tv-page").empty();

                    app.snackbar.show(
                        t("app.geo_forbidden", {ip: ip, country: country}),
                        "error",
                        false
                    );

                    return;
                }

                // Доступ разрешён.
                handshakeCompleted = true;

                // Восстанавливаем авторизацию только
                // после успешной проверки IP.
                restoreSession();
            })
            .fail(function(error) {
                handshakePending = false;

                var message = error && error.message
                    ? error.message
                    : t("app.connect_error");

                $("#tv-page").html(
                    '<div class="tv-player-message">' +
                        t("app.access_check_error") +
                    '</div>'
                );

                app.snackbar.show(
                    message,
                    "error",
                    false
                );
            });
    }





    // Успешно ли выполнен handshake.
    app.isHandshakeComplete = function() {
        return handshakeCompleted;
    };

    // Авторизован ли пользователь.
    app.isAuthorized = function() {
        return authorized;
    };

    var authorizationGeneration = 0;


    app.setAuthorized = function(value) {
        var generation = ++authorizationGeneration;

        if (value !== true || !handshakeCompleted) {
            authorized = false;

            stopTokenRefresh();
            app.api.clearHLSToken();

            app.pages.open("login");
            return;
        }

        // Сначала получаем HLS-токен,
        // затем запускаем интерфейс телевизора.
        app.api.issueHLSToken()
            .done(function() {
                if (generation !==
                    authorizationGeneration) {
                    return;
                }

                authorized = true;

                startTokenRefresh();

                $(".tv-login-footer").remove();

                app.pages.open(
                    app.pages.fromHash()
                );
            })
            .fail(function(error) {
                if (generation !==
                    authorizationGeneration) {
                    return;
                }

                authorized = false;
                stopTokenRefresh();

                if (window.console && console.warn) {
                    console.warn(
                        "[TVAPLAY] HLS token error:",
                        error
                    );
                }

                app.snackbar.show(
                    "Ошибка получения HLS-токена",
                    "error",
                    true
                );

                app.pages.open("login");
            });
    };


    // Возможность повторного handshake.
    app.startHandshake = startHandshake;




    function setBrandName(value) {
        var name = typeof value === "string" ? $.trim(value) : "";

        if (!name) {
            name = "TVAPLAY";
        }

        app.name = name;
        document.title = name;

        $(".tv-brand-title").text(name);
        $(".tv-brand-logo").attr("alt", name);
    }



    function restoreSession() {
        var accessToken = app.api.getToken();
        var refreshToken = app.api.getRefreshToken();

        // Нет сохранённых токенов — обычный вход.
        if (!accessToken && !refreshToken) {
            app.pages.open('login');
            return;
        }

        function openMain() {
            app.setAuthorized(true);
        }

        function openLogin() {
            app.api.clearTokens();
            app.setAuthorized(false);
        }

        function refreshSession() {
            app.api.refresh()
                .done(function() {
                    // После обновления JWT проверяем пользователя.
                    app.api('authMe', {})
                        .done(openMain)
                        .fail(openLogin);
                })
                .fail(function(error) {
                    // При сетевой ошибке не удаляем сессию.
                    if (error &&
                        (error.status === 'NETWORK_ERROR' ||
                        error.status === 'TIMEOUT')) {
                        app.pages.open('login');
                        return;
                    }

                    openLogin();
                });
        }

        if (!accessToken) {
            refreshSession();
            return;
        }

        // Проверяем сохранённый access JWT.
        app.api('authMe', {})
            .done(openMain)
            .fail(function(error) {
                // Недоступен сервер — сохраняем сессию.
                if (error &&
                    (error.status === 'NETWORK_ERROR' ||
                    error.status === 'TIMEOUT')) {
                    app.pages.open('login');
                    return;
                }

                // Access JWT истёк — пробуем refresh.
                refreshSession();
            });
    }










    function init() {
        app.ui.init();
        app.pages.init();

        $("#server-clock").text("--:--:--");

        // Пока проверяем IP и восстанавливаем сессию,
        // не показываем форму авторизации.
        $("#tv-page").html(
            '<div class="tv-player-message">' +
                t("app.checking_access") +
            '</div>'
        );

        startHandshake();
    }




    $(function() {
        if (app.i18n && typeof app.i18n.init === "function") {
            app.i18n.init().always(function() {
                init();
            });
        } else {
            // Localization script is missing from main.js; do not crash the app.
            if (window.console && console.error) {
                console.error("TVAPLAY: 04-i18n.js is missing from main.js");
            }
            init();
        }
    });

})(TVAPLAY, jQuery);