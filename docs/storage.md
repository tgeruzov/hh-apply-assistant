# Storage и состояние

Текущая версия схемы хранения — 1 (`STORAGE_SCHEMA_VERSION = 1`); все основные ключи используют префикс `hh_apply_assistant_s1_`. Product SemVer и storage schema независимы: например, HH Apply Assistant 2.5.0 может продолжать использовать schema 1. `STORAGE_SCHEMA_VERSION` увеличивается только тогда, когда существующие persisted data нельзя корректно прочитать без migration. Совместимые обновления сохраняют namespace и данные, а несовместимое изменение требует явной migration strategy и release note.

`localStorage` и `sessionStorage` относятся к origin hh.ru. `sessionStorage` живёт в пределах вкладки и сохраняется при full-page navigation этой вкладки; после её закрытия session state исчезает. `localStorage` остаётся между сессиями браузера.

## Настройки

Объект `hh_apply_assistant_s1_settings` нормализуется при чтении:

| Поле | Тип | Default | Валидация |
|---|---|---|---|
| `coverText` | string | стартовый текст текущего RU/EN языка из `TRANSLATIONS` | максимум 5000 символов |
| `useCover` | boolean | `true` | всё, кроме явного `false`, становится `true` |
| `applyOnRejectWarning` | boolean | `false` | `true` только при строгом `true` |
| `skipHidden` | boolean | `true` | внутреннее поле, UI его не показывает |
| `preset` | string | `balanced` | только `safe`, `balanced`, `fast`, `turbo` |
| `limit` | integer | `50` | округление и диапазон 1–500 |

Если settings отсутствуют или JSON/schema повреждены, runtime использует эти defaults. Язык хранится отдельным ключом; default `ru` также определяет стартовый текст чистой установки.

## Ключи localStorage

| Key после префикса | Содержимое и default | Кто читает/пишет | Очистка и lifetime |
|---|---|---|---|
| `settings` | JSON object настроек; default вычисляется при отсутствии | `Settings.load/save`, autosave UI | остаётся между обновлениями; полный сброс вручную |
| `language` | `ru` или `en`; при отсутствии определяется по языку document/browser, затем fallback `ru` | `I18n.init/setLanguage` | остаётся между сессиями; полный сброс вручную |
| `manual_queue` | array до 500 объектов `{vid,url,returnUrl,ts,title}`; default `[]` | automation/watchdog добавляют, UI читает/удаляет/очищает | отдельная кнопка **Очистить** или полный сброс |
| `instance_lock` | `{tabId,leaseId,ts}`; default отсутствует | Start/acquire, watchdog heartbeat, commit guard | удаляется владельцем при Stop/terminal state; stale запись перестаёт быть активной через 30 с и может быть перезаписана |
| `diagnostic_log` | array `{t,lvl,path,tab,lang,msg,...i18n}`; default `[]` | `DiagLog`, Diagnostics UI/export | до 1000 записей; **Очистить сохранённый лог и метрики**; при quota pressure окно сокращается до 300 |
| `metrics` | `{startedAt,counters,timings,selectors,snapshots}` | automation, selectors, проверка страницы/diagnostic export | **Очистить сохранённый лог и метрики**; до 15 snapshots, при failed save остаются последние 3 |
| `ui_open` | строка `0` или `1`; отсутствие означает open | dock/compact panel controller | меняется при collapse/expand; overlay state не сохраняется |

`manual_queue` проверяет URL и требует успешного write/read-back. Одновременное редактирование очереди в нескольких вкладках не является транзакционным merge: последняя подтверждённая запись может основываться на уже устаревшем snapshot списка.

## Ключи sessionStorage

| Key после префикса | Содержимое и default | Кто читает/пишет | Очистка и lifetime |
|---|---|---|---|
| `is_active` | строка `1`; отсутствие означает stopped | Start, bootstrap, watchdog, terminal handlers | удаляется при Stop/done/error/CAPTCHA; сохраняется через навигацию вкладки |
| `return_url` | URL выдачи/страницы возврата | vacancy/response flow | перезаписывается при новом переходе; обычно остаётся до закрытия вкладки/full reset |
| `processed_ids` | JSON array vacancy ID/alias; default `[]` | search filter и terminal handlers | **Сбросить историю**, закрытие вкладки или полный сброс |
| `reload_flag` | строка `1`; отсутствие означает false | response/questionnaire flow и watchdog | удаляется watchdog перед reload поисковой страницы |
| `trap_lock` | `{token,runId,expiresAt}` | response watchdog | удаляется при уходе, Stop или terminal error; default TTL 45 с, expired/invalid запись удаляется при чтении |
| `last_attempt_id` | vacancy ID/alias | redirect/response flow | очищается после завершения response flow; иначе живёт до перезаписи/закрытия вкладки |
| `last_vacancy_meta` | `{vid,title,ts}` с title до 300 символов | vacancy/list parsing и Manual Queue title resolver | перезаписывается последней вакансией; до закрытия вкладки/full reset |
| `tab_id` | случайная строка | runtime init, log и instance lease | создаётся один раз на вкладку и переживает её навигации |
| `sent_count` | integer в строковом виде; default `0` | limit guard и confirmed-success commit | свежий Start, **Сбросить историю**, закрытие вкладки |
| `run_stats` | `{success,manual,skipped,startedAt}` | `Stats` и UI | свежий Start, **Сбросить историю**, закрытие вкладки; attempts вычисляется как сумма трёх counters |

Критические записи `is_active`, `processed_ids` и `sent_count` проверяются read-back. Ошибка чтения тоже считается недостоверным состоянием и останавливает automation до опасного действия.

## Состояние экспортированной очереди

Интерактивный HTML Manual Queue использует `hh_apply_assistant_s1_manual_processed` в `localStorage` контекста самой экспортированной страницы. Ключ содержит map открытых записей. Production userscript на hh.ru его не читает и не очищает; доступность storage для `file:`/`blob:` зависит от браузера, поэтому сохранение markers является best-effort.

## Volatile state

Не всё runtime-состояние хранится в browser storage. В памяти document находятся `currentRunId`, AbortController, timers, флаги loop/response handler и UI controller state. Стабильный `window.__hhApplyAssistantRuntime` предотвращает вторую активную копию текущего runtime в том же document и не меняется вместе с product version. При полном переходе создаётся новый document и память восстанавливается из session/local state.

## Очистка

Пользовательские кнопки предпочтительнее DevTools:

- **Сбросить историю**: `processed_ids`, `sent_count`, `run_stats`;
- **Ручная очередь → Очистить**: `manual_queue`;
- **Диагностика → Дополнительно → Очистить сохранённый лог и метрики**: удаляет прежние `diagnostic_log` и `metrics`; после очистки может появиться новая служебная запись журнала о самом действии.

Для полного сброса удалите ключи с префиксом `hh_apply_assistant_s1_` из Local Storage и Session Storage для hh.ru. Не удаляйте все данные сайта без необходимости: это может завершить hh.ru session. Удаление userscript не очищает origin storage автоматически.
