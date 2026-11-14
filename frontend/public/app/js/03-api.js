(function(app, $) {
    "use strict";

    function t(key, params) {
        return app.i18n && typeof app.i18n.t === "function" ?
            app.i18n.t(key, params) : String(key);
    }

    

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
    var hlsToken = null;
    var refreshPending = null;
    var tokenGeneration = 0;    


    function makeError(status, message, details) {
        var error = {
            status: status || "ERROR",
            message: message || t("api.unknown_error")
        };

        // Сохраняем дополнительные поля ответа API.
        // Например: retry_after, max_devices и другие.
        if (details && typeof details === "object") {
            $.each(details, function(key, value) {
                if (key !== "status" && key !== "message" &&
                    key !== "__proto__" &&
                    key !== "constructor" &&
                    key !== "prototype") {
                    error[key] = value;
                }
            });
        }

        return error;
    }


    function request(op, params) {
        if (typeof op !== "string" || !op) {
            return $.Deferred()
                .reject(makeError(
                    "INVALID_OPERATION",
                    t("api.invalid_operation")
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
                    t("api.invalid_params")
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
                    result.message || result.status,
                    result
                ));
                return;
            }

            deferred.reject(makeError(
                "INVALID_RESPONSE",
                response && response.error
                    ? response.error
                    : t("api.invalid_response")
            ));
        })
        .fail(function(xhr, status) {
            var error;

            if (result && result.status) {
                error = makeError(
                    result.status,
                    result.message || result.status,
                    result
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
                        body.error || t("common.server_error")
                    );
                }
            } else if (xhr && xhr.status) {
                error = makeError(
                    "HTTP_ERROR",
                    t("common.http_error", {status: xhr.status})
                );
            } else {
                error = makeError(
                    "NETWORK_ERROR",
                    t("common.network_error")
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
        hlsToken = null;
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
                message: t("api.session_missing")
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
                    message: t("api.session_ended")
                });
                return;
            }

            if (!data.access_token) {
                deferred.reject({
                    status: "INVALID_RESPONSE",
                    message: t("api.no_access_token")
                });
                return;
            }

            // Сервер может перевыпустить refresh JWT в последние
            // пять дней его действия. Сначала надёжно сохраняем
            // новый refresh JWT: старый JTI уже отозван сервером.
            if (data.refresh_token) {
                if (!request.setRefreshToken(data.refresh_token)) {
                    deferred.reject(makeError(
                        "TOKEN_STORAGE_ERROR",
                        t("login.session_save_error")
                    ));
                    return;
                }
            }

            // Не считаем refresh успешным, если access JWT
            // не удалось сохранить в localStorage.
            if (!request.setToken(data.access_token)) {
                deferred.reject(makeError(
                    "TOKEN_STORAGE_ERROR",
                    t("login.session_save_error")
                ));
                return;
            }

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




    // Текущий HLS-токен.
    request.getHLSToken = function() {
        return hlsToken;
    };

    // Удаляем HLS-токен из памяти.
    request.clearHLSToken = function() {
        hlsToken = null;
    };

    // Получаем отдельный HLS JWT.
    // Вызывается с обычным API access JWT.
    request.issueHLSToken = function() {
        var deferred = $.Deferred();
        var token = request.getToken();

        if (!token) {
            deferred.reject({
                status: "NO_ACCESS_TOKEN"
            });
            return deferred.promise();
        }

        $.ajax({
            url: "/api/hls/token",
            type: "POST",
            headers: {
                Authorization: "Bearer " + token
            },
            dataType: "json",
            timeout: 5000,
            cache: false
        })
        .done(function(data) {
            if (!data ||
                typeof data.token !== "string" ||
                !data.token) {
                deferred.reject({
                    status: "INVALID_HLS_TOKEN"
                });
                return;
            }

            hlsToken = data.token;
            deferred.resolve(data);
        })
        .fail(function(xhr, status) {
            deferred.reject({
                status: "HLS_TOKEN_ERROR",
                httpStatus: xhr ? xhr.status : 0,
                message: status || "request failed"
            });
        });

        return deferred.promise();
    };




    app.api = request;

})(TVAPLAY, jQuery);