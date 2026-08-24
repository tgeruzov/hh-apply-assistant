// ==UserScript==
// @name         HH Apply Assistant
// @namespace    http://tampermonkey.net/
// @version      4.0.0
// @description  HH Apply Assistant — инструмент автоматизации откликов на вакансии hh.ru (HeadHunter)
// @author       Timur Geruzov
// @license      GPL-3.0-only
// @homepageURL  https://github.com/tgeruzov/hh-auto-responder
// @supportURL   https://github.com/tgeruzov/hh-auto-responder/issues
// @updateURL    https://raw.githubusercontent.com/tgeruzov/hh-auto-responder/main/hh-apply-assistant.user.js
// @downloadURL  https://raw.githubusercontent.com/tgeruzov/hh-auto-responder/main/hh-apply-assistant.user.js
// @match        *://*.hh.ru/search/vacancy*
// @match        *://*.hh.ru/vacancy/*
// @match        *://*.hh.ru/applicant/vacancy_response*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '4.0.0';

    // Повторная инъекция userscript в тот же document не должна создавать второй runtime.
    // Полная навигация получает новый window, а SPA/bfcache продолжают использовать эту запись.
    const RUNTIME_KEY = '__hhApplyAssistantRuntime';
    const existingRuntime = window[RUNTIME_KEY];
    if (existingRuntime && existingRuntime.active) return;

    const runtimeRecord = {
        active: true,
        version: VERSION,
        watchdogIntervalId: null,
        domReadyObserver: null,
        globalListeners: [],
        teardown: null
    };
    window[RUNTIME_KEY] = runtimeRecord;

    function addRuntimeListener(target, type, handler, options) {
        if (!target || typeof target.addEventListener !== 'function') return;
        target.addEventListener(type, handler, options);
        runtimeRecord.globalListeners.push({ target, type, handler, options });
    }

    // ─────────────────────────────────────────────────────────────
    //  1. КОНСТАНТЫ И КОНФИГУРАЦИЯ
    // ─────────────────────────────────────────────────────────────

    const HHA_PREFERRED_PANEL_WIDTH = 410;
    const HHA_MIN_PANEL_WIDTH = 340;
    // Minimum practical width reserved for hh.ru desktop layout before compact assistant mode is used.
    const HHA_MIN_HOST_WIDTH = 980;

    // Версия storage schema меняется только при несовместимом формате persisted data.
    const STORAGE_SCHEMA_VERSION = 1;
    const STORAGE_PREFIX = `hh_apply_assistant_s${STORAGE_SCHEMA_VERSION}_`;
    const KEYS = {
        settings: STORAGE_PREFIX + 'settings',
        language: STORAGE_PREFIX + 'language',
        isRunning: STORAGE_PREFIX + 'is_active',
        returnUrl: STORAGE_PREFIX + 'return_url',
        history: STORAGE_PREFIX + 'processed_ids',
        needF5: STORAGE_PREFIX + 'reload_flag',
        trapLock: STORAGE_PREFIX + 'trap_lock',
        instanceLock: STORAGE_PREFIX + 'instance_lock',
        lastAttempt: STORAGE_PREFIX + 'last_attempt_id',
        manualList: STORAGE_PREFIX + 'manual_queue',
        manualProcessed: STORAGE_PREFIX + 'manual_processed',
        lastVacancyMeta: STORAGE_PREFIX + 'last_vacancy_meta',
        tabId: STORAGE_PREFIX + 'tab_id',
        sentCount: STORAGE_PREFIX + 'sent_count',
        diagLog: STORAGE_PREFIX + 'diagnostic_log',
        metrics: STORAGE_PREFIX + 'metrics',
        uiOpen: STORAGE_PREFIX + 'ui_open',
        stats: STORAGE_PREFIX + 'run_stats'
    };

    // Технические тайминги - не настраиваются пользователем.
    const TUNING = {
        scrollStepMs: 200,        // шаг человеческого скролла
        waitForModalMs: 8000,     // ожидание реакции после клика Откликнуться
        confirmWaitMs: 6000,      // ожидание подтверждения после отправки формы
        responsePagePendingMs: 16000, // обычный full-page submit ждём без повторного клика
        instanceLockTtl: 30000,   // TTL кросс-вкладочной блокировки
        forceSubmitAttempts: 3    // попыток дожать отправку при предупреждении об отказе
    };

    // Максимум записей в постоянном диагностическом логе (защита от переполнения localStorage)
    const DIAG_LOG_MAX = 1000;
    // Максимум снимков DOM, которые храним для анализа изменений вёрстки
    const DOM_SNAPSHOT_MAX = 15;

    // Важные селекторы, используемые в скрипте
    const SELECTORS = {
        // Кнопка "Откликнуться" в карточке результатов поиска
        applyBtn: '[data-qa="vacancy-serp__vacancy_response"], button[data-qa="vacancy-serp__vacancy_response"]',
        // Кнопки "Откликнуться" на странице самой вакансии (верхняя/нижняя)
        vacancyApply: '[data-qa="vacancy-response-link-top"], a[data-qa="vacancy-response-link-top"], [data-qa="vacancy-response-link-bottom"], a[data-qa="vacancy-response-link-bottom"]',
        // Сценарий А: резюме уже отправлено, предлагается прикрепить сопроводительное
        attachCoverBtn: '[data-qa="responded-success-attach-cover-letter"]',
        // Кнопка/переключатель "прикрепить сопроводительное" ВНУТРИ формы отклика (до отправки):
        // раскрывает скрытое поле письма. Модалка и полностраничная форма, новая и legacy-вёрстка.
        attachCoverInModal: '[data-qa="responded-success-attach-cover-letter"], [data-qa="add-cover-letter"], button[data-qa="add-cover-letter"], [data-qa="vacancy-response-letter-toggle"]',
        // Поле ввода сопроводительного письма (новая вёрстка + фоллбек на старую)
        letterTextarea: 'textarea[name="text"], textarea[data-qa="vacancy-response-popup-form-letter-input"], textarea[name="coverLetter"]',
        // Кнопка отправки формы сопроводительного (новая вёрстка + фоллбек)
        letterSubmit: '[data-qa="vacancy-response-letter-submit"], button[data-qa="vacancy-response-letter-submit"], button[data-qa="vacancy-response-submit-popup"], [data-qa="vacancy-response-submit-popup"]',
        // Подтверждение успешной отправки отклика (кнопка перехода в чат)
        responseChat: '[data-qa="vacancy-response-link-view-topic"]',
        nativeWrapper: '[data-qa="textarea-native-wrapper"]',
        relocationBtn: '[data-qa="relocation-warning-confirm"]',
        rejectWarning: '[data-qa="response-reject-warning"]',
        vacancyLink: 'a[data-qa="serp-item__title"], a[data-qa="vacancy-serp__vacancy-title"]',
        vacancyCard: 'div[data-qa="vacancy-serp__vacancy"], .vacancy-serp-item'
    };


    // ─────────────────────────────────────────────────────────────
    //  1.1. ЛОКАЛИЗАЦИЯ (i18n Core)
    // ─────────────────────────────────────────────────────────────

    const SUPPORTED_LANGUAGES = ['ru', 'en'];
    const DEFAULT_LANGUAGE = 'ru';

    const LOCALE_TAGS = {
        ru: 'ru-RU',
        en: 'en-US'
    };

    const TRANSLATIONS = {
        ru: {
            presets: {
                safe: {
                    label: 'Безопасный'
                },
                balanced: {
                    label: 'Баланс'
                },
                fast: {
                    label: 'Быстрый'
                },
                turbo: {
                    label: 'Турбо'
                }
            },
            languages: {
                ru: 'Русский',
                en: 'Английский'
            },
            cover: {
                defaultText: 'Добрый день! Заинтересовала ваша вакансия. Опыт релевантен, подробности в резюме. Буду рад обратной связи!',
                title: 'Сопроводительное письмо',
                placeholder: 'Текст сопроводительного письма...',
                rejectWarningLabel: 'Откликаться при предупреждении HH',
                rejectWarningHelpAria: 'О настройке отклика при предупреждении HH',
                rejectWarningHelpTitle: 'Что делает эта настройка',
                rejectWarningHelpText: 'Если hh.ru покажет предупреждение о вероятном отказе, ассистент всё равно отправит отклик.'
            },
            status: {
                idle: 'Ожидание',
                running: 'В работе',
                runningTurbo: 'В работе · Турбо',
                stopped: 'Остановлено',
                error: 'Внимание',
                done: 'Завершено',
                busyTab: 'Занято другой вкладкой',
                returningToList: 'Возврат к списку...',
                waitingToReturn: 'Ожидание возврата...',
                captchaStopped: 'Обнаружена капча — остановлено',
                storageFailed: 'Сбой сохранения Manual Queue',
                autoStarting: 'Авто-запуск...'
            },
            panel: {
                minimizeTitle: 'Свернуть панель',
                expandTitle: 'Развернуть HH Apply Assistant',
                expandRunningTitle: 'HH Apply Assistant работает · развернуть',
                langSwitchLabel: 'Язык интерфейса',
                modeTitle: 'Режим работы',
                modeHelpAria: 'О режимах работы',
                modeHelpTitle: 'Ориентировочная производительность',
                modeHelpSafeTitle: 'Безопасный',
                modeHelpSafeText: '≈ 0,5–1 отклик/мин',
                modeHelpBalancedTitle: 'Баланс',
                modeHelpBalancedText: '≈ 1–2 отклика/мин',
                modeHelpFastTitle: 'Быстрый',
                modeHelpFastText: '≈ 2–4 отклика/мин',
                modeHelpTurboTitle: 'Турбо',
                modeHelpTurboText: '≈ 6–12 откликов/мин',
                modeHelpNote: 'Скорость ориентировочная: загрузка страниц и время ответа HH могут заметно влиять на результат.',
                autosaveIdle: 'Изменения сохраняются автоматически',
                autosaveSaved: 'Сохранено',
                limitLabel: 'Лимит откликов за запуск',
                limitShort: 'Лимит',
                startBtn: 'Запустить отклики',
                stopBtn: 'Остановить',
                resetHistory: 'Сбросить историю',
                resetHistoryTitle: 'Сбросить историю обработанных вакансий, счётчик и статистику запуска (лимит не изменится)',
                diagnostics: 'Диагностика',
                diagnosticsTitle: 'Открыть диагностику и лог',
                statsTitle: 'Статистика запуска',
                statsProgressTitle: 'Отправлено откликов из лимита за запуск',
                statAttempts: 'Попыток',
                statSuccess: 'Успешно',
                statManual: 'В ручной',
                statSkipped: 'Пропущено',
                manualTitle: 'Ручная очередь',
                manualCountTitle: 'Сохранено вакансий для ручного отклика',
                manualExport: 'Экспорт',
                manualClear: 'Очистить',
                manualEmpty: 'Очередь пуста · Вакансии с вопросами сохраняются сюда автоматически',
                manualNoTitle: 'Название недоступно',
                manualOpen: 'Открыть',
                manualOpenTitle: 'Открыть вакансию в новой вкладке',
                manualUnsafeUrl: 'Ссылка не прошла проверку безопасности',
                manualRemoveTitle: 'Удалить из очереди',
                manualRemove: 'Удалить',
                manualMore: 'Вся очередь ({count}) ↗',
                manualMoreTitle: 'Открыть интерактивную страницу со всей очередью вакансий'
            },
            diag: {
                backTitle: 'Вернуться в основную панель',
                backBtn: 'Назад',
                title: 'Диагностика',
                downloadLog: 'Скачать лог',
                downloadLogTitle: 'Скачать полный диагностический отчет',
                checkSelectors: 'Проверить страницу',
                checkSummaryIdle: '',
                checkSummaryProgress: '{passed}/3',
                checkSummaryOk: 'OK',
                filterLabel: 'Фильтры лога',
                filterAll: 'Все',
                filterErrors: 'Ошибки',
                searchPlaceholder: 'Поиск по логам...',
                searchLabel: 'Поиск по диагностическому логу',
                clearSearch: 'Очистить поиск',
                autoScroll: 'Автопрокрутка',
                noEntries: 'Ничего не найдено',
                emptySearchHint: 'Попробуйте изменить запрос или фильтр',
                errorsOnly: 'Только ошибки',
                moreBtn: 'Дополнительно',
                moreTitle: 'Дополнительные действия',
                clearView: 'Очистить вид',
                clearAll: 'Очистить сохранённый лог и метрики',
                badgeTitle: '{errText} в диагностическом логе · Открыть диагностику',
                badgeTitleClean: 'Открыть диагностику и лог',
                emptyTitle: 'Записей пока нет',
                emptyHint: 'Диагностические события появятся здесь во время работы',
                emptyNoErrorsTitle: 'Ошибок нет',
                emptyNoErrorsHint: 'В диагностическом логе пока нет ошибок',
                repeatExpand: 'Развернуть группу повторов',
                repeatCollapse: 'Свернуть группу повторов'
            },
            confirm: {
                clearDiag: 'Очистить сохранённый диагностический лог и метрики? (выгрузите файл перед очисткой, если нужен для анализа)',
                resetHistory: 'Сбросить историю обработанных вакансий и статистику запуска? Счётчик отправленных откликов также будет обнулён, и ассистент сможет обработать эти вакансии заново. Установленный лимит не изменится.',
                clearManual: 'Очистить сохранённый список вакансий ручной очереди?',
                removeManual: 'Удалить эту вакансию из ручной очереди?'
            },
            alert: {
                manualEmpty: 'Список пуст',
                manualOpenBlocked: 'Браузер заблокировал открытие очереди. Разрешите всплывающие окна и повторите попытку.'
            },
            health: {
                starting: 'Проверяю текущую страницу...',
                applyBtnList: 'Кнопка отклика (список)',
                vacancyApply: 'Кнопка отклика (страница вакансии)',
                vacancyLink: 'Ссылка вакансии (карточка)',
                attachCoverBtn: 'Прикрепить письмо (сценарий А)',
                letterSubmit: 'Кнопка отправки письма',
                letterTextarea: 'Поле сопроводительного письма',
                reasons: {
                    emptySearch: 'не применимо — список вакансий пуст',
                    onVacancyPage: 'не применимо на странице вакансии',
                    onResponsePage: 'не применимо на странице формы отклика',
                    notApplicable: 'не применимо на текущей странице',
                    alreadyApplied: 'не требуется — уже откликались',
                    onSearchPage: 'не применимо на странице поиска',
                    notInScenario: 'не требуется в текущем сценарии',
                    questionnaire: 'не применимо — анкета с вопросами работодателя',
                    modalNotOpen: 'не применимо — форма отклика не открыта',
                    letterNotExpanded: 'не применимо — форма письма не раскрыта'
                },
                statusOk: '{name}: OK ({sel})',
                statusFallback: '{name}: ЭВРИСТИЧЕСКИ НАЙДЕНО (селектор {sel} не сработал)',
                statusNotFound: '{name}: НЕ НАЙДЕНО ({sel})',
                statusSkipped: 'Пропуск — {name}: {reason}',
                summary: 'Проверка страницы завершена: {okCount} OK · {skipCount} не применимо · {errText}.',
                instanceLock: 'Блокировка экземпляра: tabId={tabId}, ts={ts}',
                instanceLockMissing: 'Блокировка экземпляра: отсутствует'
            },
            plurals: {
                error: {
                    one: 'ошибка',
                    few: 'ошибки',
                    many: 'ошибок',
                    other: 'ошибок'
                },
                record: {
                    one: 'запись',
                    few: 'записи',
                    many: 'записей',
                    other: 'записей'
                }
            },
            logs: {
                pageLoad: '- Загрузка страницы: {path} (запуск={running}, отправлено={sent}/{limit}) -',
                newRun: 'Новый запуск: счётчик откликов сброшен. Режим - {mode}.',
                limitReached: 'Лимит достигнут ({limit}). Работа завершена.',
                runCompleted: 'Работа завершена. Отправлено всего: {count}.',
                stoppedByUser: 'Остановлено пользователем.',
                stoppedDuringVacancy: 'Остановлено пользователем во время обработки вакансии.',
                stoppedProcessing: 'Обработка остановлена пользователем.',
                settingsSaved: 'Настройки сохранены.',
                historyReset: 'История обработанных вакансий, счётчик отправленных откликов и статистика запуска сброшены. Лимит не изменён.',
                manualCleared: 'Список ручной очереди очищен.',
                diagCleared: 'Сохранённый диагностический лог и метрики очищены.',
                diagExported: 'Диагностический лог выгружен в файл.',
                diagExportFailed: 'Не удалось выгрузить лог: {err}',
                htmlExported: 'HTML экспорт выполнен.',
                htmlOpened: 'Ручная очередь открыта в новой вкладке.',
                trapTimeout: 'Очистил trap_lock по таймауту.',
                tabBusy: 'Запуск отменён: в другой вкладке уже запущен процесс (instance lock).',
                onResponsePage: 'На странице отклика - управление у обработчика формы.',
                onVacancyPage: 'На странице вакансии - продолжаю обработку тут.',
                vacanciesFound: 'Найдено вакансий: {total}. Новых к обработке: {targets}. Отправлено: {sent}/{limit}.',
                buttonDisappeared: 'Кнопка исчезла из DOM - перезапускаю поиск.',
                navigatingVacancy: 'Переход на страницу вакансии - завершаю цикл для корректной навигации.',
                redirectWaiting: 'Редирект/внешний тест. Ожидаю возврат через watchdog.',
                skippingCode: 'Пропускаю вакансию (код: {code}).',
                mainLoopError: 'Ошибка в главном цикле: {err}',
                captchaHalt: 'Обнаружена проверка «я не робот» / анти-бот hh.ru. Прогон остановлен: решите капчу вручную и запустите заново.',
                instanceLockLost: 'Работа остановлена: межвкладочный instance lock перешёл к другой вкладке.',
                persistenceFailure: 'Критический сбой хранилища: не удалось сохранить вакансию {vid} в список для ручного отклика. Автоматизация остановлена во избежание потери данных.',
                readingFound: 'Найдена секция "Подходящие вакансии..." - скроллю до неё.',
                readingFallback: 'Секция не найдена - скроллю до 60% страницы (фоллбек).',
                readingSim: 'Читаю ~{sec} сек (имитирую просмотр страницы).',
                relocationConfirm: 'Окно переезда - подтверждаю.',
                letterMissing: 'Поле письма не появилось - отправляю отклик без сопроводительного.',
                formSubmitFallback: 'Отправил форму через form.submit() (fallback).',
                submitBtnMissing: 'Кнопка отправки письма не найдена.',
                responsePageRejectSkip: 'Страница отклика с предупреждением об отказе; форс выключен - сохраняю для ручного отклика.',
                responsePageFilling: 'Страница отклика (не тест){reject} - заполняю и отправляю.',
                responsePageRejectNote: ' с предупреждением об отказе',
                responsePageSubmitFail: 'Не удалось нажать отправку на странице отклика - сохранил для ручного.',
                responsePageSent: 'Отклик отправлен со страницы отклика.',
                responsePageQuestions: 'Страница отклика перенаправила на вопросы/тест - сохранил для ручного.',
                responsePageNoConfirm: 'Не удалось подтвердить отправку со страницы отклика - сохранил для ручного.',
                noHref: 'Не удалось получить href вакансии - пропускаю.',
                openingVacancy: 'Открываю страницу вакансии {vid} для чтения...',
                alreadyApplied: 'На эту вакансию уже откликались ранее - пропускаю.',
                applyBtnMissingReturning: 'Кнопка "Откликнуться" не найдена - помечаю вакансию как обработанную и возвращаюсь.',
                scenarioA: 'Сценарий А: резюме отправлено, письмо необязательно.',
                coverOff: 'Письмо выключено - пропускаю прикрепление.',
                scenarioASent: 'Отклик отправлен (сценарий А).',
                scenarioBRejectSkip: 'Предупреждение об отказе, откликаться всё равно выключено - сохраняю для ручного отклика.',
                scenarioBModal: 'Сценарий Б: модалка отклика{reject}{cover}',
                scenarioBRejectNote: ' (⚠ предупреждение об отказе)',
                scenarioBCoverNote: ', заполняю письмо и отправляю.',
                scenarioBNoCoverNote: ' - отправляю без письма.',
                scenarioBSubmitFail: 'Не удалось нажать отправку отклика - возвращаюсь к списку.',
                scenarioBSent: 'Отклик отправлен (сценарий Б{reject}).',
                scenarioBSentRejectNote: ', несмотря на предупреждение об отказе',
                scenarioBForcing: 'Предупреждение об отказе - дожимаю отправку (включено откликаться всё равно).',
                scenarioBForcedSent: 'Отклик отправлен (форс, предупреждение об отказе).',
                blockedResumeHidden: 'Отклик заблокирован: скрыта видимость резюме. Измените видимость резюме в настройках hh.ru, иначе часть откликов не проходит.',
                blockedRejectWarning: 'Вакансия с предупреждением скорее всего, отказ - отклик не подтверждён.',
                letterSentNoConfirm: 'Письмо отправлено, подтверждение не получено.',
                responseConfirmed: 'Отклик подтверждён (есть подтверждение отправки).',
                responseConfirmedExtra: 'Отклик подтверждён после дополнительной проверки DOM.',
                btnDisappearedUnconfirmed: 'Кнопка "Откликнуться" исчезла, но подтверждение отправки не получено - сохраняю для ручной обработки.',
                retryClick: 'Окно не открылось - повторный клик по Откликнуться.',
                retryClickSent: 'Отклик отправлен после повторного клика.',
                timeoutUnresolved: 'Не удалось определить результат отклика - сохраняю для ручной обработки и возвращаюсь.',
                scenarioC: 'Сценарий В: прямой отклик - резюме отправлено.',
                noLinkSelector: 'Не найден селектор ссылки вакансии. Проверьте структуру карточки.',
                modeSet: 'Режим работы: {mode}.',
                languageSet: 'Язык интерфейса: {language}.',
                autoResumeFound: 'Обнаружена незавершенная работа. Авто-возобновление через 1.5 сек...',
                autoResumeCanceled: 'Авто-возобновление отменено: прогон остановлен пользователем.',
                returnedReloading: 'Возврат выполнен. Перезагружаю страницу, чтобы обновить список вакансий...',
                questionsPage: 'Попали на тест/анкету с вопросами. Сохраняю для ручного отклика и возвращаюсь.',
                manualSaved: 'Сохранено для ручного отклика{note}: {vid}',
                manualAlready: 'Вакансия уже в списке для ручного отклика{note}: {vid}',
                manualSaveFailed: 'Ошибка сохранения в список для ручного отклика (сбой хранилища){note}: {vid}',
                twoStepBackFailed: 'Двухшаговый возврат не сработал. Перехожу на список вакансий.',
                noVidOnQuestions: 'Не удалось определить ID вакансии на странице с вопросами.',
                domSnapshot: 'Снимок DOM ({label}): data-qa={dataQa}, textarea={textareas}, taskFields={taskFields}, modalBtns={modalButtons}.',
                heuristicFallback: '[Эвристика] Резервный поиск для "{key}": обнаружен <{tag}>',
                heuristicFallbackAll: '[Эвристика] Резервный поиск всех элементов для "{key}": найдено {count}',
                jsError: 'JS-ошибка [HH Apply Assistant]: {msg}{where}',
                unhandledRejection: 'Unhandled rejection [HH Apply Assistant]: {msg}'
            },
            report: {
                headerTitle: '===== HH Apply Assistant - Diagnostic Log =====',
                scriptVersion: 'Версия скрипта : v{version}',
                exportedAt: 'Выгружено      : {time}',
                currentUrl: 'URL сейчас     : {url}',
                userAgent: 'User-Agent     : {ua}',
                tabId: 'TAB_ID         : {tabId}',
                running: 'Running        : {running}',
                sent: 'Отправлено     : {sent} / лимит {limit}',
                processedIds: 'Обработано ID  : {count}',
                manualList: 'Ручной список  : {count}',
                instanceLock: 'Instance lock  : {lock}',
                trapLock: 'Trap lock      : {trap}',
                f5Needed: 'F5 needed      : {f5}',
                lastAttempt: 'Last attempt   : {last}',
                returnUrl: 'Return URL     : {url}',
                config: 'Config         : {cfg}',
                logEntries: 'Записей в логе  : {count}',
                none: '(нет)',
                metricsTitle: '----- МЕТРИКИ (накопительно) -----',
                metricsSince: 'Метрики с      : {time}',
                scenariosHeading: 'Сценарии после клика Откликнуться:',
                scenarios: {
                    A: '  А (письмо необязательно) : {val}',
                    B: '  Б (письмо обязательно)   : {val}',
                    C: '  В (прямой отклик)        : {val}',
                    relocation: '  Окно переезда            : {val}',
                    questions: '  Тесты/вопросы (в отклике): {val}',
                    questionsWatchdog: '  Тесты/вопросы (watchdog) : {val}',
                    timeout: '  Таймаут (не опознано)    : {val} (из них неразрешённых: {unresolved})',
                    noApply: '  Нет кнопки отклика       : {val}',
                    bNoConfirm: '  Б без подтверждения      : {val}'
                },
                otherCounters: 'Прочие счётчики:',
                timingsHeading: 'Тайминги (мс - n / avg / max / last):',
                selectorsHeading: 'Здоровье селекторов (found / missing):',
                snapshotsTitle: '----- СНИМКИ DOM (последние, для обновления селекторов) -----',
                snapshotsEmpty: '(пока пусто - снимки делаются только при сбое детекта/тестах)',
                taskFieldsHeading: '  taskFields (вопросы работодателя):'
            },
            export: {
                docTitle: 'HH Apply Assistant · сохранённые вакансии',
                brandWordmark: 'HH Apply Assistant',
                brandSub: 'сохранённые вакансии',
                metaText: 'Экспорт ручной очереди от {date} · дубликатов удалено: {duplicates}',
                searchPlaceholder: 'Поиск по названию или ссылке...',
                sortPrefix: 'Сортировка: ',
                sortOptions: {
                    ts_desc: 'Новые → старые',
                    ts_asc: 'Старые → новые',
                    title_asc: 'Название A→Z',
                    title_desc: 'Название Z→A'
                },
                statusPrefix: 'Статус: ',
                statusOptions: {
                    new: 'Новые',
                    opened: 'Открытые'
                },
                openSelected: 'Открыть выбранные',
                openSelectedTitle: 'Открыть отмеченные вакансии, по одной вкладке на каждую. Если открылась только первая - разрешите этому файлу всплывающие окна в браузере.',
                selectAll: 'Выбрать все вакансии',
                selectVacancy: 'Выбрать вакансию: {title}',
                resetMarkers: 'Сбросить отметки',
                resetMarkersTitle: 'Снять отметку открыто со всех вакансий: режим Открытые опустеет, вакансии снова станут Новыми. Сами записи не удаляются.',
                tableHeaders: {
                    saved: 'Сохранена',
                    vacancy: 'Вакансия',
                    link: 'Ссылка',
                    age: 'Возраст'
                },
                openLinkTitle: 'Открыть вакансию',
                noLinkTag: 'нет',
                noTitleText: 'Название недоступно',
                noTitleTooltip: 'Название не удалось определить при сохранении',
                emptyStates: {
                    filter: 'Ничего не найдено по запросу',
                    opened: 'Открытых вакансий пока нет',
                    new: 'Новых вакансий нет'
                },
                summaryStats: {
                    total: 'Всего',
                    new: 'Новые',
                    opened: 'Открытые',
                    shown: 'Показано'
                },
                confirmReset: 'Снять отметку открыто со всех вакансий? Записи не удаляются - они снова появятся в режиме Новые.'
            }
        },
        en: {
            presets: {
                safe: {
                    label: 'Safe'
                },
                balanced: {
                    label: 'Balanced'
                },
                fast: {
                    label: 'Fast'
                },
                turbo: {
                    label: 'Turbo'
                }
            },
            languages: {
                ru: 'Russian',
                en: 'English'
            },
            cover: {
                defaultText: 'Hello! I am very interested in this position. My experience is relevant, and more details can be found in my CV. I look forward to your feedback!',
                title: 'Cover letter',
                placeholder: 'Cover letter text...',
                rejectWarningLabel: 'Apply when HH warns',
                rejectWarningHelpAria: 'About applying when HH shows a warning',
                rejectWarningHelpTitle: 'What this setting does',
                rejectWarningHelpText: 'If hh.ru shows a warning about a likely rejection, the assistant will still submit the application.'
            },
            status: {
                idle: 'Idle',
                running: 'Running',
                runningTurbo: 'Running · Turbo',
                stopped: 'Stopped',
                error: 'Warning',
                done: 'Completed',
                busyTab: 'Active in another tab',
                returningToList: 'Returning to list...',
                waitingToReturn: 'Waiting to return...',
                captchaStopped: 'Captcha detected — stopped',
                storageFailed: 'Manual Queue storage error',
                autoStarting: 'Auto-starting...'
            },
            panel: {
                minimizeTitle: 'Collapse panel',
                expandTitle: 'Expand HH Apply Assistant',
                expandRunningTitle: 'HH Apply Assistant is running · expand',
                langSwitchLabel: 'Interface language',
                modeTitle: 'Work mode',
                modeHelpAria: 'About work modes',
                modeHelpTitle: 'Estimated performance',
                modeHelpSafeTitle: 'Safe',
                modeHelpSafeText: '≈ 0.5–1 application/min',
                modeHelpBalancedTitle: 'Balanced',
                modeHelpBalancedText: '≈ 1–2 applications/min',
                modeHelpFastTitle: 'Fast',
                modeHelpFastText: '≈ 2–4 applications/min',
                modeHelpTurboTitle: 'Turbo',
                modeHelpTurboText: '≈ 6–12 applications/min',
                modeHelpNote: 'Speed is approximate: page loading and HH response times can significantly affect the result.',
                autosaveIdle: 'Changes are saved automatically',
                autosaveSaved: 'Saved',
                limitLabel: 'Application limit per run',
                limitShort: 'Limit',
                startBtn: 'Start applying',
                stopBtn: 'Stop',
                resetHistory: 'Reset history',
                resetHistoryTitle: 'Reset processed-vacancy history, sent counter, and run statistics (the limit stays unchanged)',
                diagnostics: 'Diagnostics',
                diagnosticsTitle: 'Open diagnostics and log',
                statsTitle: 'Run statistics',
                statsProgressTitle: 'Sent applications / Run limit',
                statAttempts: 'Attempts',
                statSuccess: 'Success',
                statManual: 'Manual',
                statSkipped: 'Skipped',
                manualTitle: 'Manual queue',
                manualCountTitle: 'Saved vacancies for manual review',
                manualExport: 'Export',
                manualClear: 'Clear',
                manualEmpty: 'Queue is empty · Vacancies with questions/tests are saved here automatically',
                manualNoTitle: 'Title unavailable',
                manualOpen: 'Open',
                manualOpenTitle: 'Open vacancy in a new tab',
                manualUnsafeUrl: 'URL failed security check',
                manualRemoveTitle: 'Remove from queue',
                manualRemove: 'Remove',
                manualMore: 'Full queue ({count}) ↗',
                manualMoreTitle: 'Open interactive page with the full vacancy queue'
            },
            diag: {
                backTitle: 'Return to main panel',
                backBtn: 'Back',
                title: 'Diagnostics',
                downloadLog: 'Download log',
                downloadLogTitle: 'Download full diagnostic report',
                checkSelectors: 'Check page',
                checkSummaryIdle: '',
                checkSummaryProgress: '{passed}/3',
                checkSummaryOk: 'OK',
                filterLabel: 'Log filters',
                filterAll: 'All',
                filterErrors: 'Errors',
                searchPlaceholder: 'Search logs...',
                searchLabel: 'Search diagnostic log',
                clearSearch: 'Clear search',
                autoScroll: 'Auto-scroll',
                noEntries: 'Nothing found',
                emptySearchHint: 'Try changing the query or filter',
                errorsOnly: 'Errors only',
                moreBtn: 'More',
                moreTitle: 'Additional actions',
                clearView: 'Clear view',
                clearAll: 'Clear saved log & metrics',
                badgeTitle: '{errText} in diagnostic log · Open diagnostics',
                badgeTitleClean: 'Open diagnostics and log',
                emptyTitle: 'No entries yet',
                emptyHint: 'Diagnostic events will appear here while the script is running',
                emptyNoErrorsTitle: 'No errors',
                emptyNoErrorsHint: 'There are no errors in the diagnostic log',
                repeatExpand: 'Expand repeat group',
                repeatCollapse: 'Collapse repeat group'
            },
            confirm: {
                clearDiag: 'Clear saved diagnostic log and metrics? (download the log before clearing if needed for analysis)',
                resetHistory: 'Reset processed-vacancy history and run statistics? The sent-application counter will also return to zero, so the assistant can process these vacancies again. Your configured limit will stay unchanged.',
                clearManual: 'Clear saved vacancies from the manual queue?',
                removeManual: 'Remove this vacancy from the manual queue?'
            },
            alert: {
                manualEmpty: 'List is empty',
                manualOpenBlocked: 'The browser blocked the queue window. Allow pop-ups and try again.'
            },
            health: {
                starting: 'Checking the current page...',
                applyBtnList: 'Apply button (list)',
                vacancyApply: 'Apply button (vacancy page)',
                vacancyLink: 'Vacancy link (card)',
                attachCoverBtn: 'Attach cover letter (Scenario A)',
                letterSubmit: 'Submit letter button',
                letterTextarea: 'Cover letter field (textarea)',
                reasons: {
                    emptySearch: 'not applicable — search list is empty',
                    onVacancyPage: 'not applicable on vacancy page',
                    onResponsePage: 'not applicable on response form page',
                    notApplicable: 'not applicable on current page',
                    alreadyApplied: 'not required — already applied',
                    onSearchPage: 'not applicable on search page',
                    notInScenario: 'not required in current scenario',
                    questionnaire: 'not applicable — employer questionnaire',
                    modalNotOpen: 'not applicable — response form not open',
                    letterNotExpanded: 'not applicable — letter form not expanded'
                },
                statusOk: '{name}: OK ({sel})',
                statusFallback: '{name}: HEURISTICALLY FOUND (selector {sel} missed)',
                statusNotFound: '{name}: NOT FOUND ({sel})',
                statusSkipped: 'Skipped — {name}: {reason}',
                summary: 'Health check complete: {okCount} OK · {skipCount} not applicable · {errText}.',
                instanceLock: 'Instance lock: tabId={tabId} ts={ts}',
                instanceLockMissing: 'Instance lock: none'
            },
            plurals: {
                error: {
                    one: 'error',
                    few: 'errors',
                    many: 'errors',
                    other: 'errors'
                },
                record: {
                    one: 'entry',
                    few: 'entries',
                    many: 'entries',
                    other: 'entries'
                }
            },
            logs: {
                pageLoad: '- Page load: {path} (running={running}, sent={sent}/{limit}) -',
                newRun: 'New run: application counter reset. Mode — {mode}.',
                limitReached: 'Limit reached ({limit}). Run completed.',
                runCompleted: 'Completed. Total applications sent: {count}.',
                stoppedByUser: 'Stopped by user.',
                stoppedDuringVacancy: 'Stopped by user while processing vacancy.',
                stoppedProcessing: 'Processing stopped by user.',
                settingsSaved: 'Settings saved.',
                historyReset: 'Processed-vacancy history, sent-application counter, and run statistics reset. The configured limit was not changed.',
                manualCleared: 'Manual queue list cleared.',
                diagCleared: 'Saved diagnostic log and metrics cleared.',
                diagExported: 'Diagnostic log exported to file.',
                diagExportFailed: 'Failed to export log: {err}',
                htmlExported: 'HTML export completed.',
                htmlOpened: 'Manual queue opened in a new tab.',
                trapTimeout: 'Cleared trap_lock on timeout.',
                tabBusy: 'Start canceled: process already active in another tab (instance lock).',
                onResponsePage: 'On response page — handing over to form handler.',
                onVacancyPage: 'On vacancy page — continuing processing here.',
                vacanciesFound: 'Vacancies found: {total}. New to process: {targets}. Sent: {sent}/{limit}.',
                buttonDisappeared: 'Button disappeared from DOM — restarting search.',
                navigatingVacancy: 'Navigating to vacancy page — finishing loop for clean navigation.',
                redirectWaiting: 'Redirect / external test. Waiting to return via watchdog.',
                skippingCode: 'Skipping vacancy (code: {code}).',
                mainLoopError: 'Main loop error: {err}',
                captchaHalt: 'Bot check / captcha detected. Automation stopped: please solve captcha manually and restart.',
                instanceLockLost: 'Run stopped: cross-tab instance lock transferred to another tab.',
                persistenceFailure: 'Critical storage failure: could not save vacancy {vid} to manual queue. Automation stopped to prevent data loss.',
                readingFound: 'Found "Similar vacancies" section — scrolling to it.',
                readingFallback: 'Section not found — scrolling to 60% page height (fallback).',
                readingSim: 'Viewing for ~{sec}s (simulating reading).',
                relocationConfirm: 'Relocation dialog — confirming.',
                letterMissing: 'Letter field did not appear — submitting without cover letter.',
                formSubmitFallback: 'Submitted form via form.submit() (fallback).',
                submitBtnMissing: 'Submit button not found.',
                responsePageRejectSkip: 'Response page with rejection warning; force submit disabled — saving for manual queue.',
                responsePageFilling: 'Response page (not a test){reject} — filling and submitting.',
                responsePageRejectNote: ' with rejection warning',
                responsePageSubmitFail: 'Failed to submit on response page — saved for manual review.',
                responsePageSent: 'Application sent from response page.',
                responsePageQuestions: 'Response page redirected to questions/test — saved for manual review.',
                responsePageNoConfirm: 'Could not confirm submission from response page — saved for manual review.',
                noHref: 'Could not obtain vacancy href — skipping.',
                openingVacancy: 'Opening vacancy page {vid} for reading...',
                alreadyApplied: 'Already applied to this vacancy — skipping.',
                applyBtnMissingReturning: 'Apply button not found — marking vacancy processed and returning.',
                scenarioA: 'Scenario A: resume sent, cover letter optional.',
                coverOff: 'Cover letter disabled — skipping attachment.',
                scenarioASent: 'Application sent (Scenario A).',
                scenarioBRejectSkip: 'Rejection warning, force apply disabled — saving for manual review.',
                scenarioBModal: 'Scenario B: response modal{reject}{cover}',
                scenarioBRejectNote: ' (⚠ rejection warning)',
                scenarioBCoverNote: ', filling letter and submitting.',
                scenarioBNoCoverNote: ' - submitting without letter.',
                scenarioBSubmitFail: 'Failed to click submit button — returning to list.',
                scenarioBSent: 'Application sent (Scenario B{reject}).',
                scenarioBSentRejectNote: ', despite rejection warning',
                scenarioBForcing: 'Rejection warning — forcing submit (apply anyway is enabled).',
                scenarioBForcedSent: 'Application sent (forced, rejection warning).',
                blockedResumeHidden: 'Application blocked: resume visibility hidden. Adjust resume visibility in hh.ru settings to proceed.',
                blockedRejectWarning: 'Vacancy has rejection warning — submission not confirmed.',
                letterSentNoConfirm: 'Letter sent, confirmation not received.',
                responseConfirmed: 'Application confirmed (confirmation present in DOM).',
                responseConfirmedExtra: 'Application confirmed after extra DOM check.',
                btnDisappearedUnconfirmed: 'Apply button disappeared without confirmation — saving for manual review.',
                retryClick: 'Window did not open — retrying click on Apply.',
                retryClickSent: 'Application sent after retry click.',
                timeoutUnresolved: 'Could not determine application outcome — saving for manual review and returning.',
                scenarioC: 'Scenario C: direct application — resume sent.',
                noLinkSelector: 'Vacancy link selector not found. Check card structure.',
                modeSet: 'Application mode: {mode}.',
                languageSet: 'Interface language: {language}.',
                autoResumeFound: 'Unfinished run detected. Auto-resuming in 1.5s...',
                autoResumeCanceled: 'Auto-resume canceled: run stopped by user.',
                returnedReloading: 'Returned to list. Reloading page to refresh vacancy list...',
                questionsPage: 'Reached test/questionnaire page. Saving for manual review and returning.',
                manualSaved: 'Saved for manual review{note}: {vid}',
                manualAlready: 'Vacancy already in manual queue{note}: {vid}',
                manualSaveFailed: 'Error saving to manual queue (storage failure){note}: {vid}',
                twoStepBackFailed: 'Two-step back failed. Navigating to vacancy list.',
                noVidOnQuestions: 'Could not determine vacancy ID on questions page.',
                domSnapshot: 'DOM snapshot ({label}): data-qa={dataQa}, textarea={textareas}, taskFields={taskFields}, modalBtns={modalButtons}.',
                heuristicFallback: '[Heuristics] Fallback search for "{key}": found <{tag}>',
                heuristicFallbackAll: '[Heuristics] Fallback search for all items "{key}": found {count}',
                jsError: 'JS-error [HH Apply Assistant]: {msg}{where}',
                unhandledRejection: 'Unhandled rejection [HH Apply Assistant]: {msg}'
            },
            report: {
                headerTitle: '===== HH Apply Assistant - Diagnostic Log =====',
                scriptVersion: 'Script version : v{version}',
                exportedAt: 'Exported at    : {time}',
                currentUrl: 'Current URL    : {url}',
                userAgent: 'User-Agent     : {ua}',
                tabId: 'TAB_ID         : {tabId}',
                running: 'Running        : {running}',
                sent: 'Sent           : {sent} / limit {limit}',
                processedIds: 'Processed IDs  : {count}',
                manualList: 'Manual queue   : {count}',
                instanceLock: 'Instance lock  : {lock}',
                trapLock: 'Trap lock      : {trap}',
                f5Needed: 'F5 needed      : {f5}',
                lastAttempt: 'Last attempt   : {last}',
                returnUrl: 'Return URL     : {url}',
                config: 'Config         : {cfg}',
                logEntries: 'Entries in log : {count}',
                none: '(none)',
                metricsTitle: '----- METRICS (cumulative) -----',
                metricsSince: 'Metrics since  : {time}',
                scenariosHeading: 'Scenarios after clicking Apply:',
                scenarios: {
                    A: '  A (cover letter optional) : {val}',
                    B: '  B (cover letter required) : {val}',
                    C: '  C (direct response)       : {val}',
                    relocation: '  Relocation modal          : {val}',
                    questions: '  Tests/questions (apply)   : {val}',
                    questionsWatchdog: '  Tests/questions (watchdog): {val}',
                    timeout: '  Timeout (unidentified)    : {val} (of which unresolved: {unresolved})',
                    noApply: '  No apply button           : {val}',
                    bNoConfirm: '  B without confirmation    : {val}'
                },
                otherCounters: 'Other counters:',
                timingsHeading: 'Timings (ms - n / avg / max / last):',
                selectorsHeading: 'Selector health (found / missing):',
                snapshotsTitle: '----- DOM SNAPSHOTS (latest, for selector updates) -----',
                snapshotsEmpty: '(currently empty - snapshots are taken only on detection failure/tests)',
                taskFieldsHeading: '  taskFields (employer questions):'
            },
            export: {
                docTitle: 'HH Apply Assistant · saved vacancies',
                brandWordmark: 'HH Apply Assistant',
                brandSub: 'saved vacancies',
                metaText: 'Manual queue export from {date} · duplicates removed: {duplicates}',
                searchPlaceholder: 'Search by title or URL...',
                sortPrefix: 'Sort: ',
                sortOptions: {
                    ts_desc: 'Newest → oldest',
                    ts_asc: 'Oldest → newest',
                    title_asc: 'Title A→Z',
                    title_desc: 'Title Z→A'
                },
                statusPrefix: 'Status: ',
                statusOptions: {
                    new: 'New',
                    opened: 'Opened'
                },
                openSelected: 'Open selected',
                openSelectedTitle: 'Open checked vacancies in separate tabs. If only the first one opens, enable pop-ups for this file in your browser.',
                selectAll: 'Select all vacancies',
                selectVacancy: 'Select vacancy: {title}',
                resetMarkers: 'Reset markers',
                resetMarkersTitle: 'Remove opened markers from all vacancies: Opened view will clear and vacancies will reappear under New. Entries are not deleted.',
                tableHeaders: {
                    saved: 'Saved',
                    vacancy: 'Vacancy',
                    link: 'Link',
                    age: 'Age'
                },
                openLinkTitle: 'Open vacancy',
                noLinkTag: 'none',
                noTitleText: 'Title unavailable',
                noTitleTooltip: 'Title could not be determined upon saving',
                emptyStates: {
                    filter: 'No results matching query',
                    opened: 'No opened vacancies yet',
                    new: 'No new vacancies'
                },
                summaryStats: {
                    total: 'Total',
                    new: 'New',
                    opened: 'Opened',
                    shown: 'Shown'
                },
                confirmReset: 'Clear opened status from all vacancies? Entries will not be deleted and will reappear under New.'
            }
        }
    };

    const I18n = (() => {
        let _currentLang = null;

        function _detectInitialLang() {
            try {
                const saved = storage.localGet(KEYS.language);
                if (saved && SUPPORTED_LANGUAGES.includes(saved)) return saved;
            } catch (e) { /* ignore */ }

            try {
                const docLang = (document.documentElement.lang || '').toLowerCase();
                if (docLang.startsWith('en')) return 'en';
                if (docLang.startsWith('ru')) return 'ru';
                const navLang = (navigator.language || navigator.userLanguage || '').toLowerCase();
                if (navLang.startsWith('en')) return 'en';
                if (navLang.startsWith('ru')) return 'ru';
            } catch (e) { /* ignore */ }

            return DEFAULT_LANGUAGE;
        }

        function _getNested(obj, path) {
            if (!obj || typeof obj !== 'object') return undefined;
            const parts = path.split('.');
            let curr = obj;
            for (const p of parts) {
                if (curr && typeof curr === 'object' && p in curr) {
                    curr = curr[p];
                } else {
                    return undefined;
                }
            }
            return curr;
        }

        function _interpolate(template, params) {
            if (typeof template !== 'string') return '';
            if (!params || typeof params !== 'object') return template;
            return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
                return (key in params && params[key] !== undefined && params[key] !== null) ? String(params[key]) : match;
            });
        }

        return {
            init() {
                if (!_currentLang) {
                    _currentLang = _detectInitialLang();
                }
                return _currentLang;
            },
            getLanguage() {
                if (!_currentLang) _currentLang = _detectInitialLang();
                return _currentLang;
            },
            setLanguage(lang) {
                if (!SUPPORTED_LANGUAGES.includes(lang)) return false;
                _currentLang = lang;
                try {
                    storage.localSet(KEYS.language, lang);
                } catch (e) { /* ignore */ }
                return true;
            },
            getLocaleTag(lang) {
                const target = lang || I18n.getLanguage();
                return LOCALE_TAGS[target] || LOCALE_TAGS[DEFAULT_LANGUAGE];
            },
            t(key, params, lang) {
                const current = lang || I18n.getLanguage();
                let val = _getNested(TRANSLATIONS[current], key);
                if (val === undefined && current !== DEFAULT_LANGUAGE) {
                    val = _getNested(TRANSLATIONS[DEFAULT_LANGUAGE], key);
                }
                if (val === undefined) {
                    return key;
                }
                return typeof val === 'string' ? _interpolate(val, params) : val;
            },
            plural(n, category, params, lang) {
                const num = Number.isFinite(Number(n)) ? Number(n) : 0;
                const current = lang || I18n.getLanguage();
                const localeTag = I18n.getLocaleTag(current);
                let form = 'other';
                try {
                    const pr = new Intl.PluralRules(localeTag);
                    form = pr.select(num);
                } catch (e) {
                    if (current === 'ru') {
                        const mod10 = num % 10;
                        const mod100 = num % 100;
                        if (mod100 >= 11 && mod100 <= 19) form = 'many';
                        else if (mod10 === 1) form = 'one';
                        else if (mod10 >= 2 && mod10 <= 4) form = 'few';
                        else form = 'many';
                    } else {
                        form = num === 1 ? 'one' : 'other';
                    }
                }
                const pluralsObj = _getNested(TRANSLATIONS[current], `plurals.${category}`)
                    || _getNested(TRANSLATIONS[DEFAULT_LANGUAGE], `plurals.${category}`)
                    || {};
                const word = pluralsObj[form] || pluralsObj.other || pluralsObj.many || pluralsObj.one || category;
                return `${num} ${word}`;
            },
            formatTime(dateOrTs, options = {}, lang) {
                const d = dateOrTs instanceof Date ? dateOrTs : new Date(dateOrTs || Date.now());
                const localeTag = I18n.getLocaleTag(lang);
                try {
                    return d.toLocaleTimeString(localeTag, options);
                } catch (e) {
                    return d.toTimeString().slice(0, 8);
                }
            },
            formatDate(dateOrTs, options = {}, lang) {
                const d = dateOrTs instanceof Date ? dateOrTs : new Date(dateOrTs || Date.now());
                const localeTag = I18n.getLocaleTag(lang);
                try {
                    return d.toLocaleDateString(localeTag, options);
                } catch (e) {
                    return d.toISOString().slice(0, 10);
                }
            },
            formatDateTime(dateOrTs, options = {}, lang) {
                const d = dateOrTs instanceof Date ? dateOrTs : new Date(dateOrTs || Date.now());
                const localeTag = I18n.getLocaleTag(lang);
                try {
                    return d.toLocaleString(localeTag, options);
                } catch (e) {
                    return d.toISOString();
                }
            }
        };
    })();

    // Пресеты темпа работы. Все интервалы в миллисекундах [min, max]:
    //  delay  - пауза перед переходом к следующей вакансии;
    //  view   - чтение страницы вакансии (имитация просмотра);
    //  action - микро-паузы между отдельными действиями (клики, ввод).
    const PRESETS = {
        safe: {
            delay: [4000, 8000],
            view: [15000, 35000],
            action: [300, 1000]
        },
        balanced: {
            delay: [2000, 5000],
            view: [8000, 20000],
            action: [150, 600]
        },
        fast: {
            delay: [1500, 3000],
            view: [4000, 9000],
            action: [120, 350]
        },
        turbo: {
            delay: [80, 200],
            view: [0, 0],
            action: [25, 80]
        }
    };
    const WORK_MODE_KEYS = ['safe', 'balanced', 'fast', 'turbo'];
    const DEFAULT_PRESET = 'balanced';
    const presetLabel = (key) => I18n.t(`presets.${key || DEFAULT_PRESET}.label`);
    const modeKeyToIndex = (key) => {
        const idx = WORK_MODE_KEYS.indexOf(key);
        return idx >= 0 ? idx : 1;
    };
    const modeIndexToKey = (idx) => {
        return WORK_MODE_KEYS[Math.max(0, Math.min(WORK_MODE_KEYS.length - 1, idx))] || DEFAULT_PRESET;
    };

    const getDefaultCoverText = (lang) => {
        const target = lang || I18n.getLanguage();
        return TRANSLATIONS[target]?.cover?.defaultText || TRANSLATIONS[DEFAULT_LANGUAGE].cover.defaultText;
    };

    // Пользовательские настройки по умолчанию
    const DEFAULTS = {
        coverText: TRANSLATIONS[DEFAULT_LANGUAGE].cover.defaultText,
        useCover: true,
        applyOnRejectWarning: false,
        skipHidden: true,
        preset: DEFAULT_PRESET,
        limit: 50
    };

    // ─────────────────────────────────────────────────────────────
    //  2. УТИЛИТЫ
    // ─────────────────────────────────────────────────────────────

    // Безусловная пауза для системной инфраструктуры (например, instance lock 60ms race window, UI)
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

    // Проверяет, принадлежит ли вызов текущему активному поколению запуска.
    // Если произошёл Stop -> Start, старый runId !== currentRunId и выполнение прерывается.
    const isRunCurrent = (runId) => {
        if (stopSignal) return false;
        if (runId !== undefined && runId !== null && runId !== currentRunId) return false;
        return State.amIRunning();
    };

    // Прерываемая пауза (Interruptible sleep): опрашивает stopSignal и слушает AbortSignal,
    // гарантируя мгновенную реакцию на нажатие "Стоп" в любых режимах и на любых таймингах (<1 мс).
    const interruptibleWait = (ms, signal) => new Promise(resolve => {
        const sig = signal || activeAbortController?.signal;
        if (stopSignal || sig?.aborted || ms <= 0) return resolve();
        let timer = null;
        let onAbort = null;
        let isDone = false;
        const cleanup = () => {
            if (isDone) return;
            isDone = true;
            if (timer) { clearTimeout(timer); timer = null; }
            if (onAbort && sig) {
                try { sig.removeEventListener('abort', onAbort); } catch (e) {}
            }
        };
        onAbort = () => {
            cleanup();
            resolve();
        };
        if (sig) {
            try { sig.addEventListener('abort', onAbort, { once: true }); } catch (e) {}
            timer = setTimeout(() => {
                cleanup();
                resolve();
            }, ms);
        } else {
            const start = Date.now();
            const check = () => {
                if (stopSignal || (Date.now() - start >= ms)) {
                    cleanup();
                    resolve();
                } else {
                    timer = setTimeout(check, Math.min(40, ms - (Date.now() - start)));
                }
            };
            timer = setTimeout(check, Math.min(40, ms));
        }
    });
    const wait = interruptibleWait;
    const randBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const toNum = (v, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    };
    // Нормализация пробелов в тексте DOM/заголовка.
    const collapseSpaces = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    // Простой стабильный хеш (FNV-1a 32) - запасной вариант генерации ID
    function fnv1a32(str) {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
            h >>>= 0;
        }
        return h >>> 0;
    }

    // Разрешаем только http(s)-ссылки на домены hh.ru - защита от подстановки мусора в хранилище.
    const toSafeHhUrl = (rawUrl) => {
        if (!rawUrl) return '';
        try {
            const u = new URL(String(rawUrl), location.href);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
            if (!/(^|\.)(hh\.ru|localhost|127\.0\.0\.1)$/i.test(u.hostname)) return '';
            return u.href;
        } catch (e) {
            return '';
        }
    };

    const parseJson = (raw, fallback) => {
        try {
            const v = JSON.parse(raw);
            return v === null || v === undefined ? fallback : v;
        } catch (e) {
            return fallback;
        }
    };

    // ─────────────────────────────────────────────────────────────
    //  3. БЕЗОПАСНАЯ ОБЁРТКА НАД ХРАНИЛИЩАМИ
    //  localStorage/sessionStorage могут кидать исключения
    //  (приватный режим, переполнение квоты) - гасим их здесь.
    // ─────────────────────────────────────────────────────────────

    const storage = {
        localGet: (key) => { try { return localStorage.getItem(key); } catch (e) { return null; } },
        localRead: (key) => { try { return { ok: true, value: localStorage.getItem(key) }; } catch (e) { return { ok: false, value: null }; } },
        localSet: (key, value) => { try { localStorage.setItem(key, value); return true; } catch (e) { return false; } },
        localRemove: (key) => { try { localStorage.removeItem(key); return true; } catch (e) { return false; } },
        sessionGet: (key) => { try { return sessionStorage.getItem(key); } catch (e) { return null; } },
        sessionRead: (key) => { try { return { ok: true, value: sessionStorage.getItem(key) }; } catch (e) { return { ok: false, value: null }; } },
        sessionSet: (key, value) => { try { sessionStorage.setItem(key, value); return true; } catch (e) { return false; } },
        sessionRemove: (key) => { try { sessionStorage.removeItem(key); return true; } catch (e) { return false; } }
    };

    function writeSessionVerified(key, value) {
        const expected = String(value);
        if (!storage.sessionSet(key, expected)) return false;
        const check = storage.sessionRead(key);
        return check.ok && check.value === expected;
    }

    function removeSessionVerified(key) {
        if (!storage.sessionRemove(key)) return false;
        const check = storage.sessionRead(key);
        return check.ok && check.value === null;
    }

    function writeLocalVerified(key, value) {
        const expected = String(value);
        if (!storage.localSet(key, expected)) return false;
        const check = storage.localRead(key);
        return check.ok && check.value === expected;
    }

    function removeLocalVerified(key) {
        if (!storage.localRemove(key)) return false;
        const check = storage.localRead(key);
        return check.ok && check.value === null;
    }

    // ─────────────────────────────────────────────────────────────
    //  4. НАСТРОЙКИ
    // ─────────────────────────────────────────────────────────────

    const Settings = {
        // Defensive validation актуальной storage schema: defaults, типы и диапазоны.
        normalize(raw = {}) {
            const defaultCover = getDefaultCoverText();
            const merged = { ...DEFAULTS, coverText: defaultCover, ...(raw || {}) };
            return {
                coverText: String(merged.coverText ?? defaultCover).slice(0, 5000),
                useCover: merged.useCover !== false,
                applyOnRejectWarning: merged.applyOnRejectWarning === true,
                skipHidden: merged.skipHidden !== false,
                preset: PRESETS[merged.preset] ? merged.preset : DEFAULT_PRESET,
                limit: clamp(Math.round(toNum(merged.limit, DEFAULTS.limit)), 1, 500)
            };
        },
        load() {
            return Settings.normalize(parseJson(storage.localGet(KEYS.settings), {}));
        },
        save(cfg) {
            try {
                return storage.localSet(KEYS.settings, JSON.stringify(cfg));
            } catch (e) {
                return false;
            }
        }
    };

    let config = Settings.load();
    function persistSettings(nextConfig) {
        const normalized = Settings.normalize(nextConfig);
        if (!Settings.save(normalized)) {
            handleSettingsPersistenceFailure();
            return false;
        }
        config = normalized;
        return true;
    }
    let isLoopActive = false;
    let stopSignal = false;
    let currentRunId = 0;
    let resumeTimer = null;
    let activeAbortController = null;
    let trapLockTimer = null;
    let currentInstanceLeaseId = null;
    let instanceLeaseVerified = false;
    let pendingInstanceLeaseId = null;
    // Флаг: уже обрабатываем полностраничную форму отклика (защита от повторного входа из watchdog).
    // Сбрасывается сам при загрузке новой страницы (новый экземпляр скрипта).
    let handlingResponsePage = false;

    // Активный пресет таймингов (устойчив к битому значению в конфиге).
    const timings = () => PRESETS[config.preset] || PRESETS[DEFAULT_PRESET];
    const actionPause = () => wait(randBetween(timings().action[0], timings().action[1]));
    const vacancyPause = () => wait(randBetween(timings().delay[0], timings().delay[1]));

    // TAB_ID должен быть стабильным в пределах одной вкладки на протяжении всех переходов
    // (list -> vacancy -> list). sessionStorage изолирован по вкладкам и переживает навигацию,
    // поэтому одна и та же вкладка сохраняет свой ID и корректно перезабирает instance lock,
    // а разные вкладки получают разные ID.
    const TAB_ID = (() => {
        let id = storage.sessionGet(KEYS.tabId);
        if (!id) {
            id = Math.random().toString(36).slice(2, 9);
            storage.sessionSet(KEYS.tabId, id);
        }
        return id;
    })();

    // ─────────────────────────────────────────────────────────────
    //  5. ДИАГНОСТИКА: ПОСТОЯННЫЙ ЛОГ И МЕТРИКИ
    // ─────────────────────────────────────────────────────────────

    // Постоянный диагностический лог (переживает навигацию между страницами).
    // Пишем в localStorage, чтобы собрать полную картину работы скрипта через все переходы
    // (список -> вакансия -> список ...) и потом выгрузить одним файлом.
    const DiagnosticI18n = (() => {
        const namespaces = ['logs', 'health'];
        const patternCache = new Map();
        const staticCache = new Map();
        const legacyEntries = {
            ru: [
                ['health.starting', 'Запускаю диагностику селекторов...'],
                ['health.applyBtnList', 'Кнопка отклика (list)'],
                ['health.vacancyApply', 'Кнопка отклика (vacancy page)'],
                ['health.vacancyLink', 'Ссылка вакансии (card)'],
                ['health.letterTextarea', 'Поле письма (textarea)'],
                ['health.summary', 'Healthcheck завершён: {okCount} OK · {skipCount} не применимо · {errText}.'],
                ['health.instanceLock', 'Instance lock: tabId={tabId} ts={ts}'],
                ['health.instanceLockMissing', 'Instance lock: отсутствует'],
                ['logs.pageLoad', '- Загрузка страницы: {path} (running={running}, sent={sent}/{limit}) -'],
                ['logs.heuristicFallback', '[Heuristics] Резервный поиск для "{key}": обнаружен <{tag}>'],
                ['logs.heuristicFallbackAll', '[Heuristics] Резервный поиск всех элементов для "{key}": найдено {count}'],
                ['logs.historyReset', 'История откликов, счётчик и статистика сброшены.']
            ],
            en: [
                ['health.starting', 'Starting selector diagnostics...'],
                ['logs.historyReset', 'Application history, counter, and statistics reset.']
            ]
        };
        const escapeRx = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        const collect = (node, prefix, out) => {
            if (!node || typeof node !== 'object') return;
            Object.entries(node).forEach(([key, value]) => {
                const path = prefix ? `${prefix}.${key}` : key;
                if (typeof value === 'string') out.push({ key: path, template: value });
                else collect(value, path, out);
            });
        };

        const getEntries = (lang) => {
            const out = [];
            namespaces.forEach(namespace => collect(TRANSLATIONS[lang]?.[namespace], namespace, out));
            collect(TRANSLATIONS[lang]?.languages, 'languages', out);
            collect(TRANSLATIONS[lang]?.presets, 'presets', out);
            (legacyEntries[lang] || []).forEach(([key, template]) => out.push({ key, template }));
            return out;
        };

        const getPatterns = (lang) => {
            if (patternCache.has(lang)) return patternCache.get(lang);
            const patterns = getEntries(lang).map(entry => {
                const params = [];
                let source = '^';
                let cursor = 0;
                entry.template.replace(/\{([a-zA-Z0-9_]+)\}/g, (token, name, offset) => {
                    source += escapeRx(entry.template.slice(cursor, offset)) + '([\\s\\S]*?)';
                    params.push(name);
                    cursor = offset + token.length;
                    return token;
                });
                source += escapeRx(entry.template.slice(cursor)) + '$';
                return {
                    ...entry,
                    params,
                    literalLength: entry.template.replace(/\{[a-zA-Z0-9_]+\}/g, '').length,
                    rx: new RegExp(source)
                };
            }).sort((a, b) => b.literalLength - a.literalLength);
            patternCache.set(lang, patterns);
            return patterns;
        };

        const getStaticEntries = (lang) => {
            if (staticCache.has(lang)) return staticCache.get(lang);
            const entries = getEntries(lang)
                .filter(entry => !/\{[a-zA-Z0-9_]+\}/.test(entry.template) && entry.template.length >= 3)
                .sort((a, b) => b.template.length - a.template.length);
            staticCache.set(lang, entries);
            return entries;
        };

        const infer = (message, preferredLang = I18n.getLanguage()) => {
            const text = String(message || '');
            const languages = [preferredLang, ...SUPPORTED_LANGUAGES.filter(lang => lang !== preferredLang)];
            for (const lang of languages) {
                for (const pattern of getPatterns(lang)) {
                    const match = pattern.rx.exec(text);
                    if (!match) continue;
                    const params = {};
                    pattern.params.forEach((name, index) => { params[name] = match[index + 1]; });
                    return { key: pattern.key, params, lang };
                }
            }
            return null;
        };

        const translateParam = (value, fromLang, toLang) => {
            let result = String(value ?? '');
            if (/^(?:true|false)$/i.test(result)) {
                if (toLang === 'ru') return result.toLowerCase() === 'true' ? 'да' : 'нет';
                return result.toLowerCase();
            }
            if (!fromLang || fromLang === toLang) return result;
            for (const source of getStaticEntries(fromLang)) {
                if (!result.includes(source.template)) continue;
                const target = I18n.t(source.key);
                if (target !== source.key) result = result.split(source.template).join(target);
            }
            return result;
        };

        const format = (entry) => {
            if (!entry) return '';
            const meta = entry.i18nKey
                ? { key: entry.i18nKey, params: entry.i18nParams || {}, lang: entry.i18nLang || '' }
                : infer(entry.msg, entry.lang || I18n.getLanguage());
            if (!meta) return String(entry.msg || '');
            const currentLang = I18n.getLanguage();
            const params = {};
            Object.entries(meta.params || {}).forEach(([name, value]) => {
                const numericValue = Number.parseInt(String(value), 10);
                if (name === 'errText' && Number.isFinite(numericValue)) {
                    params[name] = I18n.plural(numericValue, 'error');
                    return;
                }
                params[name] = translateParam(value, meta.lang, currentLang);
            });
            return I18n.t(meta.key, params);
        };

        return { infer, format };
    })();

    const DiagLog = (() => {
        let _cache = null;
        let _saveTimer = null;
        let _isDirty = false;
        let _version = 0;
        let _errorCount = 0;

        function _ensureLoaded() {
            if (_cache === null) {
                const raw = storage.localGet(KEYS.diagLog);
                const parsed = parseJson(raw, []);
                const entries = Array.isArray(parsed) ? parsed : [];
                _cache = entries.length > DIAG_LOG_MAX ? entries.slice(-DIAG_LOG_MAX) : entries;
                _isDirty = entries.length > DIAG_LOG_MAX;
                _errorCount = _cache.reduce((acc, item) => (item && item.lvl === 'ERR' ? acc + 1 : acc), 0);
            }
            return _cache;
        }

        function _flushSync() {
            if (!_isDirty || !_cache) return;
            if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
            try {
                if (_cache.length > DIAG_LOG_MAX) {
                    _cache = _cache.slice(_cache.length - DIAG_LOG_MAX);
                    _errorCount = _cache.reduce((acc, item) => (item && item.lvl === 'ERR' ? acc + 1 : acc), 0);
                }
                const json = JSON.stringify(_cache);
                if (!storage.localSet(KEYS.diagLog, json)) {
                    // Переполнение квоты — агрессивно обрезаем и пробуем снова
                    const sourceChanged = _cache.length > 300;
                    _cache = _cache.slice(-300);
                    _errorCount = _cache.reduce((acc, item) => (item && item.lvl === 'ERR' ? acc + 1 : acc), 0);
                    storage.localSet(KEYS.diagLog, JSON.stringify(_cache));
                    if (sourceChanged) {
                        _version++;
                        try { window._hhApplyAssistantUpdateDiagBadge?.(true); } catch (e) { /* ignore */ }
                        try { window._hhApplyAssistantRenderDiagnostics?.(); } catch (e) { /* ignore */ }
                    }
                }
                _isDirty = false;
            } catch (e) {
                // Ошибки storage не должны ломать работу скрипта
            }
        }

        function _scheduleSave() {
            _isDirty = true;
            if (_saveTimer) return;
            _saveTimer = setTimeout(() => {
                _saveTimer = null;
                _flushSync();
            }, 500);
        }

        return {
            push(msg, isError) {
                const arr = _ensureLoaded();
                const text = String(msg).slice(0, 1000);
                const i18n = DiagnosticI18n.infer(text, I18n.getLanguage());
                const entry = {
                    t: Date.now(),
                    lvl: isError ? 'ERR' : 'INFO',
                    path: (location.pathname + location.search).slice(0, 300),
                    tab: TAB_ID,
                    lang: I18n.getLanguage(),
                    msg: text
                };
                if (i18n) {
                    entry.i18nKey = i18n.key;
                    entry.i18nParams = i18n.params;
                    entry.i18nLang = i18n.lang;
                }
                arr.push(entry);
                _version++;
                if (isError) {
                    _errorCount++;
                }
                if (arr.length > DIAG_LOG_MAX) {
                    _cache = arr.slice(-DIAG_LOG_MAX);
                    _errorCount = _cache.reduce((acc, item) => (item && item.lvl === 'ERR' ? acc + 1 : acc), 0);
                }
                _isDirty = true;
                if (isError) {
                    // Критическая ошибка — сохраняем немедленно, чтобы не потерять при падении/навигации
                    _flushSync();
                } else {
                    _scheduleSave();
                }
            },
            getAll() {
                return _ensureLoaded().slice();
            },
            getStats() {
                const arr = _ensureLoaded();
                return {
                    total: arr.length,
                    errors: _errorCount,
                    version: _version
                };
            },
            clear() {
                _cache = [];
                _errorCount = 0;
                _version++;
                _isDirty = false;
                if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
                storage.localRemove(KEYS.diagLog);
            },
            flush() {
                _flushSync();
            }
        };
    })();

    const Metrics = (() => {
        let _cache = null;
        let _saveTimer = null;
        let _isDirty = false;

        function _ensureLoaded() {
            if (_cache === null) {
                const m = parseJson(storage.localGet(KEYS.metrics), null);
                if (m && typeof m === 'object') {
                    m.counters = m.counters || {};
                    m.timings = m.timings || {};
                    m.selectors = m.selectors || {};
                    m.snapshots = Array.isArray(m.snapshots) ? m.snapshots : [];
                    _cache = m;
                } else {
                    _cache = { startedAt: Date.now(), counters: {}, timings: {}, selectors: {}, snapshots: [] };
                }
            }
            return _cache;
        }

        function _flushSync() {
            if (!_isDirty || !_cache) return;
            if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
            try {
                if (!storage.localSet(KEYS.metrics, JSON.stringify(_cache))) {
                    _cache.snapshots = (_cache.snapshots || []).slice(-3);
                    storage.localSet(KEYS.metrics, JSON.stringify(_cache));
                }
                _isDirty = false;
            } catch (e) { /* ignore */ }
        }

        function _scheduleSave() {
            _isDirty = true;
            if (_saveTimer) return;
            _saveTimer = setTimeout(() => {
                _saveTimer = null;
                _flushSync();
            }, 300);
        }

        return {
            bump(key, by = 1) {
                const m = _ensureLoaded();
                m.counters[key] = (m.counters[key] || 0) + by;
                _scheduleSave();
            },
            timing(key, ms) {
                if (!Number.isFinite(ms)) return;
                const m = _ensureLoaded();
                const t = m.timings[key] || { n: 0, sum: 0, last: 0, max: 0 };
                t.n++; t.sum += ms; t.last = ms; if (ms > t.max) t.max = ms;
                m.timings[key] = t;
                _scheduleSave();
            },
            selector(name, found) {
                const m = _ensureLoaded();
                const s = m.selectors[name] || { found: 0, missing: 0 };
                if (found) s.found++; else s.missing++;
                m.selectors[name] = s;
                _scheduleSave();
            },
            snapshot(label, data) {
                const m = _ensureLoaded();
                m.snapshots.push({ t: Date.now(), label, ...data });
                if (m.snapshots.length > DOM_SNAPSHOT_MAX) m.snapshots = m.snapshots.slice(-DOM_SNAPSHOT_MAX);
                _isDirty = true;
                _flushSync();
            },
            getAll() { return _ensureLoaded(); },
            clear() {
                _cache = { startedAt: Date.now(), counters: {}, timings: {}, selectors: {}, snapshots: [] };
                _isDirty = false;
                if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
                storage.localRemove(KEYS.metrics);
            },
            flush() {
                _flushSync();
            }
        };
    })();

    // Живая статистика текущего прогона. Хранится в sessionStorage, поэтому переживает
    // навигацию скрипта между страницами (вкладка одна) и естественно сбрасывается на
    // новый запуск. Отдельные счётчики: сколько попыток отклика было предпринято, сколько
    // из них успешно отправлено, сколько ушло в ручной список (вопросы/блокировки),
    // сколько пропущено (уже откликались / нет кнопки / битая карточка).
    const STATS_FIELDS = ['success', 'manual', 'skipped'];
    const Stats = {
        _get() {
            const s = parseJson(storage.sessionGet(KEYS.stats), null);
            const base = { success: 0, manual: 0, skipped: 0, startedAt: 0 };
            return (s && typeof s === 'object') ? { ...base, ...s } : base;
        },
        _save(s) { storage.sessionSet(KEYS.stats, JSON.stringify(s)); },
        bump(key, by = 1) {
            if (!STATS_FIELDS.includes(key)) return;
            const s = Stats._get();
            if (!s.startedAt) s.startedAt = Date.now();
            s[key] = (s[key] || 0) + by;
            Stats._save(s);
            try { window._hhApplyAssistantRenderStats?.(); } catch (e) { /* ignore */ }
        },
        // Попытка отклика = один терминальный исход по вакансии (успех + ручной + пропуск).
        attempts() {
            const s = Stats._get();
            return (s.success || 0) + (s.manual || 0) + (s.skipped || 0);
        },
        getAll() {
            const s = Stats._get();
            return { attempts: Stats.attempts(), success: s.success || 0, manual: s.manual || 0, skipped: s.skipped || 0 };
        },
        reset() {
            storage.sessionRemove(KEYS.stats);
            try { window._hhApplyAssistantRenderStats?.(); } catch (e) { /* ignore */ }
        }
    };

    // Лог в панели + консоль + постоянное хранилище.
    // Порядок обновления:
    // 1. Сохранить запись в DiagLog
    // 2. Обновить full diagnostic UI (если открыт/отрендерен)
    // 3. Обновить diagnostic badge
    const log = (msg, isError = false) => {
        // 1. Сохраняем запись в диагностический лог (не блокируя UI при ошибках storage)
        try {
            DiagLog.push(msg, isError);
        } catch (e) { /* ошибки storage не должны ломать UI */ }

        try {
            // 2. Обновляем счетчик / бейдж
            try {
                window._hhApplyAssistantUpdateDiagBadge?.();
            } catch (e) { /* ignore */ }

            // 3. Выделенный полноразмерный экран диагностики (рендерим только если он активен/видим)
            const viewDiag = document.getElementById('ar-view-diag');
            if (viewDiag && viewDiag.style.display !== 'none') {
                try {
                    window._hhApplyAssistantRenderDiagnostics?.();
                } catch (e) { /* ignore */ }
            }
        } catch (e) { /* UI-лог не критичен */ }

        console.log(`[HH Apply Assistant] ${msg}`);
    };

    // Снимок связанного с откликом DOM - чтобы по нему обновлять селекторы, когда детект не сработал.
    // Собираем только UI-разметку (data-qa, поля, кнопки), без персональных данных.
    function captureResponseDom(label) {
        try {
            const wanted = /response|cover|letter|submit|relocation|resume|popup|modal|apply|vacancy-response/i;
            const dataQa = [];
            document.querySelectorAll('[data-qa]').forEach(el => {
                if (dataQa.length >= 50) return;
                const qa = el.getAttribute('data-qa') || '';
                if (!wanted.test(qa)) return;
                dataQa.push({
                    tag: el.tagName.toLowerCase(),
                    qa: qa.slice(0, 90),
                    vis: el.offsetParent !== null,
                    txt: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)
                });
            });
            const textareas = Array.from(document.querySelectorAll('textarea')).slice(0, 10).map(t => ({
                name: t.name || '',
                qa: t.getAttribute('data-qa') || '',
                ph: (t.getAttribute('placeholder') || '').slice(0, 40),
                vis: t.offsetParent !== null
            }));
            // Поля вопросов работодателя (task_*) - любого типа (input/select/textarea). По ним отличаем
            // настоящую анкету от обычной формы отклика (input/radio-вопросы не видны в textareas выше).
            const taskFields = Array.from(document.querySelectorAll('[name^="task_"]')).slice(0, 15).map(f => ({
                tag: f.tagName.toLowerCase(),
                type: (f.getAttribute('type') || '').slice(0, 20),
                name: (f.getAttribute('name') || '').slice(0, 60),
                vis: f.offsetParent !== null
            }));
            let modal = null;
            try { modal = document.querySelector('[data-qa*="modal" i], [class*="modal" i]'); } catch (e) { /* ignore */ }
            const modalButtons = [];
            if (modal) {
                modal.querySelectorAll('button, [role="button"], a[data-qa]').forEach(b => {
                    if (modalButtons.length >= 20) return;
                    modalButtons.push({
                        qa: b.getAttribute('data-qa') || '',
                        txt: (b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
                        vis: b.offsetParent !== null
                    });
                });
            }
            Metrics.snapshot(label, {
                path: (location.pathname + location.search).slice(0, 200),
                hasModal: !!modal,
                dataQa,
                textareas,
                taskFields,
                modalButtons
            });
            log(I18n.t('logs.domSnapshot', { label, dataQa: dataQa.length, textareas: textareas.length, taskFields: taskFields.length, modalBtns: modalButtons.length }));
        } catch (e) { /* ignore */ }
    }

    // Фиксируем, какой вариант селектора реально сработал: новый или legacy-фоллбек.
    // Если legacy начинает преобладать - значит hh.ru вернул старую вёрстку (или наоборот).
    function recordSelectorVariant(name, newSel, legacySel, knownVariant) {
        try {
            if (knownVariant) {
                Metrics.bump(`sel.${name}.${knownVariant}`);
                return;
            }
            const hasNew = !!document.querySelector(newSel);
            const hasLegacy = legacySel ? !!document.querySelector(legacySel) : false;
            const variant = hasNew ? 'new' : (hasLegacy ? 'legacy' : 'none');
            Metrics.bump(`sel.${name}.${variant}`);
        } catch (e) { /* ignore */ }
    }

    // Собираем диагностический отчёт: заголовок с окружением/состоянием + все строки лога.
    function buildDiagnosticReport() {
        const pad2 = (n) => String(n).padStart(2, '0');
        const pad3 = (n) => String(n).padStart(3, '0');
        const fmtTime = (t) => {
            const d = new Date(t);
            return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
        };
        let cfgSnapshot = '{}';
        try { cfgSnapshot = JSON.stringify({ ...config, coverText: `(${(config.coverText || '').length} ${I18n.getLanguage() === 'ru' ? 'симв.' : 'chars'})` }); } catch (e) { /* ignore */ }
        const lockRaw = storage.localGet(KEYS.instanceLock) || I18n.t('report.none');

        const entries = DiagLog.getAll();
        const header = [
            I18n.t('report.headerTitle'),
            I18n.t('report.scriptVersion', { version: VERSION }),
            I18n.t('report.exportedAt', { time: new Date().toISOString() }),
            I18n.t('report.currentUrl', { url: location.href }),
            I18n.t('report.userAgent', { ua: navigator.userAgent }),
            I18n.t('report.tabId', { tabId: TAB_ID }),
            I18n.t('report.running', { running: State.amIRunning() }),
            I18n.t('report.sent', { sent: State.getSentCount(), limit: config.limit }),
            I18n.t('report.processedIds', { count: State.getProcessedIDs().size }),
            I18n.t('report.manualList', { count: State.getManualList().length }),
            I18n.t('report.instanceLock', { lock: lockRaw }),
            I18n.t('report.trapLock', { trap: State.hasTrapLock() }),
            I18n.t('report.f5Needed', { f5: State.isF5Needed() }),
            I18n.t('report.lastAttempt', { last: State.getLastAttemptID() || I18n.t('report.none') }),
            I18n.t('report.returnUrl', { url: State.getReturnUrl() || I18n.t('report.none') }),
            I18n.t('report.config', { cfg: cfgSnapshot }),
            I18n.t('report.logEntries', { count: entries.length }),
            '==============================================',
            ''
        ].join('\n');

        const body = entries.map(e => {
            const lvl = e.lvl === 'ERR' ? 'ERR ' : 'INFO';
            return `[${fmtTime(e.t)}] [${lvl}] [tab ${e.tab || '?'}] [${e.path || '?'}] ${DiagnosticI18n.format(e)}`;
        }).join('\n');

        return header + buildMetricsSection() + '\n' + body + '\n' + buildSnapshotsSection();
    }

    // Секция метрик: распределение сценариев, тайминги, здоровье и варианты селекторов.
    function buildMetricsSection() {
        const m = Metrics.getAll();
        const c = m.counters || {};
        const get = (k) => c[k] || 0;
        const lines = [];
        lines.push('', I18n.t('report.metricsTitle'));
        lines.push(I18n.t('report.metricsSince', { time: new Date(m.startedAt || Date.now()).toISOString() }));
        lines.push(I18n.t('report.scenariosHeading'));
        lines.push(I18n.t('report.scenarios.A', { val: get('scenario.A') }));
        lines.push(I18n.t('report.scenarios.B', { val: get('scenario.B') }));
        lines.push(I18n.t('report.scenarios.C', { val: get('scenario.C') }));
        lines.push(I18n.t('report.scenarios.relocation', { val: get('scenario.relocation') }));
        lines.push(I18n.t('report.scenarios.questions', { val: get('scenario.questions') }));
        lines.push(I18n.t('report.scenarios.questionsWatchdog', { val: get('scenario.questions.watchdog') }));
        lines.push(I18n.t('report.scenarios.timeout', { val: get('scenario.timeout'), unresolved: get('scenario.timeout.unresolved') }));
        lines.push(I18n.t('report.scenarios.noApply', { val: get('scenario.noApply') }));
        lines.push(I18n.t('report.scenarios.bNoConfirm', { val: get('scenario.B.noConfirm') }));

        // Прочие счётчики (например, sel.* и всё, что не вошло выше)
        const known = new Set(['scenario.A', 'scenario.B', 'scenario.C', 'scenario.relocation', 'scenario.questions', 'scenario.questions.watchdog', 'scenario.timeout', 'scenario.timeout.unresolved', 'scenario.noApply', 'scenario.B.noConfirm']);
        const others = Object.keys(c).filter(k => !known.has(k)).sort();
        if (others.length) {
            lines.push(I18n.t('report.otherCounters'));
            others.forEach(k => lines.push(`  ${k} : ${c[k]}`));
        }

        const t = m.timings || {};
        const tKeys = Object.keys(t);
        if (tKeys.length) {
            lines.push(I18n.t('report.timingsHeading'));
            tKeys.forEach(k => {
                const v = t[k];
                const avg = v.n ? Math.round(v.sum / v.n) : 0;
                lines.push(`  ${k} : n=${v.n} avg=${avg} max=${v.max} last=${v.last}`);
            });
        }

        const sel = m.selectors || {};
        const sKeys = Object.keys(sel);
        if (sKeys.length) {
            lines.push(I18n.t('report.selectorsHeading'));
            sKeys.forEach(k => lines.push(`  ${k} : ${sel[k].found} / ${sel[k].missing}`));
        }
        lines.push('==============================================');
        return lines.join('\n');
    }

    // Секция снимков DOM - по ней видно фактическую разметку в момент сбоя детекта.
    function buildSnapshotsSection() {
        const pad2 = (n) => String(n).padStart(2, '0');
        const fmt = (t) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
        const snaps = (Metrics.getAll().snapshots) || [];
        const lines = ['', I18n.t('report.snapshotsTitle')];
        if (!snaps.length) {
            lines.push(I18n.t('report.snapshotsEmpty'));
            return lines.join('\n');
        }
        snaps.forEach((s, i) => {
            lines.push('');
            lines.push(`#${i + 1} [${fmt(s.t)}] label=${s.label} path=${s.path || '?'} hasModal=${!!s.hasModal}`);
            if (Array.isArray(s.dataQa) && s.dataQa.length) {
                lines.push('  data-qa:');
                s.dataQa.forEach(d => lines.push(`    - <${d.tag}> qa="${d.qa}" vis=${d.vis} txt="${d.txt}"`));
            }
            if (Array.isArray(s.textareas) && s.textareas.length) {
                lines.push('  textareas:');
                s.textareas.forEach(t => lines.push(`    - name="${t.name}" qa="${t.qa}" ph="${t.ph}" vis=${t.vis}`));
            }
            if (Array.isArray(s.taskFields) && s.taskFields.length) {
                lines.push(I18n.t('report.taskFieldsHeading'));
                s.taskFields.forEach(f => lines.push(`    - <${f.tag}> type="${f.type}" name="${f.name}" vis=${f.vis}`));
            }
            if (Array.isArray(s.modalButtons) && s.modalButtons.length) {
                lines.push('  modalButtons:');
                s.modalButtons.forEach(b => lines.push(`    - qa="${b.qa}" vis=${b.vis} txt="${b.txt}"`));
            }
        });
        return lines.join('\n') + '\n';
    }

    // Скачиваем диагностический отчёт файлом.
    function exportDiagnosticReport() {
        try {
            const report = buildDiagnosticReport();
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            downloadFile(`hh_apply_assistant_log_${stamp}.txt`, report, 'text/plain;charset=utf-8');
            log(I18n.t('logs.diagExported'));
        } catch (e) {
            log(I18n.t('logs.diagExportFailed', { err: (e && e.message ? e.message : e) }), true);
        }
    }

    // Универсальная выгрузка файла через Blob-ссылку.
    function downloadFile(filename, content, mime) {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    // ─────────────────────────────────────────────────────────────
    //  6. СОСТОЯНИЕ ПРОГОНА (local/session storage)
    // ─────────────────────────────────────────────────────────────

    function clearTrapLockTimer() {
        if (trapLockTimer) {
            clearTimeout(trapLockTimer);
            trapLockTimer = null;
        }
    }

    function getActiveTrapLock() {
        const raw = storage.sessionGet(KEYS.trapLock);
        if (!raw) return null;
        const lock = parseJson(raw, null);
        const expiresAt = Number(lock?.expiresAt);
        if (!lock || typeof lock !== 'object' || typeof lock.token !== 'string' || !lock.token || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            storage.sessionRemove(KEYS.trapLock);
            clearTrapLockTimer();
            return null;
        }
        return {
            token: lock.token,
            expiresAt,
            runId: Number.isFinite(Number(lock.runId)) ? Number(lock.runId) : null
        };
    }

    function readInstanceLock() {
        try {
            const raw = localStorage.getItem(KEYS.instanceLock);
            return { ok: true, lock: parseJson(raw, null) };
        } catch (e) {
            return { ok: false, lock: null };
        }
    }

    function sameInstanceLease(lock, tabId, leaseId) {
        return !!(lock && lock.tabId === tabId && typeof leaseId === 'string' && leaseId && lock.leaseId === leaseId);
    }

    function isLiveInstanceLease(lock, now = Date.now()) {
        const ts = Number(lock?.ts);
        return Number.isFinite(ts) && now - ts < TUNING.instanceLockTtl;
    }

    function newInstanceLeaseId(tabId) {
        return `${tabId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    }

    const State = {
        readProcessedIDs: () => {
            const read = storage.sessionRead(KEYS.history);
            if (!read.ok) return { ok: false, value: new Set() };
            const arr = parseJson(read.value, []);
            return { ok: true, value: new Set(Array.isArray(arr) ? arr : []) };
        },
        getProcessedIDs: () => State.readProcessedIDs().value,
        addProcessedID: (id) => {
            if (!id) return true;
            const current = State.readProcessedIDs();
            if (!current.ok) return false;
            const s = current.value;
            s.add(id);
            return writeSessionVerified(KEYS.history, JSON.stringify([...s]));
        },
        clearProcessedIDs: () => removeSessionVerified(KEYS.history),

        // Счётчик успешно отправленных откликов - переживает переходы между страницами,
        // поэтому лимит работает на весь прогон, а не сбрасывается на каждой загрузке.
        readSentCount: () => {
            const read = storage.sessionRead(KEYS.sentCount);
            if (!read.ok) return { ok: false, value: 0 };
            const n = parseInt(read.value || '0', 10);
            return { ok: true, value: Number.isFinite(n) ? n : 0 };
        },
        getSentCount: () => State.readSentCount().value,
        incSentCount: () => {
            const current = State.readSentCount();
            if (!current.ok) return null;
            const next = current.value + 1;
            if (!writeSessionVerified(KEYS.sentCount, String(next))) return null;
            Stats.bump('success');
            return next;
        },
        resetSentCount: () => removeSessionVerified(KEYS.sentCount),

        amIRunning: () => storage.sessionGet(KEYS.isRunning) === '1',
        setRunning: (state) => state ? writeSessionVerified(KEYS.isRunning, '1') : removeSessionVerified(KEYS.isRunning),

        setReturnUrl: (url) => storage.sessionSet(KEYS.returnUrl, url || location.href),
        getReturnUrl: () => storage.sessionGet(KEYS.returnUrl),

        setF5Needed: () => storage.sessionSet(KEYS.needF5, '1'),
        isF5Needed: () => storage.sessionGet(KEYS.needF5) === '1',
        clearF5Flag: () => storage.sessionRemove(KEYS.needF5),

        // "Ловушка" - пометка, что мы уже обрабатываем возврат со страницы тестов / форму отклика.
        // Защищена уникальным generation token, чтобы устаревший таймер от прошлого вызова
        // не мог снять блокировку у нового активного обработчика.
        setTrapLock: (ttlMs = 45000) => {
            const token = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
            const ttl = Math.max(0, Number(ttlMs) || 0);
            const lock = { token, runId: currentRunId, expiresAt: Date.now() + ttl };
            if (!storage.sessionSet(KEYS.trapLock, JSON.stringify(lock))) return null;
            clearTrapLockTimer();
            trapLockTimer = setTimeout(() => {
                const current = parseJson(storage.sessionGet(KEYS.trapLock), null);
                if (current && current.token === token) {
                    storage.sessionRemove(KEYS.trapLock);
                    trapLockTimer = null;
                    log(I18n.t('logs.trapTimeout'));
                }
            }, ttl);
            return token;
        },
        clearTrapLock: (token) => {
            if (token) {
                const current = getActiveTrapLock();
                if (!current || current.token !== token) return false;
            }
            const removed = storage.sessionRemove(KEYS.trapLock);
            if (removed) clearTrapLockTimer();
            return removed;
        },
        hasTrapLock: () => !!getActiveTrapLock(),

        // Запоминаем последнюю попытку отклика - пригодится при редиректах
        setLastAttemptID: (id) => id ? storage.sessionSet(KEYS.lastAttempt, id) : true,
        getLastAttemptID: () => storage.sessionGet(KEYS.lastAttempt),
        clearLastAttemptID: () => storage.sessionRemove(KEYS.lastAttempt),

        // Запоминаем распарсенное имя последней просмотренной вакансии (Должность · Город · Работодатель),
        // чтобы позже - уже на странице отклика/вопросов, где имени нет - сохранить его в ручной список.
        setLastVacancyMeta: (vid, title) => {
            if (!title) return;
            storage.sessionSet(KEYS.lastVacancyMeta, JSON.stringify({
                vid: vid || '',
                title: String(title).slice(0, 300),
                ts: Date.now()
            }));
        },
        getLastVacancyMeta: () => parseJson(storage.sessionGet(KEYS.lastVacancyMeta), null),

        // Кросс-вкладочный lease: TAB_ID задаёт вкладку, leaseId — конкретное поколение.
        // После записи обязательно перечитываем ключ: localStorage не даёт атомарного CAS,
        // поэтому ownership появляется только после точного read-back совпадения.
        acquireInstanceLock: async (tabId) => {
            const now = Date.now();
            const current = readInstanceLock();
            if (!current.ok) {
                instanceLeaseVerified = false;
                return false;
            }
            const obj = current.lock;
            if (obj && isLiveInstanceLease(obj, now) && obj.tabId !== tabId) {
                instanceLeaseVerified = false;
                return false;
            }

            const leaseId = newInstanceLeaseId(tabId);
            const candidate = { tabId, leaseId, ts: now };
            currentInstanceLeaseId = leaseId;
            instanceLeaseVerified = false;
            pendingInstanceLeaseId = leaseId;
            if (!storage.localSet(KEYS.instanceLock, JSON.stringify(candidate))) {
                if (pendingInstanceLeaseId === leaseId) pendingInstanceLeaseId = null;
                return false;
            }

            await sleep(60);
            const check = readInstanceLock();
            const owned = !!(
                check.ok
                && currentInstanceLeaseId === leaseId
                && sameInstanceLease(check.lock, tabId, leaseId)
                && Number(check.lock.ts) === now
                && isLiveInstanceLease(check.lock)
            );
            if (pendingInstanceLeaseId === leaseId) pendingInstanceLeaseId = null;
            if (currentInstanceLeaseId === leaseId) instanceLeaseVerified = owned;
            return owned;
        },
        verifyInstanceLock: (tabId, leaseId = currentInstanceLeaseId) => {
            if (!leaseId || leaseId !== currentInstanceLeaseId || !instanceLeaseVerified) return 'LOST';
            const current = readInstanceLock();
            const owned = current.ok
                && sameInstanceLease(current.lock, tabId, leaseId)
                && isLiveInstanceLease(current.lock);
            if (!owned && leaseId === currentInstanceLeaseId) instanceLeaseVerified = false;
            return owned ? 'OWNED' : 'LOST';
        },
        releaseInstanceLock: (tabId, leaseId = currentInstanceLeaseId) => {
            let removed = false;
            const current = readInstanceLock();
            if (current.ok && sameInstanceLease(current.lock, tabId, leaseId)) {
                removed = storage.localRemove(KEYS.instanceLock);
            }
            if (leaseId && leaseId === currentInstanceLeaseId) {
                currentInstanceLeaseId = null;
                instanceLeaseVerified = false;
            }
            if (leaseId && leaseId === pendingInstanceLeaseId) pendingInstanceLeaseId = null;
            return removed;
        },
        // Продлеваем только текущее подтверждённое поколение и проверяем результат записи.
        // Любая неопределённость storage означает LOST: UNKNOWN никогда не трактуется как OWNED.
        touchInstanceLock: (tabId, leaseId = currentInstanceLeaseId) => {
            if (!leaseId || leaseId !== currentInstanceLeaseId || !instanceLeaseVerified) return 'LOST';
            const current = readInstanceLock();
            if (!current.ok || !sameInstanceLease(current.lock, tabId, leaseId) || !isLiveInstanceLease(current.lock)) {
                instanceLeaseVerified = false;
                return 'LOST';
            }

            // Значение должно отличаться даже у двух guards в одну миллисекунду,
            // иначе проигнорированную запись нельзя отличить от старого timestamp.
            const now = Math.max(Date.now(), Number(current.lock.ts) + 1);
            const renewed = { tabId, leaseId, ts: now };
            if (!storage.localSet(KEYS.instanceLock, JSON.stringify(renewed))) {
                instanceLeaseVerified = false;
                return 'LOST';
            }
            const check = readInstanceLock();
            const owned = check.ok
                && sameInstanceLease(check.lock, tabId, leaseId)
                && Number(check.lock.ts) === now;
            instanceLeaseVerified = !!owned;
            return owned ? 'OWNED' : 'LOST';
        },

        // --- Ручной список (вакансии с вопросами/блокировками для ручного отклика) ---
        getManualList: () => {
            const list = parseJson(storage.localGet(KEYS.manualList), []);
            return Array.isArray(list) ? list : [];
        },
        // Добавляет запись в список для ручного отклика.
        // Возвращает:
        // 'ADDED'   - запись успешно добавлена и сохранена в localStorage;
        // 'EXISTS'  - запись уже присутствует в списке (уже сохранена ранее);
        // 'UPDATED' - заголовок существующей записи успешно обновлён и сохранён;
        // 'FAILED'  - ошибка сохранения (storage.localSet вернул false или некорректный URL).
        addManualEntry: (entry) => {
            try {
                const safeUrl = toSafeHhUrl(entry?.url);
                if (!safeUrl) return 'FAILED';
                const safeReturnUrl = toSafeHhUrl(entry?.returnUrl);
                const normalizedEntry = {
                    vid: String(entry?.vid || ('u_' + fnv1a32(safeUrl).toString(36))).slice(0, 120),
                    url: safeUrl,
                    returnUrl: safeReturnUrl || '',
                    ts: Number.isFinite(Number(entry?.ts)) ? Number(entry.ts) : Date.now(),
                    title: prettifyTitle(entry?.title || '').slice(0, 300)
                };
                const list = State.getManualList();
                const exists = list.find(e => e.vid === normalizedEntry.vid || e.url === normalizedEntry.url);
                if (!exists) {
                    list.unshift(normalizedEntry);
                    // ограничим длину списка, чтобы не раздувался
                    if (list.length > 500) list.length = 500;
                    const saved = writeLocalVerified(KEYS.manualList, JSON.stringify(list));
                    return saved ? 'ADDED' : 'FAILED';
                } else if ((!exists.title || exists.title === 'Название недоступно' || exists.title === 'Title unavailable') && normalizedEntry.title && normalizedEntry.title !== 'Название недоступно' && normalizedEntry.title !== 'Title unavailable') {
                    exists.title = normalizedEntry.title;
                    const saved = writeLocalVerified(KEYS.manualList, JSON.stringify(list));
                    return saved ? 'UPDATED' : 'FAILED';
                }
                return 'EXISTS';
            } catch (e) {
                console.warn('[HH Apply Assistant] addManualEntry error', e);
                return 'FAILED';
            }
        },
        removeManualEntry: (vid) => {
            try {
                const list = State.getManualList().filter(e => e.vid !== vid);
                return writeLocalVerified(KEYS.manualList, JSON.stringify(list));
            } catch (e) {
                console.warn('[HH Apply Assistant] removeManualEntry error', e);
                return false;
            }
        },
        clearManualList: () => {
            try {
                return removeLocalVerified(KEYS.manualList);
            } catch (e) {
                console.warn('[HH Apply Assistant] clearManualList error', e);
                return false;
            }
        }
    };

    function ensureCurrentRunLimit() {
        const sentState = State.readSentCount();
        if (!sentState.ok) return false;
        const sent = sentState.value;
        if (sent <= config.limit) return true;
        return persistSettings({ ...config, limit: Math.min(500, sent) });
    }

    // Fencing guard только для safety-critical commit points. Он не подменяет runId:
    // сначала отсекаем старое внутривкладочное поколение, затем renew+read-back текущего lease.
    function guardOwnedCommit(runId = currentRunId) {
        if (!isRunCurrent(runId)) return false;
        if (State.touchInstanceLock(TAB_ID) === 'OWNED') return true;
        haltForLostInstanceLock();
        return false;
    }

    // При авто-возобновлении сразу проверяем lock (запись в localStorage происходит
    // синхронно при вызове, пост-верификация - асинхронно)
    if (State.amIRunning()) {
        State.acquireInstanceLock(TAB_ID).then((ok) => {
            if (!ok) console.warn('[HH Apply Assistant] Обнаружен активный процесс в другой вкладке.');
        });
    }

    // ─────────────────────────────────────────────────────────────
    //  7. БЕЗОПАСНАЯ РАБОТА С DOM
    // ─────────────────────────────────────────────────────────────

    // Безопасный querySelector: не бросает исключение на битом селекторе и без DOM.
    const q = (selector, root) => {
        try { return (root || document).querySelector(selector); } catch (e) { return null; }
    };
    const qa = (selector, root) => {
        try { return Array.from((root || document).querySelectorAll(selector)); } catch (e) { return []; }
    };
    const isVisible = (el) => {
        if (!el) return false;
        try {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        } catch (e) {
            return el.offsetParent !== null;
        }
    };

    function isAutoResponderUI(el) {
        if (!el) return false;
        let curr = el;
        while (curr && curr !== document.body) {
            if (curr.id && String(curr.id).startsWith('ar-')) return true;
            if (curr.className && typeof curr.className === 'string' && curr.className.split(/\s+/).some(c => c.startsWith('ar-'))) return true;
            curr = curr.parentElement;
        }
        return false;
    }

    function queryExact(key, root) {
        const selector = SELECTORS[key];
        if (!selector) return null;
        const el = q(selector, root);
        if (!el || isAutoResponderUI(el)) return null;
        recordSelectorVariant(key, selector, null, 'new');
        return el;
    }

    function queryHeuristic(key, root) {
        const found = runHeuristic(key, root || document);
        if (!found || isAutoResponderUI(found)) return null;
        Metrics.bump(`heuristic.fallback.${key}`);
        log(I18n.t('logs.heuristicFallback', { key, tag: found.tagName.toLowerCase() }));
        return found;
    }

    // Интеллектуальный поиск элементов с эвристиками на случай изменения верстки
    function query(keyOrSelector, root) {
        const selector = SELECTORS[keyOrSelector];
        if (!selector) {
            // Если это не ключ из SELECTORS, а сырой селектор, проверим, вдруг это само значение селектора
            const matchedKey = Object.keys(SELECTORS).find(k => SELECTORS[k] === keyOrSelector);
            if (matchedKey) {
                return query(matchedKey, root);
            }
            const el = q(keyOrSelector, root);
            return isAutoResponderUI(el) ? null : el;
        }
        const el = queryExact(keyOrSelector, root);
        if (el) return el;
        // Запуск эвристического поиска
        return queryHeuristic(keyOrSelector, root);
    }

    function queryAll(keyOrSelector, root) {
        const selector = SELECTORS[keyOrSelector];
        if (!selector) {
            const matchedKey = Object.keys(SELECTORS).find(k => SELECTORS[k] === keyOrSelector);
            if (matchedKey) {
                return queryAll(matchedKey, root);
            }
            return qa(keyOrSelector, root).filter(el => !isAutoResponderUI(el));
        }
        let elements = qa(selector, root).filter(el => !isAutoResponderUI(el));
        if (elements.length > 0) {
            return elements;
        }
        let found = runHeuristicAll(keyOrSelector, root || document).filter(el => !isAutoResponderUI(el));
        if (found.length > 0) {
            Metrics.bump(`heuristic.fallback.all.${keyOrSelector}`);
            log(I18n.t('logs.heuristicFallbackAll', { key: keyOrSelector, count: found.length }));
        }
        return found;
    }

    function runHeuristic(key, root) {
        try {
            switch (key) {
                case 'applyBtn':
                case 'vacancyApply':
                {
                    const elements = Array.from(root.querySelectorAll('button, a, [role="button"]'));
                    const matchText = /откликнуться|отклик без резюме|перейти к отклику|apply|respond|no resume necessary|apply now/i;
                    for (const el of elements) {
                        if (matchText.test((el.textContent || '').trim()) && isVisible(el)) {
                            return el;
                        }
                    }
                    // Фоллбек по href/data-qa - только интерактивные элементы. Раньше широкий
                    // [data-qa*="response"] хватал служебные <div> (статус Вы откликнулись,
                    // блок успеха), клик по которым давал фантомные отклики.
                    const candidates = qa('a[href*="/applicant/vacancy_response"], a[data-qa*="response"], button[data-qa*="response"], a[data-qa*="apply"], button[data-qa*="apply"], [role="button"][data-qa*="response"]', root);
                    const notApply = /status|success|view-topic|error|chat/i;
                    for (const el of candidates) {
                        const qaAttr = el.getAttribute('data-qa') || '';
                        if (notApply.test(qaAttr)) continue;
                        if (isVisible(el)) return el;
                    }
                    break;
                }
                case 'attachCoverBtn':
                case 'attachCoverInModal': {
                    const matchText = /сопроводительное|добавить сопроводительное|написать сопроводительное|письмо|cover letter|attach cover|write cover|add cover/i;
                    // Сначала ищем среди интерактивных элементов
                    const activeEls = Array.from(root.querySelectorAll('button, a, [role="button"]'));
                    for (const el of activeEls) {
                        if (matchText.test((el.textContent || '').trim()) && isVisible(el)) {
                            return el;
                        }
                    }
                    break;
                }
                case 'letterTextarea': {
                    const textareas = Array.from(root.querySelectorAll('textarea'));
                    const visibleTextarea = textareas.find(t => isVisible(t));
                    if (visibleTextarea) return visibleTextarea;
                    const matchText = /сопроводительное|письмо|cover|message|letter/i;
                    for (const t of textareas) {
                        const placeholder = t.getAttribute('placeholder') || '';
                        const name = t.name || '';
                        if (matchText.test(placeholder) || matchText.test(name)) {
                            return t;
                        }
                    }
                    break;
                }
                case 'letterSubmit': {
                    const elements = Array.from(root.querySelectorAll('button, input[type="submit"], [role="button"]'));
                    const matchText = /отправить|откликнуться|готово|send|submit|done|apply/i;
                    for (const el of elements) {
                        if (!matchText.test((el.textContent || '').trim())) continue;
                        const qaAttr = el.getAttribute('data-qa') || '';
                        if (qaAttr.includes('vacancy-response-link') || qaAttr.includes('vacancy-serp__vacancy_response')) continue;
                        if (isVisible(el)) return el;
                    }
                    const submitBtn = root.querySelector('button[type="submit"], input[type="submit"]');
                    if (submitBtn && isVisible(submitBtn)) {
                        const qaAttr = submitBtn.getAttribute('data-qa') || '';
                        if (qaAttr.includes('vacancy-response-link') || qaAttr.includes('vacancy-serp__vacancy_response')) {
                            // skip
                        } else {
                            return submitBtn;
                        }
                    }
                    break;
                }
                case 'relocationBtn': {
                    // Кнопка подтверждения переезда существует только внутри модального окна -
                    // ищем строго в его контейнере. Раньше поиск шёл по всей странице с матчем
                    // подстроки /да/, и за кнопку подтверждения принимались Задать вопрос,
                    // ...Дальнего Востока и любой текст с да внутри.
                    const scopeSelector = '[data-qa*="relocation" i], [role="dialog"], [data-qa*="modal" i], [class*="modal" i]';
                    const scope = root.matches?.(scopeSelector) ? root : root.querySelector(scopeSelector);
                    if (!scope) break;
                    const elements = Array.from(scope.querySelectorAll('button, a, [role="button"]'));
                    const exact = /^(да|yes|ok|хорошо)[.!]?$/i;
                    const phrase = /всё равно|все равно|подтвердить|подтверждаю|согласен|продолжить|confirm|agree|proceed|apply anyway/i;
                    for (const el of elements) {
                        const t = collapseSpaces(el.textContent || '');
                        if (!t || !isVisible(el)) continue;
                        if (exact.test(t) || phrase.test(t)) return el;
                    }
                    break;
                }
                case 'rejectWarning': {
                    const elements = Array.from(root.querySelectorAll('div, span, p, h1, h2, h3'));
                    const matchText = /(?:скорее всего|вероятн\w*|возможен|может быть)\W{0,30}отказ|(?:likely|probably|may)\W{0,30}(?:reject|declin)|likely to get a rejection/i;
                    for (const el of elements) {
                        if (matchText.test((el.textContent || '').trim()) && isVisible(el)) {
                            return el;
                        }
                    }
                    break;
                }
                case 'responseChat': {
                    const elements = Array.from(root.querySelectorAll('a, button'));
                    const matchText = /перейти (?:в|к) (?:чат|переписк\w*|сообщени\w*)|написать сообщени\w*|открыть чат|(?:go|open|view) (?:the )?(?:chat|conversation|topic)|message (?:the )?employer/i;
                    for (const el of elements) {
                        if (matchText.test((el.textContent || '').trim()) && isVisible(el)) {
                            return el;
                        }
                    }
                    const chatLink = root.querySelector('a[href*="/chats/"], a[href*="/conversations/"]');
                    if (chatLink && isVisible(chatLink)) return chatLink;
                    break;
                }
                case 'vacancyCard': {
                    const cards = Array.from(root.querySelectorAll('div'));
                    for (const c of cards) {
                        if (c.className && (c.className.includes('serp-item') || c.className.includes('vacancy-serp-item'))) {
                            return c;
                        }
                    }
                    break;
                }
                case 'vacancyLink': {
                    const link = root.querySelector('a[href*="/vacancy/"]');
                    if (link) return link;
                    break;
                }
            }
        } catch (e) {
            console.warn('[HH Apply Assistant] Ошибка в эвристике для ' + key, e);
        }
        return null;
    }

    function runHeuristicAll(key, root) {
        try {
            switch (key) {
                case 'applyBtn': {
                    const buttons = Array.from(root.querySelectorAll('button, a, [role="button"]'));
                    const matchText = /откликнуться|отклик без резюме|apply|respond|no resume necessary/i;
                    const results = buttons.filter(el => matchText.test((el.textContent || '').trim()) && isVisible(el));
                    if (results.length > 0) return results;
                    // Только интерактивные элементы и без служебных data-qa (см. runHeuristic)
                    const notApply = /status|success|view-topic|error|chat/i;
                    const hrefs = Array.from(root.querySelectorAll('a[href*="/applicant/vacancy_response"], a[data-qa*="response"], button[data-qa*="response"], a[data-qa*="apply"], button[data-qa*="apply"]'));
                    return hrefs.filter(el => !notApply.test(el.getAttribute('data-qa') || '') && isVisible(el));
                }
                case 'vacancyApply': {
                    const buttons = Array.from(root.querySelectorAll('button, a, [role="button"]'));
                    const matchText = /откликнуться|respond|apply/i;
                    return buttons.filter(el => matchText.test((el.textContent || '').trim()) && isVisible(el));
                }
            }
        } catch (e) {
            console.warn('[HH Apply Assistant] Ошибка в групповой эвристике для ' + key, e);
        }
        return [];
    }

    function getVacancyCard(node) {
        if (!node) return null;
        let card = null;
        try { card = node.closest(SELECTORS.vacancyCard); } catch (e) {}
        if (card) return card;
        // Карточка содержит РОВНО ОДНУ ссылку на вакансию. Без этой проверки подъём
        // по предкам цеплял контейнер всей выдачи (data-qa="vacancy-serp__results"
        // тоже содержит "vacancy") - и все кнопки страницы получали ID первой вакансии.
        const isSingleVacancyNode = (el) => qa('a[href*="/vacancy/"]', el).length === 1;
        let curr = node.parentElement;
        while (curr && curr !== document.body) {
            const className = curr.className || '';
            const dataQa = curr.getAttribute('data-qa') || '';
            if (className.includes('serp-item') || className.includes('vacancy-serp-item') || dataQa.includes('vacancy') || dataQa.includes('serp-item')) {
                if (isSingleVacancyNode(curr)) return curr;
                break; // поднялись до контейнера списка - карточки выше нет
            }
            curr = curr.parentElement;
        }
        let fallback = node.parentElement;
        for (let i = 0; i < 4 && fallback && fallback !== document.body; i++) {
            const links = qa('a[href*="/vacancy/"]', fallback);
            if (links.length === 1) return fallback;
            if (links.length > 1) break; // это уже список, не карточка
            fallback = fallback.parentElement;
        }
        return null;
    }

    function getNativeWrapper(el) {
        if (!el) return null;
        let wrapper = null;
        try { wrapper = el.closest(SELECTORS.nativeWrapper); } catch (e) {}
        if (wrapper) return wrapper;
        return el.closest('[data-qa="textarea-native-wrapper"]') || el.closest('[class*="native-wrapper"]') || el.parentElement;
    }

        // Ждём появления элемента - MutationObserver помогает при динамическом DOM,
    // поддерживает мгновенную отмену при Stop / AbortSignal без задержек.
    async function waitForElement(keyOrSelector, timeout = TUNING.waitForModalMs, signal) {
        const sig = signal || activeAbortController?.signal;
        if (stopSignal || sig?.aborted) return null;
        const el = query(keyOrSelector);
        if (el) return el;
        return new Promise((resolve) => {
            let timer = null;
            let onAbort = null;
            let observer = null;
            let finished = false;

            const finish = (result) => {
                if (finished) return;
                finished = true;
                if (timer) { clearTimeout(timer); timer = null; }
                if (observer) { observer.disconnect(); observer = null; }
                if (onAbort && sig) {
                    try { sig.removeEventListener('abort', onAbort); } catch (e) {}
                }
                resolve(result);
            };

            if (stopSignal || sig?.aborted) {
                return finish(null);
            }

            onAbort = () => finish(null);
            if (sig) {
                try { sig.addEventListener('abort', onAbort, { once: true }); } catch (e) {}
            }

            if (typeof MutationObserver !== 'undefined') {
                observer = new MutationObserver(() => {
                    if (stopSignal || sig?.aborted) {
                        finish(null);
                        return;
                    }
                    const found = query(keyOrSelector);
                    if (found) finish(found);
                });
                try {
                    observer.observe(document.documentElement || document, { childList: true, subtree: true });
                } catch (e) {}
            }
            timer = setTimeout(() => finish(null), timeout);
        });
    }

    function mutationBelongsToAssistantUI(mutation) {
        if (!mutation) return false;
        if (isAutoResponderUI(mutation.target)) return true;
        const changedNodes = [
            ...Array.from(mutation.addedNodes || []),
            ...Array.from(mutation.removedNodes || [])
        ];
        return changedNodes.length > 0 && changedNodes.every(node => {
            if (node?.nodeType === 1) return isAutoResponderUI(node);
            return isAutoResponderUI(node?.parentElement || mutation.target);
        });
    }

    // Ждём выполнения условия (возвращающего не-false значение или truthy результат).
    // DOM-события только планируют один коротко отложенный check; собственный UI игнорируется,
    // а редкий polling сохраняет совместимость с delayed modal и SPA без постоянного rAF-сканирования.
    async function waitForCondition(checkFn, timeout = TUNING.waitForModalMs, signal) {
        const sig = signal || activeAbortController?.signal;
        if (stopSignal || sig?.aborted) return false;
        try {
            const initial = checkFn();
            if (initial) return initial;
        } catch (e) { /* ignore */ }

        return new Promise((resolve) => {
            let timer = null;
            let pollTimer = null;
            let onAbort = null;
            let observer = null;
            let scheduledId = null;
            let finished = false;

            const finish = (result) => {
                if (finished) return;
                finished = true;
                if (timer) { clearTimeout(timer); timer = null; }
                if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
                if (observer) { observer.disconnect(); observer = null; }
                if (scheduledId) {
                    clearTimeout(scheduledId);
                    scheduledId = null;
                }
                if (onAbort && sig) {
                    try { sig.removeEventListener('abort', onAbort); } catch (e) {}
                }
                resolve(result);
            };

            if (stopSignal || sig?.aborted) return finish(false);

            onAbort = () => finish(false);
            if (sig) {
                try { sig.addEventListener('abort', onAbort, { once: true }); } catch (e) {}
            }

            const executeCheck = () => {
                scheduledId = null;
                if (finished || stopSignal || sig?.aborted) {
                    finish(false);
                    return;
                }
                try {
                    const res = checkFn();
                    if (res) finish(res);
                } catch (e) { /* ignore */ }
            };

            if (typeof MutationObserver !== 'undefined') {
                observer = new MutationObserver((mutations) => {
                    if (finished || stopSignal || sig?.aborted) {
                        finish(false);
                        return;
                    }
                    if (mutations?.length && mutations.every(mutationBelongsToAssistantUI)) return;
                    if (!scheduledId) {
                        scheduledId = setTimeout(executeCheck, 40);
                    }
                });
                try {
                    observer.observe(document.documentElement || document, {
                        childList: true,
                        subtree: true,
                        attributes: true,
                        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-busy', 'disabled', 'data-state', 'data-qa']
                    });
                } catch (e) {}
            }

            pollTimer = setInterval(executeCheck, 300);

            timer = setTimeout(() => finish(false), timeout);
        });
    }

    // Корректная вставка текста в textarea (учитывает React/Magritte)
    function fillTextarea(el, value) {
        try {
            const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
            if (descriptor && descriptor.set) {
                descriptor.set.call(el, value);
            } else {
                el.value = value;
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            // Обновляем визуальный wrapper, если он есть
            const wrapper = getNativeWrapper(el);
            const clone = wrapper ? q('pre', wrapper) : null;
            if (clone) clone.textContent = value || '​';
        } catch (e) { console.warn('[HH Apply Assistant] fillTextarea error', e); }
    }

    // Отслеживаем реальные координаты мыши пользователя, чтобы траектория начиналась оттуда
    let lastMousePos = { x: 0, y: 0 };
    addRuntimeListener(window, 'mousemove', (e) => {
        lastMousePos.x = e.clientX;
        lastMousePos.y = e.clientY;
    }, { passive: true });

    // Максимально человеческий клик: полная последовательность pointer/mouse-событий + нативный click.
    // Нужен там, где React/hh.ru не реагирует на голый .click() (например, подтверждение всё равно откликнуться).
    async function realisticClick(el, runId = currentRunId) {
        if (!el || !isRunCurrent(runId)) return false;
        try { el.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (e) { /* ignore */ }
        const isTurbo = config?.preset === 'turbo';
        try {
            const rect = el.getBoundingClientRect();
            const offsetX = randBetween(-Math.floor(rect.width / 8), Math.floor(rect.width / 8));
            const offsetY = randBetween(-Math.floor(rect.height / 8), Math.floor(rect.height / 8));
            const cx = Math.max(0, Math.round(rect.left + rect.width / 2 + offsetX));
            const cy = Math.max(0, Math.round(rect.top + rect.height / 2 + offsetY));

            if (!isTurbo) {
                const startX = lastMousePos.x || randBetween(50, 300);
                const startY = lastMousePos.y || randBetween(50, 300);
                const dx = cx - startX;
                const dy = cy - startY;
                const distance = Math.hypot(dx, dy);

                if (distance > 30) {
                    const ctrlX1 = startX + dx * 0.25 + randBetween(-40, 40);
                    const ctrlY1 = startY + dy * 0.25 + randBetween(-40, 40);
                    const ctrlX2 = startX + dx * 0.75 + randBetween(-40, 40);
                    const ctrlY2 = startY + dy * 0.75 + randBetween(-40, 40);

                    const steps = Math.max(5, Math.min(20, Math.floor(distance / 50)));

                    for (let i = 0; i <= steps; i++) {
                        if (!isRunCurrent(runId)) return false;
                        const t = i / steps;
                        const mt = 1 - t;
                        const w0 = mt * mt * mt;
                        const w1 = 3 * mt * mt * t;
                        const w2 = 3 * mt * t * t;
                        const w3 = t * t * t;

                        let px = w0 * startX + w1 * ctrlX1 + w2 * ctrlX2 + w3 * cx;
                        let py = w0 * startY + w1 * ctrlY1 + w2 * ctrlY2 + w3 * cy;

                        if (i > 0 && i < steps) {
                            px += randBetween(-1, 1);
                            py += randBetween(-1, 1);
                        }

                        px = Math.round(px);
                        py = Math.round(py);

                        const moveOpts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: px, clientY: py };
                        const PointerCtor = window.PointerEvent || MouseEvent;
                        try { el.dispatchEvent(new PointerCtor('pointermove', moveOpts)); } catch (e) {}
                        try { el.dispatchEvent(new MouseEvent('mousemove', moveOpts)); } catch (e) {}

                        lastMousePos.x = px;
                        lastMousePos.y = py;

                        const delay = randBetween(6, 12) + (t > 0.85 ? randBetween(5, 10) : 0);
                        await wait(delay);
                        if (!isRunCurrent(runId)) return false;
                    }
                }
            }

            if (!isRunCurrent(runId)) return false;

            const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: 1 };
            const PointerCtor = window.PointerEvent || MouseEvent;
            const fire = (Ctor, type, opts) => { try { el.dispatchEvent(new Ctor(type, opts)); } catch (e) { /* ignore */ }; };

            if (!isRunCurrent(runId)) return false;
            fire(PointerCtor, 'pointerover', base);
            fire(MouseEvent, 'mouseover', base);
            fire(PointerCtor, 'pointerdown', base);
            fire(MouseEvent, 'mousedown', base);
            try { el.focus && el.focus(); } catch (e) { /* ignore */ }

            await wait(isTurbo ? randBetween(15, 30) : randBetween(60, 140));
            if (!isRunCurrent(runId)) return false;

            fire(PointerCtor, 'pointerup', { ...base, buttons: 0 });
            fire(MouseEvent, 'mouseup', { ...base, buttons: 0 });

            if (!guardOwnedCommit(runId)) return false;

            // Строгая single-action семантика: вызываем el.click() ровно один раз
            let clicked = false;
            try {
                if (typeof el.click === 'function') {
                    el.click();
                    clicked = true;
                }
            } catch (e) { /* ignore */ }

            if (!clicked) {
                if (!isRunCurrent(runId)) return false;
                fire(MouseEvent, 'click', { ...base, buttons: 0 });
            }

            lastMousePos.x = cx;
            lastMousePos.y = cy;
        } catch (e) { /* ignore */ }

        return isRunCurrent(runId);
    }

    // Обычный клик с защитой от исключений.
    function safeClick(el) {
        if (!el) return false;
        try { el.click(); return true; } catch (e) { return false; }
    }

    // ─────────────────────────────────────────────────────────────
    //  8. РАСПОЗНАВАНИЕ СТРАНИЦ И ВАКАНСИЙ
    // ─────────────────────────────────────────────────────────────

    const Page = {
        isVacancy: () => location.pathname.startsWith('/vacancy/'),
        isResponseForm: () => location.pathname.startsWith('/applicant/vacancy_response'),
        isSearchList: () => location.pathname.startsWith('/search/vacancy'),
        isSearch: () => location.href.includes('/search/vacancy') || location.pathname.startsWith('/search')
    };

    // Попытки извлечь ID вакансии из URL в разных форматах
    function getVacancyIDFromHref(href) {
        if (!href) return null;
        const m1 = href.match(/\/vacancy\/(\d+)/);
        if (m1) return String(m1[1]);
        const m2 = href.match(/[?&]vacancyId=(\d+)/);
        if (m2) return String(m2[1]);
        const m3 = href.match(/vacancyId%3D(\d+)/);
        if (m3) return String(m3[1]);
        return null;
    }

    // Получение уникального ID вакансии для отслеживания - сначала по ссылке, затем по хешу
    function getVacancyID(node) {
        try {
            const card = getVacancyCard(node);
            const link = card ? query('vacancyLink', card) : null;
            const href = (link && link.href) || (node && node.href) || (node && node.getAttribute && node.getAttribute('href')) || '';
            const id = getVacancyIDFromHref(href);
            if (id) return 'v_' + id;
            let text = '';
            if (card && card.innerText) text = card.innerText.slice(0, 300);
            if (!text && href) text = href;
            if (!text) text = (document.title || '') + '|' + (card ? card.dataset?.id || '' : '');
            return 'h_' + fnv1a32(text).toString(36);
        } catch (e) {
            return 'h_' + Date.now().toString(36);
        }
    }

    // Единый способ получить стабильный ID вакансии на странице
    function getStableVacancyId(btn) {
        const direct = getVacancyIDFromHref(location.href);
        if (direct) return 'v_' + direct;
        const last = State.getLastAttemptID();
        if (last) return last;
        return getVacancyID(btn || document.body);
    }

    // /applicant/vacancy_response - это НЕ всегда тест. Настоящая анкета содержит поля вопросов
    // работодателя (task_*). Если их нет - это обычная форма отклика, которую можно отправить.
    function pageLooksLikeTest() {
        if (q('textarea[name^="task_"], input[name^="task_"], select[name^="task_"], [data-qa^="task_"], [data-qa^="task-"]')) return true;
        if (/[?&]startedWithQuestion=true/i.test(location.search)) return true;
        return false;
    }

    function getResponseDetectionScope() {
        const scopeSelector = '[data-qa="modal-content-scroll-container"], [data-qa="modal-content"], [role="dialog"], form[action*="vacancy_response"], form[id^="cover-letter-"], [data-qa*="modal" i], [class*="modal" i]';
        return qa(scopeSelector).find(el => !isAutoResponderUI(el) && isVisible(el)) || null;
    }

    function hasReliableRejectWarning() {
        if (isVisible(queryExact('rejectWarning'))) return true;
        const scope = getResponseDetectionScope();
        return !!(scope && queryHeuristic('rejectWarning', scope));
    }

    function hasResponseTextConfirmation(root) {
        try {
            const nodes = (root || document).querySelectorAll('h1,h2,h3,p,div,span');
            for (const el of nodes) {
                const t = el.childElementCount === 0 ? collapseSpaces(el.textContent || '') : '';
                if (t && t.length <= 240 && /(?:резюме доставлено|resume delivered|application sent|response sent)/i.test(t) && isVisible(el)) return true;
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    function hasExactResponseConfirmation(root) {
        const chat = queryExact('responseChat', root);
        if (chat && isVisible(chat)) return true;
        const success = q('[data-qa="vacancy-response-success"], .vacancy-response-success', root);
        return !!(success && !isAutoResponderUI(success) && isVisible(success));
    }

    // Признак успешно отправленного отклика: появилась ссылка на чат или текст "резюме доставлено".
    function isResponseConfirmed({ allowDocumentStrongText = false } = {}) {
        if (hasExactResponseConfirmation(document)) return true;

        const scope = getResponseDetectionScope();
        if (scope) {
            const scopedChat = queryHeuristic('responseChat', scope);
            if (scopedChat && isVisible(scopedChat)) return true;
            if (hasResponseTextConfirmation(scope)) return true;
        }

        // Document-wide strong text допустим только в post-submit confirmation phase.
        // Initial response detection никогда не передаёт этот флаг.
        if (allowDocumentStrongText && hasResponseTextConfirmation(document)) return true;
        return false;
    }

    // На эту вакансию уже откликались ранее (не ошибка - ничего делать не нужно, просто пропускаем).
    // hh.ru показывает уведомление об ошибке или ссылку на чат по существующему отклику.
    function detectAlreadyApplied() {
        const errs = qa('[data-qa="vacancy-response-error-notification"], [data-qa*="response-error"]');
        for (const n of errs) {
            if (isVisible(n)) {
                const t = (n.textContent || '').toLowerCase();
                if (/already applied|уже отклик|отклик уже|response already/.test(t)) return true;
            }
        }
        const exactChat = queryExact('responseChat');
        if (exactChat && isVisible(exactChat)) return true;
        const scope = getResponseDetectionScope();
        const scopedChat = scope ? queryHeuristic('responseChat', scope) : null;
        return !!(scopedChat && isVisible(scopedChat));
    }

    // Причина, по которой отклик в модалке не проходит (определяется со стороны hh.ru, не баг скрипта):
    //  - 'reject-warning'  - Скорее всего, будет отказ (вакансия требует больше, чем есть в резюме);
    //  - 'resume-hidden'   - нужно изменить видимость резюме, иначе отклик заблокирован;
    //  - ''                - причина не распознана.
    function detectModalBlockReason() {
        if (hasReliableRejectWarning()) return 'reject-warning';
        const c = q('[data-qa="modal-content-scroll-container"], [data-qa="modal-content"]');
        if (c && isVisible(c)) {
            const t = (c.textContent || '').toLowerCase();
            if (/visibilit|видимост/.test(t)) return 'resume-hidden';
        }
        return '';
    }

    // Приводим любое сырое имя вакансии к читаемому виду: снимаем счётчик непрочитанных
    // из заголовка вкладки, разбираем SEO-обёртку hh.ru и служебные хвосты сайта.
    // Используется и при парсинге со страницы, и при рендере уже сохранённых записей.
    function prettifyTitle(raw) {
        let t = collapseSpaces(raw);
        if (!t) return '';
        // 1. Счётчик непрочитанных из вкладки: "(99+)", "(5)", "99+ · ", "12 • "
        t = t.replace(/^\(\s*\d+\+?\s*\)\s*/, '');
        t = t.replace(/^\d+\+?\s*[\u00b7\u2022\u2024\u2027\u30fb|]\s*/g, '');
        // 2. Английская SEO-обёртка hh.ru: "Vacancy {X} in {city}, job in {company}"
        //    Граница между должностью и городом: последнее " in " перед ", job in "
        let m = t.match(/^Vacancy\s+(.+),\s*job\s+in\s+(.+?)\s*$/i);
        if (m) {
            let titlePart = m[1];
            // Убираем " in {city}" с конца titlePart (последнее вхождение)
            const lastIn = titlePart.lastIndexOf(' in ');
            if (lastIn > 0) titlePart = titlePart.substring(0, lastIn);
            const pos = collapseSpaces(titlePart);
            const comp = collapseSpaces(m[2]).replace(/\s*[\u2014\u2013|-]\s*hh\.ru.*$/i, '');
            return [pos, comp].filter(Boolean).join(' \u00b7 ').slice(0, 300);
        }
        // 3. Английская SEO-обёртка без компании: "Vacancy {X} in {city}"
        m = t.match(/^Vacancy\s+(.+?)\s+in\s+[^,]+?\s*$/i);
        if (m) {
            // Аналогично: последнее " in " - это город, всё до него - должность
            let titlePart = m[1];
            const lastIn = titlePart.lastIndexOf(' in ');
            if (lastIn > 0) titlePart = titlePart.substring(0, lastIn);
            return collapseSpaces(titlePart).slice(0, 300);
        }
        // 4. Русский SEO-хвост: "... - работа в ...", "... - вакансия ...".
        t = t.replace(/\s*[\u2014\u2013-]\s*(работа|вакансия)(?![а-яё]).*$/i, '');
        // 5. Общий хвост сайта: "- hh.ru", "на hh.ru"
        t = t.replace(/\s*(?:[\u2014\u2013|-]\s*)?(?:на\s+)?hh\.ru\s*$/i, '');
        // 6. Ведущее "Вакансия "/"Vacancy "
        t = t.replace(/^(вакансия|vacancy)\s+/i, '');
        return t.replace(/[\u00b7\u2022|,\s]+$/, '').trim().slice(0, 300);
    }

    // Структурированные данные вакансии (JSON-LD JobPosting) - самый надёжный источник имени:
    // hh.ru отдаёт их даже на страницах-редиректах (тест/анкета), где DOM вакансии уже недоступен.
    function readJsonLdTitle() {
        try {
            for (const s of qa('script[type="application/ld+json"]')) {
                let data;
                try { data = JSON.parse(s.textContent); } catch (e) { continue; }
                const nodes = Array.isArray(data) ? data : [data];
                for (const node of nodes) {
                    if (!node || typeof node !== 'object') continue;
                    const type = node['@type'];
                    const isJob = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
                    if (!isJob) continue;
                    const pos = collapseSpaces(node.title || node.name || '');
                    const org = node.hiringOrganization;
                    const comp = collapseSpaces((org && (org.name || org)) || '');
                    const parts = [pos, comp].filter(Boolean);
                    if (parts.length) return parts.join(' · ').slice(0, 300);
                }
            }
        } catch (e) { /* ignore */ }
        return '';
    }

    // Open Graph заголовок - второй по надёжности источник, доступен на большинстве страниц hh.ru.
    function readOgTitle() {
        const og = q('meta[property="og:title"], meta[name="og:title"]');
        return og ? prettifyTitle(og.getAttribute('content')) : '';
    }

    // Собираем человекочитаемое имя вакансии Должность · Город · Работодатель.
    // Приоритет: структурированный DOM страницы → JSON-LD → Open Graph → очищенный document.title.
    function parseVacancyTitle() {
        try {
            const pick = (sel) => {
                const n = q(sel);
                return n ? collapseSpaces(n.textContent) : '';
            };
            const position = pick('[data-qa="vacancy-title"]')
                || pick('h1[data-qa="vacancy-title"]')
                || pick('h1.vacancy-title');
            if (position) {
                const employer = pick('[data-qa="vacancy-company-name"]')
                    || pick('[data-qa="bloko-header-2"] a')
                    || pick('.vacancy-company-name');
                let city = pick('[data-qa="vacancy-view-location"]');
                if (!city) {
                    const addr = pick('[data-qa="vacancy-view-raw-address"]');
                    if (addr) city = addr.split(',')[0].trim();
                }
                const parts = [position, city, employer].filter(Boolean);
                if (parts.length) return parts.join(' \u00b7 ').slice(0, 300);
            }
        } catch (e) { /* ignore */ }
        return readJsonLdTitle() || readOgTitle() || cleanDocTitle();
    }

    // Извлекаем чистое название вакансии из карточки поисковой выдачи (serp).
    // data-qa="serp-item__title-text" - самый внутренний span, содержащий ONLY название должности
    // без бейджей 99+, локаций и прочего мусора. Если не нашли - фоллбек на старый селектор.
    function readSerpCardTitle(linkEl) {
        if (!linkEl) return '';
        try {
            // Новая вёрстка: внутри ссылки есть span[data-qa="serp-item__title-text"]
            const titleSpan = linkEl.querySelector('[data-qa="serp-item__title-text"]');
            if (titleSpan) {
                const t = collapseSpaces(titleSpan.textContent);
                if (t) return t;
            }
            // Легаси: пробуем общий селектор заголовка
            const titleEl = linkEl.querySelector('[data-qa="serp-item__title-text"], .serp-item__title');
            if (titleEl) {
                const t = collapseSpaces(titleEl.textContent);
                if (t) return t;
            }
            // Крайний случай: очищаем весь textContent ссылки через prettifyTitle
            return prettifyTitle(linkEl.textContent);
        } catch (e) {
            return prettifyTitle(linkEl.textContent || '');
        }
    }

    // Чистим document.title от служебных хвостов hh.ru - на крайний случай, когда DOM недоступен.
    function cleanDocTitle() {
        return prettifyTitle(document.title);
    }

    // Возвращаем лучшее доступное имя вакансии для записи в ручной список:
    // приоритет - заранее сохранённая мета со страницы вакансии, затем парсинг текущей страницы.
    function resolveManualTitle(vid) {
        const meta = State.getLastVacancyMeta();
        if (meta && meta.title) {
            const rawVid = String(vid || '');
            const rawMetaVid = String(meta.vid || '');
            const numVid = rawVid.replace(/^v_/, '');
            const numMeta = rawMetaVid.replace(/^v_/, '');
            const isNumVid = /^\d+$/.test(numVid);
            const isNumMeta = /^\d+$/.test(numMeta);

            if (rawVid && rawMetaVid && rawVid === rawMetaVid) {
                return meta.title;
            } else if (isNumVid && isNumMeta) {
                if (numVid === numMeta) return meta.title;
                // Разные числовые ID — мета принадлежит другой вакансии, не используем
            } else if (Date.now() - (Number(meta.ts) || 0) < 15 * 60 * 1000) {
                // Если один из ID не числовой (например, hash карточки), а мета свежая — разрешаем fallback
                return meta.title;
            }
        }
        if (Page.isVacancy()) {
            const t = parseVacancyTitle();
            if (t) return t;
        }
        // Страница-редирект (анкета/форма отклика): DOM вакансии недоступен, но hh.ru
        // отдаёт JSON-LD JobPosting и og:title почти везде - берём имя из них, чтобы
        // запись в ручном списке не оставалась безымянной при прямом попадании сюда.
        return readJsonLdTitle() || readOgTitle() || '';
    }

    // Сохраняем текущую вакансию в список для ручного отклика, чтобы заблокированные/неподтверждённые
    // отклики не терялись - пользователь сможет обработать их вручную.
    // Возвращает true, если вакансия гарантированно сохранена (или уже есть) в ручном списке.
    function saveCurrentForManual(vid, note, runId) {
        if (runId && !guardOwnedCommit(runId)) return false;
        try {
            const res = State.addManualEntry({
                vid: vid,
                url: location.href,
                returnUrl: State.getReturnUrl() || '',
                ts: Date.now(),
                title: resolveManualTitle(vid)
            });
            if (res === 'ADDED') {
                Stats.bump('manual');
                log(I18n.t('logs.manualSaved', { note: note ? ' (' + note + ')' : '', vid }));
                try { window._hhApplyAssistantRenderManualQueue?.(); } catch (e) { /* ignore */ }
                return true;
            } else if (res === 'EXISTS' || res === 'UPDATED') {
                log(I18n.t('logs.manualAlready', { note: note ? ' (' + note + ')' : '', vid }));
                try { window._hhApplyAssistantRenderManualQueue?.(); } catch (e) { /* ignore */ }
                return true;
            } else {
                log(I18n.t('logs.manualSaveFailed', { note: note ? ' [' + note + ']' : '', vid }), true);
                return false;
            }
        } catch (e) {
            console.warn('[HH Apply Assistant] saveCurrentForManual error', e);
            log(I18n.t('logs.manualSaveFailed', { note: '', vid }), true);
            return false;
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  9. СТАТУС В ПАНЕЛИ
    // ─────────────────────────────────────────────────────────────

    const STATUS_KEYS = ['idle', 'running', 'stopped', 'error', 'done'];

    let currentStatusState = {
        statusKey: 'idle',
        customKeyOrText: null,
        params: null
    };

    function syncCollapsedToggleState(toggle = document.getElementById('ar-toggle-btn')) {
        if (!toggle) return;
        const running = State.amIRunning();
        const title = I18n.t(running ? 'panel.expandRunningTitle' : 'panel.expandTitle');
        toggle.classList.toggle('is-running', running);
        toggle.setAttribute('data-status', running ? 'running' : currentStatusState.statusKey);
        toggle.title = title;
        toggle.setAttribute('aria-label', title);
    }

    function setStatus(statusKey, customKeyOrText, params) {
        const key = STATUS_KEYS.includes(statusKey) ? statusKey : 'idle';
        currentStatusState = { statusKey: key, customKeyOrText, params };

        const el = document.getElementById('ar-status-text');
        if (!el) return;
        const isTurbo = config?.preset === 'turbo';

        let text;
        if (customKeyOrText) {
            if (typeof customKeyOrText === 'string' && (customKeyOrText.startsWith('status.') || I18n.t(customKeyOrText) !== customKeyOrText)) {
                text = I18n.t(customKeyOrText, params);
            } else {
                text = String(customKeyOrText);
            }
        } else if (key === 'running' && isTurbo) {
            text = I18n.t('status.runningTurbo');
        } else {
            text = I18n.t(`status.${key}`);
        }

        el.textContent = text;
        el.title = text;
        el.className = 'ar-status ar-status--' + key;

        const running = key === 'running';
        const startBtn = document.getElementById('ar-start-btn');
        const stopBtn = document.getElementById('ar-stop-btn');
        if (startBtn) {
            startBtn.style.display = running ? 'none' : 'inline-flex';
            startBtn.disabled = running;
        }
        if (stopBtn) {
            stopBtn.style.display = running ? 'inline-flex' : 'none';
            stopBtn.disabled = !running;
        }

        const executionCore = document.getElementById('ar-mode-card');
        if (executionCore) {
            executionCore.classList.toggle('is-running', running);
            executionCore.setAttribute('data-runtime-state', key);
            executionCore.setAttribute('aria-busy', running ? 'true' : 'false');
        }

        const toggle = document.getElementById('ar-toggle-btn');
        if (toggle) {
            syncCollapsedToggleState(toggle);
        }
    }

    function restoreStatusAfterMount() {
        if (State.amIRunning()) {
            setStatus('running');
        } else if (currentStatusState.statusKey === 'running') {
            setStatus('idle');
        } else {
            setStatus(currentStatusState.statusKey, currentStatusState.customKeyOrText, currentStatusState.params);
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  10. ЛОГИКА ОТКЛИКА
    // ─────────────────────────────────────────────────────────────

    const EXECUTION_STATUS = Object.freeze({
        SUCCESS: 'SUCCESS',
        SKIPPED: 'SKIPPED',
        NAVIGATED: 'NAVIGATED',
        STOPPED: 'STOPPED',
        CAPTCHA: 'CAPTCHA'
    });

    const EXECUTION_REASON = Object.freeze({
        APPLIED: 'APPLIED',
        RETURNING_TO_LIST: 'RETURNING_TO_LIST',
        VACANCY_PAGE: 'VACANCY_PAGE',
        RESPONSE_PAGE: 'RESPONSE_PAGE',
        NO_LINK: 'NO_LINK',
        NO_HREF: 'NO_HREF',
        UNKNOWN: 'UNKNOWN',
        UNRECOGNIZED_CODE: 'UNRECOGNIZED_CODE'
    });

    const ExecutionResult = {
        fromTerminalCode(code) {
            const terminalCode = String(code || 'ERROR_UNKNOWN');
            switch (terminalCode) {
                case 'OK':
                    return { status: EXECUTION_STATUS.SUCCESS, reason: EXECUTION_REASON.APPLIED, code: terminalCode };
                case 'RETURNED':
                    return { status: EXECUTION_STATUS.SUCCESS, reason: EXECUTION_REASON.RETURNING_TO_LIST, code: terminalCode };
                case 'NAVIGATED':
                    return { status: EXECUTION_STATUS.NAVIGATED, reason: EXECUTION_REASON.VACANCY_PAGE, code: terminalCode };
                case 'REDIRECT':
                    return { status: EXECUTION_STATUS.NAVIGATED, reason: EXECUTION_REASON.RESPONSE_PAGE, code: terminalCode };
                case 'STOPPED':
                    return { status: EXECUTION_STATUS.STOPPED, reason: EXECUTION_REASON.UNKNOWN, code: terminalCode };
                case 'CAPTCHA':
                    return { status: EXECUTION_STATUS.CAPTCHA, reason: EXECUTION_REASON.UNKNOWN, code: terminalCode };
                case 'ERROR_NO_LINK':
                    return { status: EXECUTION_STATUS.SKIPPED, reason: EXECUTION_REASON.NO_LINK, code: terminalCode };
                case 'ERROR_NO_HREF':
                    return { status: EXECUTION_STATUS.SKIPPED, reason: EXECUTION_REASON.NO_HREF, code: terminalCode };
                case 'ERROR_UNKNOWN':
                    return { status: EXECUTION_STATUS.SKIPPED, reason: EXECUTION_REASON.UNKNOWN, code: terminalCode };
                default:
                    return { status: EXECUTION_STATUS.SKIPPED, reason: EXECUTION_REASON.UNRECOGNIZED_CODE, code: terminalCode };
            }
        }
    };

    // Человеческий скролл: вниз до секции Подходящие вакансии в этой компании
    // (или до 60% страницы), пауза, и возврат вверх.
    async function simulateReading(viewTime, runId = currentRunId) {
        if (!viewTime || viewTime <= 0) return;
        try {
            await actionPause();
            if (!isRunCurrent(runId)) return;

            const stepMs = Math.max(100, TUNING.scrollStepMs);
            const docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
            const winH = window.innerHeight || document.documentElement.clientHeight;
            const maxY = Math.max(0, docHeight - winH);

            const needleRx = /(?:подходящие вакансии в этой компании|similar vacancies|vacancies at this company)/i;
            let sectionEl = null;
            // Чаще всего секция обозначена заголовком: дешёвый semantic path до широкого scan.
            for (const el of qa('h1,h2,h3,h4')) {
                try {
                    if (el.innerText && needleRx.test(el.innerText.trim())) {
                        sectionEl = el;
                        break;
                    }
                } catch (e) { continue; }
            }
            // Старый широкий поиск сохраняем как compatibility fallback.
            if (!sectionEl) {
                for (const el of qa('h1,h2,h3,h4,div,section')) {
                    try {
                        if (el.innerText && needleRx.test(el.innerText.trim())) {
                            sectionEl = el;
                            break;
                        }
                    } catch (e) { continue; }
                }
            }

            let targetY;
            if (sectionEl) {
                const rect = sectionEl.getBoundingClientRect();
                targetY = clamp(Math.round(rect.top + window.pageYOffset - 100), 0, maxY);
                log(I18n.t('logs.readingFound'));
            } else {
                targetY = Math.round(maxY * 0.6);
                log(I18n.t('logs.readingFallback'));
            }

            const totalSteps = Math.max(6, Math.floor((viewTime / stepMs) / 2));
            const startY = window.pageYOffset || 0;

            for (let i = 1; i <= totalSteps; i++) {
                if (!isRunCurrent(runId)) return;
                const frac = i / totalSteps;
                window.scrollTo({ top: Math.round(startY + (targetY - startY) * frac), behavior: 'auto' });
                await wait(stepMs + randBetween(-Math.floor(stepMs / 3), Math.floor(stepMs / 3)));
                if (!isRunCurrent(runId)) return;
                await actionPause();
                if (!isRunCurrent(runId)) return;
            }

            await wait(randBetween(800, 1600));
            if (!isRunCurrent(runId)) return;
            await actionPause();
            if (!isRunCurrent(runId)) return;

            const upSteps = Math.max(4, Math.floor(totalSteps / 2));
            for (let i = upSteps; i >= 0; i--) {
                if (!isRunCurrent(runId)) return;
                const frac = i / upSteps;
                window.scrollTo({ top: Math.round(startY + (targetY - startY) * frac), behavior: 'auto' });
                await wait(stepMs + randBetween(-Math.floor(stepMs / 4), Math.floor(stepMs / 4)));
                if (!isRunCurrent(runId)) return;
                await actionPause();
                if (!isRunCurrent(runId)) return;
            }

            if (!isRunCurrent(runId)) return;
            window.scrollTo({ top: 0, behavior: 'auto' });
            await wait(200 + randBetween(0, 500));
            if (!isRunCurrent(runId)) return;
            await actionPause();
        } catch (e) {
            console.warn('[HH Apply Assistant] simulateReading error', e);
        }
    }

    function detectResponseOutcomeInRoot(root, includeExactSelectors) {
        if (includeExactSelectors) {
            if (isVisible(queryExact('relocationBtn', root))) return 'RELOCATION';
            // Сценарий Б проверяется РАНЬШЕ сценария А: внутри ещё не отправленной модалки
            // есть кнопка прикрепить сопроводительное, которую нельзя считать успехом.
            if (isVisible(queryExact('letterSubmit', root))) return 'SCENARIO_B';
            if (isVisible(queryExact('attachCoverBtn', root))) return 'SCENARIO_A';
            if (hasExactResponseConfirmation(root)) return 'SCENARIO_C';
        }

        // Compatibility fallback: те же эвристики, но сначала только в активной форме/модалке.
        if (queryHeuristic('relocationBtn', root)) return 'RELOCATION';
        if (queryHeuristic('letterSubmit', root)) return 'SCENARIO_B';
        if (queryHeuristic('attachCoverBtn', root)) return 'SCENARIO_A';
        if (queryHeuristic('responseChat', root) || hasResponseTextConfirmation(root)) return 'SCENARIO_C';
        return false;
    }

    function detectResponseOutcomeOnce(runId = currentRunId, includeCompatibilityFallback = true) {
        if (!isRunCurrent(runId)) return 'STOPPED';
        // Капча/анти-бот появилась прямо в ответ на клик - ловим сразу (не дожидаясь
        // тика watchdog), пока оверлей ещё на экране и до навигации назад к списку.
        if (detectCaptcha()) return 'CAPTCHA';
        // HH перебросил на страницу тестов/вопросов.
        if (Page.isResponseForm()) return 'QUESTIONS';

        // Fast path: известные data-qa/селекторы без широкого сканирования DOM.
        if (isVisible(queryExact('relocationBtn'))) return 'RELOCATION';
        if (isVisible(queryExact('letterSubmit'))) return 'SCENARIO_B';
        if (isVisible(queryExact('attachCoverBtn'))) return 'SCENARIO_A';
        if (hasExactResponseConfirmation(document)) return 'SCENARIO_C';

        if (!includeCompatibilityFallback) return false;

        // Compatibility fallback разрешён только внутри response-specific формы/модалки.
        // Слабый document-wide текст больше не может самостоятельно завершить отклик.
        const scope = getResponseDetectionScope();
        if (!scope) return false;
        return detectResponseOutcomeInRoot(scope, true);
    }

    // Динамически определяем, что произошло после клика "Откликнуться".
    // Возвращает: 'STOPPED' | 'QUESTIONS' | 'RELOCATION' | 'SCENARIO_A' | 'SCENARIO_B' | 'SCENARIO_C' | 'TIMEOUT'
    async function resolveResponseOutcome(timeout, runId = currentRunId) {
        let lastFallbackAt = -Infinity;
        const outcome = await waitForCondition(() => {
            const now = Date.now();
            const includeFallback = now - lastFallbackAt >= 750;
            if (includeFallback) lastFallbackAt = now;
            return detectResponseOutcomeOnce(runId, includeFallback);
        }, timeout);
        if (!isRunCurrent(runId)) return 'STOPPED';
        return outcome || 'TIMEOUT';
    }

    // Определяем сценарий, по пути подтверждая окна Готовность к переезду (до 3 раз).
    async function resolveWithRelocation(timeout, runId = currentRunId) {
        let outcome = await resolveResponseOutcome(timeout, runId);
        let guard = 0;
        while (outcome === 'RELOCATION' && guard < 3) {
            if (!isRunCurrent(runId)) return 'STOPPED';
            guard++;
            Metrics.bump('scenario.relocation');
            log(I18n.t('logs.relocationConfirm'));
            const reloc = query('relocationBtn');
            if (reloc) {
                await actionPause();
                if (!isRunCurrent(runId)) return 'STOPPED';
                if (!guardOwnedCommit(runId)) return 'STOPPED';
                safeClick(reloc);
            }
            await actionPause();
            if (!isRunCurrent(runId)) return 'STOPPED';
            outcome = await resolveResponseOutcome(timeout, runId);
        }
        return outcome;
    }

    // Заполнить сопроводительное письмо (если нужно) и отправить форму отклика.
    // withCover=true - вписываем текст письма; false - просто отправляем отклик без письма.
    // Возвращает true, если удалось инициировать отправку.
    async function fillLetterAndSubmit({ withCover = true, runId = currentRunId } = {}) {
        if (!isRunCurrent(runId)) return false;
        if (withCover) {
            // Поле письма может быть скрыто за кнопкой "прикрепить сопроводительное" - раскроем.
            let area = query('letterTextarea');
            if (!area) {
                const attach = query('attachCoverInModal');
                if (isVisible(attach)) {
                    await actionPause();
                    if (!isRunCurrent(runId)) return false;
                    safeClick(attach);
                    await actionPause();
                }
                if (!isRunCurrent(runId)) return false;
                area = query('letterTextarea') || await waitForElement('letterTextarea', 3000);
            }
            if (!isRunCurrent(runId)) return false;
            if (area) {
                recordSelectorVariant('textarea', 'textarea[name="text"]', 'textarea[data-qa="vacancy-response-popup-form-letter-input"]');
                fillTextarea(area, config.coverText);
                await actionPause();
            } else {
                log(I18n.t('logs.letterMissing'), true);
            }
        }
        if (!isRunCurrent(runId)) return false;
        await wait(config?.preset === 'turbo' ? randBetween(60, 120) : randBetween(400, 900));
        if (!isRunCurrent(runId)) return false;

        let submitButton = query('letterSubmit') || await waitForElement('letterSubmit', 3000);
        if (submitButton) recordSelectorVariant('submit', '[data-qa="vacancy-response-letter-submit"]', '[data-qa="vacancy-response-submit-popup"]');
        if (!submitButton) {
            // Фоллбек: ищем форму отклика и её кнопку submit
            const form = q('form[action*="vacancy_response"], form[id^="cover-letter-"]');
            if (form) {
                submitButton = q('button[type="submit"], input[type="submit"]', form);
                if (!submitButton) {
                    if (!guardOwnedCommit(runId)) return false;
                    try { form.submit(); log(I18n.t('logs.formSubmitFallback')); return true; }
                    catch (e) { console.warn('[HH Apply Assistant] form.submit fallback failed', e); }
                }
            }
        }
        if (!isRunCurrent(runId)) return false;
        if (!submitButton) { log(I18n.t('logs.submitBtnMissing'), true); return false; }

        await actionPause();
        if (!isRunCurrent(runId)) return false;
        const clicked = await realisticClick(submitButton, runId);
        return clicked && isRunCurrent(runId);
    }

    // Дожать отправку в модалке с предупреждением Скорее всего, будет отказ: одиночный клик
    // такую отправку не завершает, поэтому несколько раз повторно кликаем по кнопке отправки,
    // между попытками проверяя подтверждение / закрытие модалки / переход на вопросы.
    // Возвращает 'OK' | 'REDIRECT' | 'STOPPED' | 'FAIL'.
    // opts.onResponsePage=true - форма отклика на отдельной странице /applicant/vacancy_response
    // (тогда нахождение на этой странице НЕ считается редиректом на тест).
    async function forceSubmitReject(maxAttempts = TUNING.forceSubmitAttempts, opts = {}) {
        const onPage = !!opts.onResponsePage;
        const runId = opts.runId || currentRunId;
        const allowDocumentStrongText = !!opts.allowDocumentStrongText;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (!isRunCurrent(runId)) return 'STOPPED';
            const submit = query('letterSubmit');
            if (isVisible(submit)) {
                await actionPause();
                if (!isRunCurrent(runId)) return 'STOPPED';
                const clicked = await realisticClick(submit, runId);
                if (!clicked || !isRunCurrent(runId)) return 'STOPPED';
            }
            const res = await waitForCondition(() => {
                if (!isRunCurrent(runId)) return 'STOPPED';
                // В модалке уход на /applicant/vacancy_response = редирект на тест; на самой странице отклика - нет.
                if (!onPage && Page.isResponseForm()) return 'QUESTIONS';
                if (isResponseConfirmed({ allowDocumentStrongText })) return 'CONFIRMED';
                return false;
            }, 3500);
            if (res === 'STOPPED' || !isRunCurrent(runId)) return 'STOPPED';
            if (res === 'QUESTIONS') return 'REDIRECT';
            if (res === 'CONFIRMED') return 'OK';
        }
        return 'FAIL';
    }

    // Ожидание подтверждения после отправки: 'QUESTIONS' | 'CONFIRMED' | 'STOPPED' | false.
    async function awaitSubmitConfirmation(timeout = TUNING.confirmWaitMs, runId = currentRunId, { allowDocumentStrongText = false } = {}) {
        return waitForCondition(() => {
            if (!isRunCurrent(runId)) return 'STOPPED';
            if (Page.isResponseForm()) return 'QUESTIONS';
            return isResponseConfirmed({ allowDocumentStrongText });
        }, timeout);
    }

    // Карточка выдачи могла вычислить для вакансии другой ID, чем страница вакансии
    // (например, hash от рекламной ссылки без vacancyId). Помечаем обработанным и его,
    // иначе та же карточка выбиралась бы из списка заново - бесконечно.
    function markAliasProcessed(vid) {
        const last = State.getLastAttemptID();
        if (last && last !== vid) return State.addProcessedID(last);
        return true;
    }

    function persistProcessedVacancy(vid, runId) {
        if (runId && !guardOwnedCommit(runId)) return false;
        if (!vid) return true;
        if (State.addProcessedID(vid) && markAliasProcessed(vid)) return true;
        haltForPersistenceFailure(vid, 'history');
        return false;
    }

    function persistSentCount(vid, runId) {
        if (runId && !guardOwnedCommit(runId)) return false;
        if (State.incSentCount() !== null) return true;
        haltForPersistenceFailure(vid, 'sentCount');
        return false;
    }

    // Подготовка к переходу на страницу отклика/тестов: отдаём управление watchdog'у.
    // ВАЖНО: REDIRECT !== PROCESSED. Вакансия не помечается processed, пока исход
    // не подтверждён (успешная отправка или гарантированное сохранение в Manual Queue).
    function markRedirect(vid) {
        if (vid && !State.getLastAttemptID() && !State.setLastAttemptID(vid)) {
            haltForPersistenceFailure(vid, 'lastAttempt');
            return 'STOPPED';
        }
        return 'REDIRECT';
    }

    // Возврат к списку вакансий после обработки одной вакансии.
    // Помечаем вакансию обработанной (чтобы не зациклиться) и уходим на сохранённый список.
    function returnToList(vid, { markProcessed = true, runId = currentRunId } = {}) {
        if (runId && !guardOwnedCommit(runId)) return false;
        if (markProcessed && vid && !persistProcessedVacancy(vid)) {
            return false;
        }
        if (!State.clearLastAttemptID()) {
            haltForPersistenceFailure(vid, 'lastAttempt');
            return false;
        }
        const returnUrl = State.getReturnUrl() || '/search/vacancy';
        if (returnUrl && returnUrl.includes('/search/vacancy')) {
            // Полная навигация на список - страница загрузится свежей, F5 не требуется.
            window.location.href = returnUrl;
        } else {
            // bfcache может показать устаревший список - форсим обновление после возврата.
            State.setF5Needed();
            try { history.back(); } catch (e) { window.location.href = '/search/vacancy'; }
            // Страховка: если возврат не сработал - форс-редирект на список.
            const timerRunId = runId || currentRunId;
            setTimeout(() => {
                if (isRunCurrent(timerRunId) && !Page.isSearchList() && guardOwnedCommit(timerRunId)) {
                    window.location.href = '/search/vacancy';
                }
            }, 1500);
        }
        return true;
    }

    // Классификация выполняется только после того, как fillLetterAndSubmit подтвердил
    // инициированный submit текущего run. Само исчезновение response route успехом не является.
    function detectPostSubmitPageOutcome(runId, { allowDocumentStrongText = false } = {}) {
        if (!isRunCurrent(runId)) return 'STOPPED';
        if (detectCaptcha()) return 'CAPTCHA';

        if (Page.isSearchList()) return 'TRUSTED_NAVIGATION';

        if (Page.isVacancy()) {
            return isResponseConfirmed({ allowDocumentStrongText }) ? 'CONFIRMED' : false;
        }

        if (!Page.isResponseForm()) return 'UNTRUSTED_NAVIGATION';
        if (pageLooksLikeTest()) return 'QUESTIONS';
        if (isResponseConfirmed({ allowDocumentStrongText })) return 'CONFIRMED';
        return false;
    }

    // Отправка отклика с полностраничной формы /applicant/vacancy_response (не тест).
    // Сюда попадают в т.ч. вакансии с предупреждением Скорее всего, будет отказ, отрисованные страницей.
    async function submitResponsePage(vid, backUrl, runId = currentRunId, trapToken = null) {
        if (!isRunCurrent(runId)) return;
        if (State.touchInstanceLock(TAB_ID) !== 'OWNED') {
            haltForLostInstanceLock();
            return;
        }
        handlingResponsePage = true;
        let savedForManual = false;
        let confirmed = false;
        const reject = hasReliableRejectWarning();
        if (reject) Metrics.bump('reject.seen.page');
        try {
            if (reject && !config.applyOnRejectWarning) {
                if (!isRunCurrent(runId)) return;
                log(I18n.t('logs.responsePageRejectSkip'), true);
                Metrics.bump('page.reject.skipped');
                savedForManual = saveCurrentForManual(vid, 'reject-warning', runId);
            } else {
                log(I18n.t('logs.responsePageFilling', { reject: reject ? I18n.t('logs.responsePageRejectNote') : '' }));
                captureResponseDom('response-page-form');
                const allowDocumentStrongText = !hasResponseTextConfirmation(document);
                const submitted = await fillLetterAndSubmit({ withCover: config.useCover, runId });
                if (!isRunCurrent(runId)) return;
                if (!submitted) {
                    Metrics.bump('page.response.fail');
                    captureResponseDom('response-page-no-submit');
                    savedForManual = saveCurrentForManual(vid, reject ? 'reject-warning' : 'page-no-submit', runId);
                    log(I18n.t('logs.responsePageSubmitFail'), true);
                } else {
                    let redirectedToQuestions = false;

                    const confirmationTimeout = reject ? TUNING.confirmWaitMs : TUNING.responsePagePendingMs;
                    const ok = await waitForCondition(
                        () => detectPostSubmitPageOutcome(runId, { allowDocumentStrongText }),
                        confirmationTimeout
                    );

                    if (!isRunCurrent(runId)) return;
                    if (ok === 'CAPTCHA') {
                        haltForCaptcha();
                        return;
                    }
                    if (ok === 'CONFIRMED' || ok === 'TRUSTED_NAVIGATION') {
                        confirmed = true;
                    } else if (ok === 'QUESTIONS') {
                        redirectedToQuestions = true;
                    } else if (ok !== 'UNTRUSTED_NAVIGATION' && reject && config.applyOnRejectWarning && hasReliableRejectWarning() && isRunCurrent(runId)) {
                        // Повторный submit допустим только для всё ещё явно видимого reject-warning.
                        // Обычный full-page submit всегда остаётся single-click, даже при медленном ответе.
                        const forced = await forceSubmitReject(TUNING.forceSubmitAttempts, { onResponsePage: true, runId, allowDocumentStrongText });
                        if (forced === 'STOPPED' || !isRunCurrent(runId)) return;
                        if (forced === 'REDIRECT') {
                            redirectedToQuestions = true;
                        } else if (forced === 'OK') {
                            confirmed = true;
                        }
                    }

                    if (!isRunCurrent(runId)) return;

                    if (confirmed) {
                        Metrics.bump('page.response.ok' + (reject ? '.reject' : ''));
                        if (!persistSentCount(vid, runId)) return;
                        log(I18n.t('logs.responsePageSent'));
                    } else if (redirectedToQuestions) {
                        Metrics.bump('scenario.questions.responsePage');
                        savedForManual = saveCurrentForManual(vid, 'questions', runId);
                        log(I18n.t('logs.responsePageQuestions'), true);
                    } else {
                        Metrics.bump('page.response.fail');
                        captureResponseDom('response-page-no-confirm');
                        savedForManual = saveCurrentForManual(vid, reject ? 'reject-warning' : 'page-no-confirm', runId);
                        log(I18n.t('logs.responsePageNoConfirm'), true);
                    }
                }
            }
        } catch (e) {
            if (!isRunCurrent(runId)) return;
            console.warn('[HH Apply Assistant] submitResponsePage error', e);
            try { savedForManual = saveCurrentForManual(vid, 'page-error', runId); } catch (_) { /* ignore */ }
        } finally {
            if (runId === currentRunId) {
                handlingResponsePage = false;
            }
            State.clearTrapLock(trapToken);
        }
        if (!isRunCurrent(runId)) return;
        if (confirmed || savedForManual) {
            if (!persistProcessedVacancy(vid, runId)) return;
            if (!State.clearLastAttemptID()) {
                haltForPersistenceFailure(vid, 'lastAttempt');
                return;
            }
            State.setF5Needed();
            // Возврат к списку (если submit ещё не увёл нас туда сам).
            if (!Page.isSearchList()) {
                try { window.location.href = backUrl; } catch (e) { /* ignore */ }
            }
        } else {
            haltForPersistenceFailure(vid);
        }
    }

    // Открываем вакансию со списка: запоминаем lastAttempt, название и переходим по ссылке
    async function openVacancyFromList(vacancyLinkEl, runId = currentRunId) {
        if (!isRunCurrent(runId)) return 'STOPPED';
        const hrefRaw = vacancyLinkEl?.href || (vacancyLinkEl.getAttribute && vacancyLinkEl.getAttribute('href'));
        const href = toSafeHhUrl(hrefRaw);
        const vid = getVacancyID(vacancyLinkEl);

        // Пре-захват названия вакансии из карточки serp - до навигации,
        // пока DOM ещё доступен. На странице вакансии parseVacancyTitle() перезапишет более полным.
        try {
            const serpTitle = readSerpCardTitle(vacancyLinkEl);
            if (serpTitle && vid) State.setLastVacancyMeta(vid, serpTitle);
        } catch (e) { /* ignore */ }

        await actionPause();
        if (!isRunCurrent(runId)) return 'STOPPED';
        State.setReturnUrl();

        try { vacancyLinkEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* ignore */ }
        await actionPause();
        if (!isRunCurrent(runId)) return 'STOPPED';

        if (!href) {
            log(I18n.t('logs.noHref'), true);
            return 'ERROR_NO_HREF';
        }
        log(I18n.t('logs.openingVacancy', { vid }));
        await actionPause();
        if (!isRunCurrent(runId)) return 'STOPPED';
        if (!State.setLastAttemptID(vid)) {
            haltForPersistenceFailure(vid, 'lastAttempt');
            return 'STOPPED';
        }
        if (!guardOwnedCommit(runId)) return 'STOPPED';
        window.location.href = href;
        return 'NAVIGATED';
    }

    // Сохраняем URL списка для возврата, не затирая уже сохранённый корректный адрес.
    function ensureReturnUrl() {
        const saved = State.getReturnUrl();
        if (!saved || !saved.includes('/search/vacancy')) {
            const ref = (document.referrer && document.referrer.includes('/search/vacancy')) ? document.referrer : '';
            State.setReturnUrl(ref || saved || '/search/vacancy');
        }
    }

    // Кнопки Откликнуться на странице вакансии нет: разбираемся почему и возвращаемся.
    function handleMissingApplyButton(vid, runId = currentRunId) {
        if (!isRunCurrent(runId)) return 'STOPPED';
        // Если нас уже редиректнуло на страницу с вопросами - отдаём watchdog'у.
        if (Page.isResponseForm()) return markRedirect(vid);
        // Уже откликались ранее - просто пропускаем (не ошибка, в ручной не сохраняем).
        if (detectAlreadyApplied()) {
            Metrics.bump('scenario.alreadyApplied');
            Stats.bump('skipped');
            log(I18n.t('logs.alreadyApplied'));
            returnToList(vid, { markProcessed: true, runId });
            return 'RETURNED';
        }
        // Кнопки нет - помечаем обработанной и возвращаемся.
        Metrics.bump('scenario.noApply');
        Stats.bump('skipped');
        captureResponseDom('no-apply-button');
        log(I18n.t('logs.applyBtnMissingReturning'), true);
        returnToList(vid, { markProcessed: true, runId });
        return 'RETURNED';
    }

    // Сценарий А: резюме уже отправлено, письмо - по желанию.
    async function handleScenarioA(vid, runId = currentRunId) {
        if (!isRunCurrent(runId)) return 'STOPPED';
        log(I18n.t('logs.scenarioA'));
        if (config.useCover) {
            const attach = query('attachCoverBtn');
            if (attach) {
                await actionPause();
                if (!isRunCurrent(runId)) return 'STOPPED';
                safeClick(attach);
                await actionPause();
                if (!isRunCurrent(runId)) return 'STOPPED';
                const submitted = await fillLetterAndSubmit({ withCover: true, runId });
                if (!isRunCurrent(runId)) return 'STOPPED';
                if (submitted) await waitForCondition(() => {
                    if (!isRunCurrent(runId)) return 'STOPPED';
                    return isResponseConfirmed();
                }, 5000);
                if (!isRunCurrent(runId)) return 'STOPPED';
            }
        } else {
            log(I18n.t('logs.coverOff'));
        }
        if (!isRunCurrent(runId)) return 'STOPPED';
        if (!persistSentCount(vid, runId)) return 'STOPPED';
        log(I18n.t('logs.scenarioASent'));
        returnToList(vid, { markProcessed: true, runId });
        return 'OK';
    }

    // Сценарий Б: открылась модалка отклика с кнопкой отправки.
    // Поле письма может быть скрыто за кнопкой "прикрепить сопроводительное" -
    // fillLetterAndSubmit при необходимости раскроет его. Если письмо выключено -
    // просто отправляем отклик без сопроводительного.
    async function handleScenarioB(vid, runId = currentRunId) {
        if (!isRunCurrent(runId)) return 'STOPPED';
        // Зафиксируем, была ли плашка Скорее всего, будет отказ, чтобы понимать,
        // отправляются ли такие вакансии (успех считается ниже) или проваливаются.
        const rejectSeen = hasReliableRejectWarning();
        if (rejectSeen) Metrics.bump('reject.seen.modal');
        // Если откликаться при предупреждении об отказе выключено - не отправляем такие,
        // а откладываем в ручной список (иначе realisticClick отправил бы их с первого клика).
        if (rejectSeen && !config.applyOnRejectWarning) {
            Metrics.bump('reject.skipped.modal');
            log(I18n.t('logs.scenarioBRejectSkip'));
            const saved = saveCurrentForManual(vid, 'reject-warning', runId);
            if (!saved) {
                if (!isRunCurrent(runId)) return 'STOPPED';
                haltForPersistenceFailure(vid);
                return 'STOPPED';
            }
            returnToList(vid, { markProcessed: true, runId });
            return 'RETURNED';
        }
        log(I18n.t('logs.scenarioBModal', { reject: rejectSeen ? I18n.t('logs.scenarioBRejectNote') : '', cover: config.useCover ? I18n.t('logs.scenarioBCoverNote') : I18n.t('logs.scenarioBNoCoverNote') }));
        const allowDocumentStrongText = !hasResponseTextConfirmation(document);
        const submitted = await fillLetterAndSubmit({ withCover: config.useCover, runId });
        if (!isRunCurrent(runId)) return 'STOPPED';
        if (!submitted) {
            log(I18n.t('logs.scenarioBSubmitFail'), true);
            captureResponseDom('scenarioB-no-submit');
            const saved = saveCurrentForManual(vid, rejectSeen ? 'reject-warning' : 'no-submit', runId);
            if (!saved) {
                if (!isRunCurrent(runId)) return 'STOPPED';
                haltForPersistenceFailure(vid);
                return 'STOPPED';
            }
            returnToList(vid, { markProcessed: true, runId });
            return 'RETURNED';
        }
        const conf = await awaitSubmitConfirmation(TUNING.confirmWaitMs, runId, { allowDocumentStrongText });
        if (!isRunCurrent(runId)) return 'STOPPED';
        if (conf === 'QUESTIONS' || Page.isResponseForm()) return markRedirect(vid);
        if (conf === 'CONFIRMED' || conf === true) {
            if (rejectSeen) Metrics.bump('reject.sent.modal');
            if (!isRunCurrent(runId)) return 'STOPPED';
            if (!persistSentCount(vid, runId)) return 'STOPPED';
            log(I18n.t('logs.scenarioBSent', { reject: rejectSeen ? I18n.t('logs.scenarioBSentRejectNote') : '' }));
            returnToList(vid, { markProcessed: true, runId });
            return 'OK';
        }
        // Отправили, но подтверждения нет - выясняем причину (это блок со стороны hh.ru).
        const reason = detectModalBlockReason();

        // Предупреждение Скорее всего, будет отказ: если включён форс - дожимаем отправку.
        if (reason === 'reject-warning' && config.applyOnRejectWarning) {
            log(I18n.t('logs.scenarioBForcing'));
            const forced = await forceSubmitReject(TUNING.forceSubmitAttempts, { onResponsePage: false, runId, allowDocumentStrongText });
            if (forced === 'STOPPED' || !isRunCurrent(runId)) return 'STOPPED';
            if (forced === 'REDIRECT') return markRedirect(vid);
            if (forced === 'OK') {
                if (!isRunCurrent(runId)) return 'STOPPED';
                Metrics.bump('scenario.B.rejectForced.ok');
                if (!persistSentCount(vid, runId)) return 'STOPPED';
                log(I18n.t('logs.scenarioBForcedSent'));
                returnToList(vid, { markProcessed: true, runId });
                return 'OK';
            }
            Metrics.bump('scenario.B.rejectForced.fail');
        }

        Metrics.bump('scenario.B.noConfirm' + (reason ? '.' + reason : ''));
        captureResponseDom('scenarioB-no-confirm');
        if (reason === 'resume-hidden') {
            log(I18n.t('logs.blockedResumeHidden'), true);
        } else if (reason === 'reject-warning') {
            log(I18n.t('logs.blockedRejectWarning'), true);
        } else {
            log(I18n.t('logs.letterSentNoConfirm'), true);
        }
        // Не теряем такие вакансии - сохраняем для ручной обработки.
        const saved = saveCurrentForManual(vid, reason || 'no-confirm', runId);
        if (!saved) {
            if (!isRunCurrent(runId)) return 'STOPPED';
            haltForPersistenceFailure(vid);
            return 'STOPPED';
        }
        returnToList(vid, { markProcessed: true, runId });
        return 'RETURNED';
    }

    // TIMEOUT - окно не появилось. Проверяем признаки успеха, защищаемся от ложных срабатываний
    // и пробуем повторный клик при видимой кнопке.
    async function handleTimeout(vid, runId = currentRunId) {
        if (!isRunCurrent(runId)) return 'STOPPED';
        // High confidence: явное подтверждение отправки в DOM (чат, баннер успеха, статус)
        if (isResponseConfirmed()) {
            if (!isRunCurrent(runId)) return 'STOPPED';
            Metrics.bump('scenario.timeout.confirmed');
            log(I18n.t('logs.responseConfirmed'));
            if (!persistSentCount(vid, runId)) return 'STOPPED';
            returnToList(vid, { markProcessed: true, runId });
            return 'OK';
        }

        // Терминальные статусы
        if (detectCaptcha()) { haltForCaptcha(); return 'CAPTCHA'; }
        if (Page.isResponseForm()) return markRedirect(vid);
        if (detectAlreadyApplied()) {
            Metrics.bump('scenario.alreadyApplied');
            Stats.bump('skipped');
            log(I18n.t('logs.alreadyApplied'));
            returnToList(vid, { markProcessed: true, runId });
            return 'RETURNED';
        }

        const applyBtn = query('vacancyApply');
        const applyVisible = isVisible(applyBtn);

        // Low confidence: кнопка исчезла, но подтверждения отправки нет.
        // Нельзя считать это успехом (кнопка могла исчезнуть из-за SPA-ререндера, изменения DOM,
        // блокирующей модалки или промежуточного состояния).
        if (!applyBtn || !applyVisible) {
            await actionPause();
            if (!isRunCurrent(runId)) return 'STOPPED';

            // Короткая дополнительная проверка DOM
            if (isResponseConfirmed()) {
                if (!isRunCurrent(runId)) return 'STOPPED';
                Metrics.bump('scenario.timeout.confirmed');
                log(I18n.t('logs.responseConfirmedExtra'));
                if (!persistSentCount(vid, runId)) return 'STOPPED';
                returnToList(vid, { markProcessed: true, runId });
                return 'OK';
            }
            if (detectCaptcha()) { haltForCaptcha(); return 'CAPTCHA'; }
            if (Page.isResponseForm()) return markRedirect(vid);
            if (detectAlreadyApplied()) {
                Metrics.bump('scenario.alreadyApplied');
                Stats.bump('skipped');
                log(I18n.t('logs.alreadyApplied'));
                returnToList(vid, { markProcessed: true, runId });
                return 'RETURNED';
            }
            if (isVisible(query('letterSubmit'))) {
                return handleScenarioB(vid, runId);
            }
            if (isVisible(query('attachCoverBtn'))) {
                return handleScenarioA(vid, runId);
            }

            // Доказать успех нельзя: не увеличиваем success, сохраняем для ручной обработки.
            Metrics.bump('scenario.timeout.buttonDisappeared.unconfirmed');
            captureResponseDom('timeout-button-disappeared');
            log(I18n.t('logs.btnDisappearedUnconfirmed'), true);
            const blockReason = detectModalBlockReason();
            const saved = saveCurrentForManual(vid, blockReason || 'button-disappeared-unconfirmed', runId);
            if (!saved) {
                if (!isRunCurrent(runId)) return 'STOPPED';
                haltForPersistenceFailure(vid);
                return 'STOPPED';
            }
            returnToList(vid, { markProcessed: true, runId });
            return 'RETURNED';
        }

        // Кнопка отклика всё ещё на месте и ничего не открылось - вероятно, первый клик не сработал.
        // Пробуем один повторный клик.
        Metrics.bump('scenario.retryClick');
        log(I18n.t('logs.retryClick'), true);
        await actionPause();
        if (!isRunCurrent(runId)) return 'STOPPED';
        const retryClicked = await realisticClick(applyBtn, runId);
        if (!retryClicked || !isRunCurrent(runId)) return 'STOPPED';
        const retryOutcome = await resolveWithRelocation(Math.min(TUNING.waitForModalMs, 6000), runId);
        if (!isRunCurrent(runId)) return 'STOPPED';
        if (retryOutcome === 'CAPTCHA') { haltForCaptcha(); return 'CAPTCHA'; }
        if (retryOutcome === 'QUESTIONS' || Page.isResponseForm()) return markRedirect(vid);
        if (retryOutcome === 'SCENARIO_A') return handleScenarioA(vid, runId);
        if (retryOutcome === 'SCENARIO_B') return handleScenarioB(vid, runId);
        if (retryOutcome === 'SCENARIO_C') {
            if (!isRunCurrent(runId)) return 'STOPPED';
            Metrics.bump('scenario.retryClick.ok');
            if (!persistSentCount(vid, runId)) return 'STOPPED';
            log(I18n.t('logs.retryClickSent'));
            returnToList(vid, { markProcessed: true, runId });
            return 'OK';
        }

        // Совсем неопознанный исход - снимок DOM максимально полезен для обновления селекторов.
        Metrics.bump('scenario.timeout.unresolved');
        captureResponseDom('timeout-unresolved');
        log(I18n.t('logs.timeoutUnresolved'), true);
        const saved = saveCurrentForManual(vid, 'timeout', runId);
        if (!saved) {
            if (!isRunCurrent(runId)) return 'STOPPED';
            haltForPersistenceFailure(vid);
            return 'STOPPED';
        }
        returnToList(vid, { markProcessed: true, runId });
        return 'RETURNED';
    }

    // Полная обработка страницы вакансии: просмотр, клик Откликнуться, сценарии А/Б/В.
    async function handleVacancyPage(btn, runId = currentRunId) {
        if (!isRunCurrent(runId)) return 'STOPPED';
        const vid = getStableVacancyId(btn);

        // Пока мы на странице вакансии - имя доступно. Сохраняем его на случай редиректа
        // на тест/анкету, где распарсить название уже нельзя.
        try {
            const vTitle = parseVacancyTitle();
            if (vTitle) State.setLastVacancyMeta(vid, vTitle);
        } catch (e) { /* ignore */ }

        ensureReturnUrl();

        const t = timings();
        const viewTime = randBetween(t.view[0], t.view[1]);
        log(I18n.t('logs.readingSim', { sec: Math.round(viewTime / 1000) }));
        await simulateReading(viewTime, runId);

        await actionPause();
        if (!isRunCurrent(runId)) return 'STOPPED';

        // Кнопка "Откликнуться" именно на странице вакансии (верхняя/нижняя).
        const applyBtn = query('vacancyApply') || await waitForElement('vacancyApply', TUNING.waitForModalMs);
        Metrics.selector('vacancyApply', !!applyBtn);
        if (!applyBtn) return handleMissingApplyButton(vid, runId);

        // Страховка от ложной кнопки: если штатного селектора отклика на странице нет
        // (кнопку дала эвристика), а признаки уже отправленного отклика есть - это
        // страница Вы откликнулись. Клик по найденному элементу дал бы фантомный
        // успех через видимую ссылку чата (SCENARIO_C) - вместо этого пропускаем.
        if (!q(SELECTORS.vacancyApply) && detectAlreadyApplied()) {
            return handleMissingApplyButton(vid, runId);
        }

        // Пометим, что сейчас пытаемся откликнуться на эту вакансию (если не было ID карточки).
        if (!State.getLastAttemptID() && !State.setLastAttemptID(vid)) {
            haltForPersistenceFailure(vid, 'lastAttempt');
            return 'STOPPED';
        }

        window.scrollTo({ top: 0, behavior: 'auto' });
        await actionPause();
        if (!isRunCurrent(runId)) return 'STOPPED';
        try { applyBtn.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (e) { /* ignore */ }
        await actionPause();
        if (!isRunCurrent(runId)) return 'STOPPED';

        const clickAt = Date.now();
        const clicked = await realisticClick(applyBtn, runId);
        if (!clicked || !isRunCurrent(runId)) return 'STOPPED';

        // Динамически определяем сценарий (А/Б/В), предварительно обрабатывая окно переезда.
        const outcome = await resolveWithRelocation(TUNING.waitForModalMs, runId);
        if (!isRunCurrent(runId)) return 'STOPPED';

        // Капча/анти-бот прямо в ответ на клик - немедленно останавливаемся.
        // (haltForCaptcha сам ведёт метрику scenario.captcha, поэтому ниже её не дублируем.)
        if (outcome === 'CAPTCHA') { haltForCaptcha(); return 'CAPTCHA'; }

        // Метрики: сколько заняло определение сценария и что именно сработало.
        Metrics.timing('resolveOutcomeMs', Date.now() - clickAt);
        Metrics.bump('scenario.' + ({
            QUESTIONS: 'questions', SCENARIO_A: 'A', SCENARIO_B: 'B',
            SCENARIO_C: 'C', TIMEOUT: 'timeout'
        }[outcome] || 'other'));

        switch (outcome) {
            // Тесты/вопросы - отдаём обработку watchdog'у (он вернёт на список и сохранит для ручного отклика).
            case 'QUESTIONS':
                return markRedirect(vid);
            case 'SCENARIO_A':
                return handleScenarioA(vid, runId);
            case 'SCENARIO_B':
                return handleScenarioB(vid, runId);
            case 'SCENARIO_C':
                if (!isRunCurrent(runId)) return 'STOPPED';
                log(I18n.t('logs.scenarioC'));
                if (!persistSentCount(vid, runId)) return 'STOPPED';
                returnToList(vid, { markProcessed: true, runId });
                return 'OK';
            default:
                return handleTimeout(vid, runId);
        }
    }

    // Обработка вакансии: работает и на странице вакансии, и для кнопки на листинге
    async function processVacancyCode(btn, runId = currentRunId) {
        if (!isRunCurrent(runId)) return 'STOPPED';

        if (Page.isVacancy()) return handleVacancyPage(btn, runId);

        if (btn) {
            const card = getVacancyCard(btn);
            const vacLink = (card && query('vacancyLink', card)) || (card && q('a[href*="/vacancy/"]', card));
            if (!vacLink) {
                log(I18n.t('logs.noLinkSelector'), true);
                return 'ERROR_NO_LINK';
            }
            return openVacancyFromList(vacLink, runId);
        }

        return 'ERROR_UNKNOWN';
    }

    async function processVacancy(btn, runId = currentRunId) {
        return ExecutionResult.fromTerminalCode(await processVacancyCode(btn, runId));
    }

    // ─────────────────────────────────────────────────────────────
    //  11. ГЛАВНЫЙ ЦИКЛ И WATCHDOG
    // ─────────────────────────────────────────────────────────────

    function clearRunningState(context) {
        if (State.setRunning(false)) return true;
        Metrics.bump('storage.is_active.cleanup.failed');
        log(`[CRITICAL_STORAGE_WRITE_FAILED] is_active cleanup: ${context || 'unknown'}`, true);
        return false;
    }

    function finalizeRun(runId, statusKey, msg) {
        if (runId !== currentRunId) return;
        isLoopActive = false;
        if (!Page.isResponseForm()) {
            handlingResponsePage = false;
        }
        if (activeAbortController) {
            try { activeAbortController.abort(); } catch (e) {}
            activeAbortController = null;
        }
        const runningCleared = clearRunningState('finalize');
        State.releaseInstanceLock(TAB_ID);
        setStatus(runningCleared ? statusKey : 'error');
        if (msg) log(msg);
    }

    async function startLoop() {
        if (isLoopActive) return;

        // Было ли запущено ДО этого вызова: отличаем свежий старт от авто-возобновления.
        const wasRunning = State.amIRunning();

        // Задаём уникальное поколение запуска ДО первого await, чтобы при Stop -> Start
        // старая попытка запуска (A) была аннулирована ещё до завершения захвата лока.
        isLoopActive = true;
        const runId = ++currentRunId;
        if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }

        if (activeAbortController) {
            try { activeAbortController.abort(); } catch (e) {}
        }
        activeAbortController = new AbortController();
        stopSignal = false;
        if (!State.setRunning(true)) {
            haltForPersistenceFailure('start', 'is_active');
            return;
        }
        setStatus('running');

        // Жёстко занимаем instance lock: не запускаемся, если работает другая вкладка.
        const acquired = await State.acquireInstanceLock(TAB_ID);

        // Если пока шёл acquire, прогон был остановлен или сменился новым поколением (Stop -> Start)
        if (runId !== currentRunId || stopSignal || !State.amIRunning()) {
            if (acquired && runId === currentRunId) {
                State.releaseInstanceLock(TAB_ID);
            }
            return;
        }

        if (!acquired) {
            if (runId === currentRunId) {
                isLoopActive = false;
                stopSignal = true;
                if (activeAbortController) {
                    try { activeAbortController.abort(); } catch (e) {}
                    activeAbortController = null;
                }
                log(I18n.t('logs.tabBusy'), true);
                const runningCleared = clearRunningState('instance-lock-acquire');
                setStatus('error', runningCleared ? 'status.busyTab' : undefined);
            }
            return;
        }

        // Свежий запуск пользователем - сбрасываем сквозной счётчик и статистику прогона.
        if (!wasRunning) {
            if (!State.resetSentCount()) {
                haltForPersistenceFailure('start', 'sentCount.reset');
                return;
            }
            Stats.reset();
            log(I18n.t('logs.newRun', { mode: presetLabel(config.preset) }));
        }

        try {
            // Лимит уже достигнут - завершаем прогон.
            const initialSent = State.readSentCount();
            if (!initialSent.ok) {
                haltForPersistenceFailure('start', 'sentCount.read');
                return;
            }
            if (initialSent.value >= config.limit) {
                finalizeRun(runId, 'done', I18n.t('logs.limitReached', { limit: config.limit }));
                return;
            }

            // Если на странице формы отклика - управление у watchdog/submitResponsePage
            if (Page.isResponseForm()) {
                isLoopActive = false;
                log(I18n.t('logs.onResponsePage'));
                return;
            }

            // Если уже на странице вакансии - обрабатываем её напрямую.
            if (Page.isVacancy()) {
                log(I18n.t('logs.onVacancyPage'));
                const res = await processVacancy(null, runId);
                if (runId !== currentRunId) return;
                if (res.status === EXECUTION_STATUS.STOPPED || stopSignal) {
                    finalizeRun(runId, 'stopped', I18n.t('logs.stoppedDuringVacancy'));
                    return;
                }
                // Капча: haltForCaptcha уже снял флаги, освободил лок и выставил статус - просто выходим.
                if (res.status === EXECUTION_STATUS.CAPTCHA) { isLoopActive = false; return; }
                // SUCCESS / NAVIGATED: навигация или watchdog продолжат цикл - флаг running сохраняем.
                isLoopActive = false;
                setStatus('running', res.code === 'OK' ? 'status.returningToList' : 'status.waitingToReturn');
                return;
            }

            let allBtns = queryAll('applyBtn');
            if (allBtns.length === 0 && Page.isSearch()) {
                await waitForCondition(() => {
                    if (stopSignal || runId !== currentRunId) return 'STOPPED';
                    const btns = queryAll('applyBtn');
                    if (btns.length > 0) return 'READY';
                    if (q('[data-qa*="empty" i], [class*="empty" i]')) return 'EMPTY';
                    return false;
                }, 2000);
                if (stopSignal || runId !== currentRunId) return;
                allBtns = queryAll('applyBtn');
            }

            const processedState = State.readProcessedIDs();
            if (!processedState.ok) {
                haltForPersistenceFailure('search', 'history.read');
                return;
            }
            const processed = processedState.value;

            let targets = allBtns.filter(b => {
                if (config.skipHidden && !isVisible(b)) return false;
                return !processed.has(getVacancyID(b));
            });

            log(I18n.t('logs.vacanciesFound', { total: allBtns.length, targets: targets.length, sent: initialSent.value, limit: config.limit }));

            let rescanCount = 0;
            const MAX_RESCANS = 3;

            while (targets.length > 0) {
                if (stopSignal || runId !== currentRunId) break;
                const btn = targets.shift();
                const sentState = State.readSentCount();
                if (!sentState.ok) {
                    haltForPersistenceFailure('search', 'sentCount.read');
                    return;
                }
                if (sentState.value >= config.limit) {
                    finalizeRun(runId, 'done', I18n.t('logs.limitReached', { limit: config.limit }));
                    return;
                }
                if (State.touchInstanceLock(TAB_ID) !== 'OWNED') {
                    haltForLostInstanceLock();
                    return;
                }
                if (!document.body.contains(btn)) {
                    log(I18n.t('logs.buttonDisappeared'), true);
                    if (rescanCount < MAX_RESCANS) {
                        rescanCount++;
                        const currentProcessedState = State.readProcessedIDs();
                        if (!currentProcessedState.ok) {
                            haltForPersistenceFailure('search-rescan', 'history.read');
                            return;
                        }
                        const currentProcessed = currentProcessedState.value;
                        const freshBtns = queryAll('applyBtn');
                        targets = freshBtns.filter(b => {
                            if (config.skipHidden && !isVisible(b)) return false;
                            return !currentProcessed.has(getVacancyID(b));
                        });
                        continue;
                    } else {
                        break;
                    }
                }

                await vacancyPause();
                if (stopSignal || runId !== currentRunId) break;
                if (State.touchInstanceLock(TAB_ID) !== 'OWNED') {
                    haltForLostInstanceLock();
                    return;
                }

                const result = await processVacancy(btn, runId);
                if (runId !== currentRunId) return;

                if (result.status === EXECUTION_STATUS.STOPPED || stopSignal) {
                    finalizeRun(runId, 'stopped', I18n.t('logs.stoppedProcessing'));
                    return;
                } else if (result.status === EXECUTION_STATUS.CAPTCHA) {
                    // haltForCaptcha уже остановил прогон и выставил статус.
                    isLoopActive = false;
                    return;
                } else if (result.status === EXECUTION_STATUS.NAVIGATED && result.reason === EXECUTION_REASON.VACANCY_PAGE) {
                    // Перешли на страницу вакансии - завершаем цикл, флаг running оставляем для авто-старта.
                    log(I18n.t('logs.navigatingVacancy'));
                    isLoopActive = false;
                    return;
                } else if (result.status === EXECUTION_STATUS.NAVIGATED && result.reason === EXECUTION_REASON.RESPONSE_PAGE) {
                    log(I18n.t('logs.redirectWaiting'), true);
                    isLoopActive = false;
                    setStatus('running', 'status.waitingToReturn');
                    return;
                } else {
                    // SKIPPED / неизвестные terminal codes: сохраняем прежнее логирование и продолжаем.
                    if (result.status === EXECUTION_STATUS.SKIPPED) {
                        if (result.code === 'ERROR_NO_LINK' || result.code === 'ERROR_NO_HREF' || result.code === 'ERROR_UNKNOWN') {
                            Stats.bump('skipped');
                        }
                    }
                    log(I18n.t('logs.skippingCode', { code: result.code }), true);
                }
            }

            if (stopSignal || runId !== currentRunId) {
                finalizeRun(runId, 'stopped', I18n.t('logs.stoppedProcessing'));
                return;
            }
            if (!Page.isResponseForm()) {
                const finalSent = State.readSentCount();
                if (!finalSent.ok) {
                    haltForPersistenceFailure('finalize', 'sentCount.read');
                    return;
                }
                finalizeRun(runId, 'done', I18n.t('logs.runCompleted', { count: finalSent.value }));
            }
        } catch (e) {
            console.warn('[HH Apply Assistant] startLoop error', e);
            finalizeRun(runId, 'error', I18n.t('logs.mainLoopError', { err: (e && e.message ? e.message : e) }));
        }
    }

    function stopRun() {
        currentRunId++;
        stopSignal = true;
        if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
        handlingResponsePage = false;
        State.clearTrapLock();
        if (activeAbortController) {
            try { activeAbortController.abort(); } catch (e) {}
            activeAbortController = null;
        }
        isLoopActive = false;
        const runningCleared = clearRunningState('stop');
        setStatus(runningCleared ? 'stopped' : 'error');
        State.releaseInstanceLock(TAB_ID);
        log(I18n.t('logs.stoppedByUser'));
    }

    // Обнаружение капчи / анти-бот проверки hh.ru. Если она появилась, прогон надо
    // немедленно остановить, а не продолжать клики: серия «слепых» откликов в закрытую
    // дверь — прямой путь к блокировке аккаунта. Проверка дешёвая: сперва явные виджеты
    // и URL, а характерные фразы ищем ТОЛЬКО внутри оверлеев/диалогов — иначе слова
    // «робот»/«проверка» в тексте вакансии давали бы ложные срабатывания.
    function detectCaptcha() {
        if (q('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="captcha" i], iframe[src*="smartcaptcha" i], iframe[title*="captcha" i], [data-qa*="captcha" i], .g-recaptcha, .h-captcha, .smart-captcha')) return true;
        if (/\/captcha|\/checkpoint|\/nocaptcha/i.test(location.pathname)) return true;
        const rx = /подтвердите,?\s*что\s*вы\s*не\s*робот|вы не робот|not a robot|необычн\w*\s+активн|unusual (?:activity|traffic)|слишком много (?:действий|попыток|запросов|откликов)/i;
        const scopes = qa('.mock-captcha-overlay, [role="dialog"], [class*="captcha" i], [class*="overlay" i], [data-qa*="modal" i], [class*="modal" i]');
        for (const s of scopes) {
            if (isAutoResponderUI(s)) continue;
            const t = (s.textContent || '');
            if (t.length <= 400 && rx.test(t) && isVisible(s)) return true;
        }
        return false;
    }

    // Останавливаем прогон из-за капчи: снимаем рабочие флаги, освобождаем межвкладочную
    // блокировку и показываем понятный статус. Дальше — за пользователем (решить капчу).
    function haltForCaptcha() {
        currentRunId++;
        Metrics.bump('scenario.captcha');
        captureResponseDom('captcha');
        stopSignal = true;
        if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
        handlingResponsePage = false;
        State.clearTrapLock();
        if (activeAbortController) {
            try { activeAbortController.abort(); } catch (e) {}
            activeAbortController = null;
        }
        isLoopActive = false;
        clearRunningState('captcha');
        State.releaseInstanceLock(TAB_ID);
        setStatus('error', 'status.captchaStopped');
        log(I18n.t('logs.captchaHalt'), true);
    }

    // Остановка из-за потери межвкладочного instance lock (другая вкладка перехватила лок после засыпания/зависания).
    // Важно: чужой лок НЕ трогаем, останавливаем только текущую вкладку.
    function haltForLostInstanceLock() {
        currentRunId++;
        Metrics.bump('instanceLock.lost');
        stopSignal = true;
        if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
        handlingResponsePage = false;
        State.clearTrapLock();
        if (activeAbortController) {
            try { activeAbortController.abort(); } catch (e) {}
            activeAbortController = null;
        }
        isLoopActive = false;
        clearRunningState('lost-instance-lock');
        setStatus('error', 'status.busyTab');
        log(I18n.t('logs.instanceLockLost'), true);
    }

    function handleSettingsPersistenceFailure() {
        if (State.amIRunning()) {
            haltForPersistenceFailure('config', 'settings');
            return;
        }
        Metrics.bump('storage.settings.failed');
        setStatus('error');
        log('[CRITICAL_STORAGE_WRITE_FAILED] settings: config', true);
    }

    // Остановка из-за сбоя критической записи. Для Manual Queue сохраняем прежний статус/текст;
    // для внутренних terminal-state ключей используем нейтральный error status и диагностический marker.
    function haltForPersistenceFailure(vid, storageArea = 'manual') {
        currentRunId++;
        Metrics.bump(`storage.${storageArea}.failed`);
        stopSignal = true;
        if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
        handlingResponsePage = false;
        State.clearTrapLock();
        if (activeAbortController) {
            try { activeAbortController.abort(); } catch (e) {}
            activeAbortController = null;
        }
        isLoopActive = false;
        clearRunningState(`persistence-${storageArea}`);
        State.releaseInstanceLock(TAB_ID);
        if (storageArea === 'manual') {
            setStatus('error', 'status.storageFailed');
            log(I18n.t('logs.persistenceFailure', { vid: vid || '' }), true);
        } else {
            setStatus('error');
            log(`[CRITICAL_STORAGE_WRITE_FAILED] ${storageArea}: ${vid || 'n/a'}`, true);
        }
    }

    // Watchdog: следит за URL. Если попали на страницу отклика/теста - обрабатываем её;
    // после возврата на список при необходимости обновляем страницу.
    function startWatchdog() {
        if (runtimeRecord.watchdogIntervalId !== null) return;
        runtimeRecord.watchdogIntervalId = setInterval(() => {
            try {
                watchdogTick();
            } catch (e) {
                console.warn('[HH Apply Assistant] watchdog error', e);
            }
        }, 1000);
    }

    function teardownRuntime() {
        if (!runtimeRecord.active) return;
        runtimeRecord.active = false;
        currentRunId++;
        stopSignal = true;
        isLoopActive = false;
        handlingResponsePage = false;
        if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
        clearTrapLockTimer();
        if (activeAbortController) {
            try { activeAbortController.abort(); } catch (e) {}
            activeAbortController = null;
        }
        if (runtimeRecord.watchdogIntervalId !== null) {
            clearInterval(runtimeRecord.watchdogIntervalId);
            runtimeRecord.watchdogIntervalId = null;
        }
        if (runtimeRecord.domReadyObserver) {
            try { runtimeRecord.domReadyObserver.disconnect(); } catch (e) {}
            runtimeRecord.domReadyObserver = null;
        }
        for (const listener of runtimeRecord.globalListeners.splice(0)) {
            try { listener.target.removeEventListener(listener.type, listener.handler, listener.options); } catch (e) {}
        }
        try { PanelController.destroy(); } catch (e) {}
        clearRunningState('runtime-teardown');
        State.releaseInstanceLock(TAB_ID);
        if (window[RUNTIME_KEY] === runtimeRecord) {
            try { delete window[RUNTIME_KEY]; } catch (e) { window[RUNTIME_KEY] = null; }
        }
    }

    runtimeRecord.teardown = teardownRuntime;

    function watchdogTick() {
        // Панель могла быть выброшена из DOM (SPA-перерисовка) - восстанавливаем.
        if (document.body && !document.getElementById('ar-main-panel')) PanelController.mount();

        if (!State.amIRunning()) return;

        // acquire уже выполняет собственный read-back; до его завершения ownership ещё
        // не существует и watchdog не должен ошибочно классифицировать 60ms race window.
        if (pendingInstanceLeaseId) return;

        // Обновляем timestamp instance lock и проверяем, что ownership всё ещё наш
        const lockStatus = State.touchInstanceLock(TAB_ID);
        if (lockStatus !== 'OWNED') {
            haltForLostInstanceLock();
            return;
        }

        // Капча / анти-бот hh.ru — немедленно останавливаемся, чтобы не долбить вслепую.
        if (detectCaptcha()) { haltForCaptcha(); return; }

        // Оказались на /applicant/vacancy_response. Это НЕ всегда тест: может быть обычная
        // страница отклика (в т.ч. с предупреждением об отказе), которую можно отправить.
        if (Page.isResponseForm()) {
            if (handlingResponsePage) return; // уже обрабатываем эту страницу
            if (State.hasTrapLock()) return;
            if (currentRunId === 0) currentRunId = 1;
            const trapToken = State.setTrapLock();
            if (!trapToken) {
                haltForPersistenceFailure(State.getLastAttemptID(), 'trapLock');
                return;
            }

            // Определяем ID вакансии (для пометки обработанной и сохранения).
            let vid = null;
            try {
                if (document.referrer) {
                    const r = getVacancyIDFromHref(document.referrer);
                    if (r) vid = 'v_' + r;
                }
            } catch (e) { /* ignore */ }
            if (!vid) { const last = State.getLastAttemptID(); if (last) vid = last; }
            if (!vid) { const cur = getVacancyIDFromHref(location.href); if (cur) vid = 'v_' + cur; }

            const savedReturn = State.getReturnUrl();
            const backUrl = (savedReturn && savedReturn.includes('/search/vacancy')) ? savedReturn : '/search/vacancy';

            // Обычная форма отклика (без полей вопросов) - пытаемся отправить.
            if (!pageLooksLikeTest()) {
                if (handlingResponsePage) return; // уже обрабатываем эту страницу
                handlingResponsePage = true;
                Metrics.bump('page.response.detected');
                log(I18n.t('logs.onResponsePage'));
                submitResponsePage(vid, backUrl, currentRunId, trapToken); // async: сам заполнит/отправит и вернёт к списку
                return;
            }

            // Настоящий тест/анкета - авто-ответить не можем: сохраняем для ручного отклика.
            Metrics.bump('scenario.questions.watchdog');
            captureResponseDom('questions-page');
            log(I18n.t('logs.questionsPage'), true);

            let saved = false;
            try {
                const entry = {
                    vid: vid || ('u_' + fnv1a32(location.href).toString(36)),
                    url: location.href,
                    returnUrl: savedReturn || '',
                    ts: Date.now(),
                    title: resolveManualTitle(vid)
                };
                const res = State.addManualEntry(entry);
                if (res === 'ADDED') {
                    Stats.bump('manual');
                    log(I18n.t('logs.manualSaved', { note: '', vid: entry.vid }));
                    try { window._hhApplyAssistantRenderManualQueue?.(); } catch (e) { /* ignore */ }
                    saved = true;
                } else if (res === 'EXISTS' || res === 'UPDATED') {
                    log(I18n.t('logs.manualAlready', { note: '', vid: entry.vid }));
                    try { window._hhApplyAssistantRenderManualQueue?.(); } catch (e) { /* ignore */ }
                    saved = true;
                } else {
                    log(I18n.t('logs.manualSaveFailed', { note: '', vid: entry.vid }), true);
                    saved = false;
                }
            } catch (e) {
                console.warn('[HH Apply Assistant] save manual entry error', e);
                log(I18n.t('logs.manualSaveFailed', { note: '', vid }), true);
                saved = false;
            }

            if (saved) {
                if (vid) {
                    if (!persistProcessedVacancy(vid, currentRunId)) return;
                    if (!State.clearLastAttemptID()) {
                        haltForPersistenceFailure(vid, 'lastAttempt');
                        return;
                    }
                } else {
                    log(I18n.t('logs.noVidOnQuestions'), true);
                }

                State.setF5Needed(); // после возвращения нужно обновить список

                // Пытаемся откатиться двумя шагами назад: list <- vacancy <- applicant
                try { history.go(-2); } catch (e) { history.back(); }

                // Если через 1.2 сек всё ещё на странице с тестом - форсим переход на список
                const timerRunId = currentRunId;
                setTimeout(() => {
                    if (isRunCurrent(timerRunId) && Page.isResponseForm() && guardOwnedCommit(timerRunId)) {
                        log(I18n.t('logs.twoStepBackFailed'), true);
                        window.location.href = backUrl;
                    }
                }, 1200);
            } else {
                haltForPersistenceFailure(vid);
            }
        } else {
            // Очищаем ловушку при уходе со страницы отклика/вопросов (SPA-навигация)
            State.clearTrapLock();
            handlingResponsePage = false;

            // Обновляем страницу только когда мы действительно на списке: раньше эвристика
            // applyBtn могла найти кнопку и на странице вакансии - и reload дёргал её зря.
            const backOnList = Page.isSearchList()
                || (!Page.isVacancy() && !Page.isResponseForm() && query('applyBtn'));
            if (State.isF5Needed() && backOnList) {
                log(I18n.t('logs.returnedReloading'));
                State.clearF5Flag();
                window.location.reload();
            }
        }
    }

    // Единый набор UI-иконок: общий viewBox и stroke позволяют центрировать
    // icon-only controls системно, оставляя лишь осмысленные optical modifiers.
    const UI_ICONS = Object.freeze({
        chevronDown: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.75 8 10 12.25 14.25 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        help: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.55"/><path d="M8.65 7.7a1.9 1.9 0 1 1 2.42 2.82c-.7.29-1.07.8-1.07 1.45" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="14.35" r=".85" fill="currentColor"/></svg>',
        arrowLeft: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11.75 5.5 7.25 10l4.5 4.5M7.6 10H15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        search: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8.6" cy="8.6" r="4.55" stroke="currentColor" stroke-width="1.65"/><path d="m12.05 12.05 3.7 3.7" stroke="currentColor" stroke-width="1.65" stroke-linecap="round"/></svg>',
        close: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="m6.25 6.25 7.5 7.5m0-7.5-7.5 7.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>',
        trash: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7.25 4.75h5.5M8 4.75v-.5A1.25 1.25 0 0 1 9.25 3h1.5A1.25 1.25 0 0 1 12 4.25v.5m-6 1.5h8l-.52 8.06A1.5 1.5 0 0 1 11.98 16H8.02a1.5 1.5 0 0 1-1.5-1.69L6 6.25Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.85 8.75v4.1M11.15 8.75v4.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
    });
    const uiIcon = (name, modifier = '') => {
        const svg = UI_ICONS[name] || '';
        const modifierClass = modifier ? ` ar-icon-svg--${modifier}` : '';
        return `<span class="ar-icon-svg${modifierClass}" aria-hidden="true">${svg}</span>`;
    };

    // ─────────────────────────────────────────────────────────────
    //  12. UI: СТИЛИ ПАНЕЛИ (в духе дизайн-системы hh.ru / Magritte)
    // ─────────────────────────────────────────────────────────────

    function injectPanelStyles() {
        if (document.getElementById('ar-styles')) return;
        const style = document.createElement('style');
        style.id = 'ar-styles';
        style.textContent = `
        :root{--hha-panel-width:${HHA_PREFERRED_PANEL_WIDTH}px;}
        #ar-main-panel, #ar-main-panel *, #ar-toggle-btn, #ar-toggle-btn *{box-sizing:border-box;}
        #ar-main-panel, #ar-toggle-btn{--font:"HH Sans","Inter",-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-family:var(--font);letter-spacing:normal;text-transform:none;}
        /* min(..., 100% - sidebar) excludes a classic scrollbar that 100vw includes. */
        html.hha-docked #HH-React-Root{box-sizing:border-box!important;width:min(calc(100vw - var(--hha-sidebar-width)),calc(100% - var(--hha-sidebar-width)))!important;max-width:min(calc(100vw - var(--hha-sidebar-width)),calc(100% - var(--hha-sidebar-width)))!important;min-width:0!important;}
        html.hha-docked #HH-React-Root .supernova-navi-container,
        html.hha-docked #HH-React-Root .supernova-navi-wrapper{box-sizing:border-box!important;width:calc(100vw - var(--hha-sidebar-width))!important;max-width:100%!important;min-width:0!important;}
        html.hha-docked #HH-React-Root .supernova-navi-inner-wrapper,
        html.hha-docked #HH-React-Root .supernova-navi,
        html.hha-docked #HH-React-Root .HH-MainContent,
        html.hha-docked #HH-React-Root .HH-Supernova-MainContent,
        html.hha-docked #HH-React-Root main.main-content{box-sizing:border-box!important;width:100%!important;max-width:100%!important;min-width:0!important;}
        /* These HH surfaces are viewport-fixed, so root reflow cannot move their right edge. */
        html.hha-docked .sticky-buttonbar_float-top,
        html.hha-docked .notification-manager{right:var(--hha-sidebar-width)!important;}
        html.hha-docked [class*="sticky-vacancy-header-container-sticky--"]{width:calc(100% - var(--hha-sidebar-width))!important;max-width:calc(100% - var(--hha-sidebar-width))!important;}
        #ar-toggle-btn{position:fixed;top:50%;right:0;transform:translateY(-50%);border:none;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;z-index:2147483000;user-select:none;}
        #ar-toggle-btn .ar-tab-text{color:#fff;text-transform:none;line-height:1;}
        #ar-main-panel{position:fixed;top:0;right:0;bottom:0;height:100vh;width:min(var(--hha-panel-width),100%);max-width:100%;z-index:2147483000;font-family:var(--font);line-height:1.4;border-radius:0;display:flex;flex-direction:column;overflow:hidden;text-align:left;}
        #ar-main-panel a{text-decoration:none;}
        #ar-main-panel a:hover{text-decoration:underline;}
        .ar-view{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden;}
        .ar-diag-nav{display:flex;align-items:center;}
        .ar-btn-back{font-weight:600;}
        .ar-diag-body{display:flex;flex-direction:column;}
        .ar-diag-toolbar{padding:0;}
        .ar-diag-full-box{display:flex;flex-direction:column;gap:2px;}
        .ar-diag-footer{display:flex;align-items:center;justify-content:flex-start;padding:0;}
        .ar-diag-footer .ar-dropdown-menu{top:auto;bottom:calc(100% + 4px);right:auto;left:0;}
        .ar-header{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px;border-radius:11px;}
        .ar-brand{display:flex;align-items:baseline;min-width:0;}
        .ar-title{text-transform:none;white-space:nowrap;}
        .ar-header-right{display:flex;align-items:center;flex:0 1 auto;min-width:0;}
        .ar-lang-switcher{display:inline-flex;align-items:center;flex:none;}
        .ar-lang-btn{font-family:inherit;cursor:pointer;line-height:1;}
        .ar-lang-btn:focus-visible{outline-offset:1px;}
        .ar-lang-sep{color:var(--line);font-size:9px;user-select:none;}
        .ar-status{display:inline-flex;align-items:center;min-width:0;max-width:160px;white-space:nowrap;overflow:hidden;}
        #ar-status-text{overflow:hidden;text-overflow:ellipsis;}
        @keyframes ar-pulse{0%,100%{ opacity:1; transform:scale(1); } 50%{ opacity:.4; transform:scale(1.25); }}
        .ar-header-action{background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:inherit;}
        .ar-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;}
        .ar-scroll::-webkit-scrollbar{width:6px;}
        .ar-card{display:flex;flex-direction:column;position:relative;overflow:hidden;flex-shrink:0;}
        .ar-card-title{text-transform:uppercase;}
        #ar-mode-card{--ar-work-track-h:36px;--ar-work-track-pad:3px;--ar-work-thumb-w:44px;--ar-work-thumb-h:30px;--ar-work-thumb-duration:255ms;--ar-work-turbo-reveal-duration:380ms;--ar-work-turbo-exit-duration:220ms;--ar-work-shock-cycle-duration:5s;--ar-work-turbo-grid-duration:60s;--ar-work-grid-shift:-320px;--ar-work-move-ease:cubic-bezier(.22, .8, .3, 1);--thumb-source-x:0px;--thumb-center-x:50%;--ar-work-grid-cell:5px;--ar-work-grid-col-gap:2px;--ar-work-grid-row-gap:2px;}
        .ar-work-mode-header{display:flex;justify-content:space-between;}
        .ar-work-mode-title{display:flex;min-width:0;margin:0;font-size:13.5px;line-height:1.2;white-space:nowrap;}
        .ar-work-mode-title__label{text-transform:uppercase;}
        .ar-help-button{position:relative;flex:0 0 auto;display:grid;place-items:center;cursor:pointer;}
        .ar-help-button:hover{color:var(--ink);border-color:#94a3b8;background:rgba(0, 0, 0, 0.04);}
        .ar-help-button:focus-visible{outline-offset:2px;}
        .ar-work-mode-options{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;line-height:1;user-select:none;}
        .ar-work-mode-slider{position:relative;height:var(--ar-work-track-h);border-radius:11px;overflow:hidden;touch-action:none;user-select:none;cursor:pointer;isolation:isolate;perspective:800px;perspective-origin:var(--thumb-center-x, 50%) 50%;transform-style:preserve-3d;}
        .ar-work-mode-slider::before{content:"";position:absolute;inset:0;z-index:0;border-radius:11px;pointer-events:none;background:linear-gradient(90deg, rgba(255,255,255,.12), rgba(255,255,255,.025) 62%, transparent 100%);}
        .ar-work-mode-turbo-surface{position:absolute;inset:0;z-index:1;border-radius:11px;pointer-events:none;opacity:0;}
        .ar-work-mode-slider.has-turbo-grid .ar-work-mode-turbo-surface{will-change:opacity;}
        .ar-work-mode-slider.is-turbo .ar-work-mode-turbo-surface{opacity:1;}
        .ar-work-mode-grid-mask{position:absolute;inset:0;z-index:2;overflow:hidden;border-radius:11px;pointer-events:none;opacity:0;visibility:hidden;filter:blur(0);-webkit-mask-image:linear-gradient(
                to right,
                #000 0,
                #000 calc(var(--thumb-source-x, 0px) - 24px),
                transparent var(--thumb-source-x, 0px),
                transparent 100%
            );mask-image:linear-gradient(
                to right,
                #000 0,
                #000 calc(var(--thumb-source-x, 0px) - 24px),
                transparent var(--thumb-source-x, 0px),
                transparent 100%
            );transition:opacity var(--ar-work-turbo-exit-duration) ease,
                filter var(--ar-work-turbo-exit-duration) ease,
                visibility 0s linear var(--ar-work-turbo-exit-duration);}
        .ar-work-mode-slider.has-turbo-grid .ar-work-mode-grid-mask{will-change:opacity, filter;}
        .ar-work-mode-slider.is-turbo .ar-work-mode-grid-mask{visibility:visible;animation:ar-turbo-grid-fade-in calc(var(--ar-work-turbo-reveal-duration) + 80ms)
                cubic-bezier(.22, .72, .22, 1)
                1 both;transition:opacity var(--ar-work-turbo-reveal-duration) ease,
                filter var(--ar-work-turbo-reveal-duration) ease,
                visibility 0s linear 0s;}
        @keyframes ar-turbo-grid-fade-in{0% {
                opacity: 0;
                filter: blur(1.2px);
            }
            55% {
                opacity: .48;
                filter: blur(.45px);
            }
            100% {
                opacity: .62;
                filter: blur(0);
            }}
        .ar-work-mode-grid-strip{position:absolute;top:0;bottom:0;left:0;display:grid;grid-template-rows:repeat(5, var(--ar-work-grid-cell));grid-auto-flow:column;grid-auto-columns:var(--ar-work-grid-cell);align-content:center;column-gap:var(--ar-work-grid-col-gap);row-gap:var(--ar-work-grid-row-gap);width:max-content;transform:translate3d(0,0,0);}
        .ar-work-mode-slider.has-turbo-grid .ar-work-mode-grid-strip{will-change:transform;}
        .ar-work-mode-slider.is-turbo .ar-work-mode-grid-strip{animation:ar-turbo-grid-drift var(--ar-work-turbo-grid-duration) linear infinite;}
        @keyframes ar-turbo-grid-drift{from { transform: translate3d(0, 0, 0); }
            to { transform: translate3d(var(--ar-work-grid-shift), 0, 0); }}
        .ar-work-mode-grid-cell{--wave-boost:0;--wave-x:0px;--wave-y:0px;--wave-scale:1;width:var(--ar-work-grid-cell);height:var(--ar-work-grid-cell);clip-path:inset(0 round 1px);background:currentColor;opacity:calc(var(--cell-alpha, .15) + var(--wave-boost));transform:translate3d(
                    var(--wave-x),
                    var(--wave-y),
                    0
                )
                scale(var(--wave-scale));transform-origin:center;}
        .ar-work-mode-slider.has-turbo-grid .ar-work-mode-grid-cell{will-change:transform, opacity;}
        .ar-work-mode-grid-cell.l0{--cell-alpha:0;}
        .ar-work-mode-grid-cell.l1{--cell-alpha:.10;}
        .ar-work-mode-grid-cell.l2{--cell-alpha:.20;}
        .ar-work-mode-grid-cell.l3{--cell-alpha:.35;}
        .ar-work-mode-grid-cell.l4{--cell-alpha:.55;}
        .ar-work-mode-grid-cell.l5{--cell-alpha:.75;}
        .ar-work-mode-snap-markers{position:absolute;z-index:3;top:50%;left:calc(var(--ar-work-track-pad) + var(--ar-work-thumb-w) / 2);right:calc(var(--ar-work-track-pad) + var(--ar-work-thumb-w) / 2);display:flex;align-items:center;justify-content:space-between;transform:translateY(-50%);pointer-events:none;}
        .ar-work-mode-snap-marker{width:3px;height:3px;flex:0 0 3px;clip-path:inset(0 round 1px);transition:opacity 100ms ease;}
        .ar-work-mode-slider:hover:not(.is-turbo) .ar-work-mode-snap-marker, .ar-work-mode-slider:focus-visible:not(.is-turbo) .ar-work-mode-snap-marker{opacity:.23;}
        .ar-work-mode-slider.is-turbo .ar-work-mode-snap-marker{opacity:0;}
        .ar-work-mode-thumb{position:absolute;z-index:5;top:var(--ar-work-track-pad);left:var(--ar-work-track-pad);width:var(--ar-work-thumb-w);height:var(--ar-work-thumb-h);transform:translate3d(0, 0, 0);transform-style:preserve-3d;transition:transform var(--ar-work-thumb-duration) var(--ar-work-move-ease);will-change:transform;pointer-events:none;}
        .ar-work-mode-slider.is-dragging .ar-work-mode-thumb{transition:none;}
        .ar-work-mode-thumb__shadow{position:absolute;inset:0;pointer-events:none;will-change:transform, box-shadow, opacity;transition:box-shadow 150ms ease;}
        .ar-work-mode-thumb__body{position:absolute;inset:0;border:1px solid rgba(92,105,122,.11);transform:translateZ(0);transform-style:preserve-3d;will-change:transform;transition:border-color 170ms ease,
                scale 100ms ease;pointer-events:none;}
        .ar-work-mode-slider.is-pressed .ar-work-mode-thumb__body{scale:.985;}
        .ar-work-mode-slider:focus{outline:none;}
        .ar-row{display:flex;align-items:center;justify-content:space-between;gap:10px;}
        .ar-row-label{flex:1;min-width:0;font-weight:500;line-height:1.4;}
        .ar-input{border:1px solid var(--line);background:var(--card);border-radius:10px;font-family:inherit;font-size:13px;color:var(--ink);transition:border-color .15s, box-shadow .15s;outline:none;}
        .ar-input:focus{border-color:var(--hh-blue);box-shadow:0 0 0 3px var(--hh-blue-soft);}
        .ar-input:hover:not(:focus){border-color:#cbd5e1;}
        .ar-input-num{flex:none;text-align:center;}
        .ar-input[type=number]{-moz-appearance:textfield;appearance:textfield;}
        .ar-input[type=number]::-webkit-outer-spin-button, .ar-input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
        .ar-textarea{width:100%;border:1px solid var(--line);background:var(--card);border-radius:11px;resize:vertical;font-family:inherit;color:var(--ink);transition:border-color .15s, box-shadow .15s, opacity .15s;}
        .ar-textarea:focus{outline:none;border-color:var(--hh-blue);box-shadow:0 0 0 3px var(--hh-blue-soft);}
        .ar-textarea:hover:not(:focus){border-color:#cbd5e1;}
        .ar-textarea:disabled{cursor:not-allowed;resize:none;}
        .ar-cover-counter.is-near{font-weight:700;}
        .ar-cover-counter.is-off{visibility:hidden;}
        .ar-switch-row{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;user-select:none;}
        .ar-switch-row-sub{padding-top:2px;}
        .ar-switch{position:relative;display:inline-block;flex:none;}
        .ar-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;z-index:1;}
        .ar-switch i{display:block;width:100%;height:100%;border-radius:7px;pointer-events:none;}
        .ar-switch i::after{content:"";position:absolute;}
        .ar-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font-family:inherit;line-height:1.15;cursor:pointer;white-space:nowrap;}
        .ar-btn:active{transform:translateY(1px);}
        .ar-btn:disabled{cursor:not-allowed;}
        .ar-btn:disabled:active{transform:none;}
        .ar-btn-cta{width:100%;box-shadow:0 2px 4px rgba(0,112,229,.18);}
        .ar-btn-soft{border:1px solid var(--line);}
        .ar-util-row{display:flex;align-items:center;justify-content:space-between;}
        .ar-util-btn{flex:1 1 0;min-width:0;font-size:11.5px;}
        .ar-progress{overflow:hidden;position:relative;}
        .ar-progress i{display:block;height:100%;width:0;border-radius:1.5px;position:relative;overflow:hidden;}
        .ar-stats{display:grid;}
        .ar-stat{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:0;text-align:center;}
        .ar-stat-num{line-height:1.1;font-variant-numeric:tabular-nums;}
        .ar-stat-cap{letter-spacing:.01em;}
        .ar-badge{display:inline-flex;align-items:center;justify-content:center;transition:all .15s ease;}
        .ar-badge-count{display:inline-flex;align-items:center;justify-content:center;font-weight:700;line-height:1;flex:none;margin-left:2px;}
        .ar-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}
        .ar-title-with-count{display:inline-flex;align-items:center;gap:6px;}
        .ar-manual{display:flex;flex-direction:column;}
        .ar-manual-item{display:flex;align-items:center;justify-content:space-between;gap:8px;}
        .ar-manual-main{flex:1 1 0;min-width:0;}
        .ar-manual-meta{display:flex;align-items:center;gap:4px;min-width:0;}
        .ar-manual-meta .ar-when{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        .ar-vid{font-weight:600;flex:none;}
        .ar-manual-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        .ar-manual-title.is-empty{font-weight:400;color:var(--ink-3);}
        .ar-manual-actions{margin-left:auto;}
        .ar-btn-open{font-size:11px;font-weight:600;}
        .ar-remove-btn{display:flex;align-items:center;justify-content:center;}
        .ar-queue-more-btn{width:100%;height:30px;font-size:11.5px;font-weight:600;margin-top:2px;}
        .ar-empty{text-align:center;font-size:11.5px;border:1px dashed var(--line);line-height:1.4;}
        .ar-dropdown{position:relative;display:inline-block;}
        .ar-dropdown-menu{display:none;position:absolute;right:0;top:calc(100% + 4px);z-index:100;flex-direction:column;gap:2px;}
        .ar-dropdown.is-open .ar-dropdown-menu{display:flex;}
        .ar-dropdown-item{display:flex;align-items:center;width:100%;font-size:11.5px;font-weight:500;text-align:left;cursor:pointer;}
        #ar-main-panel, #ar-toggle-btn{--hha-bg:#f5f7fa;--hha-surface:#ffffff;--hha-surface-hover:#f8fafc;--hha-surface-subtle:#f1f4f8;--hha-text:#18212f;--hha-text-secondary:#596578;--hha-text-muted:#626f80;--hha-border:#e2e7ee;--hha-border-strong:#ccd4df;--hha-accent:#6863b3;--hha-accent-hover:#5d58a6;--hha-accent-soft:#f0eff9;--hha-accent-ring:rgba(98,91,215,.17);--hha-turbo-deep:#4843ad;--hha-success:#0d6d4f;--hha-success-soft:#eaf8f2;--hha-warning:#955f0f;--hha-warning-soft:#fff7e8;--hha-danger:#c33448;--hha-danger-hover:#aa263a;--hha-danger-soft:#fff0f2;--hha-shadow-raised:0 12px 34px rgba(24,33,47,.12),0 2px 8px rgba(24,33,47,.06);--hha-shadow-focus:0 0 0 3px var(--hha-accent-ring);--hha-shadow-control-focus:0 0 0 3px rgba(98,91,215,.14);--hha-ease-standard:cubic-bezier(.2,.72,.3,1);--hha-ease-premium:cubic-bezier(.18,.82,.22,1);--hha-duration-fast:120ms;--hha-duration-medium:200ms;--hh-green:var(--hha-success);--hh-blue:var(--hha-accent);--hh-blue-hover:var(--hha-accent-hover);--hh-blue-soft:var(--hha-accent-soft);--ink:var(--hha-text);--ink-2:var(--hha-text-secondary);--ink-3:var(--hha-text-muted);--line:var(--hha-border);--line-2:#edf0f4;--card:var(--hha-surface);--bg:var(--hha-bg);--bg-2:var(--hha-surface-subtle);}
        #ar-main-panel{background:var(--hha-bg);color:var(--hha-text);border-left:1px solid var(--hha-border);box-shadow:-3px 0 12px rgba(24,33,47,.055);font-size:13px;}
        #ar-main-panel a{color:var(--hha-accent);}
        #ar-toggle-btn{width:32px;height:112px;padding:0;border:1px solid rgba(255,255,255,.20);border-right:0;border-radius:10px 0 0 10px;background:linear-gradient(155deg,#7471b4 0%,#6866aa 52%,#5d5998 100%);box-shadow:-1px 2px 5px rgba(20,30,45,.09);overflow:hidden;transition:background-position 180ms var(--hha-ease-premium),filter 180ms var(--hha-ease-premium),box-shadow 180ms var(--hha-ease-premium);}
        #ar-toggle-btn:hover{background:linear-gradient(155deg,#7b77bc 0%,#625fa6 54%,#57528f 100%);box-shadow:-1px 3px 7px rgba(20,30,45,.105);}
        #ar-toggle-btn:active{box-shadow:-1px 1px 3px rgba(20,30,45,.09);filter:brightness(.97);}
        #ar-toggle-btn:focus-visible{outline:2px solid #fff;outline-offset:-3px;box-shadow:-1px 2px 5px rgba(20,30,45,.09),0 0 0 3px rgba(98,91,215,.18);}
        #ar-toggle-btn .ar-tab-text{display:block;writing-mode:horizontal-tb;transform:rotate(-90deg);white-space:nowrap;font-size:11px;line-height:1;font-weight:750;letter-spacing:.035em;text-shadow:0 1px 1px rgba(44,40,91,.16);}
        @keyframes ar-tab-running-breathe{0%,100%{background-position:0% 50%;filter:brightness(1) saturate(.96);box-shadow:-2px 3px 7px rgba(69,64,137,.16),-1px 1px 3px rgba(20,30,45,.08);}50%{background-position:100% 50%;filter:brightness(1.075) saturate(1.08);box-shadow:-4px 5px 12px rgba(78,70,157,.24),-1px 2px 4px rgba(20,30,45,.10);}}
        #ar-toggle-btn.is-running{background:linear-gradient(125deg,#7772bb 0%,#5f5aa2 30%,#7b74c1 58%,#57528f 100%);background-size:230% 230%;animation:ar-tab-running-breathe 2.2s var(--hha-ease-standard) infinite;}
        #ar-toggle-btn.is-running .ar-tab-text{text-shadow:0 1px 2px rgba(42,37,91,.22),0 0 5px rgba(255,255,255,.13);}
        #ar-toggle-btn.is-running:hover{animation-play-state:paused;background-position:76% 50%;filter:brightness(1.065) saturate(1.04);}
        .ar-header{border-bottom:1px solid var(--hha-border);box-shadow:0 1px 0 rgba(24,33,47,.018);}
        .ar-brand{gap:7px;}
        .ar-title{font-size:14.5px;font-weight:720;letter-spacing:-.025em;color:var(--hha-text);}
        .ar-lang-switcher{gap:1px;padding:2px;}
        .ar-lang-sep{display:none;}
        .ar-lang-btn{min-width:26px;height:22px;padding:0 6px;font-size:10.5px;font-weight:750;transition:background var(--hha-duration-fast) var(--hha-ease-premium),color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium);}
        .ar-lang-btn:focus-visible{outline:none;box-shadow:var(--hha-shadow-control-focus);}
        .ar-header-action{border:1px solid transparent;color:var(--hha-text-muted);transition:background var(--hha-duration-fast) var(--hha-ease-premium),border-color var(--hha-duration-fast) var(--hha-ease-premium),color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium),transform var(--hha-duration-fast) var(--hha-ease-premium);}
        .ar-header-action:hover{background:var(--hha-surface-subtle);border-color:var(--hha-border);color:var(--hha-text);box-shadow:0 2px 6px rgba(24,33,47,.055);}
        .ar-header-action:active{background:#e9edf3;box-shadow:0 1px 2px rgba(24,33,47,.04);transform:translateY(0);}
        .ar-header-action:focus-visible{outline:none;box-shadow:var(--hha-shadow-control-focus);color:var(--hha-accent);}
        .ar-status{min-height:23px;padding:3px 8px;border-radius:7px;border:1px solid var(--hha-border);background:var(--hha-surface-subtle);color:var(--hha-text-secondary);font-size:10px;font-weight:650;}
        .ar-status--idle{background:var(--hha-surface-subtle);color:var(--hha-text-secondary);border-color:var(--hha-border);}
        .ar-status--running{background:var(--hha-accent-soft);color:var(--hha-accent);border-color:#d3d0e9;}
        .ar-status--stopped{background:var(--hha-danger-soft);color:var(--hha-danger);border-color:#f3cbd1;}
        .ar-status--error{background:var(--hha-warning-soft);color:var(--hha-warning);border-color:#f3dfb6;}
        .ar-status--done{background:var(--hha-success-soft);color:var(--hha-success);border-color:#c8e9dc;}
        .ar-scroll{padding:11px;gap:9px;scrollbar-color:#c8d0db transparent;}
        .ar-scroll::-webkit-scrollbar-thumb{background:#c8d0db;border-radius:2px;}
        .ar-card{padding:13px 14px;gap:10px;border:1px solid var(--hha-border);}
        .ar-card-title{font-size:11px;font-weight:750;color:var(--hha-text-secondary);}
        .ar-card-head{min-height:22px;}
        #ar-mode-card{border-color:#dce2ea;box-shadow:0 1px 2px rgba(24,33,47,.05),0 12px 28px rgba(24,33,47,.035);overflow:visible;}
        .ar-work-mode-header{align-items:center;gap:10px;}
        .ar-work-mode-title{align-items:center;gap:8px;}
        .ar-work-mode-title__label{font-size:11px;font-weight:780;letter-spacing:.065em;color:var(--hha-text-secondary);}
        .ar-help-wrap{position:relative;display:inline-flex;align-items:center;flex:0 0 auto;}
        .ar-help-button{width:22px;height:22px;padding:0;border:1px solid var(--hha-border-strong);border-radius:7px;background:var(--hha-surface);color:var(--hha-text-muted);transition:background var(--hha-duration-fast) var(--hha-ease-standard),border-color var(--hha-duration-fast) var(--hha-ease-standard),color var(--hha-duration-fast) var(--hha-ease-standard),box-shadow var(--hha-duration-fast) var(--hha-ease-standard);}
        .ar-help-button::before{content:"";position:absolute;inset:-3px;}
        .ar-help-button:hover,.ar-help-wrap.is-pinned .ar-help-button{background:var(--hha-accent-soft);border-color:#d1cee8;color:var(--hha-accent);}
        .ar-help-button:focus-visible{outline:none;box-shadow:var(--hha-shadow-focus);border-color:var(--hha-accent);}
        .ar-help-popover{position:absolute;z-index:120;top:calc(100% + 8px);right:0;width:min(276px,calc(100vw - 42px));padding:10px;border:1px solid var(--hha-border);border-radius:11px;background:rgba(255,255,255,.992);box-shadow:var(--hha-shadow-raised);opacity:0;visibility:hidden;transform:translateY(-3px);pointer-events:none;transition:opacity var(--hha-duration-medium) var(--hha-ease-standard),transform var(--hha-duration-medium) var(--hha-ease-standard),visibility 0s linear var(--hha-duration-medium);}
        .ar-help-wrap.is-open .ar-help-popover{opacity:1;visibility:visible;transform:translateY(0);pointer-events:auto;transition-delay:0s;}
        .ar-help-popover-title{display:block;margin:0 0 5px;font-size:11.5px;line-height:1.3;font-weight:760;color:var(--hha-text);}
        .ar-help-popover-copy{display:block;font-size:11px;line-height:1.45;color:var(--hha-text-secondary);}
        .ar-mode-help-item{display:grid;grid-template-columns:76px 1fr;gap:8px;align-items:start;padding:7px;border-radius:9px;}
        .ar-mode-help-item + .ar-mode-help-item{border-top:1px solid #f0f2f6;}
        .ar-mode-help-name{font-size:11px;line-height:1.35;font-weight:760;color:var(--hha-text);letter-spacing:.005em;}
        .ar-mode-help-copy{font-size:11px;line-height:1.35;color:var(--hha-text-secondary);font-variant-numeric:tabular-nums;}
        .ar-mode-help-item--turbo .ar-mode-help-name{color:var(--hha-turbo-deep);}
        .ar-mode-help-note{display:block;margin-top:5px;padding:7px;border-top:1px solid #edf0f4;color:var(--hha-text-muted);font-size:10.5px;line-height:1.42;}
        .ar-work-mode-options{margin-top:-1px;}
        .ar-work-mode-option{display:flex;align-items:center;justify-content:center;min-width:0;height:24px;padding:0 4px;border:1px solid transparent;border-radius:7px;font-size:10.5px;font-weight:620;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background var(--hha-duration-fast) var(--hha-ease-premium),border-color var(--hha-duration-fast) var(--hha-ease-premium),color var(--hha-duration-fast) var(--hha-ease-premium),font-weight var(--hha-duration-fast) var(--hha-ease-premium);}
        .ar-work-mode-option[data-mode="safe"]{background:#f2f4f7;border-color:#e2e6eb;color:#6a7585;}
        .ar-work-mode-option[data-mode="balanced"]{background:#f5f3fa;border-color:#e5e1ef;color:#686581;}
        .ar-work-mode-option[data-mode="fast"]{background:#efedf8;border-color:#dcd7ec;color:#5f5a91;}
        .ar-work-mode-option[data-mode="turbo"]{background:#e9e6f5;border-color:#cec8e6;color:#554f8d;}
        .ar-work-mode-option.is-active{font-weight:780;box-shadow:inset 0 0 0 1px rgba(92,86,160,.12),0 1px 2px rgba(24,33,47,.04);}
        .ar-work-mode-option[data-mode="safe"].is-active{background:#eceff3;border-color:#bdc6d2;color:#3f4b5b;}
        .ar-work-mode-option[data-mode="balanced"].is-active{background:#eeebf6;border-color:#c9c3df;color:#514d7e;}
        .ar-work-mode-option[data-mode="fast"].is-active{background:#e7e3f4;border-color:#bdb6da;color:#4f4989;}
        .ar-work-mode-option[data-mode="turbo"].is-active{background:#dfdaf0;border-color:#aaa2d0;color:#453f80;}
        .ar-work-mode-slider{background:linear-gradient(90deg,#e8ebf0 0%,#edf0f4 58%,#f0f2f5 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.8),inset 0 0 0 1px rgba(24,33,47,.035);}
        .ar-work-mode-slider:hover:not(.is-turbo){box-shadow:inset 0 1px 0 rgba(255,255,255,.86),inset 0 0 0 1px rgba(24,33,47,.055);}
        .ar-work-mode-turbo-surface{background:linear-gradient(90deg,rgba(98,91,215,.10) 0%,rgba(98,91,215,.20) 28%,rgba(103,91,220,.38) 56%,rgba(91,79,202,.64) 80%,rgba(72,67,173,.86) 100%);transition:opacity var(--ar-work-turbo-exit-duration) var(--hha-ease-standard);}
        .ar-work-mode-slider.is-turbo .ar-work-mode-turbo-surface{transition:opacity var(--ar-work-turbo-reveal-duration) var(--hha-ease-premium);}
        .ar-work-mode-grid-mask{color:#fff;}
        .ar-work-mode-slider.is-turbo .ar-work-mode-grid-mask{opacity:.58;}
        .ar-work-mode-snap-marker{background:#728094;opacity:.17;}
        .ar-work-mode-slider:hover:not(.is-turbo) .ar-work-mode-snap-marker,.ar-work-mode-slider:focus-visible:not(.is-turbo) .ar-work-mode-snap-marker{opacity:.27;}
        .ar-work-mode-slider:focus-visible{box-shadow:inset 0 1px 0 rgba(255,255,255,.75),inset 0 0 0 1px rgba(24,33,47,.04),0 0 0 3px var(--hha-accent-ring);}
        .ar-row-limit{padding-top:9px;border-top:1px solid #eef1f5;}
        .ar-row-label{font-size:12px;color:var(--hha-text-secondary);}
        .ar-input,.ar-textarea{border:1px solid var(--hha-border);background:var(--hha-surface);color:var(--hha-text);box-shadow:inset 0 1px 0 rgba(255,255,255,.72);transition:border-color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium),background var(--hha-duration-fast) var(--hha-ease-premium),opacity var(--hha-duration-fast) var(--hha-ease-premium);}
        .ar-input{padding:6px 9px;font-weight:700;}
        .ar-input-num{width:70px;height:32px;}
        .ar-input:hover:not(:focus),.ar-textarea:hover:not(:focus){border-color:var(--hha-border-strong);box-shadow:inset 0 1px 0 rgba(255,255,255,.82),0 1px 3px rgba(24,33,47,.035);}
        .ar-input:focus,.ar-textarea:focus{border-color:var(--hha-accent);box-shadow:var(--hha-shadow-control-focus),inset 0 1px 0 rgba(255,255,255,.78);}
        .ar-textarea{min-height:62px;padding:8px 10px;font-size:12px;line-height:1.48;}
        .ar-textarea::placeholder{color:#a1aab8;}
        .ar-textarea:disabled{opacity:.68;}
        .ar-cover-counter.is-near{color:var(--hha-warning);}
        .ar-card--settings{overflow:visible;}
        .ar-switch-row-sub{position:relative;}
        .ar-setting-label-group{display:flex;align-items:center;gap:6px;min-width:0;}
        .ar-setting-label-group .ar-row-label{flex:0 1 auto;min-width:0;}
        .ar-warning-help-wrap{position:static;}
        .ar-autosave-feedback{display:flex;align-items:center;gap:6px;min-height:16px;color:var(--hha-text-muted);font-size:11px;line-height:1.3;}
        .ar-autosave-feedback::before{content:"";width:5px;height:5px;flex:0 0 5px;border-radius:50%;background:#98a2b1;box-shadow:0 0 0 2px rgba(152,162,177,.09);transition:background var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium);}
        .ar-autosave-feedback.is-saved{color:#5e5a91;}
        .ar-autosave-feedback.is-saved::before{background:#7873b4;box-shadow:0 0 0 2px rgba(104,99,179,.11);}
        .ar-switch input:focus-visible + i{box-shadow:var(--hha-shadow-control-focus);}
        .ar-btn{min-height:34px;border-radius:10px;padding:0 13px;border:1px solid transparent;font-size:12px;font-weight:680;transition:background var(--hha-duration-fast) var(--hha-ease-premium),border-color var(--hha-duration-fast) var(--hha-ease-premium),color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium),transform var(--hha-duration-fast) var(--hha-ease-premium);}
        .ar-btn:not(:disabled):hover{transform:none;}
        .ar-btn:focus-visible{outline:none;box-shadow:var(--hha-shadow-control-focus);}
        .ar-btn:disabled{opacity:.46;}
        .ar-btn-cta{height:40px;border-radius:11px;font-size:13px;font-weight:720;}
        .ar-btn-primary{background:var(--hha-accent);color:#fff;box-shadow:0 4px 12px rgba(82,76,154,.16);}
        .ar-btn-primary:hover{background:var(--hha-accent-hover);box-shadow:0 6px 16px rgba(82,76,154,.21);}
        .ar-btn-danger{background:var(--hha-danger);color:#fff;box-shadow:0 4px 12px rgba(195,52,72,.15);}
        .ar-btn-danger:hover{background:var(--hha-danger-hover);box-shadow:0 6px 16px rgba(195,52,72,.20);}
        .ar-btn-soft{background:var(--hha-surface);color:var(--hha-text-secondary);border-color:var(--hha-border);box-shadow:inset 0 1px 0 rgba(255,255,255,.72);}
        .ar-btn-soft:hover{background:var(--hha-surface-hover);color:var(--hha-text);border-color:var(--hha-border-strong);box-shadow:inset 0 1px 0 rgba(255,255,255,.82),0 2px 6px rgba(24,33,47,.055);}
        .ar-btn-soft:active{box-shadow:inset 0 1px 2px rgba(24,33,47,.07),0 1px 2px rgba(24,33,47,.035);}
        .ar-btn-tertiary{background:var(--hha-surface-subtle);border:1px solid var(--hha-border);box-shadow:inset 0 1px 0 rgba(255,255,255,.46);}
        .ar-btn-tertiary:hover{background:#e9edf3;color:var(--hha-text);border-color:var(--hha-border-strong);box-shadow:0 2px 5px rgba(24,33,47,.045);}
        .ar-btn-tertiary:active{box-shadow:inset 0 1px 2px rgba(24,33,47,.06);}
        .ar-btn-sm{min-height:29px;padding:0 10px;font-size:11px;border-radius:9px;}
        .ar-util-row{gap:7px;}
        .ar-util-btn{height:31px;}
        .ar-progress{height:5px;background:#edf0f4;border-radius:1.5px;}
        .ar-progress i{background:linear-gradient(90deg,var(--hha-accent) 0%,#7771c3 100%);transition:width 300ms var(--hha-ease-standard);}
        .ar-stats{grid-template-columns:repeat(4,1fr);border:1px solid var(--hha-border);border-radius:11px;}
        .ar-stat{padding:7px 3px;gap:3px;}
        .ar-stat-num{font-size:16px;font-weight:780;color:var(--hha-text-muted);}
        .ar-stat-cap{font-size:10.5px;font-weight:650;color:var(--hha-text-muted);}
        .ar-stat.is-active-attempts .ar-stat-num{color:var(--hha-text);}
        .ar-stat.is-active-success .ar-stat-num{color:var(--hha-success);}
        .ar-stat.is-active-skip{background:transparent;border-color:transparent;}
        .ar-stat.is-active-skip .ar-stat-num{color:var(--hha-text-secondary);}
        .ar-badge{min-width:19px;height:19px;padding:0 6px;border:1px solid var(--hha-border);border-radius:6px;background:var(--hha-surface-subtle);color:var(--hha-text-secondary);font-size:10px;font-weight:700;}
        .ar-badge-count{min-width:17px;height:17px;padding:0 5px;border:1px solid #d7d3e9;border-radius:5px;background:var(--hha-accent-soft);color:var(--hha-accent);font-size:10px;}
        .ar-manual{gap:6px;}
        .ar-manual-item{padding:8px 9px 8px 10px;border:1px solid var(--hha-border);border-radius:11px;background:var(--hha-surface-subtle);transition:background var(--hha-duration-fast) var(--hha-ease-premium),border-color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium);}
        .ar-manual-item:hover{background:var(--hha-surface);border-color:var(--hha-border-strong);box-shadow:0 2px 7px rgba(24,33,47,.045);}
        .ar-manual-meta{color:var(--hha-text-muted);font-size:10.5px;}
        .ar-vid{color:var(--hha-text-muted);}
        .ar-manual-main{display:flex;flex-direction:column;justify-content:center;min-height:40px;}
        .ar-manual-meta{margin-bottom:3px;line-height:1.2;}
        .ar-manual-title{color:var(--hha-text);font-size:11.5px;font-weight:650;line-height:1.25;}
        .ar-manual-actions{flex:0 0 auto;align-self:center;display:flex;align-items:center;gap:10px;}
        .ar-btn-open, .ar-remove-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;align-self:center;vertical-align:middle;line-height:1;}
        .ar-btn-open{min-height:34px;height:34px;padding:0 16px;border-radius:10px;}
        .ar-btn-open > span{display:block;line-height:1;}
        .ar-remove-btn{width:34px;min-width:34px;height:34px;min-height:34px;padding:0;border-radius:10px;}
        .ar-empty{padding:15px 10px;border-color:var(--hha-border);border-radius:11px;background:var(--hha-surface-subtle);color:var(--hha-text-muted);}
        .ar-diag-body{background:var(--hha-bg);container-type:inline-size;}
        .ar-diag-nav{gap:8px;}
        .ar-diag-view-title{font-size:13px;font-weight:720;color:var(--hha-text);}
        .ar-btn-back{gap:5px;padding:0 9px 0 7px;line-height:1;}
        .ar-diag-full-box{border:1px solid #253247;border-radius:11px;background:#111927;color:#aab6c8;box-shadow:inset 0 1px 0 rgba(255,255,255,.025),0 8px 20px rgba(17,25,39,.08);}
        .ar-dropdown-menu{padding:5px;min-width:188px;border:1px solid var(--hha-border);border-radius:11px;}
        .ar-dropdown-item{padding:7px 9px;border-radius:9px;transition:background var(--hha-duration-fast) var(--hha-ease-premium),color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium);}
        .ar-dropdown-item:focus-visible{outline:none;box-shadow:var(--hha-shadow-control-focus);color:var(--hha-text);}
        .ar-dropdown-item--danger{color:var(--hha-danger);}
        .ar-diag-header{min-height:47px;}
        .ar-diag-nav{flex:1 1 auto;min-width:0;}
        .ar-btn-back .ar-icon-svg{width:15px;height:15px;}
        .ar-diag-header-actions{flex:0 0 auto;}
        .ar-diag-body{flex:1 1 auto;min-height:0;gap:8px;padding:10px 10px 12px;overflow:hidden;}
        .ar-diag-filter-row{display:grid;grid-template-columns:max-content minmax(0,1fr);align-items:center;gap:8px;min-width:0;}
        .ar-diag-filter-group{display:inline-flex;align-items:center;flex:0 0 auto;padding:2px;border:1px solid var(--hha-border);border-radius:9px;background:var(--hha-surface-subtle);}
        .ar-diag-filter-btn{display:inline-flex;align-items:center;gap:5px;height:27px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:var(--hha-text-muted);font-family:inherit;font-size:10.5px;font-weight:700;cursor:pointer;transition:background var(--hha-duration-fast) var(--hha-ease-premium),color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium);}
        .ar-diag-filter-btn:hover{color:var(--hha-text);}
        .ar-diag-filter-btn.is-active{background:var(--hha-surface);color:var(--hha-text);box-shadow:0 1px 3px rgba(24,33,47,.08);}
        .ar-diag-filter-btn:focus-visible{outline:none;box-shadow:var(--hha-shadow-control-focus);}
        .ar-diag-filter-count{min-width:16px;padding:1px 4px;border-radius:5px;background:rgba(92,104,128,.08);color:inherit;font-size:10px;line-height:1.25;text-align:center;font-variant-numeric:tabular-nums;transition:opacity .15s ease,background .15s ease,color .15s ease;}
        .ar-diag-filter-btn.is-active .ar-diag-filter-count{background:var(--hha-accent-soft);color:var(--hha-accent);}
        #ar-diag-filter-errors:not(.has-errors) .ar-diag-filter-count{opacity:1;background:rgba(92,104,128,.055);color:var(--hha-text-muted);box-shadow:none;}
        #ar-diag-filter-errors:not(.has-errors).is-active .ar-diag-filter-count{background:rgba(92,104,128,.055);color:var(--hha-text-muted);}
        #ar-diag-filter-errors.has-errors .ar-diag-filter-count{opacity:1;background:var(--hha-danger-soft);color:var(--hha-danger);}
        .ar-diag-search-wrap{position:relative;display:flex;align-items:center;flex:1 1 auto;min-width:0;height:32px;border:1px solid var(--hha-border);border-radius:9px;background:var(--hha-surface);transition:border-color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium);}
        .ar-diag-search-wrap:focus-within{border-color:var(--hha-accent);box-shadow:0 0 0 3px var(--hha-accent-soft);}
        .ar-diag-search-icon{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:24px;height:24px;margin-left:3px;color:var(--hha-text-muted);line-height:0;}
        .ar-diag-search-icon .ar-icon-svg{width:14px;height:14px;}
        .ar-diag-search{width:100%;min-width:0;height:100%;padding:0 30px 0 6px;border:0;outline:0;background:transparent;color:var(--hha-text);font-family:inherit;font-size:11px;}
        .ar-diag-search::-webkit-search-cancel-button{display:none;}
        .ar-diag-search::placeholder{color:var(--hha-text-muted);}
        .ar-diag-search-clear{position:absolute;right:2px;top:50%;transform:translateY(-50%);width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--hha-text-muted);font-family:inherit;line-height:0;cursor:pointer;}
        .ar-diag-search-clear[hidden]{display:none;}
        .ar-diag-search-clear .ar-icon-svg{width:13px;height:13px;}
        .ar-diag-search-clear:hover{background:var(--hha-surface-subtle);color:var(--hha-text);}
        .ar-diag-toolbar{min-height:34px;display:grid;grid-template-columns:minmax(0,1fr) max-content;align-items:center;gap:6px 3px;padding-block:0;}
        .ar-diag-check-zone{display:flex;align-items:center;gap:3px;min-width:0;}
        .ar-diag-check-btn{min-width:0;padding-inline:10px;}
        .ar-diag-check-status{display:inline-flex;align-items:center;flex:0 0 auto;gap:2px;height:21px;white-space:nowrap;}
        .ar-diag-check-status:empty{display:none;}
        .ar-diag-check-progress{color:var(--hha-text-muted);font-size:10.5px;line-height:1;font-weight:700;font-variant-numeric:tabular-nums;}
        .ar-diag-check-ok{display:inline-flex;align-items:center;height:21px;padding:0 6px;border-radius:6px;background:rgba(31,142,102,.08);color:var(--hha-success);font-size:10.5px;line-height:1;font-weight:750;}
        .ar-diag-autoscroll{display:inline-flex;align-items:center;justify-self:end;gap:4px;min-height:34px;color:var(--hha-text-muted);font-size:10.5px;line-height:1.2;font-weight:650;cursor:pointer;user-select:none;white-space:nowrap;}
        .ar-diag-footer-actions{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;min-width:0;}
        .ar-diag-footer-actions > *{min-width:0;}
        .ar-diag-save-btn,.ar-diag-more-btn{width:100%;min-width:0;height:32px;padding-inline:9px;font-size:11px;letter-spacing:0;}
        .ar-diag-full-dropdown{display:block;min-width:0;}
        .ar-diag-full-box{flex:1 1 0;height:auto;min-height:120px;max-height:none;padding:5px 10px 5px 0;border-color:#26344a;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:#465870 #0d1725;font-family:inherit;font-size:10.5px;line-height:1.35;}
        .ar-diag-full-box::-webkit-scrollbar{width:9px;}
        .ar-diag-full-box::-webkit-scrollbar-button,.ar-diag-full-box::-webkit-scrollbar-button:single-button{-webkit-appearance:none;appearance:none;display:none;width:0;height:0;background:transparent;}
        .ar-diag-full-box::-webkit-scrollbar-button:vertical:start:decrement,.ar-diag-full-box::-webkit-scrollbar-button:vertical:end:increment{display:none!important;width:0!important;height:0!important;max-height:0!important;border:0!important;background:#0d1725!important;background-image:none!important;}
        .ar-diag-full-box::-webkit-scrollbar-track{background:#0d1725;border-left:1px solid rgba(148,163,184,.06);border-radius:0;}
        .ar-diag-full-box::-webkit-scrollbar-thumb{background:#465870;border:2px solid #0d1725;border-radius:999px;}
        .ar-diag-full-box::-webkit-scrollbar-thumb:hover{background:#5b6d86;}
        .ar-diag-full-box:focus-visible{outline:none;box-shadow:inset 0 0 0 1px rgba(129,140,248,.42),0 0 0 2px rgba(129,140,248,.11);}
        .ar-log-row{display:grid;grid-template-columns:max-content max-content minmax(0,1fr) max-content;align-items:start;column-gap:6px;row-gap:3px;padding:6px 9px;border-bottom:1px solid rgba(148,163,184,.075);color:#c0cad8;}
        .ar-log-row:last-child{border-bottom:0;}
        .ar-log-row:hover{background:rgba(148,163,184,.045);}
        .ar-log-row.is-error{background:rgba(255,90,110,.035);}
        .ar-log-row.is-warning{background:rgba(245,158,11,.025);}
        .ar-log-time{color:#8796aa;font-family:"SFMono-Regular",ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;white-space:nowrap;font-variant-numeric:tabular-nums;}
        .ar-log-level{display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:18px;padding:0 5px;border-radius:5px;font-size:10px;line-height:1;font-weight:800;letter-spacing:.035em;background:rgba(71,126,204,.13);color:#8bb9ff;text-transform:uppercase;}
        .ar-log-level--ok{background:rgba(52,211,153,.11);color:#72ddb9;}
        .ar-log-level--warn{background:rgba(245,158,11,.12);color:#f6c66c;}
        .ar-log-level--err{background:rgba(255,100,120,.15);color:#ff8797;}
        .ar-log-message{min-width:0;color:#bec8d7;overflow-wrap:anywhere;word-break:normal;white-space:pre-wrap;}
        .ar-log-row.is-error .ar-log-message{color:#ffc1ca;}
        .ar-log-row.is-warning .ar-log-message{color:#f6dbad;}
        .ar-log-repeat{align-self:center;min-width:34px;width:max-content;height:24px;padding:0 7px;border:1px solid rgba(148,163,184,.16);border-radius:999px;background:rgba(148,163,184,.07);color:#9aa9bd;font-family:inherit;font-size:10.5px;font-weight:800;cursor:pointer;font-variant-numeric:tabular-nums;}
        .ar-log-repeat:hover{border-color:rgba(165,180,252,.34);background:rgba(129,140,248,.11);color:#c7ccff;}
        .ar-log-repeat:focus-visible{outline:1px solid #9ca3ff;outline-offset:1px;}
        .ar-log-group-children{margin:0 8px 5px 121px;border-left:1px solid rgba(148,163,184,.15);}
        .ar-log-child{display:flex;gap:8px;padding:3px 7px;color:#8796aa;font-size:10.5px;}
        .ar-log-child-time{flex:0 0 66px;color:#8796aa;font-family:"SFMono-Regular",ui-monospace,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;}
        .ar-log-empty{display:flex;align-items:center;justify-content:center;height:100%;min-height:100%;padding:28px;color:#8796aa;text-align:center;}
        .ar-log-empty-inner{display:flex;flex-direction:column;align-items:center;gap:8px;max-width:240px;}
        .ar-log-empty-icon{width:48px;height:48px;margin-bottom:2px;color:#63738a;opacity:.72;}
        .ar-log-empty-icon svg{display:block;width:100%;height:100%;}
        .ar-log-empty-title{font-size:12.5px;line-height:1.25;font-weight:750;color:#b8c3d2;}
        .ar-log-empty-hint{max-width:220px;color:#8796aa;font-size:10.5px;line-height:1.5;}
        .ar-diag-full-dropdown .ar-dropdown-menu{right:0;left:auto;top:auto;bottom:calc(100% + 5px);}
        @media (max-height:720px){
          .ar-diag-body{gap:5px;padding-top:8px;padding-bottom:8px;}
          .ar-diag-full-box{min-height:88px;}
        }
        @media (max-width:420px){
          .ar-work-mode-popover{width:min(272px,calc(100vw - 42px));}
        }
        #ar-main-panel, #ar-toggle-btn{--hha-flat-border:#d6dde6;--hha-flat-border-hover:#c2cbd6;--hha-flat-border-active:#b9c3cf;--hha-flat-surface:#ffffff;--hha-flat-surface-hover:#f7f9fb;--hha-flat-surface-active:#eef2f6;--hha-flat-violet:#6964b8;--hha-flat-violet-hover:#625dae;--hha-flat-violet-active:#5b56a4;--hha-flat-violet-deep:#56518f;--hha-shadow-level-1:0 1px 2px rgba(20,30,45,.055);--hha-shadow-level-1-hover:0 1px 3px rgba(20,30,45,.07);--hha-focus-ring:0 0 0 3px rgba(98,91,215,.16);--hha-focus-ring-strong:0 0 0 3px rgba(98,91,215,.19);}
        .ar-btn, .ar-header-action, .ar-lang-btn, .ar-dropdown-item, .ar-help-button{transition-property:background-color,background,border-color,color,box-shadow,transform;transition-duration:150ms;transition-timing-function:var(--hha-ease-premium);}
        .ar-btn:not(:disabled):hover, .ar-header-action:hover, .ar-lang-btn:hover, .ar-dropdown-item:hover, .ar-help-button:hover{transform:none;}
        .ar-btn:not(:disabled):active{transform:translateY(1px);}
        .ar-header-action:active, .ar-lang-btn:active, .ar-dropdown-item:active, .ar-help-button:active{transform:none;}
        .ar-btn-soft, .ar-btn-tertiary{border:1px solid var(--hha-flat-border);background:var(--hha-flat-surface);color:#4f5b6b;box-shadow:var(--hha-shadow-level-1);}
        .ar-btn-soft:hover, .ar-btn-tertiary:hover{border-color:var(--hha-flat-border-hover);background:var(--hha-flat-surface-hover);color:var(--hha-text);box-shadow:var(--hha-shadow-level-1-hover);}
        .ar-btn-soft:active, .ar-btn-tertiary:active{border-color:var(--hha-flat-border-active);background:var(--hha-flat-surface-active);box-shadow:none;}
        .ar-btn-tertiary{border-style:solid;color:#5c6776;}
        #ar-start-btn{color:#fff;border:1px solid var(--hha-flat-violet-deep);background:var(--hha-flat-violet);text-shadow:none;box-shadow:0 2px 4px rgba(74,68,145,.12),0 1px 1px rgba(20,30,45,.04);}
        #ar-start-btn:hover{border-color:#514d88;background:var(--hha-flat-violet-hover);box-shadow:0 3px 6px rgba(74,68,145,.14),0 1px 2px rgba(20,30,45,.04);}
        #ar-start-btn:active{border-color:#4d4982;background:var(--hha-flat-violet-active);box-shadow:0 1px 2px rgba(74,68,145,.10);transform:translateY(1px);}
        #ar-stop-btn{color:#925267;border:1px solid #d7b4be;background:#fff;text-shadow:none;box-shadow:var(--hha-shadow-level-1);}
        #ar-stop-btn:hover{color:#84475b;border-color:#c99ca9;background:#fff8fa;box-shadow:var(--hha-shadow-level-1-hover);}
        #ar-stop-btn:active{color:#7e4053;border-color:#c08f9d;background:#f8eef1;box-shadow:none;transform:translateY(1px);}
        .ar-btn-open{color:#57538f;border:1px solid #d1cfe5;background:#f6f5fb;box-shadow:var(--hha-shadow-level-1);}
        .ar-btn-open:hover{color:#4e4a84;border-color:#bfbcda;background:#efedf8;box-shadow:var(--hha-shadow-level-1-hover);}
        .ar-btn-open:active{color:#49457d;border-color:#b4b0d1;background:#e9e7f3;box-shadow:none;transform:translateY(1px);}
        .ar-input, .ar-textarea{border:1px solid var(--hha-flat-border);background:#fff;color:var(--hha-text);box-shadow:var(--hha-shadow-level-1);}
        .ar-input:hover:not(:focus), .ar-textarea:hover:not(:focus){border-color:var(--hha-flat-border-hover);background:#fff;box-shadow:var(--hha-shadow-level-1-hover);}
        .ar-input:focus, .ar-textarea:focus{outline:none;border-color:#8c87d0;background:#fff;box-shadow:var(--hha-shadow-level-1);}
        .ar-input:focus-visible, .ar-textarea:focus-visible{border-color:#6c66bf;box-shadow:var(--hha-focus-ring),var(--hha-shadow-level-1);}
        .ar-textarea:disabled{border-color:#e0e5eb;background:#f3f5f8;box-shadow:none;}
        .ar-switch{width:38px;height:22px;}
        .ar-switch i{position:relative;overflow:hidden;border:1px solid #c4ccd6;background:linear-gradient(180deg,#dfe4ea 0%,#d6dde5 100%);box-shadow:inset 0 1px 2px rgba(35,47,63,.10),inset 0 -1px 0 rgba(255,255,255,.62);transition:background 180ms var(--hha-ease-premium),border-color 180ms var(--hha-ease-premium),box-shadow 150ms var(--hha-ease-premium);}
        .ar-switch i::after{box-sizing:border-box;top:2px;left:2px;width:16px;height:16px;border-radius:5px;transform:translateX(0);border:1px solid rgba(197,205,215,.78);background:linear-gradient(180deg,#fff 0%,#fafbfc 100%);box-shadow:0 1px 2px rgba(20,30,45,.16),0 2px 4px rgba(20,30,45,.06);transition:transform 180ms var(--hha-ease-premium),box-shadow 150ms var(--hha-ease-premium),background 150ms var(--hha-ease-premium);}
        .ar-switch-row:hover .ar-switch i{border-color:#b5bfcb;background:linear-gradient(180deg,#dbe1e7 0%,#d1d9e1 100%);box-shadow:inset 0 1px 2px rgba(35,47,63,.12),inset 0 -1px 0 rgba(255,255,255,.66);}
        .ar-switch-row:hover .ar-switch i::after{box-shadow:0 1px 3px rgba(20,30,45,.17),0 2px 5px rgba(20,30,45,.07);}
        .ar-switch input:checked + i{border-color:#5c579d;background:linear-gradient(180deg,#7470b7 0%,#6662aa 100%);box-shadow:inset 0 1px 2px rgba(47,42,102,.18),inset 0 -1px 0 rgba(255,255,255,.13);}
        .ar-switch-row:hover .ar-switch input:checked + i{border-color:#514c8c;background:linear-gradient(180deg,#716cb4 0%,#5e599f 100%);}
        .ar-switch input:checked + i::after{transform:translateX(16px);}
        .ar-switch input:active + i{box-shadow:inset 0 2px 3px rgba(35,47,63,.14);}
        .ar-switch input:active + i::after{background:#fafbfc;box-shadow:0 1px 2px rgba(20,30,45,.10);transform:translateX(0) scale(.96);}
        .ar-switch input:checked:active + i::after{transform:translateX(16px) scale(.96);}
        .ar-switch input:focus-visible + i, .ar-switch input:checked:focus-visible + i{box-shadow:var(--hha-focus-ring);}
        .ar-lang-switcher{border:1px solid #d8dfe7;background:#eef2f6;box-shadow:none;}
        .ar-lang-btn{border:1px solid transparent;background:transparent;color:#5f6b7a;box-shadow:none;}
        .ar-lang-btn:hover{border-color:transparent;background:#f7f9fb;color:#4d5969;box-shadow:none;}
        .ar-lang-btn:active{border-color:transparent;background:#e6ebf0;box-shadow:none;}
        .ar-lang-btn.is-active{border-color:#d7dee7;background:#fff;color:#263344;box-shadow:var(--hha-shadow-level-1);}
        .ar-header-action, .ar-help-button{border:1px solid var(--hha-flat-border);background:#fff;color:#687486;box-shadow:var(--hha-shadow-level-1);}
        .ar-header-action:hover, .ar-help-button:hover{border-color:var(--hha-flat-border-hover);background:var(--hha-flat-surface-hover);color:#2f3b4b;box-shadow:var(--hha-shadow-level-1-hover);}
        .ar-header-action:active, .ar-help-button:active{border-color:var(--hha-flat-border-active);background:var(--hha-flat-surface-active);box-shadow:none;}
        .ar-remove-btn{border:1px solid var(--hha-flat-border);background:#fff;color:#8a7680;box-shadow:var(--hha-shadow-level-1);}
        .ar-remove-btn:hover{border-color:#d8b8c0;background:#fff5f7;color:#a03f56;box-shadow:var(--hha-shadow-level-1-hover);transform:none;}
        .ar-remove-btn:active{border-color:#cca4af;background:#f8e8ec;box-shadow:none;transform:translateY(1px);}
        .ar-dropdown-menu{border-color:#d3dbe4;background:#fff;box-shadow:0 4px 12px rgba(20,30,45,.09),0 1px 2px rgba(20,30,45,.04);}
        .ar-dropdown-item{border:1px solid transparent;background:transparent;color:#596577;box-shadow:none;}
        .ar-dropdown-item:hover{border-color:transparent;background:#f2f5f8;color:#253244;box-shadow:none;}
        .ar-dropdown-item:active{background:#e8edf2;box-shadow:none;}
        .ar-dropdown-item--danger:hover{background:#fff1f3;color:var(--hha-danger-hover);}
        #ar-clear-manual, #ar-reset-history{color:#97485b;border-color:#dfc3ca;background:#fff;}
        #ar-clear-manual:hover, #ar-reset-history:hover{color:#873c50;border-color:#d4aeb8;background:#fff7f8;}
        #ar-clear-manual:focus-visible, #ar-reset-history:focus-visible{box-shadow:0 0 0 3px rgba(195,52,72,.13);}
        .ar-btn:focus-visible, .ar-header-action:focus-visible, .ar-lang-btn:focus-visible, .ar-dropdown-item:focus-visible, .ar-help-button:focus-visible{outline:none;box-shadow:var(--hha-focus-ring);}
        #ar-start-btn:focus-visible{box-shadow:var(--hha-focus-ring-strong),0 2px 4px rgba(74,68,145,.12);}
        #ar-stop-btn:focus-visible, .ar-btn-open:focus-visible{box-shadow:var(--hha-focus-ring),var(--hha-shadow-level-1);}
        .ar-work-mode-slider::after{content:"";position:absolute;z-index:4;top:0;bottom:0;left:0;width:19%;border-radius:11px;pointer-events:none;opacity:0;background:linear-gradient(90deg,
                rgba(235,238,243,.78) 0%,
                rgba(235,237,244,.61) 24%,
                rgba(231,232,244,.38) 48%,
                rgba(225,222,246,.17) 72%,
                rgba(225,222,246,0) 100%);transition:opacity var(--ar-work-turbo-reveal-duration) var(--hha-ease-premium);}
        .ar-work-mode-slider.is-turbo::after{opacity:1;}
        .ar-card:hover{transform:none;}
        .ar-stat{transition:none;}
        .ar-stat:hover{background:inherit;border-color:transparent;box-shadow:none;transform:none;}
        .ar-stat.is-active-success:hover{background:var(--hha-success-soft);border-color:#d0ebe0;}
        #ar-main-panel, #ar-toggle-btn{--hha-control-accent:#6866aa;}
        .ar-card{border-radius:11px;border-color:#d7dee7;background:linear-gradient(180deg,#fff 0%,#fdfefe 58%,#fafbfd 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,1),
                inset 0 -1px 0 rgba(76,89,106,.028),
                0 1px 2px rgba(24,33,47,.045),
                0 7px 18px rgba(24,33,47,.026);}
        .ar-card-title{letter-spacing:.05em;}
        .ar-header{min-height:47px;padding:9px 12px 9px 14px;background:rgba(252,253,254,.975);border-bottom-color:#dfe5ec;}
        .ar-header-right{gap:6px;}
        .ar-lang-switcher{border-radius:9px;}
        .ar-lang-btn{border-radius:7px;}
        .ar-header-action{border-radius:9px;}
        .ar-scroll--content{padding:10px 11px 9px;gap:9px;overscroll-behavior:contain;}
        .ar-card--settings, .ar-card--stats, .ar-card--manual{flex-shrink:0;}
        .ar-manual-toolbar{display:flex;gap:6px;}
        .ar-stat{border-radius:11px;}
        .ar-header-action{width:auto;min-width:0;height:28px;padding:0 9px;font-size:10.5px;font-weight:650;line-height:1;}
        .ar-help-button{font-size:0;line-height:0;}
        .ar-status{gap:0;}
        .ar-btn-open{gap:0;}
        .ar-remove-btn{width:auto;min-width:0;padding:0 10px;font-size:10.5px;font-weight:650;line-height:1;}
        .ar-stats{gap:3px;padding:4px;border-color:#d3dbe5;background:linear-gradient(180deg,#eef2f6 0%,#f3f6f9 100%);box-shadow:inset 0 2px 5px rgba(35,47,63,.055),inset 0 1px 0 rgba(255,255,255,.54);}
        .ar-stat{min-height:52px;border:1px solid transparent;background:transparent;}
        .ar-stat.is-active-success{background:linear-gradient(180deg,#f4fbf8 0%,var(--hha-success-soft) 100%);border-color:#d0e9df;box-shadow:inset 0 1px 0 rgba(255,255,255,.76);}
        .ar-stat.is-active-manual{background:linear-gradient(180deg,#f8f8fd 0%,#f0f0fa 100%);border-color:#dcdced;box-shadow:inset 0 1px 0 rgba(255,255,255,.8);}
        .ar-stat.is-active-manual .ar-stat-num{color:var(--hha-control-accent);}
        .ar-execution-shell{position:relative;z-index:20;flex:0 0 auto;padding:7px 11px 11px;border-radius:11px;border-top:1px solid rgba(215,222,231,.78);background:linear-gradient(180deg,rgba(248,250,252,.70) 0%,rgba(248,250,252,.97) 18%,var(--hha-bg) 100%);box-shadow:0 -9px 20px rgba(24,33,47,.025);}
        .ar-execution-shell::before{content:"";position:absolute;left:11px;right:11px;top:-8px;height:14px;pointer-events:none;background:linear-gradient(180deg,rgba(248,250,252,0),rgba(248,250,252,.92));}
        #ar-mode-card.ar-execution-core{position:relative;z-index:1;padding:12px 13px 11px;gap:8px;overflow:visible;border-radius:11px;border-color:#cfd8e4;background:linear-gradient(180deg,#ffffff 0%,#fdfefe 46%,#f8fafc 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,1),
                inset 0 -1px 0 rgba(77,89,108,.045),
                0 2px 4px rgba(24,33,47,.055),
                0 10px 24px rgba(49,54,88,.055);transition:border-color 220ms var(--hha-ease-premium),
                box-shadow 220ms var(--hha-ease-premium),
                background 220ms var(--hha-ease-premium);}
        #ar-mode-card.ar-execution-core.is-running{border-color:#bebee0;background:linear-gradient(180deg,#fff 0%,#fdfdff 45%,#f7f7fc 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,1),
                inset 0 -1px 0 rgba(92,88,167,.055),
                0 2px 4px rgba(24,33,47,.055),
                0 11px 26px rgba(76,72,145,.09);}
        #ar-mode-card.ar-execution-core[data-mode="turbo"]{border-color:#c9c5ec;box-shadow:inset 0 1px 0 rgba(255,255,255,1),
                inset 0 -1px 0 rgba(98,91,215,.07),
                0 2px 4px rgba(24,33,47,.055),
                0 11px 28px rgba(84,77,171,.09);}
        .ar-execution-core .ar-help-popover{top:auto;bottom:calc(100% + 8px);transform:translateY(3px);}
        .ar-execution-core .ar-help-wrap.is-open .ar-help-popover{transform:translateY(0);}
        .ar-execution-limit{padding-top:8px;border-top:1px solid #e9edf2;}
        .ar-execution-limit .ar-row-label{font-size:11.5px;font-weight:590;color:#647083;}
        .ar-execution-limit .ar-input-num{width:68px;height:30px;border-radius:9px;}
        .ar-execution-runtime{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:24px;}
        .ar-execution-runtime .ar-status{min-height:22px;max-width:none;padding:3px 8px;background:#f1f4f7;border-color:#d4dce6;box-shadow:none;}
        .ar-execution-core.is-running .ar-status--running{color:#5c5998;border-color:#cecee6;background:#f1f0fa;}
        .ar-execution-count{height:22px;border-radius:7px;min-width:50px;padding:0 8px;border-color:#d4dce6;background:#fff;color:#596577;box-shadow:0 1px 2px rgba(20,30,45,.04);font-variant-numeric:tabular-nums;}
        .ar-execution-progress{height:4px;border-radius:1px;background:#e8ecf1;box-shadow:none;opacity:.72;transition:opacity 180ms var(--hha-ease-premium),background 180ms var(--hha-ease-premium);}
        .ar-execution-progress i{border-radius:1px;background:linear-gradient(90deg,#7773b4 0%,#6866aa 58%,#625bd7 100%);box-shadow:none;}
        .ar-execution-core.is-running .ar-execution-progress{opacity:1;background:#e4e5ed;}
        .ar-execution-actions{display:flex;flex-direction:column;gap:7px;}
        .ar-execution-actions #ar-start-btn, .ar-execution-actions #ar-stop-btn{border-radius:11px;}
        .ar-execution-utils{gap:7px;}
        .ar-execution-utils .ar-util-btn{height:30px;min-height:30px;border-radius:9px;}
        .ar-sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important;}
        .ar-cover-editor{position:relative;}
        .ar-cover-editor .ar-textarea{display:block;padding-right:64px;padding-bottom:18px;}
        .ar-cover-editor .ar-cover-counter{position:absolute;right:12px;bottom:6px;z-index:1;line-height:1;pointer-events:none;}
        .ar-card--stats{padding:0;border:0;background:transparent;box-shadow:none;overflow:visible;}
        .ar-card--stats .ar-stats{min-height:58px;}
        .ar-execution-meta{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:8px;border-top:1px solid #e9edf2;}
        .ar-execution-meta .ar-execution-runtime{flex:0 0 auto;min-height:0;}
        .ar-execution-meta .ar-execution-limit{flex:0 1 auto;min-width:0;padding-top:0;border-top:0;gap:7px;}
        .ar-execution-meta .ar-execution-limit .ar-row-label{flex:0 1 auto;min-width:0;white-space:nowrap;font-size:10.5px;}
        .ar-execution-meta .ar-execution-limit .ar-input-num{width:60px;}
        .ar-work-mode-thumb__body{border-radius:9px;border-color:rgba(72,84,100,.14);background:#fff;box-shadow:none;}
        .ar-work-mode-slider.is-turbo .ar-work-mode-thumb__body{border-color:rgba(98,91,215,.30);background:#fbfaff;box-shadow:none;}
        .ar-work-mode-thumb__shadow{border-radius:9px;box-shadow:0 2px 5px rgba(20,30,45,.09),0 1px 2px rgba(20,30,45,.05);}
        .ar-work-mode-slider:hover .ar-work-mode-thumb__shadow{box-shadow:0 3px 6px rgba(20,30,45,.10),0 1px 2px rgba(20,30,45,.05);}
        /* Canonical icon sizing and narrow-control containment. */
        #ar-main-panel{border-radius:0;}
        #ar-main-panel > .ar-view > .ar-header{border-radius:0;}
        .ar-icon-only{display:inline-flex;align-items:center;justify-content:center;padding:0;white-space:nowrap;}
        .ar-icon-svg{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;line-height:0;flex:none;pointer-events:none;}
        .ar-icon-svg svg{display:block;width:100%;height:100%;}
        .ar-icon-svg--trash{transform:translateY(-.25px);}
        .ar-header-action.ar-icon-only{width:28px;min-width:28px;height:28px;padding:0;font-size:0;}
        .ar-help-button.ar-icon-only{width:22px;min-width:22px;height:22px;padding:0;font-size:0;}
        .ar-help-button.ar-icon-only .ar-icon-svg{width:14px;height:14px;}
        .ar-remove-btn.ar-icon-only{width:34px;min-width:34px;height:34px;min-height:34px;padding:0;font-size:0;}
        .ar-remove-btn.ar-icon-only .ar-icon-svg{width:14px;height:14px;}
        .ar-brand{flex:1 1 auto;min-width:0;overflow:hidden;}
        .ar-title{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;}
        .ar-header-right{flex:0 0 auto;}
        .ar-card-head{min-width:0;}
        .ar-title-with-count{flex:1 1 auto;min-width:0;overflow:hidden;}
        .ar-title-with-count .ar-card-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        .ar-title-with-count .ar-badge{flex:0 0 auto;}
        .ar-manual-toolbar{flex:0 0 auto;min-width:0;}
        .ar-manual-item{min-width:0;}
        .ar-manual-actions{min-width:0;gap:8px;}
        .ar-btn-open{max-width:84px;overflow:hidden;text-overflow:ellipsis;}
        .ar-stat-cap{display:block;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-inline:2px;}
        .ar-switch-row > .ar-card-title, .ar-switch-row > .ar-row-label{min-width:0;overflow-wrap:anywhere;}
        .ar-work-mode-header{align-items:center;gap:8px;}
        .ar-work-mode-title{flex:1 1 auto;min-width:0;align-items:center;gap:7px;overflow:hidden;}
        .ar-work-mode-title__label{min-width:0;overflow:hidden;text-overflow:ellipsis;}
        .ar-execution-runtime{min-width:0;}
        .ar-execution-meta .ar-execution-limit{flex:0 1 auto;}
        .ar-execution-actions .ar-btn > span, .ar-manual-toolbar .ar-btn{min-width:0;overflow:hidden;text-overflow:ellipsis;}
        .ar-diag-header .ar-diag-nav{overflow:hidden;}
        .ar-diag-view-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        .ar-diag-filter-row{gap:8px;}
        .ar-diag-filter-group{min-width:0;}
        .ar-diag-filter-btn{min-width:0;}
        .ar-diag-filter-btn > span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        .ar-diag-filter-count{flex:0 0 auto;}
        .ar-diag-search-wrap{min-width:118px;}
        .ar-diag-toolbar{align-items:center;gap:6px 3px;}
        .ar-diag-check-zone{overflow:hidden;}
        .ar-diag-check-btn{flex:0 1 auto;max-width:150px;overflow:hidden;text-overflow:ellipsis;}
        .ar-diag-check-status{min-width:0;overflow:hidden;}
        .ar-diag-more-btn{overflow:visible;}
        .ar-diag-more-btn > span{display:block;max-width:100%;line-height:1;white-space:nowrap;}
        .ar-diag-check-zone{flex-wrap:wrap;overflow:visible;}
        .ar-diag-check-btn,.ar-diag-save-btn{flex:0 0 auto;max-width:none;overflow:visible;text-overflow:clip;}
        html.hha-compact #ar-main-panel .ar-header{padding-inline:10px;}
        html.hha-compact #ar-main-panel .ar-scroll--content{padding-inline:10px;}
        html.hha-compact #ar-main-panel .ar-card{padding-inline:10px;}
        html.hha-compact #ar-main-panel .ar-card-head{gap:6px;}
        html.hha-compact #ar-main-panel .ar-manual-toolbar{gap:4px;}
        html.hha-compact #ar-main-panel .ar-manual-actions{gap:6px;}
        html.hha-compact #ar-main-panel .ar-execution-shell{left:10px;right:10px;}
        html.hha-compact #ar-main-panel .ar-diag-filter-row{gap:6px;}
        html.hha-compact #ar-main-panel .ar-diag-toolbar{column-gap:6px;}
        @container (max-width:350px){
          .ar-log-row{grid-template-columns:max-content minmax(84px,1fr) max-content;}
          .ar-log-time{grid-column:1 / -1;}
          .ar-log-level{grid-column:1;grid-row:2;}
          .ar-log-message{grid-column:2;grid-row:2;}
          .ar-log-repeat{grid-column:3;grid-row:2;}
          .ar-log-group-children{margin-left:8px;}
        }
        @container (max-width:315px){
          .ar-diag-filter-row,.ar-diag-toolbar{grid-template-columns:minmax(0,1fr);}
          .ar-diag-autoscroll{justify-self:start;}
        }
        @container (max-width:229px){
          .ar-diag-footer-actions{grid-template-columns:minmax(0,1fr);}
        }
        @media (max-height:720px){
          .ar-scroll--content{padding-top:8px;gap:7px;}
          .ar-execution-shell{padding-top:5px;padding-bottom:8px;}
          #ar-mode-card.ar-execution-core{padding:10px 12px 9px;gap:7px;}
          .ar-work-mode-options{gap:3px;}
          .ar-work-mode-option{height:22px;font-size:10px;}
          .ar-execution-meta{padding-top:6px;}
          .ar-execution-limit{padding-top:0;}
          .ar-execution-actions{gap:6px;}
          .ar-execution-utils .ar-util-btn{height:28px;min-height:28px;}
        }
        @media (prefers-reduced-motion: reduce){
          .ar-work-mode-thumb, .ar-work-mode-thumb__body, .ar-work-mode-thumb__shadow, .ar-work-mode-turbo-surface, .ar-work-mode-grid-mask, .ar-work-mode-option, .ar-work-mode-snap-marker{transition-duration:1ms!important;}
          .ar-work-mode-thumb__body{transform:none!important;}
          .ar-work-mode-grid-strip{animation:none!important;}
          .ar-work-mode-grid-cell{transform:none!important;opacity:var(--cell-alpha, .15)!important;}
          #ar-main-panel *, #ar-toggle-btn, #ar-toggle-btn *{animation:none!important;transition:none!important;}
          .ar-btn, .ar-header-action{transform:none!important;}
          #ar-toggle-btn.is-running{background:linear-gradient(155deg,#7a75bb 0%,#6661aa 52%,#56518e 100%);filter:brightness(1.045) saturate(1.035);box-shadow:-3px 4px 10px rgba(76,70,151,.22),-1px 2px 4px rgba(20,30,45,.09);}
        }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function buildPanelHtml() {
        const lang = I18n.getLanguage();
        const curPreset = PRESETS[config.preset] ? config.preset : DEFAULT_PRESET;
        const curIndex = modeKeyToIndex(curPreset);
        const curLabel = presetLabel(curPreset);
        const sentCount = State.getSentCount();
        const effectiveLimit = Math.max(config.limit, sentCount);

        return `
            <div id="ar-view-main" class="ar-view ar-view--main">
                <div class="ar-header">
                    <div class="ar-brand">
                        <span class="ar-title">HH Apply Assistant</span>
                    </div>
                    <div class="ar-header-right">
                        <div class="ar-lang-switcher" role="group" aria-label="${I18n.t('panel.langSwitchLabel')}">
                            <button type="button" class="ar-lang-btn${lang === 'ru' ? ' is-active' : ''}" data-lang="ru" aria-pressed="${lang === 'ru'}">RU</button>
                            <span class="ar-lang-sep" aria-hidden="true">|</span>
                            <button type="button" class="ar-lang-btn${lang === 'en' ? ' is-active' : ''}" data-lang="en" aria-pressed="${lang === 'en'}">EN</button>
                        </div>
                        <button id="ar-minimize-btn" class="ar-header-action ar-icon-only" title="${I18n.t('panel.minimizeTitle')}" aria-label="${I18n.t('panel.minimizeTitle')}">${uiIcon('chevronDown')}</button>
                    </div>
                </div>

                <div class="ar-scroll ar-scroll--content">
                    <section class="ar-card ar-card--settings">
                        <label class="ar-switch-row" for="ar-use-cover-check">
                            <span class="ar-card-title" id="ar-cover-card-title" style="margin:0;">${I18n.t('cover.title')}</span>
                            <span class="ar-switch"><input type="checkbox" id="ar-use-cover-check"><i></i></span>
                        </label>
                        <div class="ar-cover-editor">
                            <textarea id="ar-cover-text" class="ar-textarea" rows="3" maxlength="5000" aria-labelledby="ar-cover-card-title" placeholder="${I18n.t('cover.placeholder')}"></textarea>
                            <span id="ar-cover-counter" class="ar-cover-counter">0 / 5000</span>
                        </div>
                        <div class="ar-switch-row ar-switch-row-sub" id="ar-apply-reject-wrap">
                            <span class="ar-setting-label-group">
                                <label class="ar-row-label" id="ar-apply-reject-label" for="ar-apply-reject-check">${I18n.t('cover.rejectWarningLabel')}</label>
                                <span class="ar-help-wrap ar-warning-help-wrap" id="ar-warning-help-wrap">
                                    <button class="ar-help-button ar-icon-only" id="ar-warning-help-btn" type="button" aria-label="${I18n.t('cover.rejectWarningHelpAria')}" aria-describedby="ar-warning-help-popover" aria-controls="ar-warning-help-popover" aria-expanded="false">${uiIcon('help')}</button>
                                    <span class="ar-help-popover" id="ar-warning-help-popover" role="tooltip" aria-hidden="true">
                                        <strong class="ar-help-popover-title" id="ar-warning-help-title">${I18n.t('cover.rejectWarningHelpTitle')}</strong>
                                        <span class="ar-help-popover-copy" id="ar-warning-help-text">${I18n.t('cover.rejectWarningHelpText')}</span>
                                    </span>
                                </span>
                            </span>
                            <label class="ar-switch" for="ar-apply-reject-check"><input type="checkbox" id="ar-apply-reject-check"><i></i></label>
                        </div>
                        <div class="ar-autosave-feedback" id="ar-autosave-feedback" role="status" aria-live="polite">
                            <span id="ar-autosave-text">${I18n.t('panel.autosaveIdle')}</span>
                        </div>
                    </section>

                    <section class="ar-card ar-card--stats" aria-labelledby="ar-stats-card-title">
                        <span class="ar-card-title ar-sr-only" id="ar-stats-card-title">${I18n.t('panel.statsTitle')}</span>
                        <div class="ar-stats">
                            <div class="ar-stat" id="ar-stat-tile-attempts">
                                <span class="ar-stat-num" id="ar-stat-attempts">0</span>
                                <span class="ar-stat-cap" id="ar-stat-cap-attempts">${I18n.t('panel.statAttempts')}</span>
                            </div>
                            <div class="ar-stat" id="ar-stat-tile-success">
                                <span class="ar-stat-num" id="ar-stat-success">0</span>
                                <span class="ar-stat-cap" id="ar-stat-cap-success">${I18n.t('panel.statSuccess')}</span>
                            </div>
                            <div class="ar-stat" id="ar-stat-tile-manual">
                                <span class="ar-stat-num" id="ar-stat-manual">0</span>
                                <span class="ar-stat-cap" id="ar-stat-cap-manual">${I18n.t('panel.statManual')}</span>
                            </div>
                            <div class="ar-stat" id="ar-stat-tile-skip">
                                <span class="ar-stat-num" id="ar-stat-skipped">0</span>
                                <span class="ar-stat-cap" id="ar-stat-cap-skipped">${I18n.t('panel.statSkipped')}</span>
                            </div>
                        </div>
                    </section>

                    <section class="ar-card ar-card--manual">
                        <div class="ar-card-head">
                            <div class="ar-title-with-count">
                                <span class="ar-card-title" id="ar-manual-card-title">${I18n.t('panel.manualTitle')}</span>
                                <span id="ar-manual-count" class="ar-badge" data-has="0" title="${I18n.t('panel.manualCountTitle')}">0</span>
                            </div>
                            <div class="ar-manual-toolbar">
                                <button id="ar-export-manual" class="ar-btn ar-btn-soft ar-btn-sm">${I18n.t('panel.manualExport')}</button>
                                <button id="ar-clear-manual" class="ar-btn ar-btn-soft ar-btn-sm">${I18n.t('panel.manualClear')}</button>
                            </div>
                        </div>
                        <div id="ar-manual-list" class="ar-manual"></div>
                    </section>
                </div>

                <div class="ar-execution-shell">
                    <section class="ar-card ar-work-mode-card ar-execution-core" id="ar-mode-card" data-mode="${curPreset}" data-runtime-state="idle">
                        <div class="ar-work-mode-header">
                            <div class="ar-work-mode-title" id="ar-work-mode-heading">
                                <span class="ar-work-mode-title__label" id="ar-work-mode-label">${I18n.t('panel.modeTitle')}</span>
                            </div>
                            <div class="ar-help-wrap ar-work-mode-help-wrap" id="ar-work-mode-help-wrap">
                                <button
                                    class="ar-help-button ar-icon-only"
                                    id="ar-work-mode-help-btn"
                                    type="button"
                                    aria-label="${I18n.t('panel.modeHelpAria')}"
                                    aria-describedby="ar-work-mode-popover"
                                    aria-controls="ar-work-mode-popover"
                                    aria-expanded="false"
                                >${uiIcon('help')}</button>
                                <div class="ar-help-popover ar-work-mode-popover" id="ar-work-mode-popover" role="tooltip" aria-hidden="true">
                                    <strong class="ar-help-popover-title" id="ar-mode-help-title">${I18n.t('panel.modeHelpTitle')}</strong>
                                    <div class="ar-mode-help-item">
                                        <strong class="ar-mode-help-name" id="ar-mode-help-safe-title">${I18n.t('panel.modeHelpSafeTitle')}</strong>
                                        <span class="ar-mode-help-copy" id="ar-mode-help-safe-text">${I18n.t('panel.modeHelpSafeText')}</span>
                                    </div>
                                    <div class="ar-mode-help-item">
                                        <strong class="ar-mode-help-name" id="ar-mode-help-balanced-title">${I18n.t('panel.modeHelpBalancedTitle')}</strong>
                                        <span class="ar-mode-help-copy" id="ar-mode-help-balanced-text">${I18n.t('panel.modeHelpBalancedText')}</span>
                                    </div>
                                    <div class="ar-mode-help-item">
                                        <strong class="ar-mode-help-name" id="ar-mode-help-fast-title">${I18n.t('panel.modeHelpFastTitle')}</strong>
                                        <span class="ar-mode-help-copy" id="ar-mode-help-fast-text">${I18n.t('panel.modeHelpFastText')}</span>
                                    </div>
                                    <div class="ar-mode-help-item ar-mode-help-item--turbo">
                                        <strong class="ar-mode-help-name" id="ar-mode-help-turbo-title">${I18n.t('panel.modeHelpTurboTitle')}</strong>
                                        <span class="ar-mode-help-copy" id="ar-mode-help-turbo-text">${I18n.t('panel.modeHelpTurboText')}</span>
                                    </div>
                                    <span class="ar-mode-help-note" id="ar-mode-help-note">${I18n.t('panel.modeHelpNote')}</span>
                                </div>
                            </div>
                        </div>

                        <div
                            class="ar-work-mode-slider${curPreset === 'turbo' ? ' is-turbo' : ''}"
                            id="ar-work-mode-slider"
                            role="slider"
                            tabindex="0"
                            aria-label="${I18n.t('panel.modeTitle')}"
                            aria-valuemin="0"
                            aria-valuemax="3"
                            aria-valuenow="${curIndex}"
                            aria-valuetext="${curLabel}"
                            data-value="${curIndex}"
                        >
                            <div class="ar-work-mode-turbo-surface" aria-hidden="true"></div>
                            <div class="ar-work-mode-grid-mask" aria-hidden="true">
                                <div class="ar-work-mode-grid-strip" id="ar-work-mode-grid-strip"></div>
                            </div>
                            <div class="ar-work-mode-snap-markers" id="ar-work-mode-snap-markers" aria-hidden="true">
                                <span class="ar-work-mode-snap-marker"></span>
                                <span class="ar-work-mode-snap-marker"></span>
                                <span class="ar-work-mode-snap-marker"></span>
                                <span class="ar-work-mode-snap-marker"></span>
                            </div>
                            <div class="ar-work-mode-thumb" id="ar-work-mode-thumb" aria-hidden="true">
                                <div class="ar-work-mode-thumb__shadow" id="ar-work-mode-thumb-shadow" aria-hidden="true"></div>
                                <div class="ar-work-mode-thumb__body" id="ar-work-mode-thumb-body" aria-hidden="true"></div>
                            </div>
                        </div>

                        <div class="ar-work-mode-options" aria-hidden="true">
                            <span class="ar-work-mode-option${curPreset === 'safe' ? ' is-active' : ''}" id="ar-work-mode-option-safe" data-mode="safe">${I18n.t('presets.safe.label')}</span>
                            <span class="ar-work-mode-option${curPreset === 'balanced' ? ' is-active' : ''}" id="ar-work-mode-option-balanced" data-mode="balanced">${I18n.t('presets.balanced.label')}</span>
                            <span class="ar-work-mode-option${curPreset === 'fast' ? ' is-active' : ''}" id="ar-work-mode-option-fast" data-mode="fast">${I18n.t('presets.fast.label')}</span>
                            <span class="ar-work-mode-option${curPreset === 'turbo' ? ' is-active' : ''}" id="ar-work-mode-option-turbo" data-mode="turbo">${I18n.t('presets.turbo.label')}</span>
                        </div>

                        <div class="ar-execution-meta">
                            <div class="ar-execution-runtime">
                                <span id="ar-status-text" class="ar-status ar-status--idle" role="status">${I18n.t('status.idle')}</span>
                                <span id="ar-stat-progress" class="ar-badge ar-execution-count" title="${I18n.t('panel.statsProgressTitle')}">${sentCount} / ${effectiveLimit}</span>
                            </div>
                            <div class="ar-row ar-row-limit ar-execution-limit">
                                <label class="ar-row-label" id="ar-limit-label" for="ar-limit-input" title="${I18n.t('panel.limitLabel')}">${I18n.t('panel.limitShort')}</label>
                                <input type="number" id="ar-limit-input" class="ar-input ar-input-num" min="${Math.max(1, sentCount)}" max="500">
                            </div>
                        </div>
                        <div id="ar-execution-progress" class="ar-progress ar-execution-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${effectiveLimit}" aria-valuenow="${sentCount}" aria-label="${I18n.t('panel.statsProgressTitle')}"><i id="ar-progress-fill" aria-hidden="true"></i></div>

                        <div class="ar-execution-actions">
                            <button id="ar-start-btn" class="ar-btn ar-btn-primary ar-btn-cta">
                                <span id="ar-start-btn-text">${I18n.t('panel.startBtn')}</span>
                            </button>
                            <button id="ar-stop-btn" class="ar-btn ar-btn-danger ar-btn-cta" style="display:none;">
                                <span id="ar-stop-btn-text">${I18n.t('panel.stopBtn')}</span>
                            </button>
                            <div class="ar-util-row ar-execution-utils">
                                <button id="ar-reset-history" class="ar-btn ar-btn-tertiary ar-btn-sm ar-util-btn" title="${I18n.t('panel.resetHistoryTitle')}">
                                    <span id="ar-reset-history-text">${I18n.t('panel.resetHistory')}</span>
                                </button>
                                <button id="ar-health-btn" class="ar-btn ar-btn-soft ar-btn-sm ar-util-btn" title="${I18n.t('panel.diagnosticsTitle')}">
                                    <span id="ar-health-btn-text">${I18n.t('panel.diagnostics')}</span>
                                    <span id="ar-health-badge" class="ar-badge-count" style="display:none;"></span>
                                </button>
                            </div>
                        </div>
                    </section>
                </div>
            </div>

            <div id="ar-view-diag" class="ar-view ar-view--diag" style="display:none;">
                <div class="ar-header ar-diag-header">
                    <div class="ar-diag-nav">
                        <button id="ar-diag-back-btn" class="ar-btn ar-btn-soft ar-btn-sm ar-btn-back" type="button" title="${I18n.t('diag.backTitle')}">
                            ${uiIcon('arrowLeft')}
                            <span id="ar-diag-back-text">${I18n.t('diag.backBtn')}</span>
                        </button>
                        <span class="ar-diag-view-title" id="ar-diag-view-title">${I18n.t('diag.title')}</span>
                    </div>
                    <div class="ar-header-right ar-diag-header-actions">
                        <button id="ar-minimize-diag-btn" class="ar-header-action ar-icon-only" title="${I18n.t('panel.minimizeTitle')}" aria-label="${I18n.t('panel.minimizeTitle')}">${uiIcon('chevronDown')}</button>
                    </div>
                </div>
                <div class="ar-diag-body">
                    <div class="ar-diag-filter-row">
                        <div id="ar-diag-filter-group" class="ar-diag-filter-group" role="group" aria-label="${I18n.t('diag.filterLabel')}">
                            <button id="ar-diag-filter-all" class="ar-diag-filter-btn is-active" type="button" aria-pressed="true">
                                <span id="ar-diag-filter-all-text">${I18n.t('diag.filterAll')}</span>
                                <span id="ar-diag-filter-all-count" class="ar-diag-filter-count">0</span>
                            </button>
                            <button id="ar-diag-filter-errors" class="ar-diag-filter-btn" type="button" aria-pressed="false">
                                <span id="ar-diag-filter-errors-text">${I18n.t('diag.filterErrors')}</span>
                                <span id="ar-diag-filter-errors-count" class="ar-diag-filter-count">0</span>
                            </button>
                        </div>
                        <div class="ar-diag-search-wrap">
                            <span class="ar-diag-search-icon" aria-hidden="true">${uiIcon('search')}</span>
                            <input id="ar-diag-search" class="ar-diag-search" type="search" autocomplete="off" spellcheck="false" placeholder="${I18n.t('diag.searchPlaceholder')}" aria-label="${I18n.t('diag.searchLabel')}">
                            <button id="ar-diag-search-clear" class="ar-diag-search-clear ar-icon-only" type="button" title="${I18n.t('diag.clearSearch')}" aria-label="${I18n.t('diag.clearSearch')}" hidden>${uiIcon('close')}</button>
                        </div>
                    </div>
                    <div class="ar-diag-toolbar">
                        <div class="ar-diag-check-zone">
                            <button id="ar-diag-full-check" class="ar-btn ar-btn-soft ar-btn-sm ar-diag-check-btn" type="button" title="${I18n.t('diag.checkSelectors')}">${I18n.t('diag.checkSelectors')}</button>
                            <span id="ar-diag-check-status" class="ar-diag-check-status" aria-live="polite">${I18n.t('diag.checkSummaryIdle')}</span>
                        </div>
                        <label class="ar-diag-autoscroll ar-switch-row" for="ar-diag-auto-scroll">
                            <span class="ar-switch">
                                <input type="checkbox" id="ar-diag-auto-scroll" checked>
                                <i aria-hidden="true"></i>
                            </span>
                            <span id="ar-diag-auto-scroll-text">${I18n.t('diag.autoScroll')}</span>
                        </label>
                    </div>
                    <div id="ar-diag-full-box" class="ar-diag-full-box" role="log" aria-live="off" tabindex="0"></div>
                    <div class="ar-diag-footer-actions">
                        <button id="ar-diag-full-save" class="ar-btn ar-btn-soft ar-btn-sm ar-diag-save-btn" type="button" title="${I18n.t('diag.downloadLogTitle')}">${I18n.t('diag.downloadLog')}</button>
                        <div class="ar-dropdown ar-diag-full-dropdown" id="ar-diag-full-dropdown">
                            <button id="ar-diag-full-more-btn" class="ar-btn ar-btn-soft ar-btn-sm ar-diag-more-btn" type="button" title="${I18n.t('diag.moreTitle')}" aria-label="${I18n.t('diag.moreTitle')}" aria-haspopup="menu" aria-expanded="false" aria-controls="ar-diag-full-menu">
                                <span id="ar-diag-more-text">${I18n.t('diag.moreBtn')}</span>
                            </button>
                            <div class="ar-dropdown-menu" id="ar-diag-full-menu" role="menu">
                                <button id="ar-diag-full-clear-box" class="ar-dropdown-item" type="button" role="menuitem">${I18n.t('diag.clearView')}</button>
                                <button id="ar-diag-full-clear-all" class="ar-dropdown-item ar-dropdown-item--danger" type="button" role="menuitem">${I18n.t('diag.clearAll')}</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    const AutosaveFeedback = (() => {
        let root = null;
        let textNode = null;
        let resetTimer = null;
        let saved = false;

        const refresh = () => {
            if (!textNode) return;
            textNode.textContent = I18n.t(saved ? 'panel.autosaveSaved' : 'panel.autosaveIdle');
            root?.classList.toggle('is-saved', saved);
        };

        const showSaved = () => {
            saved = true;
            refresh();
            if (resetTimer) clearTimeout(resetTimer);
            resetTimer = setTimeout(() => {
                resetTimer = null;
                saved = false;
                refresh();
            }, 1800);
        };

        const mount = ({ el }) => {
            root = el('ar-autosave-feedback');
            textNode = el('ar-autosave-text');
            saved = false;
            refresh();
        };

        const destroy = () => {
            if (resetTimer) clearTimeout(resetTimer);
            resetTimer = null;
            saved = false;
            root = null;
            textNode = null;
        };

        return { mount, showSaved, refresh, destroy };
    })();

    const HelpPopoverController = (() => {
        function mount({ panel, uiSignal }) {
            const entries = qa('.ar-help-wrap', panel).map(wrap => {
                const button = wrap.querySelector('.ar-help-button');
                const popover = wrap.querySelector('.ar-help-popover');
                if (!button || !popover) return null;
                const state = { wrap, button, popover, pinned: false, hover: false, focus: false, escapeClosed: false };
                const render = () => {
                    const open = !state.escapeClosed && (state.pinned || state.hover || state.focus);
                    wrap.classList.toggle('is-pinned', state.pinned);
                    wrap.classList.toggle('is-open', open);
                    button.setAttribute('aria-expanded', open ? 'true' : 'false');
                    popover.setAttribute('aria-hidden', open ? 'false' : 'true');
                };
                state.render = render;
                wrap.addEventListener('mouseenter', () => {
                    state.hover = true;
                    state.escapeClosed = false;
                    render();
                }, { signal: uiSignal });
                wrap.addEventListener('mouseleave', () => {
                    state.hover = false;
                    render();
                }, { signal: uiSignal });
                wrap.addEventListener('focusin', () => {
                    state.focus = true;
                    state.escapeClosed = false;
                    render();
                }, { signal: uiSignal });
                wrap.addEventListener('focusout', () => {
                    setTimeout(() => {
                        state.focus = wrap.contains(document.activeElement);
                        render();
                    }, 0);
                }, { signal: uiSignal });
                button.addEventListener('click', event => {
                    event.stopPropagation();
                    state.escapeClosed = false;
                    state.pinned = !state.pinned;
                    render();
                }, { signal: uiSignal });
                return state;
            }).filter(Boolean);

            document.addEventListener('click', event => {
                entries.forEach(state => {
                    if (state.pinned && !state.wrap.contains(event.target)) {
                        state.pinned = false;
                        state.render();
                    }
                });
            }, { signal: uiSignal });
            document.addEventListener('keydown', event => {
                if (event.key !== 'Escape') return;
                entries.forEach(state => {
                    if (state.pinned || state.hover || state.focus) {
                        state.pinned = false;
                        state.escapeClosed = true;
                        state.render();
                    }
                });
            }, { signal: uiSignal });
        }

        return { mount };
    })();

    const WorkModeSlider = (() => {
        let resizeObserver = null;
        let activeTurboEffects = null;
        let onVisibilityChangeImpl = () => {};

        function mount({ el, uiSignal }) {
            // ---------- Новый селектор режима (Work Mode Slider) ----------
            const modeCard = el('ar-mode-card');
            const slider = el('ar-work-mode-slider');
            const thumb = el('ar-work-mode-thumb');
            const thumbShadow = el('ar-work-mode-thumb-shadow');
            const thumbBody = el('ar-work-mode-thumb-body');
            const gridStrip = el('ar-work-mode-grid-strip');
            const reducedMotionQuery = typeof window.matchMedia === 'function'
                ? window.matchMedia('(prefers-reduced-motion: reduce)')
                : { matches: false };

            function isWorkModeVisible() {
                if (uiSignal?.aborted || document.hidden || !slider) return false;
                const panelEl = document.getElementById('ar-main-panel');
                const mainView = document.getElementById('ar-view-main');
                if (!panelEl || panelEl.style.display === 'none') return false;
                if (mainView && mainView.style.display === 'none') return false;
                if (panelEl.isConnected === false || slider.isConnected === false) return false;
                if (typeof panelEl.contains === 'function' && !panelEl.contains(slider)) return false;
                return true;
            }

            function isTurboGridVisible() {
                return modeKeyToIndex(config.preset) === 3 && isWorkModeVisible();
            }

            function canRunTurboEffects() {
                return isTurboGridVisible() && !reducedMotionQuery.matches;
            }

            // ─── Состояния и параметры физики ───
            const STATE = {
                REST: 'REST',
                TRAVEL_LIFT: 'TRAVEL_LIFT',
                TRAVEL: 'TRAVEL',
                SETTLING: 'SETTLING',
                TURBO_DEPTH_OUT: 'TURBO_DEPTH_OUT',
                TURBO_DEPTH_RETURN: 'TURBO_DEPTH_RETURN',
                IMPACT: 'IMPACT',
                SHOCKWAVE: 'SHOCKWAVE'
            };

            let currentState = STATE.REST;

            const TRAVEL_LIFT_Z = 11;
            const TRAVEL_LIFT_DURATION = 150;
            const TRAVEL_SETTLE_DURATION = 220;
            const HORIZONTAL_SNAP_DURATION = 255;

            const TURBO_PEAK_Z = 26;
            const TURBO_OUT_DURATION = 420;
            const TURBO_HOLD_DURATION = 80;
            const TURBO_RETURN_DURATION = 280;
            const TURBO_SETTLE_PAUSE = 400;

            const EASE_PREMIUM = 'cubic-bezier(0.22, 0.8, 0.3, 1)';
            const EASE_TURBO_OUT = 'cubic-bezier(0.16, 0.84, 0.44, 1)';
            const EASE_TURBO_RETURN = 'cubic-bezier(0.45, 0, 0.8, 0.5)';

            let currentBodyAnimation = null;
            let currentShadowAnimation = null;
            let turboPulseTimer = 0;
            let turboHoldTimer = 0;
            let travelSettleTimer = 0;
            let isDragging = false;
            let isSnapping = false;

            let cachedMetrics = {
                pad: 3,
                thumbWidth: 44,
                travel: 0,
                sliderWidth: 1
            };

            let gridCells = [];
            let gridMetrics = {
                width: 1,
                columns: 1,
                rows: 5,
                periodWidth: 1
            };
            let gridCleanupTimer = 0;
            let gridCleanupGeneration = 0;
            let gridRefreshRafId = 0;
            let resizeRafId = 0;

            const SHOCK_CYCLE_SECONDS = 5;
            const GRID_DRIFT_SECONDS = 60;
            const TURBO_GRID_EXIT_CLEANUP_MS = 220;

            if (modeCard) {
                modeCard.style.setProperty('--ar-work-shock-cycle-duration', `${SHOCK_CYCLE_SECONDS}s`);
                modeCard.style.setProperty('--ar-work-turbo-grid-duration', `${GRID_DRIFT_SECONDS}s`);
            }

            let gridDriftAnimation = null;
            let shockCycleSeconds = SHOCK_CYCLE_SECONDS;
            let shockStart = 0;
            let shockTravelMs = 0;
            let shockRafId = 0;
            let shockActive = false;
            let lastShockStartedAt = 0;
            let currentThumbSourceX = 0;

            function updateCachedMetrics() {
                if (!slider || !thumb) return cachedMetrics;
                const style = getComputedStyle(slider);
                const pad = parseFloat(style.getPropertyValue('--ar-work-track-pad')) || 3;
                const thumbWidth = thumb.offsetWidth || 44;
                const sliderWidth = Math.max(1, slider.clientWidth);
                const travel = Math.max(0, sliderWidth - (pad * 2) - thumbWidth);
                cachedMetrics = { pad, thumbWidth, travel, sliderWidth };
                return cachedMetrics;
            }

            function positionForValue(val) {
                const { travel } = cachedMetrics;
                return (travel / 3) * val;
            }

            function setThumbX(x, animate = true) {
                if (!slider || !thumb) return;
                if (animate) {
                    slider.classList.remove('is-dragging');
                } else {
                    slider.classList.add('is-dragging');
                }
                const { pad, thumbWidth } = cachedMetrics;
                const leftEdge = Math.max(0, pad + x);
                const centerX = leftEdge + (thumbWidth / 2);
                currentThumbSourceX = leftEdge;
                slider.style.setProperty('--thumb-source-x', `${leftEdge.toFixed(2)}px`);
                slider.style.setProperty('--thumb-center-x', `${centerX.toFixed(2)}px`);
                thumb.style.transform = `translate3d(${x.toFixed(2)}px, 0, 0)`;
            }

            function getThumbSourceX() {
                if (Number.isFinite(currentThumbSourceX) && currentThumbSourceX > 0) {
                    return currentThumbSourceX;
                }
                const { pad } = cachedMetrics;
                const curVal = modeKeyToIndex(config.preset);
                return pad + positionForValue(curVal);
            }

            function getCurrentBodyZ() {
                if (!thumbBody) return 0;
                try {
                    const tr = getComputedStyle(thumbBody).transform;
                    if (!tr || tr === 'none') return 0;
                    const matrix = new DOMMatrixReadOnly(tr);
                    return Number.isFinite(matrix.m43) ? matrix.m43 : 0;
                } catch (e) {
                    return 0;
                }
            }

            function getShadowStyle(z) {
                const clampedZ = Math.max(0, Math.min(32, z));
                const norm = clampedZ / 26;
                const blur1 = (7 + norm * 15).toFixed(1);
                const y1 = (3 + norm * 8).toFixed(1);
                const alpha1 = (0.085 + norm * 0.075).toFixed(3);

                const blur2 = (2 + norm * 5).toFixed(1);
                const y2 = (1 + norm * 3).toFixed(1);
                const alpha2 = (0.065 + norm * 0.025).toFixed(3);

                return {
                    boxShadow: `0 ${y1}px ${blur1}px rgba(27,35,48,${alpha1}), 0 ${y2}px ${blur2}px rgba(27,35,48,${alpha2})`,
                    transform: `scale(${1 + norm * 0.035})`
                };
            }

            function stopDepthAnimations() {
                if (currentBodyAnimation) {
                    try { currentBodyAnimation.cancel(); } catch (e) { /* ignore */ }
                    currentBodyAnimation = null;
                }
                if (currentShadowAnimation) {
                    try { currentShadowAnimation.cancel(); } catch (e) { /* ignore */ }
                    currentShadowAnimation = null;
                }
            }

            function clearTurboTimers() {
                if (turboPulseTimer) {
                    clearTimeout(turboPulseTimer);
                    turboPulseTimer = 0;
                }
                if (turboHoldTimer) {
                    clearTimeout(turboHoldTimer);
                    turboHoldTimer = 0;
                }
                if (travelSettleTimer) {
                    clearTimeout(travelSettleTimer);
                    travelSettleTimer = 0;
                }
            }

            function animateThumbDepth(targetZ, durationMs, easing = EASE_PREMIUM, onFinish = null) {
                if (!thumbBody) {
                    if (onFinish) onFinish();
                    return;
                }

                const startZ = getCurrentBodyZ();
                stopDepthAnimations();

                if (reducedMotionQuery.matches || durationMs <= 0 || Math.abs(startZ - targetZ) < 0.01) {
                    thumbBody.style.transform = targetZ === 0 ? 'translateZ(0)' : `translateZ(${targetZ.toFixed(2)}px)`;
                    if (thumbShadow) {
                        const st = getShadowStyle(targetZ);
                        thumbShadow.style.boxShadow = st.boxShadow;
                        thumbShadow.style.transform = st.transform;
                    }
                    if (onFinish) onFinish();
                    return;
                }

                const keyframes = [
                    { transform: `translateZ(${startZ.toFixed(2)}px)` },
                    { transform: `translateZ(${targetZ.toFixed(2)}px)` }
                ];

                try {
                    currentBodyAnimation = thumbBody.animate(keyframes, {
                        duration: durationMs,
                        easing: easing,
                        fill: 'forwards'
                    });

                    if (thumbShadow) {
                        const fromSt = getShadowStyle(startZ);
                        const toSt = getShadowStyle(targetZ);
                        currentShadowAnimation = thumbShadow.animate([
                            { boxShadow: fromSt.boxShadow, transform: fromSt.transform },
                            { boxShadow: toSt.boxShadow, transform: toSt.transform }
                        ], {
                            duration: durationMs,
                            easing: easing,
                            fill: 'forwards'
                        });

                        currentShadowAnimation.onfinish = () => {
                            thumbShadow.style.boxShadow = toSt.boxShadow;
                            thumbShadow.style.transform = toSt.transform;
                            if (currentShadowAnimation) {
                                try { currentShadowAnimation.cancel(); } catch (e) {}
                                currentShadowAnimation = null;
                            }
                        };
                    }

                    currentBodyAnimation.onfinish = () => {
                        thumbBody.style.transform = targetZ === 0 ? 'translateZ(0)' : `translateZ(${targetZ.toFixed(2)}px)`;
                        if (currentBodyAnimation) {
                            try { currentBodyAnimation.cancel(); } catch (e) {}
                            currentBodyAnimation = null;
                        }
                        if (onFinish) onFinish();
                    };
                } catch (e) {
                    thumbBody.style.transform = targetZ === 0 ? 'translateZ(0)' : `translateZ(${targetZ.toFixed(2)}px)`;
                    if (onFinish) onFinish();
                }
            }

            function cancelTurboPulse({ resetToRest = false } = {}) {
                clearTurboTimers();
                if (currentState === STATE.TURBO_DEPTH_OUT || currentState === STATE.TURBO_DEPTH_RETURN || currentState === STATE.IMPACT) {
                    stopDepthAnimations();
                }
                if (shockActive) {
                    stopShockwave({ clearSchedule: true });
                }
                if (resetToRest) {
                    currentState = STATE.REST;
                }
            }

            function startTravelLift(onLiftComplete = null) {
                cancelTurboPulse();

                const currentZ = getCurrentBodyZ();
                currentState = STATE.TRAVEL_LIFT;

                if (Math.abs(currentZ - TRAVEL_LIFT_Z) < 0.5) {
                    currentState = (isDragging || isSnapping) ? STATE.TRAVEL : STATE.TRAVEL_LIFT;
                    if (onLiftComplete) onLiftComplete();
                    return;
                }

                animateThumbDepth(TRAVEL_LIFT_Z, TRAVEL_LIFT_DURATION, EASE_PREMIUM, () => {
                    if (currentState === STATE.TRAVEL_LIFT) {
                        currentState = (isDragging || isSnapping) ? STATE.TRAVEL : STATE.TRAVEL_LIFT;
                    }
                    if (onLiftComplete) onLiftComplete();
                });
            }

            function finishTravelAndSettle() {
                isDragging = false;
                isSnapping = false;

                if (travelSettleTimer) {
                    clearTimeout(travelSettleTimer);
                    travelSettleTimer = 0;
                }

                currentState = STATE.SETTLING;

                animateThumbDepth(0, TRAVEL_SETTLE_DURATION, EASE_PREMIUM, () => {
                    currentState = STATE.REST;
                    if (canRunTurboEffects() && !isDragging && !isSnapping) {
                        scheduleTurboPulse(TURBO_SETTLE_PAUSE);
                    }
                });
            }

            function scheduleTurboPulse(delayMs = 0) {
                clearTurboTimers();
                if (!canRunTurboEffects() || isDragging || isSnapping || currentState !== STATE.REST) {
                    return;
                }

                const intervalMs = Math.max(5000, shockCycleSeconds * 1000);
                const delay = delayMs > 0
                    ? delayMs
                    : (lastShockStartedAt ? Math.max(600, (lastShockStartedAt + intervalMs) - performance.now()) : 600);

                turboPulseTimer = setTimeout(() => {
                    turboPulseTimer = 0;
                    if (!canRunTurboEffects()) return;
                    executeTurboPulse();
                }, delay);
            }

            function executeTurboPulse() {
                if (!canRunTurboEffects() || isDragging || isSnapping || currentState !== STATE.REST) {
                    return;
                }

                currentState = STATE.TURBO_DEPTH_OUT;

                // Step 1: Плавный подъём к пользователю
                animateThumbDepth(TURBO_PEAK_Z, TURBO_OUT_DURATION, EASE_TURBO_OUT, () => {
                    if (currentState !== STATE.TURBO_DEPTH_OUT) return;

                    // Step 2: Короткое удержание на пике
                    turboHoldTimer = setTimeout(() => {
                        turboHoldTimer = 0;
                        if (currentState !== STATE.TURBO_DEPTH_OUT) return;

                        currentState = STATE.TURBO_DEPTH_RETURN;

                        // Step 3: Возврат в плоскость
                        animateThumbDepth(0, TURBO_RETURN_DURATION, EASE_TURBO_RETURN, () => {
                            if (currentState !== STATE.TURBO_DEPTH_RETURN) return;

                            // Step 4: IMPACT -> запуск shockwave строго в момент касания Z = 0
                            currentState = STATE.IMPACT;
                            startShockwave();
                            currentState = STATE.SHOCKWAVE;
                        });
                    }, TURBO_HOLD_DURATION);
                });
            }

            function seededNoise(index) {
                const x = Math.sin(index * 12.9898 + 78.233) * 43758.5453;
                return x - Math.floor(x);
            }

            function levelFor(index) {
                const n = seededNoise(index + 91);

                // Regular geometry, irregular deterministic intensity.
                if (n < .18) return 'l0';
                if (n < .35) return 'l1';
                if (n < .53) return 'l2';
                if (n < .69) return 'l3';
                if (n < .84) return 'l4';
                return 'l5';
            }

            function pxVar(name, fallback) {
                if (!modeCard && !slider) return fallback;
                const style = getComputedStyle(modeCard || slider);
                const n = parseFloat(style.getPropertyValue(name));
                return Number.isFinite(n) ? n : fallback;
            }

            function gaussian(distance, width) {
                const ratio = distance / width;
                return Math.exp(-.5 * ratio * ratio);
            }

            function clamp01(val) {
                return Math.max(0, Math.min(1, val));
            }

            function smoothstep(edge0, edge1, x) {
                if (edge0 === edge1) return x < edge0 ? 0 : 1;
                const t = clamp01((x - edge0) / (edge1 - edge0));
                return t * t * (3 - 2 * t);
            }

            function resetShockCells() {
                for (const cell of gridCells) {
                    if (!cell.active && cell.lastBoost === '0' && cell.lastX === '0px' && cell.lastY === '0px' && cell.lastScale === '1') continue;
                    const style = cell.element.style;
                    style.setProperty('--wave-boost', '0');
                    style.setProperty('--wave-x', '0px');
                    style.setProperty('--wave-y', '0px');
                    style.setProperty('--wave-scale', '1');
                    cell.active = false;
                    cell.lastBoost = '0';
                    cell.lastX = '0px';
                    cell.lastY = '0px';
                    cell.lastScale = '1';
                }
            }

            function cancelGridCleanup() {
                gridCleanupGeneration++;
                if (!gridCleanupTimer) return;
                clearTimeout(gridCleanupTimer);
                gridCleanupTimer = 0;
            }

            function clearGridDom() {
                if (!gridStrip) return;
                if (gridRefreshRafId) {
                    cancelAnimationFrame(gridRefreshRafId);
                    gridRefreshRafId = 0;
                }
                gridStrip.replaceChildren();
                gridStrip.style.width = '';
                slider?.style.setProperty('--ar-work-grid-shift', '');
                slider?.classList.remove('has-turbo-grid');
                gridCells = [];
                gridMetrics = { width: 1, columns: 1, rows: 5, periodWidth: 1 };
                gridDriftAnimation = null;
            }

            function clearGridNow() {
                cancelGridCleanup();
                clearGridDom();
            }

            function scheduleGridCleanup() {
                cancelGridCleanup();
                if (!gridCells.length) return;
                const generation = gridCleanupGeneration;
                gridCleanupTimer = setTimeout(() => {
                    if (generation !== gridCleanupGeneration) return;
                    gridCleanupTimer = 0;
                    if (isTurboGridVisible()) return;
                    clearGridDom();
                }, TURBO_GRID_EXIT_CLEANUP_MS);
            }

            function rebuildGrid() {
                if (!slider || !gridStrip || !isTurboGridVisible()) return;
                const rows = 5;
                const cellSize = pxVar('--ar-work-grid-cell', 5);
                const gap = pxVar('--ar-work-grid-col-gap', 2);
                const cadence = cellSize + gap;
                const width = Math.max(1, slider.clientWidth);

                // Two exact periods: seamless right-to-left drift.
                const columns = Math.max(1, Math.ceil((width + gap) / cadence) + 2);
                const periodWidth = columns * cadence;
                const fragment = document.createDocumentFragment();
                const metadata = [];

                for (let period = 0; period < 2; period++) {
                    for (let column = 0; column < columns; column++) {
                        for (let row = 0; row < rows; row++) {
                            const index = column * rows + row;
                            const baseLevel = levelFor(index);
                            const element = document.createElement('span');

                            element.className = `ar-work-mode-grid-cell ${baseLevel}`;
                            fragment.appendChild(element);

                            metadata.push({
                                element,
                                column,
                                row,
                                period,

                                // Physical center of THIS rendered cell in the two-period strip.
                                // Shockwave uses this together with the live CSS drift offset,
                                // so the reaction always happens where the square is actually seen.
                                stripX:
                                    period * periodWidth +
                                    column * cadence +
                                    cellSize / 2,

                                phase: (seededNoise(index * 1.731 + 17.9) - .5) * .018,
                                interferenceStatic: row * 1.27,
                                echoStatic: row * 1.61,
                                baseLevel,
                                active: false,
                                lastBoost: '0',
                                lastX: '0px',
                                lastY: '0px',
                                lastScale: '1'
                            });
                        }
                    }
                }

                gridStrip.replaceChildren(fragment);
                gridStrip.style.width = `${(periodWidth * 2) - gap}px`;
                slider.style.setProperty('--ar-work-grid-shift', `${-periodWidth}px`);
                slider.classList.add('has-turbo-grid');

                gridCells = metadata;
                gridMetrics = {
                    width,
                    columns,
                    rows,
                    periodWidth
                };

                refreshGridDriftAnimation();
                resetShockCells();
            }

            function ensureGrid() {
                cancelGridCleanup();
                if (!gridCells.length && isTurboGridVisible()) rebuildGrid();
            }

            function refreshGridDriftAnimation() {
                if (!gridStrip || typeof gridStrip.getAnimations !== 'function') {
                    gridDriftAnimation = null;
                    return;
                }
                const animations = gridStrip.getAnimations();
                gridDriftAnimation = animations.length ? animations[0] : null;
            }

            function currentGridDriftOffset() {
                if (!gridDriftAnimation) {
                    refreshGridDriftAnimation();
                }

                if (!gridDriftAnimation) {
                    return 0;
                }

                const timing = gridDriftAnimation.effect?.getComputedTiming?.();
                const progress = Number.isFinite(timing?.progress)
                    ? timing.progress
                    : 0;

                return -gridMetrics.periodWidth * progress;
            }

            function travelDurationMs(cycleSeconds = shockCycleSeconds) {
                const normalized = clamp01((cycleSeconds - 5) / 35);
                return 1800 + normalized * 1200;
            }

            function stopShockwave({ clearSchedule = true } = {}) {
                if (shockRafId) {
                    cancelAnimationFrame(shockRafId);
                    shockRafId = 0;
                }

                if (clearSchedule) {
                    clearTurboTimers();
                }

                shockActive = false;
                resetShockCells();
            }

            function startShockwave() {
                if (!canRunTurboEffects() || !gridCells.length) return;

                if (shockRafId) {
                    cancelAnimationFrame(shockRafId);
                    shockRafId = 0;
                }

                shockActive = true;
                shockStart = performance.now();
                lastShockStartedAt = shockStart;
                shockTravelMs = travelDurationMs();

                shockRafId = requestAnimationFrame(updateShockwave);
            }

            function updateShockwave(now) {
                if (!shockActive || !canRunTurboEffects()) {
                    stopShockwave({ clearSchedule: false });
                    return;
                }

                const elapsed = now - shockStart;
                const travelProgress = clamp01(elapsed / shockTravelMs);

                // Almost linear propagation with a subtle natural ease at the tail.
                const travelEase = 1 - Math.pow(1 - travelProgress, 1.08);
                const sliderWidth = Math.max(1, gridMetrics.width || slider?.clientWidth || 1);
                const thumbSourceX = getThumbSourceX();
                const originNorm = clamp01(thumbSourceX / sliderWidth);
                const frontX = originNorm - (originNorm + 0.08) * travelEase;
                const elapsedSeconds = elapsed / 1000;

                // Main wave remains active during travel; wake/echo gets ~950ms to settle.
                const settleMs = 950;
                const globalDecay = elapsed <= shockTravelMs
                    ? 1
                    : 1 - smoothstep(shockTravelMs, shockTravelMs + settleMs, elapsed);

                // Read current CSS animation phase once and convert every cell's strip-space X into slider-space X.
                const driftOffset = currentGridDriftOffset();

                for (const cell of gridCells) {
                    const visualXPx = cell.stripX + driftOffset;
                    const visualX = visualXPx / sliderWidth;
                    const x = visualX + cell.phase;
                    const distance = x - frontX;

                    // Cells outside the visible/physical influence window cannot contribute
                    // perceptibly. Skipping them avoids math + DOM writes for the duplicate
                    // off-screen grid period while preserving the rendered wave.
                    if (visualX < -.25 || visualX > 1.25 || distance < -.22 || distance > .50) {
                        if (cell.active) {
                            const style = cell.element.style;
                            style.setProperty('--wave-boost', '0');
                            style.setProperty('--wave-x', '0px');
                            style.setProperty('--wave-y', '0px');
                            style.setProperty('--wave-scale', '1');
                            cell.active = false;
                            cell.lastBoost = '0';
                            cell.lastX = '0px';
                            cell.lastY = '0px';
                            cell.lastScale = '1';
                        }
                        continue;
                    }

                    // Wave moves right -> left:
                    // negative distance = just ahead of the front,
                    // positive distance = already passed / wake side.
                    const core = gaussian(distance, .026) * globalDecay;
                    const compression = gaussian(distance + .034, .030) * globalDecay;

                    const wakeGate = smoothstep(-.012, .018, distance);
                    const wake = gaussian(distance - .075, .105) * wakeGate * globalDecay;

                    const echoGate = smoothstep(.035, .075, distance);
                    const echo = gaussian(distance - .135, .040) * echoGate * globalDecay;

                    const boost = core * .50 + compression * .055 + wake * .13 + echo * .08;
                    const scale = 1 + core * .185 + wake * .035 + echo * .018 - compression * .018;
                    const waveX = core * -1.05 + compression * -.55 + wake * .30 + echo * .10;
                    const interference = Math.sin(visualX * 19.0 + cell.interferenceStatic + elapsedSeconds * 6.2 + cell.phase * 55);
                    const echoInterference = Math.sin(visualX * 14.0 + cell.echoStatic + elapsedSeconds * 4.1);
                    const waveY = interference * wake * .46 + echoInterference * echo * .16;

                    // Values are already rendered to 3 decimals, so avoid redundant style
                    // mutations when the visible value did not change between frames.
                    const boostText = boost.toFixed(3);
                    const xText = `${waveX.toFixed(3)}px`;
                    const yText = `${waveY.toFixed(3)}px`;
                    const scaleText = scale.toFixed(3);
                    const style = cell.element.style;
                    if (boostText !== cell.lastBoost) { style.setProperty('--wave-boost', boostText); cell.lastBoost = boostText; }
                    if (xText !== cell.lastX) { style.setProperty('--wave-x', xText); cell.lastX = xText; }
                    if (yText !== cell.lastY) { style.setProperty('--wave-y', yText); cell.lastY = yText; }
                    if (scaleText !== cell.lastScale) { style.setProperty('--wave-scale', scaleText); cell.lastScale = scaleText; }
                    cell.active = true;
                }

                if (elapsed < shockTravelMs + settleMs) {
                    shockRafId = requestAnimationFrame(updateShockwave);
                    return;
                }

                shockRafId = 0;
                shockActive = false;
                resetShockCells();

                if (currentState === STATE.SHOCKWAVE) {
                    currentState = STATE.REST;
                }

                if (canRunTurboEffects() && !isDragging && !isSnapping) {
                    scheduleTurboPulse();
                }
            }

            function enterTurbo() {
                if (!isTurboGridVisible()) {
                    cancelTurboPulse({ resetToRest: true });
                    stopDepthAnimations();
                    resetShockCells();
                    clearGridNow();
                    return;
                }

                ensureGrid();

                if (!canRunTurboEffects()) {
                    cancelTurboPulse({ resetToRest: true });
                    stopDepthAnimations();
                    resetShockCells();
                    return;
                }

                cancelTurboPulse();

                // Pick up the freshly-created CSS drift animation on the next frame so shockwave shares its timeline.
                if (gridRefreshRafId) cancelAnimationFrame(gridRefreshRafId);
                gridRefreshRafId = requestAnimationFrame(() => {
                    gridRefreshRafId = 0;
                    if (canRunTurboEffects()) refreshGridDriftAnimation();
                });

                if (currentState === STATE.REST && !isDragging && !isSnapping) {
                    scheduleTurboPulse(TURBO_SETTLE_PAUSE);
                }
            }

            function exitTurbo() {
                cancelTurboPulse({ resetToRest: true });
                lastShockStartedAt = 0;
                gridDriftAnimation = null;
                if (gridRefreshRafId) {
                    cancelAnimationFrame(gridRefreshRafId);
                    gridRefreshRafId = 0;
                }
                if (isWorkModeVisible()) {
                    scheduleGridCleanup();
                } else {
                    clearGridNow();
                }
            }

            // TurboEffects is an isolated visual sub-controller. WorkModeSlider owns
            // horizontal selection; this facade owns depth/grid/shock lifecycle.
            const TurboEffects = Object.freeze({
                startTravelLift,
                finishTravelAndSettle,
                cancel: cancelTurboPulse,
                stopDepth: stopDepthAnimations,
                clearGrid: clearGridNow,
                ensureGrid,
                rebuildGrid,
                refreshGrid: refreshGridDriftAnimation,
                schedule: scheduleTurboPulse,
                enter: enterTurbo,
                exit: exitTurbo,
                destroy: () => {
                    if (resizeRafId) {
                        cancelAnimationFrame(resizeRafId);
                        resizeRafId = 0;
                    }
                    clearGridNow();
                }
            });
            activeTurboEffects = TurboEffects;

            function syncThumb(animate = true) {
                const currentVal = modeKeyToIndex(config.preset);
                setThumbX(positionForValue(currentVal), animate);
            }

            function updateModeUI(val, { animateThumb = true } = {}) {
                const key = modeIndexToKey(val);
                const label = presetLabel(key);
                const wasTurbo = slider?.classList.contains('is-turbo') || false;
                const isTurbo = key === 'turbo';

                if (slider) {
                    slider.dataset.value = String(val);
                    slider.classList.toggle('is-turbo', isTurbo);
                    slider.setAttribute('aria-valuenow', String(val));
                    slider.setAttribute('aria-valuetext', label);
                }
                if (modeCard) {
                    modeCard.dataset.mode = key;
                    qa('.ar-work-mode-option', modeCard).forEach(option => {
                        option.classList.toggle('is-active', option.dataset.mode === key);
                    });
                }
                syncThumb(animateThumb);

                if (!wasTurbo && isTurbo) {
                    TurboEffects.enter();
                } else if (wasTurbo && !isTurbo) {
                    TurboEffects.exit();
                }
            }

            function selectWorkMode(nextIndex, { focus = false, fromDrag = false } = {}) {
                const clampedIndex = Math.max(0, Math.min(3, nextIndex));
                const nextKey = modeIndexToKey(clampedIndex);

                if (!fromDrag) {
                    TurboEffects.startTravelLift();
                }

                isSnapping = true;

                if (travelSettleTimer) {
                    clearTimeout(travelSettleTimer);
                    travelSettleTimer = 0;
                }

                if (config.preset !== nextKey) {
                    const previousIndex = modeKeyToIndex(config.preset);
                    if (persistSettings({ ...config, preset: nextKey })) {
                        updateModeUI(clampedIndex, { animateThumb: true });

                        if (State.amIRunning()) {
                            setStatus('running');
                        }

                        AutosaveFeedback.showSaved();
                        log(I18n.t('logs.modeSet', { mode: (nextKey === 'turbo' ? '↯ ' : '') + presetLabel(nextKey) }));
                    } else {
                        updateModeUI(previousIndex, { animateThumb: true });
                    }
                } else {
                    updateModeUI(clampedIndex, { animateThumb: true });
                }

                travelSettleTimer = setTimeout(() => {
                    TurboEffects.finishTravelAndSettle();
                }, HORIZONTAL_SNAP_DURATION);

                if (focus && slider) {
                    slider.focus({ preventScroll: true });
                }
            }

            if (slider) {
                let pointerId = null;
                let dragX = 0;
                let pointerStartX = 0;
                let pointerMoved = false;
                let sliderRectLeft = 0;

                function valueFromPointer(clientX) {
                    const { sliderWidth } = cachedMetrics;
                    const local = Math.max(0, Math.min(sliderWidth, clientX - sliderRectLeft));
                    const ratio = sliderWidth ? local / sliderWidth : 0;
                    return Math.max(0, Math.min(3, Math.floor(ratio * 4)));
                }

                function dragPositionFromPointer(clientX) {
                    const { pad, thumbWidth, travel } = cachedMetrics;
                    const centered = clientX - sliderRectLeft - pad - (thumbWidth / 2);
                    return Math.max(0, Math.min(travel, centered));
                }

                function nearestValueForX(x) {
                    const { travel } = cachedMetrics;
                    if (travel <= 0) return 0;
                    return Math.max(0, Math.min(3, Math.round((x / travel) * 3)));
                }

                slider.addEventListener('pointerdown', (event) => {
                    if (event.button !== undefined && event.button !== 0) return;
                    isDragging = true;
                    pointerId = event.pointerId;
                    pointerStartX = event.clientX;
                    pointerMoved = false;

                    updateCachedMetrics();
                    sliderRectLeft = slider.getBoundingClientRect().left;

                    try { slider.setPointerCapture?.(pointerId); } catch (e) { /* ignore */ }

                    slider.classList.add('is-pressed', 'is-dragging');

                    TurboEffects.startTravelLift();

                    dragX = dragPositionFromPointer(event.clientX);
                    setThumbX(dragX, false);
                }, { signal: uiSignal });

                slider.addEventListener('pointermove', (event) => {
                    if (!isDragging || event.pointerId !== pointerId) return;
                    if (Math.abs(event.clientX - pointerStartX) > 4) {
                        pointerMoved = true;
                    }
                    dragX = dragPositionFromPointer(event.clientX);
                    setThumbX(dragX, false);
                }, { signal: uiSignal });

                const finishPointer = (event) => {
                    if (!isDragging || event.pointerId !== pointerId) return;
                    slider.classList.remove('is-pressed', 'is-dragging');
                    try { slider.releasePointerCapture?.(pointerId); } catch (e) { /* ignore */ }
                    pointerId = null;

                    const target = pointerMoved
                        ? nearestValueForX(dragX)
                        : valueFromPointer(event.clientX);

                    selectWorkMode(target, { focus: true, fromDrag: true });
                };

                slider.addEventListener('pointerup', finishPointer, { signal: uiSignal });
                slider.addEventListener('pointercancel', (event) => {
                    if (event.pointerId !== pointerId) return;
                    slider.classList.remove('is-pressed', 'is-dragging');
                    pointerId = null;
                    const currentVal = modeKeyToIndex(config.preset);
                    selectWorkMode(currentVal, { fromDrag: true });
                }, { signal: uiSignal });

                slider.addEventListener('keydown', (event) => {
                    const curVal = modeKeyToIndex(config.preset);
                    let nextVal = curVal;
                    switch (event.key) {
                        case 'ArrowLeft':
                        case 'ArrowDown':
                            nextVal = Math.max(0, curVal - 1);
                            break;
                        case 'ArrowRight':
                        case 'ArrowUp':
                            nextVal = Math.min(3, curVal + 1);
                            break;
                        case 'Home':
                            nextVal = 0;
                            break;
                        case 'End':
                            nextVal = 3;
                        break;
                        default:
                            return;
                    }
                    event.preventDefault();
                    selectWorkMode(nextVal);
                }, { signal: uiSignal });

                resizeObserver = new ResizeObserver(() => {
                    if (resizeRafId) return;
                    resizeRafId = requestAnimationFrame(() => {
                        resizeRafId = 0;
                        updateCachedMetrics();
                        syncThumb(false);

                        if (isTurboGridVisible()) {
                            TurboEffects.cancel({ resetToRest: true });
                            TurboEffects.stopDepth();
                            if (thumbBody) {
                                thumbBody.style.transform = 'translateZ(0)';
                            }
                            if (thumbShadow) {
                                const st = getShadowStyle(0);
                                thumbShadow.style.boxShadow = st.boxShadow;
                                thumbShadow.style.transform = st.transform;
                            }

                            TurboEffects.rebuildGrid();
                            TurboEffects.refreshGrid();

                            if (canRunTurboEffects()) {
                                TurboEffects.schedule(TURBO_SETTLE_PAUSE);
                            }
                        }

                        requestAnimationFrame(() => {
                            slider?.classList.remove('is-dragging');
                        });
                    });
                });
                resizeObserver.observe(slider);

                function handleReducedMotionChange() {
                    if (reducedMotionQuery.matches) {
                        TurboEffects.ensureGrid();
                        TurboEffects.cancel({ resetToRest: true });
                        TurboEffects.stopDepth();
                        if (thumbBody) thumbBody.style.transform = 'translateZ(0)';
                        if (thumbShadow) {
                            const st = getShadowStyle(0);
                            thumbShadow.style.boxShadow = st.boxShadow;
                            thumbShadow.style.transform = st.transform;
                        }
                    } else if (canRunTurboEffects()) {
                        TurboEffects.enter();
                    }
                }

                if (typeof reducedMotionQuery.addEventListener === 'function') {
                    try {
                        reducedMotionQuery.addEventListener('change', handleReducedMotionChange, { signal: uiSignal });
                    } catch (e) {
                        reducedMotionQuery.addEventListener('change', handleReducedMotionChange);
                    }
                } else if (typeof reducedMotionQuery.addListener === 'function') {
                    reducedMotionQuery.addListener(handleReducedMotionChange);
                }

                function onVisibilityChange(isOpen) {
                    if (!isOpen || !isTurboGridVisible()) {
                        if (resizeRafId) {
                            cancelAnimationFrame(resizeRafId);
                            resizeRafId = 0;
                        }
                        TurboEffects.cancel({ resetToRest: true });
                        TurboEffects.stopDepth();
                        TurboEffects.clearGrid();
                    } else {
                        TurboEffects.enter();
                    }
                }
                onVisibilityChangeImpl = onVisibilityChange;

                document.addEventListener('visibilitychange', () => {
                    const panelEl = document.getElementById('ar-main-panel');
                    const isPanelOpen = panelEl && panelEl.style.display !== 'none';
                    onVisibilityChange(isPanelOpen && !document.hidden);
                }, { signal: uiSignal });

                function cleanupWorkModeAnimation() {
                    TurboEffects.cancel({ resetToRest: true });
                    TurboEffects.stopDepth();
                    TurboEffects.destroy();
                    if (typeof reducedMotionQuery.removeEventListener === 'function') {
                        try { reducedMotionQuery.removeEventListener('change', handleReducedMotionChange); } catch (e) {}
                    } else if (typeof reducedMotionQuery.removeListener === 'function') {
                        try { reducedMotionQuery.removeListener(handleReducedMotionChange); } catch (e) {}
                    }
                }

                uiSignal.addEventListener('abort', cleanupWorkModeAnimation, { once: true });

                updateCachedMetrics();
                updateModeUI(modeKeyToIndex(config.preset), { animateThumb: false });
                TurboEffects.ensureGrid();
                requestAnimationFrame(() => {
                    if (config.preset === 'turbo' && !isTurboGridVisible()) return;
                    updateCachedMetrics();
                    syncThumb(false);
                    requestAnimationFrame(() => {
                        slider?.classList.remove('is-dragging');
                        if (canRunTurboEffects()) {
                            TurboEffects.enter();
                        }
                    });
                });
            }

        }

        function destroy() {
            onVisibilityChangeImpl = () => {};
            if (activeTurboEffects) {
                try { activeTurboEffects.cancel({ resetToRest: true }); } catch (e) { /* ignore */ }
                try { activeTurboEffects.stopDepth(); } catch (e) { /* ignore */ }
                try { activeTurboEffects.destroy(); } catch (e) { /* ignore */ }
                activeTurboEffects = null;
            }
            if (resizeObserver) {
                try { resizeObserver.disconnect(); } catch (e) { /* ignore */ }
                resizeObserver = null;
            }
        }

        return {
            mount,
            onVisibilityChange: (isOpen) => onVisibilityChangeImpl(isOpen),
            destroy
        };
    })();

    const ManualQueueView = (() => {
        let renderImpl = () => {};

        function mount({ el }) {
            el('ar-clear-manual').onclick = () => {
                if (confirm(I18n.t('confirm.clearManual'))) {
                    if (!State.clearManualList()) {
                        Metrics.bump('storage.manual.clear.failed');
                        log('[CRITICAL_STORAGE_WRITE_FAILED] manual_queue: clear', true);
                        return;
                    }
                    renderManualList();
                    log(I18n.t('logs.manualCleared'));
                }
            };

            el('ar-export-manual').onclick = () => exportManualListHtml();

            function renderManualList() {
                const container = document.getElementById('ar-manual-list');
                if (!container) return;
                container.innerHTML = '';
                const list = State.getManualList();
                const cntEl = document.getElementById('ar-manual-count');
                const totalCount = list?.length || 0;
                if (cntEl) {
                    cntEl.textContent = totalCount;
                    cntEl.setAttribute('data-has', totalCount > 0 ? '1' : '0');
                }
                if (!list || !list.length) {
                    const empty = document.createElement('div');
                    empty.className = 'ar-empty';
                    empty.textContent = I18n.t('panel.manualEmpty');
                    container.appendChild(empty);
                    return;
                }

                const PREVIEW_LIMIT = 2;
                const previewItems = list.slice(0, PREVIEW_LIMIT);

                previewItems.forEach(item => {
                    const safeUrl = toSafeHhUrl(item?.url);
                    const row = document.createElement('div');
                    row.className = 'ar-manual-item';

                    const left = document.createElement('div');
                    left.className = 'ar-manual-main';
                    const time = I18n.formatTime(Number(item?.ts) || Date.now(), { hour: '2-digit', minute: '2-digit' });

                    const head = document.createElement('div');
                    head.className = 'ar-manual-meta';
                    const vid = document.createElement('span');
                    vid.className = 'ar-vid';
                    vid.textContent = item?.vid ? `#${item.vid}` : 'n/a';
                    const when = document.createElement('span');
                    when.className = 'ar-when';
                    when.textContent = time;
                    head.appendChild(vid);
                    head.appendChild(document.createTextNode('·'));
                    head.appendChild(when);

                    const titleEl = document.createElement('div');
                    titleEl.className = 'ar-manual-title';
                    const itemTitle = prettifyTitle(item?.title);
                    if (itemTitle && itemTitle !== 'Название недоступно' && itemTitle !== 'Title unavailable') {
                        titleEl.textContent = itemTitle;
                        titleEl.title = itemTitle;
                    } else {
                        titleEl.classList.add('is-empty');
                        titleEl.textContent = I18n.t('panel.manualNoTitle');
                    }

                    left.appendChild(head);
                    left.appendChild(titleEl);

                    const actions = document.createElement('div');
                    actions.className = 'ar-manual-actions';

                    const openBtn = document.createElement('button');
                    openBtn.className = 'ar-btn ar-btn-open';
                    const openText = document.createElement('span');
                    openText.textContent = I18n.t('panel.manualOpen');
                    openBtn.appendChild(openText);
                    openBtn.disabled = !safeUrl;
                    openBtn.title = safeUrl ? I18n.t('panel.manualOpenTitle') : I18n.t('panel.manualUnsafeUrl');
                    openBtn.onclick = () => {
                        if (safeUrl) window.open(safeUrl, '_blank', 'noopener,noreferrer');
                    };

                    const removeBtn = document.createElement('button');
                    removeBtn.className = 'ar-btn ar-remove-btn ar-icon-only';
                    removeBtn.innerHTML = uiIcon('trash', 'trash');
                    removeBtn.title = I18n.t('panel.manualRemoveTitle');
                    removeBtn.setAttribute('aria-label', I18n.t('panel.manualRemoveTitle'));
                    removeBtn.onclick = () => {
                        if (!confirm(I18n.t('confirm.removeManual'))) return;
                        if (!State.removeManualEntry(item.vid)) {
                            Metrics.bump('storage.manual.remove.failed');
                            log(`[CRITICAL_STORAGE_WRITE_FAILED] manual_queue: remove ${item.vid}`, true);
                            return;
                        }
                        renderManualList();
                    };

                    actions.appendChild(openBtn);
                    actions.appendChild(removeBtn);

                    row.appendChild(left);
                    row.appendChild(actions);
                    container.appendChild(row);
                });

                if (totalCount > PREVIEW_LIMIT) {
                    const moreBtn = document.createElement('button');
                    moreBtn.className = 'ar-btn ar-btn-soft ar-queue-more-btn';
                    moreBtn.innerHTML = `<span>${I18n.t('panel.manualMore', { count: totalCount })}</span>`;
                    moreBtn.title = I18n.t('panel.manualMoreTitle');
                    moreBtn.onclick = () => exportManualListHtml({ openInBrowser: true });
                    container.appendChild(moreBtn);
                }
            }

            renderImpl = renderManualList;
            window._hhApplyAssistantRenderManualQueue = renderImpl;
            renderImpl();
        }

        function render() { renderImpl(); }
        function destroy() {
            renderImpl = () => {};
            try { delete window._hhApplyAssistantRenderManualQueue; }
            catch (e) { window._hhApplyAssistantRenderManualQueue = undefined; }
        }
        return { mount, render, destroy };
    })();

    const StatsView = (() => {
        let renderImpl = () => {};

        function mount() {
            function renderStats() {
                const s = Stats.getAll();
                const setNum = (id, v) => { const n = document.getElementById(id); if (n) n.textContent = v; };
                setNum('ar-stat-attempts', s.attempts);
                setNum('ar-stat-success', s.success);
                setNum('ar-stat-manual', s.manual);
                setNum('ar-stat-skipped', s.skipped);
                const sent = State.getSentCount();
                const effectiveLimit = Math.max(config.limit, sent);
                const prog = document.getElementById('ar-stat-progress');
                if (prog) prog.textContent = `${sent} / ${effectiveLimit}`;
                const limitInput = document.getElementById('ar-limit-input');
                if (limitInput) {
                    limitInput.min = String(Math.max(1, sent));
                    limitInput.value = String(effectiveLimit);
                }
                const progressbar = document.getElementById('ar-execution-progress');
                if (progressbar) {
                    progressbar.setAttribute('aria-valuemax', String(effectiveLimit));
                    progressbar.setAttribute('aria-valuenow', String(sent));
                    progressbar.setAttribute('aria-label', I18n.t('panel.statsProgressTitle'));
                }
                const fill = document.getElementById('ar-progress-fill');
                if (fill) fill.style.width = clamp(Math.round(sent / Math.max(1, effectiveLimit) * 100), 0, 100) + '%';

                const tileAtt = document.getElementById('ar-stat-tile-attempts');
                const tileSuc = document.getElementById('ar-stat-tile-success');
                const tileMan = document.getElementById('ar-stat-tile-manual');
                const tileSkp = document.getElementById('ar-stat-tile-skip');
                if (tileSuc) tileSuc.classList.toggle('is-active-success', s.success > 0);
                if (tileMan) tileMan.classList.toggle('is-active-manual', s.manual > 0);
                if (tileSkp) tileSkp.classList.toggle('is-active-skip', s.skipped > 0);
                if (tileAtt) tileAtt.classList.toggle('is-active-attempts', s.attempts > 0);
            }
            window._hhApplyAssistantRenderStats = renderStats;
            renderStats();

            renderImpl = renderStats;
        }

        function render() { renderImpl(); }
        function destroy() {
            renderImpl = () => {};
            try { delete window._hhApplyAssistantRenderStats; }
            catch (e) { window._hhApplyAssistantRenderStats = undefined; }
        }
        return { mount, render, destroy };
    })();

    function isDiagnosticsVisible() {
        const panel = document.getElementById('ar-main-panel');
        const mainView = document.getElementById('ar-view-main');
        const diagnostics = document.getElementById('ar-view-diag');
        if (!panel || !mainView || !diagnostics || document.hidden) return false;
        if (panel.isConnected === false || mainView.isConnected === false || diagnostics.isConnected === false) return false;
        if (panel.style.display === 'none' || mainView.style.display !== 'none' || diagnostics.style.display === 'none') return false;
        return true;
    }

    const DiagnosticsView = (() => {
        let renderImpl = () => {};
        let updateImpl = () => {};
        let cancelScheduledImpl = () => {};
        let cancelSearchDebounceImpl = () => {};
        let onVisibilityChangeImpl = () => {};
        let lastRenderedVersion = -1;
        let lastRenderedLang = '';
        let activeFilter = 'all';
        let searchQuery = '';
        let viewOffset = 0;
        let autoScroll = true;
        let lastCheckSummary = { key: 'diag.checkSummaryIdle', params: {} };
        let diagnosticsDirty = true;
        const expandedGroups = new Set();
        const SEARCH_DEBOUNCE_MS = 140;

        const normalizeSearch = (value) => String(value || '').trim().toLocaleLowerCase();

        function groupConsecutive(items) {
            const groups = [];
            for (const item of items) {
                const prev = groups[groups.length - 1];
                if (prev && prev.msg === item.msg && prev.lvl === item.lvl) {
                    prev.count++;
                    prev.endT = item.t || Date.now();
                    prev.items.push(item);
                } else {
                    groups.push({
                        id: `${item.t || Date.now()}-${fnv1a32(`${item.lvl || 'INFO'}|${item.msg || ''}`).toString(36)}`,
                        msg: item.msg,
                        lvl: item.lvl,
                        startT: item.t || Date.now(),
                        endT: item.t || Date.now(),
                        count: 1,
                        items: [item]
                    });
                }
            }
            return groups;
        }

        const getLogGroupChildrenId = (group) => `ar-log-group-${group.id}`;

        function buildLogRow(group, isExpanded, onToggle) {
            const row = document.createElement('div');
            const isErr = group.lvl === 'ERR';
            const isWarn = group.lvl === 'WARN';
            const isOk = group.lvl === 'OK';
            const isGrouped = group.count > 1;
            row.className = 'ar-log-row' +
                (isErr ? ' is-error' : '') +
                (isWarn ? ' is-warning' : '') +
                (isGrouped ? ' is-grouped' : '');

            const time = document.createElement('span');
            time.className = 'ar-log-time';
            if (isGrouped && group.startT !== group.endT) {
                time.textContent = `${I18n.formatTime(group.startT)}–${I18n.formatTime(group.endT)}`;
            } else {
                time.textContent = I18n.formatTime(group.endT);
            }

            const level = document.createElement('span');
            level.className = 'ar-log-level' +
                (isErr ? ' ar-log-level--err' : isWarn ? ' ar-log-level--warn' : isOk ? ' ar-log-level--ok' : '');
            level.textContent = group.lvl || 'INFO';

            const msg = document.createElement('span');
            msg.className = 'ar-log-message';
            msg.textContent = group.msg;

            row.appendChild(time);
            row.appendChild(level);
            row.appendChild(msg);

            if (isGrouped) {
                const actionTitle = I18n.t(isExpanded ? 'diag.repeatCollapse' : 'diag.repeatExpand');
                const badge = document.createElement('button');
                badge.type = 'button';
                badge.className = 'ar-log-repeat';
                badge.textContent = `×${group.count}${isExpanded ? ' ▴' : ' ▾'}`;
                badge.title = actionTitle;
                badge.setAttribute('aria-label', actionTitle);
                badge.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
                badge.setAttribute('aria-controls', getLogGroupChildrenId(group));
                badge.onclick = (e) => {
                    e.stopPropagation();
                    onToggle();
                };
                row.appendChild(badge);
            }

            return row;
        }

        function mount({ el, uiSignal }) {
            cancelScheduledImpl();
            cancelSearchDebounceImpl();
            diagnosticsDirty = true;
            let scheduledRenderId = null;
            let scheduledRenderIsRaf = false;
            let searchDebounceTimer = 0;

            const cancelScheduledRender = () => {
                if (scheduledRenderId === null) return;
                if (scheduledRenderIsRaf && typeof cancelAnimationFrame === 'function') {
                    cancelAnimationFrame(scheduledRenderId);
                } else {
                    clearTimeout(scheduledRenderId);
                }
                scheduledRenderId = null;
            };

            const scheduleRender = () => {
                if (scheduledRenderId !== null) return;
                const run = () => {
                    scheduledRenderId = null;
                    if (diagnosticsDirty && isDiagnosticsVisible()) {
                        renderFullDiag({ preserveScroll: true });
                    }
                };
                if (typeof requestAnimationFrame === 'function') {
                    scheduledRenderIsRaf = true;
                    scheduledRenderId = requestAnimationFrame(run);
                } else {
                    scheduledRenderIsRaf = false;
                    scheduledRenderId = setTimeout(run, 0);
                }
            };
            cancelScheduledImpl = cancelScheduledRender;

            const cancelSearchDebounce = () => {
                if (!searchDebounceTimer) return;
                clearTimeout(searchDebounceTimer);
                searchDebounceTimer = 0;
            };
            cancelSearchDebounceImpl = cancelSearchDebounce;

            // ---------- Экран диагностики ----------
            const openFullDiag = () => {
                const viewMain = el('ar-view-main');
                const viewDiag = el('ar-view-diag');
                if (!viewMain || !viewDiag) return;
                viewMain.style.display = 'none';
                viewDiag.style.display = 'flex';
                WorkModeSlider.onVisibilityChange(false);
                cancelSearchDebounce();
                renderFullDiag();
                el('ar-diag-back-btn')?.focus();
            };

            const closeFullDiag = () => {
                const viewMain = el('ar-view-main');
                const viewDiag = el('ar-view-diag');
                if (!viewMain || !viewDiag) return;
                cancelScheduledRender();
                cancelSearchDebounce();
                viewDiag.style.display = 'none';
                viewMain.style.display = 'flex';
                el('ar-diag-full-box')?.replaceChildren();
                diagnosticsDirty = true;
                const panelEl = el('ar-main-panel');
                WorkModeSlider.onVisibilityChange(!!panelEl && panelEl.style.display !== 'none' && !document.hidden);
                el('ar-health-btn')?.focus();
            };

            function renderFullDiag({ preserveScroll = false } = {}) {
                cancelScheduledRender();
                if (!isDiagnosticsVisible()) {
                    diagnosticsDirty = true;
                    return;
                }
                const fullBox = el('ar-diag-full-box');
                if (!fullBox) return;

                const wasAtBottom = Math.abs((fullBox.scrollHeight - fullBox.scrollTop) - fullBox.clientHeight) <= 12;
                const previousScrollTop = fullBox.scrollTop;

                const all = DiagLog.getAll().map(item => ({
                    ...item,
                    msg: DiagnosticI18n.format(item)
                }));
                const visibleSource = all.slice(Math.min(viewOffset, all.length));
                const filtered = visibleSource.filter(item => {
                    if (activeFilter === 'errors' && item.lvl !== 'ERR') return false;
                    if (!searchQuery) return true;
                    const haystack = normalizeSearch(`${I18n.formatTime(item.t || Date.now())} ${item.lvl || 'INFO'} ${item.msg || ''}`);
                    return haystack.includes(searchQuery);
                });
                const groups = groupConsecutive(filtered);

                fullBox.innerHTML = '';

                if (!groups.length) {
                    const empty = document.createElement('div');
                    empty.className = 'ar-log-empty';
                    const emptyTitleKey = activeFilter === 'errors' && !searchQuery ? 'diag.emptyNoErrorsTitle'
                        : searchQuery ? 'diag.noEntries' : 'diag.emptyTitle';
                    const emptyHintKey = activeFilter === 'errors' && !searchQuery ? 'diag.emptyNoErrorsHint'
                        : searchQuery ? 'diag.emptySearchHint' : 'diag.emptyHint';
                    empty.innerHTML = `
                        <div class="ar-log-empty-inner">
                            <div class="ar-log-empty-icon">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                                    <circle cx="12" cy="12" r="9"></circle>
                                    <line x1="9" y1="10" x2="9.01" y2="10" stroke-width="2.6" stroke-linecap="round"></line>
                                    <line x1="15" y1="10" x2="15.01" y2="10" stroke-width="2.6" stroke-linecap="round"></line>
                                    <path d="M8 15s1.5 2 4 2 4-2 4-2" stroke-linecap="round"></path>
                                </svg>
                            </div>
                            <div class="ar-log-empty-title">${I18n.t(emptyTitleKey)}</div>
                            <div class="ar-log-empty-hint">${I18n.t(emptyHintKey)}</div>
                        </div>
                    `;
                    fullBox.appendChild(empty);
                } else {
                    const fragment = document.createDocumentFragment();
                    groups.forEach(group => {
                        const isExpanded = expandedGroups.has(group.id);
                        const toggleGroup = () => {
                            if (expandedGroups.has(group.id)) {
                                expandedGroups.delete(group.id);
                            } else {
                                expandedGroups.add(group.id);
                            }
                            renderFullDiag({ preserveScroll: true });
                            fullBox.querySelector(`[aria-controls="${getLogGroupChildrenId(group)}"]`)?.focus();
                        };

                        const row = buildLogRow(group, isExpanded, toggleGroup);
                        fragment.appendChild(row);

                        if (group.count > 1 && isExpanded) {
                            const childContainer = document.createElement('div');
                            childContainer.className = 'ar-log-group-children';
                            childContainer.id = getLogGroupChildrenId(group);
                            group.items.forEach(child => {
                                const childRow = document.createElement('div');
                                childRow.className = 'ar-log-child';
                                const childTime = document.createElement('span');
                                childTime.className = 'ar-log-child-time';
                                childTime.textContent = I18n.formatTime(child.t || Date.now());
                                const childMsg = document.createElement('span');
                                childMsg.className = 'ar-log-message';
                                childMsg.textContent = child.msg;
                                childRow.appendChild(childTime);
                                childRow.appendChild(childMsg);
                                childContainer.appendChild(childRow);
                            });
                            fragment.appendChild(childContainer);
                        }
                    });
                    fullBox.appendChild(fragment);
                }

                if (preserveScroll || !autoScroll) {
                    fullBox.scrollTop = previousScrollTop;
                } else if (wasAtBottom || autoScroll) {
                    fullBox.scrollTop = fullBox.scrollHeight;
                }

                diagnosticsDirty = false;
            }

            const backBtn = el('ar-diag-back-btn');
            if (backBtn) backBtn.onclick = closeFullDiag;

            const setFilter = (nextFilter) => {
                activeFilter = nextFilter === 'errors' ? 'errors' : 'all';
                for (const [id, value] of [['ar-diag-filter-all', 'all'], ['ar-diag-filter-errors', 'errors']]) {
                    const button = el(id);
                    if (!button) continue;
                    const active = activeFilter === value;
                    button.classList.toggle('is-active', active);
                    button.setAttribute('aria-pressed', active ? 'true' : 'false');
                }
                renderFullDiag();
            };
            el('ar-diag-filter-all')?.addEventListener('click', () => setFilter('all'), { signal: uiSignal });
            el('ar-diag-filter-errors')?.addEventListener('click', () => setFilter('errors'), { signal: uiSignal });

            const searchInput = el('ar-diag-search');
            const searchClear = el('ar-diag-search-clear');
            const syncSearchClear = () => { if (searchClear) searchClear.hidden = !(searchInput?.value || '').length; };
            searchInput?.addEventListener('input', () => {
                searchQuery = normalizeSearch(searchInput.value);
                syncSearchClear();
                diagnosticsDirty = true;
                cancelSearchDebounce();
                searchDebounceTimer = setTimeout(() => {
                    searchDebounceTimer = 0;
                    renderFullDiag({ preserveScroll: true });
                }, SEARCH_DEBOUNCE_MS);
            }, { signal: uiSignal });
            searchClear?.addEventListener('click', () => {
                if (!searchInput) return;
                cancelSearchDebounce();
                searchInput.value = '';
                searchQuery = '';
                syncSearchClear();
                searchInput.focus();
                renderFullDiag({ preserveScroll: true });
            }, { signal: uiSignal });

            const fullBox = el('ar-diag-full-box');
            const autoScrollInput = el('ar-diag-auto-scroll');
            if (autoScrollInput) {
                autoScrollInput.checked = autoScroll;
                autoScrollInput.addEventListener('change', () => {
                    autoScroll = autoScrollInput.checked;
                    if (autoScroll && fullBox) fullBox.scrollTop = fullBox.scrollHeight;
                }, { signal: uiSignal });
            }
            if (fullBox && typeof fullBox.addEventListener === 'function') {
                fullBox.addEventListener('scroll', () => {
                    const nextAutoScroll = fullBox.scrollHeight - fullBox.scrollTop - fullBox.clientHeight <= 18;
                    if (nextAutoScroll !== autoScroll) {
                        autoScroll = nextAutoScroll;
                        if (autoScrollInput) autoScrollInput.checked = autoScroll;
                    }
                }, { signal: uiSignal, passive: true });
            }

            const moreDropdown = el('ar-diag-full-dropdown');
            const moreButton = el('ar-diag-full-more-btn');
            const moreMenu = el('ar-diag-full-menu');
            const getMoreItems = () => moreMenu ? Array.from(moreMenu.querySelectorAll('[role="menuitem"]')) : [];
            const setMoreMenuOpen = (open, { focusItem = '', restoreFocus = false } = {}) => {
                if (!moreDropdown || !moreButton) return;
                moreDropdown.classList.toggle('is-open', open);
                moreButton.setAttribute('aria-expanded', open ? 'true' : 'false');
                if (open && focusItem) {
                    const items = getMoreItems();
                    const target = focusItem === 'last' ? items[items.length - 1] : items[0];
                    target?.focus();
                } else if (!open && restoreFocus) {
                    moreButton.focus();
                }
            };

            if (moreButton && moreDropdown && moreMenu) {
                moreButton.addEventListener('click', (event) => {
                    event.stopPropagation();
                    const willOpen = !moreDropdown.classList.contains('is-open');
                    setMoreMenuOpen(willOpen, { focusItem: willOpen && event.detail === 0 ? 'first' : '' });
                }, { signal: uiSignal });
                moreButton.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        const willOpen = !moreDropdown.classList.contains('is-open');
                        setMoreMenuOpen(willOpen, { focusItem: willOpen ? 'first' : '' });
                        return;
                    }
                    if (event.key === 'Escape' && moreDropdown.classList.contains('is-open')) {
                        event.preventDefault();
                        setMoreMenuOpen(false, { restoreFocus: true });
                        return;
                    }
                    if (event.key === 'Tab' && moreDropdown.classList.contains('is-open')) {
                        event.preventDefault();
                        setMoreMenuOpen(false);
                        (event.shiftKey ? el('ar-diag-full-save') : el('ar-diag-full-box'))?.focus();
                        return;
                    }
                    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const focusItem = event.key === 'ArrowUp' || event.key === 'End' ? 'last' : 'first';
                    setMoreMenuOpen(true, { focusItem });
                }, { signal: uiSignal });
                moreMenu.addEventListener('keydown', (event) => {
                    const items = getMoreItems();
                    if (!items.length) return;
                    const currentIndex = Math.max(0, items.indexOf(document.activeElement));
                    let targetIndex = -1;
                    if (event.key === 'ArrowDown') targetIndex = (currentIndex + 1) % items.length;
                    else if (event.key === 'ArrowUp') targetIndex = (currentIndex - 1 + items.length) % items.length;
                    else if (event.key === 'Home') targetIndex = 0;
                    else if (event.key === 'End') targetIndex = items.length - 1;
                    else if (event.key === 'Escape') {
                        event.preventDefault();
                        setMoreMenuOpen(false, { restoreFocus: true });
                        return;
                    } else if (event.key === 'Tab') {
                        event.preventDefault();
                        setMoreMenuOpen(false);
                        (event.shiftKey ? moreButton : el('ar-diag-full-box'))?.focus();
                        return;
                    } else {
                        return;
                    }
                    event.preventDefault();
                    items[targetIndex]?.focus();
                }, { signal: uiSignal });
            }

            document.addEventListener('click', (event) => {
                if (moreDropdown && !moreDropdown.contains(event.target)) setMoreMenuOpen(false);
            }, { signal: uiSignal });

            const diagFullClearBox = el('ar-diag-full-clear-box');
            if (diagFullClearBox) diagFullClearBox.onclick = () => {
                cancelScheduledRender();
                viewOffset = DiagLog.getAll().length;
                expandedGroups.clear();
                renderFullDiag();
                setMoreMenuOpen(false, { restoreFocus: true });
            };

            const updateCheckSummary = () => {
                const status = el('ar-diag-check-status');
                if (!status) return;
                status.replaceChildren();
                if (lastCheckSummary.key === 'diag.checkSummaryIdle') return;
                const progress = document.createElement('span');
                progress.className = 'ar-diag-check-progress';
                progress.textContent = I18n.t('diag.checkSummaryProgress', lastCheckSummary.params);
                const ok = document.createElement('span');
                ok.className = 'ar-diag-check-ok';
                ok.textContent = I18n.t('diag.checkSummaryOk');
                status.append(progress, ok);
            };

            // Счётчик записей и ошибок в постоянном логе с проверкой версий
            const updateDiagCount = (force = false) => {
                const stats = DiagLog.getStats();
                const curLang = I18n.getLanguage();
                if (!force && stats.version === lastRenderedVersion && curLang === lastRenderedLang) {
                    return;
                }
                lastRenderedVersion = stats.version;
                lastRenderedLang = curLang;

                const errors = stats.errors;
                const total = stats.total;
                const errText = I18n.plural(errors, 'error');

                const badge = el('ar-health-badge');
                const healthBtn = el('ar-health-btn');
                if (badge) {
                    if (errors > 0) {
                        badge.textContent = errors;
                        badge.style.display = 'inline-flex';
                        if (healthBtn) {
                            healthBtn.title = I18n.t('diag.badgeTitle', { errText });
                        }
                    } else {
                        badge.textContent = '';
                        badge.style.display = 'none';
                        if (healthBtn) {
                            healthBtn.title = I18n.t('diag.badgeTitleClean');
                        }
                    }
                }

                const allCount = el('ar-diag-filter-all-count');
                const errorCount = el('ar-diag-filter-errors-count');
                if (allCount) allCount.textContent = total;
                if (errorCount) errorCount.textContent = errors;
                el('ar-diag-filter-errors')?.classList.toggle('has-errors', errors > 0);
                updateCheckSummary();
            };

            const ownedUpdateBadge = (force) => updateDiagCount(force);
            const ownedRenderDiag = () => {
                diagnosticsDirty = true;
                if (isDiagnosticsVisible()) scheduleRender();
            };

            const handleVisibilityChange = () => {
                if (!isDiagnosticsVisible()) {
                    cancelScheduledRender();
                    cancelSearchDebounce();
                    return;
                }
                if (diagnosticsDirty) {
                    cancelSearchDebounce();
                    renderFullDiag({ preserveScroll: true });
                }
            };
            onVisibilityChangeImpl = handleVisibilityChange;
            document.addEventListener('visibilitychange', handleVisibilityChange, { signal: uiSignal });

            window._hhApplyAssistantUpdateDiagBadge = ownedUpdateBadge;
            window._hhApplyAssistantRenderDiagnostics = ownedRenderDiag;
            updateDiagCount(true);

            // Выгрузка полного диагностического лога в файл
            const exportLogs = () => {
                exportDiagnosticReport();
                updateDiagCount(true);
            };
            const diagFullSaveBtn = el('ar-diag-full-save');
            if (diagFullSaveBtn) diagFullSaveBtn.onclick = exportLogs;

            // Очистка постоянного лога
            const handleClearAllDiag = () => {
                setMoreMenuOpen(false, { restoreFocus: true });
                if (confirm(I18n.t('confirm.clearDiag'))) {
                    cancelScheduledRender();
                    DiagLog.clear();
                    Metrics.clear();
                    viewOffset = 0;
                    expandedGroups.clear();
                    const fullBox = el('ar-diag-full-box');
                    if (fullBox) fullBox.innerHTML = '';
                    updateDiagCount(true);
                    log(I18n.t('logs.diagCleared'));
                }
            };
            const diagFullClearAll = el('ar-diag-full-clear-all');
            if (diagFullClearAll) diagFullClearAll.onclick = handleClearAllDiag;

            const healthButton = el('ar-health-btn');
            if (healthButton) healthButton.onclick = openFullDiag;
            const checkButton = el('ar-diag-full-check');
            if (checkButton) checkButton.onclick = () => {
                runHealthCheck();
                lastCheckSummary = { key: 'diag.checkSummaryOk', params: { passed: 3 } };
                updateCheckSummary();
            };

            renderImpl = renderFullDiag;
            updateImpl = updateDiagCount;
        }

        function refresh() {
            updateImpl(true);
            cancelSearchDebounceImpl();
            diagnosticsDirty = true;
            if (isDiagnosticsVisible()) renderImpl();
        }
        function destroy() {
            cancelScheduledImpl();
            cancelSearchDebounceImpl();
            renderImpl = () => {};
            updateImpl = () => {};
            cancelScheduledImpl = () => {};
            cancelSearchDebounceImpl = () => {};
            onVisibilityChangeImpl = () => {};
            lastRenderedVersion = -1;
            lastRenderedLang = '';
            diagnosticsDirty = true;
            expandedGroups.clear();
            try {
                delete window._hhApplyAssistantRenderDiagnostics;
                delete window._hhApplyAssistantUpdateDiagBadge;
            } catch (e) {
                window._hhApplyAssistantRenderDiagnostics = undefined;
                window._hhApplyAssistantUpdateDiagBadge = undefined;
            }
        }
        return {
            mount,
            refresh,
            onVisibilityChange: () => onVisibilityChangeImpl(),
            destroy
        };
    })();

    const LocalizationBinder = (() => {
        let el = null;
        let panel = null;

        const textBindings = [
            ['ar-work-mode-label', 'panel.modeTitle'],
            ['ar-work-mode-option-safe', 'presets.safe.label'],
            ['ar-work-mode-option-balanced', 'presets.balanced.label'],
            ['ar-work-mode-option-fast', 'presets.fast.label'],
            ['ar-work-mode-option-turbo', 'presets.turbo.label'],
            ['ar-mode-help-title', 'panel.modeHelpTitle'],
            ['ar-mode-help-safe-title', 'panel.modeHelpSafeTitle'],
            ['ar-mode-help-safe-text', 'panel.modeHelpSafeText'],
            ['ar-mode-help-balanced-title', 'panel.modeHelpBalancedTitle'],
            ['ar-mode-help-balanced-text', 'panel.modeHelpBalancedText'],
            ['ar-mode-help-fast-title', 'panel.modeHelpFastTitle'],
            ['ar-mode-help-fast-text', 'panel.modeHelpFastText'],
            ['ar-mode-help-turbo-title', 'panel.modeHelpTurboTitle'],
            ['ar-mode-help-turbo-text', 'panel.modeHelpTurboText'],
            ['ar-mode-help-note', 'panel.modeHelpNote'],
            ['ar-limit-label', 'panel.limitShort'],
            ['ar-cover-card-title', 'cover.title'],
            ['ar-apply-reject-label', 'cover.rejectWarningLabel'],
            ['ar-warning-help-title', 'cover.rejectWarningHelpTitle'],
            ['ar-warning-help-text', 'cover.rejectWarningHelpText'],
            ['ar-start-btn-text', 'panel.startBtn'],
            ['ar-stop-btn-text', 'panel.stopBtn'],
            ['ar-reset-history-text', 'panel.resetHistory'],
            ['ar-health-btn-text', 'panel.diagnostics'],
            ['ar-stats-card-title', 'panel.statsTitle'],
            ['ar-stat-cap-attempts', 'panel.statAttempts'],
            ['ar-stat-cap-success', 'panel.statSuccess'],
            ['ar-stat-cap-manual', 'panel.statManual'],
            ['ar-stat-cap-skipped', 'panel.statSkipped'],
            ['ar-manual-card-title', 'panel.manualTitle'],
            ['ar-export-manual', 'panel.manualExport'],
            ['ar-clear-manual', 'panel.manualClear'],
            ['ar-diag-back-text', 'diag.backBtn'],
            ['ar-diag-view-title', 'diag.title'],
            ['ar-diag-full-save', 'diag.downloadLog'],
            ['ar-diag-full-check', 'diag.checkSelectors'],
            ['ar-diag-filter-all-text', 'diag.filterAll'],
            ['ar-diag-filter-errors-text', 'diag.filterErrors'],
            ['ar-diag-auto-scroll-text', 'diag.autoScroll'],
            ['ar-diag-more-text', 'diag.moreBtn'],
            ['ar-diag-full-clear-box', 'diag.clearView'],
            ['ar-diag-full-clear-all', 'diag.clearAll']
        ];

        const titleBindings = [
            ['ar-limit-label', 'panel.limitLabel'],
            ['ar-reset-history', 'panel.resetHistoryTitle'],
            ['ar-health-btn', 'panel.diagnosticsTitle'],
            ['ar-stat-progress', 'panel.statsProgressTitle'],
            ['ar-manual-count', 'panel.manualCountTitle'],
            ['ar-diag-back-btn', 'diag.backTitle'],
            ['ar-diag-full-save', 'diag.downloadLogTitle'],
            ['ar-diag-full-check', 'diag.checkSelectors'],
            ['ar-diag-full-more-btn', 'diag.moreTitle']
        ];

        function refresh() {
            if (!el) return;
            const currentLang = I18n.getLanguage();
            const mainPanel = el('ar-main-panel');
            if (mainPanel) mainPanel.setAttribute('lang', currentLang);

            const diagSearch = el('ar-diag-search');
            if (diagSearch) {
                diagSearch.placeholder = I18n.t('diag.searchPlaceholder');
                diagSearch.setAttribute('aria-label', I18n.t('diag.searchLabel'));
            }
            const diagSearchClear = el('ar-diag-search-clear');
            if (diagSearchClear) {
                diagSearchClear.title = I18n.t('diag.clearSearch');
                diagSearchClear.setAttribute('aria-label', I18n.t('diag.clearSearch'));
            }
            const diagFilterGroup = el('ar-diag-filter-group');
            if (diagFilterGroup) diagFilterGroup.setAttribute('aria-label', I18n.t('diag.filterLabel'));
            const diagMore = el('ar-diag-full-more-btn');
            if (diagMore) diagMore.setAttribute('aria-label', I18n.t('diag.moreTitle'));
            const progressbar = el('ar-execution-progress');
            if (progressbar) progressbar.setAttribute('aria-label', I18n.t('panel.statsProgressTitle'));

            const toggle = el('ar-toggle-btn');
            if (toggle) {
                toggle.setAttribute('lang', currentLang);
                syncCollapsedToggleState(toggle);
            }

            qa('.ar-lang-btn', mainPanel).forEach(btn => {
                const active = btn.dataset.lang === currentLang;
                btn.classList.toggle('is-active', active);
                btn.setAttribute('aria-pressed', active ? 'true' : 'false');
            });

            for (const [id, key] of textBindings) {
                const node = el(id);
                if (node) node.textContent = I18n.t(key);
            }
            for (const [id, key] of titleBindings) {
                const node = el(id);
                if (node) node.title = I18n.t(key);
            }

            const setIconButton = (id, iconName, label) => {
                const node = el(id);
                if (!node) return;
                node.classList.add('ar-icon-only');
                node.innerHTML = uiIcon(iconName);
                node.title = label;
                node.setAttribute('aria-label', label);
            };

            const minimizeTitle = I18n.t('panel.minimizeTitle');
            setIconButton('ar-minimize-btn', 'chevronDown', minimizeTitle);
            setIconButton('ar-minimize-diag-btn', 'chevronDown', minimizeTitle);
            setIconButton('ar-work-mode-help-btn', 'help', I18n.t('panel.modeHelpAria'));
            setIconButton('ar-warning-help-btn', 'help', I18n.t('cover.rejectWarningHelpAria'));

            const currentPresetKey = PRESETS[config.preset] ? config.preset : DEFAULT_PRESET;
            const modeLabel = presetLabel(currentPresetKey);

            const slider = el('ar-work-mode-slider');
            if (slider) {
                slider.setAttribute('aria-label', I18n.t('panel.modeTitle'));
                slider.setAttribute('aria-valuetext', modeLabel);
            }
            const help = el('ar-work-mode-help-btn');
            if (help) {
                help.setAttribute('aria-label', I18n.t('panel.modeHelpAria'));
                help.title = I18n.t('panel.modeHelpAria');
            }
            const cover = el('ar-cover-text');
            if (cover) cover.placeholder = I18n.t('cover.placeholder');
            AutosaveFeedback.refresh();

            setStatus(currentStatusState.statusKey, currentStatusState.customKeyOrText, currentStatusState.params);
            StatsView.render();
            ManualQueueView.render();
            DiagnosticsView.refresh();
        }

        function mount({ el: getEl, panel: rootPanel, uiSignal }) {
            el = getEl;
            panel = rootPanel;
            qa('.ar-lang-btn', panel).forEach(btn => {
                btn.addEventListener('click', (event) => {
                    event.stopPropagation();
                    const targetLang = btn.dataset.lang;
                    if (!targetLang || targetLang === I18n.getLanguage()) return;
                    I18n.setLanguage(targetLang);
                    refresh();
                    log(I18n.t('logs.languageSet', { language: I18n.t(`languages.${targetLang}`) }));
                }, { signal: uiSignal });
            });
        }

        function destroy() {
            el = null;
            panel = null;
        }

        return { mount, refresh, destroy };
    })();

    function getResponsivePanelLayout(viewportWidth) {
        const viewport = Math.max(0, Math.floor(Number(viewportWidth) || 0));
        const availableForPanel = viewport - HHA_MIN_HOST_WIDTH;

        if (availableForPanel >= HHA_PREFERRED_PANEL_WIDTH) {
            return {
                mode: 'full',
                panelWidth: HHA_PREFERRED_PANEL_WIDTH,
                hostWidth: viewport - HHA_PREFERRED_PANEL_WIDTH,
            };
        }
        if (availableForPanel >= HHA_MIN_PANEL_WIDTH) {
            return {
                mode: 'compact',
                panelWidth: availableForPanel,
                hostWidth: HHA_MIN_HOST_WIDTH,
            };
        }
        return {
            mode: 'overlay',
            panelWidth: Math.min(HHA_PREFERRED_PANEL_WIDTH, viewport),
            hostWidth: viewport,
        };
    }

    const HostLayoutReservation = (() => {
        const SIDEBAR_WIDTH_PROPERTY = '--hha-sidebar-width';
        const PANEL_WIDTH_PROPERTY = '--hha-panel-width';
        const MODE_CLASSES = ['hha-full-dock', 'hha-compact', 'hha-overlay'];
        let panel = null;
        let resizeObserver = null;
        let panelVisible = false;
        let currentLayout = null;
        let onLayoutChange = null;

        const getLayoutViewportWidth = () => {
            const innerWidth = Math.max(0, Number(window.innerWidth) || 0);
            const clientWidth = Math.max(0, Number(document.documentElement?.clientWidth) || 0);
            if (innerWidth && clientWidth) return Math.min(innerWidth, clientWidth);
            return clientWidth || innerWidth;
        };

        const clearHostLayoutReservation = () => {
            document.documentElement.classList.remove('hha-docked');
            const rootStyle = document.documentElement && document.documentElement.style;
            if (!rootStyle) return;
            if (typeof rootStyle.removeProperty === 'function') {
                rootStyle.removeProperty(SIDEBAR_WIDTH_PROPERTY);
            } else if (typeof rootStyle.setProperty === 'function') {
                rootStyle.setProperty(SIDEBAR_WIDTH_PROPERTY, '');
            }
        };

        const syncHostLayoutReservation = () => {
            if (!panelVisible || currentLayout?.mode === 'overlay' || !panel || panel.isConnected === false) {
                clearHostLayoutReservation();
                return;
            }
            const rect = typeof panel.getBoundingClientRect === 'function'
                ? panel.getBoundingClientRect()
                : { width: panel.offsetWidth || currentLayout.panelWidth || 0 };
            const width = Math.max(0, Math.ceil(Number(rect.width) || 0));
            document.documentElement.style?.setProperty?.(SIDEBAR_WIDTH_PROPERTY, `${width}px`);
            document.documentElement.classList.add('hha-docked');
        };

        const applyHostLayoutReservation = () => {
            panelVisible = true;
            syncHostLayoutReservation();
        };

        const setPanelVisible = (visible) => {
            panelVisible = !!visible;
            if (panelVisible) applyHostLayoutReservation();
            else clearHostLayoutReservation();
        };

        const syncResponsiveDocking = () => {
            if (!panel || panel.isConnected === false) return currentLayout;
            const nextLayout = getResponsivePanelLayout(getLayoutViewportWidth());
            const previousLayout = currentLayout;
            currentLayout = nextLayout;

            const root = document.documentElement;
            root.style?.setProperty?.(PANEL_WIDTH_PROPERTY, `${nextLayout.panelWidth}px`);
            MODE_CLASSES.forEach(className => root.classList.remove(className));
            root.classList.add(
                nextLayout.mode === 'full'
                    ? 'hha-full-dock'
                    : nextLayout.mode === 'compact'
                        ? 'hha-compact'
                        : 'hha-overlay'
            );

            const changed = !previousLayout
                || previousLayout.mode !== nextLayout.mode
                || previousLayout.panelWidth !== nextLayout.panelWidth
                || previousLayout.hostWidth !== nextLayout.hostWidth;
            if (changed && typeof onLayoutChange === 'function') {
                onLayoutChange(nextLayout, previousLayout);
            }
            syncHostLayoutReservation();
            return nextLayout;
        };

        const mount = (panelElement, uiSignal, layoutChangeHandler) => {
            panel = panelElement;
            onLayoutChange = layoutChangeHandler;
            if (typeof ResizeObserver === 'function') {
                resizeObserver = new ResizeObserver(syncHostLayoutReservation);
                resizeObserver.observe(panel);
            }
            window.addEventListener('resize', syncResponsiveDocking, { signal: uiSignal });
            return syncResponsiveDocking();
        };

        const destroy = () => {
            panelVisible = false;
            clearHostLayoutReservation();
            if (resizeObserver) resizeObserver.disconnect();
            resizeObserver = null;
            panel = null;
            currentLayout = null;
            onLayoutChange = null;
            const root = document.documentElement;
            MODE_CLASSES.forEach(className => root.classList.remove(className));
            root.classList.remove('hha-overlay-open');
            if (typeof root.style?.removeProperty === 'function') {
                root.style.removeProperty(PANEL_WIDTH_PROPERTY);
            } else {
                root.style?.setProperty?.(PANEL_WIDTH_PROPERTY, '');
            }
        };

        return {
            mount,
            setPanelVisible,
            applyHostLayoutReservation,
            clearHostLayoutReservation,
            syncHostLayoutReservation,
            syncResponsiveDocking,
            getLayout: () => currentLayout,
            destroy,
        };
    })();

    let uiAbortController = null;

    function cleanupUI() {
        HostLayoutReservation.destroy();
        WorkModeSlider.destroy();
        AutosaveFeedback.destroy();
        LocalizationBinder.destroy();
        DiagnosticsView.destroy();
        StatsView.destroy();
        ManualQueueView.destroy();
        if (uiAbortController) {
            try { uiAbortController.abort(); } catch (e) { /* ignore */ }
            uiAbortController = null;
        }
        const oldToggle = document.getElementById('ar-toggle-btn');
        if (oldToggle) oldToggle.remove();
        const oldPanel = document.getElementById('ar-main-panel');
        if (oldPanel) oldPanel.remove();
        document.documentElement.classList.remove('hha-docked');
    }

    function setupUI() {
        if (document.getElementById('ar-main-panel')) return;
        if (!document.body) return;

        cleanupUI();
        uiAbortController = new AbortController();
        const uiSignal = uiAbortController.signal;

        injectPanelStyles();

        const lang = I18n.getLanguage();

        // Свёрнутое состояние - вертикальная вкладка HH Apply Assistant
        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'ar-toggle-btn';
        toggleBtn.type = 'button';
        toggleBtn.setAttribute('lang', lang);
        toggleBtn.innerHTML = '<span class="ar-tab-text">Apply Assistant</span>';
        toggleBtn.title = I18n.t('panel.expandTitle');
        toggleBtn.setAttribute('aria-label', I18n.t('panel.expandTitle'));
        toggleBtn.style.display = 'none';
        document.body.appendChild(toggleBtn);

        const panel = document.createElement('div');
        panel.id = 'ar-main-panel';
        panel.setAttribute('lang', lang);
        panel.innerHTML = buildPanelHtml();
        document.body.appendChild(panel);

        const el = (id) => document.getElementById(id);

        // ---------- Начальные значения из конфига ----------
        el('ar-cover-text').value = config.coverText;
        el('ar-use-cover-check').checked = config.useCover;
        el('ar-apply-reject-check').checked = config.applyOnRejectWarning;
        el('ar-limit-input').min = String(Math.max(1, State.getSentCount()));
        el('ar-limit-input').value = config.limit;
        restoreStatusAfterMount();

        // Письмо: счётчик символов и явное выключенное состояние поля.
        const coverArea = el('ar-cover-text');
        const coverCounter = el('ar-cover-counter');
        const renderCoverState = () => {
            const on = el('ar-use-cover-check').checked;
            coverArea.disabled = !on;
            if (coverCounter) {
                const len = (coverArea.value || '').length;
                coverCounter.textContent = `${len} / 5000`;
                coverCounter.classList.toggle('is-near', len >= 4800);
                coverCounter.classList.toggle('is-off', !on);
            }
        };
        coverArea.addEventListener('input', renderCoverState, { signal: uiSignal });
        el('ar-use-cover-check').addEventListener('change', renderCoverState, { signal: uiSignal });
        renderCoverState();

        WorkModeSlider.mount({ el, uiSignal });
        AutosaveFeedback.mount({ el });
        HelpPopoverController.mount({ panel, uiSignal });

        // ---------- Сохранение настроек ----------
        const saveSettings = () => {
            const nextConfig = Settings.normalize({
                ...config,
                coverText: el('ar-cover-text').value,
                useCover: el('ar-use-cover-check').checked,
                applyOnRejectWarning: el('ar-apply-reject-check').checked,
                limit: Math.max(Number(el('ar-limit-input').value) || 1, State.getSentCount())
            });
            if (!persistSettings(nextConfig)) {
                el('ar-cover-text').value = config.coverText;
                el('ar-use-cover-check').checked = config.useCover;
                el('ar-apply-reject-check').checked = config.applyOnRejectWarning;
                el('ar-limit-input').value = config.limit;
                renderCoverState();
                return;
            }
            el('ar-limit-input').min = String(Math.max(1, State.getSentCount()));
            el('ar-limit-input').value = config.limit;
            StatsView.render();
            AutosaveFeedback.showSaved();
            log(I18n.t('logs.settingsSaved'));
        };
        ['ar-cover-text', 'ar-use-cover-check', 'ar-apply-reject-check', 'ar-limit-input']
            .forEach(id => { const node = el(id); if (node) node.addEventListener('change', saveSettings, { signal: uiSignal }); });

        DiagnosticsView.mount({ el, uiSignal });
        ManualQueueView.mount({ el });
        StatsView.mount();
        LocalizationBinder.mount({ el, panel, uiSignal });


        // ---------- Управление ----------
        el('ar-start-btn').onclick = startLoop;
        el('ar-stop-btn').onclick = stopRun;

        el('ar-reset-history').onclick = () => {
            if (confirm(I18n.t('confirm.resetHistory'))) {
                const historyCleared = State.clearProcessedIDs();
                const sentCleared = State.resetSentCount();
                if (!historyCleared || !sentCleared) {
                    Metrics.bump('storage.history.reset.failed');
                    log('[CRITICAL_STORAGE_WRITE_FAILED] processed_ids/sent_count: reset', true);
                    return;
                }
                Stats.reset();
                StatsView.render();
                log(I18n.t('logs.historyReset'));
            }
        };

        // ---------- Сворачивание панели ----------
        let manualOpen = storage.localGet(KEYS.uiOpen) !== '0';
        let overlayOpen = false;
        let responsiveLayout = null;
        let focusBeforeCollapse = null;

        const renderResponsiveVisibility = () => {
            const isOverlay = responsiveLayout?.mode === 'overlay';
            const isVisible = isOverlay ? overlayOpen : manualOpen;
            panel.style.display = isVisible ? 'flex' : 'none';
            toggleBtn.style.display = isVisible ? 'none' : 'flex';
            document.documentElement.classList.toggle('hha-overlay-open', isOverlay && isVisible);
            HostLayoutReservation.setPanelVisible(isVisible);
            WorkModeSlider.onVisibilityChange(isVisible);
            DiagnosticsView.onVisibilityChange();
        };

        const minimizePanel = () => {
            const activeElement = document.activeElement;
            if (activeElement && panel.contains(activeElement)) focusBeforeCollapse = activeElement;
            if (responsiveLayout?.mode === 'overlay') {
                overlayOpen = false;
            } else {
                manualOpen = false;
                storage.localSet(KEYS.uiOpen, '0');
            }
            renderResponsiveVisibility();
            if (focusBeforeCollapse) toggleBtn.focus();
        };

        const expandPanel = () => {
            if (responsiveLayout?.mode === 'overlay') {
                overlayOpen = true;
            } else {
                manualOpen = true;
                storage.localSet(KEYS.uiOpen, '1');
            }
            renderResponsiveVisibility();
            const diagnosticsOpen = el('ar-view-diag')?.style.display !== 'none';
            const candidate = focusBeforeCollapse;
            const candidateView = candidate?.closest?.('.ar-view');
            const canRestore = !!candidate
                && candidate.isConnected
                && panel.contains(candidate)
                && !candidate.disabled
                && candidateView?.style.display !== 'none';
            const fallback = diagnosticsOpen
                ? el('ar-diag-back-btn')
                : panel.querySelector('.ar-lang-btn.is-active, #ar-use-cover-check');
            (canRestore ? candidate : fallback)?.focus();
            focusBeforeCollapse = null;
        };
        el('ar-minimize-btn').onclick = minimizePanel;
        const minDiagBtn = el('ar-minimize-diag-btn');
        if (minDiagBtn) minDiagBtn.onclick = minimizePanel;
        toggleBtn.onclick = expandPanel;

        responsiveLayout = HostLayoutReservation.mount(panel, uiSignal, (nextLayout, previousLayout) => {
            if (!previousLayout || nextLayout.mode !== previousLayout.mode) overlayOpen = false;
            responsiveLayout = nextLayout;
            renderResponsiveVisibility();
        });
        renderResponsiveVisibility();

    }

    const PanelController = {
        mount: setupUI,
        destroy: cleanupUI
    };

    // Пробегает по ключевым селекторам с учетом контекста страницы
    function runHealthCheck() {
        // Независимый fallback: ссылки /vacancy/ на странице — не зависят от data-qa/class SELECTORS
        const hasSearchCards = () => !!(q(SELECTORS.vacancyCard) || q(SELECTORS.vacancyLink) || q(SELECTORS.applyBtn) || q('a[href*="/vacancy/"]'));
        const isResponseModalOpen = () => {
            const m = q('[data-qa*="modal" i], [class*="modal" i], [role="dialog"]');
            return !!(m && isVisible(m));
        };

        const checks = [
            {
                name: I18n.t('health.applyBtnList'),
                sel: SELECTORS.applyBtn,
                key: 'applyBtn',
                evaluate: () => {
                    if (Page.isSearch()) {
                        return hasSearchCards()
                            ? { required: true }
                            : { required: false, reason: I18n.t('health.reasons.emptySearch') };
                    }
                    if (Page.isVacancy()) return { required: false, reason: I18n.t('health.reasons.onVacancyPage') };
                    if (Page.isResponseForm()) return { required: false, reason: I18n.t('health.reasons.onResponsePage') };
                    return { required: false, reason: I18n.t('health.reasons.notApplicable') };
                }
            },
            {
                name: I18n.t('health.vacancyApply'),
                sel: SELECTORS.vacancyApply,
                key: 'vacancyApply',
                evaluate: () => {
                    if (Page.isVacancy()) {
                        return detectAlreadyApplied()
                            ? { required: false, reason: I18n.t('health.reasons.alreadyApplied') }
                            : { required: true };
                    }
                    if (Page.isSearch()) return { required: false, reason: I18n.t('health.reasons.onSearchPage') };
                    if (Page.isResponseForm()) return { required: false, reason: I18n.t('health.reasons.onResponsePage') };
                    return { required: false, reason: I18n.t('health.reasons.notApplicable') };
                }
            },
            {
                name: I18n.t('health.vacancyLink'),
                sel: SELECTORS.vacancyLink,
                key: 'vacancyLink',
                evaluate: () => {
                    if (Page.isSearch()) {
                        return hasSearchCards()
                            ? { required: true }
                            : { required: false, reason: I18n.t('health.reasons.emptySearch') };
                    }
                    if (Page.isVacancy()) return { required: false, reason: I18n.t('health.reasons.onVacancyPage') };
                    if (Page.isResponseForm()) return { required: false, reason: I18n.t('health.reasons.onResponsePage') };
                    return { required: false, reason: I18n.t('health.reasons.notApplicable') };
                }
            },
            {
                name: I18n.t('health.attachCoverBtn'),
                sel: SELECTORS.attachCoverBtn,
                key: 'attachCoverBtn',
                evaluate: () => {
                    return { required: false, reason: I18n.t('health.reasons.notInScenario') };
                }
            },
            {
                name: I18n.t('health.letterSubmit'),
                sel: SELECTORS.letterSubmit,
                key: 'letterSubmit',
                evaluate: () => {
                    if (Page.isResponseForm()) {
                        return pageLooksLikeTest()
                            ? { required: false, reason: I18n.t('health.reasons.questionnaire') }
                            : { required: true };
                    }
                    if (isResponseModalOpen()) {
                        return { required: true };
                    }
                    return { required: false, reason: I18n.t('health.reasons.modalNotOpen') };
                }
            },
            {
                name: I18n.t('health.letterTextarea'),
                sel: SELECTORS.letterTextarea,
                key: 'letterTextarea',
                evaluate: () => {
                    if (Page.isResponseForm()) {
                        if (pageLooksLikeTest()) return { required: false, reason: I18n.t('health.reasons.questionnaire') };
                        return { required: false, reason: I18n.t('health.reasons.letterNotExpanded') };
                    }
                    if (isResponseModalOpen()) {
                        return { required: false, reason: I18n.t('health.reasons.letterNotExpanded') };
                    }
                    return { required: false, reason: I18n.t('health.reasons.modalNotOpen') };
                }
            }
        ];

        log(I18n.t('health.starting'));
        let okCount = 0;
        let skipCount = 0;
        let errCount = 0;

        checks.forEach(c => {
            const found = q(c.sel);
            const fallbackFound = found ? null : query(c.key);
            if (found) {
                okCount++;
                log(I18n.t('health.statusOk', { name: c.name, sel: c.sel }));
            } else if (fallbackFound) {
                okCount++;
                log(I18n.t('health.statusFallback', { name: c.name, sel: c.sel }), false);
            } else {
                const ctx = c.evaluate ? c.evaluate() : { required: true };
                if (ctx.required) {
                    errCount++;
                    log(I18n.t('health.statusNotFound', { name: c.name, sel: c.sel }), true);
                } else {
                    skipCount++;
                    log(I18n.t('health.statusSkipped', { name: c.name, reason: ctx.reason || I18n.t('health.reasons.notApplicable') }), false);
                }
            }
        });

        const errText = I18n.plural(errCount, 'error');
        log(I18n.t('health.summary', { okCount, skipCount, errText }));

        const obj = parseJson(storage.localGet(KEYS.instanceLock), null);
        if (obj) {
            log(I18n.t('health.instanceLock', { tabId: obj.tabId, ts: I18n.formatTime(obj.ts) }));
        } else {
            log(I18n.t('health.instanceLockMissing'));
        }
    }
    // ─────────────────────────────────────────────────────────────
    //  14. ЭКСПОРТ РУЧНОГО СПИСКА (интерактивный HTML HH Apply Assistant)
    // ─────────────────────────────────────────────────────────────

    function exportManualListHtml({ openInBrowser = false } = {}) {
        const list = State.getManualList();
        if (!list || !list.length) { alert(I18n.t('alert.manualEmpty')); return; }

        const lang = I18n.getLanguage();
        const localeTag = I18n.getLocaleTag(lang);

        // dedupe by url (avoid duplicate identical links)
        const seen = new Set();
        const uniq = [];
        let duplicates = 0;
        for (const it of list) {
            const key = String(it.url || it.vid || '').trim();
            if (!key) continue;
            if (seen.has(key)) { duplicates++; continue; }
            seen.add(key);
            uniq.push({ ...it, title: prettifyTitle(it.title) });
        }

        const rowsJson = JSON.stringify(uniq).replace(/</g, '\\u003c');
        const expStringsJson = JSON.stringify(TRANSLATIONS[lang].export).replace(/</g, '\\u003c');
        const exportDateStr = I18n.formatDateTime(Date.now(), {}, lang);

        const content = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${I18n.t('export.docTitle')}</title><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>
                :root{
                    color-scheme:light;
                    --ap-brand:#d6001c; --ap-brand-soft:#ffebee;
                    --hh-blue:#6863b3; --hh-blue-hover:#5d58a6; --hh-blue-soft:#f0eff9;
                    --hh-green:#059669;
                    --ink:#1e293b; --ink-2:#475569; --ink-3:#626f80;
                    --line:#e2e8f0; --line-2:#f1f5f9;
                    --bg:#ffffff; --bg-2:#f8fafc; --bg-3:#f1f5f9;
                    --radius:12px; --radius-xs:6px;
                    --font:'HH Sans','Inter',-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
                }
                *{box-sizing:border-box;}
                body{font-family:var(--font);margin:0;padding:24px 20px 48px;color:var(--ink);background:var(--bg-2);line-height:1.45;}
                .wrap{max-width:1160px;margin:0 auto;}
                .topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px;flex-wrap:wrap;}
                .brand{display:flex;align-items:center;min-width:0;}
                .brand-heading{margin:0;font-size:20px;font-weight:700;color:var(--ink);letter-spacing:-.02em;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
                .brand-wordmark{font-weight:850;color:var(--ap-brand);letter-spacing:-.03em;text-transform:lowercase;font-size:21px;}
                .brand-sep{color:var(--ink-3);font-weight:400;}
                .brand-sub{font-weight:600;color:var(--ink-2);font-size:16px;}
                .meta{color:var(--ink-3);font-size:12px;margin-top:2px;}
                .panel{background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);box-shadow:0 2px 12px rgba(15,23,42,.04);overflow:hidden;}
                .stats{display:flex;align-items:stretch;flex-wrap:wrap;gap:0;flex:none;}
                .stat{display:flex;flex-direction:column;justify-content:center;gap:1px;padding:4px 18px;border-left:1px solid var(--line);}
                .stat:first-child{border-left:none;padding-left:0;}
                .stat-val{font-size:19px;font-weight:800;color:var(--ink);font-variant-numeric:tabular-nums;line-height:1.1;}
                .stat-lbl{font-size:10px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.04em;font-weight:600;white-space:nowrap;}
                .stat.new .stat-val{color:var(--hh-blue);}
                .stat.opened .stat-val{color:var(--hh-green);}
                .stat.shown .stat-val{color:var(--ink-2);}
                .toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line-2);background:var(--bg-2);}
                .search-field{position:relative;flex:1 1 280px;min-width:240px;display:flex;align-items:center;}
                .search-field .search-ic{position:absolute;left:11px;width:15px;height:15px;color:var(--ink-3);pointer-events:none;}
                input[type=text]{width:100%;height:36px;padding:0 12px 0 34px;border:1px solid var(--line);border-radius:var(--radius-xs);font-size:13px;font-family:inherit;color:var(--ink);background:#fff;transition:border-color .15s,box-shadow .15s;}
                input[type=text]:focus{outline:none;border-color:var(--hh-blue);box-shadow:0 0 0 3px var(--hh-blue-soft);}
                input[type=text]:hover:not(:focus){border-color:#cbd5e1;}
                .dropdown{position:relative;user-select:none;}
                .dropdown-trigger{display:flex;align-items:center;gap:8px;height:36px;padding:0 30px 0 12px;border:1px solid var(--line);border-radius:var(--radius-xs);font-size:12px;font-weight:600;font-family:inherit;color:var(--ink);background:#fff;cursor:pointer;white-space:nowrap;transition:all .15s;background-repeat:no-repeat;background-position:right 10px center;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23475569' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");}
                .dropdown-trigger:hover{border-color:#cbd5e1;}
                .dropdown.is-open .dropdown-trigger{border-color:var(--hh-blue);box-shadow:0 0 0 3px var(--hh-blue-soft);}
                .dropdown.is-open .dropdown-trigger{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236863b3' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M18 15l-6-6-6 6'/%3E%3C/svg%3E");}
                .dropdown-menu{display:none;position:absolute;top:calc(100% + 4px);left:0;min-width:100%;background:#fff;border:1px solid var(--line);border-radius:var(--radius-xs);box-shadow:0 8px 24px rgba(15,23,42,.12);z-index:10;padding:4px 0;overflow:hidden;}
                .dropdown.is-open .dropdown-menu{display:block;animation:dd-in .12s ease;}
                @keyframes dd-in{from{opacity:0;transform:translateY(-4px);}to{opacity:1;transform:none;}}
                .dropdown-item{display:flex;align-items:center;padding:8px 12px;font-size:12.5px;font-weight:500;color:var(--ink);cursor:pointer;transition:background .1s,color .1s;white-space:nowrap;}
                .dropdown-item:hover{background:var(--hh-blue-soft);color:var(--hh-blue);}
                .dropdown-item.is-active{font-weight:700;color:var(--hh-blue);background:var(--hh-blue-soft);}
                .toolbar-spacer{flex:1 1 0;min-width:0;}
                .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:38px;cursor:pointer;border-radius:var(--radius-xs);border:1px solid var(--line);background:#fff;color:var(--ink-2);padding:0 14px;font-size:12.5px;font-weight:600;font-family:inherit;white-space:nowrap;transition:all .15s ease;}
                .btn:hover{background:var(--bg-2);color:var(--ink);border-color:#cbd5e1;}
                .btn:active{transform:translateY(1px);}
                .btn svg{width:15px;height:15px;}
                .btn.primary{background:var(--hh-blue);color:#fff;border-color:var(--hh-blue);box-shadow:0 2px 4px rgba(82,76,154,.17);}
                .btn.primary:hover{background:var(--hh-blue-hover);border-color:var(--hh-blue-hover);box-shadow:0 4px 8px rgba(82,76,154,.23);}
                .btn.secondary{background:#fff;color:var(--ink-2);border-color:var(--line);}
                .btn.secondary:hover{background:var(--bg-3);color:var(--ink);border-color:#cbd5e1;}
                .table-wrap{overflow-x:auto;}
                table{border-collapse:separate;border-spacing:0;width:100%;font-size:13px;min-width:680px;table-layout:fixed;}
                th,td{padding:11px 14px;text-align:left;border-bottom:1px solid var(--line-2);vertical-align:middle;line-height:1.4;}
                th{background:var(--bg-3);color:var(--ink-3);position:sticky;top:0;z-index:2;font-weight:700;font-size:11px;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap;}
                tbody tr{transition:background .12s;}
                tbody tr:hover{background:var(--hh-blue-soft);}
                td a{color:var(--hh-blue);text-decoration:none;font-weight:600;word-break:break-word;}
                td a:hover{text-decoration:underline;}
                .col-check{width:44px;text-align:center;}
                .col-date{width:160px;white-space:nowrap;color:var(--ink-2);font-size:12.5px;}
                .col-title{width:auto;word-break:break-word;}
                .col-link{width:64px;white-space:nowrap;text-align:center;}
                .col-age{width:78px;white-space:nowrap;}
                .icon-link{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;color:var(--hh-blue);border-radius:var(--radius-xs);transition:background .15s,color .15s;}
                .icon-link:hover{background:var(--hh-blue-soft);text-decoration:none;}
                .icon-link svg{width:16px;height:16px;pointer-events:none;}
                .muted{color:var(--ink-3);font-weight:400;}
                .age{display:inline-block;padding:2px 8px;font-weight:600;font-size:11px;border-radius:999px;}
                .age.fresh{background:#ecfdf5;color:#059669;}
                .age.recent{background:var(--hh-blue-soft);color:var(--hh-blue);}
                .age.stale{background:#fffbeb;color:#d97706;}
                .age.old{background:var(--ap-brand-soft);color:#c01126;}
                .tag{display:inline-block;background:var(--bg-2);color:var(--ink-3);padding:2px 8px;font-size:11px;border-radius:999px;}
                .processed td{opacity:0.5;text-decoration:line-through;}
                input[type=checkbox]{-webkit-appearance:none;appearance:none;width:17px;height:17px;flex:none;margin:0;border:1.5px solid #cbd5e1;border-radius:4px;background:#fff;cursor:pointer;position:relative;vertical-align:middle;transition:background .15s,border-color .15s;}
                input[type=checkbox]:hover{border-color:var(--hh-blue);}
                input[type=checkbox]:checked{background:var(--hh-blue);border-color:var(--hh-blue);}
                input[type=checkbox]:checked::after{content:'';position:absolute;left:4px;top:1px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg);}
                input[type=checkbox]:focus-visible{outline:none;box-shadow:0 0 0 3px var(--hh-blue-soft);}
                .empty-state{padding:44px 20px;text-align:center;color:var(--ink-3);font-size:13.5px;}
                .empty-state svg{width:32px;height:32px;color:var(--ink-3);margin-bottom:10px;opacity:.7;}
                @media (max-width:640px){
                    body{padding:16px 12px 36px;}
                    .search-field{flex-basis:100%;}
                    .toolbar-spacer{display:none;}
                    .btn{flex:1;}
                }
            </style>
            </head><body>
            <div class="wrap">
                <header class="topbar">
                    <div class="brand">
                        <div class="brand-txt">
                            <h1 class="brand-heading"><span class="brand-wordmark">${I18n.t('export.brandWordmark')}</span><span class="brand-sep">·</span><span class="brand-sub">${I18n.t('export.brandSub')}</span></h1>
                            <div class="meta">${I18n.t('export.metaText', { date: exportDateStr, duplicates })}</div>
                        </div>
                    </div>
                    <div class="stats" id="summary"></div>
                </header>
                <section class="panel">
                    <div class="toolbar">
                        <div class="search-field">
                            <svg class="search-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
                            <input id="filter" type="text" placeholder="${I18n.t('export.searchPlaceholder')}">
                        </div>
                        <div class="dropdown" id="sort-dropdown">
                            <div class="dropdown-trigger" id="sort-dropdown-trigger" role="combobox" tabindex="0" aria-readonly="true" aria-haspopup="listbox" aria-expanded="false" aria-controls="sort-dropdown-listbox" aria-activedescendant="sort-option-ts-desc">${I18n.t('export.sortPrefix')}${I18n.t('export.sortOptions.ts_desc')}</div>
                            <div class="dropdown-menu" id="sort-dropdown-listbox" role="listbox" aria-labelledby="sort-dropdown-trigger">
                                <div class="dropdown-item is-active" id="sort-option-ts-desc" role="option" aria-selected="true" data-value="ts_desc">${I18n.t('export.sortOptions.ts_desc')}</div>
                                <div class="dropdown-item" id="sort-option-ts-asc" role="option" aria-selected="false" data-value="ts_asc">${I18n.t('export.sortOptions.ts_asc')}</div>
                                <div class="dropdown-item" id="sort-option-title-asc" role="option" aria-selected="false" data-value="title_asc">${I18n.t('export.sortOptions.title_asc')}</div>
                                <div class="dropdown-item" id="sort-option-title-desc" role="option" aria-selected="false" data-value="title_desc">${I18n.t('export.sortOptions.title_desc')}</div>
                            </div>
                        </div>
                        <div class="dropdown" id="view-mode-dropdown">
                            <div class="dropdown-trigger" id="view-mode-dropdown-trigger" role="combobox" tabindex="0" aria-readonly="true" aria-haspopup="listbox" aria-expanded="false" aria-controls="view-mode-dropdown-listbox" aria-activedescendant="view-mode-option-new">${I18n.t('export.statusPrefix')}${I18n.t('export.statusOptions.new')}</div>
                            <div class="dropdown-menu" id="view-mode-dropdown-listbox" role="listbox" aria-labelledby="view-mode-dropdown-trigger">
                                <div class="dropdown-item is-active" id="view-mode-option-new" role="option" aria-selected="true" data-value="new">${I18n.t('export.statusOptions.new')}</div>
                                <div class="dropdown-item" id="view-mode-option-opened" role="option" aria-selected="false" data-value="opened">${I18n.t('export.statusOptions.opened')}</div>
                            </div>
                        </div>
                        <div class="toolbar-spacer"></div>
                        <button id="open-selected" class="btn primary" title="${I18n.t('export.openSelectedTitle')}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg>
                            ${I18n.t('export.openSelected')}
                        </button>
                        <button id="clear-processed" class="btn secondary" title="${I18n.t('export.resetMarkersTitle')}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>
                            ${I18n.t('export.resetMarkers')}
                        </button>
                    </div>
                    <div class="table-wrap">
                        <table>
                            <thead>
                                <tr>
                                    <th class="col-check"><input type="checkbox" id="check-all" aria-label="${I18n.t('export.selectAll')}"></th>
                                    <th class="col-date">${I18n.t('export.tableHeaders.saved')}</th>
                                    <th class="col-title">${I18n.t('export.tableHeaders.vacancy')}</th>
                                    <th class="col-link">${I18n.t('export.tableHeaders.link')}</th>
                                    <th class="col-age">${I18n.t('export.tableHeaders.age')}</th>
                                </tr>
                            </thead>
                            <tbody id="rows"></tbody>
                        </table>
                    </div>
                </section>
            </div>

            <script>
                const data = ${rowsJson};
                const exp = ${expStringsJson};
                const activeLocale = '${localeTag}';
                let sortKey = 'ts_desc';
                let filterText = '';
                let viewMode = 'new';
                const PROCESSED_KEY = ${JSON.stringify(KEYS.manualProcessed)};
                let processed = {};
                try {
                    const raw = localStorage.getItem(PROCESSED_KEY);
                    if (raw) processed = JSON.parse(raw) || {};
                    if (!processed || typeof processed !== 'object' || Array.isArray(processed)) processed = {};
                } catch (e) {
                    processed = {};
                }
                const selected = new Set();

                const qs = (id) => document.getElementById(id);
                const escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
                const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => escMap[ch] || ch);
                const keyOf = (item, idx) => {
                    const composite = [item?.url, item?.returnUrl, item?.title, item?.ts].filter(Boolean).join('|');
                    return String(item?.vid || composite || idx);
                };
                const encodeKey = (key) => encodeURIComponent(String(key || ''));
                const decodeKey = (key) => {
                    try { return decodeURIComponent(String(key || '')); }
                    catch (e) { return ''; }
                };
                const safeHttpUrl = (raw) => {
                    if (!raw) return '';
                    try {
                        const u = new URL(String(raw));
                        if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
                        return u.href;
                    } catch (e) {
                        return '';
                    }
                };

                function humanAgo(ts) {
                    const d = Date.now() - ts;
                    const sec = Math.floor(d/1000);
                    if (sec < 60) return sec + 's';
                    const min = Math.floor(sec/60);
                    if (min < 60) return min + 'm';
                    const hr = Math.floor(min/60);
                    if (hr < 24) return hr + 'h';
                    const day = Math.floor(hr/24);
                    return day + 'd';
                }

                function ageClass(ts) {
                    const days = (Date.now() - ts)/(1000*60*60*24);
                    if (days < 1) return 'fresh';
                    if (days < 3) return 'recent';
                    if (days < 7) return 'stale';
                    return 'old';
                }

                function applySort(arr) {
                    const sorted = [...arr];
                    sorted.sort((a,b)=>{
                        if (sortKey === 'ts_desc') return (b.ts||0)-(a.ts||0);
                        if (sortKey === 'ts_asc') return (a.ts||0)-(b.ts||0);
                        const ta = (a.title||'').toLowerCase();
                        const tb = (b.title||'').toLowerCase();
                        if (sortKey === 'title_asc') return ta.localeCompare(tb, activeLocale);
                        if (sortKey === 'title_desc') return tb.localeCompare(ta, activeLocale);
                        return 0;
                    });
                    return sorted;
                }

                function render() {
                    const tbody = qs('rows');
                    if (!tbody) return;
                    const ft = filterText.trim().toLowerCase();
                    const filtered = data.filter((i, idx)=>{
                        const pKey = keyOf(i, idx);
                        if (viewMode === 'opened') {
                            if (!processed[pKey]) return false;
                        } else {
                            if (processed[pKey]) return false;
                        }
                        if (!ft) return true;
                        return [i.vid, i.title, i.url].some(v => (v||'').toLowerCase().includes(ft));
                    });
                    const sorted = applySort(filtered);
                    const openIcon = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg>';
                    let html = '';
                    sorted.forEach((i, idx)=>{
                        const ts = i.ts || Date.now();
                        const ago = humanAgo(ts);
                        const aClass = ageClass(ts);
                        const key = keyOf(i, idx);
                        const keyEnc = encodeKey(key);
                        const checked = selected.has(key) ? 'checked' : '';
                        const rowClass = processed[key] ? ' class="processed"' : '';
                        const url = safeHttpUrl(i.url);
                        const link = url ? '<a class="icon-link" title="' + escHtml(exp.openLinkTitle) + '" aria-label="' + escHtml(exp.openLinkTitle) + '" data-open="1" href="' + escHtml(url) + '" target="_blank" rel="noopener noreferrer">' + openIcon + '</a>' : '<span class="tag">' + escHtml(exp.noLinkTag) + '</span>';
                        const title = (i.title && i.title.trim()) ? i.title.trim() : '';
                        const titleCell = (title && title !== 'Название недоступно' && title !== 'Title unavailable')
                            ? escHtml(title)
                            : '<span class="muted" title="' + escHtml(exp.noTitleTooltip) + '">' + escHtml(exp.noTitleText) + '</span>';
                        const selectionName = String(exp.selectVacancy || '').replace('{title}', title || String(i.vid || exp.noTitleText));
                        html += '<tr' + rowClass + ' data-key="' + keyEnc + '">'
                             + '<td class="col-check"><input type="checkbox" class="row-check" data-key="' + keyEnc + '" aria-label="' + escHtml(selectionName) + '" ' + checked + '></td>'
                             + '<td class="col-date">' + escHtml(new Date(ts).toLocaleString(activeLocale)) + '</td>'
                             + '<td class="col-title">' + titleCell + '</td>'
                             + '<td class="col-link">' + link + '</td>'
                             + '<td class="col-age"><span class="age ' + aClass + '">' + ago + '</span></td>'
                             + '</tr>';
                    });
                    if (!sorted.length) {
                        const emptyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M9 15h6"></path></svg>';
                        const msg = ft ? exp.emptyStates.filter : (viewMode === 'opened' ? exp.emptyStates.opened : exp.emptyStates.new);
                        html = '<tr><td colspan="5"><div class="empty-state">' + emptyIcon + '<div>' + escHtml(msg) + '</div></div></td></tr>';
                    }
                    tbody.innerHTML = html;
                    const checkAll = qs('check-all');
                    if (checkAll) {
                        checkAll.checked = sorted.length > 0 && sorted.every((i, idx) => selected.has(keyOf(i, idx)));
                    }
                    renderSummary(filtered.length);
                }

                function renderSummary(shown) {
                    const box = qs('summary');
                    if (!box) return;
                    const total = data.length;
                    let opened = 0;
                    data.forEach((i, idx) => { if (processed[keyOf(i, idx)]) opened++; });
                    const fresh = total - opened;
                    const stat = (cls, val, lbl) => '<div class="stat' + (cls ? ' ' + cls : '') + '"><span class="stat-val">' + val + '</span><span class="stat-lbl">' + lbl + '</span></div>';
                    let html = stat('', total, exp.summaryStats.total) + stat('new', fresh, exp.summaryStats.new) + stat('opened', opened, exp.summaryStats.opened);
                    if (filterText.trim() !== '') html += stat('shown', typeof shown === 'number' ? shown : 0, exp.summaryStats.shown);
                    box.innerHTML = html;
                }

                function saveProcessed() {
                    try {
                        localStorage.setItem(PROCESSED_KEY, JSON.stringify(processed));
                    } catch (_) {}
                }

                qs('filter').addEventListener('input', (e)=>{ filterText = e.target.value; render(); });
                const closeDropdowns = (except = null) => {
                    document.querySelectorAll('.dropdown.is-open').forEach(dropdown => {
                        if (dropdown === except) return;
                        dropdown.classList.remove('is-open');
                        dropdown.querySelector('.dropdown-trigger')?.setAttribute('aria-expanded', 'false');
                    });
                };
                function initDropdown(id, prefix, onSelect) {
                    const wrap = qs(id);
                    if (!wrap) return;
                    const trigger = wrap.querySelector('.dropdown-trigger');
                    const menu = wrap.querySelector('.dropdown-menu');
                    const setOpen = (open) => {
                        wrap.classList.toggle('is-open', open);
                        trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
                    };
                    const choose = (item) => {
                        trigger.textContent = prefix + item.textContent;
                        menu.querySelectorAll('.dropdown-item').forEach(i => {
                            const selected = i === item;
                            i.classList.toggle('is-active', selected);
                            i.setAttribute('aria-selected', selected ? 'true' : 'false');
                        });
                        trigger.setAttribute('aria-activedescendant', item.id);
                        setOpen(false);
                        onSelect(item.dataset.value);
                    };
                    trigger.addEventListener('click', (e) => {
                        e.stopPropagation();
                        closeDropdowns(wrap);
                        setOpen(!wrap.classList.contains('is-open'));
                    });
                    trigger.addEventListener('keydown', (e) => {
                        const items = [...menu.querySelectorAll('.dropdown-item')];
                        const activeIdx = items.findIndex(i => i.classList.contains('is-active'));
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            trigger.click();
                        } else if (e.key === 'Escape') {
                            setOpen(false);
                        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                            e.preventDefault();
                            const dir = e.key === 'ArrowDown' ? 1 : -1;
                            choose(items[(activeIdx + dir + items.length) % items.length]);
                        }
                    });
                    menu.addEventListener('click', (e) => {
                        const item = e.target.closest('.dropdown-item');
                        if (item) choose(item);
                    });
                    wrap.addEventListener('focusout', () => {
                        setTimeout(() => {
                            if (!wrap.contains(document.activeElement)) setOpen(false);
                        }, 0);
                    });
                }
                document.addEventListener('click', () => closeDropdowns());
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') closeDropdowns();
                });

                initDropdown('sort-dropdown', exp.sortPrefix, (val) => { sortKey = val; render(); });
                initDropdown('view-mode-dropdown', exp.statusPrefix, (val) => {
                    viewMode = val;
                    selected.clear();
                    render();
                });

                qs('check-all').addEventListener('change', (e)=>{
                    const state = e.target.checked;
                    document.querySelectorAll('.row-check').forEach(ch => {
                        ch.checked = state;
                        const key = decodeKey(ch.dataset.key);
                        if (!key) return;
                        if (state) selected.add(key);
                        else selected.delete(key);
                    });
                });

                qs('rows').addEventListener('change', (e)=>{
                    if (!e.target.classList.contains('row-check')) return;
                    const key = decodeKey(e.target.dataset.key);
                    if (!key) return;
                    if (e.target.checked) selected.add(key);
                    else selected.delete(key);
                });

                qs('open-selected').addEventListener('click', ()=>{
                    document.querySelectorAll('.row-check:checked').forEach(ch=>{
                        const key = decodeKey(ch.dataset.key);
                        const row = data.find((i, idx) => keyOf(i, idx) === key);
                        const url = safeHttpUrl(row?.url);
                        if (url) window.open(url, '_blank', 'noopener,noreferrer');
                        if (key) processed[key] = true;
                    });
                    saveProcessed();
                    selected.clear();
                    render();
                });

                qs('rows').addEventListener('click', (e)=>{
                    const a = e.target.closest('a');
                    if (!a || a.dataset.open !== '1') return;
                    const row = a.closest('tr');
                    const key = decodeKey(row?.getAttribute('data-key'));
                    if (!key) return;
                    processed[key] = true;
                    saveProcessed();
                    render();
                });

                qs('clear-processed').addEventListener('click', ()=>{
                    if (!confirm(exp.confirmReset)) return;
                    const keys = Object.keys(processed);
                    keys.forEach(k => delete processed[k]);
                    saveProcessed();
                    selected.clear();
                    render();
                });

                // init
                render();
            </script>
            </body></html>`;

        if (openInBrowser) {
            const blob = new Blob([content], { type: 'text/html;charset=utf-8' });
            const objectUrl = URL.createObjectURL(blob);
            let queueWindow = null;
            try {
                queueWindow = window.open(objectUrl, '_blank');
                if (queueWindow) queueWindow.opener = null;
            } catch (e) { /* popup feedback below */ }
            if (!queueWindow) {
                URL.revokeObjectURL(objectUrl);
                alert(I18n.t('alert.manualOpenBlocked'));
                return;
            }
            setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
            log(I18n.t('logs.htmlOpened'));
            return;
        }

        downloadFile('hh_apply_assistant_manual_queue.html', content, 'text/html;charset=utf-8');
        log(I18n.t('logs.htmlExported'));
    }
    // ─────────────────────────────────────────────────────────────
    //  15. ЗАПУСК И ГЛОБАЛЬНЫЕ ОБРАБОТЧИКИ
    // ─────────────────────────────────────────────────────────────

    // Перехват необработанных ошибок: отделяем собственные ошибки HH Apply Assistant от шума HeadHunter и сторонних скриптов.
    let assistantErrCount = 0;
    let externalErrCount = 0;
    const ASSISTANT_ERR_LIMIT = 50;
    const EXTERNAL_ERR_LIMIT = 5;

    function isHHApplyAssistantError(e, isPromise = false) {
        const errObj = isPromise ? e.reason : (e.error || e);
        const stack = (errObj && typeof errObj.stack === 'string') ? errObj.stack : '';
        const filename = (!isPromise && typeof e.filename === 'string') ? e.filename : '';
        const message = isPromise
            ? (errObj && (errObj.message || String(errObj)) || '')
            : (e.message || String(errObj || ''));
        const combined = `${filename} ${stack} ${message}`;

        // Характерные маркеры кода HH Apply Assistant
        const assistantMarkers = [
            'HH Apply Assistant', 'hh_apply_assistant_', 'startLoop', 'processVacancy', 'applyToVacancy',
            'realisticClick', 'fillCoverLetter', 'checkResponseTrap', 'watchdogTick',
            'setupUI', 'PanelController', 'WorkModeSlider', 'DiagnosticsView', 'DiagLog', 'interruptibleWait', 'fnv1a32', 'buildPanelHtml',
            'exportManualListHtml', 'runHealthCheck'
        ];
        return assistantMarkers.some(m => combined.includes(m));
    }

    addRuntimeListener(window, 'error', (e) => {
        try {
            const isInternal = isHHApplyAssistantError(e, false);
            const where = e.filename ? ` @ ${e.filename}:${e.lineno || 0}:${e.colno || 0}` : '';
            if (isInternal) {
                if (assistantErrCount >= ASSISTANT_ERR_LIMIT) return;
                assistantErrCount++;
                log(I18n.t('logs.jsError', { msg: e.message || 'Error', where }), true);
            } else {
                if (externalErrCount >= EXTERNAL_ERR_LIMIT) return;
                externalErrCount++;
                DiagLog.push(`[External hh.ru error]: ${(e.message || 'Error').slice(0, 300)}${where}`, false);
                console.warn('[HH Apply Assistant] External hh.ru error:', e.message, where);
            }
        } catch (_) { /* ignore */ }
    });

    addRuntimeListener(window, 'unhandledrejection', (e) => {
        try {
            const isInternal = isHHApplyAssistantError(e, true);
            const r = e.reason;
            const text = r && (r.stack || r.message) ? (r.stack || r.message) : String(r);
            if (isInternal) {
                if (assistantErrCount >= ASSISTANT_ERR_LIMIT) return;
                assistantErrCount++;
                log(I18n.t('logs.unhandledRejection', { msg: String(text).slice(0, 500) }), true);
            } else {
                if (externalErrCount >= EXTERNAL_ERR_LIMIT) return;
                externalErrCount++;
                DiagLog.push(`[External unhandled rejection]: ${String(text).slice(0, 300)}`, false);
                console.warn('[HH Apply Assistant] External unhandled rejection hh.ru:', text);
            }
        } catch (_) { /* ignore */ }
    });

    ensureCurrentRunLimit();

    // Отметка загрузки каждой страницы - по ней в логе видна вся последовательность навигаций.
    log(I18n.t('logs.pageLoad', { path: location.pathname + location.search, running: State.amIRunning(), sent: State.getSentCount(), limit: config.limit }));

    startWatchdog();

    function bootstrap() {
        I18n.init();
        PanelController.mount();
        if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
        // Авто-возобновление, если скрипт был в работе перед перезагрузкой.
        // Условие перепроверяется В МОМЕНТ срабатывания таймера: если пользователь успел
        // нажать Стоп в эти 1.5 секунды, отложенный startLoop не должен воскресить
        // прогон (State.setRunning(false) уже снят, и стартовать нечего).
        if (State.amIRunning()) {
            log(I18n.t('logs.autoResumeFound'));
            setStatus('running', 'status.autoStarting');
            resumeTimer = setTimeout(() => {
                resumeTimer = null;
                if (State.amIRunning()) {
                    if (Page.isResponseForm()) {
                        log(I18n.t('logs.onResponsePage'));
                        return;
                    }
                    startLoop();
                }
                else log(I18n.t('logs.autoResumeCanceled'));
            }, 1500);
        }
        // Сбрасываем ловушку только если мы не на странице отклика/вопросов
        if (!Page.isResponseForm()) {
            State.clearTrapLock();
        }
    }

    // document-idle обычно означает готовый body, но перестрахуемся:
    // если body ещё нет - дожидаемся его через MutationObserver.
    if (document.body) {
        bootstrap();
    } else {
        const domReadyObserver = new MutationObserver((mutations, obs) => {
            if (document.body) {
                obs.disconnect();
                runtimeRecord.domReadyObserver = null;
                bootstrap();
            }
        });
        runtimeRecord.domReadyObserver = domReadyObserver;
        domReadyObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    // При восстановлении страницы из bfcache возвращается старый JS runtime со старым
    // leaseId. Новый startLoop синхронно меняет runId до первого await и получает новое
    // поколение lease, поэтому continuations замороженной страницы не могут продолжиться.
    addRuntimeListener(window, 'pageshow', (event) => {
        if (!event.persisted || !State.amIRunning()) return;
        if (activeAbortController) {
            try { activeAbortController.abort(); } catch (e) {}
        }
        isLoopActive = false;
        handlingResponsePage = false;
        startLoop();
    });

    // Очищаем instance lock при закрытии вкладки - но только когда прогон не активен:
    // прогон живёт через полные навигации (список → вакансия → список), и лок должен
    // переживать их до авто-возобновления (1.5 с в bootstrap), иначе другая вкладка
    // успеет захватить его в этом окне. Мёртвые вкладки, закрытые посреди прогона,
    // освобождаются по TTL (TUNING.instanceLockTtl).
    addRuntimeListener(window, 'beforeunload', () => {
        DiagLog.flush();
        Metrics.flush();
        if (!State.amIRunning()) State.releaseInstanceLock(TAB_ID);
    });
    addRuntimeListener(window, 'pagehide', () => {
        DiagLog.flush();
        Metrics.flush();
    });
    addRuntimeListener(window, 'unload', () => {
        DiagLog.flush();
        Metrics.flush();
        if (!State.amIRunning()) State.releaseInstanceLock(TAB_ID);
    });
})();
