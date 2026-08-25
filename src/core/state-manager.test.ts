import { test, expect, beforeEach, vi } from 'vitest';
import {
    State,
    Settings,
    Stats,
    DiagLog,
    Metrics,
    config,
    setConfig,
    persistSettings,
    setStatus,
    restoreStatusAfterMount,
    currentStatusState
} from './state-manager.js';
import { KEYS, storage } from '../storage/storage-service.js';
import {
    SELECTORS,
    TUNING
} from '../dom/selectors.js';
import {
    SUPPORTED_LANGUAGES,
    LOCALE_TAGS,
    TRANSLATIONS,
    PRESETS,
    WORK_MODE_KEYS,
    DEFAULTS
} from '../i18n/index.js';
import { STATUS_KEYS, STATS_FIELDS } from './state-manager.js';

class FakeStorage implements Storage {
    values = new Map<string, string>();
    failGet = new Set<string>();
    failSet = new Set<string>();
    failRemove = new Set<string>();
    ignoreSet = new Set<string>();
    ignoreRemove = new Set<string>();

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
        if (this.ignoreRemove.has(key)) return;
        this.values.delete(key);
    }
}

let mockLocal: FakeStorage;
let mockSession: FakeStorage;

beforeEach(() => {
    mockLocal = new FakeStorage();
    mockSession = new FakeStorage();
    (globalThis as any).localStorage = mockLocal;
    (globalThis as any).sessionStorage = mockSession;
    (globalThis as any).window = globalThis;
    (globalThis as any).document = {
        getElementById: () => null,
        documentElement: { lang: 'ru' }
    };
    DiagLog.clear();
    Metrics.clear();
    Stats.reset();
    setConfig(Settings.load());
});

test('Static configuration objects, translations, and selector maps are frozen (Prototype Pollution protection)', () => {
    expect(Object.isFrozen(KEYS)).toBe(true);
    expect(Object.isFrozen(TUNING)).toBe(true);
    expect(Object.isFrozen(SELECTORS)).toBe(true);
    expect(Object.isFrozen(SUPPORTED_LANGUAGES)).toBe(true);
    expect(Object.isFrozen(LOCALE_TAGS)).toBe(true);
    expect(Object.isFrozen(TRANSLATIONS)).toBe(true);
    expect(Object.isFrozen(TRANSLATIONS.ru)).toBe(true);
    expect(Object.isFrozen(TRANSLATIONS.en)).toBe(true);
    expect(Object.isFrozen(PRESETS)).toBe(true);
    expect(Object.isFrozen(PRESETS.safe)).toBe(true);
    expect(Object.isFrozen(WORK_MODE_KEYS)).toBe(true);
    expect(Object.isFrozen(DEFAULTS)).toBe(true);
    expect(Object.isFrozen(STATS_FIELDS)).toBe(true);
    expect(Object.isFrozen(STATUS_KEYS)).toBe(true);

    expect(() => {
        'use strict';
        (KEYS as any).polluted = 'evil';
    }).toThrow(TypeError);
});

test('successful Settings write commits matching runtime and storage config', () => {
    const next = { ...config, preset: 'fast' as const, limit: 7, coverText: 'new letter' };
    expect(persistSettings(next)).toBe(true);
    expect(config).toEqual(next);
    expect(JSON.parse(mockLocal.getItem(KEYS.settings)!)).toEqual(next);
});

test('failed Settings write preserves previous runtime and persisted config', () => {
    const beforeRuntime = { ...config };
    mockLocal.setItem(KEYS.settings, JSON.stringify(beforeRuntime));
    mockLocal.failSet.add(KEYS.settings);

    expect(persistSettings({ ...beforeRuntime, limit: 99 })).toBe(false);
    expect(config).toEqual(beforeRuntime);
    expect(JSON.parse(mockLocal.getItem(KEYS.settings)!)).toEqual(beforeRuntime);
});

test('active automation stops fail-closed when critical Settings persistence fails', () => {
    State.setRunning(true);
    mockLocal.failSet.add(KEYS.settings);

    expect(persistSettings({ preset: 'turbo' })).toBe(false);
    expect(State.amIRunning()).toBe(false);
});

test('invalid current settings schema falls back to defensive defaults', () => {
    mockLocal.setItem(KEYS.settings, '{not-json');
    const loaded = Settings.load();
    expect(loaded.preset).toBe('balanced');
    expect(loaded.limit).toBe(50);

    mockLocal.setItem(KEYS.settings, JSON.stringify({ preset: 'unknown', limit: 9999, coverText: null }));
    const partial = Settings.load();
    expect(partial.preset).toBe('balanced');
    expect(partial.limit).toBe(500);
    expect(typeof partial.coverText).toBe('string');
});

test('fresh schema storage persists current settings, history, manual queue, diagnostics, metrics and trap', () => {
    DiagLog.clear();
    Metrics.clear();
    const settings = { ...config, preset: 'fast' as const, limit: 17 };
    expect(Settings.save(settings)).toBe(true);
    expect(State.addProcessedID('v_17')).toBe(true);
    expect(State.addManualEntry({ vid: 'v_18', url: 'https://hh.ru/vacancy/18', title: 'Engineer' })).toBe('ADDED');
    expect(State.setTrapLock(1_000)).toBeTruthy();
    DiagLog.push('fresh-schema', true);
    Metrics.snapshot('fresh-schema', { path: '/search/vacancy' });

    expect(JSON.parse(mockLocal.getItem(KEYS.settings)!)).toEqual(settings);
    expect(JSON.parse(mockSession.getItem(KEYS.history)!)).toEqual(['v_17']);
    expect(JSON.parse(mockLocal.getItem(KEYS.manualList)!)[0].vid).toBe('v_18');
    expect(JSON.parse(mockLocal.getItem(KEYS.diagLog)!)[0].msg).toBe('fresh-schema');
    expect(JSON.parse(mockLocal.getItem(KEYS.metrics)!).snapshots[0].label).toBe('fresh-schema');
    expect(JSON.parse(mockSession.getItem(KEYS.trapLock)!).expiresAt).toBeGreaterThan(Date.now());
});

test('trap create persists ownership and expiration, then expires', () => {
    vi.useFakeTimers();
    const token = State.setTrapLock(500);
    const record = JSON.parse(mockSession.getItem(KEYS.trapLock)!);
    expect(record.token).toBe(token);
    expect(State.hasTrapLock()).toBe(true);

    vi.advanceTimersByTime(500);
    expect(State.hasTrapLock()).toBe(false);
    expect(mockSession.getItem(KEYS.trapLock)).toBeNull();
    vi.useRealTimers();
});

test('replacing trap preserves the new token against the stale callback', () => {
    vi.useFakeTimers();
    const first = State.setTrapLock(500);
    vi.advanceTimersByTime(100);
    const second = State.setTrapLock(700);
    expect(first).not.toBe(second);

    vi.advanceTimersByTime(400); // 500ms from first
    expect(JSON.parse(mockSession.getItem(KEYS.trapLock)!).token).toBe(second);
    expect(State.hasTrapLock()).toBe(true);
    vi.useRealTimers();
});

test('critical storage writes require read-back instead of trusting a silent no-op', () => {
    mockSession.ignoreSet.add(KEYS.history);
    expect(State.addProcessedID('v_44')).toBe(false);

    mockLocal.setItem(KEYS.manualList, JSON.stringify([{ vid: 'v_44', url: 'https://hh.ru/vacancy/44' }]));
    mockLocal.ignoreRemove.add(KEYS.manualList);
    expect(State.clearManualList()).toBe(false);
});

test('processed_ids and sent_count reads fail closed before a replacement write', () => {
    mockSession.setItem(KEYS.history, JSON.stringify(['v_existing']));
    mockSession.failGet.add(KEYS.history);
    expect(State.addProcessedID('v_new')).toBe(false);
    mockSession.failGet.delete(KEYS.history);
    expect(JSON.parse(mockSession.getItem(KEYS.history)!)).toEqual(['v_existing']);

    mockSession.setItem(KEYS.sentCount, '8');
    mockSession.failGet.add(KEYS.sentCount);
    expect(State.incSentCount()).toBeNull();
    expect(Stats.getAll().success).toBe(0);
    mockSession.failGet.delete(KEYS.sentCount);
    expect(mockSession.getItem(KEYS.sentCount)).toBe('8');
});

test('processed history reports successful and failed writes', () => {
    expect(State.addProcessedID('v_1')).toBe(true);
    expect(JSON.parse(mockSession.getItem(KEYS.history)!)).toEqual(['v_1']);

    mockSession.failSet.add(KEYS.history);
    expect(State.addProcessedID('v_2')).toBe(false);
});

test('sent count changes Stats only after successful persistence', () => {
    expect(State.incSentCount()).toBe(1);
    expect(mockSession.getItem(KEYS.sentCount)).toBe('1');
    expect(Stats.getAll().success).toBe(1);

    mockSession.failSet.add(KEYS.sentCount);
    expect(State.incSentCount()).toBeNull();
});

test('last-attempt writes report storage failure', () => {
    expect(State.setLastAttemptID('v_1')).toBe(true);
    mockSession.failSet.add(KEYS.lastAttempt);
    expect(State.setLastAttemptID('v_2')).toBe(false);
});

test('manual Stats counts ADDED but not EXISTS or UPDATED', () => {
    expect(State.addManualEntry({ vid: 'v_77', url: 'https://hh.ru/vacancy/77', title: 'Engineer' })).toBe('ADDED');
    Stats.bump('manual');
    expect(Stats.getAll().manual).toBe(1);

    expect(State.addManualEntry({ vid: 'v_77', url: 'https://hh.ru/vacancy/77', title: 'Engineer' })).toBe('EXISTS');

    mockLocal.setItem(KEYS.manualList, JSON.stringify([{
        vid: 'v_78',
        url: 'https://hh.ru/vacancy/78',
        returnUrl: '',
        ts: 1,
        title: 'Название недоступно'
    }]));
    expect(State.addManualEntry({ vid: 'v_78', url: 'https://hh.ru/vacancy/78', title: 'Senior QA' })).toBe('UPDATED');
});

test('manual clear and remove report storage failures', () => {
    mockLocal.setItem(KEYS.manualList, JSON.stringify([{ vid: 'v_90', url: 'https://hh.ru/vacancy/90' }]));

    mockLocal.failRemove.add(KEYS.manualList);
    expect(State.clearManualList()).toBe(false);
    mockLocal.failRemove.delete(KEYS.manualList);

    mockLocal.failSet.add(KEYS.manualList);
    expect(State.removeManualEntry('v_90')).toBe(false);
});

test('SPA remount status restoration preserves terminal states and rejects stale running state', () => {
    State.setRunning(false);

    for (const terminal of [
        ['stopped', null],
        ['done', null],
        ['error', null],
        ['stopped', 'status.captchaStopped']
    ] as const) {
        setStatus(terminal[0], terminal[1]);
        restoreStatusAfterMount();
        expect(currentStatusState.statusKey).toBe(terminal[0]);
        expect(currentStatusState.customKeyOrText).toBe(terminal[1]);
    }

    setStatus('running', 'status.waitingToReturn');
    restoreStatusAfterMount();
    expect(currentStatusState.statusKey).toBe('idle');

    setStatus('done');
    State.setRunning(true);
    restoreStatusAfterMount();
    expect(currentStatusState.statusKey).toBe('running');
});
