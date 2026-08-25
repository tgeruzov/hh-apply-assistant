import { clamp } from '../core/utils.js';
import { Stats, State, config } from '../core/state-manager.js';
import { I18n } from '../i18n/index.js';

export const StatsView = (() => {
    let renderImpl = () => {};

    function mount() {
        function renderStats() {
            const s = Stats.getAll();
            const setNum = (id: string, v: number) => {
                const n = document.getElementById(id);
                if (n) n.textContent = String(v);
            };
            setNum('ar-stat-attempts', s.attempts);
            setNum('ar-stat-success', s.success);
            setNum('ar-stat-manual', s.manual);
            setNum('ar-stat-skipped', s.skipped);
            const sent = State.getSentCount();
            const effectiveLimit = Math.max(config.limit, sent);
            const prog = document.getElementById('ar-stat-progress');
            if (prog) prog.textContent = `${sent} / ${effectiveLimit}`;
            const limitInput = document.getElementById('ar-limit-input') as HTMLInputElement | null;
            if (limitInput) {
                limitInput.min = String(Math.max(1, sent));
                limitInput.value = String(effectiveLimit);
            }
            const progressbar = document.getElementById('ar-execution-progress');
            if (progressbar) {
                progressbar.setAttribute('aria-valuemax', String(effectiveLimit));
                progressbar.setAttribute('aria-valuenow', String(sent));
                progressbar.setAttribute('aria-label', I18n.t('panel.statsProgressTitle'));
            }
            const fill = document.getElementById('ar-progress-fill');
            if (fill) fill.style.width = clamp(Math.round(sent / Math.max(1, effectiveLimit) * 100), 0, 100) + '%';

            const tileAtt = document.getElementById('ar-stat-tile-attempts');
            const tileSuc = document.getElementById('ar-stat-tile-success');
            const tileMan = document.getElementById('ar-stat-tile-manual');
            const tileSkp = document.getElementById('ar-stat-tile-skip');
            if (tileSuc) tileSuc.classList.toggle('is-active-success', s.success > 0);
            if (tileMan) tileMan.classList.toggle('is-active-manual', s.manual > 0);
            if (tileSkp) tileSkp.classList.toggle('is-active-skip', s.skipped > 0);
            if (tileAtt) tileAtt.classList.toggle('is-active-attempts', s.attempts > 0);
        }
        (window as any)._hhApplyAssistantRenderStats = renderStats;
        renderStats();

        renderImpl = renderStats;
    }

    function render() { renderImpl(); }
    function destroy() {
        renderImpl = () => {};
        try { delete (window as any)._hhApplyAssistantRenderStats; }
        catch (e) { (window as any)._hhApplyAssistantRenderStats = undefined; }
    }
    return { mount, render, destroy };
})();
