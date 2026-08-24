import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(TEST_DIR, '..', 'hh-apply-assistant.user.js');
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, 'utf8');
const HOOK_MARKER = '    // Перехват необработанных ошибок:';
const STORAGE_PREFIX = 'hh_apply_assistant_s1_';
// Historical HH.ru Auto Responder fixture; its internal suffix is unrelated to
// the HH Apply Assistant product version and must remain ignored, not migrated.
const PREVIOUS_PREFIX = 'hh_ar_v2_';

const KEYS = {
    settings: STORAGE_PREFIX + 'settings',
    isRunning: STORAGE_PREFIX + 'is_active',
    trap: STORAGE_PREFIX + 'trap_lock',
    history: STORAGE_PREFIX + 'processed_ids',
    sent: STORAGE_PREFIX + 'sent_count',
    manual: STORAGE_PREFIX + 'manual_queue',
    lastAttempt: STORAGE_PREFIX + 'last_attempt_id',
    diagLog: STORAGE_PREFIX + 'diagnostic_log',
    metrics: STORAGE_PREFIX + 'metrics'
};

class FakeStorage {
    constructor(initial = {}) {
        this.values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
        this.failSet = new Set();
        this.failRemove = new Set();
        this.failGet = new Set();
        this.ignoreSet = new Set();
        this.ignoreRemove = new Set();
    }

    getItem(key) {
        if (this.failGet.has(key)) throw new Error(`getItem failed: ${key}`);
        return this.values.has(key) ? this.values.get(key) : null;
    }

    setItem(key, value) {
        if (this.failSet.has(key)) throw new Error(`setItem failed: ${key}`);
        if (this.ignoreSet.has(key)) return;
        this.values.set(key, String(value));
    }

    removeItem(key) {
        if (this.failRemove.has(key)) throw new Error(`removeItem failed: ${key}`);
        if (this.ignoreRemove.has(key)) return;
        this.values.delete(key);
    }
}

class FakeClock {
    constructor(now = 0) {
        this.now = now;
        this.nextId = 1;
        this.timers = new Map();
    }

    setTimeout(fn, delay = 0) {
        const id = this.nextId++;
        this.timers.set(id, { at: this.now + Math.max(0, Number(delay) || 0), fn });
        return id;
    }

    clearTimeout(id) {
        this.timers.delete(id);
    }

    getCallback(id) {
        return this.timers.get(id)?.fn || null;
    }

    advance(ms) {
        const target = this.now + ms;
        while (true) {
            const due = [...this.timers.entries()]
                .filter(([, timer]) => timer.at <= target)
                .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
            if (!due) break;
            const [id, timer] = due;
            this.timers.delete(id);
            this.now = timer.at;
            timer.fn();
        }
        this.now = target;
    }
}

function makeClassList() {
    return { add() {}, remove() {}, toggle() {} };
}

function createHarness({
    now = 0,
    href = 'https://hh.ru/search/vacancy',
    sessionStorage = new FakeStorage(),
    localStorage = new FakeStorage()
} = {}) {
    const clock = new FakeClock(now);
    const parsedUrl = new URL(href);
    class FakeDate extends Date {
        constructor(...args) {
            super(...(args.length ? args : [clock.now]));
        }
        static now() { return clock.now; }
    }

    const document = {
        title: '',
        referrer: '',
        hidden: false,
        documentElement: { lang: 'ru', classList: makeClassList(), scrollHeight: 0, clientHeight: 0 },
        body: { contains: () => true, scrollHeight: 0, appendChild() {} },
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({
            style: { setProperty() {} },
            classList: makeClassList(),
            appendChild() {},
            remove() {},
            click() {},
            setAttribute() {}
        }),
        createDocumentFragment: () => ({ appendChild() {} }),
        createTextNode: (text) => ({ textContent: text }),
        addEventListener() {}
    };
    const location = {
        href: parsedUrl.href,
        pathname: parsedUrl.pathname,
        search: parsedUrl.search,
        reload() {}
    };
    const context = {
        console: { log() {}, warn() {}, error() {} },
        document,
        location,
        navigator: { language: 'ru-RU', userAgent: 'phase1-test' },
        localStorage,
        sessionStorage,
        Date: FakeDate,
        Math,
        URL,
        Blob,
        AbortController,
        Event,
        setTimeout: clock.setTimeout.bind(clock),
        clearTimeout: clock.clearTimeout.bind(clock),
        setInterval: () => 1,
        clearInterval() {},
        requestAnimationFrame: (fn) => clock.setTimeout(() => fn(clock.now), 16),
        cancelAnimationFrame: clock.clearTimeout.bind(clock),
        addEventListener() {},
        removeEventListener() {},
        getComputedStyle: () => ({ getPropertyValue: () => '', transform: 'none' }),
        history: { back() {}, go() {} },
        confirm: () => true,
        alert() {},
        open() {},
        scrollTo() {},
        innerHeight: 800,
        pageYOffset: 0
    };
    context.window = context;
    context.globalThis = context;

    const hook = `
    globalThis.__hhApplyAssistantTestHooks = {
        Settings,
        State,
        Stats,
        DiagLog,
        Metrics,
        startLoop,
        stopRun,
        isRunCurrent,
        returnToList,
        saveCurrentForManual,
        persistSentCount,
        setStatus,
        restoreStatusAfterMount,
        getCurrentStatusState: () => ({ ...currentStatusState }),
        getConfig: () => ({ ...config }),
        runtime: () => ({ currentRunId, isLoopActive, stopSignal, handlingResponsePage, hasAbortController: !!activeAbortController })
    };
    return;
`;
    assert.ok(SCRIPT_SOURCE.includes(HOOK_MARKER), 'test hook marker must exist');
    const instrumentedSource = SCRIPT_SOURCE.replace(HOOK_MARKER, hook + HOOK_MARKER);
    vm.createContext(context);
    vm.runInContext(instrumentedSource, context, { filename: SCRIPT_PATH });

    return { hooks: context.__hhApplyAssistantTestHooks, clock, context, sessionStorage, localStorage };
}

test('production source uses the schema namespace and ignores legacy Auto Responder storage', () => {
    assert.match(SCRIPT_SOURCE, /const STORAGE_SCHEMA_VERSION = 1/);
    assert.match(SCRIPT_SOURCE, /const STORAGE_PREFIX = `hh_apply_assistant_s\$\{STORAGE_SCHEMA_VERSION\}_`/);
    assert.doesNotMatch(SCRIPT_SOURCE, /hh_ar_v2_|hh_ar_manual_processed|LEGACY_PROCESSED_KEY|applomat/i);
});

test('SPA remount status restoration preserves terminal states and rejects stale running state', () => {
    const { hooks } = createHarness();
    hooks.State.setRunning(false);

    for (const terminal of [
        ['stopped', undefined],
        ['done', undefined],
        ['error', undefined],
        ['stopped', 'status.captchaStopped']
    ]) {
        hooks.setStatus(...terminal);
        hooks.restoreStatusAfterMount();
        const restored = hooks.getCurrentStatusState();
        assert.equal(restored.statusKey, terminal[0]);
        assert.equal(restored.customKeyOrText, terminal[1]);
    }

    hooks.setStatus('running', 'status.waitingToReturn');
    hooks.restoreStatusAfterMount();
    assert.equal(hooks.getCurrentStatusState().statusKey, 'idle');
    assert.equal(hooks.getCurrentStatusState().customKeyOrText, undefined);

    hooks.setStatus('done');
    hooks.State.setRunning(true);
    hooks.restoreStatusAfterMount();
    assert.equal(hooks.getCurrentStatusState().statusKey, 'running');
});

test('previous namespace data is ignored without cleanup or migration', () => {
    const previousSettings = JSON.stringify({ preset: 'turbo', limit: 1, coverText: 'previous' });
    const localStorage = new FakeStorage({
        [PREVIOUS_PREFIX + 'cfg_data']: previousSettings,
        [PREVIOUS_PREFIX + 'manual_list']: JSON.stringify([{ vid: 'v_old', url: 'https://hh.ru/vacancy/1' }]),
        [PREVIOUS_PREFIX + 'diag_log']: JSON.stringify([{ msg: 'previous log' }]),
        [PREVIOUS_PREFIX + 'metrics']: JSON.stringify({ counters: { previous: 1 } }),
        [PREVIOUS_PREFIX + 'instance_lock']: JSON.stringify({ tabId: 'previous-tab', ts: 1 })
    });
    const sessionStorage = new FakeStorage({
        [PREVIOUS_PREFIX + 'is_active']: '1',
        [PREVIOUS_PREFIX + 'processed_ids']: JSON.stringify(['v_old']),
        [PREVIOUS_PREFIX + 'sent_count']: '49',
        [PREVIOUS_PREFIX + 'ar_trap_lock']: 'previous-trap'
    });
    const { hooks } = createHarness({ localStorage, sessionStorage });

    assert.equal(hooks.getConfig().preset, 'balanced');
    assert.equal(hooks.getConfig().limit, 50);
    assert.equal(hooks.State.amIRunning(), false);
    assert.equal(hooks.State.getSentCount(), 0);
    assert.deepEqual([...hooks.State.getProcessedIDs()], []);
    assert.equal(hooks.State.getManualList().length, 0);
    assert.equal(hooks.State.hasTrapLock(), false);
    assert.equal(hooks.DiagLog.getAll().length, 0);
    assert.equal(Object.keys(hooks.Metrics.getAll().counters).length, 0);
    assert.equal(localStorage.getItem(PREVIOUS_PREFIX + 'cfg_data'), previousSettings);
    assert.equal(sessionStorage.getItem(PREVIOUS_PREFIX + 'is_active'), '1');
});

test('invalid current settings schema falls back to defensive defaults', () => {
    const corrupted = createHarness({
        localStorage: new FakeStorage({ [KEYS.settings]: '{not-json' })
    });
    assert.equal(corrupted.hooks.getConfig().preset, 'balanced');
    assert.equal(corrupted.hooks.getConfig().limit, 50);

    const partial = createHarness({
        localStorage: new FakeStorage({
            [KEYS.settings]: JSON.stringify({ preset: 'unknown', limit: 9_999, coverText: null })
        })
    });
    assert.equal(partial.hooks.getConfig().preset, 'balanced');
    assert.equal(partial.hooks.getConfig().limit, 500);
    assert.equal(typeof partial.hooks.getConfig().coverText, 'string');
});

test('fresh schema storage persists current settings, history, manual queue, diagnostics, metrics and trap', () => {
    const { hooks, localStorage, sessionStorage } = createHarness({ now: 5_000 });
    const settings = { ...hooks.getConfig(), preset: 'fast', limit: 17 };
    assert.equal(hooks.Settings.save(settings), true);
    assert.equal(hooks.State.addProcessedID('v_17'), true);
    assert.equal(hooks.State.addManualEntry({ vid: 'v_18', url: 'https://hh.ru/vacancy/18', title: 'Engineer' }), 'ADDED');
    assert.ok(hooks.State.setTrapLock(1_000));
    hooks.DiagLog.push('fresh-schema', true);
    hooks.Metrics.snapshot('fresh-schema', { path: '/search/vacancy' });

    assert.deepEqual(JSON.parse(localStorage.getItem(KEYS.settings)), settings);
    assert.deepEqual(JSON.parse(sessionStorage.getItem(KEYS.history)), ['v_17']);
    assert.equal(JSON.parse(localStorage.getItem(KEYS.manual))[0].vid, 'v_18');
    assert.equal(JSON.parse(localStorage.getItem(KEYS.diagLog))[0].msg, 'fresh-schema');
    assert.equal(JSON.parse(localStorage.getItem(KEYS.metrics)).snapshots[0].label, 'fresh-schema');
    assert.ok(JSON.parse(sessionStorage.getItem(KEYS.trap)).expiresAt > 5_000);
    assert.ok([...localStorage.values.keys()].every(key => key.startsWith(STORAGE_PREFIX)));
    assert.ok([...sessionStorage.values.keys()].every(key => key.startsWith(STORAGE_PREFIX)));
});

test('trap create persists ownership and expiration, then expires', () => {
    const { hooks, clock, sessionStorage } = createHarness({ now: 1_000 });
    const token = hooks.State.setTrapLock(500);
    const record = JSON.parse(sessionStorage.getItem(KEYS.trap));
    assert.equal(record.token, token);
    assert.equal(record.expiresAt, 1_500);
    assert.equal(typeof record.runId, 'number');
    assert.equal(hooks.State.hasTrapLock(), true);
    clock.advance(500);
    assert.equal(hooks.State.hasTrapLock(), false);
    assert.equal(sessionStorage.getItem(KEYS.trap), null);
});

test('replacing trap preserves the new token against the stale callback', () => {
    const { hooks, clock, sessionStorage } = createHarness({ now: 2_000 });
    const first = hooks.State.setTrapLock(500);
    const staleCallback = clock.getCallback(1);
    clock.advance(100);
    const second = hooks.State.setTrapLock(700);
    assert.notEqual(first, second);
    staleCallback();
    assert.equal(JSON.parse(sessionStorage.getItem(KEYS.trap)).token, second);
    assert.equal(hooks.State.hasTrapLock(), true);
});

test('reload removes an expired persisted trap', () => {
    const sharedSession = new FakeStorage();
    const responseHref = 'https://hh.ru/applicant/vacancy_response?vacancyId=42';
    const firstPage = createHarness({ now: 3_000, href: responseHref, sessionStorage: sharedSession });
    firstPage.hooks.State.setTrapLock(400);
    const reloadedPage = createHarness({ now: 3_500, href: responseHref, sessionStorage: sharedSession });
    assert.equal(reloadedPage.hooks.State.hasTrapLock(), false);
    assert.equal(sharedSession.getItem(KEYS.trap), null);
});

test('invalid current trap schema is removed without migration', () => {
    const sessionStorage = new FakeStorage({ [KEYS.trap]: 'invalid_trap_record' });
    const { hooks } = createHarness({
        href: 'https://hh.ru/applicant/vacancy_response?vacancyId=42',
        sessionStorage
    });
    assert.equal(hooks.State.hasTrapLock(), false);
    assert.equal(sessionStorage.getItem(KEYS.trap), null);
});

test('trap creation reports persistence failure', () => {
    const { hooks, sessionStorage } = createHarness();
    sessionStorage.failSet.add(KEYS.trap);
    assert.equal(hooks.State.setTrapLock(1_000), null);
    assert.equal(hooks.State.hasTrapLock(), false);
});

test('Stop clears the active trap and invalidates the current run', () => {
    const { hooks, sessionStorage } = createHarness();
    hooks.State.setRunning(true);
    hooks.State.setTrapLock(1_000);
    const before = hooks.runtime().currentRunId;
    hooks.stopRun();
    assert.equal(sessionStorage.getItem(KEYS.trap), null);
    assert.equal(hooks.State.amIRunning(), false);
    assert.equal(hooks.runtime().currentRunId, before + 1);
    assert.equal(hooks.runtime().stopSignal, true);
});

test('Start -> Stop cancels the pending acquire continuation', async () => {
    const { hooks, clock, localStorage } = createHarness();
    const pendingStart = hooks.startLoop();
    hooks.stopRun();
    clock.advance(60);
    await pendingStart;
    assert.equal(hooks.State.amIRunning(), false);
    assert.equal(hooks.runtime().isLoopActive, false);
    assert.equal(hooks.runtime().stopSignal, true);
    assert.equal(localStorage.getItem(STORAGE_PREFIX + 'instance_lock'), null);
});

test('Start -> Stop -> Start keeps stale run invalidated', async () => {
    const { hooks, clock } = createHarness({ href: 'https://hh.ru/applicant/vacancy_response?vacancyId=42' });
    const staleStart = hooks.startLoop();
    const staleRunId = hooks.runtime().currentRunId;
    hooks.stopRun();
    const currentStart = hooks.startLoop();
    const currentRunId = hooks.runtime().currentRunId;
    clock.advance(60);
    await Promise.all([staleStart, currentStart]);
    assert.equal(hooks.isRunCurrent(staleRunId), false);
    assert.equal(hooks.isRunCurrent(currentRunId), true);
    assert.equal(hooks.runtime().stopSignal, false);
});

test('Start fails closed when is_active cannot be persisted and recovers on the next Start', async () => {
    const { hooks, clock, sessionStorage, localStorage } = createHarness({
        href: 'https://hh.ru/applicant/vacancy_response?vacancyId=42'
    });
    sessionStorage.failSet.add(KEYS.isRunning);
    await hooks.startLoop();

    assert.equal(hooks.State.amIRunning(), false);
    assert.equal(hooks.runtime().isLoopActive, false);
    assert.equal(hooks.runtime().stopSignal, true);
    assert.equal(hooks.runtime().hasAbortController, false);
    assert.equal(localStorage.getItem(STORAGE_PREFIX + 'instance_lock'), null);

    sessionStorage.failSet.delete(KEYS.isRunning);
    const recovered = hooks.startLoop();
    clock.advance(60);
    await recovered;
    assert.equal(hooks.State.amIRunning(), true);
    assert.equal(hooks.runtime().isLoopActive, false);
    assert.equal(hooks.runtime().stopSignal, false);
});

test('fresh Start fails closed when sent_count reset cannot be persisted', async () => {
    const { hooks, clock, sessionStorage, localStorage } = createHarness({
        href: 'https://hh.ru/applicant/vacancy_response?vacancyId=42'
    });
    sessionStorage.failRemove.add(KEYS.sent);
    const pending = hooks.startLoop();
    clock.advance(60);
    await pending;

    assert.equal(hooks.State.amIRunning(), false);
    assert.equal(hooks.runtime().isLoopActive, false);
    assert.equal(hooks.runtime().stopSignal, true);
    assert.equal(hooks.runtime().hasAbortController, false);
    assert.equal(localStorage.getItem(STORAGE_PREFIX + 'instance_lock'), null);
});

test('critical storage writes require read-back instead of trusting a silent no-op', () => {
    const sessionStorage = new FakeStorage();
    sessionStorage.ignoreSet.add(KEYS.history);
    const history = createHarness({ sessionStorage });
    assert.equal(history.hooks.State.addProcessedID('v_44'), false);

    const localStorage = new FakeStorage({
        [KEYS.manual]: JSON.stringify([{ vid: 'v_44', url: 'https://hh.ru/vacancy/44' }])
    });
    localStorage.ignoreRemove.add(KEYS.manual);
    const manual = createHarness({ localStorage });
    assert.equal(manual.hooks.State.clearManualList(), false);
    assert.notEqual(localStorage.getItem(KEYS.manual), null);
});

test('processed_ids and sent_count reads fail closed before a replacement write', () => {
    const historyStorage = new FakeStorage({ [KEYS.history]: JSON.stringify(['v_existing']) });
    historyStorage.failGet.add(KEYS.history);
    const history = createHarness({ sessionStorage: historyStorage });
    assert.equal(history.hooks.State.addProcessedID('v_new'), false);
    historyStorage.failGet.delete(KEYS.history);
    assert.deepEqual(JSON.parse(historyStorage.getItem(KEYS.history)), ['v_existing']);

    const sentStorage = new FakeStorage({ [KEYS.sent]: '8' });
    sentStorage.failGet.add(KEYS.sent);
    const sent = createHarness({ sessionStorage: sentStorage });
    assert.equal(sent.hooks.State.incSentCount(), null);
    assert.equal(sent.hooks.Stats.getAll().success, 0);
    sentStorage.failGet.delete(KEYS.sent);
    assert.equal(sentStorage.getItem(KEYS.sent), '8');
});

test('critical running-state cleanup leaves no active local runtime when storage removal fails', () => {
    const { hooks, sessionStorage } = createHarness();
    assert.equal(hooks.State.setRunning(true), true);
    sessionStorage.failRemove.add(KEYS.isRunning);
    hooks.stopRun();

    assert.equal(hooks.runtime().isLoopActive, false);
    assert.equal(hooks.runtime().stopSignal, true);
    assert.equal(hooks.runtime().hasAbortController, false);
    assert.equal(hooks.State.amIRunning(), true, 'failed storage cleanup remains diagnosable');

    sessionStorage.failRemove.delete(KEYS.isRunning);
    assert.equal(hooks.State.setRunning(false), true);
});

test('processed history reports successful and failed writes', () => {
    const successful = createHarness();
    assert.equal(successful.hooks.State.addProcessedID('v_1'), true);
    assert.deepEqual(JSON.parse(successful.sessionStorage.getItem(KEYS.history)), ['v_1']);

    const failed = createHarness();
    failed.sessionStorage.failSet.add(KEYS.history);
    assert.equal(failed.hooks.State.addProcessedID('v_2'), false);
    assert.equal(failed.sessionStorage.getItem(KEYS.history), null);
});

test('sent count changes Stats only after successful persistence', () => {
    const successful = createHarness();
    assert.equal(successful.hooks.State.incSentCount(), 1);
    assert.equal(successful.sessionStorage.getItem(KEYS.sent), '1');
    assert.equal(successful.hooks.Stats.getAll().success, 1);

    const failed = createHarness();
    failed.sessionStorage.failSet.add(KEYS.sent);
    assert.equal(failed.hooks.State.incSentCount(), null);
    assert.equal(failed.sessionStorage.getItem(KEYS.sent), null);
    assert.equal(failed.hooks.Stats.getAll().success, 0);
});

test('failed sent-count persistence stops the active run', () => {
    const { hooks, sessionStorage } = createHarness({ href: 'https://hh.ru/vacancy/42' });
    hooks.State.setRunning(true);
    sessionStorage.failSet.add(KEYS.sent);
    assert.equal(hooks.persistSentCount('v_42'), false);
    assert.equal(hooks.State.amIRunning(), false);
    assert.equal(hooks.runtime().stopSignal, true);
});

test('last-attempt writes report storage failure', () => {
    const { hooks, sessionStorage } = createHarness();
    assert.equal(hooks.State.setLastAttemptID('v_1'), true);
    sessionStorage.failSet.add(KEYS.lastAttempt);
    assert.equal(hooks.State.setLastAttemptID('v_2'), false);
});

test('failed processed persistence stops before navigation', () => {
    const { hooks, context, sessionStorage } = createHarness({ href: 'https://hh.ru/vacancy/42' });
    hooks.State.setRunning(true);
    sessionStorage.failSet.add(KEYS.history);
    const originalHref = context.location.href;
    assert.equal(hooks.returnToList('v_42', { runId: 0 }), false);
    assert.equal(context.location.href, originalHref);
    assert.equal(hooks.State.amIRunning(), false);
    assert.equal(hooks.runtime().stopSignal, true);
});

test('manual Stats counts ADDED but not EXISTS or UPDATED', () => {
    const added = createHarness({ href: 'https://hh.ru/vacancy/77' });
    assert.equal(added.hooks.saveCurrentForManual('v_77', 'questions'), true);
    assert.equal(added.hooks.Stats.getAll().manual, 1);

    const existingEntry = [{
        vid: 'v_77',
        url: 'https://hh.ru/vacancy/77',
        returnUrl: '',
        ts: 1,
        title: 'Engineer'
    }];
    const existsStorage = new FakeStorage({ [KEYS.manual]: JSON.stringify(existingEntry) });
    const exists = createHarness({ href: 'https://hh.ru/vacancy/77', localStorage: existsStorage });
    assert.equal(exists.hooks.saveCurrentForManual('v_77', 'questions'), true);
    assert.equal(exists.hooks.Stats.getAll().manual, 0);

    const updateStorage = new FakeStorage({
        [KEYS.manual]: JSON.stringify([{ ...existingEntry[0], title: 'Название недоступно' }])
    });
    const updated = createHarness({ href: 'https://hh.ru/vacancy/77', localStorage: updateStorage });
    updated.hooks.State.setLastVacancyMeta('v_77', 'Engineer');
    assert.equal(updated.hooks.saveCurrentForManual('v_77', 'questions'), true);
    assert.equal(updated.hooks.Stats.getAll().manual, 0);
});

test('manual clear and remove report storage failures', () => {
    const localStorage = new FakeStorage({
        [KEYS.manual]: JSON.stringify([{ vid: 'v_90', url: 'https://hh.ru/vacancy/90' }])
    });
    const { hooks } = createHarness({ localStorage });

    localStorage.failRemove.add(KEYS.manual);
    assert.equal(hooks.State.clearManualList(), false);
    localStorage.failRemove.delete(KEYS.manual);

    localStorage.failSet.add(KEYS.manual);
    assert.equal(hooks.State.removeManualEntry('v_90'), false);
});
