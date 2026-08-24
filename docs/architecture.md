# Архитектура

HH Apply Assistant поставляется одним production-файлом [hh-apply-assistant.user.js](../hh-apply-assistant.user.js). Build step и внешние runtime-зависимости отсутствуют. Внутри IIFE код разделён на логические секции; это не отдельные JavaScript modules, но границы ответственности стабильны и используются тестами.

## Карта runtime

| Подсистема | Ответственность |
|---|---|
| Metadata и singleton | `@match`, permissions, update source и защита от второй инъекции в тот же document через `window.__hhApplyAssistantV4Runtime` |
| Configuration и i18n | defaults, валидация настроек, RU/EN translations и форматирование UI/diagnostics |
| Storage layer | безопасные local/session wrappers, verified writes для критического состояния и v4 namespace |
| State | processed IDs, run counters, URL возврата, Manual Queue, trap lock и cross-tab lease |
| Diagnostics | постоянный log, metrics, snapshots, Healthcheck и report export |
| DOM adapter | точные selectors, scoped compatibility fallbacks, heuristics, visibility checks и ожидание через MutationObserver |
| Automation engine | выбор карточки, переход на вакансию, чтение, распознавание response flow, submit confirmation и terminal outcome |
| Watchdog | проверка URL/состояния раз в секунду, response page flow, CAPTCHA, lease heartbeat и remount UI |
| UI | панель, режимы, settings autosave, статистика, ручная очередь, diagnostics и responsive docking |

## Поток управления

1. Metadata запускает файл на search, vacancy и applicant response paths.
2. Runtime загружает язык и валидированную конфигурацию, создаёт `TAB_ID`, инициализирует log/metrics и запускает watchdog.
3. `bootstrap()` монтирует панель. Если `is_active` пережил full-page navigation, через 1,5 секунды планируется resume.
4. Start создаёт новый `runId`, сохраняет running state и пытается захватить lease с read-back проверкой.
5. Search loop получает видимые apply buttons, исключает processed IDs и обрабатывает текущую страницу. При SPA-перерисовке допускается до трёх rescans исчезнувших карточек.
6. Vacancy flow получает стабильный ID и title, имитирует чтение по выбранному профилю, затем распознаёт standard form, уже отправленный отклик, reject warning, relocation dialog, response redirect, questionnaire, CAPTCHA или timeout.
7. Успех фиксируется только после commit guard и надёжного подтверждения. Неясный исход сохраняется в Manual Queue; критическая ошибка persistence останавливает run.
8. Watchdog обрабатывает `/applicant/vacancy_response`, возвращает вкладку к сохранённой выдаче и при установленном reload flag обновляет только search page.

Подробная последовательность состояний находится в [lifecycle.md](lifecycle.md).

## DOM integration

`SELECTORS` содержит известные `data-qa` и compatibility selectors hh.ru. Поиск устроен ступенчато:

1. точный selector;
2. scoped fallback внутри активной формы или modal;
3. semantic heuristic только для поддерживаемого элемента.

Широкий document scan не должен превращать произвольный текст вакансии в подтверждение отправки. Post-submit strong text разрешён только в отдельной confirmation phase, а обычное распознавание outcome ограничено response scope.

`waitForElement` и `waitForCondition` используют MutationObserver и ограниченный fallback polling. Mutations, созданные собственной панелью, отфильтровываются, чтобы diagnostics/UI не будили response detector.

## Идентификаторы вакансий

Предпочтительный ID извлекается из `/vacancy/{id}`, `vacancyId` или encoded `vacancyId`. При отсутствии числового ID создаётся FNV-1a alias по URL или содержимому карточки. Это позволяет завершить обработку рекламных/нестандартных карточек без бесконечного повтора.

Title для Manual Queue выбирается по приоритету: vacancy DOM, JSON-LD `JobPosting`, Open Graph, очищенный `document.title`, затем session cache последней вакансии.

## Concurrency и fencing

Внутри вкладки `runId` отделяет поколения Start/Stop/Start. Старый async continuation не считается актуальным после увеличения `currentRunId` или AbortController cancellation.

Между вкладками используется generation-aware lease в `localStorage`: `tabId`, уникальный `leaseId`, timestamp и TTL 30 секунд. Захват включает запись, 60-миллисекундное race window и точный read-back. Heartbeat продлевает только текущее подтверждённое поколение.

Перед submit, записью успеха и критической навигацией `guardOwnedCommit()` последовательно проверяет `runId` и обновляет lease. Неопределённость чтения/записи трактуется как потеря ownership.

## Persistence policy

Критические значения (`is_active`, processed IDs, sent count и Manual Queue) требуют успешной записи; для terminal-state и очереди используется read-back. Settings failure во время активного run также приводит к остановке.

Diagnostic log, metrics и часть UI state являются best-effort. При storage quota pressure log сокращается, snapshots оставляют меньшее окно, но automation не падает только из-за невозможности сохранить вспомогательную диагностику.

Все ключи и их lifetime описаны в [storage.md](storage.md).

## UI

Панель строится программно и не использует Shadow DOM. `HostLayoutReservation` измеряет доступную ширину и выбирает full, compact или overlay mode. Docked panel резервирует место у реального root hh.ru, не меняя глобальную ширину `body`.

UI поддерживает remount после SPA-удаления, keyboard navigation для интерактивных controls, синхронизацию RU/EN и отдельные controllers для slider, diagnostics, stats и Manual Queue. Turbo animation создаётся только при видимом Turbo mode и очищается при скрытии/переходе режима.

## Security и privacy boundary

Userscript работает с `@grant none` в page context hh.ru. Runtime не загружает внешний код и не использует transport API. Diagnostic и queue exports формируются через `Blob`/object URL. Это упрощает аудит, но означает, что storage origin hh.ru находится в общей границе с кодом страницы; подробности приведены в [PRIVACY.md](../PRIVACY.md).

## Проверки

Node tests извлекают отдельные production sections и запускают их в контролируемых harnesses. Они покрывают response confirmation, persistence failures, singleton, SPA remount, diagnostics, performance, concurrency fencing и responsive docking. Browser fixture для docking хранится отдельно и не заменяет ручной smoke на hh.ru.

Команды и тестовый workflow описаны в [development.md](development.md).
