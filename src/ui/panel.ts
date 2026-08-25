import { I18n, PRESETS, DEFAULT_PRESET, modeKeyToIndex, presetLabel } from '../i18n/index.js';
import { State, config, Settings, persistSettings, restoreStatusAfterMount, Metrics, Stats, log } from '../core/state-manager.js';
import { storage, KEYS } from '../storage/storage-service.js';
import { startLoop, stopRun } from '../core/automation-engine.js';
import { uiIcon } from './icons.js';
import { injectPanelStyles } from './styles.js';
import { HostLayoutReservation } from './layout.js';
import { AutosaveFeedback } from './autosave.js';
import { HelpPopoverController } from './help.js';
import { WorkModeSlider } from './slider.js';
import { LocalizationBinder } from './localization-binder.js';
import { DiagnosticsView } from './diagnostics.js';
import { StatsView } from './stats.js';
import { ManualQueueView } from './queue.js';
import type { DockingState } from '../types/index.js';

export function buildPanelHtml(): string {
    const lang = I18n.getLanguage();
    const curPreset = (PRESETS as any)[config.preset] ? config.preset : DEFAULT_PRESET;
    const curIndex = modeKeyToIndex(curPreset);
    const curLabel = presetLabel(curPreset);
    const sentCount = State.getSentCount();
    const effectiveLimit = Math.max(config.limit, sentCount);

    return `
        <div id="ar-view-main" class="ar-view ar-view--main">
            <div class="ar-header">
                <div class="ar-brand">
                    <span class="ar-title">HH Apply Assistant</span>
                </div>
                <div class="ar-header-right">
                    <div class="ar-lang-switcher" role="group" aria-label="${I18n.t('panel.langSwitchLabel')}">
                        <button type="button" class="ar-lang-btn${lang === 'ru' ? ' is-active' : ''}" data-lang="ru" aria-pressed="${lang === 'ru'}">RU</button>
                        <span class="ar-lang-sep" aria-hidden="true">|</span>
                        <button type="button" class="ar-lang-btn${lang === 'en' ? ' is-active' : ''}" data-lang="en" aria-pressed="${lang === 'en'}">EN</button>
                    </div>
                    <button id="ar-minimize-btn" class="ar-header-action ar-icon-only" title="${I18n.t('panel.minimizeTitle')}" aria-label="${I18n.t('panel.minimizeTitle')}">${uiIcon('chevronDown')}</button>
                </div>
            </div>

            <div class="ar-scroll ar-scroll--content">
                <section class="ar-card ar-card--settings">
                    <label class="ar-switch-row" for="ar-use-cover-check">
                        <span class="ar-card-title" id="ar-cover-card-title" style="margin:0;">${I18n.t('cover.title')}</span>
                        <span class="ar-switch"><input type="checkbox" id="ar-use-cover-check"><i></i></span>
                    </label>
                    <div class="ar-cover-editor">
                        <textarea id="ar-cover-text" class="ar-textarea" rows="3" maxlength="5000" aria-labelledby="ar-cover-card-title" placeholder="${I18n.t('cover.placeholder')}"></textarea>
                        <span id="ar-cover-counter" class="ar-cover-counter">0 / 5000</span>
                    </div>
                    <div class="ar-switch-row ar-switch-row-sub" id="ar-apply-reject-wrap">
                        <span class="ar-setting-label-group">
                            <label class="ar-row-label" id="ar-apply-reject-label" for="ar-apply-reject-check">${I18n.t('cover.rejectWarningLabel')}</label>
                            <span class="ar-help-wrap ar-warning-help-wrap" id="ar-warning-help-wrap">
                                <button class="ar-help-button ar-icon-only" id="ar-warning-help-btn" type="button" aria-label="${I18n.t('cover.rejectWarningHelpAria')}" aria-describedby="ar-warning-help-popover" aria-controls="ar-warning-help-popover" aria-expanded="false">${uiIcon('help')}</button>
                                <span class="ar-help-popover" id="ar-warning-help-popover" role="tooltip" aria-hidden="true">
                                    <strong class="ar-help-popover-title" id="ar-warning-help-title">${I18n.t('cover.rejectWarningHelpTitle')}</strong>
                                    <span class="ar-help-popover-copy" id="ar-warning-help-text">${I18n.t('cover.rejectWarningHelpText')}</span>
                                </span>
                            </span>
                        </span>
                        <label class="ar-switch" for="ar-apply-reject-check"><input type="checkbox" id="ar-apply-reject-check"><i></i></label>
                    </div>
                    <div class="ar-autosave-feedback" id="ar-autosave-feedback" role="status" aria-live="polite">
                        <span id="ar-autosave-text">${I18n.t('panel.autosaveIdle')}</span>
                    </div>
                </section>

                <section class="ar-card ar-card--stats" aria-labelledby="ar-stats-card-title">
                    <span class="ar-card-title ar-sr-only" id="ar-stats-card-title">${I18n.t('panel.statsTitle')}</span>
                    <div class="ar-stats">
                        <div class="ar-stat" id="ar-stat-tile-attempts">
                            <span class="ar-stat-num" id="ar-stat-attempts">0</span>
                            <span class="ar-stat-cap" id="ar-stat-cap-attempts">${I18n.t('panel.statAttempts')}</span>
                        </div>
                        <div class="ar-stat" id="ar-stat-tile-success">
                            <span class="ar-stat-num" id="ar-stat-success">0</span>
                            <span class="ar-stat-cap" id="ar-stat-cap-success">${I18n.t('panel.statSuccess')}</span>
                        </div>
                        <div class="ar-stat" id="ar-stat-tile-manual">
                            <span class="ar-stat-num" id="ar-stat-manual">0</span>
                            <span class="ar-stat-cap" id="ar-stat-cap-manual">${I18n.t('panel.statManual')}</span>
                        </div>
                        <div class="ar-stat" id="ar-stat-tile-skip">
                            <span class="ar-stat-num" id="ar-stat-skipped">0</span>
                            <span class="ar-stat-cap" id="ar-stat-cap-skipped">${I18n.t('panel.statSkipped')}</span>
                        </div>
                    </div>
                </section>

                <section class="ar-card ar-card--manual">
                    <div class="ar-card-head">
                        <div class="ar-title-with-count">
                            <span class="ar-card-title" id="ar-manual-card-title">${I18n.t('panel.manualTitle')}</span>
                            <span id="ar-manual-count" class="ar-badge" data-has="0" title="${I18n.t('panel.manualCountTitle')}">0</span>
                        </div>
                        <div class="ar-manual-toolbar">
                            <button id="ar-export-manual" class="ar-btn ar-btn-soft ar-btn-sm">${I18n.t('panel.manualExport')}</button>
                            <button id="ar-clear-manual" class="ar-btn ar-btn-soft ar-btn-sm">${I18n.t('panel.manualClear')}</button>
                        </div>
                    </div>
                    <div id="ar-manual-list" class="ar-manual"></div>
                </section>
            </div>

            <div class="ar-execution-shell">
                <section class="ar-card ar-work-mode-card ar-execution-core" id="ar-mode-card" data-mode="${curPreset}" data-runtime-state="idle">
                    <div class="ar-work-mode-header">
                        <div class="ar-work-mode-title" id="ar-work-mode-heading">
                            <span class="ar-work-mode-title__label" id="ar-work-mode-label">${I18n.t('panel.modeTitle')}</span>
                        </div>
                        <div class="ar-help-wrap ar-work-mode-help-wrap" id="ar-work-mode-help-wrap">
                            <button
                                class="ar-help-button ar-icon-only"
                                id="ar-work-mode-help-btn"
                                type="button"
                                aria-label="${I18n.t('panel.modeHelpAria')}"
                                aria-describedby="ar-work-mode-popover"
                                aria-controls="ar-work-mode-popover"
                                aria-expanded="false"
                            >${uiIcon('help')}</button>
                            <div class="ar-help-popover ar-work-mode-popover" id="ar-work-mode-popover" role="tooltip" aria-hidden="true">
                                <strong class="ar-help-popover-title" id="ar-mode-help-title">${I18n.t('panel.modeHelpTitle')}</strong>
                                <div class="ar-mode-help-item">
                                    <strong class="ar-mode-help-name" id="ar-mode-help-safe-title">${I18n.t('panel.modeHelpSafeTitle')}</strong>
                                    <span class="ar-mode-help-copy" id="ar-mode-help-safe-text">${I18n.t('panel.modeHelpSafeText')}</span>
                                </div>
                                <div class="ar-mode-help-item">
                                    <strong class="ar-mode-help-name" id="ar-mode-help-balanced-title">${I18n.t('panel.modeHelpBalancedTitle')}</strong>
                                    <span class="ar-mode-help-copy" id="ar-mode-help-balanced-text">${I18n.t('panel.modeHelpBalancedText')}</span>
                                </div>
                                <div class="ar-mode-help-item">
                                    <strong class="ar-mode-help-name" id="ar-mode-help-fast-title">${I18n.t('panel.modeHelpFastTitle')}</strong>
                                    <span class="ar-mode-help-copy" id="ar-mode-help-fast-text">${I18n.t('panel.modeHelpFastText')}</span>
                                </div>
                                <div class="ar-mode-help-item ar-mode-help-item--turbo">
                                    <strong class="ar-mode-help-name" id="ar-mode-help-turbo-title">${I18n.t('panel.modeHelpTurboTitle')}</strong>
                                    <span class="ar-mode-help-copy" id="ar-mode-help-turbo-text">${I18n.t('panel.modeHelpTurboText')}</span>
                                </div>
                                <span class="ar-mode-help-note" id="ar-mode-help-note">${I18n.t('panel.modeHelpNote')}</span>
                            </div>
                        </div>
                    </div>

                    <div
                        class="ar-work-mode-slider${curPreset === 'turbo' ? ' is-turbo' : ''}"
                        id="ar-work-mode-slider"
                        role="slider"
                        tabindex="0"
                        aria-label="${I18n.t('panel.modeTitle')}"
                        aria-valuemin="0"
                        aria-valuemax="3"
                        aria-valuenow="${curIndex}"
                        aria-valuetext="${curLabel}"
                        data-value="${curIndex}"
                    >
                        <div class="ar-work-mode-turbo-surface" aria-hidden="true"></div>
                        <div class="ar-work-mode-grid-mask" aria-hidden="true">
                            <div class="ar-work-mode-grid-strip" id="ar-work-mode-grid-strip"></div>
                        </div>
                        <div class="ar-work-mode-snap-markers" id="ar-work-mode-snap-markers" aria-hidden="true">
                            <span class="ar-work-mode-snap-marker"></span>
                            <span class="ar-work-mode-snap-marker"></span>
                            <span class="ar-work-mode-snap-marker"></span>
                            <span class="ar-work-mode-snap-marker"></span>
                        </div>
                        <div class="ar-work-mode-thumb" id="ar-work-mode-thumb" aria-hidden="true">
                            <div class="ar-work-mode-thumb__shadow" id="ar-work-mode-thumb-shadow" aria-hidden="true"></div>
                            <div class="ar-work-mode-thumb__body" id="ar-work-mode-thumb-body" aria-hidden="true"></div>
                        </div>
                    </div>

                    <div class="ar-work-mode-options" aria-hidden="true">
                        <span class="ar-work-mode-option${curPreset === 'safe' ? ' is-active' : ''}" id="ar-work-mode-option-safe" data-mode="safe">${I18n.t('presets.safe.label')}</span>
                        <span class="ar-work-mode-option${curPreset === 'balanced' ? ' is-active' : ''}" id="ar-work-mode-option-balanced" data-mode="balanced">${I18n.t('presets.balanced.label')}</span>
                        <span class="ar-work-mode-option${curPreset === 'fast' ? ' is-active' : ''}" id="ar-work-mode-option-fast" data-mode="fast">${I18n.t('presets.fast.label')}</span>
                        <span class="ar-work-mode-option${curPreset === 'turbo' ? ' is-active' : ''}" id="ar-work-mode-option-turbo" data-mode="turbo">${I18n.t('presets.turbo.label')}</span>
                    </div>

                    <div class="ar-execution-meta">
                        <div class="ar-execution-runtime">
                            <span id="ar-status-text" class="ar-status ar-status--idle" role="status">${I18n.t('status.idle')}</span>
                            <span id="ar-stat-progress" class="ar-badge ar-execution-count" title="${I18n.t('panel.statsProgressTitle')}">${sentCount} / ${effectiveLimit}</span>
                        </div>
                        <div class="ar-row ar-row-limit ar-execution-limit">
                            <label class="ar-row-label" id="ar-limit-label" for="ar-limit-input" title="${I18n.t('panel.limitLabel')}">${I18n.t('panel.limitShort')}</label>
                            <input type="number" id="ar-limit-input" class="ar-input ar-input-num" min="${Math.max(1, sentCount)}" max="500">
                        </div>
                    </div>
                    <div id="ar-execution-progress" class="ar-progress ar-execution-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${effectiveLimit}" aria-valuenow="${sentCount}" aria-label="${I18n.t('panel.statsProgressTitle')}"><i id="ar-progress-fill" aria-hidden="true"></i></div>

                    <div class="ar-execution-actions">
                        <button id="ar-start-btn" class="ar-btn ar-btn-primary ar-btn-cta">
                            <span id="ar-start-btn-text">${I18n.t('panel.startBtn')}</span>
                        </button>
                        <button id="ar-stop-btn" class="ar-btn ar-btn-danger ar-btn-cta" style="display:none;">
                            <span id="ar-stop-btn-text">${I18n.t('panel.stopBtn')}</span>
                        </button>
                        <div class="ar-util-row ar-execution-utils">
                            <button id="ar-reset-history" class="ar-btn ar-btn-tertiary ar-btn-sm ar-util-btn" title="${I18n.t('panel.resetHistoryTitle')}">
                                <span id="ar-reset-history-text">${I18n.t('panel.resetHistory')}</span>
                            </button>
                            <button id="ar-health-btn" class="ar-btn ar-btn-soft ar-btn-sm ar-util-btn" title="${I18n.t('panel.diagnosticsTitle')}">
                                <span id="ar-health-btn-text">${I18n.t('panel.diagnostics')}</span>
                                <span id="ar-health-badge" class="ar-badge-count" style="display:none;"></span>
                            </button>
                        </div>
                    </div>
                </section>
            </div>
        </div>

        <div id="ar-view-diag" class="ar-view ar-view--diag" style="display:none;">
            <div class="ar-header ar-diag-header">
                <div class="ar-diag-nav">
                    <button id="ar-diag-back-btn" class="ar-btn ar-btn-soft ar-btn-sm ar-btn-back" type="button" title="${I18n.t('diag.backTitle')}">
                        ${uiIcon('arrowLeft')}
                        <span id="ar-diag-back-text">${I18n.t('diag.backBtn')}</span>
                    </button>
                    <span class="ar-diag-view-title" id="ar-diag-view-title">${I18n.t('diag.title')}</span>
                </div>
                <div class="ar-header-right ar-diag-header-actions">
                    <button id="ar-minimize-diag-btn" class="ar-header-action ar-icon-only" title="${I18n.t('panel.minimizeTitle')}" aria-label="${I18n.t('panel.minimizeTitle')}">${uiIcon('chevronDown')}</button>
                </div>
            </div>
            <div class="ar-diag-body">
                <div class="ar-diag-filter-row">
                    <div id="ar-diag-filter-group" class="ar-diag-filter-group" role="group" aria-label="${I18n.t('diag.filterLabel')}">
                        <button id="ar-diag-filter-all" class="ar-diag-filter-btn is-active" type="button" aria-pressed="true">
                            <span id="ar-diag-filter-all-text">${I18n.t('diag.filterAll')}</span>
                            <span id="ar-diag-filter-all-count" class="ar-diag-filter-count">0</span>
                        </button>
                        <button id="ar-diag-filter-errors" class="ar-diag-filter-btn" type="button" aria-pressed="false">
                            <span id="ar-diag-filter-errors-text">${I18n.t('diag.filterErrors')}</span>
                            <span id="ar-diag-filter-errors-count" class="ar-diag-filter-count">0</span>
                        </button>
                    </div>
                    <div class="ar-diag-search-wrap">
                        <span class="ar-diag-search-icon" aria-hidden="true">${uiIcon('search')}</span>
                        <input id="ar-diag-search" class="ar-diag-search" type="search" autocomplete="off" spellcheck="false" placeholder="${I18n.t('diag.searchPlaceholder')}" aria-label="${I18n.t('diag.searchLabel')}">
                        <button id="ar-diag-search-clear" class="ar-diag-search-clear ar-icon-only" type="button" title="${I18n.t('diag.clearSearch')}" aria-label="${I18n.t('diag.clearSearch')}" hidden>${uiIcon('close')}</button>
                    </div>
                </div>
                <div class="ar-diag-toolbar">
                    <div class="ar-diag-check-zone">
                        <button id="ar-diag-full-check" class="ar-btn ar-btn-soft ar-btn-sm ar-diag-check-btn" type="button" title="${I18n.t('diag.checkSelectors')}">${I18n.t('diag.checkSelectors')}</button>
                        <span id="ar-diag-check-status" class="ar-diag-check-status" aria-live="polite">${I18n.t('diag.checkSummaryIdle')}</span>
                    </div>
                    <label class="ar-diag-autoscroll ar-switch-row" for="ar-diag-auto-scroll">
                        <span class="ar-switch">
                            <input type="checkbox" id="ar-diag-auto-scroll" checked>
                            <i aria-hidden="true"></i>
                        </span>
                        <span id="ar-diag-auto-scroll-text">${I18n.t('diag.autoScroll')}</span>
                    </label>
                </div>
                <div id="ar-diag-full-box" class="ar-diag-full-box" role="log" aria-live="off" tabindex="0"></div>
                <div class="ar-diag-footer-actions">
                    <button id="ar-diag-full-save" class="ar-btn ar-btn-soft ar-btn-sm ar-diag-save-btn" type="button" title="${I18n.t('diag.downloadLogTitle')}">${I18n.t('diag.downloadLog')}</button>
                    <div class="ar-dropdown ar-diag-full-dropdown" id="ar-diag-full-dropdown">
                        <button id="ar-diag-full-more-btn" class="ar-btn ar-btn-soft ar-btn-sm ar-diag-more-btn" type="button" title="${I18n.t('diag.moreTitle')}" aria-label="${I18n.t('diag.moreTitle')}" aria-haspopup="menu" aria-expanded="false" aria-controls="ar-diag-full-menu">
                            <span id="ar-diag-more-text">${I18n.t('diag.moreBtn')}</span>
                        </button>
                        <div class="ar-dropdown-menu" id="ar-diag-full-menu" role="menu">
                            <button id="ar-diag-full-clear-box" class="ar-dropdown-item" type="button" role="menuitem">${I18n.t('diag.clearView')}</button>
                            <button id="ar-diag-full-clear-all" class="ar-dropdown-item ar-dropdown-item--danger" type="button" role="menuitem">${I18n.t('diag.clearAll')}</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

let uiAbortController: AbortController | null = null;

export function cleanupUI(): void {
    if (typeof document === 'undefined') return;
    HostLayoutReservation.destroy();
    WorkModeSlider.destroy();
    AutosaveFeedback.destroy();
    LocalizationBinder.destroy();
    DiagnosticsView.destroy();
    StatsView.destroy();
    ManualQueueView.destroy();
    if (uiAbortController) {
        try { uiAbortController.abort(); } catch (e) { /* ignore */ }
        uiAbortController = null;
    }
    const oldToggle = document.getElementById('ar-toggle-btn');
    if (oldToggle) oldToggle.remove();
    const oldPanel = document.getElementById('ar-main-panel');
    if (oldPanel) oldPanel.remove();
    document.documentElement.classList.remove('hha-docked');
}

export function setupUI(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById('ar-main-panel')) return;
    if (!document.body) return;

    cleanupUI();
    uiAbortController = new AbortController();
    const uiSignal = uiAbortController.signal;

    injectPanelStyles();

    const lang = I18n.getLanguage();

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'ar-toggle-btn';
    toggleBtn.type = 'button';
    toggleBtn.setAttribute('lang', lang);
    toggleBtn.innerHTML = '<span class="ar-tab-text">Apply Assistant</span>';
    toggleBtn.title = I18n.t('panel.expandTitle');
    toggleBtn.setAttribute('aria-label', I18n.t('panel.expandTitle'));
    toggleBtn.style.display = 'none';
    document.body.appendChild(toggleBtn);

    const panel = document.createElement('div');
    panel.id = 'ar-main-panel';
    panel.setAttribute('lang', lang);
    panel.innerHTML = buildPanelHtml();
    document.body.appendChild(panel);

    const el = (id: string): any => document.getElementById(id);

    el('ar-cover-text').value = config.coverText;
    el('ar-use-cover-check').checked = config.useCover;
    el('ar-apply-reject-check').checked = config.applyOnRejectWarning;
    el('ar-limit-input').min = String(Math.max(1, State.getSentCount()));
    el('ar-limit-input').value = config.limit;
    restoreStatusAfterMount();

    const coverArea = el('ar-cover-text') as HTMLTextAreaElement | null;
    const coverCounter = el('ar-cover-counter');
    const renderCoverState = () => {
        const on = (el('ar-use-cover-check') as HTMLInputElement | null)?.checked ?? false;
        if (coverArea) coverArea.disabled = !on;
        if (coverCounter && coverArea) {
            const len = (coverArea.value || '').length;
            coverCounter.textContent = `${len} / 5000`;
            coverCounter.classList.toggle('is-near', len >= 4800);
            coverCounter.classList.toggle('is-off', !on);
        }
    };
    coverArea?.addEventListener('input', renderCoverState, { signal: uiSignal });
    el('ar-use-cover-check')?.addEventListener('change', renderCoverState, { signal: uiSignal });
    renderCoverState();

    WorkModeSlider.mount({ el, uiSignal });
    AutosaveFeedback.mount({ el });
    HelpPopoverController.mount({ panel, uiSignal });

    const saveSettings = () => {
        const nextConfig = Settings.normalize({
            ...config,
            coverText: (el('ar-cover-text') as HTMLTextAreaElement | null)?.value ?? '',
            useCover: (el('ar-use-cover-check') as HTMLInputElement | null)?.checked ?? false,
            applyOnRejectWarning: (el('ar-apply-reject-check') as HTMLInputElement | null)?.checked ?? false,
            limit: Math.max(Number((el('ar-limit-input') as HTMLInputElement | null)?.value) || 1, State.getSentCount())
        });
        if (!persistSettings(nextConfig)) {
            el('ar-cover-text').value = config.coverText;
            el('ar-use-cover-check').checked = config.useCover;
            el('ar-apply-reject-check').checked = config.applyOnRejectWarning;
            el('ar-limit-input').value = config.limit;
            renderCoverState();
            return;
        }
        el('ar-limit-input').min = String(Math.max(1, State.getSentCount()));
        el('ar-limit-input').value = config.limit;
        StatsView.render();
        AutosaveFeedback.showSaved();
        log(I18n.t('logs.settingsSaved'));
    };
    ['ar-cover-text', 'ar-use-cover-check', 'ar-apply-reject-check', 'ar-limit-input']
        .forEach(id => { const node = el(id); if (node) node.addEventListener('change', saveSettings, { signal: uiSignal }); });

    DiagnosticsView.mount({ el, uiSignal });
    ManualQueueView.mount({ el });
    StatsView.mount();
    LocalizationBinder.mount({ el, panel, uiSignal });

    const startBtn = el('ar-start-btn');
    if (startBtn) startBtn.onclick = () => { startLoop(); };
    const stopBtn = el('ar-stop-btn');
    if (stopBtn) stopBtn.onclick = () => { stopRun(); };

    const resetHistoryBtn = el('ar-reset-history');
    if (resetHistoryBtn) {
        resetHistoryBtn.onclick = () => {
            if (confirm(I18n.t('confirm.resetHistory'))) {
                const historyCleared = State.clearProcessedIDs();
                const sentCleared = State.resetSentCount();
                if (!historyCleared || !sentCleared) {
                    Metrics.bump('storage.history.reset.failed');
                    log('[CRITICAL_STORAGE_WRITE_FAILED] processed_ids/sent_count: reset', true);
                    return;
                }
                Stats.reset();
                StatsView.render();
                log(I18n.t('logs.historyReset'));
            }
        };
    }

    let manualOpen = storage.localGet(KEYS.uiOpen) !== '0';
    let overlayOpen = false;
    let responsiveLayout: DockingState | null = null;
    let focusBeforeCollapse: HTMLElement | null = null;

    const renderResponsiveVisibility = () => {
        const isOverlay = responsiveLayout?.mode === 'overlay';
        const isVisible = isOverlay ? overlayOpen : manualOpen;
        panel.style.display = isVisible ? 'flex' : 'none';
        toggleBtn.style.display = isVisible ? 'none' : 'flex';
        document.documentElement.classList.toggle('hha-overlay-open', Boolean(isOverlay && isVisible));
        HostLayoutReservation.setPanelVisible(isVisible);
        WorkModeSlider.onVisibilityChange(isVisible);
        DiagnosticsView.onVisibilityChange();
    };

    const minimizePanel = () => {
        const activeElement = document.activeElement as HTMLElement | null;
        if (activeElement && panel.contains(activeElement)) focusBeforeCollapse = activeElement;
        if (responsiveLayout?.mode === 'overlay') {
            overlayOpen = false;
        } else {
            manualOpen = false;
            storage.localSet(KEYS.uiOpen, '0');
        }
        renderResponsiveVisibility();
        if (focusBeforeCollapse) toggleBtn.focus();
    };

    const expandPanel = () => {
        if (responsiveLayout?.mode === 'overlay') {
            overlayOpen = true;
        } else {
            manualOpen = true;
            storage.localSet(KEYS.uiOpen, '1');
        }
        renderResponsiveVisibility();
        const diagnosticsOpen = el('ar-view-diag')?.style.display !== 'none';
        const candidate = focusBeforeCollapse;
        const candidateView = candidate?.closest?.('.ar-view') as HTMLElement | null;
        const canRestore = Boolean(candidate
            && candidate.isConnected
            && panel.contains(candidate)
            && !(candidate as any).disabled
            && candidateView?.style.display !== 'none');
        const fallback = diagnosticsOpen
            ? el('ar-diag-back-btn')
            : panel.querySelector<HTMLElement>('.ar-lang-btn.is-active, #ar-use-cover-check');
        (canRestore ? candidate : fallback)?.focus();
        focusBeforeCollapse = null;
    };

    const minBtn = el('ar-minimize-btn');
    if (minBtn) minBtn.onclick = minimizePanel;
    const minDiagBtn = el('ar-minimize-diag-btn');
    if (minDiagBtn) minDiagBtn.onclick = minimizePanel;
    toggleBtn.onclick = expandPanel;

    responsiveLayout = HostLayoutReservation.mount(panel, uiSignal, (nextLayout, previousLayout) => {
        if (!previousLayout || nextLayout.mode !== previousLayout.mode) overlayOpen = false;
        responsiveLayout = nextLayout;
        renderResponsiveVisibility();
    });
    renderResponsiveVisibility();
}

export const PanelController = {
    mount: setupUI,
    destroy: cleanupUI
};
