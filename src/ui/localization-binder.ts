import { qa } from '../dom/dom-adapter.js';
import { I18n, PRESETS, DEFAULT_PRESET, presetLabel } from '../i18n/index.js';
import { uiIcon } from './icons.js';
import { config, currentStatusState, setStatus, log, syncCollapsedToggleState } from '../core/state-manager.js';
import { AutosaveFeedback } from './autosave.js';
import { StatsView } from './stats.js';
import { ManualQueueView } from './queue.js';
import { DiagnosticsView } from './diagnostics.js';

export const LocalizationBinder = (() => {
    let el: ((id: string) => HTMLElement | null) | null = null;
    let panel: HTMLElement | null = null;

    const textBindings = [
        ['ar-work-mode-label', 'panel.modeTitle'],
        ['ar-work-mode-option-safe', 'presets.safe.label'],
        ['ar-work-mode-option-balanced', 'presets.balanced.label'],
        ['ar-work-mode-option-fast', 'presets.fast.label'],
        ['ar-work-mode-option-turbo', 'presets.turbo.label'],
        ['ar-mode-help-title', 'panel.modeHelpTitle'],
        ['ar-mode-help-safe-title', 'panel.modeHelpSafeTitle'],
        ['ar-mode-help-safe-text', 'panel.modeHelpSafeText'],
        ['ar-mode-help-balanced-title', 'panel.modeHelpBalancedTitle'],
        ['ar-mode-help-balanced-text', 'panel.modeHelpBalancedText'],
        ['ar-mode-help-fast-title', 'panel.modeHelpFastTitle'],
        ['ar-mode-help-fast-text', 'panel.modeHelpFastText'],
        ['ar-mode-help-turbo-title', 'panel.modeHelpTurboTitle'],
        ['ar-mode-help-turbo-text', 'panel.modeHelpTurboText'],
        ['ar-mode-help-note', 'panel.modeHelpNote'],
        ['ar-limit-label', 'panel.limitShort'],
        ['ar-cover-card-title', 'cover.title'],
        ['ar-apply-reject-label', 'cover.rejectWarningLabel'],
        ['ar-warning-help-title', 'cover.rejectWarningHelpTitle'],
        ['ar-warning-help-text', 'cover.rejectWarningHelpText'],
        ['ar-start-btn-text', 'panel.startBtn'],
        ['ar-stop-btn-text', 'panel.stopBtn'],
        ['ar-reset-history-text', 'panel.resetHistory'],
        ['ar-health-btn-text', 'panel.diagnostics'],
        ['ar-stats-card-title', 'panel.statsTitle'],
        ['ar-stat-cap-attempts', 'panel.statAttempts'],
        ['ar-stat-cap-success', 'panel.statSuccess'],
        ['ar-stat-cap-manual', 'panel.statManual'],
        ['ar-stat-cap-skipped', 'panel.statSkipped'],
        ['ar-manual-card-title', 'panel.manualTitle'],
        ['ar-export-manual', 'panel.manualExport'],
        ['ar-clear-manual', 'panel.manualClear'],
        ['ar-diag-back-text', 'diag.backBtn'],
        ['ar-diag-view-title', 'diag.title'],
        ['ar-diag-full-save', 'diag.downloadLog'],
        ['ar-diag-full-check', 'diag.checkSelectors'],
        ['ar-diag-filter-all-text', 'diag.filterAll'],
        ['ar-diag-filter-errors-text', 'diag.filterErrors'],
        ['ar-diag-auto-scroll-text', 'diag.autoScroll'],
        ['ar-diag-more-text', 'diag.moreBtn'],
        ['ar-diag-full-clear-box', 'diag.clearView'],
        ['ar-diag-full-clear-all', 'diag.clearAll']
    ];

    const titleBindings = [
        ['ar-limit-label', 'panel.limitLabel'],
        ['ar-reset-history', 'panel.resetHistoryTitle'],
        ['ar-health-btn', 'panel.diagnosticsTitle'],
        ['ar-stat-progress', 'panel.statsProgressTitle'],
        ['ar-manual-count', 'panel.manualCountTitle'],
        ['ar-diag-back-btn', 'diag.backTitle'],
        ['ar-diag-full-save', 'diag.downloadLogTitle'],
        ['ar-diag-full-check', 'diag.checkSelectors'],
        ['ar-diag-full-more-btn', 'diag.moreTitle']
    ];

    function refresh() {
        if (!el) return;
        const currentLang = I18n.getLanguage();
        const mainPanel = el('ar-main-panel');
        if (mainPanel) mainPanel.setAttribute('lang', currentLang);

        const diagSearch = el('ar-diag-search') as HTMLInputElement | null;
        if (diagSearch) {
            diagSearch.placeholder = I18n.t('diag.searchPlaceholder');
            diagSearch.setAttribute('aria-label', I18n.t('diag.searchLabel'));
        }
        const diagSearchClear = el('ar-diag-search-clear');
        if (diagSearchClear) {
            diagSearchClear.title = I18n.t('diag.clearSearch');
            diagSearchClear.setAttribute('aria-label', I18n.t('diag.clearSearch'));
        }
        const diagFilterGroup = el('ar-diag-filter-group');
        if (diagFilterGroup) diagFilterGroup.setAttribute('aria-label', I18n.t('diag.filterLabel'));
        const diagMore = el('ar-diag-full-more-btn');
        if (diagMore) diagMore.setAttribute('aria-label', I18n.t('diag.moreTitle'));
        const progressbar = el('ar-execution-progress');
        if (progressbar) progressbar.setAttribute('aria-label', I18n.t('panel.statsProgressTitle'));

        const toggle = el('ar-toggle-btn');
        if (toggle) {
            toggle.setAttribute('lang', currentLang);
            syncCollapsedToggleState(toggle);
        }

        if (mainPanel) {
            qa('.ar-lang-btn', mainPanel).forEach(btn => {
                const element = btn as HTMLElement;
                const active = element.dataset.lang === currentLang;
                element.classList.toggle('is-active', active);
                element.setAttribute('aria-pressed', active ? 'true' : 'false');
            });
        }

        for (const [id, key] of textBindings) {
            const node = el(id);
            if (node) node.textContent = I18n.t(key);
        }
        for (const [id, key] of titleBindings) {
            const node = el(id);
            if (node) node.title = I18n.t(key);
        }

        const setIconButton = (id: string, iconName: string, label: string) => {
            const node = el ? el(id) : null;
            if (!node) return;
            node.classList.add('ar-icon-only');
            node.innerHTML = uiIcon(iconName);
            node.title = label;
            node.setAttribute('aria-label', label);
        };

        const minimizeTitle = I18n.t('panel.minimizeTitle');
        setIconButton('ar-minimize-btn', 'chevronDown', minimizeTitle);
        setIconButton('ar-minimize-diag-btn', 'chevronDown', minimizeTitle);
        setIconButton('ar-work-mode-help-btn', 'help', I18n.t('panel.modeHelpAria'));
        setIconButton('ar-warning-help-btn', 'help', I18n.t('cover.rejectWarningHelpAria'));

        const currentPresetKey = (PRESETS as any)[config.preset] ? config.preset : DEFAULT_PRESET;
        const modeLabel = presetLabel(currentPresetKey);

        const slider = el('ar-work-mode-slider');
        if (slider) {
            slider.setAttribute('aria-label', I18n.t('panel.modeTitle'));
            slider.setAttribute('aria-valuetext', modeLabel);
        }
        const help = el('ar-work-mode-help-btn');
        if (help) {
            help.setAttribute('aria-label', I18n.t('panel.modeHelpAria'));
            help.title = I18n.t('panel.modeHelpAria');
        }
        const cover = el('ar-cover-text') as HTMLTextAreaElement | null;
        if (cover) cover.placeholder = I18n.t('cover.placeholder');
        AutosaveFeedback.refresh();

        setStatus(currentStatusState.statusKey, currentStatusState.customKeyOrText, currentStatusState.params);
        StatsView.render();
        ManualQueueView.render();
        DiagnosticsView.refresh();
    }

    function mount({ el: getEl, panel: rootPanel, uiSignal }: { el: (id: string) => HTMLElement | null; panel: HTMLElement; uiSignal: AbortSignal }) {
        el = getEl;
        panel = rootPanel;
        qa('.ar-lang-btn', panel).forEach(btn => {
            (btn as HTMLElement).addEventListener('click', (event: Event) => {
                event.stopPropagation();
                const targetLang = (btn as HTMLElement).dataset.lang as any;
                if (!targetLang || targetLang === I18n.getLanguage()) return;
                I18n.setLanguage(targetLang);
                refresh();
                log(I18n.t('logs.languageSet', { language: I18n.t(`languages.${targetLang}`) }));
            }, { signal: uiSignal });
        });
    }

    function destroy() {
        el = null;
        panel = null;
    }

    return { mount, refresh, destroy };
})();
