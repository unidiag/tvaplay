(function(app, $) {
    "use strict";

    var ACCESS_KEY = "tvaplay_access_token";
    var REFRESH_KEY = "tvaplay_refresh_token";

    function storageGet(key) {
        try {
            return window.localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function storageSet(key, value) {
        try {
            if (value) {
                window.localStorage.setItem(key, value);
            } else {
                window.localStorage.removeItem(key);
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    // Восстанавливаем токен после перезагрузки страницы.
    var accessToken = storageGet(ACCESS_KEY);
    var refreshPending = null;
    var tokenGeneration = 0;    

    function makeError(status, message) {
        return {
            status: status || "ERROR",
            message: message || "Неизвестная ошибка"
        };
    }

    function request(op, params) {
        if (typeof op !== "string" || !op) {
            return $.Deferred()
                .reject(makeError(
                    "INVALID_OPERATION",
                    "Некорректная операция API"
                ))
                .promise();
        }

        if (params == null) {
            params = {};
        }

        if (!$.isPlainObject(params)) {
            return $.Deferred()
                .reject(makeError(
                    "INVALID_PARAMS",
                    "Параметры API должны быть объектом"
                ))
                .promise();
        }

        // Копируем параметры, не изменяя исходный объект.
        var data = $.extend({}, params);

        data.op = op;
        data.uid = app.device.getId() || "";

        var headers = {};

        if (accessToken) {
            headers.Authorization = "Bearer " + accessToken;
        }

        var deferred = $.Deferred();

        $.ajax({
            url: "/api",
            type: "POST",
            data: JSON.stringify(data),
            contentType: "application/json; charset=utf-8",
            dataType: "json",
            headers: headers,
            timeout: 5000,
            cache: false
        })
        .done(function(response) {
            var result = response && response.data;

            if (result && result.status === "OK") {
                deferred.resolve(result);
                return;
            }

            // Сервер вернул ошибку API.
            if (result && result.status) {
                deferred.reject(makeError(
                    result.status,
                    result.message || result.status
                ));
                return;
            }

            deferred.reject(makeError(
                "INVALID_RESPONSE",
                response && response.error
                    ? response.error
                    : "Некорректный ответ API"
            ));
        })
        .fail(function(xhr, status) {
            var error;

            if (status === "timeout") {
                error = makeError(
                    "TIMEOUT",
                    "Превышено время ожидания API"
                );
            } else if (xhr && xhr.responseJSON) {
                var body = xhr.responseJSON;
                var result = body.data;

                if (result && result.status) {
                    error = makeError(
                        result.status,
                        result.message || result.status
                    );
                } else {
                    error = makeError(
                        "HTTP_ERROR",
                        body.error || "Ошибка сервера"
                    );
                }
            } else if (xhr && xhr.status) {
                error = makeError(
                    "HTTP_ERROR",
                    "HTTP ошибка: " + xhr.status
                );
            } else {
                error = makeError(
                    "NETWORK_ERROR",
                    "Ошибка соединения с сервером"
                );
            }

            deferred.reject(error);
        });

        return deferred.promise();
    }

    request.setToken = function(token) {
        accessToken = token || null;
        return storageSet(ACCESS_KEY, accessToken);
    };

    request.getToken = function() {
        return accessToken;
    };

    request.setRefreshToken = function(token) {
        return storageSet(REFRESH_KEY, token);
    };

    request.getRefreshToken = function() {
        return storageGet(REFRESH_KEY);
    };


    request.clearTokens = function() {
        // Отменяем право старого refresh-запроса
        // сохранять токены после выхода пользователя.
        tokenGeneration++;

        accessToken = null;
        storageSet(ACCESS_KEY, null);
        storageSet(REFRESH_KEY, null);
    };

    // Обновление JWT с защитой от параллельных запросов.
    request.refresh = function() {
        // Если обновление уже выполняется,
        // возвращаем тот же Promise.
        if (refreshPending) {
            return refreshPending;
        }

        var deferred = $.Deferred();
        var refreshToken = request.getRefreshToken();

        if (!refreshToken) {
            deferred.reject({
                status: "NO_REFRESH_TOKEN",
                message: "Нет сохранённой сессии"
            });

            return deferred.promise();
        }

        var generation = tokenGeneration;

        refreshPending = deferred.promise();

        request("authRefresh", {
            refresh_token: refreshToken
        })
        .done(function(data) {
            // Пока запрос выполнялся, пользователь мог
            // удалить текущую сессию и выйти на login.
            if (generation !== tokenGeneration) {
                deferred.reject({
                    status: "SESSION_CHANGED",
                    message: "Сессия была завершена"
                });
                return;
            }

            if (!data.access_token) {
                deferred.reject({
                    status: "INVALID_RESPONSE",
                    message: "Сервер не вернул access token"
                });
                return;
            }

            // Если сервер ротирует refresh JWT,
            // обязательно сохраняем новый.
            if (data.refresh_token) {
                request.setRefreshToken(data.refresh_token);
            }

            request.setToken(data.access_token);

            deferred.resolve(data);
        })
        .fail(function(error) {
            deferred.reject(error);
        })
        .always(function() {
            refreshPending = null;
        });

        return refreshPending;
    };


    app.api = request;

})(TVAPLAY, jQuery);