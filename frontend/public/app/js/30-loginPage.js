(function(app, $) {
    "use strict";
    function t(key, params) {
        return app.i18n && typeof app.i18n.t === "function" ?
            app.i18n.t(key, params) : String(key);
    }


    var LAST_PHONE_KEY = "tvaplay_last_phone";

    // Получаем номер последней успешной авторизации.
    function getLastPhone() {
        try {
            return window.localStorage.getItem(LAST_PHONE_KEY) || "";
        } catch (e) {
            return "";
        }
    }

    // Сохраняем номер в международном формате E.164.
    function saveLastPhone(phone) {
        try {
            window.localStorage.setItem(LAST_PHONE_KEY, phone);
            return true;
        } catch (e) {
            return false;
        }
    }



    var authErrorKeys = {
        GEO_BLOCKED: "login.errors.geo_blocked",
        INVALID_PHONE: "login.invalid_phone",
        INVALID_UID: "login.errors.invalid_uid",
        INVALID_CODE: "login.errors.invalid_code",
        CODE_EXPIRED: "login.errors.code_expired",
        TOO_MANY_ATTEMPTS: "login.errors.too_many_attempts",
        MAX_DEVICES: "login.errors.max_devices",
        SMS_COOLDOWN: "login.errors.sms_cooldown",
        SMS_GATEWAY_ERROR: "login.errors.sms_gateway_error",
        DB_ERROR: "login.errors.db_error",
        INTERNAL_ERROR: "login.errors.internal_error",
        AUTH_ERROR: "login.errors.auth_error",
        CONFIG_ERROR: "login.errors.config_error"
    };
    function apiErrorData(error) {
        if (error && error.responseJSON) {
            return error.responseJSON;
        }
        if (error && error.response && typeof error.response === "object") {
            return error.response;
        }
        return error || {};
    }
    function getAuthError(error, fallbackKey) {
        var data = apiErrorData(error);
        var status = data.status || (error && error.status);
        var key = authErrorKeys[status] || fallbackKey || "common.server_error";
        var params = {};
        if (status === "SMS_COOLDOWN") {
            var seconds = Number(data.retry_after);

            if (isFinite(seconds) && seconds >= 0 &&
                data.retry_after != null &&
                data.retry_after !== "") {

                params.seconds = Math.ceil(seconds);
            } else {
                return t("login.errors.sms_cooldown_unknown");
            }
        }
        if (status === "MAX_DEVICES") {
            params.max = data.max_devices != null ? data.max_devices : "";
        }
        return t(key, params);
    }
    function digitsOnly(value) {
        return String(value || "").replace(/\D/g, "");
    }
    function countDigits(value) {
        return digitsOnly(value).length;
    }
    // Выводим маску только для однозначно распознаваемого формата:
    // ^\\+375(25|29|33|44)[0-9]{7}$ -> +375 (XX) XXX-XX-XX
    // Сложные регулярные выражения остаются без маски, но валидируются API regex.

    function subscriberMask(length) {
        var groups = {
            5: [1, 2, 2],
            6: [2, 2, 2],
            7: [3, 2, 2],
            8: [4, 4],
            9: [3, 3, 3],
            10: [3, 3, 4]
        };

        var sizes = groups[length];
        var parts = [];
        var i;

        if (!sizes) {
            return new Array(length + 1).join("X");
        }

        for (i = 0; i < sizes.length; i++) {
            parts.push(
                new Array(sizes[i] + 1).join("X")
            );
        }

        return parts.join("-");
    }



    function createPhoneFormat(regexSource) {
        var source = String(regexSource || "");

        var result = {
            mask: "",
            prefix: "",
            prefixDigits: "",
            maxDigits: 15,
            enabled: false
        };

        var match;
        var prefix;
        var operatorLength = 0;
        var restLength;
        var operators;
        var i;

        // 1. Извлекаем код страны: +375, +7 и т.д.
        match = /^\^\\\+([0-9]+)/.exec(source);

        if (!match) {
            return result;
        }

        prefix = "+" + match[1];
        source = source.substring(match[0].length);

        // 2. Разбираем код оператора.
        // Беларусь: (25|29|33|44)
        // Россия:   (9[0-9]{2})

        match = /^\(([0-9]+(?:\|[0-9]+)+)\)/.exec(source);

        if (match) {
            operators = match[1].split("|");
            operatorLength = operators[0].length;

            for (i = 0; i < operators.length; i++) {
                if (operators[i].length !== operatorLength) {
                    return result;
                }
            }

            source = source.substring(match[0].length);

        } else {
            // Например: (9[0-9]{2}) -> 3 цифры
            match = /^\(([0-9]+)\[0-9\]\{([0-9]+)\}\)/.exec(source);

            if (match) {
                operatorLength =
                    match[1].length + parseInt(match[2], 10);

                source = source.substring(match[0].length);
            } else {
                return result;
            }
        }

        // 3. Длина абонентского номера.
        match = /^(?:\[0-9\]|\\d)\{([0-9]+)\}\$$/.exec(source);

        if (!match) {
            return result;
        }

        restLength = parseInt(match[1], 10);

        // Ограничения международного формата E.164.
        if (restLength < 1 ||
            restLength > 12 ||
            operatorLength < 1 ||
            prefix.length - 1 + operatorLength + restLength > 15) {
            return result;
        }

        // 4. Формируем маску.
        result.prefix = prefix;
        result.prefixDigits = digitsOnly(prefix);

        result.maxDigits =
            result.prefixDigits.length +
            operatorLength +
            restLength;

        result.mask =
            prefix +
            " (" +
            new Array(operatorLength + 1).join("X") +
            ") " +
            subscriberMask(restLength);

        result.enabled = true;

        return result;
    }



    // Возвращает канонический E.164 без пробелов/скобок.
    // При включённой маске допустимы как +37529..., так и 29... .
    function normalizePhone(value, format) {
        var raw = String(value || "");
        var digits = digitsOnly(raw);
        var prefix = format.prefixDigits;
        if (!format.enabled) {
            return raw.charAt(0) === "+" ?
                "+" + digits.substring(0, 15) : digits.substring(0, 15);
        }
        if (digits.indexOf(prefix + prefix) === 0) {
            // Вставка полного номера прямо после уже заполненного +375.
            digits = digits.substring(prefix.length);
        }
        if (digits.indexOf(prefix) === 0) {
            return "+" + digits.substring(0, format.maxDigits);
        }
        // Вставка национальной части без международного префикса.
        return "+" + (prefix + digits).substring(0, format.maxDigits);
    }
    // Опережающее форматирование: после завершения группы сразу
    // добавляем следующий разделитель, даже если следующей цифры ещё нет.
    function formatPhone(number, format) {
        var digits = digitsOnly(number);
        var mask = format.mask;
        var result = "";
        var digitPos = 0;
        var i;
        var ch;
        if (!format.enabled) {
            return number;
        }
        for (i = 0; i < mask.length; i++) {
            ch = mask.charAt(i);
            if (ch === "X" || /[0-9]/.test(ch)) {
                if (digitPos >= digits.length) {
                    break;
                }
                result += digits.charAt(digitPos++);
            } else {
                // После последней введённой цифры автоматически
                // дописываем все разделители до следующего слота.
                result += ch;
            }
        }
        return result;
    }
    // Ставим курсор после группы цифр и автоматически добавленных
    // разделителей, чтобы набор сразу продолжался в следующей группе.
    function caretAfterDigits(text, digitCount) {
        var i;
        var seen = 0;
        if (digitCount <= 0) {
            return 0;
        }
        for (i = 0; i < text.length; i++) {
            if (/\d/.test(text.charAt(i))) {
                seen++;
                if (seen >= digitCount) {
                    i++;
                    while (i < text.length && !/\d/.test(text.charAt(i))) {
                        i++;
                    }
                    return i;
                }
            }
        }
        return text.length;
    }
    function getSelection(input) {
        try {
            if (typeof input.selectionStart === "number" &&
                typeof input.selectionEnd === "number") {
                return { start: input.selectionStart, end: input.selectionEnd };
            }
        } catch (ignore) {}
        return null;
    }
    function setCaret(input, position) {
        try {
            if (typeof input.setSelectionRange === "function") {
                input.setSelectionRange(position, position);
            }
        } catch (ignore) {
            // Некоторые браузеры Smart TV не поддерживают управление курсором.
        }
    }
    function show($root) {
        var sending = false;
        var confirming = false;
        var phonePattern = null;
        var phoneConfigLoaded = false;
        var phoneFormat = createPhoneFormat("");
        var $code = null;
        var $page = $('<div class="tv-login-page"></div>').appendTo($root);
        var $form = $('<form class="tv-login-form"></form>').appendTo($page);
        var $description = $('<p class="tv-login-description"></p>')
            .text(t("login.phone_prompt")).appendTo($form);
        var $phone = $("<input>", {
            type: "tel",
            "class": "tv-login-phone",
            id: "login-phone",
            autocomplete: "tel",
            maxlength: 16,
            "data-focus-id": "login-phone"
        }).appendTo($form);
        var $button = $("<button>", {
            type: "submit",
            "class": "tv-login-submit",
            "data-focus-id": "login-submit",
            text: t("login.send_code"),
            disabled: true
        }).appendTo($form);
        function normalizedPhone() {
            return normalizePhone($phone.val(), phoneFormat);
        }
        function isValidPhone(value) {
            if (!phoneConfigLoaded || !phonePattern) {
                return false;
            }
            if (!/^\+[1-9][0-9]{7,14}$/.test(value)) {
                return false;
            }
            phonePattern.lastIndex = 0;
            return phonePattern.test(value);
        }
        function updateButton() {
            var number = normalizedPhone();
            var valid = isValidPhone(number);
            var hasInput = phoneFormat.enabled ?
                countDigits(number) > phoneFormat.prefixDigits.length :
                countDigits(number) >= 8;
            $phone.toggleClass("tv-login-phone-invalid", hasInput &&
                phoneConfigLoaded && !valid &&
                (phoneFormat.enabled ?
                    countDigits(number) >= phoneFormat.maxDigits : true));
            $button.prop("disabled", sending || !valid || !phoneConfigLoaded);
        }
        function renderPhone(value, digitsBeforeCaret) {
            var canonical = normalizePhone(value, phoneFormat);
            var formatted = formatPhone(canonical, phoneFormat);
            var minCaret = phoneFormat.enabled ?
                caretAfterDigits(formatted, phoneFormat.prefixDigits.length) : 0;
            var caret = caretAfterDigits(formatted, digitsBeforeCaret);
            $phone.val(formatted);
            if (phoneFormat.enabled) {
                setCaret($phone[0], Math.max(minCaret, caret));
            }
            updateButton();
        }
        function loadPhoneConfig() {
            phoneConfigLoaded = false;
            phonePattern = null;
            updateButton();
            app.api("guestPhoneConfig", {})
                .done(function(data) {
                    try {
                        if (!data || !data.phone_regex) {
                            throw new Error("Missing phone regex");
                        }

                        phonePattern = new RegExp(data.phone_regex);
                        phoneFormat = createPhoneFormat(data.phone_regex);
                        phoneConfigLoaded = true;

                        // Берём последний номер только если пользователь
                        // ещё не начал вводить другой.
                        var savedPhone = getLastPhone();
                        var currentPhone = $phone.val();
                        var initialPhone = currentPhone;

                        if (!initialPhone && savedPhone &&
                            isValidPhone(savedPhone)) {
                            initialPhone = savedPhone;
                        }

                        if (phoneFormat.enabled) {
                            $phone.attr("placeholder", phoneFormat.mask);
                            $phone.attr("maxlength", 48);

                            // Если сохранённого номера нет, показываем
                            // начальный префикс, например +375 (
                            renderPhone(
                                initialPhone || phoneFormat.prefix,
                                countDigits(
                                    initialPhone || phoneFormat.prefix
                                )
                            );
                        } else {
                            $phone.attr(
                                "placeholder",
                                "+XXX YY ZZZZZZZ"
                            );
                            $phone.attr("maxlength", 16);

                            if (initialPhone) {
                                $phone.val(initialPhone);
                            }

                            updateButton();
                        }

                    } catch (error) {
                        phoneConfigLoaded = false;
                        phonePattern = null;
                        app.snackbar.show(t("login.errors.config_error"), "error", true);
                    }
                })
                .fail(function(error) {
                    app.snackbar.show(
                        getAuthError(error, "login.errors.config_load_error"),
                        "error", true
                    );
                });
        }
        // Обработка Backspace/Delete рядом с разделителями маски.
        // Если браузер не поддерживает selectionStart, стандартное
        // редактирование продолжит работать с нормализацией по input.
        $phone.on("keydown", function(event) {
            var key = event.which || event.keyCode;
            var input = $phone[0];
            var selection = getSelection(input);
            var text = $phone.val();
            var startDigits;
            var endDigits;
            var digits;
            var removeIndex;
            var minDigits = phoneFormat.prefixDigits.length;
            if (!phoneFormat.enabled || !selection ||
                (key !== 8 && key !== 46)) {
                return;
            }
            startDigits = countDigits(text.substring(0, selection.start));
            endDigits = countDigits(text.substring(0, selection.end));
            digits = digitsOnly(text);
            if (selection.start !== selection.end) {
                // Удаляем выделенные редактируемые цифры, не трогая префикс.
                startDigits = Math.max(minDigits, startDigits);
                endDigits = Math.max(minDigits, endDigits);
                digits = digits.substring(0, startDigits) + digits.substring(endDigits);
                event.preventDefault();
                renderPhone("+" + digits, startDigits);
                return;
            }
            removeIndex = key === 8 ? startDigits - 1 : startDigits;
            if (removeIndex < minDigits || removeIndex >= digits.length) {
                event.preventDefault();
                setCaret(input, caretAfterDigits(text, minDigits));
                return;
            }
            digits = digits.substring(0, removeIndex) +
                digits.substring(removeIndex + 1);
            event.preventDefault();
            renderPhone("+" + digits, removeIndex);
        });
        $phone.on("input", function() {
            var selection = getSelection($phone[0]);
            var raw = $phone.val();
            var digitPosition = selection ?
                countDigits(raw.substring(0, selection.start)) : countDigits(raw);
            var rawDigits = digitsOnly(raw);
            var prefix = phoneFormat.prefixDigits;
            if (phoneFormat.enabled) {
                if (rawDigits.indexOf(prefix + prefix) === 0) {
                    digitPosition = Math.max(prefix.length,
                        digitPosition - prefix.length);
                } else if (rawDigits.indexOf(prefix) !== 0) {
                    // При вставке национального номера добавляем префикс.
                    // Если удаляли фиксированный префикс — восстанавливаем.
                    digitPosition += prefix.length;
                }
                digitPosition = Math.max(prefix.length, digitPosition);
                renderPhone(raw, digitPosition);
            } else {
                var normalized = normalizedPhone();
                if (raw !== normalized) {
                    $phone.val(normalized);
                }
                updateButton();
            }
        });
        function showCodeInput() {
            $phone.prop("disabled", true);
            $button.remove();
            $description.text(t("login.code_prompt"));
            $code = $("<input>", {
                type: "tel",
                "class": "tv-login-code",
                id: "login-code",
                placeholder: "0000",
                maxlength: 4,
                autocomplete: "one-time-code",
                "data-focus-id": "login-code"
            }).appendTo($form);
            $code.focus();
            $code.on("input", function() {
                var value = digitsOnly($code.val()).substring(0, 4);
                if ($code.val() !== value) {
                    $code.val(value);
                }
                if (value.length === 4 && !confirming) {
                    confirmCode(value);
                }
            });
        }
        function confirmCode(code) {
            if (confirming) {
                return;
            }
            confirming = true;
            $code.prop("disabled", true);
            app.api("guestConfirmcode", {
                phone: normalizedPhone(),
                code: code
            })
            .done(function(data) {
                if (!data.access_token) {
                    app.snackbar.show(t("login.no_access_token"), "error", true);
                    $code.prop("disabled", false).val("").focus();
                    return;
                }
                if (!data.refresh_token) {
                    app.snackbar.show(t("login.no_refresh_token"), "error", true);
                    $code.prop("disabled", false).val("").focus();
                    return;
                }
                var accessSaved = app.api.setToken(data.access_token);
                var refreshSaved = app.api.setRefreshToken(data.refresh_token);

                if (!accessSaved || !refreshSaved) {
                    app.snackbar.show(
                        t("login.session_save_error"),
                        "error",
                        true
                    );

                    $code.prop("disabled", false).val("").focus();
                    return;
                }

                // SMS-код подтверждён, JWT сохранены.
                // Запоминаем номер последней авторизации.
                saveLastPhone(normalizedPhone());

                // Завершаем авторизацию.
                app.setAuthorized(true);

            })
            .fail(function(error) {
                app.snackbar.show(getAuthError(error, "login.code_error"), "error", true);
                $code.prop("disabled", false).val("").focus();
            })
            .always(function() {
                confirming = false;
            });
        }
        $form.on("submit", function(event) {
            event.preventDefault();
            if (sending || $code) {
                return;
            }
            if (!app.isHandshakeComplete || !app.isHandshakeComplete()) {
                app.snackbar.show(t("login.no_server"), "error", true);
                return;
            }
            var phone = normalizedPhone();
            if (!isValidPhone(phone)) {
                app.snackbar.show(t("login.invalid_phone"), "error", true);
                $phone.focus();
                return;
            }
            sending = true;
            updateButton();
            $button.text(t("login.sending"));
            app.api("guestSendcode", { phone: phone })
                .done(function() {
                    app.snackbar.show(t("login.code_sent"), "success", true);
                    showCodeInput();
                })
                .fail(function(error) {
                    var status = apiErrorData(error).status;
                    var message = getAuthError(error, "login.send_error");
                    app.snackbar.show(
                        message,
                        status === "MAX_DEVICES" ? "warning" : "error",
                        true
                    );
                })
                .always(function() {
                    sending = false;
                    if (!$code) {
                        $button.text(t("login.send_code"));
                        updateButton();
                    }
                });
        });
        loadPhoneConfig();
    }
    app.pages.register("login", { show: show });
})(TVAPLAY, jQuery);
