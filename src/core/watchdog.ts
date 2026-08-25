import { q, qa, isAutoResponderUI, isVisible, Page, pageLooksLikeTest, getVacancyIDFromHref, resolveManualTitle, query, captureResponseDom } from '../dom/dom-adapter.js';
import {
    TAB_ID,
    currentRunId,
    pendingInstanceLeaseId,
    handlingResponsePage,
    setHandlingResponsePage,
    setStopSignal,
    setResumeTimer,
    setActiveAbortController,
    setLoopActive,
    incRunId,
    clearTrapLockTimer,
    guardOwnedCommit,
    activeAbortController,
    resumeTimer,
    isRunCurrent
} from './concurrency.js';
import { State, Stats, Metrics, log, setStatus, clearRunningState } from './state-manager.js';
import { I18n } from '../i18n/index.js';
import { fnv1a32 } from './utils.js';
import { runtimeRecord, RUNTIME_KEY } from './runtime.js';
import { submitResponsePage, persistProcessedVacancy, haltForLostInstanceLock, haltForPersistenceFailure } from './automation-engine.js';

let panelMountHandler: (() => void) | null = null;
let panelDestroyHandler: (() => void) | null = null;

export function registerPanelHandlers(mount: () => void, destroy: () => void): void {
    panelMountHandler = mount;
    panelDestroyHandler = destroy;
}

// Обнаружение капчи / анти-бот проверки hh.ru.
export function detectCaptcha(): boolean {
    if (typeof document === 'undefined') return false;
    if (q('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="captcha" i], iframe[src*="smartcaptcha" i], iframe[title*="captcha" i], [data-qa*="captcha" i], .g-recaptcha, .h-captcha, .smart-captcha')) return true;
    if (typeof location !== 'undefined' && /\/captcha|\/checkpoint|\/nocaptcha/i.test(location.pathname)) return true;
    const rx = /подтвердите,?\s*что\s*вы\s*не\s*робот|вы не робот|not a robot|необычн\w*\s+активн|unusual (?:activity|traffic)|слишком много (?:действий|попыток|запросов|откликов)/i;
    const scopes = qa('.mock-captcha-overlay, [role="dialog"], [class*="captcha" i], [class*="overlay" i], [data-qa*="modal" i], [class*="modal" i]');
    for (const s of scopes) {
        if (isAutoResponderUI(s)) continue;
        const t = (s.textContent || '');
        if (t.length <= 400 && rx.test(t) && isVisible(s)) return true;
    }
    return false;
}

// Останавливаем прогон из-за капчи: снимаем рабочие флаги, освобождаем межвкладочную
// блокировку и показываем понятный статус.
export function haltForCaptcha(): void {
    incRunId();
    Metrics.bump('scenario.captcha');
    captureResponseDom('captcha');
    setStopSignal(true);
    if (resumeTimer) { clearTimeout(resumeTimer); setResumeTimer(null); }
    setHandlingResponsePage(false);
    State.clearTrapLock();
    if (activeAbortController) {
        try { activeAbortController.abort(); } catch (e) {}
        setActiveAbortController(null);
    }
    setLoopActive(false);
    clearRunningState('captcha');
    State.releaseInstanceLock(TAB_ID);
    setStatus('error', 'status.captchaStopped');
    log(I18n.t('logs.captchaHalt'), true);
}

export function watchdogTick(): void {
    if (typeof document === 'undefined') return;
    if (document.body && !document.getElementById('ar-main-panel')) {
        panelMountHandler?.();
    }

    if (!State.amIRunning()) return;

    if (pendingInstanceLeaseId) return;

    const lockStatus = State.touchInstanceLock(TAB_ID);
    if (lockStatus !== 'OWNED') {
        haltForLostInstanceLock();
        return;
    }

    if (detectCaptcha()) { haltForCaptcha(); return; }

    if (Page.isResponseForm()) {
        if (handlingResponsePage) return;
        if (State.hasTrapLock()) return;
        if (currentRunId === 0) incRunId();
        const trapToken = State.setTrapLock();
        if (!trapToken) {
            haltForPersistenceFailure(State.getLastAttemptID(), 'trapLock');
            return;
        }

        let vid: string | null = null;
        try {
            if (document.referrer) {
                const r = getVacancyIDFromHref(document.referrer);
                if (r) vid = 'v_' + r;
            }
        } catch (e) { /* ignore */ }
        if (!vid) { const last = State.getLastAttemptID(); if (last) vid = last; }
        if (!vid) { const cur = getVacancyIDFromHref(location.href); if (cur) vid = 'v_' + cur; }

        const savedReturn = State.getReturnUrl();
        const backUrl = (savedReturn && savedReturn.includes('/search/vacancy')) ? savedReturn : '/search/vacancy';

        if (!pageLooksLikeTest()) {
            if (handlingResponsePage) return;
            setHandlingResponsePage(true);
            Metrics.bump('page.response.detected');
            log(I18n.t('logs.onResponsePage'));
            submitResponsePage(vid, backUrl, currentRunId, trapToken);
            return;
        }

        Metrics.bump('scenario.questions.watchdog');
        captureResponseDom('questions-page');
        log(I18n.t('logs.questionsPage'), true);

        let saved = false;
        try {
            const entry = {
                vid: vid || ('u_' + fnv1a32(location.href).toString(36)),
                url: location.href,
                returnUrl: savedReturn || '',
                ts: Date.now(),
                title: resolveManualTitle(vid)
            };
            const res = State.addManualEntry(entry);
            if (res === 'ADDED') {
                Stats.bump('manual');
                log(I18n.t('logs.manualSaved', { note: '', vid: entry.vid }));
                try { (window as any)._hhApplyAssistantRenderManualQueue?.(); } catch (e) { /* ignore */ }
                saved = true;
            } else if (res === 'EXISTS' || res === 'UPDATED') {
                log(I18n.t('logs.manualAlready', { note: '', vid: entry.vid }));
                try { (window as any)._hhApplyAssistantRenderManualQueue?.(); } catch (e) { /* ignore */ }
                saved = true;
            } else {
                log(I18n.t('logs.manualSaveFailed', { note: '', vid: entry.vid }), true);
                saved = false;
            }
        } catch (e) {
            console.warn('[HH Apply Assistant] save manual entry error', e);
            log(I18n.t('logs.manualSaveFailed', { note: '', vid }), true);
            saved = false;
        }

        if (saved) {
            if (vid) {
                if (!persistProcessedVacancy(vid, currentRunId)) return;
                if (!State.clearLastAttemptID()) {
                    haltForPersistenceFailure(vid, 'lastAttempt');
                    return;
                }
            } else {
                log(I18n.t('logs.noVidOnQuestions'), true);
            }

            State.setF5Needed();

            try { history.go(-2); } catch (e) { history.back(); }

            const timerRunId = currentRunId;
            setTimeout(() => {
                if (isRunCurrent(timerRunId) && Page.isResponseForm() && guardOwnedCommit(timerRunId)) {
                    log(I18n.t('logs.twoStepBackFailed'), true);
                    window.location.href = backUrl;
                }
            }, 1200);
        } else {
            haltForPersistenceFailure(vid);
        }
    } else {
        State.clearTrapLock();
        setHandlingResponsePage(false);

        const backOnList = Page.isSearchList()
            || (!Page.isVacancy() && !Page.isResponseForm() && query('applyBtn'));
        if (State.isF5Needed() && backOnList) {
            log(I18n.t('logs.returnedReloading'));
            State.clearF5Flag();
            window.location.reload();
        }
    }
}

export function startWatchdog(): void {
    if (runtimeRecord.watchdogIntervalId !== null) return;
    runtimeRecord.watchdogIntervalId = setInterval(() => {
        try {
            watchdogTick();
        } catch (e) {
            console.warn('[HH Apply Assistant] watchdog error', e);
        }
    }, 1000);
}

export function teardownRuntime(): void {
    if (!runtimeRecord.active) return;
    runtimeRecord.active = false;
    incRunId();
    setStopSignal(true);
    setLoopActive(false);
    setHandlingResponsePage(false);
    if (resumeTimer) { clearTimeout(resumeTimer); setResumeTimer(null); }
    clearTrapLockTimer();
    if (activeAbortController) {
        try { activeAbortController.abort(); } catch (e) {}
        setActiveAbortController(null);
    }
    if (runtimeRecord.watchdogIntervalId !== null) {
        clearInterval(runtimeRecord.watchdogIntervalId);
        runtimeRecord.watchdogIntervalId = null;
    }
    if (runtimeRecord.domReadyObserver) {
        try { runtimeRecord.domReadyObserver.disconnect(); } catch (e) {}
        runtimeRecord.domReadyObserver = null;
    }
    for (const listener of runtimeRecord.globalListeners.splice(0)) {
        try { listener.target.removeEventListener(listener.type, listener.handler, listener.options); } catch (e) {}
    }
    try { panelDestroyHandler?.(); } catch (e) {}
    clearRunningState('runtime-teardown');
    State.releaseInstanceLock(TAB_ID);
    if (typeof window !== 'undefined' && (window as any)[RUNTIME_KEY] === runtimeRecord) {
        try { delete (window as any)[RUNTIME_KEY]; } catch (e) { (window as any)[RUNTIME_KEY] = null; }
    }
}

runtimeRecord.teardown = teardownRuntime;
