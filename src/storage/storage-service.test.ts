import { test, expect, beforeEach } from 'vitest';
import {
    storage,
    KEYS,
    STORAGE_SCHEMA_VERSION,
    STORAGE_PREFIX,
    logStorageError,
    writeLocalVerified,
    removeLocalVerified,
    writeSessionVerified,
    removeSessionVerified,
    registerStorageHooks
} from './storage-service.js';

class MockStorage implements Storage {
    values = new Map<string, string>();
    throwOnSet = false;
    throwOnGet = false;
    throwOnRemove = false;
    errorTypeToThrow = 'QuotaExceededError';
    failSet = new Set<string>();
    failGet = new Set<string>();
    failRemove = new Set<string>();
    ignoreSet = new Set<string>();
    ignoreRemove = new Set<string>();

    get length() { return this.values.size; }
    clear() { this.values.clear(); }
    key(index: number) { return [...this.values.keys()][index] || null; }

    getItem(key: string) {
        if (this.throwOnGet || this.failGet.has(key)) {
            const err = new Error('SecurityError: Access is denied');
            err.name = 'SecurityError';
            throw err;
        }
        return this.values.has(key) ? this.values.get(key)! : null;
    }

    setItem(key: string, value: string) {
        if (this.throwOnSet || this.failSet.has(key)) {
            const err = new Error('QuotaExceededError: The quota has been exceeded');
            err.name = this.errorTypeToThrow;
            throw err;
        }
        if (this.ignoreSet.has(key)) return;
        this.values.set(key, String(value));
    }

    removeItem(key: string) {
        if (this.throwOnRemove || this.failRemove.has(key)) {
            const err = new Error('SecurityError: Access is denied');
            err.name = 'SecurityError';
            throw err;
        }
        if (this.ignoreRemove.has(key)) return;
        this.values.delete(key);
    }
}

let mockLocal: MockStorage;
let mockSession: MockStorage;

beforeEach(() => {
    mockLocal = new MockStorage();
    mockSession = new MockStorage();
    (globalThis as any).localStorage = mockLocal;
    (globalThis as any).sessionStorage = mockSession;
    (globalThis as any).window = globalThis;
});

test('Resilient storage layer catches QuotaExceededError and SecurityError safely without throwing uncaught exceptions', () => {
    expect(storage.localSet('test_key', 'test_val')).toBe(true);
    expect(storage.localGet('test_key')).toBe('test_val');
    const normalRead = storage.localRead('test_key');
    expect(normalRead.ok).toBe(true);
    expect(normalRead.value).toBe('test_val');

    mockLocal.throwOnSet = true;
    mockLocal.errorTypeToThrow = 'QuotaExceededError';
    expect(() => {
        const result = storage.localSet('overflow_key', 'some_big_data');
        expect(result).toBe(false);
    }).not.toThrow();

    mockLocal.throwOnSet = true;
    mockLocal.errorTypeToThrow = 'SecurityError';
    expect(() => {
        const result = storage.localSet('secure_key', 'val');
        expect(result).toBe(false);
    }).not.toThrow();

    mockLocal.throwOnGet = true;
    expect(() => {
        const getResult = storage.localGet('secure_key');
        expect(getResult).toBeNull();
        const readResult = storage.localRead('secure_key');
        expect(readResult.ok).toBe(false);
        expect(readResult.value).toBeNull();
    }).not.toThrow();

    expect(() => {
        logStorageError('local', 'setItem', KEYS.diagLog, new Error('Disk full'));
    }).not.toThrow();
});

test('Verified storage helpers validate write and remove outcomes against silent failure', () => {
    expect(writeLocalVerified('v_key', '123')).toBe(true);
    expect(storage.localGet('v_key')).toBe('123');
    expect(removeLocalVerified('v_key')).toBe(true);
    expect(storage.localGet('v_key')).toBeNull();

    expect(writeSessionVerified('s_key', '456')).toBe(true);
    expect(storage.sessionGet('s_key')).toBe('456');
    expect(removeSessionVerified('s_key')).toBe(true);
    expect(storage.sessionGet('s_key')).toBeNull();

    mockLocal.ignoreSet.add('silent_fail_key');
    expect(writeLocalVerified('silent_fail_key', 'val')).toBe(false);

    mockLocal.setItem('stubborn_key', 'stay');
    mockLocal.ignoreRemove.add('stubborn_key');
    expect(removeLocalVerified('stubborn_key')).toBe(false);
});

test('Storage schema namespace isolation and key validation', () => {
    expect(STORAGE_SCHEMA_VERSION).toBe(1);
    expect(STORAGE_PREFIX).toBe('hh_apply_assistant_s1_');
    for (const [name, key] of Object.entries(KEYS)) {
        expect(key.startsWith(STORAGE_PREFIX)).toBe(true);
    }
});
