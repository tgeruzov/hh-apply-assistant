import { TUNING } from '../dom/selectors.js';
import { storage, KEYS } from '../storage/storage-service.js';
import { sleep, parseJson } from './utils.js';
import type { CommitGuardResult, InstanceLeaseRecord, TrapLockRecord } from '../types/index.js';

export let isLoopActive = false;
export let stopSignal = false;
export let currentRunId = 0;
export let resumeTimer: ReturnType<typeof setTimeout> | null = null;
export let activeAbortController: AbortController | null = null;
export let trapLockTimer: ReturnType<typeof setTimeout> | null = null;
export let currentInstanceLeaseId: string | null = null;
export let instanceLeaseVerified = false;
export let pendingInstanceLeaseId: string | null = null;
export let activeWebLockAbortController: AbortController | null = null;
export let activeWebLockReleaseResolver: (() => void) | null = null;
export let hasActiveWebLock = false;
// Флаг: уже обрабатываем полностраничную форму отклика (защита от повторного входа из watchdog).
// Сбрасывается сам при загрузке новой страницы (новый экземпляр скрипта).
export let handlingResponsePage = false;

export function setLoopActive(val: boolean): void { isLoopActive = val; }
export function setStopSignal(val: boolean): void { stopSignal = val; }
export function incRunId(): number { currentRunId++; return currentRunId; }
export function setRunId(id: number): void { currentRunId = id; }
export function setResumeTimer(t: ReturnType<typeof setTimeout> | null): void { resumeTimer = t; }
export function setTrapLockTimer(t: ReturnType<typeof setTimeout> | null): void { trapLockTimer = t; }
export function setActiveAbortController(ctrl: AbortController | null): void { activeAbortController = ctrl; }
export function setHandlingResponsePage(val: boolean): void { handlingResponsePage = val; }

export type HaltHandler = () => void;
let haltHandler: HaltHandler | null = null;

export function setHaltHandler(handler: HaltHandler | null): void {
    haltHandler = handler;
}

export function triggerHaltForLostInstanceLock(): void {
    if (haltHandler) {
        haltHandler();
    }
}

// TAB_ID должен быть стабильным в пределах одной вкладки на протяжении всех переходов
// (list -> vacancy -> list). sessionStorage изолирован по вкладкам и переживает навигацию,
// поэтому одна и та же вкладка сохраняет свой ID и корректно перезабирает instance lock,
// а разные вкладки получают разные ID.
export const TAB_ID: string = (() => {
    let id = storage.sessionGet(KEYS.tabId);
    if (!id) {
        id = Math.random().toString(36).slice(2, 9);
        storage.sessionSet(KEYS.tabId, id);
    }
    return id;
})();

// Проверяет, принадлежит ли вызов текущему активному поколению запуска.
// Если произошёл Stop -> Start, старый runId !== currentRunId и выполнение прерывается.
export const isRunCurrent = (runId?: number | null): boolean => {
    if (stopSignal) return false;
    if (runId !== undefined && runId !== null && runId !== currentRunId) return false;
    return storage.sessionGet(KEYS.isRunning) === '1';
};

// Прерываемая пауза (Interruptible sleep): опрашивает stopSignal и слушает AbortSignal,
// гарантируя мгновенную реакцию на нажатие "Стоп" в любых режимах и на любых таймингах (<1 мс).
export const interruptibleWait = (ms: number, signal?: AbortSignal | null): Promise<void> => new Promise(resolve => {
    const sig = signal || activeAbortController?.signal;
    if (stopSignal || sig?.aborted || ms <= 0) return resolve();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
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

export const wait = interruptibleWait;

export function clearTrapLockTimer(): void {
    if (trapLockTimer) {
        clearTimeout(trapLockTimer);
        trapLockTimer = null;
    }
}

export function getActiveTrapLock(): TrapLockRecord | null {
    const raw = storage.sessionGet(KEYS.trapLock);
    if (!raw) return null;
    const lock = parseJson<TrapLockRecord | null>(raw, null);
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

export function readInstanceLock(): { ok: boolean; lock: any } {
    const read = storage.localRead(KEYS.instanceLock);
    if (!read.ok) return { ok: false, lock: null };
    return { ok: true, lock: parseJson(read.value, null) };
}

export function sameInstanceLease(lock: any, tabId: string, leaseId: string | null): boolean {
    return !!(lock && lock.tabId === tabId && typeof leaseId === 'string' && leaseId && lock.leaseId === leaseId);
}

export function isLiveInstanceLease(lock: any, now = Date.now()): boolean {
    const ts = Number(lock?.ts);
    return Number.isFinite(ts) && now - ts < TUNING.instanceLockTtl;
}

export function newInstanceLeaseId(tabId: string): string {
    return `${tabId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function acquireInstanceLock(tabId: string): Promise<boolean> {
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

    // Web Locks API: нативная межвкладочная синхронизация
    const supportsWebLocks = typeof navigator !== 'undefined'
        && !!navigator.locks
        && typeof navigator.locks.request === 'function';

    if (supportsWebLocks) {
        let webLockAcquired = false;
        const lockController = new AbortController();

        try {
            const lockPromise = new Promise((resolveAcquire) => {
                navigator.locks.request(
                    KEYS.instanceLock,
                    { mode: 'exclusive', ifAvailable: true, signal: lockController.signal },
                    (lock) => {
                        if (!lock) {
                            resolveAcquire(false);
                            return;
                        }
                        webLockAcquired = true;
                        hasActiveWebLock = true;
                        activeWebLockAbortController = lockController;
                        resolveAcquire(true);
                        return new Promise<void>((resolveRelease) => {
                            activeWebLockReleaseResolver = () => resolveRelease();
                        });
                    }
                ).catch(() => {
                    hasActiveWebLock = false;
                    if (!webLockAcquired) {
                        resolveAcquire(null);
                    }
                });
            });

            const lockResult = await lockPromise;
            if (lockResult === false) {
                instanceLeaseVerified = false;
                return false;
            }
        } catch (e) {
            // При ошибке вызова Web Locks API продолжаем фоллбек через storage
        }
    }

    const leaseId = newInstanceLeaseId(tabId);
    const candidate = { tabId, leaseId, ts: now };
    currentInstanceLeaseId = leaseId;
    instanceLeaseVerified = false;
    pendingInstanceLeaseId = leaseId;
    if (!storage.localSet(KEYS.instanceLock, JSON.stringify(candidate))) {
        if (pendingInstanceLeaseId === leaseId) pendingInstanceLeaseId = null;
        if (hasActiveWebLock) {
            try { activeWebLockReleaseResolver?.(); activeWebLockAbortController?.abort(); } catch (_) {}
            hasActiveWebLock = false;
            activeWebLockReleaseResolver = null;
            activeWebLockAbortController = null;
        }
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
    if (!owned && hasActiveWebLock) {
        try { activeWebLockReleaseResolver?.(); activeWebLockAbortController?.abort(); } catch (_) {}
        hasActiveWebLock = false;
        activeWebLockReleaseResolver = null;
        activeWebLockAbortController = null;
    }
    return owned;
}

export function verifyInstanceLock(tabId: string, leaseId = currentInstanceLeaseId): CommitGuardResult {
    if (!leaseId || leaseId !== currentInstanceLeaseId || !instanceLeaseVerified) return 'LOST';
    const current = readInstanceLock();
    const owned = current.ok
        && sameInstanceLease(current.lock, tabId, leaseId)
        && isLiveInstanceLease(current.lock);
    if (!owned && leaseId === currentInstanceLeaseId) {
        instanceLeaseVerified = false;
        if (hasActiveWebLock) {
            try { activeWebLockReleaseResolver?.(); activeWebLockAbortController?.abort(); } catch (_) {}
            hasActiveWebLock = false;
            activeWebLockReleaseResolver = null;
            activeWebLockAbortController = null;
        }
    }
    return owned ? 'OWNED' : 'LOST';
}

export function releaseInstanceLock(tabId: string, leaseId = currentInstanceLeaseId): boolean {
    if (hasActiveWebLock || activeWebLockReleaseResolver || activeWebLockAbortController) {
        try {
            if (typeof activeWebLockReleaseResolver === 'function') activeWebLockReleaseResolver();
            if (activeWebLockAbortController) activeWebLockAbortController.abort();
        } catch (_) {}
        activeWebLockReleaseResolver = null;
        activeWebLockAbortController = null;
        hasActiveWebLock = false;
    }
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
}

// Продлеваем только текущее подтверждённое поколение и проверяем результат записи.
// Любая неопределённость storage означает LOST: UNKNOWN никогда не трактуется как OWNED.
export function touchInstanceLock(tabId: string, leaseId = currentInstanceLeaseId): 'OWNED' | 'LOST' {
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
}

// Fencing guard только для safety-critical commit points. Он не подменяет runId:
// сначала отсекаем старое внутривкладочное поколение, затем renew+read-back текущего lease.
export function guardOwnedCommit(runId = currentRunId): boolean {
    if (!isRunCurrent(runId)) return false;
    if (touchInstanceLock(TAB_ID) === 'OWNED') return true;
    triggerHaltForLostInstanceLock();
    return false;
}
