import { test, expect, beforeEach } from 'vitest';
import {
    SELECTORS
} from './selectors.js';
import {
    runHeuristic,
    runHeuristicAll,
    getVacancyCard,
    getNativeWrapper,
    readSerpCardTitle,
    query,
    pageLooksLikeTest,
    detectModalBlockReason
} from './dom-adapter.js';
import {
    detectResponseOutcomeOnce
} from '../core/automation-engine.js';
import { State } from '../core/state-manager.js';

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
    style: any = { display: '', setProperty(name: string, val: string) { this[name] = val; } };
    visible = true;
    _textContent = '';
    listeners = new Map<string, any[]>();
    isFragment = false;

    constructor(ownerDocument: any, tagName = 'div', { text = '', visible = true } = {}) {
        this.ownerDocument = ownerDocument;
        this.tagName = tagName.toUpperCase();
        this._textContent = text;
        this.visible = visible;
    }

    get textContent() { return this._textContent; }
    set textContent(value: string) { this._textContent = String(value ?? ''); }
    get innerText() { return this._textContent; }
    set innerText(value: string) { this._textContent = String(value ?? ''); }
    get offsetParent() { return this.visible ? this.ownerDocument.body : null; }

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
    setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
    getAttribute(name: string) { return this.attributes.get(name) || ''; }
    addEventListener(type: string, listener: any) {
        const list = this.listeners.get(type) || [];
        list.push(listener);
        this.listeners.set(type, list);
    }
    dispatch(type: string) {
        const event = { target: this, stopPropagation() {}, preventDefault() {} };
        (this.listeners.get(type) || []).forEach(fn => fn(event));
    }
    click() { this.dispatch('click'); }
    matches() { return false; }
    closest() { return null; }
    querySelector(selector: string) { return this.ownerDocument.queryWithin(this, selector, false); }
    querySelectorAll(selector: string) { return this.ownerDocument.queryWithin(this, selector, true); }
    getBoundingClientRect() {
        this.ownerDocument.geometryChecks++;
        return this.visible
            ? { width: 100, height: 24, left: 0, top: 0 }
            : { width: 0, height: 0, left: 0, top: 0 };
    }
}

class FakeDocument {
    selectorMap = new Map<string, FakeElement[]>();
    queryCounts = new Map<string, number>();
    geometryChecks = 0;
    documentElement = new FakeElement(this, 'html');
    body = new FakeElement(this, 'body');

    setSelector(selector: string, elements: FakeElement | FakeElement[]) {
        this.selectorMap.set(selector, Array.isArray(elements) ? elements : [elements]);
    }
    count(selector: string) { return this.queryCounts.get(selector) || 0; }
    bump(selector: string) { this.queryCounts.set(selector, this.count(selector) + 1); }
    querySelector(selector: string) {
        this.bump(selector);
        return (this.selectorMap.get(selector) || [])[0] || null;
    }
    querySelectorAll(selector: string) {
        this.bump(selector);
        return [...(this.selectorMap.get(selector) || [])];
    }
    queryWithin(root: FakeElement, selector: string, all: boolean) {
        this.bump(selector);
        const matches = (this.selectorMap.get(selector) || []).filter(el => {
            let cur: FakeElement | null = el;
            while (cur) {
                if (cur === root) return true;
                cur = cur.parentElement;
            }
            return false;
        });
        return all ? matches : (matches[0] || null);
    }
    createElement(tagName: string) { return new FakeElement(this, tagName); }
    createTextNode(text: string) { return new FakeElement(this, 'span', { text }); }
    addEventListener() {}
    removeEventListener() {}
}

class FakeStorage implements Storage {
    values = new Map<string, string>();
    get length() { return this.values.size; }
    clear() { this.values.clear(); }
    key(index: number) { return [...this.values.keys()][index] || null; }
    getItem(key: string) { return this.values.has(key) ? this.values.get(key)! : null; }
    setItem(key: string, value: string) { this.values.set(key, String(value)); }
    removeItem(key: string) { this.values.delete(key); }
}

let doc: FakeDocument;

beforeEach(() => {
    doc = new FakeDocument();
    (globalThis as any).document = doc;
    (globalThis as any).window = globalThis;
    (globalThis as any).location = { href: 'https://hh.ru/vacancy/42', pathname: '/vacancy/42', search: '' };
    (globalThis as any).sessionStorage = new FakeStorage();
    (globalThis as any).localStorage = new FakeStorage();
    State.setRunning(true);
});

test('DOM null-safety: query and heuristic functions handle null / undefined root without throwing', () => {
    expect(() => {
        expect(runHeuristic('applyBtn', null)).toBeNull();
    }).not.toThrow();

    expect(() => {
        const resAll = runHeuristicAll('applyBtn', null);
        expect(Array.isArray(resAll)).toBe(true);
        expect(resAll.length).toBe(0);
    }).not.toThrow();

    expect(() => {
        expect(getVacancyCard(null)).toBeNull();
    }).not.toThrow();

    expect(() => {
        expect(getNativeWrapper(null)).toBeNull();
    }).not.toThrow();

    expect(() => {
        expect(readSerpCardTitle(null)).toBe('');
    }).not.toThrow();
});

test('known Scenario A/B/C selectors avoid broad interactive scans', () => {
    const attachBtn = new FakeElement(doc, 'button', { text: 'SCENARIO_A' });
    doc.setSelector(SELECTORS.attachCoverBtn, attachBtn);
    expect(detectResponseOutcomeOnce(0)).toBe('SCENARIO_A');

    const broadScans = [...doc.queryCounts.entries()]
        .filter(([q]) => /button,\s*a|span,\s*div|div,\s*span/.test(q))
        .reduce((sum, [, count]) => sum + count, 0);
    expect(broadScans).toBe(0);
});

test('response outcomes, confirmation, reject and questionnaire semantics stay intact', () => {
    const relocationBtn = new FakeElement(doc, 'button', { text: 'Да' });
    doc.setSelector(SELECTORS.relocationBtn, relocationBtn);
    expect(detectResponseOutcomeOnce(0)).toBe('RELOCATION');

    const questionnaireEl = new FakeElement(doc, 'textarea');
    doc.setSelector('textarea[name^="task_"], input[name^="task_"], select[name^="task_"], [data-qa^="task_"], [data-qa^="task-"]', questionnaireEl);
    expect(pageLooksLikeTest()).toBe(true);

    const rejectEl = new FakeElement(doc, 'div', { text: 'Reject' });
    doc.setSelector(SELECTORS.rejectWarning, rejectEl);
    expect(detectModalBlockReason()).toBe('reject-warning');
});

test('heuristics perform geometry checks only after semantic filtering', () => {
    const candidates = Array.from({ length: 100 }, (_, index) => new FakeElement(doc, 'button', { text: `Unrelated ${index}` }));
    const sendBtn = new FakeElement(doc, 'button', { text: 'Send' });
    candidates.push(sendBtn);
    doc.setSelector('button, input[type="submit"], [role="button"]', candidates);

    expect(query('letterSubmit')).toBe(sendBtn);
    expect(doc.geometryChecks).toBe(1);
});
