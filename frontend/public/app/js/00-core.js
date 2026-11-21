
/* MODULE: 00-core.js */
var TVAPLAY = (function($) {
    "use strict";

    var app = {
        version: "1.0",
        $: $,
        device: {},
        ui: {}
    };

    var STORAGE_KEY = "tvaplay_theme";
    var DEFAULT_THEME = "default";

    // Единственное место объявления доступных тем.
    // Названия соответствуют файлам в /app/css/.
    var themes = [
        "default",
        "forest",
        "indigo",
        "monochrome",
        "obsidian",
        "ocean",
        "air",
        "magma"
    ];

    var current = DEFAULT_THEME;

    function exists(name) {
        return $.inArray(name, themes) !== -1;
    }

    function normalize(name) {
        return exists(name) ? name : DEFAULT_THEME;
    }

    function getPath(name) {
        return "/app/css/" + name + ".css";
    }

    function getLabel(name) {
        return name.charAt(0).toUpperCase() + name.substring(1);
    }

    function list() {
        var result = [];

        $.each(themes, function(index, name) {
            result.push({
                id: name,
                label: getLabel(name)
            });
        });

        return result;
    }

    function findStylesheet() {
        return document.getElementById("tv-theme-css");
    }

    function apply(name) {
        if (!exists(name)) {
            return false;
        }

        var link = findStylesheet();

        if (!link) {
            return false;
        }

        link.id = "tv-theme-css";

        var target = getPath(name);
        var currentPath = link.getAttribute("href") || "";

        if (currentPath.split("?")[0] !== target) {
            link.setAttribute("href", target);
        }

        current = name;
        return true;
    }


    function get() {
        var saved = current;

        try {
            saved = window.localStorage.getItem(STORAGE_KEY) || current;
        } catch (e) {}

        return normalize(saved);
    }

    function set(name) {
        if (!exists(name)) {
            return false;
        }

        if (!apply(name)) {
            return false;
        }

        current = name;

        try {
            window.localStorage.setItem(STORAGE_KEY, name);
        } catch (e) {}

        return true;
    }

    function restore() {
        var saved = get();

        apply(saved);
    }


    app.theme = {
        get: get,
        set: set,
        list: list,
        restore: restore
    };

    restore();

    // Масштаб TV UI: настройка локальна для каждого устройства.
    // CSS добавляется один раз и действует для любой выбранной темы.
    (function() {
        var KEY = "tvaplay_interface_size";
        var currentSize = "standard";
        var modes = {small: true, standard: true, large: true};
        var styleId = "tvaplay-interface-size-style";

        function normalizeSize(value) {
            return modes[value] ? value : "standard";
        }

        function ensureStyles() {
            if (document.getElementById(styleId)) { return; }
            var style = document.createElement("style");
            style.id = styleId;
            style.type = "text/css";
            // transform масштабирует только отрисовку. Ширина и высота
            // задаются в обратной пропорции, чтобы итоговая область
            // оставалась в пределах физического viewport.
            // Не используем zoom: Android WebView по-разному учитывает
            // его при расчёте position:absolute/fixed и размеров flex.
            var css =
                "html.tv-size-small .tv-root{" +
                    "width:150%;height:150vh;min-height:0;" +
                    "-webkit-transform:scale(0.6666667);transform:scale(0.6666667);" +
                    "-webkit-transform-origin:0 0;transform-origin:0 0;" +
                "}" +
                "html.tv-size-large .tv-root{" +
                    "width:80%;height:80vh;min-height:0;" +
                    "-webkit-transform:scale(1.25);transform:scale(1.25);" +
                    "-webkit-transform-origin:0 0;transform-origin:0 0;" +
                "}" +
                // Уведомления находятся непосредственно в body, вне .tv-root.
                "html.tv-size-small #tv-snackbar-container{" +
                    "-webkit-transform:translateX(-50%) scale(0.6666667);" +
                    "transform:translateX(-50%) scale(0.6666667);" +
                    "-webkit-transform-origin:top center;transform-origin:top center;" +
                "}" +
                "html.tv-size-large #tv-snackbar-container{" +
                    "-webkit-transform:translateX(-50%) scale(1.25);" +
                    "transform:translateX(-50%) scale(1.25);" +
                    "-webkit-transform-origin:top center;transform-origin:top center;" +
                "}" +
                // При fullscreen отключаем transform для корректной
                // работы fixed-видеоплеера и аппаратного видеовывода.
                "html.tv-size-fullscreen .tv-root{" +
                    "width:100%!important;height:100vh!important;min-height:0!important;" +
                    "-webkit-transform:none!important;transform:none!important;" +
                "}";
            if (style.styleSheet) {
                style.styleSheet.cssText = css;
            } else {
                style.appendChild(document.createTextNode(css));
            }
            (document.head || document.getElementsByTagName("head")[0]).appendChild(style);
        }

        function applySize(value) {
            currentSize = normalizeSize(value);
            var html = document.documentElement;
            html.className = (" " + html.className + " ")
                .replace(/\s+tv-size-(small|standard|large)\s+/g, " ")
                .replace(/^\s+|\s+$/g, "");
            if (currentSize !== "standard") {
                html.className += " tv-size-" + currentSize;
            }
            ensureStyles();
        }

        function getSize() { return currentSize; }

        function setSize(value) {
            if (!modes[value]) { return false; }
            try {
                window.localStorage.setItem(KEY, value);
            } catch (e) {
                return false;
            }
            applySize(value);
            return true;
        }

        function fullscreen(value) {
            var html = document.documentElement;
            html.className = (" " + html.className + " ")
                .replace(/\s+tv-size-fullscreen\s+/g, " ")
                .replace(/^\s+|\s+$/g, "");
            if (value) { html.className += " tv-size-fullscreen"; }
        }

        try {
            currentSize = normalizeSize(window.localStorage.getItem(KEY));
        } catch (e) {}
        applySize(currentSize);

        app.interfaceSize = {
            get: getSize,
            set: setSize,
            fullscreen: fullscreen
        };
    })();

    return app;

})(jQuery);
