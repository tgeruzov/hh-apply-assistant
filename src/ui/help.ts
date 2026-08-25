import { qa } from '../dom/dom-adapter.js';

export const HelpPopoverController = (() => {
    function mount({ panel, uiSignal }: { panel: HTMLElement; uiSignal: AbortSignal }) {
        const entries = qa('.ar-help-wrap', panel).map(wrap => {
            const button = wrap.querySelector('.ar-help-button');
            const popover = wrap.querySelector('.ar-help-popover');
            if (!button || !popover) return null;
            const state = { wrap, button, popover, pinned: false, hover: false, focus: false, escapeClosed: false, render: () => {} };
            const render = () => {
                const open = !state.escapeClosed && (state.pinned || state.hover || state.focus);
                wrap.classList.toggle('is-pinned', state.pinned);
                wrap.classList.toggle('is-open', open);
                button.setAttribute('aria-expanded', open ? 'true' : 'false');
                popover.setAttribute('aria-hidden', open ? 'false' : 'true');
            };
            state.render = render;
            wrap.addEventListener('mouseenter', () => {
                state.hover = true;
                state.escapeClosed = false;
                render();
            }, { signal: uiSignal });
            wrap.addEventListener('mouseleave', () => {
                state.hover = false;
                render();
            }, { signal: uiSignal });
            wrap.addEventListener('focusin', () => {
                state.focus = true;
                state.escapeClosed = false;
                render();
            }, { signal: uiSignal });
            wrap.addEventListener('focusout', () => {
                setTimeout(() => {
                    state.focus = wrap.contains(document.activeElement);
                    render();
                }, 0);
            }, { signal: uiSignal });
            button.addEventListener('click', (event: Event) => {
                event.stopPropagation();
                state.escapeClosed = false;
                state.pinned = !state.pinned;
                render();
            }, { signal: uiSignal });
            return state;
        }).filter(Boolean);

        document.addEventListener('click', (event: MouseEvent) => {
            entries.forEach(state => {
                if (state && state.pinned && !state.wrap.contains(event.target as Node)) {
                    state.pinned = false;
                    state.render();
                }
            });
        }, { signal: uiSignal });
        document.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            entries.forEach(state => {
                if (state && (state.pinned || state.hover || state.focus)) {
                    state.pinned = false;
                    state.escapeClosed = true;
                    state.render();
                }
            });
        }, { signal: uiSignal });
    }

    return { mount };
})();
