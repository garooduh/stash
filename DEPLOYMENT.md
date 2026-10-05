# Развёртывание stash.qbob.ru

Дата развёртывания: 28 сентября 2026 года.

## Размещение

| Компонент | Место |
| --- | --- |
| Stash | Proxmox LXC `208` (`stash`), Debian 13, `192.168.1.209` |
| Ресурсы | 1 vCPU, 1 ГБ RAM, 512 МБ swap, rootfs 8 ГБ на `local-lvm` |
| Код | `/opt/stash` внутри LXC |
| Данные | `/data` внутри LXC = `/mnt/storage/stash` на Proxmox |
| SQLite | `/data/stash.db` |
| Приложение | `stash.service`, HTTP `0.0.0.0:8080` внутри LXC |
| Reverse proxy | Nginx LXC `200`, `/etc/nginx/sites-available/stash.qbob.ru` |
| Публичный адрес | `https://stash.qbob.ru/`, WebDAV `https://stash.qbob.ru/dav/` |
| TLS | Let's Encrypt, webroot `/var/www/stash-acme`, автоматическое продление существующим `certbot.timer` |

LXC непривилегированный, nesting выключен. Каталог данных на хосте принадлежит отображённым UID/GID пользователя `stash` в контейнере. `mp0` — bind mount с `backup=0`; обычный backup контейнера Proxmox **не включает** пользовательские файлы и SQLite. Их нужно копировать отдельно, согласованным снимком.

Из проверенных Proxmox и Nginx LXC запрос к публичному адресу `stash.qbob.ru` зависает; вероятная причина — отсутствие NAT loopback на роутере. Доступ через внутренний IP Nginx `192.168.1.11` с тем же HTTPS Host работает. Если домашние компьютеры и телефоны сталкиваются с тем же, настройте внутреннюю DNS-запись `stash.qbob.ru → 192.168.1.11` или NAT loopback на роутере; публичную A-запись `95.31.28.219` оставьте без изменений.

## Проверка и обслуживание

```bash
ssh -F ~/.ssh/config proxmox 'pct status 208; pct exec 208 -- systemctl status stash.service --no-pager'
ssh -F ~/.ssh/config proxmox 'pct exec 208 -- journalctl -u stash.service -n 100 --no-pager'
ssh -F ~/.ssh/config nginx 'nginx -t; systemctl is-active nginx'
curl https://stash.qbob.ru/health
```

Первый администратор — `bobro`. Для интерактивной смены пароля:

```bash
ssh -tt -F ~/.ssh/config proxmox 'pct exec 208 -- runuser -u stash -- /opt/stash/.venv/bin/python -m stash user password bobro'
```

Новые веб-сессии после смены пароля потребуют повторного входа. WebDAV-токены отзываются отдельно в веб-интерфейсе.

Сертификат для `stash.qbob.ru` был выпущен вручную через Certbot; проверка `certbot renew --dry-run --cert-name stash.qbob.ru` прошла успешно. Для этого сертификата сохранён deploy hook: сначала `nginx -t`, затем `systemctl reload nginx`. Конфигурация Nginx зафиксирована в [`deploy/stash.qbob.ru.nginx`](deploy/stash.qbob.ru.nginx).

Debian 13 в этом LXC сообщает `degraded` для `dev-mqueue.mount`, `run-lock.mount` и `tmp.mount`: попытки этих mount unit завершаются ошибкой. Каталоги доступны, служба Stash работает и прошла HTTP/WebDAV-проверки. Nesting не включали, поскольку приложению он не потребовался.
