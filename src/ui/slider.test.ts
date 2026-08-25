import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(__dirname, '../../');
const SCRIPT_PATH = path.join(ROOT, 'hh-apply-assistant.user.js');
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, 'utf8');
const HOOK_MARKER = '    // Перехват необработанных ошибок:';
const SETTINGS_KEY = 'hh_apply_assistant_s1_settings';

class FakeStorage {
    values = new Map<string, string>();
    failSet = new Set<string>();

    constructor(initial: Record<string, string> = {}) {
        this.values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
    }
    getItem(key: string) { return this.values.has(key) ? this.values.get(key)! : null; }
    setItem(key: string, value: string) {
        if (this.failSet.has(key)) throw new Error(`setItem failed: ${key}`);
        this.values.set(key, String(value));
    }
    removeItem(key: string) { this.values.delete(key); }
}

class FakeScheduler {
    now = 1_000;
    nextId = 1;
    timeouts = new Map<number, { fn: () => void; delay: number }>();
    rafs = new Map<number, (time: number) => void>();
    resizeCallbacks: Array<(entries: any[]) => void> = [];

    setTimeout(fn: () => void, delay = 0) {
        const id = this.nextId++;
        this.timeouts.set(id, { fn, delay: Math.max(0, Number(delay) || 0) });
        return id;
    }
    clearTimeout(id: number) { this.timeouts.delete(id); }
    requestAnimationFrame(fn: (time: number) => void) {
        const id = this.nextId++;
        this.rafs.set(id, fn);
        return id;
    }
    cancelAnimationFrame(id: number) { this.rafs.delete(id); }
    runNextTimeout() {
        const next = this.timeouts.entries().next().value;
        expect(next).toBeTruthy();
        const [id, timer] = next!;
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
        expect(turns).toBeLessThan(limit);
    }
    fireResize() { this.resizeCallbacks.forEach(callback => callback([])); }
}

class FakeClassList {
    values = new Set<string>();
    add(...names: string[]) { names.forEach(name => this.values.add(name)); }
    remove(...names: string[]) { names.forEach(name => this.values.delete(name)); }
    contains(name: string) { return this.values.has(name); }
    toggle(name: string, force?: boolean) {
        const enabled = force === undefined ? !this.values.has(name) : !!force;
        if (enabled) this.values.add(name); else this.values.delete(name);
        return enabled;
    }
}

class FakeElement {
    ownerDocument: any;
    id: string;
    tagName: string;
    children: FakeElement[] = [];
    parentElement: FakeElement | null = null;
    dataset: Record<string, string> = {};
    classList = new FakeClassList();
    style: any = { display: '', transform: '', setProperty(name: string, value: string) { this[name] = value; } };
    clientWidth = 70;
    offsetWidth = 10;
    textContent = '';
    listeners = new Map<string, any[]>();
    isFragment = false;

    constructor(document: any, id = '', tagName = 'div') {
        this.ownerDocument = document;
        this.id = id;
        this.tagName = tagName.toUpperCase();
    }

    appendChild(child: FakeElement) {
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
    replaceChildren(...children: FakeElement[]) {
        this.children = [];
        children.forEach(child => this.appendChild(child));
    }
    contains(node: FakeElement): boolean {
        if (node === this) return true;
        return this.children.some(child => child.contains(node));
    }
    addEventListener(type: string, listener: any) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }
    removeEventListener(type: string, listener: any) {
        const listeners = this.listeners.get(type) || [];
        this.listeners.set(type, listeners.filter(candidate => candidate !== listener));
    }
    dispatch(type: string, init: any = {}) {
        const event = { target: this, stopPropagation() {}, preventDefault() {}, ...init };
        (this as any)[`on${type}`]?.(event);
        (this.listeners.get(type) || []).forEach(listener => listener(event));
    }
    setAttribute(name: string, value: any) { (this as any)[name] = String(value); }
    focus() {}
    getAnimations() { return []; }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: 24 }; }
    animate() {
        const animation = {
            element: this,
            onfinish: null as any,
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
    const elements = new Map<string, FakeElement>();

    const document: any = {
        title: '',
        referrer: '',
        hidden: false,
        cellCreations: 0,
        animations: [] as any[],
        documentElement: null,
        body: null,
        getElementById(id: string) { return elements.get(id) || null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement(tagName: string) {
            if (String(tagName).toLowerCase() === 'span') this.cellCreations++;
            return new FakeElement(this, '', tagName);
        },
        createDocumentFragment() {
            const frag = new FakeElement(this, '', 'fragment');
            frag.isFragment = true;
            return frag;
        },
        createTextNode(text: string) { return { textContent: text }; },
        addEventListener() {},
        removeEventListener() {}
    };
    document.documentElement = new FakeElement(document, 'document-element', 'html');
    document.documentElement.lang = 'ru';
    document.body = new FakeElement(document, 'body', 'body');

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
        constructor(callback: (entries: any[]) => void) { scheduler.resizeCallbacks.push(callback); }
        observe() {}
        disconnect() {}
    }
    class FakeDate extends Date {
        constructor(...args: any[]) {
            super((args[0] !== undefined ? args[0] : scheduler.now) as any);
        }
        static override now() { return scheduler.now; }
    }

    const location = {
        href: 'https://hh.ru/search/vacancy',
        pathname: '/search/vacancy',
        search: '',
        reload() {}
    };
    const context: any = {
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
    expect(SCRIPT_SOURCE.includes(HOOK_MARKER)).toBe(true);
    const source = SCRIPT_SOURCE.replace(HOOK_MARKER, hook + HOOK_MARKER);
    vm.createContext(context);
    vm.runInContext(source, context, { filename: SCRIPT_PATH });

    const uiController = new AbortController();
    const el = (id: string) => document.getElementById(id);
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

test('hidden Turbo cannot restart from resize or deferred mount frames and resumes when reopened', () => {
    const harness = createHarness({ preset: 'turbo' });
    harness.hooks.WorkModeSlider.mount({ el: harness.el, uiSignal: harness.uiController.signal });
    expect(harness.scheduler.timeouts.size).toBeGreaterThan(0);

    harness.panel.style.display = 'none';
    harness.hooks.WorkModeSlider.onVisibilityChange(false);
    expect(harness.scheduler.timeouts.size).toBe(0);

    const cellsBeforeLateResize = harness.document.cellCreations;
    harness.scheduler.fireResize();
    expect(harness.document.cellCreations).toBe(cellsBeforeLateResize);
    expect(harness.scheduler.timeouts.size).toBe(0);

    harness.scheduler.flushAnimationFrames();
    expect(harness.scheduler.timeouts.size).toBe(0);
    expect(harness.scheduler.rafs.size).toBe(0);

    harness.panel.style.display = 'flex';
    harness.hooks.WorkModeSlider.onVisibilityChange(true);
    expect(harness.scheduler.timeouts.size).toBeGreaterThan(0);

    harness.mainView.style.display = 'none';
    harness.hooks.WorkModeSlider.onVisibilityChange(false);
    harness.hooks.WorkModeSlider.onVisibilityChange(true);
    expect(harness.scheduler.timeouts.size).toBe(0);

    harness.mainView.style.display = 'flex';
    harness.hooks.WorkModeSlider.onVisibilityChange(true);
    expect(harness.scheduler.timeouts.size).toBeGreaterThan(0);
});

test('hiding an active Turbo shockwave cancels its rAF loop', () => {
    const harness = createHarness({ preset: 'turbo' });
    harness.hooks.WorkModeSlider.mount({ el: harness.el, uiSignal: harness.uiController.signal });
    harness.scheduler.flushAnimationFrames();

    harness.scheduler.runNextTimeout();
    const firstBodyAnimation = harness.document.animations.find((a: any) => a.element.id === 'ar-work-mode-thumb-body');
    expect(firstBodyAnimation).toBeTruthy();
    firstBodyAnimation.finish();
    harness.scheduler.runNextTimeout();
    const bodyAnimations = harness.document.animations.filter((a: any) => a.element.id === 'ar-work-mode-thumb-body');
    bodyAnimations.at(-1).finish();
    expect(harness.scheduler.rafs.size).toBeGreaterThan(0);

    harness.panel.style.display = 'none';
    harness.hooks.WorkModeSlider.onVisibilityChange(false);
    expect(harness.scheduler.timeouts.size).toBe(0);
    expect(harness.scheduler.rafs.size).toBe(0);
});

test('Safe, Balanced and Fast modes never schedule Turbo pulse work', () => {
    for (const preset of ['safe', 'balanced', 'fast']) {
        const harness = createHarness({ preset });
        harness.hooks.WorkModeSlider.mount({ el: harness.el, uiSignal: harness.uiController.signal });
        harness.scheduler.flushAnimationFrames();
        expect(harness.scheduler.timeouts.size).toBe(0);
        expect(harness.document.cellCreations).toBe(0);
        harness.scheduler.fireResize();
        harness.scheduler.fireResize();
        harness.scheduler.fireResize();
        harness.scheduler.flushAnimationFrames();
        expect(harness.document.cellCreations).toBe(0);
    }
});

test('Turbo grid mounts lazily, survives the exit transition, and cleans up after 220ms', () => {
    const harness = createHarness({ preset: 'fast' });
    harness.hooks.WorkModeSlider.mount({ el: harness.el, uiSignal: harness.uiController.signal });
    harness.scheduler.flushAnimationFrames();
    expect(harness.gridStrip.children.length).toBe(0);

    harness.slider.dispatch('keydown', { key: 'End' });
    const mountedCellCount = harness.gridStrip.children.length;
    expect(mountedCellCount).toBeGreaterThan(0);
    expect(harness.slider.classList.contains('has-turbo-grid')).toBe(true);

    harness.slider.dispatch('keydown', { key: 'ArrowLeft' });
    expect(harness.gridStrip.children.length).toBe(mountedCellCount);
    const cleanupTimer = [...harness.scheduler.timeouts.values()].find(timer => timer.delay === 220);
    expect(cleanupTimer).toBeTruthy();
    cleanupTimer!.fn();
    expect(harness.gridStrip.children.length).toBe(0);
    expect(harness.slider.classList.contains('has-turbo-grid')).toBe(false);
});

test('stale Turbo exit cleanup cannot delete a grid after rapid re-entry', () => {
    const harness = createHarness({ preset: 'fast' });
    harness.hooks.WorkModeSlider.mount({ el: harness.el, uiSignal: harness.uiController.signal });
    harness.scheduler.flushAnimationFrames();

    harness.slider.dispatch('keydown', { key: 'End' });
    harness.slider.dispatch('keydown', { key: 'ArrowLeft' });
    const staleCleanup = [...harness.scheduler.timeouts.values()].find(timer => timer.delay === 220);
    expect(staleCleanup).toBeTruthy();

    harness.slider.dispatch('keydown', { key: 'End' });
    const activeCellCount = harness.gridStrip.children.length;
    expect(activeCellCount).toBeGreaterThan(0);
    staleCleanup!.fn();
    expect(harness.gridStrip.children.length).toBe(activeCellCount);
    expect(harness.slider.classList.contains('has-turbo-grid')).toBe(true);
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

    expect(harness.document.cellCreations).toBe(creationsBeforeResize + cellsPerGrid);
});

test('100 Safe to Turbo cycles leave no active grid work after cleanup', () => {
    const harness = createHarness({ preset: 'safe' });
    harness.hooks.WorkModeSlider.mount({ el: harness.el, uiSignal: harness.uiController.signal });
    harness.scheduler.flushAnimationFrames();

    let expectedCellCount = 0;
    for (let cycle = 0; cycle < 100; cycle++) {
        harness.slider.dispatch('keydown', { key: 'End' });
        expectedCellCount ||= harness.gridStrip.children.length;
        expect(harness.gridStrip.children.length).toBe(expectedCellCount);

        harness.slider.dispatch('keydown', { key: 'Home' });
        const cleanupEntry = [...harness.scheduler.timeouts.entries()].find(([, timer]) => timer.delay === 220);
        expect(cleanupEntry).toBeTruthy();
        harness.scheduler.timeouts.delete(cleanupEntry![0]);
        cleanupEntry![1].fn();
        expect(harness.gridStrip.children.length).toBe(0);
    }

    harness.hooks.WorkModeSlider.destroy();
    expect(harness.gridStrip.children.length).toBe(0);
    const turboLifecycleDelays = [...harness.scheduler.timeouts.values()]
        .map(timer => timer.delay)
        .filter(delay => [80, 220, 255, 400, 600].includes(delay));
    expect(turboLifecycleDelays).toEqual([]);
    expect(harness.scheduler.rafs.size).toBe(0);
    expect(harness.document.animations.every((a: any) => a.cancelled)).toBe(true);
});
