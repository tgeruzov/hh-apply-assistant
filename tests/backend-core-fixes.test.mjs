import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(TEST_DIR, '..', 'script.js');
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, 'utf8');

const submitStart = SCRIPT_SOURCE.indexOf('    async function submitResponsePage');
const submitEnd = SCRIPT_SOURCE.indexOf('\n\n    // Открываем вакансию со списка', submitStart);
assert.ok(submitStart >= 0 && submitEnd > submitStart, 'submitResponsePage source must be extractable');
const SUBMIT_RESPONSE_PAGE_SOURCE = SCRIPT_SOURCE.slice(submitStart, submitEnd);

const postSubmitOutcomeStart = SCRIPT_SOURCE.indexOf('    function detectPostSubmitPageOutcome');
assert.ok(
    postSubmitOutcomeStart >= 0 && submitStart > postSubmitOutcomeStart,
    'detectPostSubmitPageOutcome source must be extractable'
);
const POST_SUBMIT_OUTCOME_SOURCE = SCRIPT_SOURCE.slice(postSubmitOutcomeStart, submitStart);

function createSubmitHarness({
    confirmationDelayMs,
    destination = 'response',
    confirmationKind = 'scoped',
    preexistingStrongText = '',
    postSubmitText,
    invalidateRun = '',
    reject = false,
    rejectForceResult = 'FAIL'
}) {
    const observed = {
        normalClicks: 0,
        forceCalls: 0,
        waitTimeout: 0,
        sent: 0,
        processed: 0,
        successProcessed: 0,
        manual: 0
    };
    let activeRunId = 1;
    let running = true;
    let route = 'response';
    let confirmationVisible = false;
    let strongText = preexistingStrongText;
    const isStrongText = text => /(?:resume delivered|application sent|response sent|резюме доставлено)/i.test(text || '');
    const window = { location: { href: 'https://hh.ru/applicant/vacancy_response?vacancyId=42' } };
    const document = {};
    const dependencies = {
        isRunCurrent: runId => running && runId === activeRunId,
        State: {
            touchInstanceLock: () => 'OWNED',
            clearTrapLock: () => true,
            clearLastAttemptID: () => true,
            setF5Needed: () => true
        },
        TAB_ID: 'tab-test',
        haltForLostInstanceLock: () => assert.fail('lease must remain owned'),
        hasReliableRejectWarning: () => reject,
        Metrics: { bump() {} },
        config: { applyOnRejectWarning: true, useCover: false },
        log() {},
        I18n: { t: key => key },
        captureResponseDom() {},
        fillLetterAndSubmit: async () => {
            observed.normalClicks++;
            return true;
        },
        waitForCondition: async (check, timeout) => {
            observed.waitTimeout = timeout;
            if (confirmationDelayMs > timeout) return false;
            route = destination;
            confirmationVisible = confirmationKind === 'scoped';
            if (postSubmitText !== undefined) strongText = postSubmitText;
            if (invalidateRun === 'stop') running = false;
            if (invalidateRun === 'stale') activeRunId = 2;
            return check();
        },
        detectCaptcha: () => false,
        Page: {
            isResponseForm: () => route === 'response',
            isSearchList: () => route === 'search',
            isVacancy: () => route === 'vacancy'
        },
        pageLooksLikeTest: () => false,
        hasResponseTextConfirmation: () => isStrongText(strongText),
        isResponseConfirmed: ({ allowDocumentStrongText = false } = {}) => (
            confirmationVisible || (allowDocumentStrongText && isStrongText(strongText))
        ),
        TUNING: { confirmWaitMs: 6_000, responsePagePendingMs: 16_000, forceSubmitAttempts: 3 },
        forceSubmitReject: async () => {
            observed.forceCalls++;
            return rejectForceResult;
        },
        persistSentCount: () => { observed.sent++; return true; },
        saveCurrentForManual: () => { observed.manual++; return true; },
        persistProcessedVacancy: () => {
            observed.processed++;
            if (observed.sent > 0) observed.successProcessed++;
            return true;
        },
        haltForPersistenceFailure: () => assert.fail('manual fallback persistence must succeed'),
        haltForCaptcha: () => assert.fail('captcha is outside this harness'),
        document,
        window
    };
    const names = Object.keys(dependencies);
    const factory = Function(...names, `
        let handlingResponsePage = false;
        let currentRunId = 1;
        ${POST_SUBMIT_OUTCOME_SOURCE}
        ${SUBMIT_RESPONSE_PAGE_SOURCE}
        return { submitResponsePage, getHandling: () => handlingResponsePage };
    `);
    return { ...factory(...names.map(name => dependencies[name])), observed, window };
}

for (const delay of [7_000, 10_000, 15_000]) {
    test(`ordinary full-page submit remains single-click with ${delay / 1000}s confirmation`, async () => {
        const harness = createSubmitHarness({ confirmationDelayMs: delay });
        await harness.submitResponsePage('v_42', 'https://hh.ru/search/vacancy', 1, 'trap');

        assert.equal(harness.observed.normalClicks, 1);
        assert.equal(harness.observed.forceCalls, 0);
        assert.equal(harness.observed.waitTimeout, 16_000);
        assert.equal(harness.observed.sent, 1);
        assert.equal(harness.observed.processed, 1);
        assert.equal(harness.observed.manual, 0);
        assert.equal(harness.getHandling(), false);
    });
}

test('unconfirmed ordinary full-page submit falls back to Manual Queue without a second click', async () => {
    const harness = createSubmitHarness({ confirmationDelayMs: 17_000, confirmationKind: 'none' });
    await harness.submitResponsePage('v_42', 'https://hh.ru/search/vacancy', 1, 'trap');

    assert.equal(harness.observed.normalClicks, 1);
    assert.equal(harness.observed.forceCalls, 0);
    assert.equal(harness.observed.sent, 0);
    assert.equal(harness.observed.manual, 1);
    assert.equal(harness.observed.processed, 1);
});

test('force submit remains reachable only for a reliably detected reject warning', async () => {
    const harness = createSubmitHarness({
        confirmationDelayMs: 7_000,
        reject: true,
        rejectForceResult: 'OK'
    });
    await harness.submitResponsePage('v_42', 'https://hh.ru/search/vacancy', 1, 'trap');

    assert.equal(harness.observed.normalClicks, 1);
    assert.equal(harness.observed.waitTimeout, 6_000);
    assert.equal(harness.observed.forceCalls, 1);
    assert.equal(harness.observed.sent, 1);
});

test('post-submit navigation to the trusted search route is a single successful send', async () => {
    const harness = createSubmitHarness({
        confirmationDelayMs: 100,
        destination: 'search',
        confirmationKind: 'none'
    });
    await harness.submitResponsePage('v_42', 'https://hh.ru/search/vacancy', 1, 'trap');

    assert.equal(harness.observed.normalClicks, 1);
    assert.equal(harness.observed.sent, 1);
    assert.equal(harness.observed.successProcessed, 1);
    assert.equal(harness.observed.manual, 0);
});

test('post-submit vacancy navigation requires response-specific confirmation', async () => {
    const confirmed = createSubmitHarness({
        confirmationDelayMs: 100,
        destination: 'vacancy',
        confirmationKind: 'scoped'
    });
    await confirmed.submitResponsePage('v_42', 'https://hh.ru/search/vacancy', 1, 'trap');
    assert.equal(confirmed.observed.sent, 1);
    assert.equal(confirmed.observed.successProcessed, 1);

    const unconfirmed = createSubmitHarness({
        confirmationDelayMs: 100,
        destination: 'vacancy',
        confirmationKind: 'none'
    });
    await unconfirmed.submitResponsePage('v_42', 'https://hh.ru/search/vacancy', 1, 'trap');
    assert.equal(unconfirmed.observed.sent, 0);
    assert.equal(unconfirmed.observed.successProcessed, 0);
    assert.equal(unconfirmed.observed.manual, 1);
});

for (const destination of ['login', 'error', 'unknown']) {
    test(`post-submit navigation to ${destination} never increments sent or processed-success`, async () => {
        const harness = createSubmitHarness({
            confirmationDelayMs: 100,
            destination,
            confirmationKind: 'none',
            postSubmitText: destination === 'unknown' ? 'message cover reject' : 'Application sent'
        });
        await harness.submitResponsePage('v_42', 'https://hh.ru/search/vacancy', 1, 'trap');

        assert.equal(harness.observed.normalClicks, 1);
        assert.equal(harness.observed.sent, 0);
        assert.equal(harness.observed.successProcessed, 0);
        assert.equal(harness.observed.manual, 1);
    });
}

test('untrusted navigation cannot fall through to reject-only force submit', async () => {
    const harness = createSubmitHarness({
        confirmationDelayMs: 100,
        destination: 'login',
        confirmationKind: 'none',
        reject: true,
        rejectForceResult: 'OK'
    });
    await harness.submitResponsePage('v_42', 'https://hh.ru/search/vacancy', 1, 'trap');

    assert.equal(harness.observed.normalClicks, 1);
    assert.equal(harness.observed.forceCalls, 0);
    assert.equal(harness.observed.sent, 0);
    assert.equal(harness.observed.successProcessed, 0);
    assert.equal(harness.observed.manual, 1);
});

for (const invalidateRun of ['stop', 'stale']) {
    test(`${invalidateRun} fencing blocks a late trusted navigation from mutating counters`, async () => {
        const harness = createSubmitHarness({
            confirmationDelayMs: 100,
            destination: 'search',
            confirmationKind: 'none',
            invalidateRun
        });
        await harness.submitResponsePage('v_42', 'https://hh.ru/search/vacancy', 1, 'trap');

        assert.equal(harness.observed.normalClicks, 1);
        assert.equal(harness.observed.sent, 0);
        assert.equal(harness.observed.processed, 0);
        assert.equal(harness.observed.manual, 0);
    });
}

for (const postSubmitText of ['Resume delivered', 'Application sent']) {
    test(`new document-level strong text confirms only after submit: ${postSubmitText}`, async () => {
        const harness = createSubmitHarness({
            confirmationDelayMs: 100,
            destination: 'response',
            confirmationKind: 'none',
            postSubmitText
        });
        await harness.submitResponsePage('v_42', 'https://hh.ru/search/vacancy', 1, 'trap');

        assert.equal(harness.observed.sent, 1);
        assert.equal(harness.observed.successProcessed, 1);
        assert.equal(harness.observed.manual, 0);
    });
}

test('pre-existing document-level strong text is not reused as post-submit confirmation', async () => {
    const harness = createSubmitHarness({
        confirmationDelayMs: 100,
        destination: 'response',
        confirmationKind: 'none',
        preexistingStrongText: 'Resume delivered'
    });
    await harness.submitResponsePage('v_42', 'https://hh.ru/search/vacancy', 1, 'trap');

    assert.equal(harness.observed.sent, 0);
    assert.equal(harness.observed.successProcessed, 0);
    assert.equal(harness.observed.manual, 1);
});

for (const postSubmitText of ['message', 'cover letter', 'reject warning', 'Эта вакансия вам не подходит']) {
    test(`generic post-submit copy remains non-success: ${postSubmitText}`, async () => {
        const harness = createSubmitHarness({
            confirmationDelayMs: 100,
            destination: 'response',
            confirmationKind: 'none',
            postSubmitText
        });
        await harness.submitResponsePage('v_42', 'https://hh.ru/search/vacancy', 1, 'trap');

        assert.equal(harness.observed.sent, 0);
        assert.equal(harness.observed.successProcessed, 0);
        assert.equal(harness.observed.manual, 1);
    });
}

class FakeStorage {
    constructor() { this.values = new Map(); }
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
    setItem(key, value) { this.values.set(key, String(value)); }
    removeItem(key) { this.values.delete(key); }
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
        createTextNode: text => ({ textContent: text }),
        addEventListener() {},
        removeEventListener() {}
    };
    const context = {
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
        requestAnimationFrame: fn => setTimeout(fn, 0),
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

test('double userscript execution keeps one watchdog and one global-listener set', () => {
    const marker = '    function bootstrap() {';
    assert.ok(SCRIPT_SOURCE.includes(marker));
    const instrumented = SCRIPT_SOURCE.replace(marker, `
    globalThis.__singletonReached = (globalThis.__singletonReached || 0) + 1;
    return;
${marker}`);
    const { context, counts } = createSingletonContext();
    vm.createContext(context);

    vm.runInContext(instrumented, context, { filename: SCRIPT_PATH });
    const firstRecord = context.__hhApplyAssistantV4Runtime;
    const afterFirst = counts();
    assert.equal(firstRecord.active, true);
    assert.equal(afterFirst.intervalsCreated, 1);
    assert.equal(firstRecord.watchdogIntervalId, 1);
    assert.ok(firstRecord.globalListeners.length >= 3);

    vm.runInContext(instrumented, context, { filename: SCRIPT_PATH });
    assert.equal(context.__hhApplyAssistantV4Runtime, firstRecord);
    assert.deepEqual(counts(), afterFirst);
    assert.equal(context.__singletonReached, 1);

    firstRecord.teardown();
    assert.equal(context.__hhApplyAssistantV4Runtime, undefined);
    assert.equal(counts().intervalsCleared, 1);
    assert.equal(counts().listenersRemoved, afterFirst.listenersAdded);

    vm.runInContext(instrumented, context, { filename: SCRIPT_PATH });
    assert.equal(counts().intervalsCreated, 2);
    assert.equal(context.__singletonReached, 2);
});

test('confirmed backend dead constants stay removed', () => {
    assert.doesNotMatch(SCRIPT_SOURCE, /\btopApply\s*:/);
    assert.doesNotMatch(SCRIPT_SOURCE, /\b(?:MANUAL|RETRY|FATAL)\s*:\s*['"]/);
});

test('response waiting uses filtered mutations, ignores assistant UI and throttles fallback scans', () => {
    const waitStart = SCRIPT_SOURCE.indexOf('async function waitForCondition');
    const waitEnd = SCRIPT_SOURCE.indexOf('// Корректная вставка текста', waitStart);
    const waitSource = SCRIPT_SOURCE.slice(waitStart, waitEnd);
    assert.match(waitSource, /mutations\.every\(mutationBelongsToAssistantUI\)/);
    assert.match(waitSource, /attributeFilter:\s*\[[^\]]*'data-qa'/s);
    assert.match(waitSource, /setInterval\(executeCheck, 300\)/);
    assert.doesNotMatch(waitSource, /requestAnimationFrame/);

    const resolveStart = SCRIPT_SOURCE.indexOf('async function resolveResponseOutcome');
    const resolveEnd = SCRIPT_SOURCE.indexOf('// Определяем сценарий', resolveStart);
    const resolveSource = SCRIPT_SOURCE.slice(resolveStart, resolveEnd);
    assert.match(resolveSource, /now - lastFallbackAt >= 750/);
    assert.match(resolveSource, /detectResponseOutcomeOnce\(runId, includeFallback\)/);
});
