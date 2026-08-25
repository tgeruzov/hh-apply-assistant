export interface VacancyMeta {
    vid: string;
    title: string;
    url: string;
    employer?: string;
    salary?: string;
    ts?: number;
    addedAt?: number;
    returnUrl?: string;
    note?: string;
    origin?: string;
}

export type ManualQueueItem = VacancyMeta;

export interface RunStats {
    applied: number;
    skipped: number;
    errors: number;
    manual: number;
}

export interface TrapLockRecord {
    token: string;
    expiresAt: number;
    runId: number | null;
}

export interface InstanceLeaseRecord {
    tabId: string;
    leaseId: string;
    generation: number;
    expiresAt: number;
    createdAt: number;
    updatedAt: number;
}

export type CommitGuardResult = 'OWNED' | 'LOST';

export interface GlobalListenerRecord {
    target: EventTarget;
    type: string;
    handler: EventListenerOrEventListenerObject;
    options?: boolean | AddEventListenerOptions;
}

export interface RuntimeRecord {
    active: boolean;
    version: string;
    watchdogIntervalId: ReturnType<typeof setInterval> | number | null;
    domReadyObserver: MutationObserver | null;
    globalListeners: GlobalListenerRecord[];
    teardown: (() => void) | null;
    initializedAt?: number;
}
