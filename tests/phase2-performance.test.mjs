import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(TEST_DIR, '..', 'script.js');
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, 'utf8');
const HOOK_MARKER = '    // Перехват необработанных ошибок:';

const SELECTORS = {
    relocation: '[data-qa="relocation-warning-confirm"]',
    submit: '[data-qa="vacancy-response-letter-submit"], button[data-qa="vacancy-response-letter-submit"], button[data-qa="vacancy-response-submit-popup"], [data-qa="vacancy-response-submit-popup"]',
    attach: '[data-qa="responded-success-attach-cover-letter"]',
    chat: '[data-qa="vacancy-response-link-view-topic"]',
    reject: '[data-qa="response-reject-warning"]',
    questionnaire: 'textarea[name^="task_"], input[name^="task_"], select[name^="task_"], [data-qa^="task_"], [data-qa^="task-"]'
};
const RESPONSE_SCOPE_SELECTOR = '[data-qa="modal-content-scroll-container"], [data-qa="modal-content"], [role="dialog"], form[action*="vacancy_response"], form[id^="cover-letter-"], [data-qa*="modal" i], [class*="modal" i]';
const RELOCATION_SCOPE_SELECTOR = '[data-qa*="relocation" i], [role="dialog"], [data-qa*="modal" i], [class*="modal" i]';

class FakeStorage {
    constructor() { this.values = new Map(); }
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
    setItem(key, value) { this.values.set(key, String(value)); }
    removeItem(key) { this.values.delete(key); }
}

class FakeClock {
    constructor() {
        this.now = 1_000;
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

class FakeClassList {
    constructor() { this.values = new Set(); }
    add(...names) { names.forEach(name => this.values.add(name)); }
    remove(...names) { names.forEach(name => this.values.delete(name)); }
    toggle(name, force) {
        const enabled = force === undefined ? !this.values.has(name) : !!force;
        if (enabled) this.values.add(name); else this.values.delete(name);
        return enabled;
    }
    contains(name) { return this.values.has(name); }
}

class FakeElement {
    constructor(ownerDocument, tagName = 'div', { text = '', visible = true } = {}) {
        this.ownerDocument = ownerDocument;
        this.tagName = tagName.toUpperCase();
        this.parentElement = null;
        this.children = [];
        this.attributes = new Map();
        this.dataset = {};
        this.classList = new FakeClassList();
        this.className = '';
        this.style = {
            display: '',
            width: '',
            setProperty(name, value) { this[name] = value; }
        };
        this.visible = visible;
        this._textContent = text;
        this._innerHTML = '';
        this.innerHTMLWrites = 0;
        this.textContentWrites = 0;
        this.scrollTop = 0;
        this.clientHeight = 200;
        this.disabled = false;
        this.checked = false;
        this.listeners = new Map();
        this.isConnected = true;
    }

    get textContent() { return this._textContent; }
    set textContent(value) { this._textContent = String(value ?? ''); this.textContentWrites++; }
    get innerText() { return this._textContent; }
    set innerText(value) { this._textContent = String(value ?? ''); }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(value) {
        this._innerHTML = String(value ?? '');
        this.innerHTMLWrites++;
        if (value === '') this.children = [];
    }
    get childElementCount() { return this.children.length; }
    get scrollHeight() { return Math.max(this.clientHeight, this.children.length * 24); }
    get offsetParent() { return this.visible ? this.ownerDocument.body : null; }

    appendChild(child) {
        if (!child) return child;
        if (child.isFragment) {
            for (const nested of [...child.children]) this.appendChild(nested);
            return child;
        }
        child.parentElement = this;
        this.children.push(child);
        return child;
    }
    replaceChildren(...children) {
        this.children = [];
        children.forEach(child => this.appendChild(child));
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) || ''; }
    remove() {
        if (!this.parentElement) return;
        this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
    }
    addEventListener(type, listener, options = {}) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
        options?.signal?.addEventListener('abort', () => {
            const current = this.listeners.get(type) || [];
            this.listeners.set(type, current.filter(candidate => candidate !== listener));
        }, { once: true });
    }
    dispatch(type) {
        const event = { target: this, stopPropagation() {}, preventDefault() {} };
        this[`on${type}`]?.(event);
        (this.listeners.get(type) || []).forEach(listener => listener(event));
    }
    click() { this.dispatch('click'); }
    focus() {}
    matches() { return false; }
    closest() { return null; }
    querySelector(selector) { return this.ownerDocument.queryWithin(this, selector, false); }
    querySelectorAll(selector) { return this.ownerDocument.queryWithin(this, selector, true); }
    getBoundingClientRect() {
        this.ownerDocument.geometryChecks++;
        return this.visible
            ? { width: 100, height: 24, left: 0, top: 0 }
            : { width: 0, height: 0, left: 0, top: 0 };
    }
}

class FakeDocument {
    constructor() {
        this.selectorMap = new Map();
        this.queryCounts = new Map();
        this.geometryChecks = 0;
        this.title = '';
        this.referrer = '';
        this.hidden = false;
        this.documentElement = new FakeElement(this, 'html');
        this.documentElement.lang = 'ru';
        this.body = new FakeElement(this, 'body');
        this.elementsById = new Map();
        this.listeners = new Map();
    }
    setSelector(selector, elements) {
        this.selectorMap.set(selector, Array.isArray(elements) ? elements : [elements]);
    }
    count(selector) { return this.queryCounts.get(selector) || 0; }
    bump(selector) { this.queryCounts.set(selector, this.count(selector) + 1); }
    querySelector(selector) {
        this.bump(selector);
        return (this.selectorMap.get(selector) || [])[0] || null;
    }
    querySelectorAll(selector) {
        this.bump(selector);
        return [...(this.selectorMap.get(selector) || [])];
    }
    queryWithin(root, selector, all) {
        this.bump(selector);
        const matches = (this.selectorMap.get(selector) || []).filter(element => {
            let current = element;
            while (current) {
                if (current === root) return true;
                current = current.parentElement;
            }
            return false;
        });
        return all ? matches : (matches[0] || null);
    }
    createElement(tagName) { return new FakeElement(this, tagName); }
    createDocumentFragment() {
        const fragment = new FakeElement(this, 'fragment');
        fragment.isFragment = true;
        return fragment;
    }
    createTextNode(text) { return new FakeElement(this, 'span', { text }); }
    getElementById(id) { return this.elementsById.get(id) || null; }
    addEventListener(type, listener, options = {}) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
        options?.signal?.addEventListener('abort', () => {
            const current = this.listeners.get(type) || [];
            this.listeners.set(type, current.filter(candidate => candidate !== listener));
        }, { once: true });
    }
    dispatch(type) {
        (this.listeners.get(type) || []).forEach(listener => listener({ target: this }));
    }
}

function createHarness({ href = 'https://hh.ru/vacancy/42' } = {}) {
    const clock = new FakeClock();
    const document = new FakeDocument();
    const parsedUrl = new URL(href);
    class FakeDate extends Date {
        constructor(...args) { super(...(args.length ? args : [clock.now])); }
        static now() { return clock.now; }
    }
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
        navigator: { language: 'ru-RU', userAgent: 'phase2-test' },
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
        State,
        I18n,
        DiagLog,
        DiagnosticsView,
        buildDiagnosticReport,
        log,
        query,
        hasResponseTextConfirmation,
        isResponseConfirmed,
        pageLooksLikeTest,
        detectModalBlockReason,
        detectResponseOutcomeOnce: typeof detectResponseOutcomeOnce === 'function' ? detectResponseOutcomeOnce : null,
        detectPostSubmitPageOutcome,
        resolveResponseOutcome
    };
    return;
`;
    assert.ok(SCRIPT_SOURCE.includes(HOOK_MARKER));
    const source = SCRIPT_SOURCE.replace(HOOK_MARKER, hook + HOOK_MARKER);
    vm.createContext(context);
    vm.runInContext(source, context, { filename: SCRIPT_PATH });
    context.__hhApplyAssistantTestHooks.State.setRunning(true);
    return { hooks: context.__hhApplyAssistantTestHooks, document, clock, context };
}

function element(document, text = '', visible = true) {
    return new FakeElement(document, 'button', { text, visible });
}

function findByClass(root, className) {
    const found = [];
    const visit = (node) => {
        if (!node) return;
        if (String(node.className || '').split(/\s+/).includes(className)) found.push(node);
        node.children?.forEach(visit);
    };
    visit(root);
    return found;
}

test('known Scenario A/B/C selectors avoid broad interactive scans', () => {
    for (const [selector, expected] of [
        [SELECTORS.attach, 'SCENARIO_A'],
        [SELECTORS.submit, 'SCENARIO_B'],
        [SELECTORS.chat, 'SCENARIO_C']
    ]) {
        const { hooks, document } = createHarness();
        assert.equal(typeof hooks.detectResponseOutcomeOnce, 'function');
        document.setSelector(selector, element(document, expected));
        assert.equal(hooks.detectResponseOutcomeOnce(0), expected);
        const broadScans = [...document.queryCounts.entries()]
            .filter(([query]) => /button,\s*a|span,\s*div|div,\s*span/.test(query))
            .reduce((sum, [, count]) => sum + count, 0);
        assert.equal(broadScans, 0, `${expected} should stay on the exact-selector fast path`);
    }
});

test('response outcomes, confirmation, reject and questionnaire semantics stay intact', () => {
    const relocation = createHarness();
    relocation.document.setSelector(SELECTORS.relocation, element(relocation.document, 'Да'));
    assert.equal(relocation.hooks.detectResponseOutcomeOnce(0), 'RELOCATION');

    const questionnaire = createHarness({ href: 'https://hh.ru/applicant/vacancy_response?vacancyId=42' });
    questionnaire.document.setSelector(SELECTORS.questionnaire, element(questionnaire.document));
    assert.equal(questionnaire.hooks.pageLooksLikeTest(), true);
    assert.equal(questionnaire.hooks.detectResponseOutcomeOnce(0), 'QUESTIONS');

    const reject = createHarness();
    reject.document.setSelector(SELECTORS.reject, element(reject.document, 'Reject'));
    assert.equal(reject.hooks.detectModalBlockReason(), 'reject-warning');

    const stopped = createHarness();
    stopped.hooks.State.setRunning(false);
    assert.equal(stopped.hooks.detectResponseOutcomeOnce(0), 'STOPPED');

    const staleRun = createHarness();
    assert.equal(staleRun.hooks.detectResponseOutcomeOnce(99), 'STOPPED');

    const unresolved = createHarness();
    assert.equal(unresolved.hooks.detectResponseOutcomeOnce(0), false);

    const successBanner = createHarness();
    successBanner.document.setSelector(
        '[data-qa="vacancy-response-success"], .vacancy-response-success',
        element(successBanner.document, 'Success')
    );
    assert.equal(successBanner.hooks.detectResponseOutcomeOnce(0), 'SCENARIO_C');

    const textFallback = createHarness();
    const responseModal = element(textFallback.document, 'Response modal');
    const deliveredText = element(textFallback.document, 'Resume delivered');
    responseModal.appendChild(deliveredText);
    textFallback.document.setSelector(RESPONSE_SCOPE_SELECTOR, responseModal);
    textFallback.document.setSelector('h1,h2,h3,p,div,span', deliveredText);
    assert.equal(textFallback.hooks.detectResponseOutcomeOnce(0), 'SCENARIO_C');
});

test('response wait preserves timeout and stopped outcomes', async () => {
    const unresolved = createHarness();
    const timeoutResult = unresolved.hooks.resolveResponseOutcome(25, 0);
    unresolved.clock.advance(25);
    assert.equal(await timeoutResult, 'TIMEOUT');

    const stopped = createHarness();
    const stoppedResult = stopped.hooks.resolveResponseOutcome(25, 0);
    stopped.hooks.State.setRunning(false);
    stopped.clock.advance(25);
    assert.equal(await stoppedResult, 'STOPPED');
});

test('response compatibility fallback is scoped to the active modal', () => {
    const { hooks, document } = createHarness();
    const modal = element(document, 'Response modal');
    const send = element(document, 'Send');
    modal.appendChild(send);
    document.setSelector(RESPONSE_SCOPE_SELECTOR, modal);
    document.setSelector(RELOCATION_SCOPE_SELECTOR, modal);
    document.setSelector('button, a, [role="button"]', send);
    document.setSelector('button, input[type="submit"], [role="button"]', send);
    assert.equal(hooks.detectResponseOutcomeOnce(0), 'SCENARIO_B');
});

test('document-wide vacancy copy cannot become a terminal response outcome', () => {
    for (const text of [
        'Перейти к компании',
        'Сопроводительное письмо приветствуется',
        'Эта вакансия вам не подходит'
    ]) {
        const { hooks, document } = createHarness();
        const copy = element(document, text);
        document.setSelector('a, button', copy);
        document.setSelector('button, a, [role="button"]', copy);
        document.setSelector('span, div', copy);
        document.setSelector('div, span, p, h1, h2, h3', copy);
        document.setSelector('h1,h2,h3,p,div,span', copy);
        assert.equal(hooks.detectResponseOutcomeOnce(0), false, text);
        assert.equal(hooks.detectModalBlockReason(), '', text);
        assert.equal(hooks.isResponseConfirmed(), false, text);
        assert.equal(hooks.isResponseConfirmed({ allowDocumentStrongText: true }), false, text);
    }
});

test('strong document text is opt-in for post-submit confirmation and ignored by initial detection', () => {
    for (const text of ['Resume delivered', 'Application sent']) {
        const { hooks, document } = createHarness();
        const copy = element(document, text);
        document.setSelector('h1,h2,h3,p,div,span', copy);

        assert.equal(hooks.hasResponseTextConfirmation(document), true, text);
        assert.equal(hooks.isResponseConfirmed(), false, text);
        assert.equal(hooks.detectResponseOutcomeOnce(0), false, text);
        assert.equal(hooks.isResponseConfirmed({ allowDocumentStrongText: true }), true, text);
    }
});

test('strong document text requires a short leaf container', () => {
    const nested = createHarness();
    const parent = element(nested.document, 'Resume delivered');
    parent.appendChild(element(nested.document, 'nested'));
    nested.document.setSelector('h1,h2,h3,p,div,span', parent);
    assert.equal(nested.hooks.hasResponseTextConfirmation(nested.document), false);
    assert.equal(nested.hooks.isResponseConfirmed({ allowDocumentStrongText: true }), false);

    const oversized = createHarness();
    const longCopy = element(oversized.document, `Resume delivered ${'x'.repeat(241)}`);
    oversized.document.setSelector('h1,h2,h3,p,div,span', longCopy);
    assert.equal(oversized.hooks.hasResponseTextConfirmation(oversized.document), false);
    assert.equal(oversized.hooks.isResponseConfirmed({ allowDocumentStrongText: true }), false);
});

test('post-submit route classifier trusts search, requires vacancy confirmation and rejects unrelated routes', () => {
    const search = createHarness({ href: 'https://hh.ru/search/vacancy?text=qa' });
    assert.equal(search.hooks.detectPostSubmitPageOutcome(0), 'TRUSTED_NAVIGATION');

    const vacancy = createHarness({ href: 'https://hh.ru/vacancy/42' });
    assert.equal(vacancy.hooks.detectPostSubmitPageOutcome(0), false);
    vacancy.document.setSelector(
        '[data-qa="vacancy-response-success"], .vacancy-response-success',
        element(vacancy.document, 'Success')
    );
    assert.equal(vacancy.hooks.detectPostSubmitPageOutcome(0), 'CONFIRMED');

    for (const href of [
        'https://hh.ru/account/login',
        'https://hh.ru/account/login?backurl=/search/vacancy&return=/applicant/vacancy_response',
        'https://hh.ru/error',
        'https://hh.ru/employer/123'
    ]) {
        const unrelated = createHarness({ href });
        const misleading = element(unrelated.document, 'Application sent');
        unrelated.document.setSelector('h1,h2,h3,p,div,span', misleading);
        assert.equal(
            unrelated.hooks.detectPostSubmitPageOutcome(0, { allowDocumentStrongText: true }),
            'UNTRUSTED_NAVIGATION',
            href
        );
    }
});

test('post-submit route classifier fences stopped and stale runs before route success', () => {
    const stopped = createHarness({ href: 'https://hh.ru/search/vacancy' });
    stopped.hooks.State.setRunning(false);
    assert.equal(stopped.hooks.detectPostSubmitPageOutcome(0), 'STOPPED');

    const stale = createHarness({ href: 'https://hh.ru/search/vacancy' });
    assert.equal(stale.hooks.detectPostSubmitPageOutcome(99), 'STOPPED');
});

test('fast response detector skips compatibility scans until explicitly requested', () => {
    const { hooks, document } = createHarness();
    for (let index = 0; index < 20; index++) {
        assert.equal(hooks.detectResponseOutcomeOnce(0, false), false);
    }
    assert.equal(document.count(RESPONSE_SCOPE_SELECTOR), 0);
    assert.equal(document.count('button, a, [role="button"]'), 0);
    assert.equal(document.count('div, span, p, h1, h2, h3'), 0);
});

test('selector instrumentation does not repeat an already successful query', () => {
    const { hooks, document } = createHarness();
    document.setSelector(SELECTORS.submit, element(document, 'Send'));
    assert.ok(hooks.query('letterSubmit'));
    assert.equal(document.count(SELECTORS.submit), 1);
});

test('heuristics perform geometry checks only after semantic filtering', () => {
    const { hooks, document } = createHarness();
    const candidates = Array.from({ length: 100 }, (_, index) => element(document, `Unrelated ${index}`));
    candidates.push(element(document, 'Send'));
    document.setSelector('button, input[type="submit"], [role="button"]', candidates);
    assert.equal(hooks.query('letterSubmit'), candidates.at(-1));
    assert.equal(document.geometryChecks, 1);
});

test('diagnostic log updates coalesce full renders and preserve controls', () => {
    const { hooks, document, clock } = createHarness();
    const ids = [
        'ar-view-main', 'ar-view-diag', 'ar-diag-full-box', 'ar-diag-back-btn',
        'ar-diag-filter-all', 'ar-diag-filter-errors', 'ar-diag-filter-all-count',
        'ar-diag-filter-errors-count', 'ar-diag-search', 'ar-diag-search-clear',
        'ar-diag-auto-scroll', 'ar-diag-health-summary', 'ar-diag-check-status',
        'ar-health-badge', 'ar-health-btn', 'ar-diag-full-clear-all', 'ar-diag-full-dropdown'
    ];
    ids.forEach(id => document.elementsById.set(id, new FakeElement(document)));
    const el = id => document.getElementById(id);
    const viewMain = el('ar-view-main');
    const viewDiag = el('ar-view-diag');
    const fullBox = el('ar-diag-full-box');
    const badge = el('ar-health-badge');
    const errorsOnly = el('ar-diag-filter-errors');
    hooks.DiagnosticsView.mount({ el, uiSignal: new AbortController().signal });

    el('ar-health-btn').onclick();
    assert.equal(viewMain.style.display, 'none');
    assert.equal(viewDiag.style.display, 'flex');
    fullBox.innerHTMLWrites = 0;
    badge.textContentWrites = 0;

    hooks.log('repeat');
    hooks.log('repeat');
    hooks.log('repeat');
    assert.equal(fullBox.innerHTMLWrites, 0, 'log should schedule rather than synchronously rebuild');
    clock.advance(16);
    assert.equal(fullBox.innerHTMLWrites, 1, 'three log writes should coalesce into one full render');
    assert.equal(badge.textContentWrites, 3, 'badge should update once per log entry');
    const repeatBadges = findByClass(fullBox, 'ar-log-repeat');
    assert.equal(repeatBadges.length, 1);
    assert.match(repeatBadges[0].textContent, /×3/);
    repeatBadges[0].click();
    assert.equal(findByClass(fullBox, 'ar-log-group-children').length, 1);
    findByClass(fullBox, 'ar-log-repeat')[0].click();
    assert.equal(findByClass(fullBox, 'ar-log-group-children').length, 0);

    hooks.log('failure', true);
    errorsOnly.click();
    clock.advance(16);
    const messages = findByClass(fullBox, 'ar-log-message').map(node => node.textContent);
    assert.deepEqual(messages, ['failure']);
    assert.equal(el('ar-diag-filter-errors-count').textContent, '1');

    hooks.I18n.setLanguage('en');
    hooks.DiagnosticsView.refresh();
    assert.match(el('ar-diag-health-summary').title, /error|entr(?:y|ies)|record/i);

    el('ar-diag-filter-all').click();
    el('ar-diag-full-clear-all').onclick();
    clock.advance(16);
    assert.equal(hooks.DiagLog.getAll().length, 1, 'clear keeps only its own confirmation entry');

    el('ar-diag-back-btn').onclick();
    assert.equal(viewDiag.style.display, 'none');
    assert.equal(viewMain.style.display, 'flex');
});
