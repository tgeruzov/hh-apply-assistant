import { q, isVisible, Page, detectAlreadyApplied, pageLooksLikeTest, query } from '../dom/dom-adapter.js';
import { SELECTORS } from '../dom/selectors.js';
import { storage, KEYS } from '../storage/storage-service.js';
import { State, DiagLog, DiagnosticI18n, Metrics, log } from '../core/state-manager.js';
import { I18n } from '../i18n/index.js';
import { fnv1a32, parseJson } from '../core/utils.js';
import { uiIcon } from './icons.js';
import { WorkModeSlider } from './slider.js';
import { exportDiagnosticReport } from './export.js';

export function isDiagnosticsVisible(): boolean {
    if (typeof document === 'undefined') return false;
    const panel = document.getElementById('ar-main-panel');
    const mainView = document.getElementById('ar-view-main');
    const diagnostics = document.getElementById('ar-view-diag');
    if (!panel || !mainView || !diagnostics || document.hidden) return false;
    if (panel.isConnected === false || mainView.isConnected === false || diagnostics.isConnected === false) return false;
    if (panel.style.display === 'none' || mainView.style.display !== 'none' || diagnostics.style.display === 'none') return false;
    return true;
}

export const DiagnosticsView = (() => {
    let renderImpl: (opts?: { preserveScroll?: boolean }) => void = () => {};
    let updateImpl: (force?: boolean) => void = () => {};
    let cancelScheduledImpl = () => {};
    let cancelSearchDebounceImpl = () => {};
    let onVisibilityChangeImpl = () => {};
    let lastRenderedVersion = -1;
    let lastRenderedLang = '';
    let activeFilter = 'all';
    let searchQuery = '';
    let viewOffset = 0;
    let autoScroll = true;
    let lastCheckSummary = { key: 'diag.checkSummaryIdle', params: {} };
    let diagnosticsDirty = true;
    const expandedGroups = new Set<string>();
    const SEARCH_DEBOUNCE_MS = 140;

    const normalizeSearch = (value: string) => String(value || '').trim().toLocaleLowerCase();

    function groupConsecutive(items: any[]) {
        const groups: any[] = [];
        for (const item of items) {
            const prev = groups[groups.length - 1];
            if (prev && prev.msg === item.msg && prev.lvl === item.lvl) {
                prev.count++;
                prev.endT = item.t || Date.now();
                prev.items.push(item);
            } else {
                groups.push({
                    id: `${item.t || Date.now()}-${fnv1a32(`${item.lvl || 'INFO'}|${item.msg || ''}`).toString(36)}`,
                    msg: item.msg,
                    lvl: item.lvl,
                    startT: item.t || Date.now(),
                    endT: item.t || Date.now(),
                    count: 1,
                    items: [item]
                });
            }
        }
        return groups;
    }

    const getLogGroupChildrenId = (group: any) => `ar-log-group-${group.id}`;

    function buildLogRow(group: any, isExpanded: boolean, onToggle: () => void) {
        const row = document.createElement('div');
        const isErr = group.lvl === 'ERR';
        const isWarn = group.lvl === 'WARN';
        const isOk = group.lvl === 'OK';
        const isGrouped = group.count > 1;
        row.className = 'ar-log-row' +
            (isErr ? ' is-error' : '') +
            (isWarn ? ' is-warning' : '') +
            (isGrouped ? ' is-grouped' : '');

        const time = document.createElement('span');
        time.className = 'ar-log-time';
        if (isGrouped && group.startT !== group.endT) {
            time.textContent = `${I18n.formatTime(group.startT)}–${I18n.formatTime(group.endT)}`;
        } else {
            time.textContent = I18n.formatTime(group.endT);
        }

        const level = document.createElement('span');
        level.className = 'ar-log-level' +
            (isErr ? ' ar-log-level--err' : isWarn ? ' ar-log-level--warn' : isOk ? ' ar-log-level--ok' : '');
        level.textContent = group.lvl || 'INFO';

        const msg = document.createElement('span');
        msg.className = 'ar-log-message';
        msg.textContent = group.msg;

        row.appendChild(time);
        row.appendChild(level);
        row.appendChild(msg);

        if (isGrouped) {
            const actionTitle = I18n.t(isExpanded ? 'diag.repeatCollapse' : 'diag.repeatExpand');
            const badge = document.createElement('button');
            badge.type = 'button';
            badge.className = 'ar-log-repeat';
            badge.textContent = `×${group.count}${isExpanded ? ' ▴' : ' ▾'}`;
            badge.title = actionTitle;
            badge.setAttribute('aria-label', actionTitle);
            badge.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
            badge.setAttribute('aria-controls', getLogGroupChildrenId(group));
            badge.onclick = (e) => {
                e.stopPropagation();
                onToggle();
            };
            row.appendChild(badge);
        }

        return row;
    }

    function mount({ el, uiSignal }: { el: (id: string) => HTMLElement | null; uiSignal: AbortSignal }) {
        cancelScheduledImpl();
        cancelSearchDebounceImpl();
        diagnosticsDirty = true;
        let scheduledRenderId: any = null;
        let scheduledRenderIsRaf = false;
        let searchDebounceTimer: any = 0;

        const cancelScheduledRender = () => {
            if (scheduledRenderId === null) return;
            if (scheduledRenderIsRaf && typeof cancelAnimationFrame === 'function') {
                cancelAnimationFrame(scheduledRenderId);
            } else {
                clearTimeout(scheduledRenderId);
            }
            scheduledRenderId = null;
        };

        const scheduleRender = () => {
            if (scheduledRenderId !== null) return;
            const run = () => {
                scheduledRenderId = null;
                if (diagnosticsDirty && isDiagnosticsVisible()) {
                    renderFullDiag({ preserveScroll: true });
                }
            };
            if (typeof requestAnimationFrame === 'function') {
                scheduledRenderIsRaf = true;
                scheduledRenderId = requestAnimationFrame(run);
            } else {
                scheduledRenderIsRaf = false;
                scheduledRenderId = setTimeout(run, 0);
            }
        };
        cancelScheduledImpl = cancelScheduledRender;

        const cancelSearchDebounce = () => {
            if (!searchDebounceTimer) return;
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = 0;
        };
        cancelSearchDebounceImpl = cancelSearchDebounce;

        const openFullDiag = () => {
            const viewMain = el('ar-view-main');
            const viewDiag = el('ar-view-diag');
            if (!viewMain || !viewDiag) return;
            viewMain.style.display = 'none';
            viewDiag.style.display = 'flex';
            WorkModeSlider.onVisibilityChange(false);
            cancelSearchDebounce();
            renderFullDiag();
            el('ar-diag-back-btn')?.focus();
        };

        const closeFullDiag = () => {
            const viewMain = el('ar-view-main');
            const viewDiag = el('ar-view-diag');
            if (!viewMain || !viewDiag) return;
            cancelScheduledRender();
            cancelSearchDebounce();
            viewDiag.style.display = 'none';
            viewMain.style.display = 'flex';
            el('ar-diag-full-box')?.replaceChildren();
            diagnosticsDirty = true;
            const panelEl = el('ar-main-panel');
            WorkModeSlider.onVisibilityChange(Boolean(panelEl && panelEl.style.display !== 'none' && !document.hidden));
            el('ar-health-btn')?.focus();
        };

        function renderFullDiag({ preserveScroll = false } = {}) {
            cancelScheduledRender();
            if (!isDiagnosticsVisible()) {
                diagnosticsDirty = true;
                return;
            }
            const fullBox = el('ar-diag-full-box');
            if (!fullBox) return;

            const wasAtBottom = Math.abs((fullBox.scrollHeight - fullBox.scrollTop) - fullBox.clientHeight) <= 12;
            const previousScrollTop = fullBox.scrollTop;

            const all = DiagLog.getAll().map(item => ({
                ...item,
                msg: DiagnosticI18n.format(item)
            }));
            const visibleSource = all.slice(Math.min(viewOffset, all.length));
            const filtered = visibleSource.filter(item => {
                if (activeFilter === 'errors' && item.lvl !== 'ERR') return false;
                if (!searchQuery) return true;
                const haystack = normalizeSearch(`${I18n.formatTime(item.t || Date.now())} ${item.lvl || 'INFO'} ${item.msg || ''}`);
                return haystack.includes(searchQuery);
            });
            const groups = groupConsecutive(filtered);

            fullBox.innerHTML = '';

            if (!groups.length) {
                const empty = document.createElement('div');
                empty.className = 'ar-log-empty';
                const emptyTitleKey = activeFilter === 'errors' && !searchQuery ? 'diag.emptyNoErrorsTitle'
                    : searchQuery ? 'diag.noEntries' : 'diag.emptyTitle';
                const emptyHintKey = activeFilter === 'errors' && !searchQuery ? 'diag.emptyNoErrorsHint'
                    : searchQuery ? 'diag.emptySearchHint' : 'diag.emptyHint';
                empty.innerHTML = `
                    <div class="ar-log-empty-inner">
                        <div class="ar-log-empty-icon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                                <circle cx="12" cy="12" r="9"></circle>
                                <line x1="9" y1="10" x2="9.01" y2="10" stroke-width="2.6" stroke-linecap="round"></line>
                                <line x1="15" y1="10" x2="15.01" y2="10" stroke-width="2.6" stroke-linecap="round"></line>
                                <path d="M8 15s1.5 2 4 2 4-2 4-2" stroke-linecap="round"></path>
                            </svg>
                        </div>
                        <div class="ar-log-empty-title">${I18n.t(emptyTitleKey)}</div>
                        <div class="ar-log-empty-hint">${I18n.t(emptyHintKey)}</div>
                    </div>
                `;
                fullBox.appendChild(empty);
            } else {
                const fragment = document.createDocumentFragment();
                groups.forEach(group => {
                    const isExpanded = expandedGroups.has(group.id);
                    const toggleGroup = () => {
                        if (expandedGroups.has(group.id)) {
                            expandedGroups.delete(group.id);
                        } else {
                            expandedGroups.add(group.id);
                        }
                        renderFullDiag({ preserveScroll: true });
                        (fullBox.querySelector(`[aria-controls="${getLogGroupChildrenId(group)}"]`) as HTMLElement)?.focus();
                    };

                    const row = buildLogRow(group, isExpanded, toggleGroup);
                    fragment.appendChild(row);

                    if (group.count > 1 && isExpanded) {
                        const childContainer = document.createElement('div');
                        childContainer.className = 'ar-log-group-children';
                        childContainer.id = getLogGroupChildrenId(group);
                        group.items.forEach((child: any) => {
                            const childRow = document.createElement('div');
                            childRow.className = 'ar-log-child';
                            const childTime = document.createElement('span');
                            childTime.className = 'ar-log-child-time';
                            childTime.textContent = I18n.formatTime(child.t || Date.now());
                            const childMsg = document.createElement('span');
                            childMsg.className = 'ar-log-message';
                            childMsg.textContent = child.msg;
                            childRow.appendChild(childTime);
                            childRow.appendChild(childMsg);
                            childContainer.appendChild(childRow);
                        });
                        fragment.appendChild(childContainer);
                    }
                });
                fullBox.appendChild(fragment);
            }

            if (preserveScroll || !autoScroll) {
                fullBox.scrollTop = previousScrollTop;
            } else if (wasAtBottom || autoScroll) {
                fullBox.scrollTop = fullBox.scrollHeight;
            }

            diagnosticsDirty = false;
        }

        const backBtn = el('ar-diag-back-btn');
        if (backBtn) backBtn.onclick = closeFullDiag;

        const setFilter = (nextFilter: string) => {
            activeFilter = nextFilter === 'errors' ? 'errors' : 'all';
            for (const [id, value] of [['ar-diag-filter-all', 'all'], ['ar-diag-filter-errors', 'errors']]) {
                const button = el(id);
                if (!button) continue;
                const active = activeFilter === value;
                button.classList.toggle('is-active', active);
                button.setAttribute('aria-pressed', active ? 'true' : 'false');
            }
            renderFullDiag();
        };
        el('ar-diag-filter-all')?.addEventListener('click', () => setFilter('all'), { signal: uiSignal });
        el('ar-diag-filter-errors')?.addEventListener('click', () => setFilter('errors'), { signal: uiSignal });

        const searchInput = el('ar-diag-search') as HTMLInputElement | null;
        const searchClear = el('ar-diag-search-clear');
        const syncSearchClear = () => { if (searchClear) searchClear.hidden = !(searchInput?.value || '').length; };
        searchInput?.addEventListener('input', () => {
            searchQuery = normalizeSearch(searchInput.value);
            syncSearchClear();
            diagnosticsDirty = true;
            cancelSearchDebounce();
            searchDebounceTimer = setTimeout(() => {
                searchDebounceTimer = 0;
                renderFullDiag({ preserveScroll: true });
            }, SEARCH_DEBOUNCE_MS);
        }, { signal: uiSignal });
        searchClear?.addEventListener('click', () => {
            if (!searchInput) return;
            cancelSearchDebounce();
            searchInput.value = '';
            searchQuery = '';
            syncSearchClear();
            searchInput.focus();
            renderFullDiag({ preserveScroll: true });
        }, { signal: uiSignal });

        const fullBox = el('ar-diag-full-box');
        const autoScrollInput = el('ar-diag-auto-scroll') as HTMLInputElement | null;
        if (autoScrollInput) {
            autoScrollInput.checked = autoScroll;
            autoScrollInput.addEventListener('change', () => {
                autoScroll = autoScrollInput.checked;
                if (autoScroll && fullBox) fullBox.scrollTop = fullBox.scrollHeight;
            }, { signal: uiSignal });
        }
        if (fullBox && typeof fullBox.addEventListener === 'function') {
            fullBox.addEventListener('scroll', () => {
                const nextAutoScroll = fullBox.scrollHeight - fullBox.scrollTop - fullBox.clientHeight <= 18;
                if (nextAutoScroll !== autoScroll) {
                    autoScroll = nextAutoScroll;
                    if (autoScrollInput) autoScrollInput.checked = autoScroll;
                }
            }, { signal: uiSignal, passive: true });
        }

        const moreDropdown = el('ar-diag-full-dropdown');
        const moreButton = el('ar-diag-full-more-btn');
        const moreMenu = el('ar-diag-full-menu');
        const getMoreItems = () => moreMenu ? Array.from(moreMenu.querySelectorAll<HTMLElement>('[role="menuitem"]')) : [];
        const setMoreMenuOpen = (open: boolean, { focusItem = '', restoreFocus = false } = {}) => {
            if (!moreDropdown || !moreButton) return;
            moreDropdown.classList.toggle('is-open', open);
            moreButton.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (open && focusItem) {
                const items = getMoreItems();
                const target = focusItem === 'last' ? items[items.length - 1] : items[0];
                target?.focus();
            } else if (!open && restoreFocus) {
                moreButton.focus();
            }
        };

        if (moreButton && moreDropdown && moreMenu) {
            moreButton.addEventListener('click', (event: MouseEvent) => {
                event.stopPropagation();
                const willOpen = !moreDropdown.classList.contains('is-open');
                setMoreMenuOpen(willOpen, { focusItem: willOpen && event.detail === 0 ? 'first' : '' });
            }, { signal: uiSignal });
            moreButton.addEventListener('keydown', (event: KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    const willOpen = !moreDropdown.classList.contains('is-open');
                    setMoreMenuOpen(willOpen, { focusItem: willOpen ? 'first' : '' });
                    return;
                }
                if (event.key === 'Escape' && moreDropdown.classList.contains('is-open')) {
                    event.preventDefault();
                    setMoreMenuOpen(false, { restoreFocus: true });
                    return;
                }
                if (event.key === 'Tab' && moreDropdown.classList.contains('is-open')) {
                    event.preventDefault();
                    setMoreMenuOpen(false);
                    (event.shiftKey ? el('ar-diag-full-save') : el('ar-diag-full-box'))?.focus();
                    return;
                }
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const focusItem = event.key === 'ArrowUp' || event.key === 'End' ? 'last' : 'first';
                setMoreMenuOpen(true, { focusItem });
            }, { signal: uiSignal });
            moreMenu.addEventListener('keydown', (event: KeyboardEvent) => {
                const items = getMoreItems();
                if (!items.length) return;
                const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
                let targetIndex = -1;
                if (event.key === 'ArrowDown') targetIndex = (currentIndex + 1) % items.length;
                else if (event.key === 'ArrowUp') targetIndex = (currentIndex - 1 + items.length) % items.length;
                else if (event.key === 'Home') targetIndex = 0;
                else if (event.key === 'End') targetIndex = items.length - 1;
                else if (event.key === 'Escape') {
                    event.preventDefault();
                    setMoreMenuOpen(false, { restoreFocus: true });
                    return;
                } else if (event.key === 'Tab') {
                    event.preventDefault();
                    setMoreMenuOpen(false);
                    (event.shiftKey ? moreButton : el('ar-diag-full-box'))?.focus();
                    return;
                } else {
                    return;
                }
                event.preventDefault();
                items[targetIndex]?.focus();
            }, { signal: uiSignal });
        }

        document.addEventListener('click', (event: MouseEvent) => {
            if (moreDropdown && !moreDropdown.contains(event.target as Node)) setMoreMenuOpen(false);
        }, { signal: uiSignal });

        const diagFullClearBox = el('ar-diag-full-clear-box');
        if (diagFullClearBox) diagFullClearBox.onclick = () => {
            cancelScheduledRender();
            viewOffset = DiagLog.getAll().length;
            expandedGroups.clear();
            renderFullDiag();
            setMoreMenuOpen(false, { restoreFocus: true });
        };

        const updateCheckSummary = () => {
            const status = el('ar-diag-check-status');
            if (!status) return;
            status.replaceChildren();
            if (lastCheckSummary.key === 'diag.checkSummaryIdle') return;
            const progress = document.createElement('span');
            progress.className = 'ar-diag-check-progress';
            progress.textContent = I18n.t('diag.checkSummaryProgress', lastCheckSummary.params);
            const ok = document.createElement('span');
            ok.className = 'ar-diag-check-ok';
            ok.textContent = I18n.t('diag.checkSummaryOk');
            status.append(progress, ok);
        };

        const updateDiagCount = (force = false) => {
            const stats = DiagLog.getStats();
            const curLang = I18n.getLanguage();
            if (!force && stats.version === lastRenderedVersion && curLang === lastRenderedLang) {
                return;
            }
            lastRenderedVersion = stats.version;
            lastRenderedLang = curLang;

            const errors = stats.errors;
            const total = stats.total;
            const errText = I18n.plural(errors, 'error');

            const badge = el('ar-health-badge');
            const healthBtn = el('ar-health-btn');
            if (badge) {
                if (errors > 0) {
                    badge.textContent = String(errors);
                    badge.style.display = 'inline-flex';
                    if (healthBtn) {
                        healthBtn.title = I18n.t('diag.badgeTitle', { errText });
                    }
                } else {
                    badge.textContent = '';
                    badge.style.display = 'none';
                    if (healthBtn) {
                        healthBtn.title = I18n.t('diag.badgeTitleClean');
                    }
                }
            }

            const allCount = el('ar-diag-filter-all-count');
            const errorCount = el('ar-diag-filter-errors-count');
            if (allCount) allCount.textContent = String(total);
            if (errorCount) errorCount.textContent = String(errors);
            el('ar-diag-filter-errors')?.classList.toggle('has-errors', errors > 0);
            updateCheckSummary();
        };

        const ownedUpdateBadge = (force?: boolean) => updateDiagCount(force);
        const ownedRenderDiag = () => {
            diagnosticsDirty = true;
            if (isDiagnosticsVisible()) scheduleRender();
        };

        const handleVisibilityChange = () => {
            if (!isDiagnosticsVisible()) {
                cancelScheduledRender();
                cancelSearchDebounce();
                return;
            }
            if (diagnosticsDirty) {
                cancelSearchDebounce();
                renderFullDiag({ preserveScroll: true });
            }
        };
        onVisibilityChangeImpl = handleVisibilityChange;
        document.addEventListener('visibilitychange', handleVisibilityChange, { signal: uiSignal });

        (window as any)._hhApplyAssistantUpdateDiagBadge = ownedUpdateBadge;
        (window as any)._hhApplyAssistantRenderDiagnostics = ownedRenderDiag;
        updateDiagCount(true);

        const exportLogs = () => {
            exportDiagnosticReport();
            updateDiagCount(true);
        };
        const diagFullSaveBtn = el('ar-diag-full-save');
        if (diagFullSaveBtn) diagFullSaveBtn.onclick = exportLogs;

        const handleClearAllDiag = () => {
            setMoreMenuOpen(false, { restoreFocus: true });
            if (confirm(I18n.t('confirm.clearDiag'))) {
                cancelScheduledRender();
                DiagLog.clear();
                Metrics.clear();
                viewOffset = 0;
                expandedGroups.clear();
                const fullBoxEl = el('ar-diag-full-box');
                if (fullBoxEl) fullBoxEl.innerHTML = '';
                updateDiagCount(true);
                log(I18n.t('logs.diagCleared'));
            }
        };
        const diagFullClearAll = el('ar-diag-full-clear-all');
        if (diagFullClearAll) diagFullClearAll.onclick = handleClearAllDiag;

        const healthButton = el('ar-health-btn');
        if (healthButton) healthButton.onclick = openFullDiag;
        const checkButton = el('ar-diag-full-check');
        if (checkButton) checkButton.onclick = () => {
            runHealthCheck();
            lastCheckSummary = { key: 'diag.checkSummaryOk', params: { passed: 3 } };
            updateCheckSummary();
        };

        renderImpl = renderFullDiag;
        updateImpl = updateDiagCount;
    }

    function refresh() {
        updateImpl(true);
        cancelSearchDebounceImpl();
        diagnosticsDirty = true;
        if (isDiagnosticsVisible()) renderImpl();
    }
    function destroy() {
        cancelScheduledImpl();
        cancelSearchDebounceImpl();
        renderImpl = () => {};
        updateImpl = () => {};
        cancelScheduledImpl = () => {};
        cancelSearchDebounceImpl = () => {};
        onVisibilityChangeImpl = () => {};
        lastRenderedVersion = -1;
        lastRenderedLang = '';
        diagnosticsDirty = true;
        expandedGroups.clear();
        try {
            delete (window as any)._hhApplyAssistantRenderDiagnostics;
            delete (window as any)._hhApplyAssistantUpdateDiagBadge;
        } catch (e) {
            (window as any)._hhApplyAssistantRenderDiagnostics = undefined;
            (window as any)._hhApplyAssistantUpdateDiagBadge = undefined;
        }
    }
    return {
        mount,
        refresh,
        onVisibilityChange: () => onVisibilityChangeImpl(),
        destroy
    };
})();

// Пробегает по ключевым селекторам с учетом контекста страницы
export function runHealthCheck(): void {
    const hasSearchCards = () => Boolean(q(SELECTORS.vacancyCard) || q(SELECTORS.vacancyLink) || q(SELECTORS.applyBtn) || q('a[href*="/vacancy/"]'));
    const isResponseModalOpen = () => {
        const m = q('[data-qa*="modal" i], [class*="modal" i], [role="dialog"]');
        return Boolean(m && isVisible(m));
    };

    const checks = [
        {
            name: I18n.t('health.applyBtnList'),
            sel: SELECTORS.applyBtn,
            key: 'applyBtn',
            evaluate: () => {
                if (Page.isSearch()) {
                    return hasSearchCards()
                        ? { required: true }
                        : { required: false, reason: I18n.t('health.reasons.emptySearch') };
                }
                if (Page.isVacancy()) return { required: false, reason: I18n.t('health.reasons.onVacancyPage') };
                if (Page.isResponseForm()) return { required: false, reason: I18n.t('health.reasons.onResponsePage') };
                return { required: false, reason: I18n.t('health.reasons.notApplicable') };
            }
        },
        {
            name: I18n.t('health.vacancyApply'),
            sel: SELECTORS.vacancyApply,
            key: 'vacancyApply',
            evaluate: () => {
                if (Page.isVacancy()) {
                    return detectAlreadyApplied()
                        ? { required: false, reason: I18n.t('health.reasons.alreadyApplied') }
                        : { required: true };
                }
                if (Page.isSearch()) return { required: false, reason: I18n.t('health.reasons.onSearchPage') };
                if (Page.isResponseForm()) return { required: false, reason: I18n.t('health.reasons.onResponsePage') };
                return { required: false, reason: I18n.t('health.reasons.notApplicable') };
            }
        },
        {
            name: I18n.t('health.vacancyLink'),
            sel: SELECTORS.vacancyLink,
            key: 'vacancyLink',
            evaluate: () => {
                if (Page.isSearch()) {
                    return hasSearchCards()
                        ? { required: true }
                        : { required: false, reason: I18n.t('health.reasons.emptySearch') };
                }
                if (Page.isVacancy()) return { required: false, reason: I18n.t('health.reasons.onVacancyPage') };
                if (Page.isResponseForm()) return { required: false, reason: I18n.t('health.reasons.onResponsePage') };
                return { required: false, reason: I18n.t('health.reasons.notApplicable') };
            }
        },
        {
            name: I18n.t('health.attachCoverBtn'),
            sel: SELECTORS.attachCoverBtn,
            key: 'attachCoverBtn',
            evaluate: () => {
                return { required: false, reason: I18n.t('health.reasons.notInScenario') };
            }
        },
        {
            name: I18n.t('health.letterSubmit'),
            sel: SELECTORS.letterSubmit,
            key: 'letterSubmit',
            evaluate: () => {
                if (Page.isResponseForm()) {
                    return pageLooksLikeTest()
                        ? { required: false, reason: I18n.t('health.reasons.questionnaire') }
                        : { required: true };
                }
                if (isResponseModalOpen()) {
                    return { required: true };
                }
                return { required: false, reason: I18n.t('health.reasons.modalNotOpen') };
            }
        },
        {
            name: I18n.t('health.letterTextarea'),
            sel: SELECTORS.letterTextarea,
            key: 'letterTextarea',
            evaluate: () => {
                if (Page.isResponseForm()) {
                    if (pageLooksLikeTest()) return { required: false, reason: I18n.t('health.reasons.questionnaire') };
                    return { required: false, reason: I18n.t('health.reasons.letterNotExpanded') };
                }
                if (isResponseModalOpen()) {
                    return { required: false, reason: I18n.t('health.reasons.letterNotExpanded') };
                }
                return { required: false, reason: I18n.t('health.reasons.modalNotOpen') };
            }
        }
    ];

    log(I18n.t('health.starting'));
    let okCount = 0;
    let skipCount = 0;
    let errCount = 0;

    checks.forEach(c => {
        const found = q(c.sel);
        const fallbackFound = found ? null : query(c.key as any);
        if (found) {
            okCount++;
            log(I18n.t('health.statusOk', { name: c.name, sel: c.sel }));
        } else if (fallbackFound) {
            okCount++;
            log(I18n.t('health.statusFallback', { name: c.name, sel: c.sel }), false);
        } else {
            const ctx = c.evaluate ? c.evaluate() : { required: true, reason: undefined };
            if (ctx.required) {
                errCount++;
                log(I18n.t('health.statusNotFound', { name: c.name, sel: c.sel }), true);
            } else {
                skipCount++;
                log(I18n.t('health.statusSkipped', { name: c.name, reason: ctx.reason || I18n.t('health.reasons.notApplicable') }), false);
            }
        }
    });

    const errText = I18n.plural(errCount, 'error');
    log(I18n.t('health.summary', { okCount, skipCount, errText }));

    const obj = parseJson<any>(storage.localGet(KEYS.instanceLock), null);
    if (obj) {
        log(I18n.t('health.instanceLock', { tabId: obj.tabId, ts: I18n.formatTime(obj.ts) }));
    } else {
        log(I18n.t('health.instanceLockMissing'));
    }
}
