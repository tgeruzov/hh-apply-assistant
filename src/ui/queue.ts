import { toSafeHhUrl, prettifyTitle } from '../core/utils.js';
import { State, Metrics, log } from '../core/state-manager.js';
import { I18n } from '../i18n/index.js';
import { uiIcon } from './icons.js';
import { exportManualListHtml } from './export.js';

export const ManualQueueView = (() => {
    let renderImpl = () => {};

    function mount({ el }: { el: (id: string) => HTMLElement | null }) {
        const clearBtn = el('ar-clear-manual');
        if (clearBtn) {
            clearBtn.onclick = () => {
                if (confirm(I18n.t('confirm.clearManual'))) {
                    if (!State.clearManualList()) {
                        Metrics.bump('storage.manual.clear.failed');
                        log('[CRITICAL_STORAGE_WRITE_FAILED] manual_queue: clear', true);
                        return;
                    }
                    renderManualList();
                    log(I18n.t('logs.manualCleared'));
                }
            };
        }

        const exportBtn = el('ar-export-manual');
        if (exportBtn) {
            exportBtn.onclick = () => exportManualListHtml();
        }

        function renderManualList() {
            const container = document.getElementById('ar-manual-list');
            if (!container) return;
            container.innerHTML = '';
            const list = State.getManualList();
            const cntEl = document.getElementById('ar-manual-count');
            const totalCount = list?.length || 0;
            if (cntEl) {
                cntEl.textContent = String(totalCount);
                cntEl.setAttribute('data-has', totalCount > 0 ? '1' : '0');
            }
            if (!list || !list.length) {
                const empty = document.createElement('div');
                empty.className = 'ar-empty';
                empty.innerHTML = `
                    <span class="ar-empty-icon" aria-hidden="true">${uiIcon('inbox')}</span>
                    <span class="ar-empty-text">${I18n.t('panel.manualEmpty')}</span>
                `;
                container.appendChild(empty);
                return;
            }

            const PREVIEW_LIMIT = 2;
            const previewItems = list.slice(0, PREVIEW_LIMIT);

            previewItems.forEach(item => {
                const safeUrl = toSafeHhUrl(item?.url);
                const row = document.createElement('div');
                row.className = 'ar-manual-item';

                const left = document.createElement('div');
                left.className = 'ar-manual-main';
                const time = I18n.formatTime(Number(item?.ts) || Date.now(), { hour: '2-digit', minute: '2-digit' });

                const head = document.createElement('div');
                head.className = 'ar-manual-meta';
                const vid = document.createElement('span');
                vid.className = 'ar-vid';
                vid.textContent = item?.vid ? `#${item.vid}` : 'n/a';
                const when = document.createElement('span');
                when.className = 'ar-when';
                when.textContent = time;
                head.appendChild(vid);
                head.appendChild(document.createTextNode('·'));
                head.appendChild(when);

                const titleEl = document.createElement('div');
                titleEl.className = 'ar-manual-title';
                const itemTitle = prettifyTitle(item?.title);
                if (itemTitle && itemTitle !== 'Название недоступно' && itemTitle !== 'Title unavailable') {
                    titleEl.textContent = itemTitle;
                    titleEl.title = itemTitle;
                } else {
                    titleEl.classList.add('is-empty');
                    titleEl.textContent = I18n.t('panel.manualNoTitle');
                }

                left.appendChild(head);
                left.appendChild(titleEl);

                const actions = document.createElement('div');
                actions.className = 'ar-manual-actions';

                const openBtn = document.createElement('button');
                openBtn.className = 'ar-btn ar-btn-open';
                const openText = document.createElement('span');
                openText.textContent = I18n.t('panel.manualOpen');
                openBtn.appendChild(openText);
                openBtn.disabled = !safeUrl;
                openBtn.title = safeUrl ? I18n.t('panel.manualOpenTitle') : I18n.t('panel.manualUnsafeUrl');
                openBtn.onclick = () => {
                    if (safeUrl) window.open(safeUrl, '_blank', 'noopener,noreferrer');
                };

                const removeBtn = document.createElement('button');
                removeBtn.className = 'ar-btn ar-remove-btn ar-icon-only';
                removeBtn.innerHTML = uiIcon('trash', 'trash');
                removeBtn.title = I18n.t('panel.manualRemoveTitle');
                removeBtn.setAttribute('aria-label', I18n.t('panel.manualRemoveTitle'));
                removeBtn.onclick = () => {
                    if (!confirm(I18n.t('confirm.removeManual'))) return;
                    if (!State.removeManualEntry(item.vid)) {
                        Metrics.bump('storage.manual.remove.failed');
                        log(`[CRITICAL_STORAGE_WRITE_FAILED] manual_queue: remove ${item.vid}`, true);
                        return;
                    }
                    renderManualList();
                };

                actions.appendChild(openBtn);
                actions.appendChild(removeBtn);

                row.appendChild(left);
                row.appendChild(actions);
                container.appendChild(row);
            });

            if (totalCount > PREVIEW_LIMIT) {
                const moreBtn = document.createElement('button');
                moreBtn.className = 'ar-btn ar-btn-soft ar-queue-more-btn';
                moreBtn.innerHTML = `<span>${I18n.t('panel.manualMore', { count: totalCount })}</span>`;
                moreBtn.title = I18n.t('panel.manualMoreTitle');
                moreBtn.onclick = () => exportManualListHtml({ openInBrowser: true });
                container.appendChild(moreBtn);
            }
        }

        renderImpl = renderManualList;
        (window as any)._hhApplyAssistantRenderManualQueue = renderImpl;
        renderImpl();
    }

    function render() { renderImpl(); }
    function destroy() {
        renderImpl = () => {};
        try { delete (window as any)._hhApplyAssistantRenderManualQueue; }
        catch (e) { (window as any)._hhApplyAssistantRenderManualQueue = undefined; }
    }
    return { mount, render, destroy };
})();
