(function(app, $) {
    "use strict";

    var sending = false;
    var confirming = false;

    function digitsOnly(value) {
        return String(value || "").replace(/\D/g, "");
    }


    function formatPhone(value) {
        var digits = digitsOnly(value).substring(0, 11);
        var result = "";

        if (digits.length > 0) {
            result = digits.substring(0, 1);
        }

        if (digits.length > 1) {
            result += "-" + digits.substring(1, 4);
        }

        if (digits.length > 4) {
            result += "-" + digits.substring(4, 7);
        }

        if (digits.length > 7) {
            result += "-" + digits.substring(7, 9);
        }

        if (digits.length > 9) {
            result += "-" + digits.substring(9, 11);
        }

        return result;
    }


    function isValidPhone(value) {
        return /^8-0(25|29|33|44)-[0-9]{3}-[0-9]{2}-[0-9]{2}$/
            .test(value);
    }

    function show($root) {
        sending = false;
        confirming = false;

        var $page = $('<div class="tv-login-page"></div>')
            .appendTo($root);

        var $form = $('<form class="tv-login-form"></form>')
            .appendTo($page);

        $('<p class="tv-login-description">' +
            'Введите номер телефона</p>')
            .appendTo($form);

        var $phone = $('<input>', {
            type: 'tel',
            'class': 'tv-login-phone',
            id: 'login-phone',
            autocomplete: 'tel',
            placeholder: '8-0XX-XXX-XX-XX',
            maxlength: 15,
            'data-focus-id': 'login-phone'
        }).appendTo($form);

        var $button = $('<button>', {
            type: 'submit',
            'class': 'tv-login-submit',
            'data-focus-id': 'login-submit',
            text: 'Отправить код',
            disabled: true
        }).appendTo($form);

        var $code = null;

        function updateButton() {
            var phone = $phone.val();
            var valid = isValidPhone(phone);
            var complete = digitsOnly(phone).length === 11;

            // Красная рамка только у полного некорректного номера
            $phone.toggleClass(
                'tv-login-phone-invalid',
                complete && !valid
            );

            $button.prop(
                'disabled',
                sending || !valid
            );
        }

        function showCodeInput() {
            // Фиксируем телефон после отправки SMS.
            $phone.prop('disabled', true);

            // Убираем кнопку отправки.
            $button.remove();

            $('.tv-login-description')
                .text('Введите код из SMS');

            $code = $('<input>', {
                type: 'tel',
                'class': 'tv-login-code',
                id: 'login-code',
                placeholder: '0000',
                maxlength: 4,
                autocomplete: 'one-time-code',
                'data-focus-id': 'login-code'
            }).appendTo($form);

            $code.focus();

            $code.on('input', function() {
                var value = digitsOnly($code.val())
                    .substring(0, 4);

                if ($code.val() !== value) {
                    $code.val(value);
                }

                // Отправляем автоматически после 4 цифр.
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

            // На время проверки запрещаем редактирование.
            $code.prop('disabled', true);

            app.api('guestConfirmcode', {
                phone: digitsOnly($phone.val()),
                code: code
            })
            .done(function(data) {
                if (!data.access_token) {
                    app.snackbar.show(
                        'Сервер не вернул токен авторизации',
                        'error',
                        true
                    );

                    $code.prop('disabled', false);
                    $code.val('');
                    $code.focus();
                    return;
                }

                // Сохраняем оба токена.
                var accessSaved = app.api.setToken(
                    data.access_token
                );

                var refreshSaved = app.api.setRefreshToken(
                    data.refresh_token
                );

                // Проверяем наличие refresh-токена.
                if (!data.refresh_token) {
                    app.snackbar.show(
                        "Сервер не вернул refresh token",
                        "error",
                        true
                    );
                    return;
                }

                // Предупреждаем, если хранилище недоступно.
                if (!accessSaved || !refreshSaved) {
                    app.snackbar.show(
                        "Не удалось сохранить сессию на устройстве",
                        "error",
                        true
                    );
                    return;
                }

                // Авторизация завершена.
                app.setAuthorized(true);
            })
            .fail(function(error) {
                app.snackbar.show(
                    error && error.message
                        ? error.message
                        : 'Ошибка проверки SMS-кода',
                    'error',
                    true
                );

                $code.prop('disabled', false);
                $code.val('');
                $code.focus();
            })
            .always(function() {
                confirming = false;
            });
        }

        $phone.on('input', function() {
            var formatted = formatPhone($phone.val());

            if ($phone.val() !== formatted) {
                $phone.val(formatted);
            }

            updateButton();
        });


        $form.on('submit', function(event) {
            event.preventDefault();

            if (sending || $code) {
                return;
            }

            if (!app.isHandshakeComplete ||
                !app.isHandshakeComplete()) {

                app.snackbar.show(
                    'Нет соединения с сервером',
                    'error',
                    true
                );
                return;
            }

            var phone = $phone.val();

            if (!isValidPhone(phone)) {
                app.snackbar.show(
                    'Некорректный номер телефона',
                    'error',
                    true
                );

                $phone.focus();
                return;
            }

            sending = true;
            updateButton();

            $button.text('Отправка...');

            app.api('guestSendcode', {
                phone: digitsOnly(phone)
            })
            .done(function(data) {
                app.snackbar.show(
                    data.message || 'SMS-код отправлен',
                    'success',
                    true
                );

                // Переключаем форму на ввод SMS-кода.
                showCodeInput();
            })
            .fail(function(error) {
                var message = error && error.message
                    ? error.message
                    : 'Ошибка отправки SMS-кода';

                if (error && error.status === 'MAX_DEVICES') {
                    app.snackbar.show(message, 'warning', true);
                    return;
                }

                app.snackbar.show(message, 'error', true);
            })
            .always(function() {
                sending = false;

                if (!$code) {
                    $button.text('Отправить код');
                    updateButton();
                }
            });
        });
    }

    app.pages.register('login', {
        show: show
    });

})(TVAPLAY, jQuery);