/* MODULE: 20-pages.js */
(function(app, $) {
    "use strict";

    var registry = {};
    var current = null;
    var previous = null;
    var history = [];
    var focusMemory = {};

    function pageFromHash() {
        var name = window.location.hash.replace(/^#/, '').toLowerCase();
        if (name === 'player' || name === 'favorites' ||
            name === 'search' || name === 'service') {
            return name;
        }
        return 'player';
    }

    function syncHash(name) {
        if (name !== 'login' && window.location.hash !== '#' + name) {
            window.location.hash = name;
        }
    }


    var SELECTOR =
        'button, a[href], input, select, textarea, [tabindex]';

    function focusables() {
        return $(".tv-root").find(SELECTOR).filter(function() {
            var $el = $(this);

            return !$el.is(':disabled') &&
                $el.attr('tabindex') !== '-1' &&
                $el.css('display') !== 'none' &&
                $el.css('visibility') !== 'hidden' &&
                $el.parents().filter(function() {
                    return $(this).css('display') === 'none' ||
                        $(this).css('visibility') === 'hidden';
                }).length === 0;
        });
    }

    function rememberFocus() {
        var el = document.activeElement;

        if (!current || !el ||
            !$.contains(document.getElementById('tv-page'), el)) {
            return;
        }

        var $items = $("#tv-page").find(SELECTOR);

        focusMemory[current] = {
            id: $(el).attr('data-focus-id') || null,
            index: $items.index(el)
        };
    }

    function focusElement(el) {
        if (!el || typeof el.focus !== 'function') {
            return false;
        }

        el.focus();
        return document.activeElement === el;
    }

    function focusPage(restore) {
        var $items = focusables();

        var $pageItems = $items.filter(function() {
            return $.contains(
                document.getElementById('tv-page'), this
            );
        });

        var saved = restore && focusMemory[current];
        var target = null;

        if (saved && saved.id) {
            $pageItems.each(function() {
                if ($(this).attr('data-focus-id') === saved.id) {
                    target = this;
                    return false;
                }
            });
        }

        if (!target && saved && saved.index >= 0) {
            target = $pageItems.get(saved.index);
        }

        // Если на странице есть интерактивные элементы,
        // устанавливаем фокус на них.
        if (!target) {
            target = $pageItems.get(0);
        }

        // Если страница пустая, фокусируем её кнопку меню.
        if (!target) {
            target = $('.tv-nav-button').filter(function() {
                return $(this).attr('data-page') === current;
            }).get(0);
        }

        // Последний резервный вариант.
        target = target || $items.get(0);

        focusElement(target);
    }

    function register(name, page) {
        registry[name] = page;
    }

    function open(name, params, isBack) {
        var page = registry[name];
        var oldPage = registry[current];

        if (!page) {
            if (app.snackbar && app.snackbar.show) {
                app.snackbar.show(
                    'Страница не найдена: ' + name,
                    'error',
                    true
                );
            }
            return;
        }

        // До авторизации разрешаем только страницу входа.
        if (name !== 'login' &&
            (!app.isAuthorized || !app.isAuthorized())) {
            return;
        }

        if (current === name) {
            syncHash(name);
            return;
        }

        rememberFocus();

        if (!isBack && current !== null) {
            history.push(current);
        }

        if (oldPage && oldPage.hide) {
            oldPage.hide();
        }

        previous = current;
        current = name;

        var $root = $('#tv-page').empty();

        page.show($root, params || {});

        $('.tv-nav-button')
            .removeClass('tv-nav-active')
            .removeAttr('aria-current');

        $('.tv-nav-button').filter(function() {
            return $(this).attr('data-page') === name;
        })
            .addClass('tv-nav-active')
            .attr('aria-current', 'page');

        // Показываем меню только после авторизации.
        if (app.isAuthorized && app.isAuthorized()) {
            $('.tv-nav').removeClass('tv-nav-hidden');
        } else {
            $('.tv-nav').addClass('tv-nav-hidden');
        }          

        focusPage(true);
        syncHash(name);
    }

    function back() {
        while (history.length) {
            var name = history.pop();

            if (registry[name] && name !== current) {
                open(name, {}, true);
                return;
            }
        }

        if (current !== 'player') {
            open('player', {}, true);
        }
    }

    function move(direction) {
        var $items = focusables();

        if (!$items.length) {
            return;
        }

        var active = document.activeElement;
        var source = $items.index(active);

        if (source < 0) {
            focusPage(true);
            return;
        }

        var rect = active.getBoundingClientRect();

        var x = (rect.left + rect.right) / 2;
        var y = (rect.top + rect.bottom) / 2;

        var best = null;
        var score = Infinity;

        $items.each(function(i) {
            if (i === source) {
                return;
            }

            var r = this.getBoundingClientRect();

            var dx = (r.left + r.right) / 2 - x;
            var dy = (r.top + r.bottom) / 2 - y;

            var forward;
            var side;

            if (direction === 'left') {
                forward = -dx;
                side = Math.abs(dy);
            } else if (direction === 'right') {
                forward = dx;
                side = Math.abs(dy);
            } else if (direction === 'up') {
                forward = -dy;
                side = Math.abs(dx);
            } else {
                forward = dy;
                side = Math.abs(dx);
            }

            if (forward <= 2) {
                return;
            }

            // Предпочитаем элементы в нужном направлении,
            // находящиеся ближе к текущей линии.
            var candidateScore = forward + side * 2.5;

            if (candidateScore < score) {
                score = candidateScore;
                best = this;
            }
        });

        // Резервный линейный обход.
        if (!best) {
            var step =
                direction === 'left' || direction === 'up'
                    ? -1
                    : 1;

            best = $items.get(source + step) || null;
        }

        if (best) {
            focusElement(best);
        }
    }

    function onKeydown(event) {
        if (event.altKey || event.ctrlKey || event.metaKey) {
            return;
        }

        var key = event.which || event.keyCode;
        var target = event.target || document.activeElement;

        var editing = $(target).is(
            'input, textarea, select, [contenteditable="true"]'
        );

        // Back: Escape / webOS / Tizen
        var isBack = key === 27 ||
                    key === 461 ||
                    key === 10009;

        // Backspace
        var isBackspace = key === 8;

        if (isBack || (isBackspace && !editing)) {

            event.preventDefault();
            event.stopPropagation();

            // До авторизации нельзя выходить из страницы входа.
            if (!app.isAuthorized || !app.isAuthorized()) {
                return;
            }

            back();
            return;
        }

        // Стрелки
        if (key >= 37 && key <= 40) {
            if (editing) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            move(
                key === 37 ? 'left' :
                key === 38 ? 'up' :
                key === 39 ? 'right' : 'down'
            );

            return;
        }

        // OK / Enter / Space
        if (key === 13 || key === 32) {
            if (editing) {
                return;
            }


            var active = document.activeElement;

            if (!active ||
                !$.contains(document.documentElement, active)) {
                return;
            }

            // Нативные button и a уже умеют click по Enter.
            if ($(active).is('button, a[href]')) {
                return;
            }

            if ($(active).is('[tabindex]')) {
                event.preventDefault();
                $(active).trigger('click');
            }
        }
    }

    function init() {

        $('.tv-root').html(
            '<div class="tv-header">' +
                '<div class="tv-brand">' +
                    '<img src="/logo192.png" ' +
                        'alt="TVAPLAY" ' +
                        'class="tv-brand-logo">' +
                    '<span class="tv-brand-title">TVAPLAY</span>' +
                '</div>' +


                '<div class="tv-nav">' +
                    '<button type="button" class="tv-nav-button" ' +
                        'data-focus-id="nav-player" data-page="player">' +
                        'Каналы' +
                    '</button>' +

                    '<button type="button" class="tv-nav-button" ' +
                        'data-focus-id="nav-favorites" data-page="favorites">' +
                        'Избранное' +
                    '</button>' +

                    '<button type="button" class="tv-nav-button" ' +
                        'data-focus-id="nav-search" data-page="search">' +
                        'Поиск' +
                    '</button>' +

                    '<button type="button" class="tv-nav-button" ' +
                        'data-focus-id="nav-service" data-page="service">' +
                        'Сервис' +
                    '</button>' +
                '</div>' +


                '<span id="server-clock"></span>' +
            '</div>' +

            '<div id="tv-page" class="tv-page"></div>'
        );


        $('.tv-nav-button').on('click', function() {
            open($(this).attr('data-page'));
        });

        $(document)
            .off('keydown.tvpages')
            .on('keydown.tvpages', onKeydown);

        $('.tv-nav').addClass('tv-nav-hidden');

        $(window)
            .off('hashchange.tvpages')
            .on('hashchange.tvpages', function() {
                if (!app.isAuthorized || !app.isAuthorized()) {
                    return;
                }
                var name = pageFromHash();
                if (name !== current) {
                    open(name, {}, true);
                }
            });
    }

    app.pages = {
        register: register,
        open: open,
        back: back,
        fromHash: pageFromHash,
        init: init,
        focus: focusPage,
        current: function() {
            return current;
        },
        previous: function() {
            return previous;
        }
    };

})(TVAPLAY, jQuery);
