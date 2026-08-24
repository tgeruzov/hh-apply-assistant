# Документация HH Apply Assistant

Документы сгруппированы по задаче читателя. Версия описываемого userscript: 4.0.0.

## Пользователю

- [Установка и обновление](installation.md): Chrome, Tampermonkey, разрешения, install URL и проверка запуска.
- [Использование](usage.md): панель, режимы, настройки, run flow и ручная очередь.
- [Решение проблем](troubleshooting.md): панель, Site access, locks, CAPTCHA и диагностика bug report.
- [Данные и приватность](../PRIVACY.md): локальное хранение, сетевой boundary и состав экспортов.

## Разработчику

- [Архитектура](architecture.md): карта runtime и ответственность подсистем.
- [Storage](storage.md): ключи, schema, defaults, readers/writers и lifetime.
- [Lifecycle](lifecycle.md): загрузка, Start/Stop, навигация, resume, locks и terminal states.
- [Diagnostics](diagnostics.md): журнал, метрики, snapshots, Healthcheck и report export.
- [Development](development.md): локальная установка, тесты и browser smoke.
- [Release process](release-process.md): версия, changelog, tag и GitHub Release.
- [План будущей миграции](migration-plan.md): ancestry, рекомендуемый controlled fast-forward и stop conditions.
- [Release notes 4.0.0](release-notes/v4.0.0.md): готовый текст для первого публичного релиза.

Правила contributions находятся в [CONTRIBUTING.md](../CONTRIBUTING.md), сообщения об уязвимостях — в [SECURITY.md](../SECURITY.md).
