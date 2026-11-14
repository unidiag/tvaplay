/* MODULE: 12-modalFocus.js */
(function(app, $) {
    "use strict";

    var stack = [];
    var SELECTOR = 'button, a[href], input, select, textarea, [tabindex]';

    function active() {
        while (stack.length) {
            var el = stack[stack.length - 1];
            if (el && $.contains(document, el)) {
                return el;
            }
            stack.pop();
        }
        return null;
    }

    function inside(modal, element) {
        return !!element && (modal === element || $.contains(modal, element));
    }

    function allowed(element) {
        var modal = active();
        return !modal || inside(modal, element);
    }

    function focusables() {
        var modal = active();
        if (!modal) { return $(); }
        return $(modal).find(SELECTOR).filter(function() {
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

    function focusFirst() {
        var target = focusables().get(0);
        if (target) { target.focus(); }
    }

    function open($modal, $initialFocus) {
        var modal = $modal && $modal[0];
        if (!modal) { return; }
        if ($.inArray(modal, stack) < 0) { stack.push(modal); }
        if ($initialFocus && $initialFocus.length &&
            inside(modal, $initialFocus[0])) {
            $initialFocus.focus();
        } else {
            focusFirst();
        }
    }

    function close($modal) {
        var modal = $modal && $modal[0];
        var index = $.inArray(modal, stack);
        if (index >= 0) { stack.splice(index, 1); }
        if (active() && !allowed(document.activeElement)) { focusFirst(); }
    }

    function filter($elements) {
        var modal = active();
        if (!modal) { return $elements; }
        return $elements.filter(function() { return inside(modal, this); });
    }

    // Не допускаем программного перевода фокуса за пределы диалога.
    document.addEventListener('focus', function(event) {
        if (active() && !allowed(event.target)) { focusFirst(); }
    }, true);

    // Tab и Shift+Tab циклически перемещаются только внутри диалога.
    // Стрелками управляет общий навигатор 20-pages.js.
    document.addEventListener('keydown', function(event) {
        if (!active()) { return; }
        var key = event.which || event.keyCode;
        if (key !== 9) { return; }
        event.preventDefault();
        event.stopPropagation();
        var $items = focusables();
        if (!$items.length) { return; }
        var index = $items.index(document.activeElement);
        var next = event.shiftKey ? index - 1 : index + 1;
        if (index < 0) { next = event.shiftKey ? $items.length - 1 : 0; }
        if (next < 0) { next = $items.length - 1; }
        if (next >= $items.length) { next = 0; }
        $items.get(next).focus();
    }, true);

    // В том числе мышью нельзя активировать кнопки страницы под диалогом.
    document.addEventListener('click', function(event) {
        if (!active() || allowed(event.target)) { return; }
        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) { event.stopImmediatePropagation(); }
        focusFirst();
    }, true);

    app.modalFocus = {
        active: active,
        allowed: allowed,
        filter: filter,
        focusFirst: focusFirst,
        open: open,
        close: close
    };
})(TVAPLAY, jQuery);
