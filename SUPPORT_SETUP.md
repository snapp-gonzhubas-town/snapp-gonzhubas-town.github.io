# Support Chat Setup

## Что уже готово
- На сайте есть плавающая кнопка поддержки и чат-виджет.
- Есть отдельная панель оператора `support-admin.html`, которую можно открыть как обычную страницу или как Telegram Mini App.
- Есть шаблон API + Telegram webhook в `support-worker-template.js`.
- Есть схема базы `support-schema.sql`.

## Важный момент про GitHub
GitHub Pages подходит для статического сайта и Telegram Mini App фронтенда. Сам Telegram-бот и API поддержки должны работать на серверной среде. Самый простой вариант здесь - Cloudflare Workers + D1.

## Идентификация посетителей
Сейчас схема такая:
- На сайте каждому посетителю создается `visitorId` в `localStorage`.
- Дополнительно отправляется простой браузерный fingerprint.
- На сервере можно сохранять хэш IP, а не сам IP.

Это дает нормальную идентификацию для поддержки без привязки к Telegram у самого посетителя.

## Как подключить живой режим
1. Сначала отзови текущий Telegram token и выпусти новый. Токен, который уже был отправлен в чат, считается скомпрометированным.
2. Размести сайт и `support-admin.html` на GitHub Pages.
3. Подними `support-worker-template.js` как Cloudflare Worker.
4. Создай D1 базу и выполни `support-schema.sql`.
5. Если база уже существовала раньше, добавь миграцией новые поля и таблицы из `support-schema.sql` (`support_presence`, `support_effects`, soft-delete поля у сообщений).
6. Заполни переменные из `support.env.example`.
7. В `support-config.js` пропиши `apiBase` как URL воркера. По умолчанию он пустой, чтобы фронтенд не смотрел в мёртвый tunnel URL.
8. Поставь webhook боту на `/api/telegram/webhook` и передай `TELEGRAM_WEBHOOK_SECRET`, если используешь секрет вебхука.
9. Через BotFather добавь кнопку или shortcut на `support-admin.html`.

## Что получает оператор
- Список всех чатов с сайта.
- Историю переписки как в мессенджере.
- Ответы прямо из Telegram Mini App.
- Уведомления в Telegram при новых сообщениях.

## Полезные ссылки
- GitHub Pages: https://docs.github.com/pages/getting-started-with-github-pages/what-is-github-pages
- Telegram Bot API: https://core.telegram.org/bots/api
- Telegram Mini Apps: https://core.telegram.org/bots/webapps
