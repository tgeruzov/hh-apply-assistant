import { test, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    detectPostSubmitPageOutcome,
    resolveResponseOutcome,
    detectResponseOutcomeOnce
} from './automation-engine.js';
import {
    hasResponseTextConfirmation,
    isResponseConfirmed,
    pageLooksLikeTest,
    detectModalBlockReason
} from '../dom/dom-adapter.js';
import { State, setConfig, Settings } from './state-manager.js';
import { setStopSignal, setRunId } from './concurrency.js';
import { SELECTORS } from '../dom/selectors.js';

const ROOT = path.resolve(__dirname, '../../');
const SCRIPT_PATH = path.join(ROOT, 'hh-apply-assistant.user.js');
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, 'utf8').replace(/\r\n/g, '\n');

const submitStart = SCRIPT_SOURCE.indexOf('    async function submitResponsePage');
const submitEnd = SCRIPT_SOURCE.indexOf('\n\n    // Открываем вакансию со списка', submitStart);
const SUBMIT_RESPONSE_PAGE_SOURCE = SCRIPT_SOURCE.slice(submitStart, submitEnd);

const postSubmitOutcomeStart = SCRIPT_SOURCE.indexOf('    function detectPostSubmitPageOutcome');
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
}: {
    confirmationDelayMs: number;
    destination?: string;
    confirmationKind?: string;
    preexistingStrongText?: string;
    postSubmitText?: string;
    invalidateRun?: string;
    reject?: boolean;
    rejectForceResult?: string;
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
    const isStrongText = (text: string) => /(?:resume delivered|application sent|response sent|резюме доставлено)/i.test(text || '');
    const window = { location: { href: 'https://hh.ru/applicant/vacancy_response?vacancyId=42' } };
    const document = {};
    const dependencies: Record<string, any> = {
        isRunCurrent: (runId: number) => running && runId === activeRunId,
        State: {
            touchInstanceLock: () => 'OWNED',
            clearTrapLock: () => true,
            clearLastAttemptID: () => true,
            setF5Needed: () => true
        },
        TAB_ID: 'tab-test',
        haltForLostInstanceLock: () => { throw new Error('lease must remain owned'); },
        hasReliableRejectWarning: () => reject,
        Metrics: { bump() {} },
        config: { applyOnRejectWarning: true, useCover: false },
        log() {},
        I18n: { t: (key: string) => key },
        captureResponseDom() {},
        fillLetterAndSubmit: async () => {
            observed.normalClicks++;
            return true;
        },
        waitForCondition: async (check: () => boolean, timeout: number) => {
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
        haltForPersistenceFailure: () => { throw new Error('manual fallback persistence must succeed'); },
        haltForCaptcha: () => { throw new Error('captcha is outside this harness'); },
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

        expect(harness.observed.normalClicks).toBe(1);
        expect(harness.observed.forceCalls).toBe(0);
        expect(harness.observed.waitTimeout).toBe(16_000);
        expect(harness.observed.sent).toBe(1);
        expect(harness.observed.processed).toBe(1);
        expect(harness.observed.manual).toBe(0);
        expect(harness.getHandling()).toBe(false);
    });
}

test('unconfirmed ordinary full-page submit falls back to Manual Queue without a second click', async () => {
    const harness = createSubmitHarness({ confirmationDelayMs: 17_000, confirmationKind: 'none' });
    await harness.submitResponsePage('v_42', 'https://hh.ru/search/vacancy', 1, 'trap');

    expect(harness.observed.normalClicks).toBe(1);
    expect(harness.observed.forceCalls).toBe(0);
    expect(harness.observed.sent).toBe(0);
    expect(harness.observed.manual).toBe(1);
    expect(harness.observed.processed).toBe(1);
});

test('force submit remains reachable only for a reliably detected reject warning', async () => {
    const harness = createSubmitHarness({
        confirmationDelayMs: 7_000,
        reject: true,
        rejectForceResult: 'OK'
    });
    await harness.submitResponsePage('v_42', 'https://hh.ru/search/vacancy', 1, 'trap');

    expect(harness.observed.normalClicks).toBe(1);
    expect(harness.observed.waitTimeout).toBe(6_000);
    expect(harness.observed.forceCalls).toBe(1);
    expect(harness.observed.sent).toBe(1);
});

test('post-submit navigation to the trusted search route is a single successful send', async () => {
    const harness = createSubmitHarness({
        confirmationDelayMs: 100,
        destination: 'search',
        confirmationKind: 'none'
    });
    await harness.submitResponsePage('v_42', 'https://hh.ru/search/vacancy', 1, 'trap');

    expect(harness.observed.normalClicks).toBe(1);
    expect(harness.observed.sent).toBe(1);
    expect(harness.observed.successProcessed).toBe(1);
    expect(harness.observed.manual).toBe(0);
});

test('post-submit vacancy navigation requires response-specific confirmation', async () => {
    const confirmed = createSubmitHarness({
        confirmationDelayMs: 100,
        destination: 'vacancy',
        confirmationKind: 'scoped'
    });
    await confirmed.submitResponsePage('v_42', 'https://hh.ru/search/vacancy', 1, 'trap');
    expect(confirmed.observed.sent).toBe(1);
    expect(confirmed.observed.successProcessed).toBe(1);

    const unconfirmed = createSubmitHarness({
        confirmationDelayMs: 100,
        destination: 'vacancy',
        confirmationKind: 'none'
    });
    await unconfirmed.submitResponsePage('v_42', 'https://hh.ru/search/vacancy', 1, 'trap');
    expect(unconfirmed.observed.sent).toBe(0);
    expect(unconfirmed.observed.successProcessed).toBe(0);
    expect(unconfirmed.observed.manual).toBe(1);
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

        expect(harness.observed.normalClicks).toBe(1);
        expect(harness.observed.sent).toBe(0);
        expect(harness.observed.successProcessed).toBe(0);
        expect(harness.observed.manual).toBe(1);
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

    expect(harness.observed.normalClicks).toBe(1);
    expect(harness.observed.forceCalls).toBe(0);
    expect(harness.observed.sent).toBe(0);
    expect(harness.observed.successProcessed).toBe(0);
    expect(harness.observed.manual).toBe(1);
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

        expect(harness.observed.normalClicks).toBe(1);
        expect(harness.observed.sent).toBe(0);
        expect(harness.observed.processed).toBe(0);
        expect(harness.observed.manual).toBe(0);
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

        expect(harness.observed.sent).toBe(1);
        expect(harness.observed.successProcessed).toBe(1);
        expect(harness.observed.manual).toBe(0);
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

    expect(harness.observed.sent).toBe(0);
    expect(harness.observed.successProcessed).toBe(0);
    expect(harness.observed.manual).toBe(1);
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

        expect(harness.observed.sent).toBe(0);
        expect(harness.observed.successProcessed).toBe(0);
        expect(harness.observed.manual).toBe(1);
    });
}

test('response waiting uses filtered mutations, ignores assistant UI and throttles fallback scans', () => {
    const waitStart = SCRIPT_SOURCE.indexOf('async function waitForCondition');
    const waitEnd = SCRIPT_SOURCE.indexOf('// Корректная вставка текста', waitStart);
    const waitSource = SCRIPT_SOURCE.slice(waitStart, waitEnd);
    expect(waitSource).toMatch(/mutations\.every\(mutationBelongsToAssistantUI\)/);
    expect(waitSource).toMatch(/attributeFilter:\s*\[[^\]]*'data-qa'/s);
    expect(waitSource).toMatch(/setInterval\(executeCheck, 300\)/);
    expect(waitSource).not.toMatch(/requestAnimationFrame/);

    const resolveStart = SCRIPT_SOURCE.indexOf('async function resolveResponseOutcome');
    const resolveEnd = SCRIPT_SOURCE.indexOf('// Определяем сценарий', resolveStart);
    const resolveSource = SCRIPT_SOURCE.slice(resolveStart, resolveEnd);
    expect(resolveSource).toMatch(/now - lastFallbackAt >= 750/);
    expect(resolveSource).toMatch(/detectResponseOutcomeOnce\(runId, includeFallback\)/);
});
