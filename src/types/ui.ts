export type LayoutMode = 'full' | 'compact' | 'overlay';

export type StatusKey = 'idle' | 'running' | 'stopped' | 'error' | 'done';

export interface DockingState {
    mode: LayoutMode;
    panelWidth: number;
    hostWidth?: number;
    sidebarWidth?: number;
    isDocked?: boolean;
}

export interface StatusState {
    statusKey: StatusKey;
    customKeyOrText?: string | null;
    params?: Record<string, unknown> | null;
}
