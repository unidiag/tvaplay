
(function(app, $) {
    "use strict";

    function t(key, params) {
        return app.i18n && typeof app.i18n.t === "function" ?
            app.i18n.t(key, params) : String(key);
    }

    function showInfo(title, value) {
        var row = $("<div></div>");

        row.css({
            "padding": "12px 0",
            "border-bottom": "1px solid #243147",
            "word-wrap": "break-word"
        });

        $("<div></div>")
            .text(title)
            .css({
                "color": "#37c5d4",
            })
            .appendTo(row);

        $("<div></div>")
            .text(
                value === null ||
                typeof value === "undefined" ||
                value === ""
                    ? t("common.unavailable")
                    : String(value)
            )
            .css({
                "color": "#eef3fc",
            })
            .appendTo(row);

        $("#device-info").append(row);
    }

    function init() {
        $("#root").html(
            '<div class="tv-root">' +
                '<div id="device-info" ' +
                'style="overflow:auto;width:100%;">' +
                '</div>' +
            '</div>'
        );
    }

    app.ui.init = init;
    app.ui.showInfo = showInfo;

})(TVAPLAY, jQuery);
