import { deepFreeze } from '../dom/selectors.js';

// Версия storage schema меняется только при несовместимом формате persisted data.
export const STORAGE_SCHEMA_VERSION = 1;
export const STORAGE_PREFIX = `hh_apply_assistant_s${STORAGE_SCHEMA_VERSION}_`;

export const KEYS = deepFreeze({
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
});

export type StorageErrorLogger = (msg: string, err: boolean) => void;
export type StorageMetricsBumper = (metricName: string) => void;

let errorLoggerHook: StorageErrorLogger | null = null;
let metricsBumperHook: StorageMetricsBumper | null = null;

export function registerStorageHooks(logger: StorageErrorLogger | null, bumper: StorageMetricsBumper | null): void {
    errorLoggerHook = logger;
    metricsBumperHook = bumper;
}

export function logStorageError(storageType: 'local' | 'session', op: string, key: string, error: unknown): void {
    try {
        const err = error as { name?: string; message?: string } | null;
        const errName = (err && err.name) ? err.name : 'StorageError';
        const errMsg = (err && err.message) ? err.message : String(error || 'unknown');
        const logMsg = `[STORAGE_ERROR] ${storageType}.${op}("${key}"): ${errName} - ${errMsg}`;
        console.warn(`[HH Apply Assistant] ${logMsg}`);
        // Защита от бесконечной рекурсии при сбое записи логов и метрик
        if (key === KEYS.diagLog || key === KEYS.metrics) {
            return;
        }
        if (errorLoggerHook) {
            errorLoggerHook(logMsg, true);
        } else if (typeof (globalThis as any).DiagLog !== 'undefined' && typeof (globalThis as any).DiagLog.push === 'function') {
            (globalThis as any).DiagLog.push(logMsg, true);
        }

        if (metricsBumperHook) {
            metricsBumperHook(`storage.error.${storageType}.${op}`);
        } else if (typeof (globalThis as any).Metrics !== 'undefined' && typeof (globalThis as any).Metrics.bump === 'function') {
            (globalThis as any).Metrics.bump(`storage.error.${storageType}.${op}`);
        }
    } catch (_) {
        // Никогда не выбрасываем исключения из логгера хранилища
    }
}

export const getLocalStorage = (): Storage | null => {
    try {
        return typeof window !== 'undefined' && window.localStorage ? window.localStorage : (typeof localStorage !== 'undefined' ? localStorage : null);
    } catch (e) {
        logStorageError('local', 'access', 'localStorage', e);
        return null;
    }
};

export const getSessionStorage = (): Storage | null => {
    try {
        return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
    } catch (e) {
        logStorageError('session', 'access', 'sessionStorage', e);
        return null;
    }
};

export interface StorageReadResult {
    ok: boolean;
    value: string | null;
}

export const storage = {
    localGet: (key: string): string | null => {
        try {
            const s = getLocalStorage();
            return s ? s.getItem(key) : null;
        } catch (e) {
            logStorageError('local', 'getItem', key, e);
            return null;
        }
    },
    localRead: (key: string): StorageReadResult => {
        try {
            const s = getLocalStorage();
            if (!s) {
                logStorageError('local', 'read', key, new Error('localStorage unavailable'));
                return { ok: false, value: null };
            }
            return { ok: true, value: s.getItem(key) };
        } catch (e) {
            logStorageError('local', 'read', key, e);
            return { ok: false, value: null };
        }
    },
    localSet: (key: string, value: string): boolean => {
        try {
            const s = getLocalStorage();
            if (!s) {
                logStorageError('local', 'setItem', key, new Error('localStorage unavailable'));
                return false;
            }
            s.setItem(key, value);
            return true;
        } catch (e) {
            logStorageError('local', 'setItem', key, e);
            return false;
        }
    },
    localRemove: (key: string): boolean => {
        try {
            const s = getLocalStorage();
            if (!s) {
                logStorageError('local', 'removeItem', key, new Error('localStorage unavailable'));
                return false;
            }
            s.removeItem(key);
            return true;
        } catch (e) {
            logStorageError('local', 'removeItem', key, e);
            return false;
        }
    },
    sessionGet: (key: string): string | null => {
        try {
            const s = getSessionStorage();
            return s ? s.getItem(key) : null;
        } catch (e) {
            logStorageError('session', 'getItem', key, e);
            return null;
        }
    },
    sessionRead: (key: string): StorageReadResult => {
        try {
            const s = getSessionStorage();
            if (!s) {
                logStorageError('session', 'read', key, new Error('sessionStorage unavailable'));
                return { ok: false, value: null };
            }
            return { ok: true, value: s.getItem(key) };
        } catch (e) {
            logStorageError('session', 'read', key, e);
            return { ok: false, value: null };
        }
    },
    sessionSet: (key: string, value: string): boolean => {
        try {
            const s = getSessionStorage();
            if (!s) {
                logStorageError('session', 'setItem', key, new Error('sessionStorage unavailable'));
                return false;
            }
            s.setItem(key, value);
            return true;
        } catch (e) {
            logStorageError('session', 'setItem', key, e);
            return false;
        }
    },
    sessionRemove: (key: string): boolean => {
        try {
            const s = getSessionStorage();
            if (!s) {
                logStorageError('session', 'removeItem', key, new Error('sessionStorage unavailable'));
                return false;
            }
            s.removeItem(key);
            return true;
        } catch (e) {
            logStorageError('session', 'removeItem', key, e);
            return false;
        }
    }
};

export function writeSessionVerified(key: string, value: string | number): boolean {
    const expected = String(value);
    if (!storage.sessionSet(key, expected)) return false;
    const check = storage.sessionRead(key);
    return check.ok && check.value === expected;
}

export function removeSessionVerified(key: string): boolean {
    if (!storage.sessionRemove(key)) return false;
    const check = storage.sessionRead(key);
    return check.ok && check.value === null;
}

export function writeLocalVerified(key: string, value: string | number): boolean {
    const expected = String(value);
    if (!storage.localSet(key, expected)) return false;
    const check = storage.localRead(key);
    return check.ok && check.value === expected;
}

export function removeLocalVerified(key: string): boolean {
    if (!storage.localRemove(key)) return false;
    const check = storage.localRead(key);
    return check.ok && check.value === null;
}
