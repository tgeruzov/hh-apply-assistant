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

class FakeStorage {
    constructor(initial = {}) {
        this.values = new Map(Object.entries(initial).map(([k, v]) => [k, String(v)]));
        this.throwOnSet = false;
        this.throwOnGet = false;
        this.throwOnRemove = false;
        this.errorTypeToThrow = 'QuotaExceededError';
    }
    getItem(key) {
        if (this.throwOnGet) {
            const err = new Error('SecurityError: Access is denied');
            err.name = 'SecurityError';
            throw err;
        }
        return this.values.has(key) ? this.values.get(key) : null;
    }
    setItem(key, value) {
        if (this.throwOnSet) {
            const err = new Error('QuotaExceededError: The quota has been exceeded');
            err.name = this.errorTypeToThrow;
            throw err;
        }
        this.values.set(key, String(value));
    }
    removeItem(key) {
        if (this.throwOnRemove) {
            const err = new Error('SecurityError: Access is denied');
            err.name = 'SecurityError';
            throw err;
        }
        this.values.delete(key);
    }
}

class FakeClock {
    constructor(now = 1000) {
        this.now = now;
        this.nextId = 1;
        this.timers = new Map();
    }
    setTimeout(fn, delay = 0) {
        const id = this.nextId++;
        this.timers.set(id, { at: this.now + Math.max(0, Number(delay) || 0), fn });
        return id;
    }
    clearTimeout(id) { this.timers.delete(id); }
    advance(ms) {
        const target = this.now + ms;
        while (true) {
            const due = [...this.timers.entries()]
                .filter(([, t]) => t.at <= target)
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

function createHarness({
    now = 1000,
    tabId = 'tab-test',
    localStorage = new FakeStorage(),
    sessionStorage = new FakeStorage(),
    locks = null
} = {}) {
    const clock = new FakeClock(now);
    const location = {
        href: 'https://hh.ru/search/vacancy',
        pathname: '/search/vacancy',
        search: '',
        reload() {}
    };
    const document = {
        title: 'Тест Вакансия',
        referrer: '',
        hidden: false,
        documentElement: { lang: 'ru', classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, scrollHeight: 0, clientHeight: 0 },
        body: { contains: () => true, scrollHeight: 0, appendChild() {} },
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({
            style: { setProperty() {} },
            classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
            appendChild() {},
            remove() {},
            click() {},
            setAttribute() {}
        }),
        createDocumentFragment: () => ({ appendChild() {} }),
        createTextNode: text => ({ textContent: text }),
        addEventListener() {}
    };

    class FakeDate extends Date {
        constructor(...args) { super(...(args.length ? args : [clock.now])); }
        static now() { return clock.now; }
    }

    const navigatorObj = {
        language: 'ru-RU',
        userAgent: 'stabilization-test',
        ...(locks ? { locks } : {})
    };

    const context = {
        console: { log() {}, warn() {}, error() {} },
        document,
        location,
        navigator: navigatorObj,
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
        requestAnimationFrame: fn => clock.setTimeout(() => fn(clock.now), 16),
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
        State,
        TAB_ID,
        KEYS,
        TUNING,
        SELECTORS,
        SUPPORTED_LANGUAGES,
        LOCALE_TAGS,
        TRANSLATIONS,
        PRESETS,
        WORK_MODE_KEYS,
        DEFAULTS,
        STATS_FIELDS,
        STATUS_KEYS,
        storage,
        logStorageError,
        DiagLog,
        Metrics,
        Stats,
        runHeuristic,
        runHeuristicAll,
        getVacancyCard,
        getNativeWrapper,
        readSerpCardTitle,
        isRunCurrent,
        leaseRuntime: () => ({
            leaseId: typeof currentInstanceLeaseId === 'undefined' ? null : currentInstanceLeaseId,
            verified: typeof instanceLeaseVerified === 'undefined' ? false : instanceLeaseVerified,
            hasActiveWebLock: typeof hasActiveWebLock === 'undefined' ? false : hasActiveWebLock
        })
    };
    return;
`;
    assert.ok(SCRIPT_SOURCE.includes(HOOK_MARKER));
    const source = SCRIPT_SOURCE.replace(HOOK_MARKER, hook + HOOK_MARKER);
    vm.createContext(context);
    vm.runInContext(source, context, { filename: SCRIPT_PATH });
    return { hooks: context.__hhApplyAssistantTestHooks, clock, localStorage, sessionStorage };
}

async function acquire(harness) {
    const pending = harness.hooks.State.acquireInstanceLock(harness.hooks.TAB_ID);
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
    harness.clock.advance(60);
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
    return pending;
}

test('Static configuration objects, translations, and selector maps are frozen (Prototype Pollution protection)', () => {
    const { hooks } = createHarness();
    assert.ok(Object.isFrozen(hooks.KEYS), 'KEYS must be frozen');
    assert.ok(Object.isFrozen(hooks.TUNING), 'TUNING must be frozen');
    assert.ok(Object.isFrozen(hooks.SELECTORS), 'SELECTORS must be frozen');
    assert.ok(Object.isFrozen(hooks.SUPPORTED_LANGUAGES), 'SUPPORTED_LANGUAGES must be frozen');
    assert.ok(Object.isFrozen(hooks.LOCALE_TAGS), 'LOCALE_TAGS must be frozen');
    assert.ok(Object.isFrozen(hooks.TRANSLATIONS), 'TRANSLATIONS must be frozen');
    assert.ok(Object.isFrozen(hooks.TRANSLATIONS.ru), 'TRANSLATIONS.ru must be deep frozen');
    assert.ok(Object.isFrozen(hooks.TRANSLATIONS.en), 'TRANSLATIONS.en must be deep frozen');
    assert.ok(Object.isFrozen(hooks.PRESETS), 'PRESETS must be frozen');
    assert.ok(Object.isFrozen(hooks.PRESETS.safe), 'PRESETS.safe must be deep frozen');
    assert.ok(Object.isFrozen(hooks.WORK_MODE_KEYS), 'WORK_MODE_KEYS must be frozen');
    assert.ok(Object.isFrozen(hooks.DEFAULTS), 'DEFAULTS must be frozen');
    assert.ok(Object.isFrozen(hooks.STATS_FIELDS), 'STATS_FIELDS must be frozen');
    assert.ok(Object.isFrozen(hooks.STATUS_KEYS), 'STATUS_KEYS must be frozen');

    assert.throws(() => {
        'use strict';
        hooks.KEYS.polluted = 'evil';
    }, TypeError, 'Mutating frozen KEYS should throw TypeError');
});

test('Resilient storage layer catches QuotaExceededError and SecurityError safely without throwing uncaught exceptions', () => {
    const localStorage = new FakeStorage();
    const { hooks } = createHarness({ localStorage });

    // Normal operation
    assert.strictEqual(hooks.storage.localSet('test_key', 'test_val'), true);
    assert.strictEqual(hooks.storage.localGet('test_key'), 'test_val');
    const normalRead = hooks.storage.localRead('test_key');
    assert.strictEqual(normalRead.ok, true);
    assert.strictEqual(normalRead.value, 'test_val');

    // QuotaExceededError simulation
    localStorage.throwOnSet = true;
    localStorage.errorTypeToThrow = 'QuotaExceededError';
    assert.doesNotThrow(() => {
        const result = hooks.storage.localSet('overflow_key', 'some_big_data');
        assert.strictEqual(result, false, 'Storage write should gracefully return false on quota error');
    });

    // SecurityError simulation
    localStorage.throwOnSet = true;
    localStorage.errorTypeToThrow = 'SecurityError';
    assert.doesNotThrow(() => {
        const result = hooks.storage.localSet('secure_key', 'val');
        assert.strictEqual(result, false, 'Storage write should gracefully return false on SecurityError');
    });

    localStorage.throwOnGet = true;
    assert.doesNotThrow(() => {
        const getResult = hooks.storage.localGet('secure_key');
        assert.strictEqual(getResult, null);
        const readResult = hooks.storage.localRead('secure_key');
        assert.strictEqual(readResult.ok, false);
        assert.strictEqual(readResult.value, null);
    });

    // Diagnostic logging without recursion when logging itself fails
    assert.doesNotThrow(() => {
        hooks.logStorageError('local', 'setItem', hooks.KEYS.diagLog, new Error('Disk full'));
    });
});

test('Web Locks API integration: acquires exclusive lock, aborts gracefully, and falls back to storage verification', async () => {
    let requestedMode = null;
    let requestedIfAvailable = null;

    const fakeLocks = {
        async request(name, options, callback) {
            requestedMode = options?.mode;
            requestedIfAvailable = options?.ifAvailable;

            if (options?.signal?.aborted) {
                throw new Error('Aborted');
            }
            const fakeLock = { name, mode: options?.mode };
            return callback(fakeLock);
        }
    };

    const harness = createHarness({ locks: fakeLocks });

    // Tab acquires instance lock with Web Locks API
    const acquired = await acquire(harness);

    assert.strictEqual(acquired, true, 'Acquisition should succeed');
    assert.strictEqual(requestedMode, 'exclusive', 'Web lock should be requested in exclusive mode');
    assert.strictEqual(requestedIfAvailable, true, 'Web lock should be requested with ifAvailable: true');
    assert.strictEqual(harness.hooks.leaseRuntime().hasActiveWebLock, true, 'Runtime tracks active Web Lock');

    // Verification succeeds while lock is held
    assert.strictEqual(harness.hooks.State.verifyInstanceLock(harness.hooks.TAB_ID), 'OWNED');

    // Releasing instance lock cleans up Web Lock
    const released = harness.hooks.State.releaseInstanceLock(harness.hooks.TAB_ID);
    assert.strictEqual(released, true);
    assert.strictEqual(harness.hooks.leaseRuntime().hasActiveWebLock, false, 'Web Lock is released on releaseInstanceLock');
});

test('Web Locks API integration: holding promise stays pending until releaseInstanceLock is called', async () => {
    let lockHolderSettled = false;

    const fakeLocks = {
        async request(name, options, callback) {
            const fakeLock = { name, mode: options?.mode };
            const p = callback(fakeLock);
            p.then(() => { lockHolderSettled = true; });
            return p;
        }
    };

    const harness = createHarness({ locks: fakeLocks });

    const acquired = await acquire(harness);
    assert.strictEqual(acquired, true);
    assert.strictEqual(lockHolderSettled, false, 'Web lock holding promise must stay pending while lease is held');

    harness.hooks.State.releaseInstanceLock(harness.hooks.TAB_ID);
    await Promise.resolve();
    assert.strictEqual(lockHolderSettled, true, 'Web lock holding promise resolves when releaseInstanceLock is called');
});

test('Web Locks API integration: ifAvailable returns null when already held by another tab, failing acquisition closed', async () => {
    const fakeLocks = {
        async request(name, options, callback) {
            // Simulate lock is already held by another tab: callback receives null
            return callback(null);
        }
    };

    const harness = createHarness({ locks: fakeLocks });

    const acquired = await acquire(harness);

    assert.strictEqual(acquired, false, 'Acquisition must fail closed when Web Lock is unavailable');
    assert.strictEqual(harness.hooks.leaseRuntime().hasActiveWebLock, false);
    assert.strictEqual(harness.hooks.leaseRuntime().verified, false);
});

test('Web Locks fallback: when navigator.locks is unavailable, acquisition succeeds via localStorage verification', async () => {
    const harness = createHarness({ locks: null });

    const acquired = await acquire(harness);

    assert.strictEqual(acquired, true, 'Fallback acquisition must succeed via localStorage verification');
    assert.strictEqual(harness.hooks.leaseRuntime().verified, true);
    assert.strictEqual(harness.hooks.leaseRuntime().hasActiveWebLock, false, 'No Web Lock in fallback mode');
});

test('DOM null-safety: query and heuristic functions handle null / undefined root without throwing', () => {
    const { hooks } = createHarness();

    assert.doesNotThrow(() => {
        const res = hooks.runHeuristic('applyBtn', null);
        assert.strictEqual(res, null);
    });

    assert.doesNotThrow(() => {
        const resAll = hooks.runHeuristicAll('applyBtn', null);
        assert.strictEqual(Array.isArray(resAll), true);
        assert.strictEqual(resAll.length, 0);
    });

    assert.doesNotThrow(() => {
        const card = hooks.getVacancyCard(null);
        assert.strictEqual(card, null);
    });

    assert.doesNotThrow(() => {
        const wrapper = hooks.getNativeWrapper(null);
        assert.strictEqual(wrapper, null);
    });

    assert.doesNotThrow(() => {
        const title = hooks.readSerpCardTitle(null);
        assert.strictEqual(title, '');
    });
});
