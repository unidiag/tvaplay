
(function(app, $) {
    "use strict";

    function show($root) {
        $('<h1>Поиск</h1>').appendTo($root);

        $('<p>Поиск передач в архиве телевидения.</p>')
            .appendTo($root);
    }

    app.pages.register('search', {
        show: show
    });

})(TVAPLAY, jQuery);
