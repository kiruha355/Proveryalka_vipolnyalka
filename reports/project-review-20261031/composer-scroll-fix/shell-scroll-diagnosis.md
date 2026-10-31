# Внешняя прокрутка оболочки

Баг воспроизведён в актуальном UI8 (`/assets/index-eyNfCJ_k.js`), отдельно от устаревшей пользовательской вкладки. Настоящий native scroll страницы дал `window.scrollY=1600`: приложение целиком уехало за верхнюю границу. Это не elastic overscroll и не ошибка высоты основного grid.

Причина — абсолютные `span.visually-hidden` с текстом «Агент:» внутри длинной истории. При статичных предках их containing block — BODY, статический top последней подписи достигает3320.51px. Поэтому `document.body.scrollHeight=800` и высота app800 не означали отсутствия прокрутки: у `document.documentElement.scrollHeight` было3320.

Причина изолирована на той же странице: исходный CSS → html3320, offsetParent BODY; только `.chat__body{position:relative}` → html800, offsetParent chat__body. Доступные подписи остаются в DOM.

В исходнике добавлен containing block для чата, фиксированные viewport-границы html/body/root/app и запрет передачи прокрутки наружу. Страница не скроллится, внутренние чат, инспектор и данные остаются скроллерами.

Проверка выполнена native T3 preview в собственной новой вкладке, без provider-запросов и backend/restart. Exact CSS патч временно применён к DOM UI8: html800/windowY0 после outer scroll2000; чат0→1600→5174.5; инспектор0→90; Files workspace0→102.5, footer bottom800. Скриншоты before/after просмотрены. Финальная source build/publication остаётся root; эти скрины отмечены как injected patch, не как production bundle.

Узкий viewport не проверялся. Docker не запускался. В UI Files обнаружено отдельное сообщение о неготовом образе sandbox, передано root.
