# Разработка

Проект состоит из одного production userscript и dependency-free Node tests. Сборщика, package manager manifest и generated bundle нет: файл в корне является и source of truth, и устанавливаемым artifact.

## Требования

- Git;
- Node.js 24 для совпадения с `.nvmrc` и CI;
- Chrome с Tampermonkey для browser smoke.

```bash
git clone https://github.com/tgeruzov/hh-auto-responder.git
cd hh-auto-responder
node --check hh-apply-assistant.user.js
node --test
```

`npm install` не нужен.

## Структура

- `hh-apply-assistant.user.js`: metadata, runtime, UI и styles;
- `tests/*.test.mjs`: Node test runner harnesses и source invariants;
- `tests/hh-docking-browser-fixture.html`: ручной fixture responsive docking;
- `scripts/validate-repository.mjs`: metadata/version/docs validation без зависимостей;
- `docs/`: пользовательская и техническая документация;
- `.github/`: CI и contribution forms.

Логическая карта production-файла находится в [architecture.md](architecture.md).

## Development-копия в Tampermonkey

1. Откройте Dashboard и создайте новый script.
2. Скопируйте `hh-apply-assistant.user.js` целиком.
3. Чтобы development-копия не заменилась release source из `main`, отключите проверку обновлений для этой записи в Tampermonkey либо удалите `@updateURL` и `@downloadURL` только в локальном editor copy.
4. Добавьте к `@name` локальный suffix, чтобы отличать копию, но не держите release и dev scripts одновременно включёнными на hh.ru.
5. После каждого изменения вставьте актуальный source, сохраните и перезагрузите страницу.

Не коммитьте dev-only metadata или временные selectors в production file.

## Где менять код

- Metadata, version и permissions находятся в начале файла.
- `TRANSLATIONS.ru` и `TRANSLATIONS.en` должны оставаться симметричными по keys.
- `PRESETS`, `DEFAULTS`, `TUNING`, `SELECTORS` являются публично документируемой конфигурацией.
- Storage contract сосредоточен в `KEYS`, `Settings`, `State`, `DiagLog`, `Metrics` и `Stats`.
- Response engine начинается с page/outcome detection и заканчивается `startLoop`, Stop/CAPTCHA/persistence handlers и watchdog.
- UI состоит из HTML/styles и controllers; persistent collapse state отделён от responsive mode.

Имена секций и функций используются тестами для извлечения production fragments. При крупном перемещении кода проверьте, что harness boundaries остались корректными.

## Storage и совместимость

v4 намеренно игнорирует старые namespaces. Внутри `hh_apply_assistant_v4_` изменение schema должно быть backward-compatible либо сопровождаться явной migration strategy и release note.

Для нового persistent field определите:

- default и type normalization;
- local или session lifetime;
- writer/readers и clear path;
- поведение при malformed JSON, read error, write error и quota pressure;
- необходимость verified write/read-back;
- privacy impact и попадание в exports.

Не используйте очистку всего storage origin в runtime: там находятся данные hh.ru.

## Automation changes

Отклик является необратимым действием. Перед новым click/submit/navigation сохраните существующую последовательность guards:

1. актуальный `runId` и отсутствие Stop;
2. ownership текущего generation lease;
3. response-specific outcome/confirmation;
4. persistence terminal state до ухода со страницы, если это требуется flow.

Не расширяйте document-wide text heuristics без scoped negative tests. Проверяйте уже применённую вакансию отдельно от нового подтверждённого успеха. Questionnaire flow не должен автоматически отвечать на `task_*` fields.

## RU/EN

UI string добавляется в обе ветки `TRANSLATIONS` с одинаковым key. Проверьте:

- main panel, diagnostics и Manual Queue;
- confirmation dialogs, title/aria-label и empty states;
- log translation после переключения языка;
- HTML export на RU и EN;
- default cover text при чистой установке соответствующего языка.

Корневые README синхронизируются по версиям, defaults, install/update flow, supported paths и privacy claims; формулировки не обязаны быть дословным переводом.

## Browser smoke

Для engine/UI изменения используйте тестовый hh.ru account/context и минимальный лимит. Не проверяйте необратимый submit, если изменение можно доказать до этого шага.

Минимальный набор:

- чистая загрузка supported search page;
- Start, Stop во время wait и повторный Start;
- переход search → vacancy → response/search;
- сценарий Manual Queue без фактической повторной отправки;
- Healthcheck, filter/search, report export;
- RU/EN;
- wide dock, compact и overlay; collapse/expand и keyboard focus;
- две вкладки для busy lease, если затронут concurrency.

DOM hh.ru меняется независимо от репозитория. Зафиксируйте тип страницы и relevant `data-qa`, но не добавляйте персональный HTML dump.

## Автоматические проверки

```bash
node --check hh-apply-assistant.user.js
node --test
node scripts/validate-repository.mjs
git diff --check
```

`node --test` сейчас содержит 100 tests, один из которых является browser fixture wrapper и штатно skipped без отдельного browser harness. CI выполняет те же четыре группы проверок на push и pull request.

После изменения документации просмотрите rendered Markdown на GitHub или совместимом preview: validator проверяет локальные paths/anchors и heading hierarchy, но не внешний URL и не визуальное качество текста.
