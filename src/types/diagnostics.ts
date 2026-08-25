export interface DiagLogEntry {
    ts: number;
    msg: string;
    err: boolean;
    count?: number;
}

export type MetricsMap = Record<string, number>;

export interface DomSnapshot {
    tag: string;
    id: string;
    className: string;
    text: string;
    dataQa: string;
    rect?: DOMRect | null;
}

export interface TimingMetric {
    n: number;
    sum: number;
    last: number;
    max: number;
}

export interface SelectorMetric {
    found: number;
    missing: number;
}

export interface MetricsData {
    startedAt: number;
    counters: Record<string, number>;
    timings: Record<string, TimingMetric>;
    selectors: Record<string, SelectorMetric>;
    snapshots: any[];
}
