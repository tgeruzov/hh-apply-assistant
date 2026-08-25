import { deepFreeze, DIAG_LOG_MAX, DOM_SNAPSHOT_MAX } from '../dom/selectors.js';
import {
    storage,
    KEYS,
    writeSessionVerified,
    removeSessionVerified,
    writeLocalVerified,
    removeLocalVerified,
    registerStorageHooks
} from '../storage/storage-service.js';
import {
    parseJson,
    clamp,
    toNum,
    randBetween,
    fnv1a32,
    toSafeHhUrl,
    prettifyTitle
} from './utils.js';
import {
    I18n,
    PRESETS,
    DEFAULT_PRESET,
    DEFAULTS,
    getDefaultCoverText,
    TRANSLATIONS,
    SUPPORTED_LANGUAGES
} from '../i18n/index.js';
import {
    TAB_ID,
    currentRunId,
    currentInstanceLeaseId,
    acquireInstanceLock,
    verifyInstanceLock,
    releaseInstanceLock,
    touchInstanceLock,
    guardOwnedCommit,
    getActiveTrapLock,
    clearTrapLockTimer,
    setTrapLockTimer,
    setStopSignal,
    setLoopActive,
    setResumeTimer,
    setActiveAbortController,
    setHandlingResponsePage,
    incRunId,
    activeAbortController,
    resumeTimer,
    wait
} from './concurrency.js';
import type {
    AppSettings,
    DiagLogEntry,
    DomSnapshot,
    ManualQueueItem,
    MetricsData,
    MetricsMap,
    RunStats,
    StatusKey,
    StatusState,
    VacancyMeta
} from '../types/index.js';

export const Settings = {
    // Defensive validation актуальной storage schema: defaults, типы и диапазоны.
    normalize(raw: Partial<AppSettings> = {}): AppSettings {
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
    load(): AppSettings {
        return Settings.normalize(parseJson(storage.localGet(KEYS.settings), {}));
    },
    save(cfg: AppSettings): boolean {
        try {
            return storage.localSet(KEYS.settings, JSON.stringify(cfg));
        } catch (e) {
            return false;
        }
    }
};

export let config: AppSettings = Settings.load();

export function setConfig(nextConfig: AppSettings): void {
    config = nextConfig;
}

export function handleSettingsPersistenceFailure(): void {
    Metrics.bump('settings.save.failed');
    if (State.amIRunning()) {
        currentRunId_inc();
        setStopSignal(true);
        if (resumeTimer) { clearTimeout(resumeTimer); setResumeTimer(null); }
        setHandlingResponsePage(false);
        State.clearTrapLock();
        if (activeAbortController) {
            try { activeAbortController.abort(); } catch (e) {}
            setActiveAbortController(null);
        }
        setLoopActive(false);
        clearRunningState('settings-save-failed');
        State.releaseInstanceLock(TAB_ID);
        setStatus('error');
        log(I18n.t('logs.persistenceFailure', { vid: 'settings' }), true);
    }
}

function currentRunId_inc() {
    incRunId();
}

export function persistSettings(nextConfig: Partial<AppSettings>): boolean {
    const normalized = Settings.normalize(nextConfig);
    if (!Settings.save(normalized)) {
        handleSettingsPersistenceFailure();
        return false;
    }
    config = normalized;
    return true;
}

// Активный пресет таймингов (устойчив к битому значению в конфиге).
export const timings = () => PRESETS[config.preset] || PRESETS[DEFAULT_PRESET];
export const actionPause = () => wait(randBetween(timings().action[0], timings().action[1]));
export const vacancyPause = () => wait(randBetween(timings().delay[0], timings().delay[1]));

export const DiagnosticI18n = (() => {
    const namespaces = ['logs', 'health'];
    const patternCache = new Map<string, any[]>();
    const staticCache = new Map<string, any[]>();
    const legacyEntries: Record<string, [string, string][]> = {
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
    const escapeRx = (value: string) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const collect = (node: any, prefix: string, out: Array<{ key: string; template: string }>) => {
        if (!node || typeof node !== 'object') return;
        Object.entries(node).forEach(([key, value]) => {
            const path = prefix ? `${prefix}.${key}` : key;
            if (typeof value === 'string') out.push({ key: path, template: value });
            else collect(value, path, out);
        });
    };

    const getEntries = (lang: string) => {
        const out: Array<{ key: string; template: string }> = [];
        namespaces.forEach(namespace => collect((TRANSLATIONS as any)[lang]?.[namespace], namespace, out));
        collect((TRANSLATIONS as any)[lang]?.languages, 'languages', out);
        collect((TRANSLATIONS as any)[lang]?.presets, 'presets', out);
        (legacyEntries[lang] || []).forEach(([key, template]) => out.push({ key, template }));
        return out;
    };

    const getPatterns = (lang: string) => {
        if (patternCache.has(lang)) return patternCache.get(lang)!;
        const patterns = getEntries(lang).map(entry => {
            const params: string[] = [];
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

    const getStaticEntries = (lang: string) => {
        if (staticCache.has(lang)) return staticCache.get(lang)!;
        const entries = getEntries(lang)
            .filter(entry => !/\{[a-zA-Z0-9_]+\}/.test(entry.template) && entry.template.length >= 3)
            .sort((a, b) => b.template.length - a.template.length);
        staticCache.set(lang, entries);
        return entries;
    };

    const infer = (message: string, preferredLang = I18n.getLanguage()) => {
        const text = String(message || '');
        const languages = [preferredLang, ...SUPPORTED_LANGUAGES.filter(lang => lang !== preferredLang)];
        for (const lang of languages) {
            for (const pattern of getPatterns(lang)) {
                const match = pattern.rx.exec(text);
                if (!match) continue;
                const params: Record<string, string> = {};
                pattern.params.forEach((name: string, index: number) => { params[name] = match[index + 1]; });
                return { key: pattern.key, params, lang };
            }
        }
        return null;
    };

    const translateParam = (value: unknown, fromLang: string, toLang: string) => {
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

    const format = (entry: any) => {
        if (!entry) return '';
        const meta = entry.i18nKey
            ? { key: entry.i18nKey, params: entry.i18nParams || {}, lang: entry.i18nLang || '' }
            : infer(entry.msg, entry.lang || I18n.getLanguage());
        if (!meta) return String(entry.msg || '');
        const currentLang = I18n.getLanguage();
        const params: Record<string, unknown> = {};
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

export const DiagLog = (() => {
    let _cache: any[] | null = null;
    let _saveTimer: ReturnType<typeof setTimeout> | null = null;
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
                    try { (window as any)._hhApplyAssistantUpdateDiagBadge?.(true); } catch (e) { /* ignore */ }
                    try { (window as any)._hhApplyAssistantRenderDiagnostics?.(); } catch (e) { /* ignore */ }
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
        push(msg: unknown, isError = false) {
            const arr = _ensureLoaded();
            const text = String(msg).slice(0, 1000);
            const i18n = DiagnosticI18n.infer(text, I18n.getLanguage());
            const entry: any = {
                t: Date.now(),
                lvl: isError ? 'ERR' : 'INFO',
                path: typeof location !== 'undefined' ? (location.pathname + location.search).slice(0, 300) : '',
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

export const Metrics = (() => {
    let _cache: any = null;
    let _saveTimer: ReturnType<typeof setTimeout> | null = null;
    let _isDirty = false;

    function _ensureLoaded(): MetricsData {
        if (_cache === null) {
            const m = parseJson<any>(storage.localGet(KEYS.metrics), null);
            if (m && typeof m === 'object') {
                m.counters = m.counters || {};
                m.timings = m.timings || {};
                m.selectors = m.selectors || {};
                m.snapshots = Array.isArray(m.snapshots) ? m.snapshots : [];
                _cache = m as MetricsData;
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
        bump(key: string, by = 1) {
            const m = _ensureLoaded();
            m.counters[key] = (m.counters[key] || 0) + by;
            _scheduleSave();
        },
        timing(key: string, ms: number) {
            if (!Number.isFinite(ms)) return;
            const m = _ensureLoaded();
            const t = m.timings[key] || { n: 0, sum: 0, last: 0, max: 0 };
            t.n++; t.sum += ms; t.last = ms; if (ms > t.max) t.max = ms;
            m.timings[key] = t;
            _scheduleSave();
        },
        selector(name: string, found: boolean) {
            const m = _ensureLoaded();
            const s = m.selectors[name] || { found: 0, missing: 0 };
            if (found) s.found++; else s.missing++;
            m.selectors[name] = s;
            _scheduleSave();
        },
        snapshot(label: string, data: any) {
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

// Hook up storage error logger and metrics
registerStorageHooks(
    (msg: string, isErr: boolean) => DiagLog.push(msg, isErr),
    (metricName: string) => Metrics.bump(metricName)
);

export const STATS_FIELDS = deepFreeze(['success', 'manual', 'skipped']);

export const Stats = {
    _get(): { success: number; manual: number; skipped: number; startedAt: number; [k: string]: number } {
        const s = parseJson<Record<string, number> | null>(storage.sessionGet(KEYS.stats), null);
        const base = { success: 0, manual: 0, skipped: 0, startedAt: 0 };
        return (s && typeof s === 'object') ? { ...base, ...s } : base;
    },
    _save(s: any) { storage.sessionSet(KEYS.stats, JSON.stringify(s)); },
    bump(key: string, by = 1) {
        if (!STATS_FIELDS.includes(key)) return;
        const s = Stats._get();
        if (!s.startedAt) s.startedAt = Date.now();
        s[key] = (s[key] || 0) + by;
        Stats._save(s);
        try { (window as any)._hhApplyAssistantRenderStats?.(); } catch (e) { /* ignore */ }
    },
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
        try { (window as any)._hhApplyAssistantRenderStats?.(); } catch (e) { /* ignore */ }
    }
};

export const log = (msg: unknown, isError = false): void => {
    try {
        DiagLog.push(msg, isError);
    } catch (e) { /* ошибки storage не должны ломать UI */ }

    try {
        try {
            (window as any)._hhApplyAssistantUpdateDiagBadge?.();
        } catch (e) { /* ignore */ }

        const viewDiag = typeof document !== 'undefined' ? document.getElementById('ar-view-diag') : null;
        if (viewDiag && viewDiag.style.display !== 'none') {
            try {
                (window as any)._hhApplyAssistantRenderDiagnostics?.();
            } catch (e) { /* ignore */ }
        }
    } catch (e) { /* UI-лог не критичен */ }

    console.log(`[HH Apply Assistant] ${msg}`);
};

export const STATUS_KEYS: readonly StatusKey[] = deepFreeze(['idle', 'running', 'stopped', 'error', 'done']);

export let currentStatusState: StatusState = {
    statusKey: 'idle',
    customKeyOrText: null,
    params: null
};

export function syncCollapsedToggleState(toggle = typeof document !== 'undefined' ? document.getElementById('ar-toggle-btn') : null): void {
    if (!toggle) return;
    const running = State.amIRunning();
    const title = I18n.t(running ? 'panel.expandRunningTitle' : 'panel.expandTitle');
    toggle.classList.toggle('is-running', running);
    toggle.setAttribute('data-status', running ? 'running' : currentStatusState.statusKey);
    toggle.title = title;
    toggle.setAttribute('aria-label', title);
}

export function setStatus(statusKey: StatusKey, customKeyOrText?: string | null, params?: Record<string, unknown> | null): void {
    const key: StatusKey = STATUS_KEYS.includes(statusKey) ? statusKey : 'idle';
    currentStatusState = { statusKey: key, customKeyOrText, params };

    if (typeof document === 'undefined') return;
    const el = document.getElementById('ar-status-text');
    if (!el) return;
    const isTurbo = config?.preset === 'turbo';

    let text: string;
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
    const startBtn = document.getElementById('ar-start-btn') as HTMLButtonElement | null;
    const stopBtn = document.getElementById('ar-stop-btn') as HTMLButtonElement | null;
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

export function restoreStatusAfterMount(): void {
    if (State.amIRunning()) {
        setStatus('running');
    } else if (currentStatusState.statusKey === 'running') {
        setStatus('idle');
    } else {
        setStatus(currentStatusState.statusKey, currentStatusState.customKeyOrText, currentStatusState.params);
    }
}

export function clearRunningState(context?: string): boolean {
    if (State.setRunning(false)) return true;
    Metrics.bump('storage.is_active.cleanup.failed');
    log(`[CRITICAL_STORAGE_WRITE_FAILED] is_active cleanup: ${context || 'unknown'}`, true);
    return false;
}

export const State = {
    readProcessedIDs: (): { ok: boolean; value: Set<string> } => {
        const read = storage.sessionRead(KEYS.history);
        if (!read.ok) return { ok: false, value: new Set() };
        const arr = parseJson(read.value, []);
        return { ok: true, value: new Set(Array.isArray(arr) ? arr : []) };
    },
    getProcessedIDs: (): Set<string> => State.readProcessedIDs().value,
    addProcessedID: (id: string): boolean => {
        if (!id) return true;
        const current = State.readProcessedIDs();
        if (!current.ok) return false;
        const s = current.value;
        s.add(id);
        return writeSessionVerified(KEYS.history, JSON.stringify([...s]));
    },
    clearProcessedIDs: (): boolean => removeSessionVerified(KEYS.history),

    readSentCount: (): { ok: boolean; value: number } => {
        const read = storage.sessionRead(KEYS.sentCount);
        if (!read.ok) return { ok: false, value: 0 };
        const n = parseInt(read.value || '0', 10);
        return { ok: true, value: Number.isFinite(n) ? n : 0 };
    },
    getSentCount: (): number => State.readSentCount().value,
    incSentCount: (): number | null => {
        const current = State.readSentCount();
        if (!current.ok) return null;
        const next = current.value + 1;
        if (!writeSessionVerified(KEYS.sentCount, String(next))) return null;
        Stats.bump('success');
        return next;
    },
    resetSentCount: (): boolean => removeSessionVerified(KEYS.sentCount),

    amIRunning: (): boolean => storage.sessionGet(KEYS.isRunning) === '1',
    setRunning: (state: boolean): boolean => state ? writeSessionVerified(KEYS.isRunning, '1') : removeSessionVerified(KEYS.isRunning),

    setReturnUrl: (url?: string): boolean => storage.sessionSet(KEYS.returnUrl, url || (typeof location !== 'undefined' ? location.href : '')),
    getReturnUrl: (): string | null => storage.sessionGet(KEYS.returnUrl),

    setF5Needed: (): boolean => storage.sessionSet(KEYS.needF5, '1'),
    isF5Needed: (): boolean => storage.sessionGet(KEYS.needF5) === '1',
    clearF5Flag: (): boolean => storage.sessionRemove(KEYS.needF5),

    setTrapLock: (ttlMs = 45000): string | null => {
        const token = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        const ttl = Math.max(0, Number(ttlMs) || 0);
        const lock = { token, runId: currentRunId, expiresAt: Date.now() + ttl };
        if (!storage.sessionSet(KEYS.trapLock, JSON.stringify(lock))) return null;
        clearTrapLockTimer();
        setTrapLockTimer(setTimeout(() => {
            const current = parseJson<any>(storage.sessionGet(KEYS.trapLock), null);
            if (current && current.token === token) {
                storage.sessionRemove(KEYS.trapLock);
                clearTrapLockTimer();
                log(I18n.t('logs.trapTimeout'));
            }
        }, ttl));
        return token;
    },
    clearTrapLock: (token?: string): boolean => {
        if (token) {
            const current = getActiveTrapLock();
            if (!current || current.token !== token) return false;
        }
        const removed = storage.sessionRemove(KEYS.trapLock);
        if (removed) clearTrapLockTimer();
        return removed;
    },
    hasTrapLock: (): boolean => !!getActiveTrapLock(),

    setLastAttemptID: (id?: string | null): boolean => id ? storage.sessionSet(KEYS.lastAttempt, id) : true,
    getLastAttemptID: (): string | null => storage.sessionGet(KEYS.lastAttempt),
    clearLastAttemptID: (): boolean => storage.sessionRemove(KEYS.lastAttempt),

    setLastVacancyMeta: (vid?: string | null, title?: string | null): void => {
        if (!title) return;
        storage.sessionSet(KEYS.lastVacancyMeta, JSON.stringify({
            vid: vid || '',
            title: String(title).slice(0, 300),
            ts: Date.now()
        }));
    },
    getLastVacancyMeta: (): any => parseJson(storage.sessionGet(KEYS.lastVacancyMeta), null),

    acquireInstanceLock: (tabId: string) => acquireInstanceLock(tabId),
    verifyInstanceLock: (tabId: string, leaseId?: string) => verifyInstanceLock(tabId, leaseId),
    releaseInstanceLock: (tabId: string, leaseId?: string) => releaseInstanceLock(tabId, leaseId),
    touchInstanceLock: (tabId: string, leaseId?: string) => touchInstanceLock(tabId, leaseId),
    guardOwnedCommit: (runId?: number) => guardOwnedCommit(runId),
    getCurrentInstanceLeaseId: () => currentInstanceLeaseId,

    getManualList: (): ManualQueueItem[] => {
        const list = parseJson(storage.localGet(KEYS.manualList), []);
        return Array.isArray(list) ? list : [];
    },
    addManualEntry: (entry: Partial<ManualQueueItem>): 'ADDED' | 'EXISTS' | 'UPDATED' | 'FAILED' => {
        try {
            const safeUrl = toSafeHhUrl(entry?.url);
            if (!safeUrl) return 'FAILED';
            const safeReturnUrl = toSafeHhUrl(entry?.returnUrl);
            const normalizedEntry: ManualQueueItem = {
                vid: String(entry?.vid || ('u_' + fnv1a32(safeUrl).toString(36))).slice(0, 120),
                url: safeUrl,
                returnUrl: safeReturnUrl || '',
                ts: Number.isFinite(Number((entry as any)?.ts)) ? Number((entry as any).ts) : Date.now(),
                title: prettifyTitle(entry?.title || '').slice(0, 300)
            } as any;
            const list = State.getManualList();
            const exists = list.find(e => e.vid === normalizedEntry.vid || e.url === normalizedEntry.url);
            if (!exists) {
                list.unshift(normalizedEntry);
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
    removeManualEntry: (vid: string): boolean => {
        try {
            const list = State.getManualList().filter(e => e.vid !== vid);
            return writeLocalVerified(KEYS.manualList, JSON.stringify(list));
        } catch (e) {
            console.warn('[HH Apply Assistant] removeManualEntry error', e);
            return false;
        }
    },
    clearManualList: (): boolean => {
        try {
            return removeLocalVerified(KEYS.manualList);
        } catch (e) {
            console.warn('[HH Apply Assistant] clearManualList error', e);
            return false;
        }
    }
};

export function ensureCurrentRunLimit(): boolean {
    const sentState = State.readSentCount();
    if (!sentState.ok) return false;
    const sent = sentState.value;
    if (sent <= config.limit) return true;
    return persistSettings({ ...config, limit: Math.min(500, sent) });
}
