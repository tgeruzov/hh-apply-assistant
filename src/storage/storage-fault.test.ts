import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    storage,
    KEYS,
    getLocalStorage,
    getSessionStorage,
    logStorageError,
    writeLocalVerified,
    removeLocalVerified,
    writeSessionVerified,
    removeSessionVerified,
    registerStorageHooks
} from './storage-service.js';
import {
    Settings,
    State,
    Stats,
    DiagLog,
    Metrics,
    config,
    persistSettings,
    currentStatusState
} from '../core/state-manager.js';
import {
    getActiveTrapLock,
    readInstanceLock,
    verifyInstanceLock,
    acquireInstanceLock,
    setStopSignal,
    setRunId
} from '../core/concurrency.js';
import { DEFAULTS, DEFAULT_PRESET, getDefaultCoverText } from '../i18n/index.js';

class FaultInjectingStorage implements Storage {
    values = new Map<string, string>();
    quotaExceededOnSet = false;
    securityErrorOnAll = false;
    failKeys = new Set<string>();

    get length() {
        if (this.securityErrorOnAll) {
            const err = new Error('SecurityError: Access is denied');
            err.name = 'SecurityError';
            throw err;
        }
        return this.values.size;
    }

    clear() {
        if (this.securityErrorOnAll) {
            const err = new Error('SecurityError: Access is denied');
            err.name = 'SecurityError';
            throw err;
        }
        this.values.clear();
    }

    key(index: number) {
        if (this.securityErrorOnAll) {
            const err = new Error('SecurityError: Access is denied');
            err.name = 'SecurityError';
            throw err;
        }
        return [...this.values.keys()][index] || null;
    }

    getItem(key: string) {
        if (this.securityErrorOnAll || this.failKeys.has(key)) {
            const err = new Error('SecurityError: Access is denied');
            err.name = 'SecurityError';
            throw err;
        }
        return this.values.has(key) ? this.values.get(key)! : null;
    }

    setItem(key: string, value: string) {
        if (this.securityErrorOnAll) {
            const err = new Error('SecurityError: Access is denied');
            err.name = 'SecurityError';
            throw err;
        }
        if (this.quotaExceededOnSet || this.failKeys.has(key)) {
            const err = new Error('QuotaExceededError: The quota has been exceeded');
            err.name = 'QuotaExceededError';
            throw err;
        }
        this.values.set(key, String(value));
    }

    removeItem(key: string) {
        if (this.securityErrorOnAll || this.failKeys.has(key)) {
            const err = new Error('SecurityError: Access is denied');
            err.name = 'SecurityError';
            throw err;
        }
        this.values.delete(key);
    }
}

let mockLocal: FaultInjectingStorage;
let mockSession: FaultInjectingStorage;

beforeEach(() => {
    mockLocal = new FaultInjectingStorage();
    mockSession = new FaultInjectingStorage();

    (globalThis as any).localStorage = mockLocal;
    (globalThis as any).sessionStorage = mockSession;
    (globalThis as any).window = globalThis;

    DiagLog.clear();
    Metrics.clear();
    Stats.reset();
    setStopSignal(false);
    setRunId(0);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('Storage Fault Injection & Data Corruption Suite', () => {

    describe('1. QuotaExceededError Fault Injection', () => {

        test('persistSettings gracefully halts running automation without uncaught exceptions on QuotaExceededError', () => {
            // Emulate running automation state
            State.setRunning(true);
            expect(State.amIRunning()).toBe(true);

            // Trigger QuotaExceededError on localStorage.setItem
            mockLocal.quotaExceededOnSet = true;

            let result = true;
            expect(() => {
                result = persistSettings({ limit: 350, coverText: 'Important application text' });
            }).not.toThrow();

            // Must report failure
            expect(result).toBe(false);

            // Automation must be stopped fail-closed to prevent running without persisted state
            expect(State.amIRunning()).toBe(false);
            expect(currentStatusState.statusKey).toBe('error');

            // Must have recorded failure in DiagLog and bumped metrics
            const logs = DiagLog.getAll();
            expect(logs.some(l => l.lvl === 'ERR' || l.msg.includes('settings'))).toBe(true);
            const metrics = Metrics.getAll();
            expect(metrics.counters['settings.save.failed']).toBeGreaterThanOrEqual(1);
        });

        test('State.addManualEntry returns FAILED without throwing when localStorage has QuotaExceededError', () => {
            mockLocal.quotaExceededOnSet = true;

            let status: string = '';
            expect(() => {
                status = State.addManualEntry({
                    vid: '10928374',
                    url: 'https://hh.ru/vacancy/10928374',
                    title: 'Frontend Engineer'
                });
            }).not.toThrow();

            expect(status).toBe('FAILED');
        });

        test('DiagLog aggressively trims to 300 entries on QuotaExceededError and continues accumulating in RAM', () => {
            // Pre-fill 350 log entries in memory
            for (let i = 0; i < 350; i++) {
                DiagLog.push(`Log message test #${i}`, false);
            }

            expect(DiagLog.getAll().length).toBe(350);

            // Force quota error on storage write
            mockLocal.quotaExceededOnSet = true;

            // Trigger flushSync
            expect(() => {
                DiagLog.flush();
            }).not.toThrow();

            // Cache is trimmed to 300 entries on quota overflow attempt
            const currentLogs = DiagLog.getAll();
            expect(currentLogs.length).toBeLessThanOrEqual(300);

            // RAM storage remains fully operational
            expect(() => {
                DiagLog.push('Post-quota error in-memory message', true);
            }).not.toThrow();

            const finalLogs = DiagLog.getAll();
            expect(finalLogs[finalLogs.length - 1].msg).toBe('Post-quota error in-memory message');
        });

        test('Metrics snapshots are trimmed to 3 on QuotaExceededError without crashing', () => {
            for (let i = 0; i < 10; i++) {
                Metrics.snapshot(`snapshot-${i}`, { count: i });
            }

            mockLocal.quotaExceededOnSet = true;

            expect(() => {
                Metrics.snapshot('overflow-snapshot', { count: 99 });
            }).not.toThrow();

            const allMetrics = Metrics.getAll();
            expect(allMetrics.snapshots.length).toBeLessThanOrEqual(4);
        });

        test('State.addProcessedID safely returns false when sessionStorage hits QuotaExceededError', () => {
            mockSession.quotaExceededOnSet = true;

            let added = true;
            expect(() => {
                added = State.addProcessedID('v_998877');
            }).not.toThrow();

            expect(added).toBe(false);
        });
    });

    describe('2. SecurityError Fault Injection (Private Browsing / Storage Blocked)', () => {

        beforeEach(() => {
            mockLocal.securityErrorOnAll = true;
            mockSession.securityErrorOnAll = true;
        });

        test('Storage layer methods fail-open / return null without throwing on complete Storage lockdown', () => {
            expect(storage.localGet('any_key')).toBeNull();
            expect(storage.localSet('any_key', 'val')).toBe(false);
            expect(storage.localRead('any_key')).toEqual({ ok: false, value: null });
            expect(storage.localRemove('any_key')).toBe(false);

            expect(storage.sessionGet('any_key')).toBeNull();
            expect(storage.sessionSet('any_key', 'val')).toBe(false);
            expect(storage.sessionRead('any_key')).toEqual({ ok: false, value: null });
            expect(storage.sessionRemove('any_key')).toBe(false);
        });

        test('Settings.load() gracefully returns default application settings under Storage lockdown', () => {
            const loaded = Settings.load();
            expect(loaded).toBeDefined();
            expect(loaded.limit).toBe(DEFAULTS.limit);
            expect(loaded.preset).toBe(DEFAULT_PRESET);
            expect(loaded.useCover).toBe(DEFAULTS.useCover);
            expect(typeof loaded.coverText).toBe('string');
        });

        test('State and Stats methods maintain safe fallbacks without throwing under SecurityError', () => {
            expect(State.amIRunning()).toBe(false);
            expect(State.getSentCount()).toBe(0);
            expect(State.getProcessedIDs().size).toBe(0);
            expect(State.getManualList()).toEqual([]);

            const stats = Stats.getAll();
            expect(stats).toEqual({
                attempts: 0,
                success: 0,
                manual: 0,
                skipped: 0
            });
        });

        test('logStorageError does not recursively crash when logging errors for diagLog or metrics keys', () => {
            expect(() => {
                logStorageError('local', 'setItem', KEYS.diagLog, new Error('Blocked'));
                logStorageError('local', 'setItem', KEYS.metrics, new Error('Blocked'));
            }).not.toThrow();
        });
    });

    describe('3. JSON Corruption & State Normalization Fault Injection', () => {

        test('Settings.normalize and Settings.load recover from corrupted JSON payloads across all variations', () => {
            const corruptedPayloads = [
                '{bad_json:',
                'null',
                'undefined',
                '"just a string"',
                '[1, 2, 3]',
                '{"limit": "NOT_A_NUMBER", "preset": "INVALID_PRESET_123", "useCover": "invalid"}',
                '{"limit": 99999, "coverText": null}',
                '{"limit": -50, "coverText": 12345}',
                '\x00\x01\x02\xFF\xFE'
            ];

            for (const payload of corruptedPayloads) {
                mockLocal.values.set(KEYS.settings, payload);

                let loaded!: any;
                expect(() => {
                    loaded = Settings.load();
                }).not.toThrow();

                expect(loaded).toBeDefined();
                expect(typeof loaded.coverText).toBe('string');
                expect(typeof loaded.useCover).toBe('boolean');
                expect(typeof loaded.limit).toBe('number');
                expect(loaded.limit).toBeGreaterThanOrEqual(1);
                expect(loaded.limit).toBeLessThanOrEqual(500);
                expect(typeof loaded.preset).toBe('string');
            }
        });

        test('State.getManualList recovers cleanly from corrupted JSON structures', () => {
            const corruptedManualPayloads = [
                'invalid { json [',
                'null',
                '"a single string instead of array"',
                '{"vid": "123"}', // object instead of array
                '[null, 123, "invalid", {}]'
            ];

            for (const payload of corruptedManualPayloads) {
                mockLocal.values.set(KEYS.manualList, payload);

                let list: any;
                expect(() => {
                    list = State.getManualList();
                }).not.toThrow();

                expect(Array.isArray(list)).toBe(true);
            }
        });

        test('State.readProcessedIDs safely handles corrupted history JSON', () => {
            mockSession.values.set(KEYS.history, '{ corrupt: [ unclosed');

            const res = State.readProcessedIDs();
            expect(res.ok).toBe(true);
            expect(res.value instanceof Set).toBe(true);
            expect(res.value.size).toBe(0);
        });

        test('getActiveTrapLock discards corrupted or expired trap records safely', () => {
            const badTraps = [
                'malformed json',
                JSON.stringify({ token: 123, expiresAt: 'invalid' }),
                JSON.stringify({ token: '', expiresAt: Date.now() + 10000 }),
                JSON.stringify({ token: 'tok_1', expiresAt: Date.now() - 5000 }) // already expired
            ];

            for (const trap of badTraps) {
                mockSession.values.set(KEYS.trapLock, trap);

                let activeTrap: any;
                expect(() => {
                    activeTrap = getActiveTrapLock();
                }).not.toThrow();

                expect(activeTrap).toBeNull();
            }
        });

        test('readInstanceLock and verifyInstanceLock handle corrupted instance lease JSON safely', () => {
            mockLocal.values.set(KEYS.instanceLock, '<<<not valid json>>>');

            const read = readInstanceLock();
            expect(read.ok).toBe(true);
            expect(read.lock).toBeNull();

            const verification = verifyInstanceLock('tab-corrupt', 'tab-corrupt-lease');
            expect(verification).toBe('LOST');
        });

        test('Stats._get recovers safely when stats key is corrupted', () => {
            mockSession.values.set(KEYS.stats, '{"corrupted": NaN, "success": "bad"}');

            const stats = Stats.getAll();
            expect(stats.attempts).toBe(0);
            expect(stats.success).toBe(0);
            expect(stats.manual).toBe(0);
            expect(stats.skipped).toBe(0);
        });
    });
});
