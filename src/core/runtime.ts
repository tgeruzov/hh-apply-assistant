import type { GlobalListenerRecord, RuntimeRecord } from '../types/index.js';

export const VERSION = '4.0.0';

// Повторная инъекция userscript в тот же document не должна создавать второй runtime.
// Полная навигация получает новый window, а SPA/bfcache продолжают использовать эту запись.
export const RUNTIME_KEY = '__hhApplyAssistantRuntime';
const existingRuntime = typeof window !== 'undefined' ? (window as any)[RUNTIME_KEY] : null;
if (existingRuntime && existingRuntime.active) {
    // Early exit
}

export const runtimeRecord: RuntimeRecord = {
    active: true,
    version: VERSION,
    watchdogIntervalId: null,
    domReadyObserver: null,
    globalListeners: [],
    teardown: null
};
if (typeof window !== 'undefined') {
    (window as any)[RUNTIME_KEY] = runtimeRecord;
}

export function addRuntimeListener(
    target: EventTarget | null | undefined,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
): void {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler, options);
    runtimeRecord.globalListeners.push({ target, type, handler, options });
}
