import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    TAB_ID,
    isRunCurrent,
    guardOwnedCommit,
    acquireInstanceLock,
    verifyInstanceLock,
    releaseInstanceLock,
    touchInstanceLock,
    currentInstanceLeaseId,
    instanceLeaseVerified,
    hasActiveWebLock,
    setStopSignal,
    setRunId,
    currentRunId
} from './concurrency.js';
import { storage, KEYS } from '../storage/storage-service.js';
import { State } from './state-manager.js';

const ROOT = path.resolve(__dirname, '../../');
const SCRIPT_PATH = path.join(ROOT, 'hh-apply-assistant.user.js');
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, 'utf8');
const TTL = 30_000;

class FakeStorage implements Storage {
    values = new Map<string, string>();
    failGet = new Set<string>();
    failSet = new Set<string>();
    failRemove = new Set<string>();
    ignoreSet = new Set<string>();

    constructor(initial: Record<string, string> = {}) {
        Object.entries(initial).forEach(([k, v]) => this.values.set(k, String(v)));
    }

    get length() { return this.values.size; }
    clear() { this.values.clear(); }
    key(index: number) { return [...this.values.keys()][index] || null; }

    getItem(key: string) {
        if (this.failGet.has(key)) throw new Error(`getItem failed: ${key}`);
        return this.values.has(key) ? this.values.get(key)! : null;
    }
    setItem(key: string, value: string) {
        if (this.failSet.has(key)) throw new Error(`setItem failed: ${key}`);
        if (this.ignoreSet.has(key)) return;
        this.values.set(key, String(value));
    }
    removeItem(key: string) {
        if (this.failRemove.has(key)) throw new Error(`removeItem failed: ${key}`);
        this.values.delete(key);
    }
}

function storedLease(storageInst: FakeStorage) {
    const raw = storageInst.getItem(KEYS.instanceLock);
    return raw ? JSON.parse(raw) : null;
}

let mockLocal: FakeStorage;
let mockSession: FakeStorage;

beforeEach(() => {
    mockLocal = new FakeStorage();
    mockSession = new FakeStorage();
    (globalThis as any).localStorage = mockLocal;
    (globalThis as any).sessionStorage = mockSession;
    Object.defineProperty(globalThis, 'navigator', {
        value: { language: 'ru-RU' },
        configurable: true,
        writable: true
    });
    setStopSignal(false);
    setRunId(0);
});

afterEach(() => {
    vi.useRealTimers();
});

test('previous namespace lease is ignored and left untouched', async () => {
    const previousKey = 'hh_ar_v2_instance_lock';
    const previousLease = JSON.stringify({ tabId: 'previous-tab', ts: 1_000 });
    mockLocal.setItem(previousKey, previousLease);

    const acquired = await acquireInstanceLock('current-tab');
    expect(acquired).toBe(true);
    expect(storedLease(mockLocal).tabId).toBe('current-tab');
    expect(mockLocal.getItem(previousKey)).toBe(previousLease);
});

test('invalid current lease schema is fail-closed and not rewritten', async () => {
    const invalidLease = { tabId: 'unknown-tab', ts: Date.now() };
    mockLocal.setItem(KEYS.instanceLock, JSON.stringify(invalidLease));

    const acquired = await acquireInstanceLock('current-tab');
    expect(acquired).toBe(false);
    expect(storedLease(mockLocal)).toEqual(invalidLease);
    expect(verifyInstanceLock('current-tab')).toBe('LOST');
});

test('A acquires a generated lease and B cannot acquire it while active', async () => {
    const acquiredA = await acquireInstanceLock('tab-a');
    expect(acquiredA).toBe(true);
    const leaseA = storedLease(mockLocal);
    expect(leaseA.tabId).toBe('tab-a');
    expect(typeof leaseA.leaseId).toBe('string');
    expect(leaseA.leaseId.length).toBeGreaterThan(0);

    const acquiredB = await acquireInstanceLock('tab-b');
    expect(acquiredB).toBe(false);
    expect(storedLease(mockLocal)).toEqual(leaseA);
});

test('expired A lease can be replaced by a new B generation', async () => {
    const acquiredA = await acquireInstanceLock('tab-a');
    expect(acquiredA).toBe(true);
    const oldLeaseId = storedLease(mockLocal).leaseId;

    // Simulate clock advance beyond TTL
    const lease = storedLease(mockLocal);
    lease.ts = Date.now() - (TTL + 100);
    mockLocal.setItem(KEYS.instanceLock, JSON.stringify(lease));

    const acquiredB = await acquireInstanceLock('tab-b');
    expect(acquiredB).toBe(true);
    const next = storedLease(mockLocal);
    expect(next.tabId).toBe('tab-b');
    expect(next.leaseId).not.toBe(oldLeaseId);
});

test('A ownership verification fails after B takeover', async () => {
    expect(await acquireInstanceLock('tab-a')).toBe(true);

    // Simulate expire and B takeover
    const lease = storedLease(mockLocal);
    lease.tabId = 'tab-b';
    lease.leaseId = 'tab-b_new_lease';
    lease.ts = Date.now();
    mockLocal.setItem(KEYS.instanceLock, JSON.stringify(lease));

    expect(verifyInstanceLock('tab-a')).toBe('LOST');
});

test('stale A heartbeat cannot overwrite B lease', async () => {
    expect(await acquireInstanceLock('tab-a')).toBe(true);

    const bLease = { tabId: 'tab-b', leaseId: 'tab-b_lease', ts: Date.now() };
    mockLocal.setItem(KEYS.instanceLock, JSON.stringify(bLease));

    expect(touchInstanceLock('tab-a')).toBe('LOST');
    expect(storedLease(mockLocal)).toEqual(bLease);
});

test('stale A release cannot delete B lease', async () => {
    expect(await acquireInstanceLock('tab-a')).toBe(true);

    const bLease = { tabId: 'tab-b', leaseId: 'tab-b_lease', ts: Date.now() };
    mockLocal.setItem(KEYS.instanceLock, JSON.stringify(bLease));

    expect(releaseInstanceLock('tab-a', 'stale-lease-id')).toBe(false);
    expect(storedLease(mockLocal)).toEqual(bLease);
});

test('same TAB_ID old generation cannot delete a newer generation', async () => {
    expect(await acquireInstanceLock('same-tab')).toBe(true);
    const oldLeaseId = storedLease(mockLocal).leaseId;

    expect(await acquireInstanceLock('same-tab')).toBe(true);
    const newLease = storedLease(mockLocal);
    expect(newLease.leaseId).not.toBe(oldLeaseId);

    expect(releaseInstanceLock('same-tab', oldLeaseId)).toBe(false);
    expect(storedLease(mockLocal)).toEqual(newLease);
});

test('search -> vacancy -> response -> search keeps TAB_ID and fences every page generation', async () => {
    const leaseIds: string[] = [];
    for (let i = 0; i < 4; i++) {
        expect(await acquireInstanceLock('navigation-tab')).toBe(true);
        leaseIds.push(storedLease(mockLocal).leaseId);
    }
    expect(new Set(leaseIds).size).toBe(4);
    expect(verifyInstanceLock('navigation-tab')).toBe('OWNED');

    for (const staleLeaseId of leaseIds.slice(0, -1)) {
        expect(releaseInstanceLock('navigation-tab', staleLeaseId)).toBe(false);
    }
    expect(storedLease(mockLocal).leaseId).toBe(leaseIds.at(-1));
});

test('storage write failure during reacquire is not mistaken for ownership', async () => {
    expect(await acquireInstanceLock('tab-a')).toBe(true);
    mockLocal.failSet.add(KEYS.instanceLock);
    expect(await acquireInstanceLock('tab-a')).toBe(false);
    expect(verifyInstanceLock('tab-a')).toBe('LOST');
});

test('storage read failure during acquire is fail-closed', async () => {
    mockLocal.failGet.add(KEYS.instanceLock);
    expect(await acquireInstanceLock('tab-a')).toBe(false);
});

test('acquire requires exact read-back of the newly written generation', async () => {
    mockLocal.setItem(KEYS.instanceLock, JSON.stringify({ tabId: 'tab-a', leaseId: 'older-generation', ts: 1_000 }));
    mockLocal.ignoreSet.add(KEYS.instanceLock);
    expect(await acquireInstanceLock('tab-a')).toBe(false);
    expect(storedLease(mockLocal).leaseId).toBe('older-generation');
});

test('storage failure during heartbeat loses ownership', async () => {
    expect(await acquireInstanceLock('tab-a')).toBe(true);
    mockLocal.failSet.add(KEYS.instanceLock);
    expect(touchInstanceLock('tab-a')).toBe('LOST');
    expect(verifyInstanceLock('tab-a')).toBe('LOST');
});

test('heartbeat requires read-back of its exact renewed timestamp', async () => {
    expect(await acquireInstanceLock('tab-a')).toBe(true);
    mockLocal.ignoreSet.add(KEYS.instanceLock);
    expect(touchInstanceLock('tab-a')).toBe('LOST');
});

test('stale async continuation cannot pass commit guard after takeover', async () => {
    State.setRunning(true);
    expect(await acquireInstanceLock(TAB_ID)).toBe(true);

    let irreversibleActions = 0;
    // Simulate takeover by modifying storage lease
    const bLease = { tabId: 'tab-b', leaseId: 'tab-b_lease', ts: Date.now() };
    mockLocal.setItem(KEYS.instanceLock, JSON.stringify(bLease));

    if (guardOwnedCommit(0)) {
        irreversibleActions++;
    }
    expect(irreversibleActions).toBe(0);
});

test('normal single-tab acquire, renew, guarded commit and release remain valid', async () => {
    State.setRunning(true);
    expect(await acquireInstanceLock(TAB_ID)).toBe(true);
    expect(verifyInstanceLock(TAB_ID)).toBe('OWNED');
    const beforeTouch = storedLease(mockLocal);

    expect(guardOwnedCommit(0)).toBe(true);
    expect(storedLease(mockLocal).ts).toBeGreaterThanOrEqual(beforeTouch.ts);
    expect(releaseInstanceLock(TAB_ID)).toBe(true);
    expect(storedLease(mockLocal)).toBeNull();
});

test('actual final-click and form.submit paths are wired to the commit guard', () => {
    const realisticBody = SCRIPT_SOURCE.slice(
        SCRIPT_SOURCE.indexOf('async function realisticClick'),
        SCRIPT_SOURCE.indexOf('function safeClick')
    );
    const submitBody = SCRIPT_SOURCE.slice(
        SCRIPT_SOURCE.indexOf('async function fillLetterAndSubmit'),
        SCRIPT_SOURCE.indexOf('async function forceSubmitReject')
    );
    const terminalBody = SCRIPT_SOURCE.slice(
        SCRIPT_SOURCE.indexOf('function persistProcessedVacancy'),
        SCRIPT_SOURCE.indexOf('async function submitResponsePage')
    );
    expect(realisticBody).toMatch(/guardOwnedCommit\(runId\)/);
    expect(submitBody).toMatch(/guardOwnedCommit\(runId\)[\s\S]*form\.submit\(\)/);
    expect(terminalBody).toMatch(/function persistProcessedVacancy[\s\S]*guardOwnedCommit\(runId\)/);
    expect(terminalBody).toMatch(/function persistSentCount[\s\S]*guardOwnedCommit\(runId\)/);
    expect(terminalBody).toMatch(/function returnToList[\s\S]*guardOwnedCommit\(runId\)/);
    expect(SCRIPT_SOURCE).toMatch(/addRuntimeListener\(window, 'pageshow'[\s\S]*event\.persisted[\s\S]*startLoop\(\)/);
});

test('Web Locks API integration: acquires exclusive lock, aborts gracefully, and falls back to storage verification', async () => {
    let requestedMode: string | undefined;
    let requestedIfAvailable: boolean | undefined;

    const fakeLocks = {
        async request(name: string, options: any, callback: (lock: any) => any) {
            requestedMode = options?.mode;
            requestedIfAvailable = options?.ifAvailable;
            if (options?.signal?.aborted) throw new Error('Aborted');
            const fakeLock = { name, mode: options?.mode };
            return callback(fakeLock);
        }
    };
    Object.defineProperty(globalThis, 'navigator', {
        value: { language: 'ru-RU', locks: fakeLocks },
        configurable: true,
        writable: true
    });

    const acquired = await acquireInstanceLock(TAB_ID);
    expect(acquired).toBe(true);
    expect(requestedMode).toBe('exclusive');
    expect(requestedIfAvailable).toBe(true);
    expect(verifyInstanceLock(TAB_ID)).toBe('OWNED');

    const released = releaseInstanceLock(TAB_ID);
    expect(released).toBe(true);
});

test('Web Locks API integration: holding promise stays pending until releaseInstanceLock is called', async () => {
    let lockHolderSettled = false;
    const fakeLocks = {
        async request(name: string, options: any, callback: (lock: any) => any) {
            const fakeLock = { name, mode: options?.mode };
            const p = callback(fakeLock);
            p.then(() => { lockHolderSettled = true; });
            return p;
        }
    };
    Object.defineProperty(globalThis, 'navigator', {
        value: { language: 'ru-RU', locks: fakeLocks },
        configurable: true,
        writable: true
    });

    const acquired = await acquireInstanceLock(TAB_ID);
    expect(acquired).toBe(true);
    expect(lockHolderSettled).toBe(false);

    releaseInstanceLock(TAB_ID);
    await Promise.resolve();
    expect(lockHolderSettled).toBe(true);
});

test('Web Locks API integration: ifAvailable returns null when already held by another tab, failing acquisition closed', async () => {
    const fakeLocks = {
        async request(name: string, options: any, callback: (lock: any) => any) {
            return callback(null);
        }
    };
    Object.defineProperty(globalThis, 'navigator', {
        value: { language: 'ru-RU', locks: fakeLocks },
        configurable: true,
        writable: true
    });

    const acquired = await acquireInstanceLock(TAB_ID);
    expect(acquired).toBe(false);
});

test('Web Locks fallback: when navigator.locks is unavailable, acquisition succeeds via localStorage verification', async () => {
    Object.defineProperty(globalThis, 'navigator', {
        value: { language: 'ru-RU' },
        configurable: true,
        writable: true
    });
    const acquired = await acquireInstanceLock(TAB_ID);
    expect(acquired).toBe(true);
});
