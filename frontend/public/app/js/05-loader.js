
(function(app, $) {
    "use strict";

    function create(container) {
        var $container = $(container);
        var $overlay = null;
        var destroyed = false;

        if (!$container.length) {
            return null;
        }

        // Лоадер позиционируется относительно контейнера.
        // Для video-контейнера уже используется position: relative.
        var position = $container.css("position");
        var changedPosition = false;

        if (!position || position === "static") {
            $container.css("position", "relative");
            changedPosition = true;
        }

        $overlay = $('<div class="tv-loader"></div>')
            .hide()
            .appendTo($container);

        $('<div class="tv-loader-spinner"></div>')
            .appendTo($overlay);

        var $text = $('<div class="tv-loader-text"></div>')
            .appendTo($overlay);

        function show(message) {
            if (destroyed) {
                return;
            }

            $text.text(message || "Загрузка...");
            $overlay.show();
        }

        function hide() {
            if (destroyed) {
                return;
            }

            $overlay.hide();
        }

        function destroy() {
            if (destroyed) {
                return;
            }

            destroyed = true;
            $overlay.remove();

            if (changedPosition) {
                $container.css("position", "");
            }
        }

        return {
            show: show,
            hide: hide,
            destroy: destroy
        };
    }

    app.loader = {
        create: create
    };

})(TVAPLAY, jQuery);
