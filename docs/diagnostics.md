# Диагностика

Diagnostics предназначена для разбора selector changes, response flow, navigation, locks и storage failures. Журнал и metrics сохраняются между переходами и сессиями, пока пользователь не очистит их.

## Diagnostic log

Каждая запись содержит:

- timestamp;
- уровень `INFO` или `ERR`;
- `pathname + search`, обрезанный до 300 символов;
- `TAB_ID` и язык записи;
- сообщение длиной до 1000 символов;
- i18n key/params, если сообщение удалось распознать для последующего перевода UI.

Log хранит до 1000 последних записей. Запись INFO сохраняется с debounce 500 мс, ошибка flush выполняется сразу. Если полный массив не помещается в localStorage, остаются последние 300 записей.

Runtime также слушает `error` и `unhandledrejection`. Внутренние ошибки HH Apply Assistant пишутся как ERR, суммарно максимум 50 error/rejection events на document. Внешний шум hh.ru/стороннего кода записывается как INFO с отдельным marker, суммарно максимум 5 внешних events на document.

## Экран Diagnostics

Экран позволяет:

- показать все записи или только ERR;
- искать по времени, уровню и тексту с debounce 140 мс;
- сворачивать последовательные одинаковые сообщения в группу и раскрывать отдельные timestamps;
- включать/выключать autoscroll;
- скрыть текущий вид через **Очистить вид**;
- удалить прежний сохранённый журнал и метрики через **Дополнительно → Очистить сохранённый лог и метрики**;
- скачать полный report;
- проверить текущую страницу кнопкой **Проверить страницу**.

**Очистить вид** не удаляет storage. Оно ставит offset на текущий конец журнала; новые записи снова появятся. Search/filter/autoscroll являются состоянием текущего document runtime и не имеют отдельного persistent key.

**Очистить сохранённый лог и метрики** удаляет прежние данные. После очистки скрипт записывает новое служебное событие о выполненном действии, поэтому журнал может сразу снова содержать одну запись.

## Metrics

`hh_apply_assistant_s1_metrics` содержит:

- counters сценариев, selector variants, locks, storage failures и UI/runtime событий;
- timing aggregates `{n,sum,last,max}`;
- selector health `{found,missing}`;
- DOM snapshots.

Metrics не ограничивают число разных counter names, но их набор задаётся исходником. Кнопка **Очистить сохранённый лог и метрики** создаёт новый объект с `startedAt` и пустыми секциями.

## DOM snapshots

Snapshot создаётся в местах, где response flow не распознан, обнаружена CAPTCHA/questionnaire или нужен разбор selector. Хранятся последние 15; при storage quota failure — последние 3.

Snapshot может содержать:

- текущий path до 200 символов;
- факт наличия modal;
- до 50 релевантных `data-qa` nodes: tag, selector value, visibility и короткий text fragment;
- до 10 textarea descriptions: `name`, `data-qa`, placeholder, visibility;
- до 15 `task_*` field descriptions: tag/type/name/visibility;
- до 20 modal buttons: `data-qa`, visibility и короткий text fragment.

Значения form controls не копируются. Однако labels, placeholders, URL query parameters и DOM text могут быть чувствительными в конкретном контексте, поэтому snapshot нельзя считать автоматически анонимным.

## Проверка страницы

Кнопка **Проверить страницу** проверяет шесть групп selectors с учётом текущей страницы:

- apply button и vacancy link на выдаче;
- apply button на vacancy page;
- attach-cover scenario;
- submit button и textarea response form.

Результат для элемента:

- основной selector найден;
- найден scoped/heuristic fallback;
- обязательный selector не найден (ERR);
- проверка неприменима на текущей странице и пропущена.

Textarea или modal button вне открытой формы закономерно неприменимы. На пустой выдаче list selectors также не считаются ошибкой. В конце проверка пишет summary и состояние instance lock.

## Diagnostic report

Скачивается файл `hh_apply_assistant_log_YYYY-MM-DDTHH-MM-SS.txt`. Он включает:

1. version, export time, полный текущий URL и user agent;
2. tab ID, running flag, sent/limit, processed/manual counts;
3. raw instance lock, trap/reload flags, last attempt и return URL;
4. settings snapshot, где `coverText` заменён количеством символов;
5. metrics, timings и selector statistics;
6. весь сохранённый log;
7. DOM snapshots.

Report создаётся локально через `Blob` и object URL. Runtime не отправляет его автоматически.

## Перед bug report

1. Очистите старую диагностику, если она мешает выделить проблему (предварительно сохраните нужный report).
2. Нажмите **Проверить страницу** на проблемной странице.
3. Воспроизведите один сценарий.
4. Скачайте report.
5. Просмотрите current URL, return URL, log paths и snapshot text; удалите персональные или секретные данные.
6. Приложите только релевантный отредактированный фрагмент, если полный report не нужен.

Bug form просит версию script/browser/Tampermonkey, режим, тип страницы и ожидаемый outcome. Privacy boundary описан в [PRIVACY.md](../PRIVACY.md).
