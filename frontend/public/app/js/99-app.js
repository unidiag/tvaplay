/* MODULE: 99-app.js */
(function(app, $) {
    "use strict";

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
                    var ip = data.ip || "неизвестен";
                    var country = data.country || "UNKNOWN";

                    handshakeCompleted = false;

                    $("#tv-page").empty();

                    app.snackbar.show(
                        "Доступ запрещён по геопозиции " +
                        ip + " (" + country + ")",
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
                    : "Не удалось подключиться к серверу";

                $("#tv-page").html(
                    '<div class="tv-player-message">' +
                        'Не удалось проверить доступ к серверу' +
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

    // Вызываем после успешного подтверждения SMS-кода.
    app.setAuthorized = function(value) {
        authorized = value === true && handshakeCompleted;

        if (authorized) {
            // Запускаем фоновое обновление JWT.
            startTokenRefresh();

            $(".tv-login-footer").remove();
            app.pages.open(app.pages.fromHash());
        } else {
            // При выходе больше не обновляем токены.
            stopTokenRefresh();

            app.pages.open('login');
        }
    };

    // Возможность повторного handshake.
    app.startHandshake = startHandshake;





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
                'Проверка доступа...' +
            '</div>'
        );

        startHandshake();
    }




    $(init);

})(TVAPLAY, jQuery);