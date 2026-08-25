import {
    RUNTIME_KEY,
    runtimeRecord,
    addRuntimeListener
} from './core/runtime.js';
import { Page } from './dom/dom-adapter.js';
import { I18n } from './i18n/index.js';
import {
    State,
    config,
    ensureCurrentRunLimit,
    setStatus,
    log,
    DiagLog,
    Metrics
} from './core/state-manager.js';
import { startLoop } from './core/automation-engine.js';
import { startWatchdog } from './core/watchdog.js';
import { PanelController } from './ui/panel.js';
import {
    TAB_ID,
    isLoopActive,
    activeAbortController,
    resumeTimer,
    setResumeTimer,
    setLoopActive,
    handlingResponsePage,
    setHandlingResponsePage
} from './core/concurrency.js';

// Перехват необработанных ошибок: отделяем собственные ошибки HH Apply Assistant от шума HeadHunter и сторонних скриптов.
let assistantErrCount = 0;
let externalErrCount = 0;
const ASSISTANT_ERR_LIMIT = 50;
const EXTERNAL_ERR_LIMIT = 5;

function isHHApplyAssistantError(e: any, isPromise = false): boolean {
    const errObj = isPromise ? e.reason : (e.error || e);
    const stack = (errObj && typeof errObj.stack === 'string') ? errObj.stack : '';
    const filename = (!isPromise && typeof e.filename === 'string') ? e.filename : '';
    const message = isPromise
        ? (errObj && (errObj.message || String(errObj)) || '')
        : (e.message || String(errObj || ''));
    const combined = `${filename} ${stack} ${message}`;

    // Характерные маркеры кода HH Apply Assistant
    const assistantMarkers = [
        'HH Apply Assistant', 'hh_apply_assistant_', 'startLoop', 'processVacancy', 'applyToVacancy',
        'realisticClick', 'fillCoverLetter', 'checkResponseTrap', 'watchdogTick',
        'setupUI', 'PanelController', 'WorkModeSlider', 'DiagnosticsView', 'DiagLog', 'interruptibleWait', 'fnv1a32', 'buildPanelHtml',
        'exportManualListHtml', 'runHealthCheck'
    ];
    return assistantMarkers.some(m => combined.includes(m));
}

addRuntimeListener(typeof window !== 'undefined' ? window : null, 'error', (e: any) => {
    try {
        const isInternal = isHHApplyAssistantError(e, false);
        const where = e.filename ? ` @ ${e.filename}:${e.lineno || 0}:${e.colno || 0}` : '';
        if (isInternal) {
            if (assistantErrCount >= ASSISTANT_ERR_LIMIT) return;
            assistantErrCount++;
            log(I18n.t('logs.jsError', { msg: e.message || 'Error', where }), true);
        } else {
            if (externalErrCount >= EXTERNAL_ERR_LIMIT) return;
            externalErrCount++;
            DiagLog.push(`[External hh.ru error]: ${(e.message || 'Error').slice(0, 300)}${where}`, false);
            console.warn('[HH Apply Assistant] External hh.ru error:', e.message, where);
        }
    } catch (_) { /* ignore */ }
});

addRuntimeListener(typeof window !== 'undefined' ? window : null, 'unhandledrejection', (e: any) => {
    try {
        const isInternal = isHHApplyAssistantError(e, true);
        const r = e.reason;
        const text = r && (r.stack || r.message) ? (r.stack || r.message) : String(r);
        if (isInternal) {
            if (assistantErrCount >= ASSISTANT_ERR_LIMIT) return;
            assistantErrCount++;
            log(I18n.t('logs.unhandledRejection', { msg: String(text).slice(0, 500) }), true);
        } else {
            if (externalErrCount >= EXTERNAL_ERR_LIMIT) return;
            externalErrCount++;
            DiagLog.push(`[External unhandled rejection]: ${String(text).slice(0, 300)}`, false);
            console.warn('[HH Apply Assistant] External unhandled rejection hh.ru:', text);
        }
    } catch (_) { /* ignore */ }
});

ensureCurrentRunLimit();

// Отметка загрузки каждой страницы - по ней в логе видна вся последовательность навигаций.
log(I18n.t('logs.pageLoad', {
    path: (typeof location !== 'undefined' ? location.pathname + location.search : ''),
    running: State.amIRunning(),
    sent: State.getSentCount(),
    limit: config.limit
}));

// При восстановлении страницы из bfcache возвращается старый JS runtime со старым
// leaseId. Новый startLoop синхронно меняет runId до первого await и получает новое
// поколение lease, поэтому continuations замороженной страницы не могут продолжиться.
addRuntimeListener(window, 'pageshow', (event: any) => {
    if (!event.persisted || !State.amIRunning()) return;
    if (activeAbortController) {
        try { activeAbortController.abort(); } catch (e) {}
    }
    setLoopActive(false);
    setHandlingResponsePage(false);
    startLoop();
});

// Очищаем instance lock при закрытии вкладки - но только когда прогон не активен:
// прогон живёт через полные навигации (список → вакансия → список), и лок должен
// переживать их до авто-возобновления (1.5 с в bootstrap), иначе другая вкладка
// успеет захватить его в этом окне. Мёртвые вкладки, закрытые посреди прогона,
// освобождаются по TTL (TUNING.instanceLockTtl).
addRuntimeListener(window, 'beforeunload', () => {
    DiagLog.flush();
    Metrics.flush();
    if (!State.amIRunning()) State.releaseInstanceLock(TAB_ID);
});
addRuntimeListener(window, 'pagehide', () => {
    DiagLog.flush();
    Metrics.flush();
});
addRuntimeListener(window, 'unload', () => {
    DiagLog.flush();
    Metrics.flush();
    if (!State.amIRunning()) State.releaseInstanceLock(TAB_ID);
});

startWatchdog();

function bootstrap(): void {
    I18n.init();
    PanelController.mount();
    if (resumeTimer) { clearTimeout(resumeTimer); setResumeTimer(null); }
    // Авто-возобновление, если скрипт был в работе перед перезагрузкой.
    // Условие перепроверяется В МОМЕНТ срабатывания таймера: если пользователь успел
    // нажать Стоп в эти 1.5 секунды, отложенный startLoop не должен воскресить
    // прогон (State.setRunning(false) уже снят, и стартовать нечего).
    if (State.amIRunning()) {
        log(I18n.t('logs.autoResumeFound'));
        setStatus('running', 'status.autoStarting');
        const timer = setTimeout(() => {
            setResumeTimer(null);
            if (State.amIRunning()) {
                if (Page.isResponseForm()) {
                    log(I18n.t('logs.onResponsePage'));
                    return;
                }
                startLoop();
            } else {
                log(I18n.t('logs.autoResumeCanceled'));
            }
        }, 1500);
        setResumeTimer(timer);
    }
    // Сбрасываем ловушку только если мы не на странице отклика/вопросов
    if (!Page.isResponseForm()) {
        State.clearTrapLock();
    }
}

// document-idle обычно означает готовый body, но перестрахуемся:
// если body ещё нет - дожидаемся его через MutationObserver.
if (typeof document !== 'undefined' && document.body) {
    bootstrap();
} else if (typeof document !== 'undefined') {
    const domReadyObserver = new MutationObserver((_mutations, obs) => {
        if (document.body) {
            obs.disconnect();
            runtimeRecord.domReadyObserver = null;
            bootstrap();
        }
    });
    runtimeRecord.domReadyObserver = domReadyObserver;
    domReadyObserver.observe(document.documentElement, { childList: true, subtree: true });
}
