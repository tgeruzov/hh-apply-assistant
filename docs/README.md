# Документация HH Apply Assistant

[Главная страница на русском](../README.md) · [Project overview in English](i18n/README.en.md)

Документы сгруппированы по задаче и аудитории. Для основных пользовательских сценариев и работы с сообществом доступны русская и английская версии.

## Пользователю

- Установка и обновление: [RU](installation.md) · [EN](i18n/installation.en.md) — Chrome, Tampermonkey, разрешения и проверка запуска.
- Использование: [RU](usage.md) · [EN](i18n/usage.en.md) — панель, режимы, настройки, запуск, остановка и ручная очередь.
- Решение проблем: [RU](troubleshooting.md) · [EN](i18n/troubleshooting.en.md) — установка, появление панели, CAPTCHA, обновление и подготовка сообщения об ошибке.
- Данные и приватность: [RU](PRIVACY.md) · [EN](i18n/PRIVACY.en.md) — локальное хранение, сетевое поведение и состав экспортов.

## Разработчику

- [Архитектура](architecture.md): карта production-файла и границы подсистем.
- [Storage](storage.md): ключи, значения по умолчанию, совместимость и время жизни данных.
- [Lifecycle](lifecycle.md): загрузка, запуск и остановка, навигация, восстановление и состояния завершения.
- [Diagnostics](diagnostics.md): журнал, метрики, снимки DOM, проверка страницы и экспорт отчёта.
- [Development](development.md): локальная development-копия, тесты и browser smoke.

## Maintainer

- [Выпуск версии](release-process.md): переиспользуемый SemVer flow, release candidate, публикация и post-release checks.
- [Changelog](../CHANGELOG.md): подтверждённые пользовательские изменения, начиная с 4.0.0.
- [Release notes 4.0.0](release-notes/v4.0.0.md): пользовательское описание первого публичного выпуска HH Apply Assistant после legacy-поколения.
- [Temporary 4.0.0 cutover plan](migration-plan.md): одноразовый runbook только для первого публичного выпуска HH Apply Assistant; не использовать для следующих релизов.

## Community

- Участие в разработке: [RU](../.github/CONTRIBUTING.md) · [EN](i18n/CONTRIBUTING.en.md).
- Сообщение об уязвимости: [RU](../.github/SECURITY.md) · [EN](i18n/SECURITY.en.md).
- [Кодекс поведения](../.github/CODE_OF_CONDUCT.md).
- [Сообщения об ошибках и предложения](https://github.com/tgeruzov/hh-apply-assistant/issues/new/choose) через структурированные формы.
