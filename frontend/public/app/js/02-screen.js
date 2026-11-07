(function(app) {
    "use strict";

    var MIN_WIDTH = 1920;
    var MIN_HEIGHT = 1080;

    function getResolution() {
        return {
            width: window.screen.width,
            height: window.screen.height
        };
    }

    function isSmallScreen() {
        var resolution = getResolution();

        return resolution.width < MIN_WIDTH ||
               resolution.height < MIN_HEIGHT;
    }

    function init() {
        var small = isSmallScreen();
        var root = document.documentElement;

        if (small) {
            if (root.className.indexOf("tv-small-screen") === -1) {
                root.className += " tv-small-screen";
            }
        }

        return small;
    }

    app.screen = {
        init: init,
        getResolution: getResolution,
        isSmall: isSmallScreen
    };

    // Применяем при загрузке модуля.
    init();

})(TVAPLAY);