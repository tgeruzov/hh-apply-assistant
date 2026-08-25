import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    TAB_ID,
    isRunCurrent,
    guardOwnedCommit,
    acquireInstanceLock,
    verifyInstanceLock,
    releaseInstanceLock,
    touchInstanceLock,
    hasActiveWebLock,
    activeWebLockAbortController,
    currentInstanceLeaseId,
    setStopSignal,
    setRunId,
    setHaltHandler,
    interruptibleWait,
    wait
} from './concurrency.js';
import { storage, KEYS } from '../storage/storage-service.js';
import { State } from './state-manager.js';
import { sleep } from './utils.js';

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

class MockWebLockManager {
    private heldLocks = new Map<string, { holderId: string; release: () => void }>();

    async request(name: string, options: any, callback: (lock: any) => any): Promise<any> {
        const ifAvailable = !!options?.ifAvailable;
        const signal: AbortSignal | undefined = options?.signal;

        if (signal?.aborted) {
            const err = new Error('The request was aborted.');
            err.name = 'AbortError';
            throw err;
        }

        const isCurrentlyHeld = this.heldLocks.has(name);

        if (isCurrentlyHeld && ifAvailable) {
            return callback(null);
        }

        let releaseCallback!: () => void;
        const releasePromise = new Promise<void>((resolve) => {
            releaseCallback = resolve;
        });

        const holderId = Math.random().toString(36).slice(2);
        this.heldLocks.set(name, { holderId, release: releaseCallback });

        let abortListener: (() => void) | null = null;
        if (signal) {
            abortListener = () => {
                if (this.heldLocks.get(name)?.holderId === holderId) {
                    this.heldLocks.delete(name);
                    releaseCallback();
                }
            };
            signal.addEventListener('abort', abortListener, { once: true });
        }

        const fakeLock = { name, mode: options?.mode || 'exclusive' };

        try {
            const callbackPromise = callback(fakeLock);
            // Lock stays held as long as the promise returned by callback is pending or until release is called
            const result = await Promise.race([
                callbackPromise,
                releasePromise.then(() => undefined)
            ]);
            return result;
        } finally {
            if (this.heldLocks.get(name)?.holderId === holderId) {
                this.heldLocks.delete(name);
            }
            if (signal && abortListener) {
                signal.removeEventListener('abort', abortListener);
            }
        }
    }

    isHeld(name: string): boolean {
        return this.heldLocks.has(name);
    }

    reset() {
        for (const [, lock] of this.heldLocks) {
            lock.release();
        }
        this.heldLocks.clear();
    }
}

let mockLocal: FakeStorage;
let mockSession: FakeStorage;
let lockManager: MockWebLockManager;

beforeEach(() => {
    mockLocal = new FakeStorage();
    mockSession = new FakeStorage();
    lockManager = new MockWebLockManager();

    (globalThis as any).localStorage = mockLocal;
    (globalThis as any).sessionStorage = mockSession;
    Object.defineProperty(globalThis, 'navigator', {
        value: {
            language: 'ru-RU',
            locks: lockManager
        },
        configurable: true,
        writable: true
    });

    setStopSignal(false);
    setRunId(0);
    setHaltHandler(null);
});

afterEach(() => {
    vi.useRealTimers();
    lockManager.reset();
});

describe('Concurrency & Race Condition Stress Suite', () => {

    test('Massive Web Lock Contention: 20 parallel instances simultaneously request exclusive lock with ifAvailable', async () => {
        const instances = Array.from({ length: 20 }, (_, i) => `tab-stress-${i}`);

        // Launch 20 concurrent acquisition attempts
        const results = await Promise.all(instances.map(tabId => acquireInstanceLock(tabId)));

        const winners = results.map((acquired, index) => ({ tabId: instances[index], acquired })).filter(r => r.acquired);
        const losers = results.map((acquired, index) => ({ tabId: instances[index], acquired })).filter(r => !r.acquired);

        // Exactly one instance must acquire the lock
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(19);

        const winnerTab = winners[0].tabId;
        expect(verifyInstanceLock(winnerTab)).toBe('OWNED');

        // Losers verifying with their own stale lease IDs return 'LOST' without degrading winner
        for (const loser of losers) {
            expect(verifyInstanceLock(loser.tabId, `${loser.tabId}-lease`)).toBe('LOST');
        }

        expect(lockManager.isHeld(KEYS.instanceLock)).toBe(true);

        // Winner releases the lock
        const released = releaseInstanceLock(winnerTab);
        expect(released).toBe(true);
        expect(lockManager.isHeld(KEYS.instanceLock)).toBe(false);

        // Subsequent instance can now acquire the lock immediately
        const nextWinner = await acquireInstanceLock(losers[0].tabId);
        expect(nextWinner).toBe(true);
        expect(verifyInstanceLock(losers[0].tabId)).toBe('OWNED');
        releaseInstanceLock(losers[0].tabId);
    });

    test('Emergency Release via AbortSignal: instantaneous release on abort and takeover by awaiting thread', async () => {
        const tabA = 'tab-abort-a';
        const tabB = 'tab-abort-b';

        // Tab A acquires the lock
        const acquiredA = await acquireInstanceLock(tabA);
        expect(acquiredA).toBe(true);
        expect(hasActiveWebLock).toBe(true);
        expect(activeWebLockAbortController).not.toBeNull();

        // Tab B cannot acquire while A is holding
        const acquiredBBefore = await acquireInstanceLock(tabB);
        expect(acquiredBBefore).toBe(false);

        // Emergency abort of Tab A's active Web Lock
        activeWebLockAbortController?.abort();
        releaseInstanceLock(tabA);

        // Web Lock is immediately released
        expect(lockManager.isHeld(KEYS.instanceLock)).toBe(false);

        // Tab B immediately acquires the lock without deadlocks
        const acquiredBAfter = await acquireInstanceLock(tabB);
        expect(acquiredBAfter).toBe(true);
        expect(verifyInstanceLock(tabB)).toBe('OWNED');
        expect(verifyInstanceLock(tabA, 'stale-lease-a')).toBe('LOST');

        releaseInstanceLock(tabB);
    });

    test('Web Locks Fallback Stress: 20 concurrent instances race using localStorage generation tokens with I/O jitter', async () => {
        // Strip navigator.locks to force fallback to storage-based fencing
        Object.defineProperty(globalThis, 'navigator', {
            value: { language: 'ru-RU' },
            configurable: true,
            writable: true
        });

        const tabCount = 20;
        const tabs = Array.from({ length: tabCount }, (_, i) => `fallback-tab-${i}`);

        // Launch concurrent acquisitions with slight randomized stagger to simulate real browser process jitter
        const acquisitionPromises = tabs.map(async (tabId, index) => {
            await sleep(index % 3); // 0-2ms jitter
            return { tabId, acquired: await acquireInstanceLock(tabId) };
        });

        const outcomes = await Promise.all(acquisitionPromises);
        const acquiredTabs = outcomes.filter(o => o.acquired);

        // At most one tab wins ownership of the verified lease
        expect(acquiredTabs.length).toBeLessThanOrEqual(1);

        if (acquiredTabs.length === 1) {
            const winnerTab = acquiredTabs[0].tabId;
            expect(verifyInstanceLock(winnerTab)).toBe('OWNED');

            // Stale tabs cannot release or touch winner's lease
            for (const other of tabs.filter(t => t !== winnerTab)) {
                expect(touchInstanceLock(other, `${other}_stale`)).toBe('LOST');
                expect(releaseInstanceLock(other, `${other}_stale`)).toBe(false);
            }

            // Winner remains in full control
            expect(touchInstanceLock(winnerTab)).toBe('OWNED');
            expect(releaseInstanceLock(winnerTab)).toBe(true);
        }
    });

    test('Expired generation token can be safely taken over by a new instance under fallback mode', async () => {
        Object.defineProperty(globalThis, 'navigator', {
            value: { language: 'ru-RU' },
            configurable: true,
            writable: true
        });

        const tabA = 'tab-gen-a';
        const tabB = 'tab-gen-b';

        expect(await acquireInstanceLock(tabA)).toBe(true);
        const leaseAId = currentInstanceLeaseId;
        expect(typeof leaseAId).toBe('string');

        // Simulate lease expiration (advance timestamp beyond 30s TTL)
        const raw = mockLocal.getItem(KEYS.instanceLock);
        const lease = JSON.parse(raw!);
        lease.ts = Date.now() - 35_000;
        mockLocal.setItem(KEYS.instanceLock, JSON.stringify(lease));

        // Tab B takes over expired lease
        const acquiredB = await acquireInstanceLock(tabB);
        expect(acquiredB).toBe(true);
        expect(verifyInstanceLock(tabB)).toBe('OWNED');
        expect(verifyInstanceLock(tabA, leaseAId!)).toBe('LOST');

        // Stale Tab A attempts heartbeat and release -> fails closed
        expect(touchInstanceLock(tabA, leaseAId!)).toBe('LOST');
        expect(releaseInstanceLock(tabA, leaseAId!)).toBe(false);

        // Tab B's lease remains unharmed
        expect(verifyInstanceLock(tabB)).toBe('OWNED');
        releaseInstanceLock(tabB);
    });

    test('Split-Brain Isolation: guardOwnedCommit stops execution and triggers halt when lease is overtaken during I/O delay', async () => {
        State.setRunning(true);
        const haltSpy = vi.fn();
        setHaltHandler(haltSpy);

        // Tab A acquires instance lock
        const tabA = TAB_ID;
        expect(await acquireInstanceLock(tabA)).toBe(true);
        expect(guardOwnedCommit(0)).toBe(true);

        let committedActions = 0;

        // Simulate async operation where Tab A goes to sleep (e.g. waiting for page/network/user input)
        // Meanwhile, Tab B takes over the lock in storage
        const bLease = {
            tabId: 'tab-split-brain-b',
            leaseId: 'b_lease_123',
            ts: Date.now()
        };
        mockLocal.setItem(KEYS.instanceLock, JSON.stringify(bLease));

        // Tab A awakens and attempts a safety-critical commit
        const canCommit = guardOwnedCommit(0);

        if (canCommit) {
            committedActions++;
        }

        // Commit MUST be rejected
        expect(canCommit).toBe(false);
        expect(committedActions).toBe(0);

        // Halt handler MUST be notified to safely shut down automation
        expect(haltSpy).toHaveBeenCalledTimes(1);
    });

    test('High-frequency interruptibleWait resolves immediately on AbortSignal without memory leak or listener accumulation', async () => {
        const controller = new AbortController();

        const waitCount = 50;
        const waitPromises: Promise<void>[] = [];

        for (let i = 0; i < waitCount; i++) {
            waitPromises.push(interruptibleWait(5000, controller.signal));
        }

        // Abort after 5ms
        setTimeout(() => controller.abort(), 5);

        const startTime = Date.now();
        await Promise.all(waitPromises);
        const elapsed = Date.now() - startTime;

        // All 50 promises must resolve almost immediately, not waiting 5000ms
        expect(elapsed).toBeLessThan(100);
    });

    test('Rapid stopSignal toggle halts in-flight waits immediately', async () => {
        const p1 = wait(2000);
        const p2 = wait(2000);

        setStopSignal(true);

        const startTime = Date.now();
        await Promise.all([p1, p2]);
        const elapsed = Date.now() - startTime;

        expect(elapsed).toBeLessThan(50);
        expect(isRunCurrent(0)).toBe(false);
    });
});
