
(function(app) {
    "use strict";

    var STORAGE_KEY = "tvaplay_device_id";

    function generateUUID() {
        var uuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";

        return uuid.replace(/[xy]/g, function(c) {
            var r = Math.floor(Math.random() * 16);
            var v = c === "x" ? r : (r & 3 | 8);

            return v.toString(16);
        });
    }

    function getLocalDeviceId() {
        var id = null;

        try {
            id = localStorage.getItem(STORAGE_KEY);

            if (!id) {
                id = generateUUID();
                localStorage.setItem(STORAGE_KEY, id);
            }

            return id;
        } catch (e) {
            return null;
        }
    }

    app.device.getId = getLocalDeviceId;

})(TVAPLAY);
