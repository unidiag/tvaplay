(function(app, $) {
    "use strict";

    var programmes = {};
    var serverTime = 0;
    var loadedAt = 0;
    var pending = null;

    function now() {
        // Часы старого телевизора могут быть установлены неправильно.
        if (serverTime && loadedAt) {
            return serverTime + (new Date().getTime() - loadedAt);
        }
        return new Date().getTime();
    }

    function get(channelId) {
        var item = programmes[String(channelId || "")];
        var time = now();
        if (!item || !(Number(item.start) <= time && time < Number(item.stop))) {
            return null;
        }
        return item;
    }

    function getProgress(channelId) {
        var item = get(channelId);
        var duration;
        if (!item) { return 0; }
        duration = Number(item.stop) - Number(item.start);
        if (duration <= 0) { return 0; }
        return Math.max(0, Math.min(100,
            (now() - Number(item.start)) * 100 / duration));
    }

    function load() {
        if (pending) { return pending; }
        var deferred = $.Deferred();
        pending = deferred.promise();
        app.api("getEPGNow", {})
            .done(function(data) {
                if (!data || !data.programmes || typeof data.programmes !== "object") {
                    deferred.reject({status: "INVALID_RESPONSE", message: "Нет данных EPG"});
                    return;
                }
                programmes = data.programmes;
                serverTime = Number(data.server_time) || 0;
                loadedAt = new Date().getTime();
                deferred.resolve(programmes);
            })
            .fail(function(error) { deferred.reject(error); })
            .always(function() { pending = null; });
        return pending;
    }

    function clear() {
        programmes = {};
        serverTime = 0;
        loadedAt = 0;
    }

    app.epg = {
        load: load,
        get: get,
        getProgress: getProgress,
        clear: clear
    };
})(TVAPLAY, jQuery);
