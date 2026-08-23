# Архитектура HH Apply Assistant v4.0.0

Документ предназначен для contributors и maintainers. Пользовательские инструкции находятся в [README](../README.md) и [руководстве](user-guide.md).

## Структура репозитория

- `script.js` — production userscript без build step и внешних runtime-зависимостей;
- `tests/*.test.mjs` — тесты на встроенном Node.js test runner;
- `tests/hh-docking-browser-fixture.html` — browser fixture для docking/responsive сценариев;
- `README.md` и `docs/` — пользовательская и техническая документация;
- `.github/` — CI и минимальные contribution templates.

## Runtime

Metadata ограничивает запуск страницами поиска, вакансии и формы отклика hh.ru. Runtime защищён от повторной инъекции в тот же document.

Основной поток:

1. UI загружает валидированную конфигурацию из storage.
2. **Старт** создаёт новое поколение run и пытается захватить cross-tab lease.
3. Поисковый цикл собирает ещё не обработанные карточки текущей страницы.
4. Vacancy flow открывает карточку, выполняет профиль чтения и распознаёт сценарий отклика.
5. До необратимого click/submit/navigation проверяются актуальный `runId` и поколение lease.
6. Итог сохраняется как подтверждённый успех, Manual Queue outcome или пропуск.
7. Watchdog поддерживает SPA/reload lifecycle и возврат к выдаче.

## Cross-tab lease

Lease хранится в `localStorage` и содержит `tabId`, уникальный `leaseId` и timestamp. Вкладка получает ownership только после записи и точной read-back проверки. Активная вкладка продлевает lease, а истёкший lease может быть захвачен другим поколением.

Ошибки чтения, записи или подтверждения трактуются fail-closed. Старая вкладка не должна проходить commit guard после takeover и не перезаписывает чужое поколение.

## Навигация и trap lock

Watchdog следит за URL, поддерживает UI после SPA-перерисовок и обрабатывает `/applicant/vacancy_response`. Обычная full-page форма отправляется в рамках стандартного flow, а анкета с вопросами сохраняется в Manual Queue.

Trap lock в `sessionStorage` содержит token, `runId` и expiration. Просроченная или невалидная запись удаляется; timer проверяет token перед очисткой, чтобы старое поколение не сняло новый lock.

## Распознавание сценариев

После клика скрипт ждёт первый надёжно распознанный outcome:

- стандартная modal/form;
- предложение прикрепить письмо после отклика;
- прямое подтверждение;
- предупреждение о вероятном отказе;
- relocation modal;
- редирект на форму или вопросы;
- CAPTCHA;
- timeout или неподтверждённый исход.

Модалка с ещё не отправленной формой проверяется раньше post-submit предложения письма. Состояние «Вы откликнулись» распознаётся до нового клика и не увеличивает счётчик.

## Идентификаторы и Manual Queue

Предпочтительный ID извлекается из vacancy URL. Если числовой ID недоступен, используется стабильный псевдоним по URL или содержимому карточки. Для рекламных ссылок обработанными могут быть помечены и alias карточки, и фактический vacancy ID.

Название вакансии берётся по приоритету:

1. DOM страницы вакансии;
2. JSON-LD `JobPosting`;
3. Open Graph title;
4. очищенный `document.title`.

Последняя метаинформация о вакансии кэшируется в `sessionStorage`, чтобы сохранить понятное название после редиректа.

## Persistence

Критические settings и terminal-state записи проверяются после записи. Неопределённый итог не считается успехом: run останавливается, чтобы не продолжать с недостоверным состоянием.

Diagnostics и часть UI persistence являются best-effort. При storage quota pressure журнал и DOM snapshots сокращаются до меньшего окна.

## Диагностика и privacy boundary

Diagnostic report включает версию, время, текущий URL, user agent, состояние run, storage/lease summary, метрики, журнал и ограниченные snapshots. `coverText` заменяется количеством символов; значения полей не сохраняются в snapshot.

Manual Queue export и diagnostic report создаются через `Blob` и object URL. Runtime не содержит внешнего transport API, `@require` или динамического исполнения кода. Эти свойства проверяются при release pass и должны сохраняться либо явно документироваться при изменении модели.

## Проверки

```bash
node --check script.js
node --test
git diff --check
```

Изменения storage, navigation, selector fallbacks, RU/EN или необратимых действий требуют соответствующих regression tests.
