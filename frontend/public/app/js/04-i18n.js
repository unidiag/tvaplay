/* MODULE: 04-i18n.js — dynamic catalog / ES5 / jQuery */
(function(app, $) {
    "use strict";

    var STORAGE_KEY = "tvaplay_language";
    var DEFAULT_LANGUAGE = "en";
    var CATALOG_URL = "/languages.json";
    var LANGUAGE_DIR = "/app/lang/";
    var current = DEFAULT_LANGUAGE;
    var serverDefault = DEFAULT_LANGUAGE;
    var catalogError = null;
    var languages = [{id: DEFAULT_LANGUAGE, name: "English"}];
    var available = {en: true};
    var dictionaries = {};
    var requests = {};
    var initRequest = null;
    var subscribers = [];

    function getStoredLanguage() {
        try { return window.localStorage.getItem(STORAGE_KEY) || ""; }
        catch (e) { return ""; }
    }

    function saveLanguage(lang) {
        try { window.localStorage.setItem(STORAGE_KEY, lang); }
        catch (e) { /* Storage may be disabled on older TVs. */ }
    }

    function lookup(obj, key) {
        var parts = String(key).split(".");
        var value = obj;
        var i;
        for (i = 0; i < parts.length; i++) {
            if (!value || typeof value !== "object" ||
                    !Object.prototype.hasOwnProperty.call(value, parts[i])) {
                return null;
            }
            value = value[parts[i]];
        }
        return typeof value === "string" ? value : null;
    }

    function t(key, params) {
        var value = lookup(dictionaries[current], key);
        if (value === null) {
            value = lookup(dictionaries[DEFAULT_LANGUAGE], key);
        }
        if (value === null) { return String(key); }
        params = params || {};
        return value.replace(/\{([a-zA-Z0-9_]+)\}/g, function(match, name) {
            return Object.prototype.hasOwnProperty.call(params, name) ?
                String(params[name]) : match;
        });
    }

    function getLanguages() {
        // Copy to prevent callers from mutating the registry.
        var result = [];
        $.each(languages, function(_, item) {
            result.push({id: item.id, name: item.name});
        });
        return result;
    }

    function loadCatalog() {
        var deferred = $.Deferred();
        $.ajax({
            url: CATALOG_URL,
            type: "GET",
            dataType: "json",
            cache: false,
            timeout: 10000
        }).done(function(data) {
            if (!data || !$.isArray(data.languages)) {
                catalogError = "Invalid language catalog";
                deferred.reject(catalogError);
                return;
            }
            var discovered = [];
            var ids = {};
            $.each(data.languages, function(_, item) {
                if (!item || typeof item.id !== "string" ||
                        !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(item.id) ||
                        typeof item.name !== "string" || !$.trim(item.name) ||
                        ids[item.id]) {
                    return;
                }
                ids[item.id] = true;
                discovered.push({id: item.id, name: item.name});
            });
            if (!ids[DEFAULT_LANGUAGE]) {
                catalogError = "English dictionary missing from catalog";
                deferred.reject(catalogError);
                return;
            }
            // Server 'default' depends on GeoIP: it is not always 'en'.
            serverDefault = (typeof data["default"] === "string" &&
                ids[data["default"]]) ? data["default"] : DEFAULT_LANGUAGE;
            available = ids;
            languages = discovered;
            catalogError = null;
            deferred.resolve(discovered);
        }).fail(function(xhr, status) {
            catalogError = "Cannot load /languages.json: " +
                (status || (xhr && xhr.status) || "unknown error");
            deferred.reject(catalogError);
        });
        return deferred.promise();
    }

    // Retry catalog loading on opening Settings after a temporary failure.
    function refreshLanguages() {
        return loadCatalog();
    }

    function loadLanguage(lang) {
        if (!available[lang]) {
            return $.Deferred().reject("Unsupported language: " + lang).promise();
        }
        if (dictionaries[lang]) {
            return $.Deferred().resolve(dictionaries[lang]).promise();
        }
        if (requests[lang]) { return requests[lang]; }

        var deferred = $.Deferred();
        requests[lang] = deferred.promise();
        $.ajax({
            url: LANGUAGE_DIR + lang + ".json",
            type: "GET",
            dataType: "json",
            cache: true,
            timeout: 12000
        }).done(function(data) {
            if (!data || typeof data !== "object" || $.isArray(data)) {
                deferred.reject("Invalid dictionary: " + lang);
                return;
            }
            dictionaries[lang] = data;
            deferred.resolve(data);
        }).fail(function(xhr, status) {
            deferred.reject(status || "Network error");
        }).always(function() {
            delete requests[lang];
        });
        return deferred.promise();
    }

    function notifyChanged(lang) {
        $.each(subscribers.slice(0), function(_, callback) {
            try { callback(lang); } catch (e) {}
        });
    }

    function init() {
        if (initRequest) { return initRequest; }
        var deferred = $.Deferred();
        initRequest = deferred.promise();

        // Even if /languages.json is temporarily unavailable, keep the UI
        // bootable with the English dictionary.
        loadCatalog().always(function() {
            var saved = getStoredLanguage();
            var desired = available[saved] ? saved : serverDefault;
            loadLanguage(DEFAULT_LANGUAGE).done(function() {
                if (desired === DEFAULT_LANGUAGE) {
                    current = DEFAULT_LANGUAGE;
                    deferred.resolve(current);
                    return;
                }
                loadLanguage(desired).done(function() {
                    current = desired;
                    deferred.resolve(current);
                }).fail(function() {
                    current = DEFAULT_LANGUAGE;
                    deferred.resolve(current);
                });
            }).fail(function() {
                // Do not block UI startup when language files are unavailable.
                current = DEFAULT_LANGUAGE;
                deferred.resolve(current);
            });
        });
        return initRequest;
    }

    function setLanguage(lang) {
        var deferred = $.Deferred();
        init().done(function() {
            if (!available[lang]) {
                deferred.reject("Unsupported language: " + lang);
                return;
            }
            loadLanguage(lang).done(function() {
                var changed = current !== lang;
                current = lang;
                saveLanguage(lang);
                if (changed) { notifyChanged(lang); }
                deferred.resolve(lang);
            }).fail(function(error) {
                deferred.reject(error);
            });
        }).fail(function(error) {
            deferred.reject(error);
        });
        return deferred.promise();
    }

    app.i18n = {
        init: init,
        t: t,
        getLanguage: function() { return current; },
        getLanguages: getLanguages,
        refreshLanguages: refreshLanguages,
        getCatalogError: function() { return catalogError; },
        setLanguage: setLanguage,
        onChange: function(fn) {
            if (typeof fn !== "function") { return function() {}; }
            subscribers.push(fn);
            return function() {
                var index = $.inArray(fn, subscribers);
                if (index !== -1) { subscribers.splice(index, 1); }
            };
        }
    };
})(TVAPLAY, jQuery);
