// ==UserScript==
// @name         applomat v4.0.0
// @namespace    http://tampermonkey.net/
// @version      v4.0.0
// @description  applomat — инструмент автоматизации откликов на вакансии hh.ru (HeadHunter)
// @author       Timur Geruzov
// @license      GPL-3.0-only
// @match        *://*.hh.ru/search/vacancy*
// @match        *://*.hh.ru/vacancy/*
// @match        *://*.hh.ru/applicant/vacancy_response*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ─────────────────────────────────────────────────────────────
    //  1. КОНСТАНТЫ И КОНФИГУРАЦИЯ
    // ─────────────────────────────────────────────────────────────

    const VERSION = '4.0.0';

    // Префикс сохраняем от v2, чтобы при обновлении не потерять
    // накопленные данные (ручной список, диагностический лог, метрики).
    const STORAGE_PREFIX = 'hh_ar_v2_';
    const KEYS = {
        settings: STORAGE_PREFIX + 'cfg_data',
        isRunning: STORAGE_PREFIX + 'is_active',
        returnUrl: STORAGE_PREFIX + 'list_url',
        history: STORAGE_PREFIX + 'processed_ids',
        needF5: STORAGE_PREFIX + 'reload_flag',
        trapLock: STORAGE_PREFIX + 'ar_trap_lock',
        instanceLock: STORAGE_PREFIX + 'instance_lock',
        lastAttempt: STORAGE_PREFIX + 'last_attempt_id',
        manualList: STORAGE_PREFIX + 'manual_list',
        lastVacancyMeta: STORAGE_PREFIX + 'last_vacancy_meta',
        tabId: STORAGE_PREFIX + 'tab_id',
        sentCount: STORAGE_PREFIX + 'sent_count',
        diagLog: STORAGE_PREFIX + 'diag_log',
        metrics: STORAGE_PREFIX + 'metrics',
        uiOpen: STORAGE_PREFIX + 'ui_open',
        stats: STORAGE_PREFIX + 'run_stats'
    };

    // Технические тайминги - не настраиваются пользователем.
    const TUNING = {
        scrollStepMs: 200,        // шаг человеческого скролла
        waitForModalMs: 8000,     // ожидание реакции после клика Откликнуться
        confirmWaitMs: 6000,      // ожидание подтверждения после отправки формы
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
        topApply: '[data-qa="vacancy-response-link-top"], a[data-qa="vacancy-response-link-top"]',
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

    // Пресеты темпа работы. Все интервалы в миллисекундах [min, max]:
    //  delay  - пауза перед переходом к следующей вакансии;
    //  view   - чтение страницы вакансии (имитация просмотра);
    //  action - микро-паузы между отдельными действиями (клики, ввод).
    const PRESETS = {
        safe: {
            label: 'Безопасный',
            hint: '≈ 1 отклик в минуту. Паузы 4-8 с, чтение вакансии 15-35 с. Медленно и максимально похоже на человека.',
            delay: [4000, 8000],
            view: [15000, 35000],
            action: [300, 1000]
        },
        balanced: {
            label: 'Оптимальный',
            hint: '≈ 2 отклика в минуту. Паузы 2-5 с, чтение вакансии 8-20 с. Рекомендуемый баланс скорости и естественности.',
            delay: [2000, 5000],
            view: [8000, 20000],
            action: [150, 600]
        },
        fast: {
            label: 'Быстрый',
            hint: '≈ 3-4 отклика в минуту. Паузы 1,5-3 с, чтение вакансии 4-9 с. Повышенный темп — заметнее для hh.ru.',
            delay: [1500, 3000],
            view: [4000, 9000],
            action: [120, 350]
        },
        turbo: {
            label: 'Турбо',
            hint: '↯ Максимальная скорость. Только необходимые технические паузы. При блокировке applomat автоматически остановится.',
            delay: [80, 200],
            view: [0, 0],
            action: [25, 80]
        }
    };
    const DEFAULT_PRESET = 'balanced';

    // Пользовательские настройки по умолчанию
    const DEFAULTS = {
        coverText: 'Добрый день! Заинтересовала ваша вакансия. Опыт релевантен, подробности в резюме. Буду рад обратной связи!',
        useCover: true,
        applyOnRejectWarning: true,
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
        const cleanup = () => {
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
            if (sig.aborted) return resolve();
            try { sig.addEventListener('abort', onAbort, { once: true }); } catch (e) {}
        }
        const start = Date.now();
        const check = () => {
            if (stopSignal || (sig && sig.aborted) || (Date.now() - start >= ms)) {
                cleanup();
                resolve();
            } else {
                timer = setTimeout(check, Math.min(40, ms - (Date.now() - start)));
            }
        };
        timer = setTimeout(check, Math.min(40, ms));
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
        localSet: (key, value) => { try { localStorage.setItem(key, value); return true; } catch (e) { return false; } },
        localRemove: (key) => { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } },
        sessionGet: (key) => { try { return sessionStorage.getItem(key); } catch (e) { return null; } },
        sessionSet: (key, value) => { try { sessionStorage.setItem(key, value); return true; } catch (e) { return false; } },
        sessionRemove: (key) => { try { sessionStorage.removeItem(key); } catch (e) { /* ignore */ } }
    };

    // ─────────────────────────────────────────────────────────────
    //  4. НАСТРОЙКИ
    // ─────────────────────────────────────────────────────────────

    const Settings = {
        // Приводим сырые данные (в т.ч. конфиг от старых версий с ручными
        // таймингами) к актуальной схеме: пресет + несколько флагов.
        normalize(raw = {}) {
            const merged = { ...DEFAULTS, ...(raw || {}) };
            return {
                coverText: String(merged.coverText ?? DEFAULTS.coverText).slice(0, 5000),
                useCover: merged.useCover !== false,
                applyOnRejectWarning: merged.applyOnRejectWarning !== false,
                skipHidden: merged.skipHidden !== false,
                preset: PRESETS[merged.preset] ? merged.preset : DEFAULT_PRESET,
                limit: clamp(Math.round(toNum(merged.limit, DEFAULTS.limit)), 1, 500)
            };
        },
        load() {
            return Settings.normalize(parseJson(storage.localGet(KEYS.settings), {}));
        },
        save(cfg) {
            storage.localSet(KEYS.settings, JSON.stringify(cfg));
        }
    };

    let config = Settings.load();
    let isLoopActive = false;
    let stopSignal = false;
    let currentRunId = 0;
    let resumeTimer = null;
    let activeAbortController = null;
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
    const DiagLog = (() => {
        let _cache = null;
        let _saveTimer = null;
        let _isDirty = false;

        function _ensureLoaded() {
            if (_cache === null) {
                const raw = storage.localGet(KEYS.diagLog);
                const parsed = parseJson(raw, []);
                _cache = Array.isArray(parsed) ? parsed : [];
            }
            return _cache;
        }

        function _flushSync() {
            if (!_isDirty || !_cache) return;
            if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
            try {
                if (_cache.length > DIAG_LOG_MAX) {
                    _cache = _cache.slice(_cache.length - DIAG_LOG_MAX);
                }
                const json = JSON.stringify(_cache);
                if (!storage.localSet(KEYS.diagLog, json)) {
                    // Переполнение квоты — агрессивно обрезаем и пробуем снова
                    _cache = _cache.slice(-300);
                    storage.localSet(KEYS.diagLog, JSON.stringify(_cache));
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
                arr.push({
                    t: Date.now(),
                    lvl: isError ? 'ERR' : 'INFO',
                    path: (location.pathname + location.search).slice(0, 300),
                    tab: TAB_ID,
                    msg: String(msg).slice(0, 1000)
                });
                if (arr.length > DIAG_LOG_MAX + 50) {
                    _cache = arr.slice(arr.length - DIAG_LOG_MAX);
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
            clear() {
                _cache = [];
                _isDirty = false;
                if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
                storage.localRemove(KEYS.diagLog);
            },
            flush() {
                _flushSync();
            }
        };
    })();

    // Метрики: накопительная статистика для улучшения скрипта.
    // Копим распределение сценариев, тайминги, здоровье селекторов (new vs legacy) и
    // снимки DOM в проблемных местах - по ним видно, что и когда поменял hh.ru.
    const Metrics = {
        _get() {
            const m = parseJson(storage.localGet(KEYS.metrics), null);
            if (m && typeof m === 'object') {
                m.counters = m.counters || {};
                m.timings = m.timings || {};
                m.selectors = m.selectors || {};
                m.snapshots = Array.isArray(m.snapshots) ? m.snapshots : [];
                return m;
            }
            return { startedAt: Date.now(), counters: {}, timings: {}, selectors: {}, snapshots: [] };
        },
        _save(m) {
            if (!storage.localSet(KEYS.metrics, JSON.stringify(m))) {
                // Переполнение - сбрасываем снимки (самое тяжёлое) и пробуем снова
                m.snapshots = (m.snapshots || []).slice(-3);
                storage.localSet(KEYS.metrics, JSON.stringify(m));
            }
        },
        bump(key, by = 1) {
            const m = Metrics._get();
            m.counters[key] = (m.counters[key] || 0) + by;
            Metrics._save(m);
        },
        timing(key, ms) {
            if (!Number.isFinite(ms)) return;
            const m = Metrics._get();
            const t = m.timings[key] || { n: 0, sum: 0, last: 0, max: 0 };
            t.n++; t.sum += ms; t.last = ms; if (ms > t.max) t.max = ms;
            m.timings[key] = t;
            Metrics._save(m);
        },
        selector(name, found) {
            const m = Metrics._get();
            const s = m.selectors[name] || { found: 0, missing: 0 };
            if (found) s.found++; else s.missing++;
            m.selectors[name] = s;
            Metrics._save(m);
        },
        snapshot(label, data) {
            const m = Metrics._get();
            m.snapshots.push({ t: Date.now(), label, ...data });
            if (m.snapshots.length > DOM_SNAPSHOT_MAX) m.snapshots = m.snapshots.slice(-DOM_SNAPSHOT_MAX);
            Metrics._save(m);
        },
        getAll() { return Metrics._get(); },
        clear() { storage.localRemove(KEYS.metrics); }
    };

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
            try { window._hh_ar_renderStats?.(); } catch (e) { /* ignore */ }
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
            try { window._hh_ar_renderStats?.(); } catch (e) { /* ignore */ }
        }
    };

    // Лог в панели + консоль + постоянное хранилище.
    // Порядок обновления:
    // 1. Сохранить запись в DiagLog
    // 2. Обновить inline UI
    // 3. Обновить full diagnostic UI
    // 4. Обновить diagnostic badge
    const MAX_INLINE_LOG_ENTRIES = 8;
    const log = (msg, isError = false) => {
        // 1. Сохраняем запись в диагностический лог (не блокируя UI при ошибках storage)
        try {
            DiagLog.push(msg, isError);
        } catch (e) { /* ошибки storage не должны ломать UI */ }

        try {
            const timeStr = new Date().toLocaleTimeString('ru-RU');
            const fullText = `[${timeStr}] ${msg}`;

            // 2. Inline box preview (последние 6-8 строк без вложенного скролла)
            const logBox = document.getElementById('ar-log-box');
            if (logBox) {
                const entry = document.createElement('div');
                entry.className = 'ar-log-line' + (isError ? ' ar-log-err' : '');
                entry.textContent = fullText;
                entry.dataset.error = isError ? '1' : '0';
                const errorsOnly = document.getElementById('ar-log-errors-only');
                if (errorsOnly && errorsOnly.checked && !isError) {
                    entry.style.display = 'none';
                }
                logBox.appendChild(entry);

                // Ограничиваем inline-превью последними записями, чтобы не раздувать DOM
                const children = Array.from(logBox.children);
                if (children.length > MAX_INLINE_LOG_ENTRIES) {
                    children.slice(0, children.length - MAX_INLINE_LOG_ENTRIES).forEach(c => c.remove());
                }
            }

            // 3. Выделенный полноразмерный экран диагностики
            const fullBox = document.getElementById('ar-diag-full-box');
            if (fullBox) {
                const fullEntry = document.createElement('div');
                fullEntry.className = 'ar-log-line' + (isError ? ' ar-log-err' : '');
                fullEntry.textContent = fullText;
                fullEntry.dataset.error = isError ? '1' : '0';
                const fullErrorsOnly = document.getElementById('ar-diag-full-errors-only');
                if (fullErrorsOnly && fullErrorsOnly.checked && !isError) {
                    fullEntry.style.display = 'none';
                }
                fullBox.appendChild(fullEntry);
                fullBox.scrollTop = fullBox.scrollHeight;
            }

            // 4. Обновляем счетчик / бейдж
            try {
                window._hh_ar_updateDiagBadge?.();
            } catch (e) { /* ignore */ }
        } catch (e) { /* UI-лог не критичен */ }

        console.log(`[applomat] ${msg}`);
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
            log(`Снимок DOM (${label}): data-qa=${dataQa.length}, textarea=${textareas.length}, taskFields=${taskFields.length}, modalBtns=${modalButtons.length}.`);
        } catch (e) { /* ignore */ }
    }

    // Фиксируем, какой вариант селектора реально сработал: новый или legacy-фоллбек.
    // Если legacy начинает преобладать - значит hh.ru вернул старую вёрстку (или наоборот).
    function recordSelectorVariant(name, newSel, legacySel) {
        try {
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
        try { cfgSnapshot = JSON.stringify({ ...config, coverText: `(${(config.coverText || '').length} симв.)` }); } catch (e) { /* ignore */ }
        const lockRaw = storage.localGet(KEYS.instanceLock) || '(нет)';

        const entries = DiagLog.getAll();
        const header = [
            '===== applomat - Diagnostic Log =====',
            `Версия скрипта : v${VERSION}`,
            `Выгружено      : ${new Date().toISOString()}`,
            `URL сейчас     : ${location.href}`,
            `User-Agent     : ${navigator.userAgent}`,
            `TAB_ID         : ${TAB_ID}`,
            `Running        : ${State.amIRunning()}`,
            `Отправлено     : ${State.getSentCount()} / лимит ${config.limit}`,
            `Обработано ID  : ${State.getProcessedIDs().size}`,
            `Ручной список  : ${State.getManualList().length}`,
            `Instance lock  : ${lockRaw}`,
            `Trap lock      : ${State.hasTrapLock()}`,
            `F5 needed      : ${State.isF5Needed()}`,
            `Last attempt   : ${State.getLastAttemptID() || '(нет)'}`,
            `Return URL     : ${State.getReturnUrl() || '(нет)'}`,
            `Config         : ${cfgSnapshot}`,
            `Записей в логе  : ${entries.length}`,
            '==============================================',
            ''
        ].join('\n');

        const body = entries.map(e => {
            const lvl = e.lvl === 'ERR' ? 'ERR ' : 'INFO';
            return `[${fmtTime(e.t)}] [${lvl}] [tab ${e.tab || '?'}] [${e.path || '?'}] ${e.msg}`;
        }).join('\n');

        return header + buildMetricsSection() + '\n' + body + '\n' + buildSnapshotsSection();
    }

    // Секция метрик: распределение сценариев, тайминги, здоровье и варианты селекторов.
    function buildMetricsSection() {
        const m = Metrics.getAll();
        const c = m.counters || {};
        const get = (k) => c[k] || 0;
        const lines = [];
        lines.push('', '----- МЕТРИКИ (накопительно) -----');
        lines.push(`Метрики с      : ${new Date(m.startedAt || Date.now()).toISOString()}`);
        lines.push('Сценарии после клика Откликнуться:');
        lines.push(`  А (письмо необязательно) : ${get('scenario.A')}`);
        lines.push(`  Б (письмо обязательно)   : ${get('scenario.B')}`);
        lines.push(`  В (прямой отклик)        : ${get('scenario.C')}`);
        lines.push(`  Окно переезда            : ${get('scenario.relocation')}`);
        lines.push(`  Тесты/вопросы (в отклике): ${get('scenario.questions')}`);
        lines.push(`  Тесты/вопросы (watchdog) : ${get('scenario.questions.watchdog')}`);
        lines.push(`  Таймаут (не опознано)    : ${get('scenario.timeout')} (из них неразрешённых: ${get('scenario.timeout.unresolved')})`);
        lines.push(`  Нет кнопки отклика       : ${get('scenario.noApply')}`);
        lines.push(`  Б без подтверждения      : ${get('scenario.B.noConfirm')}`);

        // Прочие счётчики (например, sel.* и всё, что не вошло выше)
        const known = new Set(['scenario.A', 'scenario.B', 'scenario.C', 'scenario.relocation', 'scenario.questions', 'scenario.questions.watchdog', 'scenario.timeout', 'scenario.timeout.unresolved', 'scenario.noApply', 'scenario.B.noConfirm']);
        const others = Object.keys(c).filter(k => !known.has(k)).sort();
        if (others.length) {
            lines.push('Прочие счётчики:');
            others.forEach(k => lines.push(`  ${k} : ${c[k]}`));
        }

        const t = m.timings || {};
        const tKeys = Object.keys(t);
        if (tKeys.length) {
            lines.push('Тайминги (мс - n / avg / max / last):');
            tKeys.forEach(k => {
                const v = t[k];
                const avg = v.n ? Math.round(v.sum / v.n) : 0;
                lines.push(`  ${k} : n=${v.n} avg=${avg} max=${v.max} last=${v.last}`);
            });
        }

        const sel = m.selectors || {};
        const sKeys = Object.keys(sel);
        if (sKeys.length) {
            lines.push('Здоровье селекторов (found / missing):');
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
        const lines = ['', '----- СНИМКИ DOM (последние, для обновления селекторов) -----'];
        if (!snaps.length) {
            lines.push('(пока пусто - снимки делаются только при сбое детекта/тестах)');
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
                lines.push('  taskFields (вопросы работодателя):');
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
            downloadFile(`applomat_log_${stamp}.txt`, report, 'text/plain;charset=utf-8');
            log('Диагностический лог выгружен в файл.');
        } catch (e) {
            log('Не удалось выгрузить лог: ' + (e && e.message), true);
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

    const State = {
        getProcessedIDs: () => {
            const arr = parseJson(storage.sessionGet(KEYS.history), []);
            return new Set(Array.isArray(arr) ? arr : []);
        },
        addProcessedID: (id) => {
            if (!id) return;
            const s = State.getProcessedIDs();
            s.add(id);
            storage.sessionSet(KEYS.history, JSON.stringify([...s]));
        },
        clearProcessedIDs: () => storage.sessionRemove(KEYS.history),

        // Счётчик успешно отправленных откликов - переживает переходы между страницами,
        // поэтому лимит работает на весь прогон, а не сбрасывается на каждой загрузке.
        getSentCount: () => {
            const n = parseInt(storage.sessionGet(KEYS.sentCount) || '0', 10);
            return Number.isFinite(n) ? n : 0;
        },
        incSentCount: () => {
            const next = State.getSentCount() + 1;
            storage.sessionSet(KEYS.sentCount, String(next));
            Stats.bump('success');
            return next;
        },
        resetSentCount: () => storage.sessionRemove(KEYS.sentCount),

        amIRunning: () => storage.sessionGet(KEYS.isRunning) === '1',
        setRunning: (state) => state ? storage.sessionSet(KEYS.isRunning, '1') : storage.sessionRemove(KEYS.isRunning),

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
            storage.sessionSet(KEYS.trapLock, token);
            setTimeout(() => {
                if (storage.sessionGet(KEYS.trapLock) === token) {
                    storage.sessionRemove(KEYS.trapLock);
                    log('Очистил ar_trap_lock по таймауту.');
                }
            }, ttlMs);
            return token;
        },
        clearTrapLock: (token) => {
            if (token) {
                if (storage.sessionGet(KEYS.trapLock) === token) {
                    storage.sessionRemove(KEYS.trapLock);
                }
            } else {
                storage.sessionRemove(KEYS.trapLock);
            }
        },
        hasTrapLock: () => !!storage.sessionGet(KEYS.trapLock),

        // Запоминаем последнюю попытку отклика - пригодится при редиректах
        setLastAttemptID: (id) => { if (id) storage.sessionSet(KEYS.lastAttempt, id); },
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

        // Простая кросс-вкладочная блокировка (instance lock).
        // Асинхронная: localStorage не даёт атомарного compare-and-set, поэтому после
        // записи перечитываем ключ с небольшой задержкой - если другая вкладка успела
        // перезаписать лок в этом окне, признаём поражение (лок уже не наш).
        acquireInstanceLock: async (tabId) => {
            const now = Date.now();
            const obj = parseJson(storage.localGet(KEYS.instanceLock), null);
            if (obj && Number.isFinite(Number(obj.ts)) && now - obj.ts < TUNING.instanceLockTtl && obj.tabId !== tabId) {
                return false;
            }
            storage.localSet(KEYS.instanceLock, JSON.stringify({ tabId, ts: now }));
            await sleep(60);
            const check = parseJson(storage.localGet(KEYS.instanceLock), null);
            return !!(check && check.tabId === tabId);
        },
        releaseInstanceLock: (tabId) => {
            const obj = parseJson(storage.localGet(KEYS.instanceLock), null);
            if (obj && obj.tabId === tabId) storage.localRemove(KEYS.instanceLock);
        },
        // Обновляем timestamp блокировки, если она принадлежит нашей вкладке.
        // Возвращает статус: 'OWNED' (лок успешно продлён) | 'LOST' (лок принадлежит другой вкладке или отсутствует).
        touchInstanceLock: (tabId) => {
            const obj = parseJson(storage.localGet(KEYS.instanceLock), null);
            if (obj && obj.tabId === tabId) {
                storage.localSet(KEYS.instanceLock, JSON.stringify({ tabId, ts: Date.now() }));
                return 'OWNED';
            }
            return 'LOST';
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
                    const saved = storage.localSet(KEYS.manualList, JSON.stringify(list));
                    return saved ? 'ADDED' : 'FAILED';
                } else if ((!exists.title || exists.title === 'Название недоступно') && normalizedEntry.title && normalizedEntry.title !== 'Название недоступно') {
                    exists.title = normalizedEntry.title;
                    const saved = storage.localSet(KEYS.manualList, JSON.stringify(list));
                    return saved ? 'UPDATED' : 'FAILED';
                }
                return 'EXISTS';
            } catch (e) {
                console.warn('[applomat] addManualEntry error', e);
                return 'FAILED';
            }
        },
        removeManualEntry: (vid) => {
            try {
                const list = State.getManualList().filter(e => e.vid !== vid);
                return storage.localSet(KEYS.manualList, JSON.stringify(list));
            } catch (e) {
                console.warn('[applomat] removeManualEntry error', e);
                return false;
            }
        },
        clearManualList: () => {
            try {
                storage.localRemove(KEYS.manualList);
                return true;
            } catch (e) {
                console.warn('[applomat] clearManualList error', e);
                return false;
            }
        }
    };

    // При авто-возобновлении сразу проверяем lock (запись в localStorage происходит
    // синхронно при вызове, пост-верификация - асинхронно)
    if (State.amIRunning()) {
        State.acquireInstanceLock(TAB_ID).then((ok) => {
            if (!ok) console.warn('[applomat] Обнаружен активный процесс в другой вкладке.');
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
        const el = q(selector, root);
        if (el && !isAutoResponderUI(el)) {
            recordSelectorVariant(keyOrSelector, selector, null);
            return el;
        }
        // Запуск эвристического поиска
        const found = runHeuristic(keyOrSelector, root || document);
        if (found && !isAutoResponderUI(found)) {
            Metrics.bump(`heuristic.fallback.${keyOrSelector}`);
            log(`[Heuristics] Резервный поиск для "${keyOrSelector}": обнаружен <${found.tagName.toLowerCase()}>`);
            return found;
        }
        return null;
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
            log(`[Heuristics] Резервный поиск всех элементов для "${keyOrSelector}": найдено ${found.length}`);
        }
        return found;
    }

    function runHeuristic(key, root) {
        try {
            switch (key) {
                case 'applyBtn':
                case 'vacancyApply':
                case 'topApply': {
                    const elements = Array.from(root.querySelectorAll('button, a, [role="button"]'));
                    const matchText = /откликнуться|отклик без резюме|перейти к отклику|apply|respond|no resume necessary|apply now/i;
                    for (const el of elements) {
                        if (isVisible(el) && matchText.test((el.textContent || '').trim())) {
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
                        if (isVisible(el) && matchText.test((el.textContent || '').trim())) {
                            return el;
                        }
                    }
                    // Если не нашли, ищем среди span и div (как фоллбек)
                    const staticEls = Array.from(root.querySelectorAll('span, div'));
                    for (const el of staticEls) {
                        if (isVisible(el) && matchText.test((el.textContent || '').trim())) {
                            // Исключаем контейнеры, если внутри них есть другие интерактивные элементы или textarea
                            if (el.querySelector('button, a, textarea, input, select')) continue;
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
                        if (isVisible(el) && matchText.test((el.textContent || '').trim())) {
                            const qaAttr = el.getAttribute('data-qa') || '';
                            if (qaAttr.includes('vacancy-response-link') || qaAttr.includes('vacancy-serp__vacancy_response')) continue;
                            return el;
                        }
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
                    const scope = root.querySelector('[data-qa*="relocation" i], [role="dialog"], [data-qa*="modal" i], [class*="modal" i]');
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
                    const matchText = /отказ|не подходит|будет отказ|reject|unsuitable|decline|likely to get a rejection/i;
                    for (const el of elements) {
                        if (isVisible(el) && matchText.test((el.textContent || '').trim())) {
                            return el;
                        }
                    }
                    break;
                }
                case 'responseChat': {
                    const elements = Array.from(root.querySelectorAll('a, button'));
                    const matchText = /сообщение|чат|переписке|перейти к|message|chat|topic/i;
                    for (const el of elements) {
                        if (isVisible(el) && matchText.test((el.textContent || '').trim())) {
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
            console.warn('[applomat] Ошибка в эвристике для ' + key, e);
        }
        return null;
    }

    function runHeuristicAll(key, root) {
        try {
            switch (key) {
                case 'applyBtn': {
                    const buttons = Array.from(root.querySelectorAll('button, a, [role="button"]'));
                    const matchText = /откликнуться|отклик без резюме|apply|respond|no resume necessary/i;
                    const results = buttons.filter(el => isVisible(el) && matchText.test((el.textContent || '').trim()));
                    if (results.length > 0) return results;
                    // Только интерактивные элементы и без служебных data-qa (см. runHeuristic)
                    const notApply = /status|success|view-topic|error|chat/i;
                    const hrefs = Array.from(root.querySelectorAll('a[href*="/applicant/vacancy_response"], a[data-qa*="response"], button[data-qa*="response"], a[data-qa*="apply"], button[data-qa*="apply"]'));
                    return hrefs.filter(el => isVisible(el) && !notApply.test(el.getAttribute('data-qa') || ''));
                }
                case 'vacancyApply': {
                    const buttons = Array.from(root.querySelectorAll('button, a, [role="button"]'));
                    const matchText = /откликнуться|respond|apply/i;
                    return buttons.filter(el => isVisible(el) && matchText.test((el.textContent || '').trim()));
                }
            }
        } catch (e) {
            console.warn('[applomat] Ошибка в групповой эвристике для ' + key, e);
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

    // Ждём выполнения условия (возвращающего не-false значение или truthy результат).
    // Реагирует на MutationObserver, интервал и таймер, поддерживает мгновенную отмену по AbortSignal / stopSignal.
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
            let finished = false;

            const finish = (result) => {
                if (finished) return;
                finished = true;
                if (timer) { clearTimeout(timer); timer = null; }
                if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
                if (observer) { observer.disconnect(); observer = null; }
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

            if (typeof MutationObserver !== 'undefined') {
                observer = new MutationObserver(() => {
                    if (stopSignal || sig?.aborted) {
                        finish(false);
                        return;
                    }
                    try {
                        const res = checkFn();
                        if (res) finish(res);
                    } catch (e) { /* ignore */ }
                });
                try {
                    observer.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true });
                } catch (e) {}
            }

            pollTimer = setInterval(() => {
                if (stopSignal || sig?.aborted) {
                    finish(false);
                    return;
                }
                try {
                    const res = checkFn();
                    if (res) finish(res);
                } catch (e) { /* ignore */ }
            }, 80);

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
        } catch (e) { console.warn('[applomat] fillTextarea error', e); }
    }

    // Отслеживаем реальные координаты мыши пользователя, чтобы траектория начиналась оттуда
    let lastMousePos = { x: 0, y: 0 };
    window.addEventListener('mousemove', (e) => {
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

            if (!isRunCurrent(runId)) return false;

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
        isResponseForm: () => location.href.includes('/applicant/vacancy_response'),
        isSearchList: () => location.href.includes('/search/vacancy')
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

    // Признак успешно отправленного отклика: появилась ссылка на чат или текст "резюме доставлено".
    function isResponseConfirmed() {
        const chat = query('responseChat');
        if (chat && isVisible(chat)) {
            return true;
        }
        const success = q('[data-qa="vacancy-response-success"], .vacancy-response-success');
        if (success && isVisible(success)) {
            return true;
        }
        try {
            const nodes = document.querySelectorAll('h1,h2,h3,p,div,span');
            for (const el of nodes) {
                const t = el.childElementCount === 0 ? (el.textContent || '') : '';
                if (t && t.trim().toLowerCase().includes('резюме доставлено') && isVisible(el)) return true;
            }
        } catch (e) { /* ignore */ }
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
        const chat = query('responseChat');
        return !!(chat && isVisible(chat));
    }

    // Причина, по которой отклик в модалке не проходит (определяется со стороны hh.ru, не баг скрипта):
    //  - 'reject-warning'  - Скорее всего, будет отказ (вакансия требует больше, чем есть в резюме);
    //  - 'resume-hidden'   - нужно изменить видимость резюме, иначе отклик заблокирован;
    //  - ''                - причина не распознана.
    function detectModalBlockReason() {
        if (query('rejectWarning')) return 'reject-warning';
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
            if (vid && meta.vid && meta.vid === vid) return meta.title;
            if (Date.now() - (Number(meta.ts) || 0) < 15 * 60 * 1000) return meta.title;
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
    function saveCurrentForManual(vid, note) {
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
                log(`Сохранено для ручного отклика${note ? ' (' + note + ')' : ''}: ${vid}`);
                try { window._hh_ar_renderManualList?.(); } catch (e) { /* ignore */ }
                return true;
            } else if (res === 'EXISTS' || res === 'UPDATED') {
                log(`Вакансия уже в списке для ручного отклика${note ? ' (' + note + ')' : ''}: ${vid}`);
                try { window._hh_ar_renderManualList?.(); } catch (e) { /* ignore */ }
                return true;
            } else {
                log(`Ошибка сохранения в список для ручного отклика (сбой хранилища)${note ? ' [' + note + ']' : ''}: ${vid}`, true);
                return false;
            }
        } catch (e) {
            console.warn('[applomat] saveCurrentForManual error', e);
            log(`Ошибка сохранения в список для ручного отклика: ${vid}`, true);
            return false;
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  9. СТАТУС В ПАНЕЛИ
    // ─────────────────────────────────────────────────────────────

    const STATUS_TEXT = {
        idle: 'Ожидание',
        running: 'В работе',
        stopped: 'Остановлено',
        error: 'Внимание',
        done: 'Завершено'
    };

    function setStatus(statusKey, customText) {
        const key = STATUS_TEXT[statusKey] ? statusKey : 'idle';
        const el = document.getElementById('ar-status-text');
        if (!el) return;
        const isTurbo = config?.preset === 'turbo';
        let text = customText || STATUS_TEXT[key];
        if (key === 'running' && isTurbo && !customText) {
            text = 'В работе · ↯ Турбо';
        }
        el.textContent = text;
        el.title = text;
        el.className = 'ar-status ar-status--' + key + (isTurbo ? ' is-turbo' : '');

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

        /* Top red flow line removed per design polish */

        const progBar = document.querySelector('.ar-progress');
        if (progBar) progBar.classList.toggle('is-turbo', running && isTurbo);

        const toggle = document.getElementById('ar-toggle-btn');
        if (toggle) {
            toggle.classList.toggle('is-running', running);
            toggle.setAttribute('data-status', key);
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  10. ЛОГИКА ОТКЛИКА
    // ─────────────────────────────────────────────────────────────

    // Человеческий скролл: вниз до секции Подходящие вакансии в этой компании
    // (или до 60% страницы), пауза, и возврат вверх.
    async function simulateReading(viewTime, runId = currentRunId) {
        try {
            await actionPause();
            if (!isRunCurrent(runId)) return;

            const stepMs = Math.max(100, TUNING.scrollStepMs);
            const docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
            const winH = window.innerHeight || document.documentElement.clientHeight;
            const maxY = Math.max(0, docHeight - winH);

            const needle = 'подходящие вакансии в этой компании';
            let sectionEl = null;
            for (const el of qa('h1,h2,h3,h4,div,section')) {
                try {
                    if (el.innerText && el.innerText.trim().toLowerCase().includes(needle)) {
                        sectionEl = el;
                        break;
                    }
                } catch (e) { continue; }
            }

            let targetY;
            if (sectionEl) {
                const rect = sectionEl.getBoundingClientRect();
                targetY = clamp(Math.round(rect.top + window.pageYOffset - 100), 0, maxY);
                log('Найдена секция "Подходящие вакансии..." - скроллю до неё.');
            } else {
                targetY = Math.round(maxY * 0.6);
                log('Секция не найдена - скроллю до 60% страницы (фоллбек).');
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
            console.warn('[applomat] simulateReading error', e);
        }
    }

    // Динамически определяем, что произошло после клика "Откликнуться".
    // Возвращает: 'STOPPED' | 'QUESTIONS' | 'RELOCATION' | 'SCENARIO_A' | 'SCENARIO_B' | 'SCENARIO_C' | 'TIMEOUT'
    async function resolveResponseOutcome(timeout, runId = currentRunId) {
        const outcome = await waitForCondition(() => {
            if (!isRunCurrent(runId)) return 'STOPPED';
            // Капча/анти-бот появилась прямо в ответ на клик - ловим сразу (не дожидаясь
            // тика watchdog), пока оверлей ещё на экране и до навигации назад к списку.
            if (detectCaptcha()) return 'CAPTCHA';
            // HH перебросил на страницу тестов/вопросов
            if (Page.isResponseForm()) return 'QUESTIONS';
            // Окно подтверждения переезда
            if (isVisible(query('relocationBtn'))) return 'RELOCATION';
            // Сценарий Б проверяется РАНЬШЕ сценария А: внутри ещё не отправленной модалки
            // есть кнопка прикрепить сопроводительное, которую эвристика сценария А
            // принимала за пост-отправочное предложение письма - и при выключенном письме
            // скрипт засчитывал успех, не отправив отклик вовсе.
            // Поле письма может быть ещё скрыто за кнопкой "прикрепить сопроводительное" -
            // поэтому ориентируемся именно на видимую кнопку отправки, а не на textarea.
            if (isVisible(query('letterSubmit'))) return 'SCENARIO_B';
            // Сценарий А: резюме отправлено, предлагают прикрепить письмо (пост-отправка)
            if (isVisible(query('attachCoverBtn'))) return 'SCENARIO_A';
            // Сценарий В: прямой отклик - есть признак успешной отправки
            if (isResponseConfirmed()) return 'SCENARIO_C';
            return false;
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
            log('Окно переезда - подтверждаю.');
            const reloc = query('relocationBtn');
            if (reloc) {
                await actionPause();
                if (!isRunCurrent(runId)) return 'STOPPED';
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
                log('Поле письма не появилось - отправляю отклик без сопроводительного.', true);
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
                    if (!isRunCurrent(runId)) return false;
                    try { form.submit(); log('Отправил форму через form.submit() (fallback).'); return true; }
                    catch (e) { console.warn('[applomat] form.submit fallback failed', e); }
                }
            }
        }
        if (!isRunCurrent(runId)) return false;
        if (!submitButton) { log('Кнопка отправки письма не найдена.', true); return false; }

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
                if (onPage && !Page.isResponseForm()) return 'CONFIRMED';
                if (isResponseConfirmed()) return 'CONFIRMED';
                return false;
            }, 3500);
            if (res === 'STOPPED' || !isRunCurrent(runId)) return 'STOPPED';
            if (res === 'QUESTIONS') return 'REDIRECT';
            if (res === 'CONFIRMED') return 'OK';
        }
        return 'FAIL';
    }

    // Ожидание подтверждения после отправки: 'QUESTIONS' | 'CONFIRMED' | 'STOPPED' | false.
    async function awaitSubmitConfirmation(timeout = TUNING.confirmWaitMs, runId = currentRunId) {
        return waitForCondition(() => {
            if (!isRunCurrent(runId)) return 'STOPPED';
            if (Page.isResponseForm()) return 'QUESTIONS';
            return isResponseConfirmed();
        }, timeout);
    }

    // Карточка выдачи могла вычислить для вакансии другой ID, чем страница вакансии
    // (например, hash от рекламной ссылки без vacancyId). Помечаем обработанным и его,
    // иначе та же карточка выбиралась бы из списка заново - бесконечно.
    function markAliasProcessed(vid) {
        const last = State.getLastAttemptID();
        if (last && last !== vid) State.addProcessedID(last);
    }

    // Подготовка к переходу на страницу отклика/тестов: отдаём управление watchdog'у.
    // ВАЖНО: REDIRECT !== PROCESSED. Вакансия не помечается processed, пока исход
    // не подтверждён (успешная отправка или гарантированное сохранение в Manual Queue).
    function markRedirect(vid) {
        if (vid && !State.getLastAttemptID()) State.setLastAttemptID(vid);
        return 'REDIRECT';
    }

    // Возврат к списку вакансий после обработки одной вакансии.
    // Помечаем вакансию обработанной (чтобы не зациклиться) и уходим на сохранённый список.
    function returnToList(vid, { markProcessed = true, runId = currentRunId } = {}) {
        if (runId && !isRunCurrent(runId)) return;
        if (markProcessed && vid) {
            State.addProcessedID(vid);
            markAliasProcessed(vid);
        }
        State.clearLastAttemptID();
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
                if (isRunCurrent(timerRunId) && !Page.isSearchList()) {
                    window.location.href = '/search/vacancy';
                }
            }, 1500);
        }
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
        const reject = !!query('rejectWarning');
        if (reject) Metrics.bump('reject.seen.page');
        try {
            if (reject && !config.applyOnRejectWarning) {
                if (!isRunCurrent(runId)) return;
                log('Страница отклика с предупреждением об отказе; форс выключен - сохраняю для ручного отклика.', true);
                Metrics.bump('page.reject.skipped');
                savedForManual = saveCurrentForManual(vid, 'reject-warning');
            } else {
                log(`Страница отклика (не тест)${reject ? ' с предупреждением об отказе' : ''} - заполняю и отправляю.`);
                captureResponseDom('response-page-form');
                const submitted = await fillLetterAndSubmit({ withCover: config.useCover, runId });
                if (!isRunCurrent(runId)) return;
                if (!submitted) {
                    Metrics.bump('page.response.fail');
                    captureResponseDom('response-page-no-submit');
                    savedForManual = saveCurrentForManual(vid, reject ? 'reject-warning' : 'page-no-submit');
                    log('Не удалось нажать отправку на странице отклика - сохранил для ручного.', true);
                } else {
                    let redirectedToQuestions = false;

                    const ok = await waitForCondition(() => {
                        if (!isRunCurrent(runId)) return 'STOPPED';
                        if (detectCaptcha()) return 'CAPTCHA';
                        if (!Page.isResponseForm()) return 'NAVIGATED';
                        if (isResponseConfirmed()) return 'CONFIRMED';
                        return false;
                    }, TUNING.confirmWaitMs);

                    if (!isRunCurrent(runId)) return;
                    if (ok === 'CAPTCHA') {
                        haltForCaptcha();
                        return;
                    }
                    if (ok === 'NAVIGATED' || ok === 'CONFIRMED') {
                        confirmed = true;
                    } else if (isRunCurrent(runId)) {
                        const forced = await forceSubmitReject(TUNING.forceSubmitAttempts, { onResponsePage: true, runId });
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
                        State.incSentCount();
                        log('Отклик отправлен со страницы отклика.');
                    } else if (redirectedToQuestions) {
                        Metrics.bump('scenario.questions.responsePage');
                        savedForManual = saveCurrentForManual(vid, 'questions');
                        log('Страница отклика перенаправила на вопросы/тест - сохранил для ручного.', true);
                    } else {
                        Metrics.bump('page.response.fail');
                        captureResponseDom('response-page-no-confirm');
                        savedForManual = saveCurrentForManual(vid, reject ? 'reject-warning' : 'page-no-confirm');
                        log('Не удалось подтвердить отправку со страницы отклика - сохранил для ручного.', true);
                    }
                }
            }
        } catch (e) {
            if (!isRunCurrent(runId)) return;
            console.warn('[applomat] submitResponsePage error', e);
            try { savedForManual = saveCurrentForManual(vid, 'page-error'); } catch (_) { /* ignore */ }
        } finally {
            if (runId === currentRunId) {
                handlingResponsePage = false;
            }
            State.clearTrapLock(trapToken);
        }
        if (!isRunCurrent(runId)) return;
        if (confirmed || savedForManual) {
            if (vid) {
                State.addProcessedID(vid);
                markAliasProcessed(vid);
            }
            State.clearLastAttemptID();
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
            log('Не удалось получить href вакансии - пропускаю.', true);
            return 'ERROR_NO_HREF';
        }
        log(`Открываю страницу вакансии ${vid} для чтения...`);
        await actionPause();
        if (!isRunCurrent(runId)) return 'STOPPED';
        State.setLastAttemptID(vid); // запомним, на какую вакансию кликаем
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
            log('На эту вакансию уже откликались ранее - пропускаю.');
            returnToList(vid, { markProcessed: true, runId });
            return 'RETURNED';
        }
        // Кнопки нет - помечаем обработанной и возвращаемся.
        Metrics.bump('scenario.noApply');
        Stats.bump('skipped');
        captureResponseDom('no-apply-button');
        log('Кнопка "Откликнуться" не найдена - помечаю вакансию как обработанную и возвращаюсь.', true);
        returnToList(vid, { markProcessed: true, runId });
        return 'RETURNED';
    }

    // Сценарий А: резюме уже отправлено, письмо - по желанию.
    async function handleScenarioA(vid, runId = currentRunId) {
        if (!isRunCurrent(runId)) return 'STOPPED';
        log('Сценарий А: резюме отправлено, письмо необязательно.');
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
            log('Письмо выключено - пропускаю прикрепление.');
        }
        if (!isRunCurrent(runId)) return 'STOPPED';
        State.incSentCount();
        log('Отклик отправлен (сценарий А).');
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
        const rejectSeen = !!query('rejectWarning');
        if (rejectSeen) Metrics.bump('reject.seen.modal');
        // Если откликаться при предупреждении об отказе выключено - не отправляем такие,
        // а откладываем в ручной список (иначе realisticClick отправил бы их с первого клика).
        if (rejectSeen && !config.applyOnRejectWarning) {
            Metrics.bump('reject.skipped.modal');
            log('Предупреждение об отказе, откликаться всё равно выключено - сохраняю для ручного отклика.');
            const saved = saveCurrentForManual(vid, 'reject-warning');
            if (!saved) {
                haltForPersistenceFailure(vid);
                return 'STOPPED';
            }
            returnToList(vid, { markProcessed: true, runId });
            return 'RETURNED';
        }
        log(`Сценарий Б: модалка отклика${rejectSeen ? ' (⚠ предупреждение об отказе)' : ''}${config.useCover ? ', заполняю письмо и отправляю.' : ' - отправляю без письма.'}`);
        const submitted = await fillLetterAndSubmit({ withCover: config.useCover, runId });
        if (!isRunCurrent(runId)) return 'STOPPED';
        if (!submitted) {
            log('Не удалось нажать отправку отклика - возвращаюсь к списку.', true);
            captureResponseDom('scenarioB-no-submit');
            const saved = saveCurrentForManual(vid, rejectSeen ? 'reject-warning' : 'no-submit');
            if (!saved) {
                haltForPersistenceFailure(vid);
                return 'STOPPED';
            }
            returnToList(vid, { markProcessed: true, runId });
            return 'RETURNED';
        }
        const conf = await awaitSubmitConfirmation(TUNING.confirmWaitMs, runId);
        if (!isRunCurrent(runId)) return 'STOPPED';
        if (conf === 'QUESTIONS' || Page.isResponseForm()) return markRedirect(vid);
        if (conf === 'CONFIRMED' || conf === true) {
            if (rejectSeen) Metrics.bump('reject.sent.modal');
            if (!isRunCurrent(runId)) return 'STOPPED';
            State.incSentCount();
            log(`Отклик отправлен (сценарий Б${rejectSeen ? ', несмотря на предупреждение об отказе' : ''}).`);
            returnToList(vid, { markProcessed: true, runId });
            return 'OK';
        }
        // Отправили, но подтверждения нет - выясняем причину (это блок со стороны hh.ru).
        const reason = detectModalBlockReason();

        // Предупреждение Скорее всего, будет отказ: если включён форс - дожимаем отправку.
        if (reason === 'reject-warning' && config.applyOnRejectWarning) {
            log('Предупреждение об отказе - дожимаю отправку (включено откликаться всё равно).');
            const forced = await forceSubmitReject(TUNING.forceSubmitAttempts, { onResponsePage: false, runId });
            if (forced === 'STOPPED' || !isRunCurrent(runId)) return 'STOPPED';
            if (forced === 'REDIRECT') return markRedirect(vid);
            if (forced === 'OK') {
                if (!isRunCurrent(runId)) return 'STOPPED';
                Metrics.bump('scenario.B.rejectForced.ok');
                State.incSentCount();
                log('Отклик отправлен (форс, предупреждение об отказе).');
                returnToList(vid, { markProcessed: true, runId });
                return 'OK';
            }
            Metrics.bump('scenario.B.rejectForced.fail');
        }

        Metrics.bump('scenario.B.noConfirm' + (reason ? '.' + reason : ''));
        captureResponseDom('scenarioB-no-confirm');
        if (reason === 'resume-hidden') {
            log('Отклик заблокирован: скрыта видимость резюме. Измените видимость резюме в настройках hh.ru, иначе часть откликов не проходит.', true);
        } else if (reason === 'reject-warning') {
            log('Вакансия с предупреждением скорее всего, отказ - отклик не подтверждён.', true);
        } else {
            log('Письмо отправлено, подтверждение не получено.', true);
        }
        // Не теряем такие вакансии - сохраняем для ручной обработки.
        const saved = saveCurrentForManual(vid, reason || 'no-confirm');
        if (!saved) {
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
            log('Отклик подтверждён (есть подтверждение отправки).');
            State.incSentCount();
            returnToList(vid, { markProcessed: true, runId });
            return 'OK';
        }

        // Терминальные статусы
        if (detectCaptcha()) { haltForCaptcha(); return 'CAPTCHA'; }
        if (Page.isResponseForm()) return markRedirect(vid);
        if (detectAlreadyApplied()) {
            Metrics.bump('scenario.alreadyApplied');
            Stats.bump('skipped');
            log('На эту вакансию уже откликались ранее - пропускаю.');
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
                log('Отклик подтверждён после дополнительной проверки DOM.');
                State.incSentCount();
                returnToList(vid, { markProcessed: true, runId });
                return 'OK';
            }
            if (detectCaptcha()) { haltForCaptcha(); return 'CAPTCHA'; }
            if (Page.isResponseForm()) return markRedirect(vid);
            if (detectAlreadyApplied()) {
                Metrics.bump('scenario.alreadyApplied');
                Stats.bump('skipped');
                log('На эту вакансию уже откликались ранее - пропускаю.');
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
            log('Кнопка "Откликнуться" исчезла, но подтверждение отправки не получено - сохраняю для ручной обработки.', true);
            const blockReason = detectModalBlockReason();
            const saved = saveCurrentForManual(vid, blockReason || 'button-disappeared-unconfirmed');
            if (!saved) {
                haltForPersistenceFailure(vid);
                return 'STOPPED';
            }
            returnToList(vid, { markProcessed: true, runId });
            return 'RETURNED';
        }

        // Кнопка отклика всё ещё на месте и ничего не открылось - вероятно, первый клик не сработал.
        // Пробуем один повторный клик.
        Metrics.bump('scenario.retryClick');
        log('Окно не открылось - повторный клик по Откликнуться.', true);
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
            State.incSentCount();
            log('Отклик отправлен после повторного клика.');
            returnToList(vid, { markProcessed: true, runId });
            return 'OK';
        }

        // Совсем неопознанный исход - снимок DOM максимально полезен для обновления селекторов.
        Metrics.bump('scenario.timeout.unresolved');
        captureResponseDom('timeout-unresolved');
        log('Не удалось определить результат отклика - сохраняю для ручной обработки и возвращаюсь.', true);
        const saved = saveCurrentForManual(vid, 'timeout');
        if (!saved) {
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
        log(`Читаю ~${Math.round(viewTime / 1000)} сек (имитирую просмотр страницы).`);
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
        if (!State.getLastAttemptID()) State.setLastAttemptID(vid);

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
                log('Сценарий В: прямой отклик - резюме отправлено.');
                State.incSentCount();
                returnToList(vid, { markProcessed: true, runId });
                return 'OK';
            default:
                return handleTimeout(vid, runId);
        }
    }

    // Обработка вакансии: работает и на странице вакансии, и для кнопки на листинге
    async function processVacancy(btn, runId = currentRunId) {
        if (!isRunCurrent(runId)) return 'STOPPED';

        if (Page.isVacancy()) return handleVacancyPage(btn, runId);

        if (btn) {
            const card = getVacancyCard(btn);
            const vacLink = (card && query('vacancyLink', card)) || (card && q('a[href*="/vacancy/"]', card));
            if (!vacLink) {
                log('Не найден селектор ссылки вакансии. Проверьте структуру карточки.', true);
                return 'ERROR_NO_LINK';
            }
            return openVacancyFromList(vacLink, runId);
        }

        return 'ERROR_UNKNOWN';
    }

    // ─────────────────────────────────────────────────────────────
    //  11. ГЛАВНЫЙ ЦИКЛ И WATCHDOG
    // ─────────────────────────────────────────────────────────────

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
        State.setRunning(true);
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
                log('Запуск отменён: в другой вкладке уже запущен процесс (instance lock).', true);
                State.setRunning(false);
                setStatus('error', 'Занято другой вкладкой');
            }
            return;
        }

        // Свежий запуск пользователем - сбрасываем сквозной счётчик и статистику прогона.
        if (!wasRunning) {
            State.resetSentCount();
            Stats.reset();
            log(`Новый запуск: счётчик откликов сброшен. Режим - ${timings().label}.`);
        }

        const finishRun = (statusKey, msg) => {
            if (runId !== currentRunId) return;
            isLoopActive = false;
            if (!Page.isResponseForm()) {
                handlingResponsePage = false;
            }
            State.setRunning(false);
            State.releaseInstanceLock(TAB_ID);
            setStatus(statusKey);
            if (msg) log(msg);
        };

        try {
            // Лимит уже достигнут - завершаем прогон.
            if (State.getSentCount() >= config.limit) {
                finishRun('done', `Лимит достигнут (${config.limit}). Работа завершена.`);
                return;
            }

            // Если на странице формы отклика - управление у watchdog/submitResponsePage
            if (Page.isResponseForm()) {
                isLoopActive = false;
                log('На странице отклика - управление у обработчика формы.');
                return;
            }

            // Если уже на странице вакансии - обрабатываем её напрямую.
            if (Page.isVacancy()) {
                log('На странице вакансии - продолжаю обработку тут.');
                const res = await processVacancy(null, runId);
                if (runId !== currentRunId) return;
                if (res === 'STOPPED' || stopSignal) {
                    finishRun('stopped', 'Остановлено пользователем во время обработки вакансии.');
                    return;
                }
                // Капча: haltForCaptcha уже снял флаги, освободил лок и выставил статус - просто выходим.
                if (res === 'CAPTCHA') { isLoopActive = false; return; }
                // OK / REDIRECT / RETURNED: навигация или watchdog продолжат цикл - флаг running сохраняем.
                isLoopActive = false;
                setStatus('running', res === 'OK' ? 'Возврат к списку...' : 'Ожидание возврата...');
                return;
            }

            const allBtns = queryAll('applyBtn');
            const processed = State.getProcessedIDs();

            const targets = allBtns.filter(b => {
                if (config.skipHidden && !isVisible(b)) return false;
                return !processed.has(getVacancyID(b));
            });

            log(`Найдено вакансий: ${allBtns.length}. Новых к обработке: ${targets.length}. Отправлено: ${State.getSentCount()}/${config.limit}.`);

            for (const btn of targets) {
                if (stopSignal || runId !== currentRunId) break;
                if (State.getSentCount() >= config.limit) {
                    finishRun('done', `Лимит достигнут (${config.limit}). Работа завершена.`);
                    return;
                }
                if (State.touchInstanceLock(TAB_ID) !== 'OWNED') {
                    haltForLostInstanceLock();
                    return;
                }
                if (!document.body.contains(btn)) {
                    log('Кнопка исчезла из DOM - перезапускаю поиск.', true);
                    break;
                }

                await vacancyPause();
                if (stopSignal || runId !== currentRunId) break;
                if (State.touchInstanceLock(TAB_ID) !== 'OWNED') {
                    haltForLostInstanceLock();
                    return;
                }

                const result = await processVacancy(btn, runId);
                if (runId !== currentRunId) return;

                if (result === 'STOPPED' || stopSignal) {
                    finishRun('stopped', 'Обработка остановлена пользователем.');
                    return;
                } else if (result === 'CAPTCHA') {
                    // haltForCaptcha уже остановил прогон и выставил статус.
                    isLoopActive = false;
                    return;
                } else if (result === 'NAVIGATED') {
                    // Перешли на страницу вакансии - завершаем цикл, флаг running оставляем для авто-старта.
                    log('Переход на страницу вакансии - завершаю цикл для корректной навигации.');
                    isLoopActive = false;
                    return;
                } else if (result === 'REDIRECT') {
                    log('Редирект/внешний тест. Ожидаю возврат через watchdog.', true);
                    isLoopActive = false;
                    setStatus('running', 'Ожидание возврата...');
                    return;
                } else {
                    // ERROR_NO_LINK / ERROR_NO_HREF и т.п. - пропускаем эту карточку и продолжаем.
                    log(`Пропускаю вакансию (код: ${result}).`, true);
                }
            }

            if (stopSignal || runId !== currentRunId) {
                finishRun('stopped', 'Обработка остановлена пользователем.');
                return;
            }
            if (!Page.isResponseForm()) {
                finishRun('done', `Работа завершена. Отправлено всего: ${State.getSentCount()}.`);
            }
        } catch (e) {
            console.warn('[applomat] startLoop error', e);
            finishRun('error', 'Ошибка в главном цикле: ' + (e && e.message ? e.message : e));
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
        State.setRunning(false);
        setStatus('stopped');
        State.releaseInstanceLock(TAB_ID);
        log('Остановлено пользователем.');
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
        State.setRunning(false);
        State.releaseInstanceLock(TAB_ID);
        setStatus('error', 'Обнаружена капча — остановлено');
        log('Обнаружена проверка «я не робот» / анти-бот hh.ru. Прогон остановлен: решите капчу вручную и запустите заново.', true);
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
        State.setRunning(false);
        setStatus('error', 'Занято другой вкладкой');
        log('Работа остановлена: межвкладочный instance lock перешёл к другой вкладке.', true);
    }

    // Остановка из-за сбоя сохранения в список для ручного отклика (Manual Queue).
    // Вакансию нельзя терять: останавливаем прогон, НЕ помечаем processed и сохраняем контекст.
    function haltForPersistenceFailure(vid) {
        currentRunId++;
        Metrics.bump('storage.manual.failed');
        stopSignal = true;
        if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
        handlingResponsePage = false;
        State.clearTrapLock();
        if (activeAbortController) {
            try { activeAbortController.abort(); } catch (e) {}
            activeAbortController = null;
        }
        isLoopActive = false;
        State.setRunning(false);
        State.releaseInstanceLock(TAB_ID);
        setStatus('error', 'Сбой сохранения Manual Queue');
        log(`Критический сбой хранилища: не удалось сохранить вакансию ${vid || ''} в список для ручного отклика. Автоматизация остановлена во избежание потери данных.`, true);
    }

    // Watchdog: следит за URL. Если попали на страницу отклика/теста - обрабатываем её;
    // после возврата на список при необходимости обновляем страницу.
    function startWatchdog() {
        setInterval(() => {
            try {
                watchdogTick();
            } catch (e) {
                console.warn('[applomat] watchdog error', e);
            }
        }, 1000);
    }

    function watchdogTick() {
        // Панель могла быть выброшена из DOM (SPA-перерисовка) - восстанавливаем.
        if (document.body && !document.getElementById('ar-main-panel')) setupUI();

        if (!State.amIRunning()) return;

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
            const trapToken = State.setTrapLock();

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
                log('Открылась страница отклика (не тест) - обрабатываю.');
                if (currentRunId === 0) currentRunId = 1;
                submitResponsePage(vid, backUrl, currentRunId, trapToken); // async: сам заполнит/отправит и вернёт к списку
                return;
            }

            // Настоящий тест/анкета - авто-ответить не можем: сохраняем для ручного отклика.
            Metrics.bump('scenario.questions.watchdog');
            captureResponseDom('questions-page');
            log('Попали на тест/анкету с вопросами. Сохраняю для ручного отклика и возвращаюсь.', true);

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
                    log(`Сохранена вакансия для ручного отклика: ${entry.vid}`);
                    try { window._hh_ar_renderManualList?.(); } catch (e) { /* ignore */ }
                    saved = true;
                } else if (res === 'EXISTS' || res === 'UPDATED') {
                    log(`Вакансия уже в списке для ручного отклика: ${entry.vid}`);
                    try { window._hh_ar_renderManualList?.(); } catch (e) { /* ignore */ }
                    saved = true;
                } else {
                    log(`Ошибка сохранения вакансии в ручной список (сбой хранилища): ${entry.vid}`, true);
                    saved = false;
                }
            } catch (e) {
                console.warn('[applomat] save manual entry error', e);
                log(`Ошибка сохранения вакансии в ручной список: ${vid}`, true);
                saved = false;
            }

            if (saved) {
                if (vid) {
                    State.addProcessedID(vid);
                    markAliasProcessed(vid);
                    State.clearLastAttemptID();
                } else {
                    log('Не удалось определить ID вакансии на странице с вопросами.', true);
                }

                State.setF5Needed(); // после возвращения нужно обновить список

                // Пытаемся откатиться двумя шагами назад: list <- vacancy <- applicant
                try { history.go(-2); } catch (e) { history.back(); }

                // Если через 1.2 сек всё ещё на странице с тестом - форсим переход на список
                const timerRunId = currentRunId;
                setTimeout(() => {
                    if (isRunCurrent(timerRunId) && Page.isResponseForm()) {
                        log('Двухшаговый возврат не сработал. Перехожу на список вакансий.', true);
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
                log('Возврат выполнен. Перезагружаю страницу, чтобы обновить список вакансий...');
                State.clearF5Flag();
                window.location.reload();
            }
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  12. UI: СТИЛИ ПАНЕЛИ (в духе дизайн-системы hh.ru / Magritte)
    // ─────────────────────────────────────────────────────────────

    function injectPanelStyles() {
        if (document.getElementById('ar-styles')) return;
        const style = document.createElement('style');
        style.id = 'ar-styles';
        style.textContent = `
        #ar-main-panel, #ar-main-panel *, #ar-toggle-btn, #ar-toggle-btn *{ box-sizing:border-box; }
        #ar-main-panel, #ar-toggle-btn{
            /* Палитра applomat: фирменный красный, синий основной CTA, зелёный статус успеха */
            --ap-brand:#d6001c; --ap-brand-hover:#b80018; --ap-brand-soft:#ffebee;
            --hh-red:#d6001c; --hh-red-hover:#b80018; --hh-red-soft:#ffebee;
            --hh-green:#059669; --hh-green-hover:#047857; --hh-green-soft:#ecfdf5;
            --hh-blue:#0070e5; --hh-blue-hover:#005cbd; --hh-blue-soft:#e9f2fd;
            --hh-amber:#d97706; --hh-amber-soft:#fffbeb;
            --ink:#1e293b; --ink-2:#475569; --ink-3:#94a3b8;
            --line:#e2e8f0; --line-2:#f1f5f9;
            --card:#ffffff; --bg:#f8fafc; --bg-2:#f1f5f9;
            --r-lg:12px; --r-md:8px; --r-sm:6px;
            --font:'HH Sans','Inter',-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
            font-family:var(--font); letter-spacing:normal; text-transform:none;
        }

        /* Панель раздвигает контент hh.ru, а не перекрывает его */
        html.hh-ar-open{ margin-right:410px !important; }
        html.hh-ar-anim{ transition:margin-right .2s ease; }

        /* Свёрнутое состояние - вертикальная вкладка applomat */
        #ar-toggle-btn{
            position:fixed; top:50%; right:0; transform:translateY(-50%);
            width:34px; height:104px; border:none; padding:10px 0;
            background:var(--ap-brand);
            color:#fff; border-radius:8px 0 0 8px;
            display:flex; flex-direction:column; align-items:center; justify-content:center;
            cursor:pointer; z-index:2147483000; box-shadow:0 1px 3px rgba(0,0,0,.18);
            user-select:none; transition:background .15s ease;
        }
        #ar-toggle-btn:hover{ background:var(--ap-brand-hover); }
        #ar-toggle-btn:focus-visible{ outline:2px solid #fff; outline-offset:-2px; }
        #ar-toggle-btn .ar-tab-dot{
            width:6px; height:6px; border-radius:50%;
            background:rgba(255,255,255,.55); flex:none; margin-bottom:8px;
            transition:background .2s ease;
        }
        #ar-toggle-btn.is-running .ar-tab-dot,
        #ar-toggle-btn[data-status="running"] .ar-tab-dot{ background:#34d399; }
        #ar-toggle-btn[data-status="error"] .ar-tab-dot{ background:#fbbf24; }
        #ar-toggle-btn[data-status="stopped"] .ar-tab-dot{ background:#f87171; }
        #ar-toggle-btn[data-status="done"] .ar-tab-dot{ background:#60a5fa; }
        #ar-toggle-btn .ar-tab-text{
            font-size:11.5px; font-weight:650; letter-spacing:.04em;
            color:#ffffff; text-transform:lowercase; line-height:1;
            writing-mode:vertical-rl; transform:rotate(180deg);
        }

        /* Каркас панели - боковая колонка во всю высоту */
        #ar-main-panel{
            position:fixed; top:0; right:0; bottom:0; height:100vh;
            width:410px; max-width:100vw;
            background:var(--bg); color:var(--ink);
            border-left:1px solid var(--line); z-index:2147483000;
            box-shadow:-4px 0 20px rgba(15,23,42,.06);
            font-family:var(--font); font-size:13px; line-height:1.4;
            display:flex; flex-direction:column; overflow:hidden; text-align:left;
        }
        #ar-main-panel a{ color:var(--hh-blue); text-decoration:none; }
        #ar-main-panel a:hover{ text-decoration:underline; }

        /* Views switching inside sidebar */
        .ar-view{
            display:flex; flex-direction:column; width:100%; height:100%; min-height:0; overflow:hidden;
        }
        .ar-diag-nav{ display:flex; align-items:center; gap:8px; min-width:0; }
        .ar-diag-view-title{ font-weight:600; font-size:13.5px; color:var(--ink); }
        .ar-btn-back{ padding:0 8px; font-weight:600; }
        .ar-diag-body{
            flex:1 1 auto; min-height:0; display:flex; flex-direction:column; gap:8px; padding:10px; background:var(--bg);
        }
        .ar-diag-toolbar{
            display:flex; align-items:center; justify-content:space-between; gap:8px; padding:2px 0;
        }
        .ar-diag-stat{ font-size:11px; color:var(--ink-3); font-weight:500; font-variant-numeric:tabular-nums; }
        .ar-diag-full-box{
            flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden;
            background:#0f172a; color:#94a3b8; border-radius:var(--r-md);
            font-family:'SFMono-Regular',ui-monospace,Menlo,Consolas,monospace; font-size:10.5px;
            padding:10px 12px; line-height:1.5; border:1px solid #1e293b;
            display:flex; flex-direction:column; gap:2px;
        }
        .ar-diag-full-box::-webkit-scrollbar{ width:6px; }
        .ar-diag-full-box::-webkit-scrollbar-thumb{ background:#334155; border-radius:6px; }

        /* Phase 4: Мягкий transient 1px inset pulse всей панели при активации Турбо */
        #ar-main-panel.is-turbo-activating{
            animation:ar-panel-edge-pulse .6s cubic-bezier(.22, 1, .36, 1) forwards;
        }
        @keyframes ar-panel-edge-pulse{
            0%{ box-shadow:-4px 0 20px rgba(15,23,42,.06), inset 0 0 0 0 rgba(214,0,28,0); }
            35%{ box-shadow:-4px 0 20px rgba(15,23,42,.08), inset 0 0 0 1px rgba(214,0,28,.28); }
            100%{ box-shadow:-4px 0 20px rgba(15,23,42,.06), inset 0 0 0 0 rgba(214,0,28,0); }
        }

        /* Phase 3b: Фирменная линия applomat - в обычном состоянии скрыта, пробегает 1 раз при активации Турбо */
        .ar-flow-line{
            position:absolute; top:0; left:0; right:0; height:2px;
            background:linear-gradient(90deg, #ff334b, #d6001c, #e11d48);
            transform:scaleX(0); transform-origin:left center;
            opacity:0; pointer-events:none; z-index:10;
        }
        .ar-flow-line.is-turbo-activating{
            animation:ar-flow-line-burst .6s cubic-bezier(.22, 1, .36, 1) forwards;
        }
        @keyframes ar-flow-line-burst{
            0%{ transform:scaleX(0); transform-origin:left center; opacity:0; }
            20%{ opacity:1; }
            50%{ transform:scaleX(1); transform-origin:left center; opacity:1; }
            51%{ transform:scaleX(1); transform-origin:right center; opacity:1; }
            80%{ opacity:1; }
            100%{ transform:scaleX(0); transform-origin:right center; opacity:0; }
        }

        /* Шапка: чистый lowercase текст, оптическое выравнивание */
        .ar-header{
            flex:0 0 auto; display:flex; align-items:center; justify-content:space-between; gap:8px;
            padding:10px 14px; border-bottom:1px solid var(--line); background:var(--card);
        }
        .ar-brand{ display:flex; align-items:baseline; gap:6px; min-width:0; }
        .ar-title{
            font-weight:600; font-size:13.5px; color:var(--ink);
            letter-spacing:-.01em; text-transform:lowercase; white-space:nowrap;
        }
        .ar-sub{ font-size:11px; font-weight:500; color:var(--ink-3); }
        .ar-header-right{ display:flex; align-items:center; gap:6px; flex:0 1 auto; min-width:0; }

        /* Статус-пилюля */
        .ar-status{
            display:inline-flex; align-items:center; gap:5px; min-width:0; max-width:160px;
            padding:2.5px 8px; font-size:10.5px; font-weight:600; border-radius:999px;
            white-space:nowrap; overflow:hidden; background:var(--bg-2); color:var(--ink-2);
            border:1px solid var(--line);
        }
        #ar-status-text{ overflow:hidden; text-overflow:ellipsis; }
        .ar-status::before{ content:''; width:6px; height:6px; border-radius:50%; background:currentColor; flex:none; }
        .ar-status--idle{ background:var(--bg-2); color:var(--ink-2); border-color:var(--line); }
        .ar-status--running{ background:var(--hh-green-soft); color:var(--hh-green); border-color:#a7f3d0; }
        .ar-status--running::before{ animation:ar-pulse 1.2s ease-in-out infinite; }
        .ar-status--stopped{ background:var(--hh-red-soft); color:#c01126; border-color:#fecaca; }
        .ar-status--error{ background:var(--hh-amber-soft); color:var(--hh-amber); border-color:#fde68a; }
        .ar-status--done{ background:var(--hh-blue-soft); color:var(--hh-blue); border-color:#bfdbfe; }
        .ar-status--turbo-confirm{ background:#1e293b !important; color:#ffffff !important; border-color:#334155 !important; }
        .ar-status--turbo-confirm::before{ background:#ff334b !important; }
        @keyframes ar-pulse{ 0%,100%{ opacity:1; transform:scale(1); } 50%{ opacity:.4; transform:scale(1.25); } }

        .ar-icon-btn{
            border:none; background:transparent; cursor:pointer; width:26px; height:26px;
            color:var(--ink-3); display:flex; align-items:center; justify-content:center;
            border-radius:var(--r-sm); transition:background .15s, color .15s;
        }
        .ar-icon-btn:hover{ background:var(--bg-2); color:var(--ink); }

        /* Прокручиваемое тело */
        .ar-scroll{
            flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden;
            padding:10px; display:flex; flex-direction:column; gap:9px;
        }
        .ar-scroll::-webkit-scrollbar{ width:6px; }
        .ar-scroll::-webkit-scrollbar-thumb{ background:#cbd5e1; border-radius:6px; }

        /* Карточки */
        .ar-card{
            background:var(--card); border-radius:var(--r-lg); padding:12px 14px;
            border:1px solid var(--line); box-shadow:0 1px 2px rgba(15,23,42,.04);
            display:flex; flex-direction:column; gap:9px; position:relative; overflow:hidden;
        }
        .ar-card-title{ font-size:12px; font-weight:700; color:var(--ink); text-transform:uppercase; letter-spacing:.03em; }

        /* Phase 2: Однократный легкий energy sweep через карточку "Режим работы" */
        .ar-card::before{
            content:''; position:absolute; top:0; left:0; right:0; bottom:0;
            background:linear-gradient(105deg, transparent 15%, rgba(214,0,28,.10) 45%, rgba(255,51,75,.16) 50%, rgba(214,0,28,.10) 55%, transparent 85%);
            transform:translateX(-100%); pointer-events:none; opacity:0; z-index:1;
        }
        .ar-card.is-turbo-activating::before{
            opacity:1; animation:ar-card-sweep .55s cubic-bezier(.22, 1, .36, 1) forwards;
        }
        @keyframes ar-card-sweep{
            0%{ transform:translateX(-100%); opacity:0; }
            25%{ opacity:1; }
            75%{ opacity:1; }
            100%{ transform:translateX(100%); opacity:0; }
        }

        /* Сегмент-контрол пресетов темпа: 4 колонки строго одинаковой ширины */
        .ar-seg{
            display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:2px;
            background:var(--bg-2); border-radius:var(--r-md); padding:3px;
            position:relative; overflow:hidden;
        }
        /* Phase 3a: Тонкая красная линия селектора, пробегающая от Turbo влево */
        .ar-seg-line{
            position:absolute; bottom:0; left:0; height:2px; width:100%;
            background:linear-gradient(90deg, #ff334b, #d6001c, #991b1b);
            transform:scaleX(0); transform-origin:right center; pointer-events:none; z-index:3; opacity:0;
        }
        .ar-seg-line.is-active{
            opacity:1; animation:ar-seg-line-sweep .55s cubic-bezier(.22, 1, .36, 1) forwards;
        }
        @keyframes ar-seg-line-sweep{
            0%{ transform:scaleX(0); transform-origin:right center; opacity:1; }
            45%{ transform:scaleX(1); transform-origin:right center; opacity:1; }
            50%{ transform:scaleX(1); transform-origin:left center; opacity:1; }
            100%{ transform:scaleX(0); transform-origin:left center; opacity:0; }
        }

        .ar-seg-btn{
            min-width:0; border:none; background:transparent; border-radius:6px;
            padding:6px 2px; font-family:inherit; font-size:11px; font-weight:600;
            color:var(--ink-2); cursor:pointer; white-space:nowrap; text-align:center;
            transition:background .15s, color .15s, box-shadow .15s;
            position:relative; overflow:hidden; text-overflow:ellipsis;
        }
        .ar-seg-btn:hover{ color:var(--ink); }
        .ar-seg-btn.is-active{ background:var(--card); color:var(--ink); box-shadow:0 1px 3px rgba(15,23,42,.1); }

        /* Phase 1: Постоянный активный Turbo state: dark graphite surface + white label + red ↯ */
        .ar-seg-btn--turbo{ font-weight:700; }
        .ar-seg-btn--turbo .ar-turbo-icon{
            display:inline-block; margin-right:1px; color:var(--hh-red); font-size:11px;
            vertical-align:baseline; font-weight:800;
        }
        .ar-seg-btn--turbo.is-active{
            background:#1e293b; color:#ffffff; box-shadow:0 1px 3px rgba(15,23,42,.22), inset 0 0 0 1px rgba(255,255,255,.08);
        }
        .ar-seg-btn--turbo.is-active .ar-turbo-icon{
            color:#ff334b;
        }
        .ar-seg-btn--turbo::after{
            content:''; position:absolute; top:0; left:0; width:100%; height:100%;
            background:linear-gradient(90deg, transparent 0%, rgba(255,255,255,.28) 50%, transparent 100%);
            transform:translateX(-100%); pointer-events:none; opacity:0;
        }
        .ar-seg-btn--turbo.is-activating::after{
            opacity:1; animation:ar-turbo-shimmer .45s cubic-bezier(.22, 1, .36, 1) forwards;
        }
        @keyframes ar-turbo-shimmer{
            0%{ transform:translateX(-100%); opacity:0; }
            30%{ opacity:1; }
            100%{ transform:translateX(100%); opacity:0; }
        }

        /* Subtle Progress highlight in Turbo */
        .ar-progress.is-turbo i::after{
            content:''; position:absolute; top:0; left:0; width:100%; height:100%;
            background:linear-gradient(90deg, transparent 0%, rgba(255,255,255,.2) 50%, transparent 100%);
            transform:translateX(-100%); animation:ar-turbo-prog 2.6s infinite ease-in-out;
            pointer-events:none; will-change:transform;
        }
        @keyframes ar-turbo-prog{
            0%{ transform:translateX(-100%); }
            100%{ transform:translateX(100%); }
        }

        @media (prefers-reduced-motion: reduce){
            .ar-seg-line, .ar-seg-btn--turbo::after, .ar-progress.is-turbo i::after, .ar-card::before, .ar-flow-line, #ar-main-panel{ animation:none !important; }
        }

        .ar-preset-hint{
            font-size:11.5px; line-height:1.45; color:var(--ink-2);
            background:var(--bg); border:1px solid var(--line); border-radius:var(--r-md); padding:8px 10px;
        }

        /* Строка подпись + контрол */
        .ar-row{ display:flex; align-items:center; justify-content:space-between; gap:10px; }
        .ar-row-label{ flex:1; min-width:0; font-size:12.5px; font-weight:500; color:var(--ink-2); line-height:1.4; }
        .ar-row-limit{ padding-top:8px; border-top:1px solid var(--line-2); }

        /* Поле ввода */
        .ar-input{
            border:1px solid var(--line); background:var(--card); border-radius:6px;
            padding:6px 10px; font-family:inherit; font-size:13px; font-weight:700;
            color:var(--ink); transition:border-color .15s, box-shadow .15s;
            outline:none;
        }
        .ar-input:focus{ border-color:var(--hh-blue); box-shadow:0 0 0 3px var(--hh-blue-soft); }
        .ar-input:hover:not(:focus){ border-color:#cbd5e1; }
        .ar-input-num{ width:72px; height:32px; flex:none; text-align:center; }
        .ar-input[type=number]{ -moz-appearance:textfield; appearance:textfield; }
        .ar-input[type=number]::-webkit-outer-spin-button,
        .ar-input[type=number]::-webkit-inner-spin-button{ -webkit-appearance:none; margin:0; }

        /* Textarea сопроводительного письма (компактная по умолчанию) */
        .ar-textarea{
            width:100%; border:1px solid var(--line); background:var(--card);
            border-radius:var(--r-md); padding:7px 10px; resize:vertical; font-family:inherit;
            font-size:12px; color:var(--ink); line-height:1.45; min-height:56px;
            transition:border-color .15s, box-shadow .15s, opacity .15s;
        }
        .ar-textarea:focus{ outline:none; border-color:var(--hh-blue); box-shadow:0 0 0 3px var(--hh-blue-soft); }
        .ar-textarea:hover:not(:focus){ border-color:#cbd5e1; }
        .ar-textarea::placeholder{ color:var(--ink-3); }
        .ar-textarea:disabled{ opacity:.6; background:var(--bg); cursor:not-allowed; resize:none; border-color:var(--line-2); }
        .ar-cover-footer{ display:flex; justify-content:flex-end; font-size:10.5px; color:var(--ink-3); font-variant-numeric:tabular-nums; }
        .ar-cover-counter.is-near{ color:#b26a00; font-weight:700; }
        .ar-cover-counter.is-off{ visibility:hidden; }

        /* Переключатели (switch) */
        .ar-switch-row{ display:flex; align-items:center; justify-content:space-between; gap:10px; cursor:pointer; user-select:none; }
        .ar-switch-row-sub{ padding-top:2px; }
        .ar-switch{ position:relative; display:inline-block; width:36px; height:20px; flex:none; }
        .ar-switch input{ position:absolute; opacity:0; width:100%; height:100%; margin:0; cursor:pointer; z-index:1; }
        .ar-switch i{
            display:block; width:100%; height:100%; border-radius:999px;
            background:#cbd5e1; transition:background .2s ease; pointer-events:none;
        }
        .ar-switch i::after{
            content:''; position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%;
            background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.2); transition:transform .2s ease;
        }
        .ar-switch input:checked + i{ background:var(--hh-green); }
        .ar-switch input:checked + i::after{ transform:translateX(16px); }
        .ar-switch input:focus-visible + i{ box-shadow:0 0 0 3px var(--hh-blue-soft); }

        /* Кнопки */
        .ar-btn{
            display:inline-flex; align-items:center; justify-content:center; gap:6px;
            border:none; border-radius:var(--r-md); padding:0 14px; min-height:34px;
            font-family:inherit; font-size:12.5px; font-weight:600; line-height:1.15; cursor:pointer;
            white-space:nowrap; transition:all .15s ease;
        }
        .ar-btn:active{ transform:translateY(1px); }
        .ar-btn:disabled{ opacity:.45; cursor:not-allowed; }
        .ar-btn:disabled:active{ transform:none; }

        /* Доминантная главная кнопка CTA */
        .ar-btn-cta{
            width:100%; height:40px; font-size:13.5px; font-weight:700;
            border-radius:9px; box-shadow:0 2px 4px rgba(0,112,229,.18);
        }
        .ar-btn-primary{ background:var(--hh-blue); color:#fff; }
        .ar-btn-primary:hover{ background:var(--hh-blue-hover); box-shadow:0 4px 10px rgba(0,112,229,.26); }
        .ar-btn-danger{ background:var(--hh-red); color:#fff; box-shadow:0 2px 4px rgba(214,0,28,.2); }
        .ar-btn-danger:hover{ background:var(--hh-red-hover); box-shadow:0 4px 10px rgba(214,0,28,.3); }
        .ar-btn-soft{ background:var(--bg); color:var(--ink-2); border:1px solid var(--line); }
        .ar-btn-soft:hover{ background:var(--bg-2); color:var(--ink); border-color:#cbd5e1; }
        .ar-btn-tertiary{ background:transparent; color:var(--ink-3); border:1px dashed var(--line); }
        .ar-btn-tertiary:hover{ background:var(--bg-2); color:var(--ink-2); border-color:#cbd5e1; }
        .ar-btn-ghost{ background:transparent; border:none; color:var(--ink-3); padding:0 6px; }
        .ar-btn-ghost:hover{ background:var(--bg-2); color:var(--ink-2); }
        .ar-btn-full{ width:100%; justify-content:center; }
        .ar-btn-sm{ min-height:28px; padding:0 10px; font-size:11.5px; border-radius:6px; }

        /* Вторичная строка утилит (understated) */
        .ar-util-row{ display:flex; align-items:center; justify-content:space-between; gap:8px; }
        .ar-util-btn{ flex:1 1 0; min-width:0; height:30px; font-size:11.5px; }

        /* Полоса прогресса */
        .ar-progress{
            height:5px; border-radius:999px; background:var(--bg-2);
            overflow:hidden; position:relative;
        }
        .ar-progress i{
            display:block; height:100%; width:0; border-radius:999px;
            background:linear-gradient(90deg, #0070e5, #059669); transition:width .3s ease;
            position:relative; overflow:hidden;
        }

        /* Плитки статистики с нейтральным zero-state */
        .ar-stats{ display:grid; grid-template-columns:repeat(4,1fr); gap:6px; }
        .ar-stat{
            display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;
            padding:7px 4px; border-radius:var(--r-md); background:var(--bg);
            border:1px solid var(--line); min-width:0; text-align:center; transition:all .2s ease;
        }
        .ar-stat-num{ font-size:16px; font-weight:800; line-height:1.1; color:var(--ink-3); font-variant-numeric:tabular-nums; }
        .ar-stat-cap{ font-size:9.5px; font-weight:600; color:var(--ink-3); letter-spacing:.01em; }
        .ar-stat.is-active-success{ background:var(--hh-green-soft); border-color:#a7f3d0; }
        .ar-stat.is-active-success .ar-stat-num{ color:var(--hh-green); }
        .ar-stat.is-active-manual{ background:var(--hh-blue-soft); border-color:#bfdbfe; }
        .ar-stat.is-active-manual .ar-stat-num{ color:var(--hh-blue); }
        .ar-stat.is-active-skip{ background:var(--bg-2); border-color:#cbd5e1; }
        .ar-stat.is-active-skip .ar-stat-num{ color:var(--ink-2); }
        .ar-stat.is-active-attempts .ar-stat-num{ color:var(--ink); }

        /* Бейджи и счётчики */
        .ar-badge{
            display:inline-flex; align-items:center; justify-content:center; min-width:18px; height:18px;
            padding:0 6px; font-size:10.5px; font-weight:700; border-radius:999px;
            background:var(--bg-2); color:var(--ink-2); transition:all .15s ease;
        }
        .ar-badge--neutral{ background:var(--bg-2); color:var(--ink-2); border:1px solid var(--line); }
        .ar-badge--error{ background:var(--hh-red-soft); color:var(--hh-red); border:1px solid #fecaca; }
        .ar-badge--info{ background:var(--hh-blue-soft); color:var(--hh-blue); }
        .ar-card-head{ display:flex; align-items:center; justify-content:space-between; gap:8px; }
        .ar-title-with-count{ display:inline-flex; align-items:center; gap:6px; }

        /* Ручная очередь (без вложенного скролла) */
        .ar-manual{ display:flex; flex-direction:column; gap:7px; }
        .ar-manual-item{
            display:flex; align-items:center; justify-content:space-between; gap:8px; padding:7px 10px;
            border:1px solid var(--line); background:var(--bg); border-radius:var(--r-md);
            transition:all .15s ease;
        }
        .ar-manual-item:hover{ border-color:#cbd5e1; background:#ffffff; }
        .ar-manual-main{ flex:1 1 0; min-width:0; }
        .ar-manual-meta{ font-size:9.5px; color:var(--ink-3); margin-bottom:1px; display:flex; align-items:center; gap:4px; min-width:0; }
        .ar-manual-meta .ar-when{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .ar-vid{ font-weight:600; color:var(--ink-3); flex:none; }
        .ar-manual-title{
            font-size:12px; font-weight:600; color:var(--ink);
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:1.35;
        }
        .ar-manual-title.is-empty{ font-weight:400; color:var(--ink-3); }
        .ar-manual-actions{ display:flex; align-items:center; gap:4px; flex:none; margin-left:auto; }
        .ar-btn-open{ height:26px; padding:0 8px; font-size:11px; font-weight:600; background:var(--hh-blue-soft); color:var(--hh-blue); border:none; }
        .ar-btn-open:hover{ background:var(--hh-blue); color:#fff; }
        .ar-icon-del{
            width:24px; height:24px; min-height:24px; padding:0; background:transparent; border:none;
            color:var(--ink-3); border-radius:5px; display:flex; align-items:center; justify-content:center;
        }
        .ar-icon-del:hover{ background:var(--hh-red-soft); color:var(--hh-red); }
        .ar-queue-more-btn{ width:100%; height:30px; font-size:11.5px; font-weight:600; margin-top:2px; }
        .ar-empty{
            text-align:center; color:var(--ink-3); font-size:11.5px; padding:14px 10px;
            background:var(--bg); border:1px dashed var(--line); border-radius:var(--r-md);
            line-height:1.4;
        }

        /* Диагностика */
        .ar-summary{ display:flex; align-items:center; justify-content:space-between; cursor:pointer; list-style:none; user-select:none; padding:2px 0; }
        .ar-summary::-webkit-details-marker{ display:none; }
        .ar-summary-title{ display:flex; align-items:center; gap:6px; font-size:12px; font-weight:700; color:var(--ink); text-transform:uppercase; letter-spacing:.03em; }
        .ar-summary-title::before{ content:'▸'; color:var(--ink-3); font-size:11px; transition:transform .15s; }
        .ar-details[open] .ar-summary-title::before{ transform:rotate(90deg); }
        .ar-details-body{ margin-top:8px; display:flex; flex-direction:column; gap:8px; }
        .ar-details:not([open]) .ar-details-body{ display:none; }
        .ar-log-tools{ display:flex; gap:6px; }
        .ar-log-tools .ar-btn{ flex:1 1 0; min-width:0; }
        .ar-log-tools--sub{ align-items:center; justify-content:space-between; }
        .ar-inline-check{ display:inline-flex; align-items:center; gap:6px; font-size:11.5px; color:var(--ink-2); cursor:pointer; user-select:none; }
        .ar-inline-check input{ cursor:pointer; }
        #ar-log-box{
            min-height:40px; overflow:hidden; background:#0f172a; color:#94a3b8; border-radius:var(--r-md);
            font-family:'SFMono-Regular',ui-monospace,Menlo,Consolas,monospace; font-size:10.5px;
            padding:8px 10px; line-height:1.5; border:1px solid #1e293b;
            display:flex; flex-direction:column; gap:2px;
        }
        #ar-log-box .ar-log-err, .ar-diag-full-box .ar-log-err{ color:#f87171; }
        .ar-log-line{ word-break:break-word; white-space:pre-wrap; }

        /* Выпадающее меню действий */
        .ar-dropdown{ position:relative; display:inline-block; }
        .ar-dropdown-menu{
            display:none; position:absolute; right:0; top:calc(100% + 4px);
            background:var(--card); border:1px solid var(--line); border-radius:var(--r-md);
            box-shadow:0 4px 12px rgba(15,23,42,.12); min-width:180px; z-index:100;
            padding:4px; flex-direction:column; gap:2px;
        }
        .ar-dropdown.is-open .ar-dropdown-menu{ display:flex; }
        .ar-dropdown-item{
            display:flex; align-items:center; width:100%; padding:6px 10px;
            font-size:11.5px; font-weight:500; color:var(--ink-2);
            background:transparent; border:none; border-radius:4px;
            text-align:left; cursor:pointer; transition:background .12s, color .12s;
        }
        .ar-dropdown-item:hover{ background:var(--bg-2); color:var(--ink); }
        .ar-dropdown-item--danger{ color:var(--hh-red); }
        .ar-dropdown-item--danger:hover{ background:var(--hh-red-soft); color:var(--hh-red-hover); }

        @media (max-width:700px){
            html.hh-ar-open{ margin-right:0 !important; }
            #ar-main-panel{ width:min(410px,94vw); }
        }

        @media (prefers-reduced-motion: reduce){
            #ar-main-panel *, #ar-toggle-btn, #ar-toggle-btn *{ animation:none !important; transition:none !important; }
            html.hh-ar-anim{ transition:none !important; }
        }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    // ─────────────────────────────────────────────────────────────
    //  13. UI: ПАНЕЛЬ (applomat Redesign)
    // ─────────────────────────────────────────────────────────────

    function buildPanelHtml() {
        const presetButtons = Object.entries(PRESETS).map(([key, p]) =>
            `<button type="button" class="ar-seg-btn${key === 'turbo' ? ' ar-seg-btn--turbo' : ''}" data-preset="${key}" role="radio" aria-checked="false">${key === 'turbo' ? '<span class="ar-turbo-icon">↯</span> ' : ''}${p.label}</button>`
        ).join('');

        return `
            <div id="ar-view-main" class="ar-view ar-view--main">
                <div class="ar-flow-line" id="ar-flow-line"></div>
                <div class="ar-header">
                    <div class="ar-brand">
                        <span class="ar-title">applomat</span>
                        <span class="ar-sub">v${VERSION}</span>
                    </div>
                    <div class="ar-header-right">
                        <span id="ar-status-text" class="ar-status ar-status--idle" role="status" aria-live="polite">Ожидание</span>
                        <button id="ar-minimize-btn" class="ar-icon-btn" title="Свернуть панель" aria-label="Свернуть панель">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>
                        </button>
                    </div>
                </div>

                <div class="ar-scroll">
                    <section class="ar-card" id="ar-mode-card">
                        <div class="ar-card-title">Режим работы</div>
                        <div class="ar-seg" id="ar-preset-seg" role="radiogroup" aria-label="Темп откликов">
                            ${presetButtons}
                            <span class="ar-seg-line" id="ar-seg-line" aria-hidden="true"></span>
                        </div>
                        <div class="ar-preset-hint" id="ar-preset-hint"></div>
                        <div class="ar-row ar-row-limit">
                            <label class="ar-row-label" for="ar-limit-input">Лимит откликов за запуск</label>
                            <input type="number" id="ar-limit-input" class="ar-input ar-input-num" min="1" max="500">
                        </div>
                    </section>

                    <section class="ar-card">
                        <label class="ar-switch-row" for="ar-use-cover-check">
                            <span class="ar-card-title" style="margin:0;">Сопроводительное письмо</span>
                            <span class="ar-switch"><input type="checkbox" id="ar-use-cover-check"><i></i></span>
                        </label>
                        <textarea id="ar-cover-text" class="ar-textarea" rows="2" maxlength="5000" placeholder="Текст сопроводительного письма..."></textarea>
                        <div class="ar-cover-footer">
                            <span id="ar-cover-counter" class="ar-cover-counter">0 / 5000</span>
                        </div>
                        <label class="ar-switch-row ar-switch-row-sub" for="ar-apply-reject-check" title="Дожимать отклик на вакансиях, где hh предупреждает о вероятном отказе">
                            <span class="ar-row-label" style="font-size:12px;">Откликаться несмотря на предупреждение</span>
                            <span class="ar-switch"><input type="checkbox" id="ar-apply-reject-check"><i></i></span>
                        </label>
                    </section>

                    <section class="ar-card">
                        <button id="ar-start-btn" class="ar-btn ar-btn-primary ar-btn-cta">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                            <span>Запустить отклики</span>
                        </button>
                        <button id="ar-stop-btn" class="ar-btn ar-btn-danger ar-btn-cta" style="display:none;">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                            <span>Остановить (Стоп)</span>
                        </button>
                        <div class="ar-util-row">
                            <button id="ar-reset-history" class="ar-btn ar-btn-tertiary ar-btn-sm ar-util-btn" title="Сбросить историю отправленных откликов и статистику">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                                <span>Сбросить историю</span>
                            </button>
                            <button id="ar-health-btn" class="ar-btn ar-btn-soft ar-btn-sm ar-util-btn" title="Проверить селекторы и открыть диагностику">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                                <span>Диагностика</span>
                            </button>
                        </div>
                    </section>

                    <section class="ar-card">
                        <div class="ar-card-head">
                            <div class="ar-card-title">Статистика запуска</div>
                            <span id="ar-stat-progress" class="ar-badge" title="Отправлено откликов из лимита за запуск">0 / 0</span>
                        </div>
                        <div class="ar-progress" aria-hidden="true"><i id="ar-progress-fill"></i></div>
                        <div class="ar-stats">
                            <div class="ar-stat" id="ar-stat-tile-attempts">
                                <span class="ar-stat-num" id="ar-stat-attempts">0</span>
                                <span class="ar-stat-cap">Попыток</span>
                            </div>
                            <div class="ar-stat" id="ar-stat-tile-success">
                                <span class="ar-stat-num" id="ar-stat-success">0</span>
                                <span class="ar-stat-cap">Успешно</span>
                            </div>
                            <div class="ar-stat" id="ar-stat-tile-manual">
                                <span class="ar-stat-num" id="ar-stat-manual">0</span>
                                <span class="ar-stat-cap">В ручной</span>
                            </div>
                            <div class="ar-stat" id="ar-stat-tile-skip">
                                <span class="ar-stat-num" id="ar-stat-skipped">0</span>
                                <span class="ar-stat-cap">Пропущено</span>
                            </div>
                        </div>
                    </section>

                    <section class="ar-card">
                        <div class="ar-card-head">
                            <div class="ar-title-with-count">
                                <span class="ar-card-title">Ручная очередь</span>
                                <span id="ar-manual-count" class="ar-badge" data-has="0" title="Сохранено вакансий для ручного отклика">0</span>
                            </div>
                            <div style="display:flex; gap:6px;">
                                <button id="ar-export-manual" class="ar-btn ar-btn-soft ar-btn-sm">Экспорт</button>
                                <button id="ar-clear-manual" class="ar-btn ar-btn-soft ar-btn-sm">Очистить</button>
                            </div>
                        </div>
                        <div id="ar-manual-list" class="ar-manual"></div>
                    </section>

                    <section class="ar-card">
                        <details class="ar-details" id="ar-diag-details">
                            <summary class="ar-summary">
                                <div class="ar-summary-title">Диагностика</div>
                                <span id="ar-diag-count" class="ar-badge ar-badge--neutral" title="Записей в логе">0</span>
                            </summary>
                            <div class="ar-details-body">
                                <div class="ar-log-tools">
                                    <button id="ar-diag-check-btn" class="ar-btn ar-btn-soft ar-btn-sm" style="flex:1;">Проверить селекторы</button>
                                    <button id="ar-save-logs" class="ar-btn ar-btn-soft ar-btn-sm" style="flex:1;">Скачать лог</button>
                                </div>
                                <div class="ar-log-tools ar-log-tools--sub">
                                    <label class="ar-inline-check" for="ar-log-errors-only">
                                        <input type="checkbox" id="ar-log-errors-only">
                                        <span>Только ошибки</span>
                                    </label>
                                    <div class="ar-dropdown" id="ar-diag-more-dropdown">
                                        <button id="ar-diag-more-btn" class="ar-btn ar-btn-ghost ar-btn-sm" type="button" title="Дополнительные действия">
                                            <span>Дополнительно</span>
                                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
                                        </button>
                                        <div class="ar-dropdown-menu" id="ar-diag-more-menu">
                                            <button id="ar-clear-log" class="ar-dropdown-item" type="button">Очистить вид</button>
                                            <button id="ar-clear-diag" class="ar-dropdown-item ar-dropdown-item--danger" type="button">Очистить сохр. лог и метрики</button>
                                        </div>
                                    </div>
                                </div>
                                <div id="ar-log-box"></div>
                                <button id="ar-open-full-diag-btn" class="ar-btn ar-btn-tertiary ar-btn-sm ar-btn-full" type="button">
                                    <span>Показать весь лог →</span>
                                </button>
                            </div>
                        </details>
                    </section>
                </div>
            </div>

            <div id="ar-view-diag" class="ar-view ar-view--diag" style="display:none;">
                <div class="ar-header">
                    <div class="ar-diag-nav">
                        <button id="ar-diag-back-btn" class="ar-btn ar-btn-soft ar-btn-sm ar-btn-back" type="button" title="Вернуться в основную панель">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
                            <span>Назад</span>
                        </button>
                        <span class="ar-diag-view-title">Диагностика</span>
                    </div>
                    <div class="ar-header-right">
                        <button id="ar-diag-full-save" class="ar-btn ar-btn-soft ar-btn-sm" type="button" title="Скачать полный диагностический отчет">Скачать лог</button>
                        <button id="ar-minimize-diag-btn" class="ar-icon-btn" title="Свернуть панель" aria-label="Свернуть панель">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>
                        </button>
                    </div>
                </div>
                <div class="ar-diag-body">
                    <div class="ar-diag-toolbar">
                        <label class="ar-inline-check" for="ar-diag-full-errors-only">
                            <input type="checkbox" id="ar-diag-full-errors-only">
                            <span>Только ошибки</span>
                        </label>
                        <div style="display:flex; align-items:center; gap:6px;">
                            <span id="ar-diag-full-stat" class="ar-diag-stat">Всего: 0</span>
                            <button id="ar-diag-full-check" class="ar-btn ar-btn-soft ar-btn-sm" type="button" title="Проверить селекторы">Селекторы</button>
                            <div class="ar-dropdown" id="ar-diag-full-dropdown">
                                <button id="ar-diag-full-more-btn" class="ar-btn ar-btn-ghost ar-btn-sm" type="button" title="Действия">⋯</button>
                                <div class="ar-dropdown-menu" id="ar-diag-full-menu">
                                    <button id="ar-diag-full-clear-box" class="ar-dropdown-item" type="button">Очистить вид</button>
                                    <button id="ar-diag-full-clear-all" class="ar-dropdown-item ar-dropdown-item--danger" type="button">Очистить сохр. лог и метрики</button>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div id="ar-diag-full-box" class="ar-diag-full-box"></div>
                </div>
            </div>
        `;
    }

    // ─────────────────────────────────────────────────────────────
    //  13. UI: ПАНЕЛЬ (applomat Redesign & Lifecycle Controller)
    // ─────────────────────────────────────────────────────────────

    let uiAbortController = null;
    let uiDiagTimer = null;
    let uiStatsTimer = null;

    function cleanupUI() {
        if (uiDiagTimer) { clearInterval(uiDiagTimer); uiDiagTimer = null; }
        if (uiStatsTimer) { clearInterval(uiStatsTimer); uiStatsTimer = null; }
        if (uiAbortController) {
            try { uiAbortController.abort(); } catch (e) { /* ignore */ }
            uiAbortController = null;
        }
        const oldToggle = document.getElementById('ar-toggle-btn');
        if (oldToggle) oldToggle.remove();
        const oldPanel = document.getElementById('ar-main-panel');
        if (oldPanel) oldPanel.remove();
    }

    function setupUI() {
        if (document.getElementById('ar-main-panel')) return;
        if (!document.body) return;

        cleanupUI();
        uiAbortController = new AbortController();
        const uiSignal = uiAbortController.signal;

        injectPanelStyles();

        // Свёрнутое состояние - вертикальная вкладка applomat
        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'ar-toggle-btn';
        toggleBtn.type = 'button';
        toggleBtn.innerHTML = `
            <span class="ar-tab-dot" aria-hidden="true"></span>
            <span class="ar-tab-text">applomat</span>
        `;
        toggleBtn.title = 'Развернуть applomat';
        toggleBtn.setAttribute('aria-label', 'Развернуть applomat');
        toggleBtn.style.display = 'none';
        document.body.appendChild(toggleBtn);

        const panel = document.createElement('div');
        panel.id = 'ar-main-panel';
        panel.innerHTML = buildPanelHtml();
        document.body.appendChild(panel);

        const el = (id) => document.getElementById(id);

        // ---------- Начальные значения из конфига ----------
        el('ar-cover-text').value = config.coverText;
        el('ar-use-cover-check').checked = config.useCover;
        el('ar-apply-reject-check').checked = config.applyOnRejectWarning;
        el('ar-limit-input').value = config.limit;
        setStatus(State.amIRunning() ? 'running' : 'idle');

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
        coverArea.addEventListener('input', renderCoverState);
        el('ar-use-cover-check').addEventListener('change', renderCoverState);
        renderCoverState();

        // ---------- Пресеты темпа ----------
        const presetSeg = el('ar-preset-seg');
        const presetHint = el('ar-preset-hint');

        let turboActivationSeq = 0;
        let turboTimers = [];

        const clearAllTurboTimers = () => {
            turboTimers.forEach(t => clearTimeout(t));
            turboTimers = [];
        };

        const cancelTurboActivation = () => {
            turboActivationSeq++;
            clearAllTurboTimers();

            const p = el('ar-main-panel');
            const modeCard = el('ar-mode-card');
            const turboLine = el('ar-seg-line');
            const flowLine = el('ar-flow-line');
            const statusText = el('ar-status-text');

            p?.classList.remove('is-turbo-activating');
            modeCard?.classList.remove('is-turbo-activating');
            turboLine?.classList.remove('is-active');
            flowLine?.classList.remove('is-turbo-activating');
            qa('.ar-seg-btn--turbo', presetSeg).forEach(b => b.classList.remove('is-activating'));

            if (statusText && statusText.classList.contains('ar-status--turbo-confirm')) {
                statusText.classList.remove('ar-status--turbo-confirm');
                setStatus(State.amIRunning() ? 'running' : 'idle');
            }
        };

        const triggerTurboActivation = () => {
            cancelTurboActivation();

            const isReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            const mySeq = ++turboActivationSeq;
            const statusText = el('ar-status-text');

            if (isReducedMotion) {
                if (!State.amIRunning() && statusText) {
                    statusText.textContent = '↯ Турбо включён';
                    statusText.classList.add('ar-status--turbo-confirm');
                    const tid = setTimeout(() => {
                        if (mySeq !== turboActivationSeq || config?.preset !== 'turbo') return;
                        if (!State.amIRunning() && statusText) {
                            statusText.textContent = STATUS_TEXT.idle;
                            statusText.classList.remove('ar-status--turbo-confirm');
                        }
                    }, 1000);
                    turboTimers.push(tid);
                }
                return;
            }

            const p = el('ar-main-panel');
            const modeCard = el('ar-mode-card');
            const turboLine = el('ar-seg-line');
            const flowLine = el('ar-flow-line');
            const turboBtn = qa('.ar-seg-btn--turbo', presetSeg)[0];

            void modeCard?.offsetWidth; // reflow

            p?.classList.add('is-turbo-activating');
            modeCard?.classList.add('is-turbo-activating');
            turboLine?.classList.add('is-active');
            flowLine?.classList.add('is-turbo-activating');
            turboBtn?.classList.add('is-activating');

            if (!State.amIRunning() && statusText) {
                statusText.textContent = '↯ Турбо включён';
                statusText.classList.add('ar-status--turbo-confirm');
                const confirmTid = setTimeout(() => {
                    if (mySeq !== turboActivationSeq || config?.preset !== 'turbo') return;
                    if (!State.amIRunning() && statusText) {
                        statusText.textContent = STATUS_TEXT.idle;
                        statusText.classList.remove('ar-status--turbo-confirm');
                    }
                }, 1000);
                turboTimers.push(confirmTid);
            }

            const animTid = setTimeout(() => {
                if (mySeq !== turboActivationSeq) return;
                p?.classList.remove('is-turbo-activating');
                modeCard?.classList.remove('is-turbo-activating');
                turboLine?.classList.remove('is-active');
                flowLine?.classList.remove('is-turbo-activating');
                turboBtn?.classList.remove('is-activating');
            }, 650);
            turboTimers.push(animTid);
        };

        const renderPreset = () => {
            const active = PRESETS[config.preset] ? config.preset : DEFAULT_PRESET;
            qa('.ar-seg-btn', presetSeg).forEach(btn => {
                const isActive = btn.dataset.preset === active;
                btn.classList.toggle('is-active', isActive);
                btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
                btn.tabIndex = isActive ? 0 : -1;
            });
            if (presetHint) presetHint.textContent = (PRESETS[active] || PRESETS[DEFAULT_PRESET]).hint;
        };

        const selectPreset = (key, { focus = false } = {}) => {
            if (!PRESETS[key] || config.preset === key) return;
            const wasTurbo = config.preset === 'turbo';
            const isEnteringTurbo = key === 'turbo' && !wasTurbo;

            // Немедленная отмена всех предыдущих эффектов Turbo и таймеров
            cancelTurboActivation();

            config.preset = key;
            Settings.save(config);
            renderPreset();
            if (focus) qa('.ar-seg-btn', presetSeg).find(b => b.dataset.preset === key)?.focus();

            if (State.amIRunning()) {
                setStatus('running');
            }

            // Фирменный эффект активации повышенной мощности Турбо
            if (isEnteringTurbo) {
                triggerTurboActivation();
            }

            log(`Режим работы: ${key === 'turbo' ? '↯ ' : ''}${PRESETS[config.preset].label}.`);
        };

        if (presetSeg) {
            presetSeg.addEventListener('click', (e) => {
                const btn = e.target.closest('.ar-seg-btn');
                if (btn) selectPreset(btn.dataset.preset);
            });
            presetSeg.addEventListener('keydown', (e) => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
                e.preventDefault();
                const keys = Object.keys(PRESETS);
                const cur = keys.indexOf(PRESETS[config.preset] ? config.preset : DEFAULT_PRESET);
                const dir = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
                selectPreset(keys[(cur + dir + keys.length) % keys.length], { focus: true });
            });
        }
        renderPreset();

        // ---------- Сохранение настроек ----------
        const saveSettings = () => {
            config = Settings.normalize({
                ...config,
                coverText: el('ar-cover-text').value,
                useCover: el('ar-use-cover-check').checked,
                applyOnRejectWarning: el('ar-apply-reject-check').checked,
                limit: el('ar-limit-input').value
            });
            el('ar-limit-input').value = config.limit;
            Settings.save(config);
            log('Настройки сохранены.');
        };
        ['ar-cover-text', 'ar-use-cover-check', 'ar-apply-reject-check', 'ar-limit-input']
            .forEach(id => { const node = el(id); if (node) node.addEventListener('change', saveSettings); });

        // ---------- Лог и диагностика ----------
        const initInlineLogs = () => {
            const box = el('ar-log-box');
            if (!box) return;
            box.innerHTML = '';
            const all = DiagLog.getAll();
            const latest = all.slice(-MAX_INLINE_LOG_ENTRIES);
            const filterErr = el('ar-log-errors-only')?.checked;
            latest.forEach(item => {
                const isErr = item.lvl === 'ERR';
                if (filterErr && !isErr) return;
                const line = document.createElement('div');
                line.className = 'ar-log-line' + (isErr ? ' ar-log-err' : '');
                const time = new Date(item.t || Date.now()).toLocaleTimeString('ru-RU');
                line.textContent = `[${time}] ${item.msg}`;
                line.dataset.error = isErr ? '1' : '0';
                box.appendChild(line);
            });
        };

        const applyLogFilter = () => {
            const box = el('ar-log-box');
            const chk = el('ar-log-errors-only');
            if (!box || !chk) return;
            Array.from(box.children).forEach(child => {
                child.style.display = (chk.checked && child.dataset.error !== '1') ? 'none' : 'block';
            });
        };
        const errChk = el('ar-log-errors-only');
        if (errChk) errChk.onchange = () => {
            applyLogFilter();
            initInlineLogs();
        };

        initInlineLogs();

        const clearLogBtn = el('ar-clear-log');
        if (clearLogBtn) clearLogBtn.onclick = () => {
            const box = el('ar-log-box');
            if (box) box.innerHTML = '';
            el('ar-diag-more-dropdown')?.classList.remove('is-open');
        };

        // Переключение между основным видом и экраном диагностики
        const openFullDiag = () => {
            const viewMain = el('ar-view-main');
            const viewDiag = el('ar-view-diag');
            if (!viewMain || !viewDiag) return;
            viewMain.style.display = 'none';
            viewDiag.style.display = 'flex';
            renderFullDiag();
        };

        const closeFullDiag = () => {
            const viewMain = el('ar-view-main');
            const viewDiag = el('ar-view-diag');
            if (!viewMain || !viewDiag) return;
            viewDiag.style.display = 'none';
            viewMain.style.display = 'flex';
        };

        function renderFullDiag() {
            const fullBox = el('ar-diag-full-box');
            if (!fullBox) return;
            fullBox.innerHTML = '';
            const all = DiagLog.getAll();
            const filterErr = el('ar-diag-full-errors-only')?.checked;

            all.forEach(item => {
                const isErr = item.lvl === 'ERR';
                if (filterErr && !isErr) return;
                const line = document.createElement('div');
                line.className = 'ar-log-line' + (isErr ? ' ar-log-err' : '');
                const time = new Date(item.t || Date.now()).toLocaleTimeString('ru-RU');
                line.textContent = `[${time}] ${item.msg}`;
                line.dataset.error = isErr ? '1' : '0';
                fullBox.appendChild(line);
            });
            fullBox.scrollTop = fullBox.scrollHeight;
            updateDiagCount();
        }

        const openFullBtn = el('ar-open-full-diag-btn');
        if (openFullBtn) openFullBtn.onclick = openFullDiag;

        const backBtn = el('ar-diag-back-btn');
        if (backBtn) backBtn.onclick = closeFullDiag;

        const diagFullErrChk = el('ar-diag-full-errors-only');
        if (diagFullErrChk) diagFullErrChk.onchange = renderFullDiag;

        const diagFullClearBox = el('ar-diag-full-clear-box');
        if (diagFullClearBox) diagFullClearBox.onclick = () => {
            const fullBox = el('ar-diag-full-box');
            if (fullBox) fullBox.innerHTML = '';
            el('ar-diag-full-dropdown')?.classList.remove('is-open');
        };

        // Dropdowns setup
        const setupDropdown = (btnId, dropdownId) => {
            const btn = el(btnId);
            const dropdown = el(dropdownId);
            if (!btn || !dropdown) return;
            btn.onclick = (e) => {
                e.stopPropagation();
                dropdown.classList.toggle('is-open');
            };
        };
        setupDropdown('ar-diag-more-btn', 'ar-diag-more-dropdown');
        setupDropdown('ar-diag-full-more-btn', 'ar-diag-full-dropdown');

        document.addEventListener('click', () => {
            el('ar-diag-more-dropdown')?.classList.remove('is-open');
            el('ar-diag-full-dropdown')?.classList.remove('is-open');
        }, { signal: uiSignal });

        // Счётчик записей и ошибок в постоянном логе
        const updateDiagCount = () => {
            const all = DiagLog.getAll();
            const total = all.length;
            const errors = all.filter(e => e.lvl === 'ERR').length;

            const c = el('ar-diag-count');
            if (c) {
                if (errors > 0) {
                    c.textContent = `${errors} ${errors === 1 ? 'ошибка' : (errors < 5 ? 'ошибки' : 'ошибок')}`;
                    c.className = 'ar-badge ar-badge--error';
                    c.title = `Всего записей: ${total}, из них ошибок: ${errors}`;
                } else {
                    c.textContent = total;
                    c.className = 'ar-badge ar-badge--neutral';
                    c.title = `Записей в логе: ${total}`;
                }
            }

            const fullStat = el('ar-diag-full-stat');
            if (fullStat) {
                fullStat.textContent = `Всего: ${total} · Ошибок: ${errors}`;
            }
        };
        window._applomat_updateDiagBadge = window._hh_ar_updateDiagBadge = updateDiagCount;
        updateDiagCount();
        uiDiagTimer = setInterval(() => {
            if (!document.getElementById('ar-diag-count')) {
                clearInterval(uiDiagTimer);
                uiDiagTimer = null;
                return;
            }
            updateDiagCount();
        }, 2000);

        // Выгрузка полного диагностического лога в файл
        const exportLogs = () => {
            exportDiagnosticReport();
            updateDiagCount();
        };
        const saveLogsBtn = el('ar-save-logs');
        if (saveLogsBtn) saveLogsBtn.onclick = exportLogs;
        const diagFullSaveBtn = el('ar-diag-full-save');
        if (diagFullSaveBtn) diagFullSaveBtn.onclick = exportLogs;

        // Очистка постоянного лога
        const handleClearAllDiag = () => {
            if (confirm('Очистить сохранённый диагностический лог и метрики? (выгрузите файл перед очисткой, если нужен для анализа)')) {
                DiagLog.clear();
                Metrics.clear();
                const box = el('ar-log-box');
                if (box) box.innerHTML = '';
                const fullBox = el('ar-diag-full-box');
                if (fullBox) fullBox.innerHTML = '';
                updateDiagCount();
                log('Сохранённый диагностический лог и метрики очищены.');
                el('ar-diag-more-dropdown')?.classList.remove('is-open');
                el('ar-diag-full-dropdown')?.classList.remove('is-open');
            }
        };
        const clearDiagBtn = el('ar-clear-diag');
        if (clearDiagBtn) clearDiagBtn.onclick = handleClearAllDiag;
        const diagFullClearAll = el('ar-diag-full-clear-all');
        if (diagFullClearAll) diagFullClearAll.onclick = handleClearAllDiag;

        // ---------- Управление ----------
        el('ar-start-btn').onclick = startLoop;
        el('ar-stop-btn').onclick = stopRun;

        el('ar-reset-history').onclick = () => {
            if (confirm('Сбросить историю откликов, лимит и статистику текущего запуска?')) {
                State.clearProcessedIDs();
                State.resetSentCount();
                Stats.reset();
                renderStats();
                log('История откликов, счётчик и статистика сброшены.');
            }
        };

        const triggerDiag = () => {
            openFullDiag();
            runHealthCheck();
        };
        el('ar-health-btn').onclick = triggerDiag;
        const diagCheckBtn = el('ar-diag-check-btn');
        if (diagCheckBtn) diagCheckBtn.onclick = runHealthCheck;
        const diagFullCheckBtn = el('ar-diag-full-check');
        if (diagFullCheckBtn) diagFullCheckBtn.onclick = runHealthCheck;

        // ---------- Ручная очередь (без вложенного скролла) ----------
        el('ar-clear-manual').onclick = () => {
            if (confirm('Очистить сохранённый список вакансий ручной очереди?')) {
                State.clearManualList();
                renderManualList();
                log('Список ручной очереди очищен.');
            }
        };

        el('ar-export-manual').onclick = exportManualListHtml;

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
                empty.textContent = 'Очередь пуста · Вакансии с вопросами сохраняются сюда автоматически';
                container.appendChild(empty);
                return;
            }

            // Превью до 4 элементов без вложенного скролл-бокса
            const PREVIEW_LIMIT = 4;
            const previewItems = list.slice(0, PREVIEW_LIMIT);

            previewItems.forEach(item => {
                const safeUrl = toSafeHhUrl(item?.url);
                const row = document.createElement('div');
                row.className = 'ar-manual-item';

                const left = document.createElement('div');
                left.className = 'ar-manual-main';
                const time = new Date(Number(item?.ts) || Date.now()).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

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
                if (itemTitle) {
                    titleEl.textContent = itemTitle;
                    titleEl.title = itemTitle;
                } else {
                    titleEl.classList.add('is-empty');
                    titleEl.textContent = 'Название недоступно';
                }

                left.appendChild(head);
                left.appendChild(titleEl);

                const actions = document.createElement('div');
                actions.className = 'ar-manual-actions';

                const openBtn = document.createElement('button');
                openBtn.className = 'ar-btn ar-btn-open';
                openBtn.innerHTML = '<span>Открыть</span><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
                openBtn.disabled = !safeUrl;
                openBtn.title = safeUrl ? 'Открыть вакансию в новой вкладке' : 'Ссылка не прошла проверку безопасности';
                openBtn.onclick = () => {
                    if (safeUrl) window.open(safeUrl, '_blank', 'noopener,noreferrer');
                };

                const removeBtn = document.createElement('button');
                removeBtn.className = 'ar-btn ar-icon-del';
                removeBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
                removeBtn.title = 'Удалить из очереди';
                removeBtn.onclick = () => { State.removeManualEntry(item.vid); renderManualList(); };

                actions.appendChild(openBtn);
                actions.appendChild(removeBtn);

                row.appendChild(left);
                row.appendChild(actions);
                container.appendChild(row);
            });

            if (totalCount > PREVIEW_LIMIT) {
                const moreBtn = document.createElement('button');
                moreBtn.className = 'ar-btn ar-btn-soft ar-queue-more-btn';
                moreBtn.innerHTML = `<span>Открыть очередь (${totalCount}) →</span>`;
                moreBtn.title = 'Открыть интерактивную страницу со всей очередью вакансий';
                moreBtn.onclick = exportManualListHtml;
                container.appendChild(moreBtn);
            }
        }

        // ---------- Живая статистика прогона ----------
        function renderStats() {
            const s = Stats.getAll();
            const setNum = (id, v) => { const n = document.getElementById(id); if (n) n.textContent = v; };
            setNum('ar-stat-attempts', s.attempts);
            setNum('ar-stat-success', s.success);
            setNum('ar-stat-manual', s.manual);
            setNum('ar-stat-skipped', s.skipped);
            const sent = State.getSentCount();
            const prog = document.getElementById('ar-stat-progress');
            if (prog) prog.textContent = `${sent} / ${config.limit}`;
            const fill = document.getElementById('ar-progress-fill');
            if (fill) fill.style.width = clamp(Math.round(sent / Math.max(1, config.limit) * 100), 0, 100) + '%';

            // Zero-state consistency: семантические цвета только при ненулевых значениях
            const tileAtt = document.getElementById('ar-stat-tile-attempts');
            const tileSuc = document.getElementById('ar-stat-tile-success');
            const tileMan = document.getElementById('ar-stat-tile-manual');
            const tileSkp = document.getElementById('ar-stat-tile-skip');
            if (tileSuc) tileSuc.classList.toggle('is-active-success', s.success > 0);
            if (tileMan) tileMan.classList.toggle('is-active-manual', s.manual > 0);
            if (tileSkp) tileSkp.classList.toggle('is-active-skip', s.skipped > 0);
            if (tileAtt) tileAtt.classList.toggle('is-active-attempts', s.attempts > 0);
        }
        window._applomat_renderStats = window._hh_ar_renderStats = renderStats;
        renderStats();

        uiStatsTimer = setInterval(() => {
            if (!document.getElementById('ar-stat-attempts')) {
                clearInterval(uiStatsTimer);
                uiStatsTimer = null;
                return;
            }
            renderStats();
        }, 2000);

        // ---------- Сворачивание панели ----------
        const rootEl = document.documentElement;
        const toggleVisibility = (isOpen) => {
            panel.style.display = isOpen ? 'flex' : 'none';
            toggleBtn.style.display = isOpen ? 'none' : 'flex';
            rootEl.classList.toggle('hh-ar-open', isOpen);
            storage.localSet(KEYS.uiOpen, isOpen ? '1' : '0');
        };
        el('ar-minimize-btn').onclick = () => toggleVisibility(false);
        const minDiagBtn = el('ar-minimize-diag-btn');
        if (minDiagBtn) minDiagBtn.onclick = () => toggleVisibility(false);
        toggleBtn.onclick = () => toggleVisibility(true);

        toggleVisibility(storage.localGet(KEYS.uiOpen) !== '0');
        setTimeout(() => rootEl.classList.add('hh-ar-anim'), 60);

        // initial render
        applyLogFilter();
        renderManualList();

        window._applomat_renderManualList = window._hh_ar_renderManualList = renderManualList;
    }

    // Пробегает по ключевым селекторам и пишет результат в лог
    function runHealthCheck() {
        const checks = [
            { name: 'Кнопка отклика (list)', sel: SELECTORS.applyBtn, key: 'applyBtn' },
            { name: 'Кнопка отклика (vacancy page)', sel: SELECTORS.vacancyApply, key: 'vacancyApply' },
            { name: 'Ссылка вакансии (card)', sel: SELECTORS.vacancyLink, key: 'vacancyLink' },
            { name: 'Прикрепить письмо (сценарий А)', sel: SELECTORS.attachCoverBtn, key: 'attachCoverBtn' },
            { name: 'Кнопка отправки письма', sel: SELECTORS.letterSubmit, key: 'letterSubmit' },
            { name: 'Поле письма (textarea)', sel: SELECTORS.letterTextarea, key: 'letterTextarea' }
        ];
        log('Запускаю диагностику селекторов...');
        checks.forEach(c => {
            const found = q(c.sel);
            const fallbackFound = found ? null : query(c.key);
            if (found) {
                log(`${c.name}: OK (${c.sel})`);
            } else if (fallbackFound) {
                log(`${c.name}: ЭВРИСТИЧЕСКИ НАЙДЕНО (селектор ${c.sel} не сработал)`, false);
            } else {
                log(`${c.name}: НЕ НАЙДЕНО (${c.sel})`, true);
            }
        });
        const obj = parseJson(storage.localGet(KEYS.instanceLock), null);
        if (obj) {
            log(`Instance lock: tabId=${obj.tabId} ts=${new Date(obj.ts).toLocaleTimeString('ru-RU')}`);
        } else {
            log('Instance lock: отсутствует');
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  14. ЭКСПОРТ РУЧНОГО СПИСКА (интерактивный HTML applomat)
    // ─────────────────────────────────────────────────────────────

    function exportManualListHtml() {
        const list = State.getManualList();
        if (!list || !list.length) { alert('Список пуст'); return; }

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

        const content = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>applomat · сохранённые вакансии</title><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>
                :root{
                    color-scheme:light;
                    --ap-brand:#d6001c; --ap-brand-hover:#b80018; --ap-brand-soft:#ffebee;
                    --hh-blue:#0070e5; --hh-blue-hover:#005cbd; --hh-blue-soft:#e9f2fd;
                    --hh-green:#059669; --hh-green-soft:#ecfdf5;
                    --ink:#1e293b; --ink-2:#475569; --ink-3:#94a3b8;
                    --line:#e2e8f0; --line-2:#f1f5f9;
                    --bg:#ffffff; --bg-2:#f8fafc; --bg-3:#f1f5f9;
                    --radius:12px; --radius-sm:8px; --radius-xs:6px;
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
                .dropdown.is-open .dropdown-trigger{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%230070e5' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M18 15l-6-6-6 6'/%3E%3C/svg%3E");}
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
                .btn.primary{background:var(--hh-blue);color:#fff;border-color:var(--hh-blue);box-shadow:0 2px 4px rgba(0,112,229,.18);}
                .btn.primary:hover{background:var(--hh-blue-hover);border-color:var(--hh-blue-hover);box-shadow:0 4px 8px rgba(0,112,229,.25);}
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
                            <h1 class="brand-heading"><span class="brand-wordmark">applomat</span><span class="brand-sep">·</span><span class="brand-sub">сохранённые вакансии</span></h1>
                            <div class="meta">Экспорт ручной очереди от ${new Date().toLocaleString('ru-RU')} · дубликатов удалено: ${duplicates}</div>
                        </div>
                    </div>
                    <div class="stats" id="summary"></div>
                </header>
                <section class="panel">
                    <div class="toolbar">
                        <div class="search-field">
                            <svg class="search-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
                            <input id="filter" type="text" placeholder="Поиск по названию или ссылке...">
                        </div>
                        <div class="dropdown" id="sort-dropdown">
                            <div class="dropdown-trigger" tabindex="0">Сортировка: Новые → старые</div>
                            <div class="dropdown-menu">
                                <div class="dropdown-item is-active" data-value="ts_desc">Новые → старые</div>
                                <div class="dropdown-item" data-value="ts_asc">Старые → новые</div>
                                <div class="dropdown-item" data-value="title_asc">Название A→Z</div>
                                <div class="dropdown-item" data-value="title_desc">Название Z→A</div>
                            </div>
                        </div>
                        <div class="dropdown" id="view-mode-dropdown">
                            <div class="dropdown-trigger" tabindex="0">Статус: Новые</div>
                            <div class="dropdown-menu">
                                <div class="dropdown-item is-active" data-value="new">Новые</div>
                                <div class="dropdown-item" data-value="opened">Открытые</div>
                            </div>
                        </div>
                        <div class="toolbar-spacer"></div>
                        <button id="open-selected" class="btn primary" title="Открыть отмеченные вакансии, по одной вкладке на каждую. Если открылась только первая - разрешите этому файлу всплывающие окна в браузере.">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg>
                            Открыть выбранные
                        </button>
                        <button id="clear-processed" class="btn secondary" title="Снять отметку открыто со всех вакансий: режим Открытые опустеет, вакансии снова станут Новыми. Сами записи не удаляются.">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>
                            Сбросить отметки
                        </button>
                    </div>
                    <div class="table-wrap">
                        <table>
                            <thead>
                                <tr>
                                    <th class="col-check"><input type="checkbox" id="check-all"></th>
                                    <th class="col-date">Сохранена</th>
                                    <th class="col-title">Вакансия</th>
                                    <th class="col-link">Ссылка</th>
                                    <th class="col-age">Возраст</th>
                                </tr>
                            </thead>
                            <tbody id="rows"></tbody>
                        </table>
                    </div>
                </section>
            </div>

            <script>
                const data = ${rowsJson};
                let sortKey = 'ts_desc';
                let filterText = '';
                let viewMode = 'new';
                const PROCESSED_KEY = 'applomat_manual_processed';
                const LEGACY_PROCESSED_KEY = 'hh_ar_manual_processed';
                let processed = {};
                try {
                    const raw = localStorage.getItem(PROCESSED_KEY);
                    if (raw) {
                        processed = JSON.parse(raw) || {};
                    } else {
                        const legacyRaw = localStorage.getItem(LEGACY_PROCESSED_KEY);
                        if (legacyRaw) {
                            processed = JSON.parse(legacyRaw) || {};
                            try { localStorage.setItem(PROCESSED_KEY, JSON.stringify(processed)); } catch (_) {}
                        }
                    }
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
                        if (sortKey === 'title_asc') return ta.localeCompare(tb);
                        if (sortKey === 'title_desc') return tb.localeCompare(ta);
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
                        const link = url ? '<a class="icon-link" title="Открыть вакансию" aria-label="Открыть вакансию" data-open="1" href="' + escHtml(url) + '" target="_blank" rel="noopener noreferrer">' + openIcon + '</a>' : '<span class="tag">нет</span>';
                        const title = (i.title && i.title.trim()) ? i.title.trim() : '';
                        const titleCell = title
                            ? escHtml(title)
                            : '<span class="muted" title="Название не удалось определить при сохранении">Название недоступно</span>';
                        html += '<tr' + rowClass + ' data-key="' + keyEnc + '">'
                             + '<td class="col-check"><input type="checkbox" class="row-check" data-key="' + keyEnc + '" ' + checked + '></td>'
                             + '<td class="col-date">' + escHtml(new Date(ts).toLocaleString('ru-RU')) + '</td>'
                             + '<td class="col-title">' + titleCell + '</td>'
                             + '<td class="col-link">' + link + '</td>'
                             + '<td class="col-age"><span class="age ' + aClass + '">' + ago + '</span></td>'
                             + '</tr>';
                    });
                    if (!sorted.length) {
                        const emptyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M9 15h6"></path></svg>';
                        const msg = ft ? 'Ничего не найдено по запросу' : (viewMode === 'opened' ? 'Открытых вакансий пока нет' : 'Новых вакансий нет');
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
                    let html = stat('', total, 'Всего') + stat('new', fresh, 'Новые') + stat('opened', opened, 'Открытые');
                    if (filterText.trim() !== '') html += stat('shown', typeof shown === 'number' ? shown : 0, 'Показано');
                    box.innerHTML = html;
                }

                function saveProcessed() {
                    try {
                        localStorage.setItem(PROCESSED_KEY, JSON.stringify(processed));
                    } catch (_) {}
                }

                qs('filter').addEventListener('input', (e)=>{ filterText = e.target.value; render(); });
                function initDropdown(id, prefix, onSelect) {
                    const wrap = qs(id);
                    if (!wrap) return;
                    const trigger = wrap.querySelector('.dropdown-trigger');
                    const menu = wrap.querySelector('.dropdown-menu');
                    trigger.setAttribute('role', 'button');
                    trigger.setAttribute('aria-haspopup', 'listbox');
                    trigger.setAttribute('aria-expanded', 'false');
                    const setOpen = (open) => {
                        wrap.classList.toggle('is-open', open);
                        trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
                    };
                    const choose = (item) => {
                        trigger.textContent = prefix + item.textContent;
                        menu.querySelectorAll('.dropdown-item').forEach(i => i.classList.remove('is-active'));
                        item.classList.add('is-active');
                        setOpen(false);
                        onSelect(item.dataset.value);
                    };
                    trigger.addEventListener('click', (e) => {
                        e.stopPropagation();
                        document.querySelectorAll('.dropdown.is-open').forEach(d => { if (d !== wrap) d.classList.remove('is-open'); });
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
                }
                document.addEventListener('click', () => {
                    document.querySelectorAll('.dropdown.is-open').forEach(d => d.classList.remove('is-open'));
                });
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') document.querySelectorAll('.dropdown.is-open').forEach(d => d.classList.remove('is-open'));
                });

                initDropdown('sort-dropdown', 'Сортировка: ', (val) => { sortKey = val; render(); });
                initDropdown('view-mode-dropdown', 'Статус: ', (val) => {
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
                    if (!confirm('Снять отметку открыто со всех вакансий? Записи не удаляются - они снова появятся в режиме Новые.')) return;
                    const keys = Object.keys(processed);
                    keys.forEach(k => delete processed[k]);
                    saveProcessed();
                    selected.clear();
                    render();
                });

                // init
                render();
            <\/script>
            </body></html>`;

        downloadFile('applomat_manual_list.html', content, 'text/html;charset=utf-8');
        log('HTML экспорт выполнен.');
    }

    // ─────────────────────────────────────────────────────────────
    //  15. ЗАПУСК И ГЛОБАЛЬНЫЕ ОБРАБОТЧИКИ
    // ─────────────────────────────────────────────────────────────

    // Перехват необработанных ошибок: отделяем собственные ошибки applomat от шума HeadHunter и сторонних скриптов.
    let applomatErrCount = 0;
    let externalErrCount = 0;
    const APPLOMAT_ERR_LIMIT = 50;
    const EXTERNAL_ERR_LIMIT = 5;

    function isApplomatError(e, isPromise = false) {
        const errObj = isPromise ? e.reason : (e.error || e);
        const stack = (errObj && typeof errObj.stack === 'string') ? errObj.stack : '';
        const filename = (!isPromise && typeof e.filename === 'string') ? e.filename : '';
        const message = isPromise
            ? (errObj && (errObj.message || String(errObj)) || '')
            : (e.message || String(errObj || ''));
        const combined = `${filename} ${stack} ${message}`;

        // Характерные маркеры кода applomat
        const applomatMarkers = [
            'applomat', 'hh_ar_', 'startLoop', 'processVacancy', 'applyToVacancy',
            'realisticClick', 'fillCoverLetter', 'checkResponseTrap', 'watchdogTick',
            'setupUI', 'DiagLog', 'interruptibleWait', 'fnv1a32', 'buildPanelHtml',
            'exportManualListHtml', 'runHealthCheck'
        ];
        return applomatMarkers.some(m => combined.includes(m));
    }

    window.addEventListener('error', (e) => {
        try {
            const isInternal = isApplomatError(e, false);
            const where = e.filename ? ` @ ${e.filename}:${e.lineno || 0}:${e.colno || 0}` : '';
            if (isInternal) {
                if (applomatErrCount >= APPLOMAT_ERR_LIMIT) return;
                applomatErrCount++;
                log(`JS-ошибка [applomat]: ${e.message || 'Error'}${where}`, true);
            } else {
                if (externalErrCount >= EXTERNAL_ERR_LIMIT) return;
                externalErrCount++;
                // Внешняя ошибка страницы hh.ru — логируем как INFO, не окрашивая диагностический бейдж в красный
                DiagLog.push(`[Внешняя ошибка страницы hh.ru]: ${(e.message || 'Error').slice(0, 300)}${where}`, false);
                console.warn('[applomat] Внешняя ошибка страницы hh.ru:', e.message, where);
            }
        } catch (_) { /* ignore */ }
    });

    window.addEventListener('unhandledrejection', (e) => {
        try {
            const isInternal = isApplomatError(e, true);
            const r = e.reason;
            const text = r && (r.stack || r.message) ? (r.stack || r.message) : String(r);
            if (isInternal) {
                if (applomatErrCount >= APPLOMAT_ERR_LIMIT) return;
                applomatErrCount++;
                log(`Unhandled rejection [applomat]: ${String(text).slice(0, 500)}`, true);
            } else {
                if (externalErrCount >= EXTERNAL_ERR_LIMIT) return;
                externalErrCount++;
                DiagLog.push(`[Внешний unhandled rejection]: ${String(text).slice(0, 300)}`, false);
                console.warn('[applomat] Внешний unhandled rejection hh.ru:', text);
            }
        } catch (_) { /* ignore */ }
    });

    // Отметка загрузки каждой страницы - по ней в логе видна вся последовательность навигаций.
    log(`- Загрузка страницы: ${location.pathname}${location.search} (running=${State.amIRunning()}, sent=${State.getSentCount()}/${config.limit}) -`);

    startWatchdog();

    function bootstrap() {
        setupUI();
        if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
        // Авто-возобновление, если скрипт был в работе перед перезагрузкой.
        // Условие перепроверяется В МОМЕНТ срабатывания таймера: если пользователь успел
        // нажать Стоп в эти 1.5 секунды, отложенный startLoop не должен воскресить
        // прогон (State.setRunning(false) уже снят, и стартовать нечего).
        if (State.amIRunning()) {
            log('Обнаружена незавершенная работа. Авто-возобновление через 1.5 сек...');
            setStatus('running', 'Авто-запуск...');
            resumeTimer = setTimeout(() => {
                resumeTimer = null;
                if (State.amIRunning()) {
                    if (Page.isResponseForm()) {
                        log('На странице отклика - управление у обработчика формы.');
                        return;
                    }
                    startLoop();
                }
                else log('Авто-возобновление отменено: прогон остановлен пользователем.');
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
                bootstrap();
            }
        });
        domReadyObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    // Очищаем instance lock при закрытии вкладки - но только когда прогон не активен:
    // прогон живёт через полные навигации (список → вакансия → список), и лок должен
    // переживать их до авто-возобновления (1.5 с в bootstrap), иначе другая вкладка
    // успеет захватить его в этом окне. Мёртвые вкладки, закрытые посреди прогона,
    // освобождаются по TTL (TUNING.instanceLockTtl).
    window.addEventListener('beforeunload', () => {
        DiagLog.flush();
        if (!State.amIRunning()) State.releaseInstanceLock(TAB_ID);
    });
    window.addEventListener('pagehide', () => {
        DiagLog.flush();
    });
    window.addEventListener('unload', () => {
        DiagLog.flush();
        if (!State.amIRunning()) State.releaseInstanceLock(TAB_ID);
    });
})();
