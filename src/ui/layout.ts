import {
    deepFreeze,
    HHA_MIN_HOST_WIDTH,
    HHA_MIN_PANEL_WIDTH,
    HHA_PREFERRED_PANEL_WIDTH
} from '../dom/selectors.js';

export {
    HHA_MIN_HOST_WIDTH,
    HHA_MIN_PANEL_WIDTH,
    HHA_PREFERRED_PANEL_WIDTH
};
export const SIDEBAR_WIDTH_PROPERTY = '--hha-sidebar-width';
import type { DockingState, LayoutMode } from '../types/index.js';

export function getResponsivePanelLayout(viewportWidth?: number): DockingState {
    const viewport = Math.max(0, Math.floor(Number(viewportWidth || (typeof window !== 'undefined' ? window.innerWidth : 0)) || 0));
    const availableForPanel = viewport - HHA_MIN_HOST_WIDTH;
    if (availableForPanel >= HHA_PREFERRED_PANEL_WIDTH) {
        return {
            mode: 'full',
            panelWidth: HHA_PREFERRED_PANEL_WIDTH,
            hostWidth: viewport - HHA_PREFERRED_PANEL_WIDTH,
        };
    }
    if (availableForPanel >= HHA_MIN_PANEL_WIDTH) {
        return {
            mode: 'compact',
            panelWidth: availableForPanel,
            hostWidth: HHA_MIN_HOST_WIDTH,
        };
    }
    return {
        mode: 'overlay',
        panelWidth: Math.min(HHA_PREFERRED_PANEL_WIDTH, viewport),
        hostWidth: viewport,
    };
}

export const HostLayoutReservation = (() => {
    const SIDEBAR_WIDTH_PROPERTY = '--hha-sidebar-width';
    const PANEL_WIDTH_PROPERTY = '--hha-panel-width';
    const MODE_CLASSES = deepFreeze(['hha-full-dock', 'hha-compact', 'hha-overlay']);
    let panel: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let panelVisible = false;
    let currentLayout: DockingState | null = null;
    let onLayoutChange: ((next: DockingState, prev: DockingState | null) => void) | null = null;

    const getLayoutViewportWidth = (): number => {
        if (typeof window === 'undefined') return 0;
        const innerWidth = Math.max(0, Number(window.innerWidth) || 0);
        const clientWidth = Math.max(0, Number(document.documentElement?.clientWidth) || 0);
        if (innerWidth && clientWidth) return Math.min(innerWidth, clientWidth);
        return clientWidth || innerWidth;
    };

    const clearHostLayoutReservation = (): void => {
        if (typeof document === 'undefined') return;
        document.documentElement.classList.remove('hha-docked');
        const rootStyle = document.documentElement && document.documentElement.style;
        if (!rootStyle) return;
        if (typeof rootStyle.removeProperty === 'function') {
            rootStyle.removeProperty(SIDEBAR_WIDTH_PROPERTY);
        } else if (typeof rootStyle.setProperty === 'function') {
            rootStyle.setProperty(SIDEBAR_WIDTH_PROPERTY, '');
        }
    };

    const syncHostLayoutReservation = (): void => {
        if (typeof document === 'undefined') return;
        if (!panelVisible || currentLayout?.mode === 'overlay' || !panel || panel.isConnected === false) {
            clearHostLayoutReservation();
            return;
        }
        const rect = typeof panel.getBoundingClientRect === 'function'
            ? panel.getBoundingClientRect()
            : { width: panel.offsetWidth || (currentLayout ? currentLayout.panelWidth : 0) };
        const width = Math.max(0, Math.ceil(Number(rect.width) || 0));
        document.documentElement.style?.setProperty?.(SIDEBAR_WIDTH_PROPERTY, `${width}px`);
        document.documentElement.classList.add('hha-docked');
    };

    const applyHostLayoutReservation = (): void => {
        panelVisible = true;
        syncHostLayoutReservation();
    };

    const setPanelVisible = (visible: boolean): void => {
        panelVisible = !!visible;
        if (panelVisible) applyHostLayoutReservation();
        else clearHostLayoutReservation();
    };

    const syncResponsiveDocking = (): DockingState | null => {
        if (typeof document === 'undefined') return null;
        if (!panel || panel.isConnected === false) return currentLayout;
        const nextLayout = getResponsivePanelLayout(getLayoutViewportWidth());
        const previousLayout = currentLayout;
        currentLayout = nextLayout;

        const root = document.documentElement;
        root.style?.setProperty?.(PANEL_WIDTH_PROPERTY, `${nextLayout.panelWidth}px`);
        MODE_CLASSES.forEach(className => root.classList.remove(className));
        root.classList.add(
            nextLayout.mode === 'full'
                ? 'hha-full-dock'
                : nextLayout.mode === 'compact'
                    ? 'hha-compact'
                    : 'hha-overlay'
        );

        const changed = !previousLayout
            || previousLayout.mode !== nextLayout.mode
            || previousLayout.panelWidth !== nextLayout.panelWidth
            || previousLayout.hostWidth !== nextLayout.hostWidth;
        if (changed && typeof onLayoutChange === 'function') {
            onLayoutChange(nextLayout, previousLayout);
        }
        syncHostLayoutReservation();
        return nextLayout;
    };

    const mount = (
        panelElement: HTMLElement,
        uiSignal: AbortSignal,
        layoutChangeHandler?: (next: DockingState, prev: DockingState | null) => void
    ): DockingState | null => {
        panel = panelElement;
        onLayoutChange = layoutChangeHandler || null;
        if (typeof ResizeObserver === 'function') {
            resizeObserver = new ResizeObserver(syncHostLayoutReservation);
            resizeObserver.observe(panel);
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('resize', syncResponsiveDocking, { signal: uiSignal });
        }
        return syncResponsiveDocking();
    };

    const destroy = (): void => {
        panelVisible = false;
        clearHostLayoutReservation();
        if (resizeObserver) resizeObserver.disconnect();
        resizeObserver = null;
        panel = null;
        currentLayout = null;
        onLayoutChange = null;
        if (typeof document !== 'undefined') {
            const root = document.documentElement;
            MODE_CLASSES.forEach(className => root.classList.remove(className));
            root.classList.remove('hha-overlay-open');
            if (typeof root.style?.removeProperty === 'function') {
                root.style.removeProperty(PANEL_WIDTH_PROPERTY);
            } else {
                root.style?.setProperty?.(PANEL_WIDTH_PROPERTY, '');
            }
        }
    };

    return {
        mount,
        setPanelVisible,
        applyHostLayoutReservation,
        clearHostLayoutReservation,
        syncHostLayoutReservation,
        syncResponsiveDocking,
        getLayout: () => currentLayout,
        destroy,
    };
})();
