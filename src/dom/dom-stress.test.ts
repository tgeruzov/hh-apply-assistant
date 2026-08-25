import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { SELECTORS, TUNING } from './selectors.js';
import {
    q,
    qa,
    isVisible,
    isAutoResponderUI,
    query,
    queryAll,
    queryExact,
    queryHeuristic,
    runHeuristic,
    runHeuristicAll,
    getVacancyCard,
    getNativeWrapper,
    getVacancyID,
    getVacancyIDFromHref,
    parseVacancyTitle,
    readSerpCardTitle,
    waitForElement,
    waitForCondition,
    mutationBelongsToAssistantUI,
    hasReliableRejectWarning,
    isResponseConfirmed,
    detectAlreadyApplied,
    detectModalBlockReason,
    Page
} from './dom-adapter.js';
import { State, DiagLog, Metrics } from '../core/state-manager.js';
import { setStopSignal, setActiveAbortController } from '../core/concurrency.js';
import { sleep } from '../core/utils.js';

class MockStorage implements Storage {
    values = new Map<string, string>();
    get length() { return this.values.size; }
    clear() { this.values.clear(); }
    key(index: number) { return [...this.values.keys()][index] || null; }
    getItem(key: string) { return this.values.has(key) ? this.values.get(key)! : null; }
    setItem(key: string, value: string) { this.values.set(key, String(value)); }
    removeItem(key: string) { this.values.delete(key); }
}

class MockClassList {
    values = new Set<string>();
    constructor(initial = '') {
        initial.split(/\s+/).filter(Boolean).forEach(c => this.values.add(c));
    }
    add(...names: string[]) { names.forEach(name => this.values.add(name)); }
    remove(...names: string[]) { names.forEach(name => this.values.delete(name)); }
    toggle(name: string, force?: boolean) {
        const enabled = force === undefined ? !this.values.has(name) : !!force;
        if (enabled) this.values.add(name); else this.values.delete(name);
        return enabled;
    }
    contains(name: string) { return this.values.has(name); }
    toString() { return Array.from(this.values).join(' '); }
}

class MockElement {
    nodeType = 1;
    ownerDocument: MockDocument;
    tagName: string;
    parentElement: MockElement | null = null;
    children: MockElement[] = [];
    attributes = new Map<string, string>();
    classList: MockClassList;
    style: Record<string, any> = { display: '', setProperty(k: string, v: string) { this[k] = v; } };
    visible = true;
    _textContent = '';
    listeners = new Map<string, any[]>();
    dataset: Record<string, string> = {};

    constructor(ownerDocument: MockDocument, tagName = 'div', { text = '', visible = true, className = '', id = '' } = {}) {
        this.ownerDocument = ownerDocument;
        this.tagName = tagName.toUpperCase();
        this._textContent = text;
        this.visible = visible;
        this.classList = new MockClassList(className);
        if (className) this.className = className;
        if (id) this.id = id;
    }

    get id(): string { return this.attributes.get('id') || ''; }
    set id(val: string) { if (val) this.attributes.set('id', val); else this.attributes.delete('id'); }

    get href(): string { return this.attributes.get('href') || ''; }
    set href(val: string) { if (val) this.attributes.set('href', val); else this.attributes.delete('href'); }

    get className(): string { return this.classList.toString(); }
    set className(val: string) { this.classList = new MockClassList(val); }

    get textContent(): string {
        if (this.children.length === 0) return this._textContent;
        return this.children.map(c => c.textContent).join('');
    }
    set textContent(value: string) {
        this._textContent = String(value ?? '');
        this.children = [];
    }

    get innerText(): string { return this.textContent; }
    set innerText(value: string) { this.textContent = value; }

    get childElementCount(): number { return this.children.length; }

    get isAttached(): boolean {
        let cur: MockElement | null = this;
        while (cur) {
            if (cur === this.ownerDocument.documentElement) return true;
            cur = cur.parentElement;
        }
        return false;
    }

    get offsetParent(): MockElement | null {
        return (this.visible && this.isAttached) ? (this.ownerDocument.body || this) : null;
    }

    appendChild(child: MockElement): MockElement {
        if (!child) return child;
        child.parentElement = this;
        this.children.push(child);
        this.ownerDocument.notifyMutation({
            type: 'childList',
            target: this,
            addedNodes: [child],
            removedNodes: []
        });
        return child;
    }

    removeChild(child: MockElement): MockElement {
        const index = this.children.indexOf(child);
        if (index >= 0) {
            this.children.splice(index, 1);
            child.parentElement = null;
            this.ownerDocument.notifyMutation({
                type: 'childList',
                target: this,
                addedNodes: [],
                removedNodes: [child]
            });
        }
        return child;
    }

    setAttribute(name: string, value: string) {
        const oldValue = this.attributes.get(name);
        this.attributes.set(name, String(value));
        if (name === 'class') this.className = String(value);
        if (name.startsWith('data-')) {
            const dataProp = name.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase());
            this.dataset[dataProp] = String(value);
        }
        this.ownerDocument.notifyMutation({
            type: 'attributes',
            target: this,
            attributeName: name,
            oldValue
        });
    }

    getAttribute(name: string): string | null {
        return this.attributes.has(name) ? this.attributes.get(name)! : null;
    }

    hasAttribute(name: string): boolean {
        return this.attributes.has(name);
    }

    removeAttribute(name: string) {
        this.attributes.delete(name);
        this.ownerDocument.notifyMutation({
            type: 'attributes',
            target: this,
            attributeName: name
        });
    }

    addEventListener(type: string, listener: any) {
        const list = this.listeners.get(type) || [];
        list.push(listener);
        this.listeners.set(type, list);
    }

    removeEventListener(type: string, listener: any) {
        const list = (this.listeners.get(type) || []).filter(l => l !== listener);
        this.listeners.set(type, list);
    }

    dispatchEvent(event: any): boolean {
        const list = this.listeners.get(event?.type || '') || [];
        for (const listener of list) {
            if (typeof listener === 'function') listener(event);
            else if (listener && typeof listener.handleEvent === 'function') listener.handleEvent(event);
        }
        return true;
    }

    click() {
        this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} });
    }

    scrollIntoView() {}

    getBoundingClientRect() {
        return (this.visible && this.isAttached)
            ? { width: 120, height: 32, left: 10, top: 20, right: 130, bottom: 52 }
            : { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
    }

    closest(selector: string): MockElement | null {
        let current: MockElement | null = this;
        while (current) {
            if (current.matches(selector)) return current;
            current = current.parentElement;
        }
        return null;
    }

    matches(selector: string): boolean {
        const parts = selector.split(',').map(s => s.trim());
        return parts.some(part => this.matchesSingle(part));
    }

    private matchesSingle(selector: string): boolean {
        let sel = selector.trim();
        if (!sel || sel === '*') return true;

        let tag = '';
        let rest = sel;
        const tagMatch = sel.match(/^([a-zA-Z0-9_-]+)/);
        if (tagMatch) {
            tag = tagMatch[1].toUpperCase();
            rest = sel.slice(tagMatch[1].length);
        }

        if (tag && this.tagName !== tag) {
            return false;
        }

        while (rest) {
            if (rest.startsWith('.')) {
                const clsMatch = rest.match(/^\.([a-zA-Z0-9_-]+)/);
                if (!clsMatch) return false;
                if (!this.classList.contains(clsMatch[1])) return false;
                rest = rest.slice(clsMatch[0].length);
            } else if (rest.startsWith('#')) {
                const idMatch = rest.match(/^#([a-zA-Z0-9_-]+)/);
                if (!idMatch) return false;
                if (this.id !== idMatch[1]) return false;
                rest = rest.slice(idMatch[0].length);
            } else if (rest.startsWith('[')) {
                const attrEnd = rest.indexOf(']');
                if (attrEnd === -1) return false;
                const attrExpr = rest.slice(1, attrEnd);
                rest = rest.slice(attrEnd + 1);

                if (attrExpr.includes('=')) {
                    let op = '=';
                    if (attrExpr.includes('*=')) op = '*=';
                    else if (attrExpr.includes('^=')) op = '^=';
                    else if (attrExpr.includes('$=')) op = '$=';

                    const [attrName, valRaw] = attrExpr.split(op);
                    const expectedVal = valRaw.replace(/^["']|["']$/g, '');
                    const actualVal = this.getAttribute(attrName.trim());
                    if (actualVal === null) return false;

                    if (op === '*=' && !actualVal.includes(expectedVal)) return false;
                    if (op === '^=' && !actualVal.startsWith(expectedVal)) return false;
                    if (op === '$=' && !actualVal.endsWith(expectedVal)) return false;
                    if (op === '=' && actualVal !== expectedVal) return false;
                } else {
                    if (!this.hasAttribute(attrExpr)) return false;
                }
            } else {
                break;
            }
        }
        return true;
    }

    querySelector(selector: string): MockElement | null {
        return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector: string): MockElement[] {
        const results: MockElement[] = [];
        const traverse = (node: MockElement) => {
            for (const child of node.children) {
                if (child.matches(selector)) {
                    results.push(child);
                }
                traverse(child);
            }
        };
        traverse(this);
        return results;
    }
}

class MockDocument {
    documentElement: MockElement;
    body: MockElement;
    title = 'HeadHunter - Vacancies';
    private observers = new Set<TrackingMutationObserver>();

    constructor() {
        this.documentElement = new MockElement(this, 'html');
        this.body = new MockElement(this, 'body');
        this.documentElement.appendChild(this.body);
    }

    createElement(tagName: string): MockElement {
        return new MockElement(this, tagName);
    }

    createTextNode(text: string): MockElement {
        return new MockElement(this, 'span', { text });
    }

    querySelector(selector: string): MockElement | null {
        return this.documentElement.querySelector(selector);
    }

    querySelectorAll(selector: string): MockElement[] {
        return this.documentElement.querySelectorAll(selector);
    }

    registerObserver(obs: TrackingMutationObserver) {
        this.observers.add(obs);
    }

    unregisterObserver(obs: TrackingMutationObserver) {
        this.observers.delete(obs);
    }

    notifyMutation(record: any) {
        for (const obs of this.observers) {
            obs.trigger([record]);
        }
    }
}

class TrackingMutationObserver {
    static createdInstances: TrackingMutationObserver[] = [];
    static activeInstances = new Set<TrackingMutationObserver>();

    callback: (mutations: any[], observer: TrackingMutationObserver) => void;
    observedElement: MockElement | null = null;
    isDisconnected = false;

    constructor(callback: (mutations: any[], observer: TrackingMutationObserver) => void) {
        this.callback = callback;
        TrackingMutationObserver.createdInstances.push(this);
        TrackingMutationObserver.activeInstances.add(this);
    }

    observe(target: MockElement, _options?: any) {
        this.observedElement = target;
        this.isDisconnected = false;
        target.ownerDocument?.registerObserver(this);
    }

    disconnect() {
        this.isDisconnected = true;
        TrackingMutationObserver.activeInstances.delete(this);
        if (this.observedElement?.ownerDocument) {
            this.observedElement.ownerDocument.unregisterObserver(this);
        }
        this.observedElement = null;
    }

    takeRecords() {
        return [];
    }

    trigger(mutations: any[]) {
        if (!this.isDisconnected) {
            this.callback(mutations, this);
        }
    }

    static reset() {
        TrackingMutationObserver.createdInstances = [];
        TrackingMutationObserver.activeInstances.clear();
    }
}

let doc: MockDocument;
let mockLocal: MockStorage;
let mockSession: MockStorage;

beforeEach(() => {
    TrackingMutationObserver.reset();
    doc = new MockDocument();
    mockLocal = new MockStorage();
    mockSession = new MockStorage();

    (globalThis as any).document = doc;
    (globalThis as any).window = globalThis;
    (globalThis as any).localStorage = mockLocal;
    (globalThis as any).sessionStorage = mockSession;
    (globalThis as any).MutationObserver = TrackingMutationObserver;
    (globalThis as any).location = {
        href: 'https://hh.ru/search/vacancy?text=developer',
        pathname: '/search/vacancy',
        search: '?text=developer'
    };

    setStopSignal(false);
    setActiveAbortController(null);
    State.setRunning(true);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('DOM Stress, Host Drift Resilience & Memory Leak Suite', () => {

    describe('1. Dynamic Modal Delays & MutationObserver Polling', () => {

        test('waitForElement detects modal inserted after dynamic delay of 50ms', async () => {
            const elementPromise = waitForElement('applyBtn', 2000);

            setTimeout(() => {
                const btn = doc.createElement('button');
                btn.setAttribute('data-qa', 'vacancy-serp__vacancy_response');
                btn.textContent = 'Откликнуться';
                doc.body.appendChild(btn);
            }, 50);

            const found = await elementPromise;
            expect(found).not.toBeNull();
            expect(found?.textContent).toBe('Откликнуться');
        });

        test('waitForElement detects submit button inserted after dynamic delay of 150ms', async () => {
            const elementPromise = waitForElement('letterSubmit', 2000);

            setTimeout(() => {
                const submitBtn = doc.createElement('button');
                submitBtn.setAttribute('data-qa', 'vacancy-response-letter-submit');
                submitBtn.textContent = 'Отправить';
                doc.body.appendChild(submitBtn);
            }, 150);

            const found = await elementPromise;
            expect(found).not.toBeNull();
            expect(found?.textContent).toBe('Отправить');
        });

        test('waitForElement detects relocation confirmation inserted after 300ms delay', async () => {
            const elementPromise = waitForElement('relocationBtn', 2000);

            setTimeout(() => {
                const modal = doc.createElement('div');
                modal.setAttribute('data-qa', 'relocation-warning-modal');
                const confirmBtn = doc.createElement('button');
                confirmBtn.setAttribute('data-qa', 'relocation-warning-confirm');
                confirmBtn.textContent = 'Да, я готов к переезду';
                modal.appendChild(confirmBtn);
                doc.body.appendChild(modal);
            }, 300);

            const found = await elementPromise;
            expect(found).not.toBeNull();
            expect(found?.getAttribute('data-qa')).toBe('relocation-warning-confirm');
        });

        test('waitForElement returns null on timeout when element never appears', async () => {
            const startTime = Date.now();
            const result = await waitForElement('nonExistentSelector', 100);
            const elapsed = Date.now() - startTime;

            expect(result).toBeNull();
            expect(elapsed).toBeGreaterThanOrEqual(80);
        });

        test('waitForElement immediately cancels and disconnects observer on AbortSignal', async () => {
            const controller = new AbortController();

            const promise = waitForElement('applyBtn', 5000, controller.signal);

            setTimeout(() => controller.abort(), 20);

            const startTime = Date.now();
            const result = await promise;
            const elapsed = Date.now() - startTime;

            expect(result).toBeNull();
            expect(elapsed).toBeLessThan(150);
            expect(TrackingMutationObserver.activeInstances.size).toBe(0);
        });

        test('waitForCondition detects attribute/state changes and ignores Assistant UI internal mutations', async () => {
            let ready = false;

            const condPromise = waitForCondition(() => ready, 2000);

            // Mutate assistant UI element -> should be ignored by mutationBelongsToAssistantUI
            const assistantPanel = doc.createElement('div');
            assistantPanel.id = 'ar-panel';
            doc.body.appendChild(assistantPanel);

            // Mutate target state after 50ms
            setTimeout(() => {
                ready = true;
                const hostEl = doc.createElement('div');
                hostEl.className = 'host-content-ready';
                doc.body.appendChild(hostEl);
            }, 50);

            const outcome = await condPromise;
            expect(outcome).toBe(true);
        });
    });

    describe('2. HeadHunter Host Drift & Broken Layout Resilience', () => {

        test('Total absence of data-qa: Heuristics accurately resolve buttons by localized semantic text', () => {
            // Apply button in search card
            const card = doc.createElement('div');
            card.className = 'custom-vacancy-card';
            const applyBtn = doc.createElement('button');
            applyBtn.className = 'custom-apply-class-v2';
            applyBtn.textContent = 'Откликнуться на вакансию';
            card.appendChild(applyBtn);
            doc.body.appendChild(card);

            // Modal dialog for cover letter and submit
            const modalDialog = doc.createElement('div');
            modalDialog.setAttribute('role', 'dialog');

            const coverBtn = doc.createElement('button');
            coverBtn.textContent = 'Добавить сопроводительное письмо';
            modalDialog.appendChild(coverBtn);

            const submitForm = doc.createElement('form');
            const submitBtn = doc.createElement('button');
            submitBtn.setAttribute('type', 'submit');
            submitBtn.textContent = 'Отправить резюме';
            submitForm.appendChild(submitBtn);
            modalDialog.appendChild(submitForm);

            const relocationModal = doc.createElement('div');
            relocationModal.setAttribute('role', 'dialog');
            relocationModal.setAttribute('data-qa', 'relocation-scope');
            const relocationBtn = doc.createElement('button');
            relocationBtn.textContent = 'Да';
            relocationModal.appendChild(relocationBtn);

            doc.body.appendChild(modalDialog);
            doc.body.appendChild(relocationModal);

            expect(query('applyBtn', card as unknown as ParentNode)).toBe(applyBtn);
            expect(query('attachCoverInModal', modalDialog as unknown as ParentNode)).toBe(coverBtn);
            expect(query('letterSubmit', submitForm as unknown as ParentNode)).toBe(submitBtn);
            expect(query('relocationBtn', relocationModal as unknown as ParentNode)).toBe(relocationBtn);
        });

        test('CSS Modules with dynamic hash classes: heuristics and vacancy card traversal resolve cleanly', () => {
            const card = doc.createElement('div');
            card.className = 'VacancyCard_root__x9F2a vacancy-serp-item';

            const titleLink = doc.createElement('a');
            titleLink.className = 'VacancyTitle_link__3bNqa';
            titleLink.setAttribute('href', '/vacancy/98765432?query=react');

            const titleSpan = doc.createElement('span');
            titleSpan.className = 'serp-item__title';
            titleSpan.textContent = 'Senior React Developer · BigTech · Moscow';
            titleLink.appendChild(titleSpan);

            card.appendChild(titleLink);
            doc.body.appendChild(card);

            expect(getVacancyCard(titleSpan as unknown as Node)).toBe(card);
            expect(getVacancyID(titleSpan as unknown as Element)).toBe('v_98765432');
            expect(readSerpCardTitle(titleLink as unknown as Element)).toContain('Senior React Developer');
        });

        test('Deeply nested SVG / span nodes inside buttons traverse up safely without throwing null errors', () => {
            const button = doc.createElement('button');
            button.className = 'apply-btn-with-icon';

            const iconSpan = doc.createElement('span');
            iconSpan.className = 'icon-container';

            const svg = doc.createElement('svg');
            const path = doc.createElement('path');
            svg.appendChild(path);
            iconSpan.appendChild(svg);

            const textSpan = doc.createElement('span');
            textSpan.textContent = 'Откликнуться без резюме';

            button.appendChild(iconSpan);
            button.appendChild(textSpan);
            doc.body.appendChild(button);

            // Test traversal starting from deeply nested SVG path node
            expect(() => {
                expect(getVacancyCard(path as unknown as Node)).toBeNull();
                expect(getNativeWrapper(path as unknown as Element)).toBe(svg);
                expect(isAutoResponderUI(path as unknown as Element)).toBe(false);
                expect(getVacancyID(path as unknown as Element)).toBeDefined();
            }).not.toThrow();
        });

        test('Completely broken DOM structures fail safely returning defaults without throwing TypeError', () => {
            const brokenElements = [
                null,
                undefined,
                doc.createElement('div'), // empty detached div
                doc.createElement('a')    // anchor without href
            ];

            for (const el of brokenElements) {
                expect(() => {
                    expect(getVacancyCard(el as any)).toBeNull();
                    expect(getNativeWrapper(el as any)).toBeNull();
                    expect(readSerpCardTitle(el as any)).toBe('');
                    expect(isAutoResponderUI(el as any)).toBe(false);
                    expect(isVisible(el as any)).toBe(false);
                }).not.toThrow();
            }

            expect(() => {
                expect(parseVacancyTitle()).toBe('HeadHunter - Vacancies');
                expect(hasReliableRejectWarning()).toBe(false);
                expect(isResponseConfirmed()).toBe(false);
                expect(detectAlreadyApplied()).toBe(false);
                expect(detectModalBlockReason()).toBe('');
                expect(getVacancyIDFromHref('javascript:void(0)')).toBeNull();
                expect(getVacancyIDFromHref('tel:+79990000000')).toBeNull();
                expect(getVacancyIDFromHref(null)).toBeNull();
            }).not.toThrow();
        });
    });

    describe('3. Memory Leaks & MutationObserver Lifecycle (500 Sequential Scans)', () => {

        test('500 sequential element lookups cleanly disconnect 100% of MutationObserver instances without leaks', async () => {
            const iterations = 500;

            for (let i = 0; i < iterations; i++) {
                if (i % 3 === 0) {
                    // Match immediately
                    const btn = doc.createElement('button');
                    btn.setAttribute('data-qa', 'vacancy-serp__vacancy_response');
                    doc.body.appendChild(btn);

                    const found = await waitForElement('applyBtn', 200);
                    expect(found).toBe(btn);

                    doc.body.removeChild(btn);
                } else if (i % 3 === 1) {
                    // Match after async micro-delay
                    const lookup = waitForElement('letterSubmit', 200);
                    setTimeout(() => {
                        const submit = doc.createElement('button');
                        submit.setAttribute('data-qa', 'vacancy-response-letter-submit');
                        doc.body.appendChild(submit);
                        setTimeout(() => {
                            if (submit.parentElement) doc.body.removeChild(submit);
                        }, 5);
                    }, 1);

                    const found = await lookup;
                    expect(found).not.toBeNull();
                } else {
                    // Cancel with AbortController
                    const ac = new AbortController();
                    const lookup = waitForElement('attachCoverBtn', 200, ac.signal);
                    setTimeout(() => ac.abort(), 1);
                    const found = await lookup;
                    expect(found).toBeNull();
                }
            }

            // Verify memory leak prevention: all created observers must have been disconnected
            expect(TrackingMutationObserver.createdInstances.length).toBeGreaterThan(0);
            expect(TrackingMutationObserver.activeInstances.size).toBe(0);

            const leakedObservers = TrackingMutationObserver.createdInstances.filter(obs => !obs.isDisconnected);
            expect(leakedObservers).toHaveLength(0);
        });
    });
});
