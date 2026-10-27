(function(app) {
    "use strict";

    var serverTime = null;
    var syncTimestamp = 0;
    var timer = null;

    function setTime(time) {
        // Формат: YYYY-MM-DD HH:mm:ss
        var parts = String(time).match(
            /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
        );

        if (!parts) {
            return false;
        }

        serverTime = Date.UTC(
            parseInt(parts[1], 10),
            parseInt(parts[2], 10) - 1,
            parseInt(parts[3], 10),
            parseInt(parts[4], 10),
            parseInt(parts[5], 10),
            parseInt(parts[6], 10)
        );

        syncTimestamp = new Date().getTime();

        return true;
    }

    function getTime() {
        if (serverTime === null) {
            return null;
        }

        var elapsed = new Date().getTime() - syncTimestamp;

        return new Date(serverTime + elapsed);
    }

    function pad(value) {
        return value < 10 ? "0" + value : String(value);
    }

    function formatTime() {
        var date = getTime();

        if (!date) {
            return "--:--";
        }

        var months = [
            "января", "февраля", "марта",
            "апреля", "мая", "июня",
            "июля", "августа", "сентября",
            "октября", "ноября", "декабря"
        ];

        return date.getUTCDate() + " " +
            months[date.getUTCMonth()] + ", " +
            pad(date.getUTCHours()) + ":" +
            pad(date.getUTCMinutes());
    }

    function start(callback) {
        stop();

        function update() {
            callback(formatTime());

            var date = getTime();
            var delay = 60000;

            if (date) {
                delay = 60000 -
                    (date.getUTCSeconds() * 1000 +
                    date.getUTCMilliseconds());
            }

            timer = setTimeout(update, delay);
        }

        update();
    }

    function stop() {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    }

    app.clock = {
        setTime: setTime,
        getTime: getTime,
        formatTime: formatTime,
        start: start,
        stop: stop
    };

})(TVAPLAY);