# Stash

Лёгкое личное файловое хранилище для домашнего сервера. Файлы лежат на диске под своими именами; браузер и WebDAV работают с одним и тем же пространством пользователя. Приложение рассчитано на 1–5 пользователей и запускается как один процесс.

Параметры действующего сервера `stash.qbob.ru` записаны в [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Требования

- Python 3.12 или новее;
- Debian Stable или другая Linux-система с доступным каталогом данных;
- внешний Nginx и HTTPS для доступа из сети;
- SQLite и файловая система с достаточным свободным местом.

Nginx, DNS и TLS не входят в Stash. До публикации сервиса проверьте DNS-запись домена, настройте HTTPS на внешнем Nginx и ограничьте доступ к внутреннему HTTP-порту. По умолчанию Stash слушает только `127.0.0.1:8080`.

## Установка

```bash
git clone <адрес-вашего-репозитория> /opt/stash
cd /opt/stash
python3 -m venv .venv
.venv/bin/python -m pip install -e .
cp .env.example .env
```

Для локальной разработки установите `.[dev]`. Файл `.env` не входит в Git. Отредактируйте в нём пути под свой сервер. Пример для системы, где каталог данных принадлежит пользователю `stash`:

```env
STASH_HOST=127.0.0.1
STASH_PORT=8080
STASH_DATA_DIR=/var/lib/stash
STASH_DATABASE=/var/lib/stash/stash.db
STASH_SESSION_LIFETIME_DAYS=30
STASH_COOKIE_SECURE=true
STASH_TRUSTED_PROXY_IPS=127.0.0.1
```

При проверке интерфейса напрямую через локальный `http://127.0.0.1:8080` временно укажите `STASH_COOKIE_SECURE=false`, иначе браузер не сохранит cookie с флагом Secure. Для работы через HTTPS оставьте `true`.

Создайте каталог и выдайте права пользователю процесса **до** миграции:

```bash
sudo install -d -o stash -g stash -m 0700 /var/lib/stash
```

Пользователь `stash` здесь — отдельный системный пользователь без права входа. Для домашнего теста можно использовать свой аккаунт и каталог внутри домашней директории. Не запускайте Stash от `root`.

## Миграция, первый пользователь и запуск

Выполните команды от имени системного пользователя, который будет запускать приложение, из каталога проекта:

```bash
.venv/bin/alembic upgrade head
.venv/bin/python -m stash user create bobro --admin
.venv/bin/python -m stash serve
```

CLI дважды запросит пароль без отображения ввода. Пароль должен содержать не менее 12 символов. Дополнительных пользователей можно создать той же командой без `--admin`. Веб-регистрации нет.

Чтобы сменить пароль пользователя из CLI, выполните `.venv/bin/python -m stash user password bobro`. Действующие веб-сессии этого пользователя будут удалены; WebDAV-токены управляются отдельно.

Локальные адреса:

- Web UI: `http://127.0.0.1:8080/`
- WebDAV: `http://127.0.0.1:8080/dav/`
- Health check: `http://127.0.0.1:8080/health`

При работе через домен используйте `https://drive.example.com/` и `https://drive.example.com/dav/`. Для входа в WebDAV-клиент укажите имя пользователя Stash и отдельный токен, который создаётся через настройки веб-интерфейса. Основной пароль в WebDAV не принимается. Токен отображается только при создании; сохраните его в менеджере паролей. Токен можно отозвать в настройках.

В файловом интерфейсе доступны список и плитка, сортировка и фильтр по типу. Тема переключается в верхней панели между системной, светлой и тёмной; выбор сохраняется в браузере и применяется также к странице входа.

## systemd

Пример unit-файла находится в [`deploy/stash.service`](deploy/stash.service). Подставьте фактический путь установки и пользователя. После установки unit-файла:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now stash.service
systemctl status stash.service
journalctl -u stash.service -n 100 --no-pager
```

Stash корректно останавливается по SIGTERM, который systemd посылает по умолчанию. Перезапуск автоматический при ошибке процесса.

## Nginx

Пример конфигурации для `drive.example.com` после самостоятельной настройки DNS и сертификата:

```nginx
server {
    listen 443 ssl;
    server_name drive.example.com;

    ssl_certificate     /etc/letsencrypt/live/drive.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/drive.example.com/privkey.pem;

    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    location /dav/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Authorization $http_authorization;
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

`proxy_pass` здесь без завершающего `/`, чтобы WsgiDAV получил путь `/dav/`. По умолчанию Stash доверяет forwarded-заголовкам только от `127.0.0.1`. Если Nginx работает в отдельном LXC, укажите в `.env` его внутренний адрес в `STASH_TRUSTED_PROXY_IPS`, а `STASH_HOST` установите в `0.0.0.0` или внутренний адрес контейнера. Не открывайте внутренний HTTP-порт в Интернет. SSL-сертификат Stash не получает автоматически.

После настройки прокси проверьте `nginx -t`, статус службы, `journalctl`, `/health`, вход в UI и операции WebDAV через HTTPS.

## Хранение и резервные копии

```text
/var/lib/stash/
├── stash.db
└── users/
    ├── 1/files/Documents/report.pdf
    └── 2/files/
```

**Пользовательские файлы являются обычными файлами файловой системы, а SQLite содержит только служебные данные.** Имена и дерево папок сохраняются. Для резервной копии копируйте `users/` через `restic`, `rsync` или другой файловый инструмент и создавайте согласованный снимок SQLite с помощью `sqlite3 /var/lib/stash/stash.db '.backup /путь/к/копии/stash.db'` либо снимка файловой системы. Проверяйте восстановление обеих частей. Для полностью согласованного снимка во время активной загрузки на время копирования остановите службу или используйте атомарный снимок тома.

## Разработка

```bash
.venv/bin/python -m pip install -e '.[dev]'
.venv/bin/ruff check .
.venv/bin/ruff format --check .
.venv/bin/python -m pytest -q
```

Тесты создают временные SQLite и каталоги файлов. Структура и решения описаны в [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Ограничения MVP

Удаление физическое, без корзины. Нет квот, публичных ссылок, шаринга, версий файлов, возобновляемой загрузки и индекса содержимого. Поиск обходит имена файлов в текущем пространстве и может быть медленным на очень большом дереве. Индикатор места показывает использование всего диска, а не персональную квоту. Блокировки WebDAV хранятся в памяти процесса и исчезают при перезапуске. Обычный WebDAV PUT следует стандартной семантике WsgiDAV и может перезаписать файл; загрузка через REST API при совпадении имени возвращает `409`. Для безопасности каталог данных должен принадлежать только системному пользователю Stash; сторонние процессы не должны подменять файлы и ссылки во время обработки запросов.
