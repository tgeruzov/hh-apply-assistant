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

const KEYS = {
    lock: 'hh_apply_assistant_s1_instance_lock',
    tabId: 'hh_apply_assistant_s1_tab_id'
};
const TTL = 30_000;

class FakeStorage {
    constructor(initial = {}) {
        this.values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
        this.failGet = new Set();
        this.failSet = new Set();
        this.failRemove = new Set();
        this.ignoreSet = new Set();
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
        this.values.delete(key);
    }
}

class FakeClock {
    constructor(now = 1_000) {
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

function classList() {
    return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
}

function createHarness({
    now = 1_000,
    tabId = 'tab-a',
    localStorage = new FakeStorage(),
    sessionStorage = new FakeStorage({ [KEYS.tabId]: tabId })
} = {}) {
    const clock = new FakeClock(now);
    const location = {
        href: 'https://hh.ru/search/vacancy',
        pathname: '/search/vacancy',
        search: '',
        reload() {}
    };
    const document = {
        title: '',
        referrer: '',
        hidden: false,
        documentElement: { lang: 'ru', classList: classList(), scrollHeight: 0, clientHeight: 0 },
        body: { contains: () => true, scrollHeight: 0, appendChild() {} },
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({
            style: { setProperty() {} },
            classList: classList(),
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
    const context = {
        console: { log() {}, warn() {}, error() {} },
        document,
        location,
        navigator: { language: 'ru-RU', userAgent: 'phase3-test' },
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
        isRunCurrent,
        guardOwnedCommit: typeof guardOwnedCommit === 'function' ? guardOwnedCommit : null,
        leaseRuntime: () => ({
            leaseId: typeof currentInstanceLeaseId === 'undefined' ? null : currentInstanceLeaseId,
            verified: typeof instanceLeaseVerified === 'undefined' ? false : instanceLeaseVerified
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
    harness.clock.advance(60);
    return pending;
}

function storedLease(storage) {
    const raw = storage.getItem(KEYS.lock);
    return raw ? JSON.parse(raw) : null;
}

test('previous namespace lease is ignored and left untouched', async () => {
    const previousKey = 'hh_ar_v2_instance_lock';
    const previousLease = JSON.stringify({ tabId: 'previous-tab', ts: 1_000 });
    const shared = new FakeStorage({ [previousKey]: previousLease });
    const current = createHarness({ tabId: 'current-tab', localStorage: shared });
    assert.equal(await acquire(current), true);
    assert.equal(storedLease(shared).tabId, 'current-tab');
    assert.equal(shared.getItem(previousKey), previousLease);
});

test('invalid current lease schema is fail-closed and not rewritten', async () => {
    const invalidLease = { tabId: 'unknown-tab', ts: 1_000 };
    const shared = new FakeStorage({ [KEYS.lock]: JSON.stringify(invalidLease) });
    const current = createHarness({ now: 1_000, tabId: 'current-tab', localStorage: shared });
    assert.equal(await acquire(current), false);
    assert.deepEqual(storedLease(shared), invalidLease);
    assert.equal(current.hooks.State.verifyInstanceLock(current.hooks.TAB_ID), 'LOST');
});

test('A acquires a generated lease and B cannot acquire it while active', async () => {
    const shared = new FakeStorage();
    const a = createHarness({ tabId: 'tab-a', localStorage: shared });
    const b = createHarness({ tabId: 'tab-b', localStorage: shared });
    assert.equal(await acquire(a), true);
    const lease = storedLease(shared);
    assert.equal(lease.tabId, 'tab-a');
    assert.equal(typeof lease.leaseId, 'string');
    assert.ok(lease.leaseId.length > 0);
    assert.equal(await acquire(b), false);
    assert.deepEqual(storedLease(shared), lease);
});

test('expired A lease can be replaced by a new B generation', async () => {
    const shared = new FakeStorage();
    const a = createHarness({ now: 1_000, tabId: 'tab-a', localStorage: shared });
    const b = createHarness({ now: 1_000, tabId: 'tab-b', localStorage: shared });
    assert.equal(await acquire(a), true);
    const oldLeaseId = storedLease(shared).leaseId;
    b.clock.advance(TTL + 1);
    assert.equal(await acquire(b), true);
    const next = storedLease(shared);
    assert.equal(next.tabId, 'tab-b');
    assert.notEqual(next.leaseId, oldLeaseId);
});

test('A ownership verification fails after B takeover', async () => {
    const shared = new FakeStorage();
    const a = createHarness({ tabId: 'tab-a', localStorage: shared });
    const b = createHarness({ tabId: 'tab-b', localStorage: shared });
    assert.equal(await acquire(a), true);
    b.clock.advance(TTL + 1);
    assert.equal(await acquire(b), true);
    assert.equal(a.hooks.State.verifyInstanceLock(a.hooks.TAB_ID), 'LOST');
});

test('stale A heartbeat cannot overwrite B lease', async () => {
    const shared = new FakeStorage();
    const a = createHarness({ tabId: 'tab-a', localStorage: shared });
    const b = createHarness({ tabId: 'tab-b', localStorage: shared });
    assert.equal(await acquire(a), true);
    b.clock.advance(TTL + 1);
    assert.equal(await acquire(b), true);
    const bLease = storedLease(shared);
    assert.equal(a.hooks.State.touchInstanceLock(a.hooks.TAB_ID), 'LOST');
    assert.deepEqual(storedLease(shared), bLease);
});

test('stale A release cannot delete B lease', async () => {
    const shared = new FakeStorage();
    const a = createHarness({ tabId: 'tab-a', localStorage: shared });
    const b = createHarness({ tabId: 'tab-b', localStorage: shared });
    assert.equal(await acquire(a), true);
    const staleLeaseId = a.hooks.leaseRuntime().leaseId;
    b.clock.advance(TTL + 1);
    assert.equal(await acquire(b), true);
    const bLease = storedLease(shared);
    assert.equal(a.hooks.State.releaseInstanceLock(a.hooks.TAB_ID, staleLeaseId), false);
    assert.deepEqual(storedLease(shared), bLease);
});

test('same TAB_ID old generation cannot delete a newer generation', async () => {
    const sharedLocal = new FakeStorage();
    const sharedSession = new FakeStorage({ [KEYS.tabId]: 'same-tab' });
    const oldPage = createHarness({ tabId: 'same-tab', localStorage: sharedLocal, sessionStorage: sharedSession });
    const newPage = createHarness({ now: 2_000, tabId: 'same-tab', localStorage: sharedLocal, sessionStorage: sharedSession });
    assert.equal(await acquire(oldPage), true);
    const oldLeaseId = oldPage.hooks.leaseRuntime().leaseId;
    assert.equal(await acquire(newPage), true);
    const newLease = storedLease(sharedLocal);
    assert.notEqual(newLease.leaseId, oldLeaseId);
    assert.equal(oldPage.hooks.State.releaseInstanceLock(oldPage.hooks.TAB_ID, oldLeaseId), false);
    assert.deepEqual(storedLease(sharedLocal), newLease);
    assert.equal(oldPage.hooks.TAB_ID, newPage.hooks.TAB_ID);
});

test('search → vacancy → response → search keeps TAB_ID and fences every page generation', async () => {
    const sharedLocal = new FakeStorage();
    const sharedSession = new FakeStorage({ [KEYS.tabId]: 'navigation-tab' });
    const pages = [1_000, 2_000, 3_000, 4_000].map(now => createHarness({
        now,
        tabId: 'navigation-tab',
        localStorage: sharedLocal,
        sessionStorage: sharedSession
    }));
    const leaseIds = [];
    for (const page of pages) {
        assert.equal(await acquire(page), true);
        assert.equal(page.hooks.TAB_ID, 'navigation-tab');
        leaseIds.push(page.hooks.leaseRuntime().leaseId);
    }
    assert.equal(new Set(leaseIds).size, pages.length);
    assert.equal(pages.at(-1).hooks.State.verifyInstanceLock('navigation-tab'), 'OWNED');
    for (const stalePage of pages.slice(0, -1)) {
        assert.equal(stalePage.hooks.State.releaseInstanceLock('navigation-tab'), false);
    }
    assert.equal(storedLease(sharedLocal).leaseId, leaseIds.at(-1));
});

test('storage write failure during reacquire is not mistaken for ownership', async () => {
    const shared = new FakeStorage();
    const a = createHarness({ tabId: 'tab-a', localStorage: shared });
    assert.equal(await acquire(a), true);
    shared.failSet.add(KEYS.lock);
    assert.equal(await acquire(a), false);
    assert.equal(a.hooks.State.verifyInstanceLock(a.hooks.TAB_ID), 'LOST');
});

test('storage read failure during acquire is fail-closed', async () => {
    const shared = new FakeStorage();
    shared.failGet.add(KEYS.lock);
    const a = createHarness({ tabId: 'tab-a', localStorage: shared });
    assert.equal(await acquire(a), false);
});

test('acquire requires exact read-back of the newly written generation', async () => {
    const shared = new FakeStorage({
        [KEYS.lock]: JSON.stringify({ tabId: 'tab-a', leaseId: 'older-generation', ts: 1_000 })
    });
    shared.ignoreSet.add(KEYS.lock);
    const a = createHarness({ tabId: 'tab-a', localStorage: shared });
    assert.equal(await acquire(a), false);
    assert.equal(storedLease(shared).leaseId, 'older-generation');
});

test('storage failure during heartbeat loses ownership', async () => {
    const shared = new FakeStorage();
    const a = createHarness({ tabId: 'tab-a', localStorage: shared });
    assert.equal(await acquire(a), true);
    shared.failSet.add(KEYS.lock);
    assert.equal(a.hooks.State.touchInstanceLock(a.hooks.TAB_ID), 'LOST');
    assert.equal(a.hooks.State.verifyInstanceLock(a.hooks.TAB_ID), 'LOST');
});

test('heartbeat requires read-back of its exact renewed timestamp', async () => {
    const shared = new FakeStorage();
    const a = createHarness({ tabId: 'tab-a', localStorage: shared });
    assert.equal(await acquire(a), true);
    shared.ignoreSet.add(KEYS.lock);
    assert.equal(a.hooks.State.touchInstanceLock(a.hooks.TAB_ID), 'LOST');
});

test('stale async continuation cannot pass commit guard after takeover', async () => {
    const shared = new FakeStorage();
    const a = createHarness({ tabId: 'tab-a', localStorage: shared });
    const b = createHarness({ tabId: 'tab-b', localStorage: shared });
    a.hooks.State.setRunning(true);
    assert.equal(await acquire(a), true);

    let resume;
    const gap = new Promise(resolve => { resume = resolve; });
    let irreversibleActions = 0;
    const staleContinuation = (async () => {
        await gap;
        assert.equal(a.hooks.isRunCurrent(0), true, 'runId alone still sees the old tab-local run as current');
        if (a.hooks.guardOwnedCommit(0)) irreversibleActions++;
    })();

    b.clock.advance(TTL + 1);
    assert.equal(await acquire(b), true);
    resume();
    await staleContinuation;
    assert.equal(irreversibleActions, 0);
    assert.equal(a.hooks.State.amIRunning(), false);
});

test('normal single-tab acquire, renew, guarded commit and release remain valid', async () => {
    const shared = new FakeStorage();
    const a = createHarness({ tabId: 'tab-a', localStorage: shared });
    a.hooks.State.setRunning(true);
    assert.equal(await acquire(a), true);
    assert.equal(a.hooks.State.verifyInstanceLock(a.hooks.TAB_ID), 'OWNED');
    const beforeTouch = storedLease(shared);
    a.clock.advance(1_000);
    assert.equal(a.hooks.guardOwnedCommit(0), true);
    assert.ok(storedLease(shared).ts > beforeTouch.ts);
    assert.equal(a.hooks.State.releaseInstanceLock(a.hooks.TAB_ID), true);
    assert.equal(storedLease(shared), null);
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
    assert.match(realisticBody, /guardOwnedCommit\(runId\)/);
    assert.match(submitBody, /guardOwnedCommit\(runId\)[\s\S]*form\.submit\(\)/);
    assert.match(terminalBody, /function persistProcessedVacancy[\s\S]*guardOwnedCommit\(runId\)/);
    assert.match(terminalBody, /function persistSentCount[\s\S]*guardOwnedCommit\(runId\)/);
    assert.match(terminalBody, /function returnToList[\s\S]*guardOwnedCommit\(runId\)/);
    assert.match(SCRIPT_SOURCE, /addRuntimeListener\(window, 'pageshow'[\s\S]*event\.persisted[\s\S]*startLoop\(\)/);
});
