import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(__dirname, '../../');
const SCRIPT_PATH = path.join(ROOT, 'hh-apply-assistant.user.js');
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, 'utf8');
const HOOK_MARKER = '    // Перехват необработанных ошибок:';

class FakeStorage {
    values = new Map<string, string>();
    getItem(key: string) { return this.values.has(key) ? this.values.get(key)! : null; }
    setItem(key: string, value: string) { this.values.set(key, String(value)); }
    removeItem(key: string) { this.values.delete(key); }
}

class FakeClock {
    now = 1_000;
    nextId = 1;
    timers = new Map<number, { at: number; fn: () => void }>();

    setTimeout(fn: () => void, delay = 0) {
        const id = this.nextId++;
        this.timers.set(id, { at: this.now + Math.max(0, Number(delay) || 0), fn });
        return id;
    }
    clearTimeout(id: number) { this.timers.delete(id); }
    advance(ms: number) {
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

class FakeClassList {
    values = new Set<string>();
    add(...names: string[]) { names.forEach(name => this.values.add(name)); }
    remove(...names: string[]) { names.forEach(name => this.values.delete(name)); }
    toggle(name: string, force?: boolean) {
        const enabled = force === undefined ? !this.values.has(name) : !!force;
        if (enabled) this.values.add(name); else this.values.delete(name);
        return enabled;
    }
    contains(name: string) { return this.values.has(name); }
}

class FakeElement {
    ownerDocument: any;
    tagName: string;
    parentElement: FakeElement | null = null;
    children: FakeElement[] = [];
    attributes = new Map<string, string>();
    classList = new FakeClassList();
    className = '';
    style: any = { display: '', width: '', setProperty(name: string, value: string) { this[name] = value; } };
    visible = true;
    _textContent = '';
    _innerHTML = '';
    innerHTMLWrites = 0;
    textContentWrites = 0;
    scrollTop = 0;
    clientHeight = 200;
    disabled = false;
    checked = false;
    listeners = new Map<string, any[]>();
    isConnected = true;
    isFragment = false;
    value = '';
    onclick: any = null;

    constructor(ownerDocument: any, tagName = 'div', { text = '', visible = true } = {}) {
        this.ownerDocument = ownerDocument;
        this.tagName = tagName.toUpperCase();
        this.visible = visible;
        this._textContent = text;
    }

    get textContent() { return this._textContent; }
    set textContent(value: string) { this._textContent = String(value ?? ''); this.textContentWrites++; }
    get innerText() { return this._textContent; }
    set innerText(value: string) { this._textContent = String(value ?? ''); }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(value: string) {
        this._innerHTML = String(value ?? '');
        this.innerHTMLWrites++;
        if (value === '') this.children = [];
    }
    get childElementCount() { return this.children.length; }
    get scrollHeight() { return Math.max(this.clientHeight, this.children.length * 24); }

    appendChild(child: FakeElement) {
        if (!child) return child;
        if (child.isFragment) {
            for (const nested of [...child.children]) this.appendChild(nested);
            return child;
        }
        child.parentElement = this;
        this.children.push(child);
        return child;
    }
    replaceChildren(...children: FakeElement[]) {
        this.children = [];
        children.forEach(child => this.appendChild(child));
    }
    setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
    getAttribute(name: string) { return this.attributes.get(name) || ''; }
    remove() {
        if (!this.parentElement) return;
        this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
    }
    addEventListener(type: string, listener: any, options: any = {}) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }
    dispatch(type: string) {
        const event = { target: this, stopPropagation() {}, preventDefault() {} };
        (this as any)[`on${type}`]?.(event);
        (this.listeners.get(type) || []).forEach(listener => listener(event));
    }
    click() { this.dispatch('click'); }
    focus() {}
    matches() { return false; }
    closest() { return null; }
    getBoundingClientRect() { return { width: 100, height: 24, left: 0, top: 0 }; }
}

class FakeDocument {
    title = '';
    referrer = '';
    hidden = false;
    documentElement = new FakeElement(this, 'html');
    body = new FakeElement(this, 'body');
    elementsById = new Map<string, FakeElement>();
    listeners = new Map<string, any[]>();

    createElement(tagName: string) { return new FakeElement(this, tagName); }
    createDocumentFragment() {
        const fragment = new FakeElement(this, 'fragment');
        fragment.isFragment = true;
        return fragment;
    }
    createTextNode(text: string) { return new FakeElement(this, 'span', { text }); }
    getElementById(id: string) { return this.elementsById.get(id) || null; }
    addEventListener(type: string, listener: any) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }
    dispatch(type: string) {
        (this.listeners.get(type) || []).forEach(listener => listener({ target: this }));
    }
}

function createHarness() {
    const clock = new FakeClock();
    const document = new FakeDocument();
    class FakeDate extends Date {
        constructor(...args: any[]) {
            super((args[0] !== undefined ? args[0] : clock.now) as any);
        }
        static override now() { return clock.now; }
    }
    const location = {
        href: 'https://hh.ru/vacancy/42',
        pathname: '/vacancy/42',
        search: '',
        reload() {}
    };
    const context: any = {
        console: { log() {}, warn() {}, error() {} },
        document,
        location,
        navigator: { language: 'ru-RU', userAgent: 'diagnostics-test' },
        localStorage: new FakeStorage(),
        sessionStorage: new FakeStorage(),
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
        requestAnimationFrame: (fn: any) => clock.setTimeout(() => fn(clock.now), 16),
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
        I18n,
        DiagLog,
        DiagnosticsView,
        buildDiagnosticReport,
        log
    };
    return;
`;
    expect(SCRIPT_SOURCE.includes(HOOK_MARKER)).toBe(true);
    const source = SCRIPT_SOURCE.replace(HOOK_MARKER, hook + HOOK_MARKER);
    vm.createContext(context);
    vm.runInContext(source, context, { filename: SCRIPT_PATH });
    context.__hhApplyAssistantTestHooks.State.setRunning(true);
    return { hooks: context.__hhApplyAssistantTestHooks, document, clock, context };
}

function findByClass(root: FakeElement | null, className: string): FakeElement[] {
    const found: FakeElement[] = [];
    const visit = (node: FakeElement | null) => {
        if (!node) return;
        if (String(node.className || '').split(/\s+/).includes(className)) found.push(node);
        node.children?.forEach(visit);
    };
    visit(root);
    return found;
}

test('diagnostic log updates coalesce full renders and preserve controls', () => {
    const { hooks, document, clock } = createHarness();
    const ids = [
        'ar-main-panel', 'ar-view-main', 'ar-view-diag', 'ar-diag-full-box', 'ar-diag-back-btn',
        'ar-diag-filter-all', 'ar-diag-filter-errors', 'ar-diag-filter-all-count',
        'ar-diag-filter-errors-count', 'ar-diag-search', 'ar-diag-search-clear',
        'ar-diag-auto-scroll', 'ar-diag-check-status',
        'ar-health-badge', 'ar-health-btn', 'ar-diag-full-clear-all', 'ar-diag-full-dropdown'
    ];
    ids.forEach(id => document.elementsById.set(id, new FakeElement(document)));
    const el = (id: string) => document.getElementById(id)!;
    const viewMain = el('ar-view-main');
    const viewDiag = el('ar-view-diag');
    const fullBox = el('ar-diag-full-box');
    const badge = el('ar-health-badge');
    const errorsOnly = el('ar-diag-filter-errors');
    el('ar-main-panel').style.display = 'flex';
    viewMain.style.display = 'flex';
    viewDiag.style.display = 'none';
    hooks.DiagnosticsView.mount({ el, uiSignal: new AbortController().signal });

    el('ar-health-btn').onclick();
    expect(viewMain.style.display).toBe('none');
    expect(viewDiag.style.display).toBe('flex');
    fullBox.innerHTMLWrites = 0;
    badge.textContentWrites = 0;

    for (let index = 0; index < 1000; index++) hooks.log('repeat');
    expect(fullBox.innerHTMLWrites).toBe(0);
    clock.advance(16);
    expect(fullBox.innerHTMLWrites).toBe(1);
    expect(badge.textContentWrites).toBe(1000);
    const repeatBadges = findByClass(fullBox, 'ar-log-repeat');
    expect(repeatBadges.length).toBe(1);
    expect(repeatBadges[0].textContent).toMatch(/×1000/);

    const searchInput = el('ar-diag-search');
    const writesBeforeSearch = fullBox.innerHTMLWrites;
    for (const query of ['e', 'er', 'err', 'erro', 'error']) {
        searchInput.value = query;
        searchInput.dispatch('input');
    }
    expect(fullBox.innerHTMLWrites).toBe(writesBeforeSearch);
    clock.advance(139);
    expect(fullBox.innerHTMLWrites).toBe(writesBeforeSearch);
    clock.advance(1);
    expect(fullBox.innerHTMLWrites).toBe(writesBeforeSearch + 1);
    el('ar-diag-search-clear').click();

    hooks.log('failure', true);
    errorsOnly.click();
    clock.advance(16);
    const messages = findByClass(fullBox, 'ar-log-message').map(node => node.textContent);
    expect(messages).toEqual(['failure']);
    expect(el('ar-diag-filter-errors-count').textContent).toBe('1');
});

test('Diagnostics keeps slow and burst sources, counts, groups, and RU/EN exports bounded to 1000', () => {
    const { hooks, document, clock } = createHarness();
    const ids = [
        'ar-main-panel', 'ar-view-main', 'ar-view-diag', 'ar-diag-full-box', 'ar-diag-back-btn',
        'ar-diag-filter-all', 'ar-diag-filter-errors', 'ar-diag-filter-all-count',
        'ar-diag-filter-errors-count', 'ar-diag-search', 'ar-diag-search-clear',
        'ar-diag-auto-scroll', 'ar-diag-check-status', 'ar-health-badge', 'ar-health-btn',
        'ar-diag-full-clear-all', 'ar-diag-full-dropdown'
    ];
    ids.forEach(id => document.elementsById.set(id, new FakeElement(document)));
    const el = (id: string) => document.getElementById(id)!;
    el('ar-main-panel').style.display = 'flex';
    el('ar-view-main').style.display = 'flex';
    el('ar-view-diag').style.display = 'none';
    hooks.DiagnosticsView.mount({ el, uiSignal: new AbortController().signal });
    el('ar-health-btn').onclick();

    for (let index = 0; index < 1005; index++) {
        hooks.log(`slow ${index}`, index % 17 === 0);
    }
    expect(hooks.DiagLog.getAll().length).toBe(1000);
    expect(el('ar-diag-filter-all-count').textContent).toBe('1000');
    clock.advance(16);
    expect(findByClass(el('ar-diag-full-box'), 'ar-log-row').length).toBe(1000);

    for (const language of ['ru', 'en']) {
        hooks.I18n.setLanguage(language);
        hooks.DiagnosticsView.refresh();
        const report = hooks.buildDiagnosticReport();
        expect((report.match(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]/gm) || []).length).toBe(1000);
    }
});

test('hidden Diagnostics stays dirty without rendering and catches up exactly once per reopen', () => {
    const { hooks, document, clock } = createHarness();
    const ids = [
        'ar-main-panel', 'ar-view-main', 'ar-view-diag', 'ar-diag-full-box', 'ar-diag-back-btn',
        'ar-diag-filter-all', 'ar-diag-filter-errors', 'ar-diag-filter-all-count',
        'ar-diag-filter-errors-count', 'ar-diag-search', 'ar-diag-search-clear',
        'ar-diag-auto-scroll', 'ar-diag-check-status',
        'ar-health-badge', 'ar-health-btn', 'ar-diag-full-clear-all', 'ar-diag-full-dropdown'
    ];
    ids.forEach(id => document.elementsById.set(id, new FakeElement(document)));
    const el = (id: string) => document.getElementById(id)!;
    const panel = el('ar-main-panel');
    const viewMain = el('ar-view-main');
    const viewDiag = el('ar-view-diag');
    const fullBox = el('ar-diag-full-box');
    panel.style.display = 'flex';
    viewMain.style.display = 'flex';
    viewDiag.style.display = 'none';

    hooks.DiagnosticsView.mount({ el, uiSignal: new AbortController().signal });
    el('ar-health-btn').onclick();
    el('ar-diag-back-btn').onclick();
    fullBox.innerHTMLWrites = 0;

    for (let index = 0; index < 100; index++) hooks.log(`kept hidden ${index}`);
    clock.advance(16);
    expect(fullBox.innerHTMLWrites).toBe(0);

    el('ar-health-btn').onclick();
    expect(fullBox.innerHTMLWrites).toBe(1);
});
