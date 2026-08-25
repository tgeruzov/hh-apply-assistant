export type SpeedPreset = 'safe' | 'balanced' | 'fast' | 'turbo';

export interface PresetTimings {
    readonly action: readonly [number, number];
    readonly delay: readonly [number, number];
}

export interface AppSettings {
    coverText: string;
    useCover: boolean;
    applyOnRejectWarning: boolean;
    skipHidden: boolean;
    preset: SpeedPreset;
    limit: number;
}
