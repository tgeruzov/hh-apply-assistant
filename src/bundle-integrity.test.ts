import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(__dirname, '..');
const DIST_BUNDLE = path.join(ROOT, 'dist', 'hh-apply-assistant.user.js');
const ROOT_BUNDLE = path.join(ROOT, 'hh-apply-assistant.user.js');
const PKG_JSON_PATH = path.join(ROOT, 'package.json');

const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, 'utf8'));

describe('Userscript Bundle Integrity & Sandbox Isolation Suite', () => {

    test('Bundle Autonomous Structure: self-contained standalone IIFE without imports or require calls', () => {
        expect(existsSync(DIST_BUNDLE)).toBe(true);
        expect(existsSync(ROOT_BUNDLE)).toBe(true);

        const source = readFileSync(DIST_BUNDLE, 'utf8');

        // File size must be substantial (> 100 KB) representing fully assembled application
        expect(source.length).toBeGreaterThan(100 * 1024);

        // Header and IIFE envelope validation
        expect(source).toMatch(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*\n\s*\(function\s*\(\)\s*\{/m);
        expect(source.trim()).toMatch(/\}\)\(\);$/);

        // Must not contain ES module top-level import/export keywords in executable body
        const executableBody = source.slice(source.indexOf('(function () {'));

        const topLevelImports = executableBody.match(/^[ \t]*import\s+[^'"]+['"][^'"]+['"]/gm);
        expect(topLevelImports).toBeNull();

        const topLevelExports = executableBody.match(/^[ \t]*export\s+(?:default|const|let|var|function|class)/gm);
        expect(topLevelExports).toBeNull();

        // Must not contain CommonJS require calls
        const cjsRequires = executableBody.match(/\brequire\s*\(['"][^'"]+['"]\)/g);
        expect(cjsRequires).toBeNull();
    });

    test('Userscript Metadata Block Compliance: matches package.json and official HeadHunter domain contracts', () => {
        const source = readFileSync(DIST_BUNDLE, 'utf8');
        const headerMatch = source.match(/^\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/m);
        expect(headerMatch).not.toBeNull();

        const header = headerMatch![1];

        const getMeta = (tag: string) => {
            const rx = new RegExp(`^//\\s+@${tag}\\s+(.+)$`, 'gm');
            return [...header.matchAll(rx)].map(m => m[1].trim());
        };

        expect(getMeta('name')[0]).toBe('HH Apply Assistant');
        expect(getMeta('version')[0]).toBe(pkg.version);
        expect(getMeta('author')[0]).toBe(pkg.author);
        expect(getMeta('license')[0]).toBe(pkg.license);
        expect(getMeta('namespace')[0]).toBe('http://tampermonkey.net/');
        expect(getMeta('grant')[0]).toBe('none');
        expect(getMeta('run-at')[0]).toBe('document-idle');

        const matches = getMeta('match');
        expect(matches).toEqual([
            '*://*.hh.ru/search/vacancy*',
            '*://*.hh.ru/vacancy/*',
            '*://*.hh.ru/applicant/vacancy_response*'
        ]);

        // Must not depend on external unsanctioned scripts
        expect(getMeta('require')).toHaveLength(0);
        expect(getMeta('resource')).toHaveLength(0);
    });

    test('Global Sandbox Hygiene: bundle executes in isolated VM without polluting window except authorized runtime record', () => {
        const source = readFileSync(DIST_BUNDLE, 'utf8');

        class FakeStorage {
            values = new Map<string, string>();
            getItem(k: string) { return this.values.get(k) || null; }
            setItem(k: string, v: string) { this.values.set(k, String(v)); }
            removeItem(k: string) { this.values.delete(k); }
            clear() { this.values.clear(); }
        }

        class MockEvent {
            type: string;
            bubbles: boolean;
            cancelable: boolean;
            constructor(type: string, opts: any = {}) {
                this.type = type;
                this.bubbles = !!opts?.bubbles;
                this.cancelable = !!opts?.cancelable;
            }
        }

        class MockCustomEvent extends MockEvent {
            detail: any;
            constructor(type: string, opts: any = {}) {
                super(type, opts);
                this.detail = opts?.detail;
            }
        }

        class MockMouseEvent extends MockEvent {}
        class MockPointerEvent extends MockMouseEvent {}

        class MockNode {
            static ELEMENT_NODE = 1;
            nodeType = 1;
        }
        class MockElement extends MockNode {}
        class MockHTMLElement extends MockElement {}
        class MockHTMLTextAreaElement extends MockHTMLElement {
            value = '';
        }
        class MockHTMLButtonElement extends MockHTMLElement {}
        class MockHTMLAnchorElement extends MockHTMLElement {}

        class MockMutationObserver {
            observe() {}
            disconnect() {}
            takeRecords() { return []; }
        }

        const elementMap = new Map<string, any>();
        function createOrGetElement(id: string, tagName = 'div') {
            if (elementMap.has(id)) return elementMap.get(id);
            const el: any = {
                nodeType: 1,
                id,
                tagName: tagName.toUpperCase(),
                value: '',
                textContent: '',
                innerHTML: '',
                children: [],
                parentElement: null,
                appendChild(c: any) { this.children.push(c); return c; },
                removeChild() {},
                insertAdjacentHTML() {},
                querySelector() { return null; },
                querySelectorAll() { return []; },
                addEventListener() {},
                removeEventListener() {},
                getAttribute(attr: string) { return this[attr] || null; },
                setAttribute(attr: string, val: any) { this[attr] = val; },
                removeAttribute(attr: string) { delete this[attr]; },
                classList: {
                    add() {},
                    remove() {},
                    toggle() { return false; },
                    contains() { return false; }
                },
                style: {
                    display: '',
                    setProperty(k: string, v: string) { (this as Record<string, any>)[k] = v; }
                },
                dataset: {},
                scrollIntoView() {},
                focus() {},
                blur() {}
            };
            elementMap.set(id, el);
            return el;
        }

        const listeners: any[] = [];
        const sandboxWindow: Record<string, any> = {
            Event: MockEvent,
            CustomEvent: MockCustomEvent,
            MouseEvent: MockMouseEvent,
            PointerEvent: MockPointerEvent,
            Node: MockNode,
            Element: MockElement,
            HTMLElement: MockHTMLElement,
            HTMLTextAreaElement: MockHTMLTextAreaElement,
            HTMLButtonElement: MockHTMLButtonElement,
            HTMLAnchorElement: MockHTMLAnchorElement,
            MutationObserver: MockMutationObserver,
            AbortController,
            AbortSignal,
            addEventListener(type: string, fn: any) { listeners.push({ type, fn }); },
            removeEventListener() {},
            localStorage: new FakeStorage(),
            sessionStorage: new FakeStorage(),
            location: {
                href: 'https://hh.ru/search/vacancy?text=dev',
                pathname: '/search/vacancy',
                search: '?text=dev'
            },
            navigator: {
                language: 'ru-RU'
            },
            console: {
                log() {},
                warn() {},
                error() {}
            },
            setTimeout(fn: any) { return setTimeout(fn, 0); },
            clearTimeout(id: any) { clearTimeout(id); },
            setInterval(fn: any) { return setInterval(fn, 10000); },
            clearInterval(id: any) { clearInterval(id); }
        };
        sandboxWindow.window = sandboxWindow;
        sandboxWindow.globalThis = sandboxWindow;

        const bodyElement = createOrGetElement('body', 'body');
        const rootElement = createOrGetElement('html', 'html');
        rootElement.appendChild(bodyElement);

        const sandboxDoc: any = {
            nodeType: 9,
            documentElement: rootElement,
            body: bodyElement,
            title: 'HH Search',
            createElement(tagName: string) { return createOrGetElement(Math.random().toString(36).slice(2), tagName); },
            createTextNode(text: string) { return { textContent: text, nodeType: 3 }; },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            getElementById(id: string) { return createOrGetElement(id); },
            addEventListener() {},
            removeEventListener() {}
        };

        sandboxWindow.document = sandboxDoc;

        const context = vm.createContext(sandboxWindow);

        // Run compiled userscript in the VM context
        expect(() => {
            vm.runInContext(source, context);
        }).not.toThrow();

        // Verify that the authorized runtime record was registered
        const runtime = sandboxWindow.__hhApplyAssistantRuntime;
        expect(runtime).toBeDefined();
        expect(runtime.active).toBe(true);
        expect(runtime.version).toBe(pkg.version);
        expect(Array.isArray(runtime.globalListeners)).toBe(true);

        // Verify global namespace hygiene: no internal variables leaked to window
        const disallowedLeakedGlobals = [
            'isLoopActive',
            'stopSignal',
            'currentRunId',
            'TAB_ID',
            'SELECTORS',
            'TUNING',
            'DEFAULTS',
            'I18n',
            'State',
            'Settings',
            'DiagLog',
            'Metrics',
            'Stats',
            'acquireInstanceLock',
            'guardOwnedCommit',
            'realisticClick',
            'startLoop'
        ];

        for (const globalKey of disallowedLeakedGlobals) {
            expect(sandboxWindow[globalKey], `Global leak detected: ${globalKey}`).toBeUndefined();
        }
    });
});
