
(function(app, $) {
    "use strict";

    var $container = null;
    var items = [];

    var FADE_IN = 300;
    var FADE_OUT = 500;
    var DURATION = 3000;

    function getContainer() {
        if (!$container || !$container.length) {
            $container = $('<div id="tv-snackbar-container"></div>');
            $("body").append($container);
        }

        return $container;
    }

    function removeItem(item) {
        var i;

        if (item.timer !== null) {
            clearTimeout(item.timer);
            item.timer = null;
        }

        item.$element.stop(true, false).fadeOut(
            FADE_OUT,
            function() {
                item.$element.remove();

                for (i = items.length - 1; i >= 0; i--) {
                    if (items[i] === item) {
                        items.splice(i, 1);
                        break;
                    }
                }
            }
        );
    }

    function show(message, color, autoHide) {
        var types = {
            "default": true,
            "primary": true,
            "warning": true,
            "error": true,
            "success": true
        };

        color = types[color] ? color : "default";
        autoHide = autoHide !== false;

        var $element = $("<div></div>")
            .addClass("tv-snackbar")
            .addClass("tv-snackbar-" + color)
            .text(message == null ? "" : String(message))
            .hide()
            .appendTo(getContainer());

        var item = {
            $element: $element,
            timer: null
        };

        items.push(item);

        $element.fadeIn(FADE_IN);

        if (autoHide) {
            item.timer = setTimeout(function() {
                removeItem(item);
            }, DURATION);
        }

        return item;
    }

    function hide() {
        var active = items.slice();
        var i;

        for (i = 0; i < active.length; i++) {
            removeItem(active[i]);
        }
    }

    app.snackbar = {
        show: show,
        hide: hide
    };

})(TVAPLAY, jQuery);
