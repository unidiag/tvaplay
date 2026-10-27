(function(app, $) {
    "use strict";

    var VERSION_KEY = "tvaplay_version";

    function getVersion() {
        try {
            return localStorage.getItem(VERSION_KEY) || "";
        } catch (e) {
            return "";
        }
    }

    function setVersion(version) {
        if (version === undefined || version === null) {
            return;
        }

        version = String(version);

        try {
            localStorage.setItem(VERSION_KEY, version);
        } catch (e) {}

        update();
    }

    function update() {
        var $page = $(".tv-login-page");

        if (!$page.length) {
            $(".tv-login-footer").remove();
            return;
        }

        var $footer = $("body > .tv-login-footer");

        if (!$footer.length) {
            $footer = $('<div class="tv-login-footer"></div>');

            $footer.append(
                '<span id="tv-login-uid"></span>'
            );

            $footer.append(
                '<span id="tv-login-version"></span>'
            );

            $("body").append($footer);
        }

        var uid = app.device.getId() || "";
        var version = getVersion();

        $footer.find("#tv-login-uid").text(
            uid ? "UID: " + uid : ""
        );

        $footer.find("#tv-login-version").text(
            version ? "v" + version : ""
        );
    }

    app.ui.setLoginVersion = setVersion;
    app.ui.updateLoginFooter = update;

})(TVAPLAY, jQuery);