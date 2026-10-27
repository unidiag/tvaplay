
(function(app, $) {
    "use strict";

    function show($root) {
        $('<h1>Избранное</h1>').appendTo($root);

        $('<p>Здесь будут избранные ТВ-каналы.</p>')
            .appendTo($root);
    }

    app.pages.register('favorites', {
        show: show
    });

})(TVAPLAY, jQuery);
