# Пользовательская аутентификация (#79)

Включение: `PROVERYALKA_AUTH_ENABLED=1`, `PROVERYALKA_AUTH_ORIGIN=https://your-host`.
HTTP допускается только для loopback. Без флага остаётся прежний локальный режим,
не предназначенный для публикации. UI входа/регистрации — отдельная задача #87.

Email нормализуется в lower-case и уникален. Пароль: 12–128 символов, scrypt
N=16384/r=8/p=5, случайная 128-bit соль (эквивалент минимальных параметров OWASP).
Сессии — случайные 256-bit bearer credentials в HttpOnly/SameSite=Strict cookie,
Secure при HTTPS. В SQLite лежат только SHA-256 токенов и срок действия.

API `/api/auth`: POST register, POST login, GET me, POST logout,
DELETE sessions (завершить все), POST password (current_password/new_password),
POST password/reset-request (email), POST password/reset (token/password).
Все изменяющие запросы требуют точный Origin из конфигурации. Для операций
вошедшего пользователя дополнительно `X-CSRF-Token` из login/me. Ответы с
данными сессии имеют Cache-Control:no-store. Смена/восстановление пароля отзывает
все сессии и ссылки восстановления. Повторное использование ссылки запрещено.
401 AUTH_REQUIRED/INVALID_CREDENTIALS, 403 CSRF_INVALID, 409 ACCOUNT_EXISTS,
422 INVALID_REQUEST, 429 AUTH_RATE_LIMIT. Ошибки не отражают пароль.

Восстановление: настройте PROVERYALKA_SMTP_HOST/PORT (465), SMTP_USER,
SMTP_PASSWORD и SMTP_SENDER. Только SMTP over TLS с проверкой сертификата.
Отправляется одноразовая 15-минутная ссылка на настроенный AUTH_ORIGIN, не на
Host заголовок. Токен находится в URL fragment, его принимает UI #87; UI передаёт
его POST /password/reset. Он не возвращается в API/SSE и не записывается в лог.
Доставка внедряется отдельно в тестах; живое SMTP без настроенных credentials
не запускалось. Изменять email API пока не позволяет. Endpoint регистрации
создаёт аккаунт, но подтверждение email при регистрации не реализовано.

Лимит по IP и отдельно аккаунту: 10 попыток за 15 минут, хранится в SQLite;
X-Forwarded-For не доверяется. За reverse proxy нужен корректный trusted-proxy
deployment, иначе все клиенты разделят IP-лимит. Защита владения ресурсами — #80.

Источники: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
и https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html .
