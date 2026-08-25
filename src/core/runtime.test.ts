import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { VERSION, RUNTIME_KEY, runtimeRecord, addRuntimeListener } from './runtime.js';
import { STORAGE_SCHEMA_VERSION, STORAGE_PREFIX } from '../storage/storage-service.js';

const ROOT = path.resolve(__dirname, '../../');
const SCRIPT_PATH = path.join(ROOT, 'hh-apply-assistant.user.js');
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, 'utf8').replace(/\r\n/g, '\n');
const EXPECTED_PRODUCT_VERSION = '4.0.0';
const EXPECTED_STORAGE_SCHEMA_VERSION = 1;
const EXPECTED_STORAGE_PREFIX = 'hh_apply_assistant_s1_';
const EXPECTED_RUNTIME_KEY = '__hhApplyAssistantRuntime';

function metadataValue(key: string): string {
    const values = [...SCRIPT_SOURCE.matchAll(new RegExp(`^//\\s+@${key}\\s+(.+)$`, 'gm'))]
        .map(match => match[1].trim());
    expect(values.length).toBe(1);
    return values[0];
}

class FakeStorage {
    values = new Map<string, string>();
    getItem(key: string) { return this.values.has(key) ? this.values.get(key)! : null; }
    setItem(key: string, value: string) { this.values.set(key, String(value)); }
    removeItem(key: string) { this.values.delete(key); }
}

function makeClassList() {
    return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
}

function createSingletonContext() {
    let intervalsCreated = 0;
    let intervalsCleared = 0;
    let listenersAdded = 0;
    let listenersRemoved = 0;
    const document = {
        title: '',
        referrer: '',
        hidden: false,
        documentElement: { lang: 'ru', classList: makeClassList(), style: { removeProperty() {} }, scrollHeight: 0, clientHeight: 0 },
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
        createTextNode: (text: string) => ({ textContent: text }),
        addEventListener() {},
        removeEventListener() {}
    };
    const context: any = {
        console: { log() {}, warn() {}, error() {} },
        document,
        location: { href: 'https://hh.ru/search/vacancy', pathname: '/search/vacancy', search: '', reload() {} },
        navigator: { language: 'ru-RU', userAgent: 'singleton-test' },
        localStorage: new FakeStorage(),
        sessionStorage: new FakeStorage(),
        Date,
        Math,
        URL,
        Blob,
        AbortController,
        Event,
        setTimeout,
        clearTimeout,
        setInterval() { intervalsCreated++; return intervalsCreated; },
        clearInterval() { intervalsCleared++; },
        requestAnimationFrame: (fn: any) => setTimeout(fn, 0),
        cancelAnimationFrame: clearTimeout,
        addEventListener() { listenersAdded++; },
        removeEventListener() { listenersRemoved++; },
        getComputedStyle: () => ({ getPropertyValue: () => '', transform: 'none' }),
        history: { back() {}, go() {} },
        confirm: () => true,
        alert() {},
        open() {},
        scrollTo() {},
        innerHeight: 800,
        innerWidth: 1280,
        pageYOffset: 0
    };
    context.window = context;
    context.globalThis = context;
    return {
        context,
        counts: () => ({ intervalsCreated, intervalsCleared, listenersAdded, listenersRemoved })
    };
}

test('product metadata, runtime VERSION and runtime record share one product version', () => {
    expect(VERSION).toBe(EXPECTED_PRODUCT_VERSION);
    expect(runtimeRecord.version).toBe(EXPECTED_PRODUCT_VERSION);
    expect(metadataValue('name')).toBe('HH Apply Assistant');
    expect(metadataValue('version')).toBe(EXPECTED_PRODUCT_VERSION);

    const runtimeVersions = [...SCRIPT_SOURCE.matchAll(/^\s*const VERSION = '([^']+)';$/gm)];
    expect(runtimeVersions.length).toBe(1);
    expect(runtimeVersions[0][1]).toBe(EXPECTED_PRODUCT_VERSION);

    const runtimeRecordSource = SCRIPT_SOURCE.match(/const runtimeRecord = \{[\s\S]*?^\s*\};/m)?.[0] || '';
    expect(runtimeRecordSource).toMatch(/\bversion:\s*VERSION\b/);
    expect(runtimeRecordSource).not.toMatch(/\bversion:\s*['"]/);
    expect(
        SCRIPT_SOURCE.indexOf(runtimeVersions[0][0])
    ).toBeLessThan(SCRIPT_SOURCE.indexOf('const runtimeRecord = {'));
});

test('runtime singleton identity is stable across product versions', () => {
    expect(RUNTIME_KEY).toBe(EXPECTED_RUNTIME_KEY);
    expect(RUNTIME_KEY).not.toMatch(/\d/);
    const declarations = [...SCRIPT_SOURCE.matchAll(/^\s*const RUNTIME_KEY = '([^']+)';$/gm)];
    expect(declarations.length).toBe(1);
    expect(declarations[0][1]).toBe(EXPECTED_RUNTIME_KEY);
    expect(declarations[0][1]).not.toMatch(/\d/);
    expect(SCRIPT_SOURCE).not.toMatch(/__hhApplyAssistantV\d+Runtime/);
});

test('storage schema and namespace are independent from product SemVer', () => {
    expect(STORAGE_SCHEMA_VERSION).toBe(EXPECTED_STORAGE_SCHEMA_VERSION);
    expect(STORAGE_PREFIX).toBe(EXPECTED_STORAGE_PREFIX);
    expect(Number.isSafeInteger(STORAGE_SCHEMA_VERSION)).toBe(true);
    expect(STORAGE_SCHEMA_VERSION).toBeGreaterThan(0);

    const declarations = [...SCRIPT_SOURCE.matchAll(/^\s*const STORAGE_SCHEMA_VERSION = (\d+);$/gm)];
    expect(declarations.length).toBe(1);
    const schemaVersion = Number(declarations[0][1]);
    expect(schemaVersion).toBe(EXPECTED_STORAGE_SCHEMA_VERSION);

    const prefixDeclaration = SCRIPT_SOURCE.match(
        /^\s*const STORAGE_PREFIX = `hh_apply_assistant_s\$\{STORAGE_SCHEMA_VERSION\}_`;$/m
    )?.[0] || '';
    expect(prefixDeclaration).toBeTruthy();
    expect(prefixDeclaration).not.toMatch(/\bVERSION\b/);
    expect(`hh_apply_assistant_s${schemaVersion}_`).toBe(EXPECTED_STORAGE_PREFIX);
    expect(SCRIPT_SOURCE).not.toMatch(/hh_apply_assistant_v\d+_/);
    expect(SCRIPT_SOURCE).not.toMatch(/hh_apply_assistant_s\d+_/);
    const productMajor = EXPECTED_PRODUCT_VERSION.split('.')[0];
    expect(SCRIPT_SOURCE.includes(`hh_apply_assistant_v${productMajor}_`)).toBe(false);
    expect(SCRIPT_SOURCE.includes('hh_apply_assistant_v4_')).toBe(false);
    expect(SCRIPT_SOURCE.includes('__hhApplyAssistantV4Runtime')).toBe(false);
});

test('double userscript execution keeps one watchdog and one global-listener set', () => {
    const marker = '    function bootstrap() {';
    expect(SCRIPT_SOURCE.includes(marker)).toBe(true);
    const instrumented = SCRIPT_SOURCE.replace(marker, `
    globalThis.__singletonReached = (globalThis.__singletonReached || 0) + 1;
    return;
${marker}`);
    const { context, counts } = createSingletonContext();
    vm.createContext(context);

    vm.runInContext(instrumented, context, { filename: SCRIPT_PATH });
    const firstRecord = context.__hhApplyAssistantRuntime;
    const afterFirst = counts();
    const productVersion = SCRIPT_SOURCE.match(/const VERSION = '([^']+)'/)?.[1];
    expect(firstRecord.active).toBe(true);
    expect(firstRecord.version).toBe(productVersion);
    expect(afterFirst.intervalsCreated).toBe(1);
    expect(firstRecord.watchdogIntervalId).toBe(1);
    expect(firstRecord.globalListeners.length).toBeGreaterThanOrEqual(3);

    vm.runInContext(instrumented, context, { filename: SCRIPT_PATH });
    expect(context.__hhApplyAssistantRuntime).toBe(firstRecord);
    expect(counts()).toEqual(afterFirst);
    expect(context.__singletonReached).toBe(1);

    const futureVersionInstrumented = instrumented.replace(
        /const VERSION = '(\d+)\.(\d+)\.(\d+)';/,
        (_, major, minor) => `const VERSION = '${major}.${Number(minor) + 1}.0';`
    );
    expect(futureVersionInstrumented).not.toBe(instrumented);
    vm.runInContext(futureVersionInstrumented, context, { filename: SCRIPT_PATH });
    expect(context.__hhApplyAssistantRuntime).toBe(firstRecord);
    expect(counts()).toEqual(afterFirst);
    expect(context.__singletonReached).toBe(1);

    firstRecord.teardown();
    expect(context.__hhApplyAssistantRuntime).toBeUndefined();
    expect(counts().intervalsCleared).toBe(1);
    expect(counts().listenersRemoved).toBe(afterFirst.listenersAdded);

    vm.runInContext(instrumented, context, { filename: SCRIPT_PATH });
    expect(counts().intervalsCreated).toBe(2);
    expect(context.__singletonReached).toBe(2);
});

test('confirmed backend dead constants stay removed', () => {
    expect(SCRIPT_SOURCE).not.toMatch(/\btopApply\s*:/);
    expect(SCRIPT_SOURCE).not.toMatch(/\b(?:MANUAL|RETRY|FATAL)\s*:\s*['"]/);
});
