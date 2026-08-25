import { I18n } from '../i18n/index.js';

export const AutosaveFeedback = (() => {
    let root: HTMLElement | null = null;
    let textNode: HTMLElement | null = null;
    let resetTimer: ReturnType<typeof setTimeout> | null = null;
    let saved = false;

    const refresh = () => {
        if (!textNode) return;
        textNode.textContent = I18n.t(saved ? 'panel.autosaveSaved' : 'panel.autosaveIdle');
        root?.classList.toggle('is-saved', saved);
    };

    const showSaved = () => {
        saved = true;
        refresh();
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
            resetTimer = null;
            saved = false;
            refresh();
        }, 1800);
    };

    const mount = ({ el }: { el: (id: string) => HTMLElement | null }) => {
        root = el('ar-autosave-feedback');
        textNode = el('ar-autosave-text');
        saved = false;
        refresh();
    };

    const destroy = () => {
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = null;
        saved = false;
        root = null;
        textNode = null;
    };

    return { mount, showSaved, refresh, destroy };
})();
