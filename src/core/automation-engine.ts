import { SELECTORS, TUNING } from '../dom/selectors.js';
import {
    q,
    qa,
    isVisible,
    isAutoResponderUI,
    query,
    queryExact,
    queryHeuristic,
    queryAll,
    getVacancyCard,
    getVacancyID,
    getStableVacancyId,
    Page,
    pageLooksLikeTest,
    getResponseDetectionScope,
    hasReliableRejectWarning,
    hasResponseTextConfirmation,
    hasExactResponseConfirmation,
    isResponseConfirmed,
    detectAlreadyApplied,
    detectModalBlockReason,
    parseVacancyTitle,
    readSerpCardTitle,
    resolveManualTitle,
    saveCurrentForManual,
    captureResponseDom,
    recordSelectorVariant,
    waitForElement,
    waitForCondition,
    fillTextarea,
    realisticClick,
    safeClick
} from '../dom/dom-adapter.js';
import {
    TAB_ID,
    currentRunId,
    isLoopActive,
    stopSignal,
    activeAbortController,
    resumeTimer,
    isRunCurrent,
    guardOwnedCommit,
    wait,
    setLoopActive,
    setStopSignal,
    setResumeTimer,
    setActiveAbortController,
    setHandlingResponsePage,
    incRunId,
    setHaltHandler
} from './concurrency.js';

declare let handlingResponsePage: boolean;
import {
    State,
    Stats,
    Metrics,
    log,
    config,
    timings,
    actionPause,
    vacancyPause,
    setStatus,
    clearRunningState
} from './state-manager.js';
import { I18n, presetLabel } from '../i18n/index.js';
import { clamp, randBetween, toSafeHhUrl } from './utils.js';
import { detectCaptcha, haltForCaptcha } from './watchdog.js';
import type { ExecutionResultData, TerminalCode } from '../types/index.js';

export const EXECUTION_STATUS = Object.freeze({
    SUCCESS: 'SUCCESS',
    SKIPPED: 'SKIPPED',
    NAVIGATED: 'NAVIGATED',
    STOPPED: 'STOPPED',
    CAPTCHA: 'CAPTCHA'
} as const);

export const EXECUTION_REASON = Object.freeze({
    APPLIED: 'APPLIED',
    RETURNING_TO_LIST: 'RETURNING_TO_LIST',
    VACANCY_PAGE: 'VACANCY_PAGE',
    RESPONSE_PAGE: 'RESPONSE_PAGE',
    NO_LINK: 'NO_LINK',
    NO_HREF: 'NO_HREF',
    UNKNOWN: 'UNKNOWN',
    UNRECOGNIZED_CODE: 'UNRECOGNIZED_CODE'
} as const);

export const ExecutionResult = {
    fromTerminalCode(code: string | TerminalCode): ExecutionResultData {
        const terminalCode = String(code || 'ERROR_UNKNOWN');
        switch (terminalCode) {
            case 'OK':
                return { status: EXECUTION_STATUS.SUCCESS, reason: EXECUTION_REASON.APPLIED, code: terminalCode };
            case 'RETURNED':
                return { status: EXECUTION_STATUS.SUCCESS, reason: EXECUTION_REASON.RETURNING_TO_LIST, code: terminalCode };
            case 'NAVIGATED':
                return { status: EXECUTION_STATUS.NAVIGATED, reason: EXECUTION_REASON.VACANCY_PAGE, code: terminalCode };
            case 'REDIRECT':
                return { status: EXECUTION_STATUS.NAVIGATED, reason: EXECUTION_REASON.RESPONSE_PAGE, code: terminalCode };
            case 'STOPPED':
                return { status: EXECUTION_STATUS.STOPPED, reason: EXECUTION_REASON.UNKNOWN, code: terminalCode };
            case 'CAPTCHA':
                return { status: EXECUTION_STATUS.CAPTCHA, reason: EXECUTION_REASON.UNKNOWN, code: terminalCode };
            case 'ERROR_NO_LINK':
                return { status: EXECUTION_STATUS.SKIPPED, reason: EXECUTION_REASON.NO_LINK, code: terminalCode };
            case 'ERROR_NO_HREF':
                return { status: EXECUTION_STATUS.SKIPPED, reason: EXECUTION_REASON.NO_HREF, code: terminalCode };
            case 'ERROR_UNKNOWN':
                return { status: EXECUTION_STATUS.SKIPPED, reason: EXECUTION_REASON.UNKNOWN, code: terminalCode };
            default:
                return { status: EXECUTION_STATUS.SKIPPED, reason: EXECUTION_REASON.UNRECOGNIZED_CODE, code: terminalCode };
        }
    }
};

    // Имитация прокрутки: вниз до секции Подходящие вакансии в этой компании
// (или до 60% страницы), пауза, и возврат вверх.
export async function simulateReading(viewTime: number, runId = currentRunId): Promise<void> {
    if (!viewTime || viewTime <= 0) return;
    try {
        await actionPause();
        if (!isRunCurrent(runId)) return;

        const stepMs = Math.max(100, TUNING.scrollStepMs);
        const docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        const winH = window.innerHeight || document.documentElement.clientHeight;
        const maxY = Math.max(0, docHeight - winH);

        const needleRx = /(?:подходящие вакансии в этой компании|similar vacancies|vacancies at this company)/i;
        let sectionEl: Element | null = null;
        for (const el of qa('h1,h2,h3,h4')) {
            try {
                if ((el as HTMLElement).innerText && needleRx.test((el as HTMLElement).innerText.trim())) {
                    sectionEl = el;
                    break;
                }
            } catch (e) { continue; }
        }
        if (!sectionEl) {
            for (const el of qa('h1,h2,h3,h4,div,section')) {
                try {
                    if ((el as HTMLElement).innerText && needleRx.test((el as HTMLElement).innerText.trim())) {
                        sectionEl = el;
                        break;
                    }
                } catch (e) { continue; }
            }
        }

        let targetY: number;
        if (sectionEl) {
            const rect = sectionEl.getBoundingClientRect();
            targetY = clamp(Math.round(rect.top + window.pageYOffset - 100), 0, maxY);
            log(I18n.t('logs.readingFound'));
        } else {
            targetY = Math.round(maxY * 0.6);
            log(I18n.t('logs.readingFallback'));
        }

        const totalSteps = Math.max(6, Math.floor((viewTime / stepMs) / 2));
        const startY = window.pageYOffset || 0;

        for (let i = 1; i <= totalSteps; i++) {
            if (!isRunCurrent(runId)) return;
            const frac = i / totalSteps;
            window.scrollTo({ top: Math.round(startY + (targetY - startY) * frac), behavior: 'auto' });
            await wait(stepMs + randBetween(-Math.floor(stepMs / 3), Math.floor(stepMs / 3)));
            if (!isRunCurrent(runId)) return;
            await actionPause();
            if (!isRunCurrent(runId)) return;
        }

        await wait(randBetween(800, 1600));
        if (!isRunCurrent(runId)) return;
        await actionPause();
        if (!isRunCurrent(runId)) return;

        const upSteps = Math.max(4, Math.floor(totalSteps / 2));
        for (let i = upSteps; i >= 0; i--) {
            if (!isRunCurrent(runId)) return;
            const frac = i / upSteps;
            window.scrollTo({ top: Math.round(startY + (targetY - startY) * frac), behavior: 'auto' });
            await wait(stepMs + randBetween(-Math.floor(stepMs / 4), Math.floor(stepMs / 4)));
            if (!isRunCurrent(runId)) return;
            await actionPause();
            if (!isRunCurrent(runId)) return;
        }

        if (!isRunCurrent(runId)) return;
        window.scrollTo({ top: 0, behavior: 'auto' });
        await wait(200 + randBetween(0, 500));
        if (!isRunCurrent(runId)) return;
        await actionPause();
    } catch (e) {
        console.warn('[HH Apply Assistant] simulateReading error', e);
    }
}

export function detectResponseOutcomeInRoot(root: ParentNode, includeExactSelectors: boolean): string | false {
    if (includeExactSelectors) {
        if (isVisible(queryExact('relocationBtn', root))) return 'RELOCATION';
        if (isVisible(queryExact('letterSubmit', root))) return 'SCENARIO_B';
        if (isVisible(queryExact('attachCoverBtn', root))) return 'SCENARIO_A';
        if (hasExactResponseConfirmation(root)) return 'SCENARIO_C';
    }

    if (queryHeuristic('relocationBtn', root)) return 'RELOCATION';
    if (queryHeuristic('letterSubmit', root)) return 'SCENARIO_B';
    if (queryHeuristic('attachCoverBtn', root)) return 'SCENARIO_A';
    if (queryHeuristic('responseChat', root) || hasResponseTextConfirmation(root)) return 'SCENARIO_C';
    return false;
}

export function detectResponseOutcomeOnce(runId = currentRunId, includeCompatibilityFallback = true): string | false {
    if (!isRunCurrent(runId)) return 'STOPPED';
    if (detectCaptcha()) return 'CAPTCHA';
    if (Page.isResponseForm()) return 'QUESTIONS';

    if (isVisible(queryExact('relocationBtn'))) return 'RELOCATION';
    if (isVisible(queryExact('letterSubmit'))) return 'SCENARIO_B';
    if (isVisible(queryExact('attachCoverBtn'))) return 'SCENARIO_A';
    if (hasExactResponseConfirmation(document)) return 'SCENARIO_C';

    if (!includeCompatibilityFallback) return false;

    const scope = getResponseDetectionScope();
    if (!scope) return false;
    return detectResponseOutcomeInRoot(scope, true);
}

export async function resolveResponseOutcome(timeout: number, runId = currentRunId): Promise<string> {
    let lastFallbackAt = -Infinity;
    const outcome = await waitForCondition(() => {
        const now = Date.now();
        const includeFallback = now - lastFallbackAt >= 750;
        if (includeFallback) lastFallbackAt = now;
        return detectResponseOutcomeOnce(runId, includeFallback);
    }, timeout);
    if (!isRunCurrent(runId)) return 'STOPPED';
    return (outcome as string) || 'TIMEOUT';
}

export async function resolveWithRelocation(timeout: number, runId = currentRunId): Promise<string> {
    let outcome = await resolveResponseOutcome(timeout, runId);
    let guard = 0;
    while (outcome === 'RELOCATION' && guard < 3) {
        if (!isRunCurrent(runId)) return 'STOPPED';
        guard++;
        Metrics.bump('scenario.relocation');
        log(I18n.t('logs.relocationConfirm'));
        const reloc = query('relocationBtn');
        if (reloc) {
            await actionPause();
            if (!isRunCurrent(runId)) return 'STOPPED';
            if (!guardOwnedCommit(runId)) return 'STOPPED';
            safeClick(reloc as HTMLElement);
        }
        await actionPause();
        if (!isRunCurrent(runId)) return 'STOPPED';
        outcome = await resolveResponseOutcome(timeout, runId);
    }
    return outcome;
}

export async function fillLetterAndSubmit({ withCover = true, runId = currentRunId } = {}): Promise<boolean> {
    if (!isRunCurrent(runId)) return false;
    if (withCover) {
        let area = query('letterTextarea') as HTMLTextAreaElement | null;
        if (!area) {
            const attach = query('attachCoverInModal');
            if (isVisible(attach)) {
                await actionPause();
                if (!isRunCurrent(runId)) return false;
                safeClick(attach as HTMLElement);
                await actionPause();
            }
            if (!isRunCurrent(runId)) return false;
            area = (query('letterTextarea') as HTMLTextAreaElement | null) || (await waitForElement('letterTextarea', 3000) as HTMLTextAreaElement | null);
        }
        if (!isRunCurrent(runId)) return false;
        if (area) {
            recordSelectorVariant('textarea', 'textarea[name="text"]', 'textarea[data-qa="vacancy-response-popup-form-letter-input"]');
            fillTextarea(area, config.coverText);
            await actionPause();
        } else {
            log(I18n.t('logs.letterMissing'), true);
        }
    }
    if (!isRunCurrent(runId)) return false;
    await wait(config?.preset === 'turbo' ? randBetween(60, 120) : randBetween(400, 900));
    if (!isRunCurrent(runId)) return false;

    let submitButton = (query('letterSubmit') as HTMLElement | null) || (await waitForElement('letterSubmit', 3000) as HTMLElement | null);
    if (submitButton) recordSelectorVariant('submit', '[data-qa="vacancy-response-letter-submit"]', '[data-qa="vacancy-response-submit-popup"]');
    if (!submitButton) {
        const form = q<HTMLFormElement>('form[action*="vacancy_response"], form[id^="cover-letter-"]');
        if (form) {
            submitButton = q<HTMLElement>('button[type="submit"], input[type="submit"]', form);
            if (!submitButton) {
                if (!guardOwnedCommit(runId)) return false;
                try { form.submit(); log(I18n.t('logs.formSubmitFallback')); return true; }
                catch (e) { console.warn('[HH Apply Assistant] form.submit fallback failed', e); }
            }
        }
    }
    if (!isRunCurrent(runId)) return false;
    if (!submitButton) { log(I18n.t('logs.submitBtnMissing'), true); return false; }

    await actionPause();
    if (!isRunCurrent(runId)) return false;
    const clicked = await realisticClick(submitButton, runId);
    return clicked && isRunCurrent(runId);
}

    // Повторная отправка при предупреждении об отказе.
export async function forceSubmitReject(maxAttempts = TUNING.forceSubmitAttempts, opts: { onResponsePage?: boolean; runId?: number; allowDocumentStrongText?: boolean } = {}): Promise<string> {
    const onPage = !!opts.onResponsePage;
    const runId = opts.runId || currentRunId;
    const allowDocumentStrongText = !!opts.allowDocumentStrongText;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (!isRunCurrent(runId)) return 'STOPPED';
        const submit = query('letterSubmit') as HTMLElement | null;
        if (isVisible(submit)) {
            await actionPause();
            if (!isRunCurrent(runId)) return 'STOPPED';
            const clicked = await realisticClick(submit, runId);
            if (!clicked || !isRunCurrent(runId)) return 'STOPPED';
        }
        const res = await waitForCondition(() => {
            if (!isRunCurrent(runId)) return 'STOPPED';
            if (!onPage && Page.isResponseForm()) return 'QUESTIONS';
            if (isResponseConfirmed({ allowDocumentStrongText })) return 'CONFIRMED';
            return false;
        }, 3500);
        if (res === 'STOPPED' || !isRunCurrent(runId)) return 'STOPPED';
        if (res === 'QUESTIONS') return 'REDIRECT';
        if (res === 'CONFIRMED') return 'OK';
    }
    return 'FAIL';
}

export async function awaitSubmitConfirmation(timeout = TUNING.confirmWaitMs, runId = currentRunId, { allowDocumentStrongText = false } = {}): Promise<any> {
    return waitForCondition(() => {
        if (!isRunCurrent(runId)) return 'STOPPED';
        if (Page.isResponseForm()) return 'QUESTIONS';
        return isResponseConfirmed({ allowDocumentStrongText });
    }, timeout);
}

export function markAliasProcessed(vid?: string | null): boolean {
    const last = State.getLastAttemptID();
    if (last && last !== vid) return State.addProcessedID(last);
    return true;
}

export function persistProcessedVacancy(vid?: string | null, runId = currentRunId): boolean {
    if (runId && !guardOwnedCommit(runId)) return false;
    if (!vid) return true;
    if (State.addProcessedID(vid) && markAliasProcessed(vid)) return true;
    haltForPersistenceFailure(vid, 'history');
    return false;
}

export function persistSentCount(vid?: string | null, runId = currentRunId): boolean {
    if (runId && !guardOwnedCommit(runId)) return false;
    if (State.incSentCount() !== null) return true;
    haltForPersistenceFailure(vid, 'sentCount');
    return false;
}

export function markRedirect(vid?: string | null): string {
    if (vid && !State.getLastAttemptID() && !State.setLastAttemptID(vid)) {
        haltForPersistenceFailure(vid, 'lastAttempt');
        return 'STOPPED';
    }
    return 'REDIRECT';
}

export function returnToList(vid?: string | null, { markProcessed = true, runId = currentRunId } = {}): boolean {
    if (runId && !guardOwnedCommit(runId)) return false;
    if (markProcessed && vid && !persistProcessedVacancy(vid)) {
        return false;
    }
    if (!State.clearLastAttemptID()) {
        haltForPersistenceFailure(vid, 'lastAttempt');
        return false;
    }
    const returnUrl = State.getReturnUrl() || '/search/vacancy';
    if (returnUrl && returnUrl.includes('/search/vacancy')) {
        window.location.href = returnUrl;
    } else {
        State.setF5Needed();
        try { history.back(); } catch (e) { window.location.href = '/search/vacancy'; }
        const timerRunId = runId || currentRunId;
        setTimeout(() => {
            if (isRunCurrent(timerRunId) && !Page.isSearchList() && guardOwnedCommit(timerRunId)) {
                window.location.href = '/search/vacancy';
            }
        }, 1500);
    }
    return true;
}

export function detectPostSubmitPageOutcome(runId = currentRunId, { allowDocumentStrongText = false } = {}): string | false {
    if (!isRunCurrent(runId)) return 'STOPPED';
    if (detectCaptcha()) return 'CAPTCHA';
    if (Page.isSearchList()) return 'TRUSTED_NAVIGATION';
    if (Page.isVacancy()) {
        return isResponseConfirmed({ allowDocumentStrongText }) ? 'CONFIRMED' : false;
    }
    if (!Page.isResponseForm()) return 'UNTRUSTED_NAVIGATION';
    if (pageLooksLikeTest()) return 'QUESTIONS';
    if (isResponseConfirmed({ allowDocumentStrongText })) return 'CONFIRMED';
    return false;
}

export async function submitResponsePage(vid?: string | null, backUrl = '/search/vacancy', runId = currentRunId, trapToken: string | null = null): Promise<void> {
    if (!isRunCurrent(runId)) return;
    if (State.touchInstanceLock(TAB_ID) !== 'OWNED') {
        haltForLostInstanceLock();
        return;
    }
    handlingResponsePage = true;
    let savedForManual = false;
    let confirmed = false;
    const reject = hasReliableRejectWarning();
    if (reject) Metrics.bump('reject.seen.page');
    try {
        if (reject && !config.applyOnRejectWarning) {
            if (!isRunCurrent(runId)) return;
            log(I18n.t('logs.responsePageRejectSkip'), true);
            Metrics.bump('page.reject.skipped');
            savedForManual = saveCurrentForManual(vid, 'reject-warning', runId);
        } else {
            log(I18n.t('logs.responsePageFilling', { reject: reject ? I18n.t('logs.responsePageRejectNote') : '' }));
            captureResponseDom('response-page-form');
            const allowDocumentStrongText = !hasResponseTextConfirmation(document);
            const submitted = await fillLetterAndSubmit({ withCover: config.useCover, runId });
            if (!isRunCurrent(runId)) return;
            if (!submitted) {
                Metrics.bump('page.response.fail');
                captureResponseDom('response-page-no-submit');
                savedForManual = saveCurrentForManual(vid, reject ? 'reject-warning' : 'page-no-submit', runId);
                log(I18n.t('logs.responsePageSubmitFail'), true);
            } else {
                let redirectedToQuestions = false;

                const confirmationTimeout = reject ? TUNING.confirmWaitMs : TUNING.responsePagePendingMs;
                const ok = await waitForCondition(
                    () => detectPostSubmitPageOutcome(runId, { allowDocumentStrongText }),
                    confirmationTimeout
                );

                if (!isRunCurrent(runId)) return;
                if (ok === 'CAPTCHA') {
                    haltForCaptcha();
                    return;
                }
                if (ok === 'CONFIRMED' || ok === 'TRUSTED_NAVIGATION') {
                    confirmed = true;
                } else if (ok === 'QUESTIONS') {
                    redirectedToQuestions = true;
                } else if (ok !== 'UNTRUSTED_NAVIGATION' && reject && config.applyOnRejectWarning && hasReliableRejectWarning() && isRunCurrent(runId)) {
                    const forced = await forceSubmitReject(TUNING.forceSubmitAttempts, { onResponsePage: true, runId, allowDocumentStrongText });
                    if (forced === 'STOPPED' || !isRunCurrent(runId)) return;
                    if (forced === 'REDIRECT') {
                        redirectedToQuestions = true;
                    } else if (forced === 'OK') {
                        confirmed = true;
                    }
                }

                if (!isRunCurrent(runId)) return;

                if (confirmed) {
                    Metrics.bump('page.response.ok' + (reject ? '.reject' : ''));
                    if (!persistSentCount(vid, runId)) return;
                    log(I18n.t('logs.responsePageSent'));
                } else if (redirectedToQuestions) {
                    Metrics.bump('scenario.questions.responsePage');
                    savedForManual = saveCurrentForManual(vid, 'questions', runId);
                    log(I18n.t('logs.responsePageQuestions'), true);
                } else {
                    Metrics.bump('page.response.fail');
                    captureResponseDom('response-page-no-confirm');
                    savedForManual = saveCurrentForManual(vid, reject ? 'reject-warning' : 'page-no-confirm', runId);
                    log(I18n.t('logs.responsePageNoConfirm'), true);
                }
            }
        }
    } catch (e) {
        if (!isRunCurrent(runId)) return;
        console.warn('[HH Apply Assistant] submitResponsePage error', e);
        try { savedForManual = saveCurrentForManual(vid, 'page-error', runId); } catch (_) { /* ignore */ }
    } finally {
        if (runId === currentRunId) {
            handlingResponsePage = false;
        }
        State.clearTrapLock(trapToken || undefined);
    }
    if (!isRunCurrent(runId)) return;
    if (confirmed || savedForManual) {
        if (!persistProcessedVacancy(vid, runId)) return;
        if (!State.clearLastAttemptID()) {
            haltForPersistenceFailure(vid, 'lastAttempt');
            return;
        }
        State.setF5Needed();
        if (!Page.isSearchList()) {
            try { window.location.href = backUrl; } catch (e) { /* ignore */ }
        }
    } else {
        haltForPersistenceFailure(vid);
    }
}

export async function openVacancyFromList(vacancyLinkEl: HTMLAnchorElement, runId = currentRunId): Promise<string> {
    if (!isRunCurrent(runId)) return 'STOPPED';
    const hrefRaw = vacancyLinkEl?.href || (vacancyLinkEl.getAttribute && vacancyLinkEl.getAttribute('href'));
    const href = toSafeHhUrl(hrefRaw);
    const vid = getVacancyID(vacancyLinkEl);

    try {
        const serpTitle = readSerpCardTitle(vacancyLinkEl);
        if (serpTitle && vid) State.setLastVacancyMeta(vid, serpTitle);
    } catch (e) { /* ignore */ }

    await actionPause();
    if (!isRunCurrent(runId)) return 'STOPPED';
    State.setReturnUrl();

    try { vacancyLinkEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* ignore */ }
    await actionPause();
    if (!isRunCurrent(runId)) return 'STOPPED';

    if (!href) {
        log(I18n.t('logs.noHref'), true);
        return 'ERROR_NO_HREF';
    }
    log(I18n.t('logs.openingVacancy', { vid }));
    await actionPause();
    if (!isRunCurrent(runId)) return 'STOPPED';
    if (!State.setLastAttemptID(vid)) {
        haltForPersistenceFailure(vid, 'lastAttempt');
        return 'STOPPED';
    }
    if (!guardOwnedCommit(runId)) return 'STOPPED';
    window.location.href = href;
    return 'NAVIGATED';
}

export function ensureReturnUrl(): void {
    const saved = State.getReturnUrl();
    if (!saved || !saved.includes('/search/vacancy')) {
        const ref = (document.referrer && document.referrer.includes('/search/vacancy')) ? document.referrer : '';
        State.setReturnUrl(ref || saved || '/search/vacancy');
    }
}

export function handleMissingApplyButton(vid?: string | null, runId = currentRunId): string {
    if (!isRunCurrent(runId)) return 'STOPPED';
    if (Page.isResponseForm()) return markRedirect(vid);
    if (detectAlreadyApplied()) {
        Metrics.bump('scenario.alreadyApplied');
        Stats.bump('skipped');
        log(I18n.t('logs.alreadyApplied'));
        returnToList(vid, { markProcessed: true, runId });
        return 'RETURNED';
    }
    Metrics.bump('scenario.noApply');
    Stats.bump('skipped');
    captureResponseDom('no-apply-button');
    log(I18n.t('logs.applyBtnMissingReturning'), true);
    returnToList(vid, { markProcessed: true, runId });
    return 'RETURNED';
}

export async function handleScenarioA(vid?: string | null, runId = currentRunId): Promise<string> {
    if (!isRunCurrent(runId)) return 'STOPPED';
    log(I18n.t('logs.scenarioA'));
    if (config.useCover) {
        const attach = query('attachCoverBtn');
        if (attach) {
            await actionPause();
            if (!isRunCurrent(runId)) return 'STOPPED';
            safeClick(attach as HTMLElement);
            await actionPause();
            if (!isRunCurrent(runId)) return 'STOPPED';
            const submitted = await fillLetterAndSubmit({ withCover: true, runId });
            if (!isRunCurrent(runId)) return 'STOPPED';
            if (submitted) await waitForCondition(() => {
                if (!isRunCurrent(runId)) return 'STOPPED';
                return isResponseConfirmed();
            }, 5000);
            if (!isRunCurrent(runId)) return 'STOPPED';
        }
    } else {
        log(I18n.t('logs.coverOff'));
    }
    if (!isRunCurrent(runId)) return 'STOPPED';
    if (!persistSentCount(vid, runId)) return 'STOPPED';
    log(I18n.t('logs.scenarioASent'));
    returnToList(vid, { markProcessed: true, runId });
    return 'OK';
}

export async function handleScenarioB(vid?: string | null, runId = currentRunId): Promise<string> {
    if (!isRunCurrent(runId)) return 'STOPPED';
    const rejectSeen = hasReliableRejectWarning();
    if (rejectSeen) Metrics.bump('reject.seen.modal');
    if (rejectSeen && !config.applyOnRejectWarning) {
        Metrics.bump('reject.skipped.modal');
        log(I18n.t('logs.scenarioBRejectSkip'));
        const saved = saveCurrentForManual(vid, 'reject-warning', runId);
        if (!saved) {
            if (!isRunCurrent(runId)) return 'STOPPED';
            haltForPersistenceFailure(vid);
            return 'STOPPED';
        }
        returnToList(vid, { markProcessed: true, runId });
        return 'RETURNED';
    }
    log(I18n.t('logs.scenarioBModal', { reject: rejectSeen ? I18n.t('logs.scenarioBRejectNote') : '', cover: config.useCover ? I18n.t('logs.scenarioBCoverNote') : I18n.t('logs.scenarioBNoCoverNote') }));
    const allowDocumentStrongText = !hasResponseTextConfirmation(document);
    const submitted = await fillLetterAndSubmit({ withCover: config.useCover, runId });
    if (!isRunCurrent(runId)) return 'STOPPED';
    if (!submitted) {
        log(I18n.t('logs.scenarioBSubmitFail'), true);
        captureResponseDom('scenarioB-no-submit');
        const saved = saveCurrentForManual(vid, rejectSeen ? 'reject-warning' : 'no-submit', runId);
        if (!saved) {
            if (!isRunCurrent(runId)) return 'STOPPED';
            haltForPersistenceFailure(vid);
            return 'STOPPED';
        }
        returnToList(vid, { markProcessed: true, runId });
        return 'RETURNED';
    }
    const conf = await awaitSubmitConfirmation(TUNING.confirmWaitMs, runId, { allowDocumentStrongText });
    if (!isRunCurrent(runId)) return 'STOPPED';
    if (conf === 'QUESTIONS' || Page.isResponseForm()) return markRedirect(vid);
    if (conf === 'CONFIRMED' || conf === true) {
        if (rejectSeen) Metrics.bump('reject.sent.modal');
        if (!isRunCurrent(runId)) return 'STOPPED';
        if (!persistSentCount(vid, runId)) return 'STOPPED';
        log(I18n.t('logs.scenarioBSent', { reject: rejectSeen ? I18n.t('logs.scenarioBSentRejectNote') : '' }));
        returnToList(vid, { markProcessed: true, runId });
        return 'OK';
    }
    const reason = detectModalBlockReason();

    if (reason === 'reject-warning' && config.applyOnRejectWarning) {
        log(I18n.t('logs.scenarioBForcing'));
        const forced = await forceSubmitReject(TUNING.forceSubmitAttempts, { onResponsePage: false, runId, allowDocumentStrongText });
        if (forced === 'STOPPED' || !isRunCurrent(runId)) return 'STOPPED';
        if (forced === 'REDIRECT') return markRedirect(vid);
        if (forced === 'OK') {
            if (!isRunCurrent(runId)) return 'STOPPED';
            Metrics.bump('scenario.B.rejectForced.ok');
            if (!persistSentCount(vid, runId)) return 'STOPPED';
            log(I18n.t('logs.scenarioBForcedSent'));
            returnToList(vid, { markProcessed: true, runId });
            return 'OK';
        }
        Metrics.bump('scenario.B.rejectForced.fail');
    }

    Metrics.bump('scenario.B.noConfirm' + (reason ? '.' + reason : ''));
    captureResponseDom('scenarioB-no-confirm');
    if (reason === 'resume-hidden') {
        log(I18n.t('logs.blockedResumeHidden'), true);
    } else if (reason === 'reject-warning') {
        log(I18n.t('logs.blockedRejectWarning'), true);
    } else {
        log(I18n.t('logs.letterSentNoConfirm'), true);
    }
    const saved = saveCurrentForManual(vid, reason || 'no-confirm', runId);
    if (!saved) {
        if (!isRunCurrent(runId)) return 'STOPPED';
        haltForPersistenceFailure(vid);
        return 'STOPPED';
    }
    returnToList(vid, { markProcessed: true, runId });
    return 'RETURNED';
}

export async function handleTimeout(vid?: string | null, runId = currentRunId): Promise<string> {
    if (!isRunCurrent(runId)) return 'STOPPED';
    if (isResponseConfirmed()) {
        if (!isRunCurrent(runId)) return 'STOPPED';
        Metrics.bump('scenario.timeout.confirmed');
        log(I18n.t('logs.responseConfirmed'));
        if (!persistSentCount(vid, runId)) return 'STOPPED';
        returnToList(vid, { markProcessed: true, runId });
        return 'OK';
    }

    if (detectCaptcha()) { haltForCaptcha(); return 'CAPTCHA'; }
    if (Page.isResponseForm()) return markRedirect(vid);
    if (detectAlreadyApplied()) {
        Metrics.bump('scenario.alreadyApplied');
        Stats.bump('skipped');
        log(I18n.t('logs.alreadyApplied'));
        returnToList(vid, { markProcessed: true, runId });
        return 'RETURNED';
    }

    const applyBtn = query('vacancyApply') as HTMLElement | null;
    const applyVisible = isVisible(applyBtn);

    if (!applyBtn || !applyVisible) {
        await actionPause();
        if (!isRunCurrent(runId)) return 'STOPPED';

        if (isResponseConfirmed()) {
            if (!isRunCurrent(runId)) return 'STOPPED';
            Metrics.bump('scenario.timeout.confirmed');
            log(I18n.t('logs.responseConfirmedExtra'));
            if (!persistSentCount(vid, runId)) return 'STOPPED';
            returnToList(vid, { markProcessed: true, runId });
            return 'OK';
        }
        if (detectCaptcha()) { haltForCaptcha(); return 'CAPTCHA'; }
        if (Page.isResponseForm()) return markRedirect(vid);
        if (detectAlreadyApplied()) {
            Metrics.bump('scenario.alreadyApplied');
            Stats.bump('skipped');
            log(I18n.t('logs.alreadyApplied'));
            returnToList(vid, { markProcessed: true, runId });
            return 'RETURNED';
        }
        if (isVisible(query('letterSubmit'))) {
            return handleScenarioB(vid, runId);
        }
        if (isVisible(query('attachCoverBtn'))) {
            return handleScenarioA(vid, runId);
        }

        Metrics.bump('scenario.timeout.buttonDisappeared.unconfirmed');
        captureResponseDom('timeout-button-disappeared');
        log(I18n.t('logs.btnDisappearedUnconfirmed'), true);
        const blockReason = detectModalBlockReason();
        const saved = saveCurrentForManual(vid, blockReason || 'button-disappeared-unconfirmed', runId);
        if (!saved) {
            if (!isRunCurrent(runId)) return 'STOPPED';
            haltForPersistenceFailure(vid);
            return 'STOPPED';
        }
        returnToList(vid, { markProcessed: true, runId });
        return 'RETURNED';
    }

    Metrics.bump('scenario.retryClick');
    log(I18n.t('logs.retryClick'), true);
    await actionPause();
    if (!isRunCurrent(runId)) return 'STOPPED';
    const retryClicked = await realisticClick(applyBtn, runId);
    if (!retryClicked || !isRunCurrent(runId)) return 'STOPPED';
    const retryOutcome = await resolveWithRelocation(Math.min(TUNING.waitForModalMs, 6000), runId);
    if (!isRunCurrent(runId)) return 'STOPPED';
    if (retryOutcome === 'CAPTCHA') { haltForCaptcha(); return 'CAPTCHA'; }
    if (retryOutcome === 'QUESTIONS' || Page.isResponseForm()) return markRedirect(vid);
    if (retryOutcome === 'SCENARIO_A') return handleScenarioA(vid, runId);
    if (retryOutcome === 'SCENARIO_B') return handleScenarioB(vid, runId);
    if (retryOutcome === 'SCENARIO_C') {
        if (!isRunCurrent(runId)) return 'STOPPED';
        Metrics.bump('scenario.retryClick.ok');
        if (!persistSentCount(vid, runId)) return 'STOPPED';
        log(I18n.t('logs.retryClickSent'));
        returnToList(vid, { markProcessed: true, runId });
        return 'OK';
    }

    Metrics.bump('scenario.timeout.unresolved');
    captureResponseDom('timeout-unresolved');
    log(I18n.t('logs.timeoutUnresolved'), true);
    const saved = saveCurrentForManual(vid, 'timeout', runId);
    if (!saved) {
        if (!isRunCurrent(runId)) return 'STOPPED';
        haltForPersistenceFailure(vid);
        return 'STOPPED';
    }
    returnToList(vid, { markProcessed: true, runId });
    return 'RETURNED';
}

export async function handleVacancyPage(btn: Element | null, runId = currentRunId): Promise<string> {
    if (!isRunCurrent(runId)) return 'STOPPED';
    const vid = getStableVacancyId(btn);

    try {
        const vTitle = parseVacancyTitle();
        if (vTitle) State.setLastVacancyMeta(vid, vTitle);
    } catch (e) { /* ignore */ }

    ensureReturnUrl();

    const t = timings();
    const viewTime = randBetween(t.view[0], t.view[1]);
    log(I18n.t('logs.readingSim', { sec: Math.round(viewTime / 1000) }));
    await simulateReading(viewTime, runId);

    await actionPause();
    if (!isRunCurrent(runId)) return 'STOPPED';

    const applyBtn = (query('vacancyApply') as HTMLElement | null) || (await waitForElement('vacancyApply', TUNING.waitForModalMs) as HTMLElement | null);
    Metrics.selector('vacancyApply', !!applyBtn);
    if (!applyBtn) return handleMissingApplyButton(vid, runId);

    if (!q(SELECTORS.vacancyApply) && detectAlreadyApplied()) {
        return handleMissingApplyButton(vid, runId);
    }

    if (!State.getLastAttemptID() && !State.setLastAttemptID(vid)) {
        haltForPersistenceFailure(vid, 'lastAttempt');
        return 'STOPPED';
    }

    window.scrollTo({ top: 0, behavior: 'auto' });
    await actionPause();
    if (!isRunCurrent(runId)) return 'STOPPED';
    try { applyBtn.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (e) { /* ignore */ }
    await actionPause();
    if (!isRunCurrent(runId)) return 'STOPPED';

    const clickAt = Date.now();
    const clicked = await realisticClick(applyBtn, runId);
    if (!clicked || !isRunCurrent(runId)) return 'STOPPED';

    const outcome = await resolveWithRelocation(TUNING.waitForModalMs, runId);
    if (!isRunCurrent(runId)) return 'STOPPED';

    if (outcome === 'CAPTCHA') { haltForCaptcha(); return 'CAPTCHA'; }

    Metrics.timing('resolveOutcomeMs', Date.now() - clickAt);
    Metrics.bump('scenario.' + ({
        QUESTIONS: 'questions', SCENARIO_A: 'A', SCENARIO_B: 'B',
        SCENARIO_C: 'C', TIMEOUT: 'timeout'
    }[outcome] || 'other'));

    switch (outcome) {
        case 'QUESTIONS':
            return markRedirect(vid);
        case 'SCENARIO_A':
            return handleScenarioA(vid, runId);
        case 'SCENARIO_B':
            return handleScenarioB(vid, runId);
        case 'SCENARIO_C':
            if (!isRunCurrent(runId)) return 'STOPPED';
            log(I18n.t('logs.scenarioC'));
            if (!persistSentCount(vid, runId)) return 'STOPPED';
            returnToList(vid, { markProcessed: true, runId });
            return 'OK';
        default:
            return handleTimeout(vid, runId);
    }
}

export async function processVacancyCode(btn: Element | null, runId = currentRunId): Promise<string> {
    if (!isRunCurrent(runId)) return 'STOPPED';

    if (Page.isVacancy()) return handleVacancyPage(btn, runId);

    if (btn) {
        const card = getVacancyCard(btn);
        const vacLink = ((card && query('vacancyLink', card)) || (card && q<HTMLAnchorElement>('a[href*="/vacancy/"]', card))) as HTMLAnchorElement | null;
        if (!vacLink) {
            log(I18n.t('logs.noLinkSelector'), true);
            return 'ERROR_NO_LINK';
        }
        return openVacancyFromList(vacLink, runId);
    }

    return 'ERROR_UNKNOWN';
}

export async function processVacancy(btn: Element | null, runId = currentRunId): Promise<ExecutionResultData> {
    return ExecutionResult.fromTerminalCode(await processVacancyCode(btn, runId));
}

export function finalizeRun(runId: number, statusKey: any, msg?: string): void {
    if (runId !== currentRunId) return;
    setLoopActive(false);
    if (!Page.isResponseForm()) {
        setHandlingResponsePage(false);
    }
    if (activeAbortController) {
        try { activeAbortController.abort(); } catch (e) {}
        setActiveAbortController(null);
    }
    const runningCleared = clearRunningState('finalize');
    State.releaseInstanceLock(TAB_ID);
    setStatus(runningCleared ? statusKey : 'error');
    if (msg) log(msg);
}

export async function startLoop(): Promise<void> {
    if (isLoopActive) return;

    const wasRunning = State.amIRunning();

    setLoopActive(true);
    const runId = incRunId();
    if (resumeTimer) { clearTimeout(resumeTimer); setResumeTimer(null); }

    if (activeAbortController) {
        try { activeAbortController.abort(); } catch (e) {}
    }
    setActiveAbortController(new AbortController());
    setStopSignal(false);
    if (!State.setRunning(true)) {
        haltForPersistenceFailure('start', 'is_active');
        return;
    }
    setStatus('running');

    const acquired = await State.acquireInstanceLock(TAB_ID);

    if (runId !== currentRunId || stopSignal || !State.amIRunning()) {
        if (acquired && runId === currentRunId) {
            State.releaseInstanceLock(TAB_ID);
        }
        return;
    }

    if (!acquired) {
        if (runId === currentRunId) {
            setLoopActive(false);
            setStopSignal(true);
            if (activeAbortController) {
                try { activeAbortController.abort(); } catch (e) {}
                setActiveAbortController(null);
            }
            log(I18n.t('logs.tabBusy'), true);
            const runningCleared = clearRunningState('instance-lock-acquire');
            setStatus('error', runningCleared ? 'status.busyTab' : undefined);
        }
        return;
    }

    if (!wasRunning) {
        if (!State.resetSentCount()) {
            haltForPersistenceFailure('start', 'sentCount.reset');
            return;
        }
        Stats.reset();
        log(I18n.t('logs.newRun', { mode: presetLabel(config.preset) }));
    }

    try {
        const initialSent = State.readSentCount();
        if (!initialSent.ok) {
            haltForPersistenceFailure('start', 'sentCount.read');
            return;
        }
        if (initialSent.value >= config.limit) {
            finalizeRun(runId, 'done', I18n.t('logs.limitReached', { limit: config.limit }));
            return;
        }

        if (Page.isResponseForm()) {
            setLoopActive(false);
            log(I18n.t('logs.onResponsePage'));
            return;
        }

        if (Page.isVacancy()) {
            log(I18n.t('logs.onVacancyPage'));
            const res = await processVacancy(null, runId);
            if (runId !== currentRunId) return;
            if (res.status === EXECUTION_STATUS.STOPPED || stopSignal) {
                finalizeRun(runId, 'stopped', I18n.t('logs.stoppedDuringVacancy'));
                return;
            }
            if (res.status === EXECUTION_STATUS.CAPTCHA) { setLoopActive(false); return; }
            setLoopActive(false);
            setStatus('running', res.code === 'OK' ? 'status.returningToList' : 'status.waitingToReturn');
            return;
        }

        let allBtns = queryAll('applyBtn');
        if (allBtns.length === 0 && Page.isSearch()) {
            await waitForCondition(() => {
                if (stopSignal || runId !== currentRunId) return 'STOPPED';
                const btns = queryAll('applyBtn');
                if (btns.length > 0) return 'READY';
                if (q('[data-qa*="empty" i], [class*="empty" i]')) return 'EMPTY';
                return false;
            }, 2000);
            if (stopSignal || runId !== currentRunId) return;
            allBtns = queryAll('applyBtn');
        }

        const processedState = State.readProcessedIDs();
        if (!processedState.ok) {
            haltForPersistenceFailure('search', 'history.read');
            return;
        }
        const processed = processedState.value;

        let targets = allBtns.filter(b => {
            if (config.skipHidden && !isVisible(b)) return false;
            return !processed.has(getVacancyID(b));
        });

        log(I18n.t('logs.vacanciesFound', { total: allBtns.length, targets: targets.length, sent: initialSent.value, limit: config.limit }));

        let rescanCount = 0;
        const MAX_RESCANS = 3;

        while (targets.length > 0) {
            if (stopSignal || runId !== currentRunId) break;
            const btn = targets.shift() as HTMLElement;
            const sentState = State.readSentCount();
            if (!sentState.ok) {
                haltForPersistenceFailure('search', 'sentCount.read');
                return;
            }
            if (sentState.value >= config.limit) {
                finalizeRun(runId, 'done', I18n.t('logs.limitReached', { limit: config.limit }));
                return;
            }
            if (State.touchInstanceLock(TAB_ID) !== 'OWNED') {
                haltForLostInstanceLock();
                return;
            }
            if (!document.body.contains(btn)) {
                log(I18n.t('logs.buttonDisappeared'), true);
                if (rescanCount < MAX_RESCANS) {
                    rescanCount++;
                    const currentProcessedState = State.readProcessedIDs();
                    if (!currentProcessedState.ok) {
                        haltForPersistenceFailure('search-rescan', 'history.read');
                        return;
                    }
                    const currentProcessed = currentProcessedState.value;
                    const freshBtns = queryAll('applyBtn');
                    targets = freshBtns.filter(b => {
                        if (config.skipHidden && !isVisible(b)) return false;
                        return !currentProcessed.has(getVacancyID(b));
                    });
                    continue;
                } else {
                    break;
                }
            }

            await vacancyPause();
            if (stopSignal || runId !== currentRunId) break;
            if (State.touchInstanceLock(TAB_ID) !== 'OWNED') {
                haltForLostInstanceLock();
                return;
            }

            const result = await processVacancy(btn, runId);
            if (runId !== currentRunId) return;

            if (result.status === EXECUTION_STATUS.STOPPED || stopSignal) {
                finalizeRun(runId, 'stopped', I18n.t('logs.stoppedProcessing'));
                return;
            } else if (result.status === EXECUTION_STATUS.CAPTCHA) {
                setLoopActive(false);
                return;
            } else if (result.status === EXECUTION_STATUS.NAVIGATED && result.reason === EXECUTION_REASON.VACANCY_PAGE) {
                log(I18n.t('logs.navigatingVacancy'));
                setLoopActive(false);
                return;
            } else if (result.status === EXECUTION_STATUS.NAVIGATED && result.reason === EXECUTION_REASON.RESPONSE_PAGE) {
                log(I18n.t('logs.redirectWaiting'), true);
                setLoopActive(false);
                setStatus('running', 'status.waitingToReturn');
                return;
            } else {
                if (result.status === EXECUTION_STATUS.SKIPPED) {
                    if (result.code === 'ERROR_NO_LINK' || result.code === 'ERROR_NO_HREF' || result.code === 'ERROR_UNKNOWN') {
                        Stats.bump('skipped');
                    }
                }
                log(I18n.t('logs.skippingCode', { code: result.code }), true);
            }
        }

        if (stopSignal || runId !== currentRunId) {
            finalizeRun(runId, 'stopped', I18n.t('logs.stoppedProcessing'));
            return;
        }
        if (!Page.isResponseForm()) {
            const finalSent = State.readSentCount();
            if (!finalSent.ok) {
                haltForPersistenceFailure('finalize', 'sentCount.read');
                return;
            }
            finalizeRun(runId, 'done', I18n.t('logs.runCompleted', { count: finalSent.value }));
        }
    } catch (e: any) {
        console.warn('[HH Apply Assistant] startLoop error', e);
        finalizeRun(runId, 'error', I18n.t('logs.mainLoopError', { err: (e && e.message ? e.message : e) }));
    }
}

export function stopRun(): void {
    incRunId();
    setStopSignal(true);
    if (resumeTimer) { clearTimeout(resumeTimer); setResumeTimer(null); }
    setHandlingResponsePage(false);
    State.clearTrapLock();
    if (activeAbortController) {
        try { activeAbortController.abort(); } catch (e) {}
        setActiveAbortController(null);
    }
    setLoopActive(false);
    const runningCleared = clearRunningState('stop');
    setStatus(runningCleared ? 'stopped' : 'error');
    State.releaseInstanceLock(TAB_ID);
    log(I18n.t('logs.stoppedByUser'));
}

export function haltForLostInstanceLock(): void {
    incRunId();
    Metrics.bump('instanceLock.lost');
    setStopSignal(true);
    if (resumeTimer) { clearTimeout(resumeTimer); setResumeTimer(null); }
    setHandlingResponsePage(false);
    State.clearTrapLock();
    if (activeAbortController) {
        try { activeAbortController.abort(); } catch (e) {}
        setActiveAbortController(null);
    }
    setLoopActive(false);
    clearRunningState('lost-instance-lock');
    setStatus('error', 'status.busyTab');
    log(I18n.t('logs.instanceLockLost'), true);
}

setHaltHandler(haltForLostInstanceLock);

export function haltForPersistenceFailure(vid?: string | null, storageArea = 'manual'): void {
    incRunId();
    Metrics.bump(`storage.${storageArea}.failed`);
    setStopSignal(true);
    if (resumeTimer) { clearTimeout(resumeTimer); setResumeTimer(null); }
    setHandlingResponsePage(false);
    State.clearTrapLock();
    if (activeAbortController) {
        try { activeAbortController.abort(); } catch (e) {}
        setActiveAbortController(null);
    }
    setLoopActive(false);
    clearRunningState(`persistence-${storageArea}`);
    State.releaseInstanceLock(TAB_ID);
    if (storageArea === 'manual') {
        setStatus('error', 'status.storageFailed');
        log(I18n.t('logs.persistenceFailure', { vid: vid || '' }), true);
    } else {
        setStatus('error');
        log(`[CRITICAL_STORAGE_WRITE_FAILED] ${storageArea}: ${vid || 'n/a'}`, true);
    }
}
