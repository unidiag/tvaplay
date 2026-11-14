
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

    return app;

})(jQuery);
