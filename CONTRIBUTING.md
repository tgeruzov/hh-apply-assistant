# Участие в разработке

[Русский](CONTRIBUTING.md) | [English](CONTRIBUTING.en.md)

HH Apply Assistant принимает bug fixes, улучшения распознавания сценариев, UI-правки, тесты и документацию. Крупное изменение automation behavior, storage schema или модели разрешений сначала лучше обсудить в Issue: такие изменения труднее безопасно проверить на реальном hh.ru.

Обычные ошибки сообщайте через [форму сообщения об ошибке](https://github.com/tgeruzov/hh-auto-responder/issues/new?template=bug_report.yml). Уязвимости и случаи с чувствительными данными направляйте по [Security Policy](SECURITY.md), а не в публичную форму. Во всех обсуждениях действует [Code of Conduct](CODE_OF_CONDUCT.md).

## Окружение

Понадобятся:

- Git;
- Node.js 24 для совпадения с CI;
- настольный Chrome и Tampermonkey для ручной проверки.

Сборки и установки npm-пакетов нет.

```bash
git clone https://github.com/tgeruzov/hh-auto-responder.git
cd hh-auto-responder
node --check hh-apply-assistant.user.js
node --test
```

Локальная установка development-копии и карта исходника описаны в [docs/development.md](docs/development.md).

## Работа над изменением

1. Обновите `main` в canonical public repository и создайте от него отдельную ветку. Доступ к приватному development repository внешнему contributor не нужен.
2. Сведите изменение к одному понятному bug или use case.
3. Если затронут пользовательский текст, обновите RU и EN в `TRANSLATIONS`. Если изменился основной README, синхронизируйте `README.md` и `README.en.md` по фактам.
4. Для новых storage fields определите default, валидацию, lifetime и совместимость с текущей storage schema. Увеличивайте её версию только для несовместимого persisted format, а не вместе с product major.
5. Не ослабляйте `runId`/lease guards перед click, submit, записью успеха или навигацией.
6. Обновите тесты и документацию публичного поведения.

Не добавляйте внешнюю runtime-зависимость, сетевой запрос, `@grant`, `@connect`, `@require` или `@resource` без описания причины и последствий для privacy/security.

## Проверка

Перед pull request выполните:

```bash
node --check hh-apply-assistant.user.js
node --test
node scripts/validate-repository.mjs
git diff --check
```

Изменения UI или automation дополнительно проверяются в Tampermonkey:

- **Запустить отклики**, **Остановить** и повторный запуск;
- нужный тип страницы hh.ru и возврат к выдаче;
- RU и EN;
- широкая, компактная и открытая поверх страницы компоновка, если затронут интерфейс;
- **Ручная очередь** и **Диагностика**, если изменён соответствующий сценарий;
- отсутствие новых console errors.

Используйте тестовый контекст без реальных персональных данных. Не добавляйте в fixtures, screenshots, issues и commits cookies, токены, сопроводительные письма или неотредактированные diagnostic exports.

## Pull request

В описании укажите причину, пользовательский эффект и выполненные проверки. Отдельно отметьте влияние на automation, UI, RU/EN, storage, diagnostics и privacy. `CHANGELOG.md` нужен для значимого пользовательского изменения; version bump выполняется в release PR, а не в каждом обычном PR.
