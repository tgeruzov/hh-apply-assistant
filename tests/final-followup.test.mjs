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
const SETTINGS_KEY = 'hh_apply_assistant_v4_settings';

class FakeStorage {
    constructor(initial = {}) {
        this.values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
        this.failSet = new Set();
    }
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
    setItem(key, value) {
        if (this.failSet.has(key)) throw new Error(`setItem failed: ${key}`);
        this.values.set(key, String(value));
    }
    removeItem(key) { this.values.delete(key); }
}

class FakeScheduler {
    constructor() {
        this.now = 1_000;
        this.nextId = 1;
        this.timeouts = new Map();
        this.rafs = new Map();
        this.resizeCallbacks = [];
    }
    setTimeout(fn, delay = 0) {
        const id = this.nextId++;
        this.timeouts.set(id, { fn, delay: Math.max(0, Number(delay) || 0) });
        return id;
    }
    clearTimeout(id) { this.timeouts.delete(id); }
    requestAnimationFrame(fn) {
        const id = this.nextId++;
        this.rafs.set(id, fn);
        return id;
    }
    cancelAnimationFrame(id) { this.rafs.delete(id); }
    runNextTimeout() {
        const next = this.timeouts.entries().next().value;
        assert.ok(next, 'expected a pending timeout');
        const [id, timer] = next;
        this.timeouts.delete(id);
        timer.fn();
    }
    flushAnimationFrames(limit = 20) {
        let turns = 0;
        while (this.rafs.size && turns++ < limit) {
            const batch = [...this.rafs.values()];
            this.rafs.clear();
            batch.forEach(fn => fn(this.now));
            this.now += 16;
        }
        assert.ok(turns < limit, 'animation frames should settle');
    }
    fireResize() { this.resizeCallbacks.forEach(callback => callback([])); }
}

class FakeClassList {
    constructor() { this.values = new Set(); }
    add(...names) { names.forEach(name => this.values.add(name)); }
    remove(...names) { names.forEach(name => this.values.delete(name)); }
    contains(name) { return this.values.has(name); }
    toggle(name, force) {
        const enabled = force === undefined ? !this.values.has(name) : !!force;
        if (enabled) this.values.add(name); else this.values.delete(name);
        return enabled;
    }
}

class FakeElement {
    constructor(document, id = '', tagName = 'div') {
        this.ownerDocument = document;
        this.id = id;
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.parentElement = null;
        this.dataset = {};
        this.classList = new FakeClassList();
        this.style = {
            display: '',
            transform: '',
            setProperty(name, value) { this[name] = value; }
        };
        this.clientWidth = 70;
        this.offsetWidth = 10;
        this.textContent = '';
        this.listeners = new Map();
    }
    appendChild(child) {
        if (child?.isFragment) {
            child.children.forEach(nested => this.appendChild(nested));
            return child;
        }
        if (child) {
            child.parentElement = this;
            this.children.push(child);
        }
        return child;
    }
    replaceChildren(...children) {
        this.children = [];
        children.forEach(child => this.appendChild(child));
    }
    contains(node) {
        if (node === this) return true;
        return this.children.some(child => child.contains?.(node));
    }
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }
    removeEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        this.listeners.set(type, listeners.filter(candidate => candidate !== listener));
    }
    dispatch(type, init = {}) {
        const event = { target: this, stopPropagation() {}, preventDefault() {}, ...init };
        this[`on${type}`]?.(event);
        (this.listeners.get(type) || []).forEach(listener => listener(event));
    }
    setAttribute(name, value) { this[name] = String(value); }
    focus() {}
    getAnimations() { return []; }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: 24 }; }
    animate() {
        const animation = {
            element: this,
            onfinish: null,
            cancelled: false,
            cancel() { this.cancelled = true; },
            finish() { this.onfinish?.(); }
        };
        this.ownerDocument.animations.push(animation);
        return animation;
    }
}

function createHarness({ preset = 'balanced' } = {}) {
    const scheduler = new FakeScheduler();
    const initialConfig = {
        coverText: 'old letter',
        useCover: true,
        applyOnRejectWarning: true,
        skipHidden: true,
        preset,
        limit: 12
    };
    const localStorage = new FakeStorage({ [SETTINGS_KEY]: JSON.stringify(initialConfig) });
    const sessionStorage = new FakeStorage();
    const elements = new Map();

    const document = {
        title: '',
        referrer: '',
        hidden: false,
        cellCreations: 0,
        animations: [],
        documentElement: null,
        body: null,
        getElementById(id) { return elements.get(id) || null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement(tagName) {
            if (String(tagName).toLowerCase() === 'span') this.cellCreations++;
            return new FakeElement(this, '', tagName);
        },
        createDocumentFragment() {
            return { isFragment: true, children: [], appendChild(node) { this.children.push(node); } };
        },
        createTextNode(text) { return { textContent: text }; },
        addEventListener() {},
        removeEventListener() {}
    };
    document.documentElement = new FakeElement(document, 'document-element', 'html');
    document.documentElement.lang = 'ru';
    document.documentElement.scrollHeight = 0;
    document.documentElement.clientHeight = 0;
    document.body = new FakeElement(document, 'body', 'body');
    document.body.scrollHeight = 0;

    const panel = new FakeElement(document, 'ar-main-panel');
    const mainView = new FakeElement(document, 'ar-view-main');
    const modeCard = new FakeElement(document, 'ar-mode-card');
    const slider = new FakeElement(document, 'ar-work-mode-slider');
    const thumb = new FakeElement(document, 'ar-work-mode-thumb');
    const thumbShadow = new FakeElement(document, 'ar-work-mode-thumb-shadow');
    const thumbBody = new FakeElement(document, 'ar-work-mode-thumb-body');
    const modeState = new FakeElement(document, 'ar-work-mode-state');
    const gridStrip = new FakeElement(document, 'ar-work-mode-grid-strip');
    panel.appendChild(mainView);
    mainView.appendChild(modeCard);
    modeCard.appendChild(slider);
    slider.appendChild(thumb);
    slider.appendChild(thumbShadow);
    thumb.appendChild(thumbBody);
    slider.appendChild(gridStrip);
    [panel, mainView, modeCard, slider, thumb, thumbShadow, thumbBody, modeState, gridStrip]
        .forEach(element => elements.set(element.id, element));

    const mediaQuery = {
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {}
    };
    class FakeResizeObserver {
        constructor(callback) { scheduler.resizeCallbacks.push(callback); }
        observe() {}
        disconnect() {}
    }
    class FakeDate extends Date {
        constructor(...args) { super(...(args.length ? args : [scheduler.now])); }
        static now() { return scheduler.now; }
    }

    const location = {
        href: 'https://hh.ru/search/vacancy',
        pathname: '/search/vacancy',
        search: '',
        reload() {}
    };
    const context = {
        console: { log() {}, warn() {}, error() {} },
        document,
        location,
        navigator: { language: 'ru-RU', userAgent: 'final-followup-test' },
        localStorage,
        sessionStorage,
        Date: FakeDate,
        Math,
        URL,
        Blob,
        AbortController,
        Event,
        ResizeObserver: FakeResizeObserver,
        setTimeout: scheduler.setTimeout.bind(scheduler),
        clearTimeout: scheduler.clearTimeout.bind(scheduler),
        setInterval: () => 1,
        clearInterval() {},
        requestAnimationFrame: scheduler.requestAnimationFrame.bind(scheduler),
        cancelAnimationFrame: scheduler.cancelAnimationFrame.bind(scheduler),
        performance: { now: () => scheduler.now },
        matchMedia: () => mediaQuery,
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
        persistSettings,
        State,
        WorkModeSlider,
        getConfig: () => ({ ...config }),
        runtime: () => ({ currentRunId, isLoopActive, stopSignal })
    };
    return;
`;
    assert.ok(SCRIPT_SOURCE.includes(HOOK_MARKER));
    const source = SCRIPT_SOURCE.replace(HOOK_MARKER, hook + HOOK_MARKER);
    vm.createContext(context);
    vm.runInContext(source, context, { filename: SCRIPT_PATH });

    const uiController = new AbortController();
    const el = id => document.getElementById(id);
    return {
        hooks: context.__hhApplyAssistantTestHooks,
        localStorage,
        sessionStorage,
        scheduler,
        document,
        panel,
        mainView,
        slider,
        gridStrip,
        el,
        uiController
    };
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('successful Settings write commits matching runtime and storage config', () => {
    const harness = createHarness();
    const next = { ...harness.hooks.getConfig(), preset: 'fast', limit: 7, coverText: 'new letter' };
    assert.equal(harness.hooks.persistSettings(next), true);
    assert.deepEqual(plain(harness.hooks.getConfig()), next);
    assert.deepEqual(JSON.parse(harness.localStorage.getItem(SETTINGS_KEY)), next);
});

test('failed Settings write preserves previous runtime and persisted config', () => {
    const harness = createHarness();
    const beforeRuntime = plain(harness.hooks.getConfig());
    const beforeStorage = JSON.parse(harness.localStorage.getItem(SETTINGS_KEY));
    harness.localStorage.failSet.add(SETTINGS_KEY);
    assert.equal(harness.hooks.persistSettings({ ...beforeRuntime, limit: 99 }), false);
    assert.deepEqual(plain(harness.hooks.getConfig()), beforeRuntime);
    assert.deepEqual(JSON.parse(harness.localStorage.getItem(SETTINGS_KEY)), beforeStorage);
});

test('active automation stops fail-closed when critical Settings persistence fails', () => {
    const harness = createHarness();
    const beforeRuntime = plain(harness.hooks.getConfig());
    harness.hooks.State.setRunning(true);
    harness.localStorage.failSet.add(SETTINGS_KEY);
    assert.equal(harness.hooks.persistSettings({ ...beforeRuntime, preset: 'turbo' }), false);
    assert.equal(harness.hooks.State.amIRunning(), false);
    assert.equal(harness.hooks.runtime().stopSignal, true);
    assert.deepEqual(plain(harness.hooks.getConfig()), beforeRuntime);
});

test('hidden Turbo cannot restart from resize or deferred mount frames and resumes when reopened', () => {
    const harness = createHarness({ preset: 'turbo' });
    harness.hooks.WorkModeSlider.mount({ el: harness.el, uiSignal: harness.uiController.signal });
    assert.ok(harness.scheduler.timeouts.size > 0, 'visible Turbo should schedule its pulse');

    harness.panel.style.display = 'none';
    harness.hooks.WorkModeSlider.onVisibilityChange(false);
    assert.equal(harness.scheduler.timeouts.size, 0, 'hide should clear Turbo timers');

    const cellsBeforeLateResize = harness.document.cellCreations;
    harness.scheduler.fireResize();
    assert.equal(harness.document.cellCreations, cellsBeforeLateResize, 'hidden resize must not rebuild Turbo cells');
    assert.equal(harness.scheduler.timeouts.size, 0, 'hidden resize must not restart Turbo');

    harness.scheduler.flushAnimationFrames();
    assert.equal(harness.scheduler.timeouts.size, 0, 'deferred mount frames must not restart hidden Turbo');
    assert.equal(harness.scheduler.rafs.size, 0, 'hidden Turbo must not leave an rAF loop');

    harness.panel.style.display = 'flex';
    harness.hooks.WorkModeSlider.onVisibilityChange(true);
    assert.ok(harness.scheduler.timeouts.size > 0, 'reopened Turbo should schedule its pulse again');

    harness.mainView.style.display = 'none';
    harness.hooks.WorkModeSlider.onVisibilityChange(false);
    harness.hooks.WorkModeSlider.onVisibilityChange(true);
    assert.equal(harness.scheduler.timeouts.size, 0, 'hidden main/diagnostics view must keep Turbo stopped');

    harness.mainView.style.display = 'flex';
    harness.hooks.WorkModeSlider.onVisibilityChange(true);
    assert.ok(harness.scheduler.timeouts.size > 0, 'returning to the main view should resume Turbo');
});

test('hiding an active Turbo shockwave cancels its rAF loop', () => {
    const harness = createHarness({ preset: 'turbo' });
    harness.hooks.WorkModeSlider.mount({ el: harness.el, uiSignal: harness.uiController.signal });
    harness.scheduler.flushAnimationFrames();

    harness.scheduler.runNextTimeout();
    const firstBodyAnimation = harness.document.animations.find(animation => animation.element.id === 'ar-work-mode-thumb-body');
    assert.ok(firstBodyAnimation, 'Turbo pulse should start its depth animation');
    firstBodyAnimation.finish();
    harness.scheduler.runNextTimeout();
    const bodyAnimations = harness.document.animations.filter(animation => animation.element.id === 'ar-work-mode-thumb-body');
    bodyAnimations.at(-1).finish();
    assert.ok(harness.scheduler.rafs.size > 0, 'shockwave should own an active rAF');

    harness.panel.style.display = 'none';
    harness.hooks.WorkModeSlider.onVisibilityChange(false);
    assert.equal(harness.scheduler.timeouts.size, 0);
    assert.equal(harness.scheduler.rafs.size, 0, 'hide should cancel the active shockwave rAF');
});

test('Safe, Balanced and Fast modes never schedule Turbo pulse work', () => {
    for (const preset of ['safe', 'balanced', 'fast']) {
        const harness = createHarness({ preset });
        harness.hooks.WorkModeSlider.mount({ el: harness.el, uiSignal: harness.uiController.signal });
        harness.scheduler.flushAnimationFrames();
        assert.equal(harness.scheduler.timeouts.size, 0, `${preset} should not schedule Turbo timers`);
        assert.equal(harness.document.cellCreations, 0, `${preset} should not mount Turbo cells`);
        harness.scheduler.fireResize();
        harness.scheduler.fireResize();
        harness.scheduler.fireResize();
        harness.scheduler.flushAnimationFrames();
        assert.equal(harness.document.cellCreations, 0, `${preset} resize should not rebuild Turbo cells`);
    }
});

test('Turbo grid mounts lazily, survives the exit transition, and cleans up after 220ms', () => {
    const harness = createHarness({ preset: 'fast' });
    harness.hooks.WorkModeSlider.mount({ el: harness.el, uiSignal: harness.uiController.signal });
    harness.scheduler.flushAnimationFrames();
    assert.equal(harness.gridStrip.children.length, 0);

    harness.slider.dispatch('keydown', { key: 'End' });
    const mountedCellCount = harness.gridStrip.children.length;
    assert.ok(mountedCellCount > 0, 'entering Turbo should create the grid');
    assert.equal(harness.slider.classList.contains('has-turbo-grid'), true);

    harness.slider.dispatch('keydown', { key: 'ArrowLeft' });
    assert.equal(harness.gridStrip.children.length, mountedCellCount, 'grid should remain during Turbo exit');
    const cleanupTimer = [...harness.scheduler.timeouts.values()].find(timer => timer.delay === 220);
    assert.ok(cleanupTimer, 'Turbo exit should schedule the existing 220ms cleanup boundary');
    cleanupTimer.fn();
    assert.equal(harness.gridStrip.children.length, 0);
    assert.equal(harness.slider.classList.contains('has-turbo-grid'), false);
});

test('stale Turbo exit cleanup cannot delete a grid after rapid re-entry', () => {
    const harness = createHarness({ preset: 'fast' });
    harness.hooks.WorkModeSlider.mount({ el: harness.el, uiSignal: harness.uiController.signal });
    harness.scheduler.flushAnimationFrames();

    harness.slider.dispatch('keydown', { key: 'End' });
    harness.slider.dispatch('keydown', { key: 'ArrowLeft' });
    const staleCleanup = [...harness.scheduler.timeouts.values()].find(timer => timer.delay === 220);
    assert.ok(staleCleanup);

    harness.slider.dispatch('keydown', { key: 'End' });
    const activeCellCount = harness.gridStrip.children.length;
    assert.ok(activeCellCount > 0);
    staleCleanup.fn();
    assert.equal(harness.gridStrip.children.length, activeCellCount);
    assert.equal(harness.slider.classList.contains('has-turbo-grid'), true);
});

test('visible Turbo resize bursts coalesce to one grid rebuild per animation frame', () => {
    const harness = createHarness({ preset: 'turbo' });
    harness.hooks.WorkModeSlider.mount({ el: harness.el, uiSignal: harness.uiController.signal });
    harness.scheduler.flushAnimationFrames();
    const cellsPerGrid = harness.gridStrip.children.length;
    const creationsBeforeResize = harness.document.cellCreations;

    harness.scheduler.fireResize();
    harness.scheduler.fireResize();
    harness.scheduler.fireResize();
    harness.scheduler.flushAnimationFrames();

    assert.equal(harness.document.cellCreations, creationsBeforeResize + cellsPerGrid);
});

test('100 Safe to Turbo cycles leave no active grid work after cleanup', () => {
    const harness = createHarness({ preset: 'safe' });
    harness.hooks.WorkModeSlider.mount({ el: harness.el, uiSignal: harness.uiController.signal });
    harness.scheduler.flushAnimationFrames();

    let expectedCellCount = 0;
    for (let cycle = 0; cycle < 100; cycle++) {
        harness.slider.dispatch('keydown', { key: 'End' });
        expectedCellCount ||= harness.gridStrip.children.length;
        assert.equal(harness.gridStrip.children.length, expectedCellCount);

        harness.slider.dispatch('keydown', { key: 'Home' });
        const cleanupEntry = [...harness.scheduler.timeouts.entries()].find(([, timer]) => timer.delay === 220);
        assert.ok(cleanupEntry, `cycle ${cycle + 1} should schedule grid cleanup`);
        harness.scheduler.timeouts.delete(cleanupEntry[0]);
        cleanupEntry[1].fn();
        assert.equal(harness.gridStrip.children.length, 0);
    }

    harness.hooks.WorkModeSlider.destroy();
    assert.equal(harness.gridStrip.children.length, 0);
    const turboLifecycleDelays = [...harness.scheduler.timeouts.values()]
        .map(timer => timer.delay)
        .filter(delay => [80, 220, 255, 400, 600].includes(delay));
    assert.deepEqual(turboLifecycleDelays, []);
    assert.equal(harness.scheduler.rafs.size, 0);
    assert.ok(harness.document.animations.every(animation => animation.cancelled));
});
