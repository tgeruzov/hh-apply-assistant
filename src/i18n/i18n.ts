import { deepFreeze } from '../dom/selectors.js';
import { storage, KEYS } from '../storage/storage-service.js';
import type { SupportedLanguage, LocaleTag, SpeedPreset, PresetTimings, AppSettings } from '../types/index.js';
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE, LOCALE_TAGS, TRANSLATIONS } from './dictionaries.js';

export const I18n = (() => {
    let _currentLang: SupportedLanguage | null = null;

    function _detectInitialLang(): SupportedLanguage {
        try {
            const saved = storage.localGet(KEYS.language) as SupportedLanguage | null;
            if (saved && SUPPORTED_LANGUAGES.includes(saved)) return saved;
        } catch (e) { /* ignore */ }

        try {
            const docLang = (typeof document !== 'undefined' && document.documentElement ? document.documentElement.lang || '' : '').toLowerCase();
            if (docLang.startsWith('en')) return 'en';
            if (docLang.startsWith('ru')) return 'ru';
            const nav = typeof navigator !== 'undefined' ? navigator : null;
            const navLang = ((nav && nav.language) || (nav as any)?.userLanguage || '').toLowerCase();
            if (navLang.startsWith('en')) return 'en';
            if (navLang.startsWith('ru')) return 'ru';
        } catch (e) { /* ignore */ }

        return DEFAULT_LANGUAGE;
    }

    function _getNested(obj: unknown, path: string): any {
        if (!obj || typeof obj !== 'object') return undefined;
        const parts = path.split('.');
        let curr: any = obj;
        for (const p of parts) {
            if (curr && typeof curr === 'object' && p in curr) {
                curr = curr[p];
            } else {
                return undefined;
            }
        }
        return curr;
    }

    function _interpolate(template: string, params?: Record<string, unknown> | null): string {
        if (typeof template !== 'string') return '';
        if (!params || typeof params !== 'object') return template;
        return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
            return (key in params && params[key] !== undefined && params[key] !== null) ? String(params[key]) : match;
        });
    }

    return {
        init(): SupportedLanguage {
            if (!_currentLang) {
                _currentLang = _detectInitialLang();
            }
            return _currentLang;
        },
        getLanguage(): SupportedLanguage {
            if (!_currentLang) _currentLang = _detectInitialLang();
            return _currentLang;
        },
        setLanguage(lang: SupportedLanguage): boolean {
            if (!SUPPORTED_LANGUAGES.includes(lang)) return false;
            _currentLang = lang;
            try {
                storage.localSet(KEYS.language, lang);
            } catch (e) { /* ignore */ }
            return true;
        },
        getLocaleTag(lang?: SupportedLanguage): LocaleTag {
            const target = lang || I18n.getLanguage();
            return LOCALE_TAGS[target] || LOCALE_TAGS[DEFAULT_LANGUAGE];
        },
        t(key: string, params?: Record<string, unknown> | null, lang?: SupportedLanguage): string {
            const current = lang || I18n.getLanguage();
            let val = _getNested((TRANSLATIONS as any)[current], key);
            if (val === undefined && current !== DEFAULT_LANGUAGE) {
                val = _getNested((TRANSLATIONS as any)[DEFAULT_LANGUAGE], key);
            }
            if (val === undefined) {
                return key;
            }
            return typeof val === 'string' ? _interpolate(val, params) : val;
        },
        plural(n: number | string, category: string, _params?: Record<string, unknown> | null, lang?: SupportedLanguage): string {
            const num = Number.isFinite(Number(n)) ? Number(n) : 0;
            const current = lang || I18n.getLanguage();
            const localeTag = I18n.getLocaleTag(current);
            let form = 'other';
            try {
                const pr = new Intl.PluralRules(localeTag);
                form = pr.select(num);
            } catch (e) {
                if (current === 'ru') {
                    const mod10 = num % 10;
                    const mod100 = num % 100;
                    if (mod100 >= 11 && mod100 <= 19) form = 'many';
                    else if (mod10 === 1) form = 'one';
                    else if (mod10 >= 2 && mod10 <= 4) form = 'few';
                    else form = 'many';
                } else {
                    form = num === 1 ? 'one' : 'other';
                }
            }
            const pluralsObj = _getNested((TRANSLATIONS as any)[current], `plurals.${category}`)
                || _getNested((TRANSLATIONS as any)[DEFAULT_LANGUAGE], `plurals.${category}`)
                || {};
            const word = pluralsObj[form] || pluralsObj.other || pluralsObj.many || pluralsObj.one || category;
            return `${num} ${word}`;
        },
        formatTime(dateOrTs?: Date | number | null, options: Intl.DateTimeFormatOptions = {}, lang?: SupportedLanguage): string {
            const d = dateOrTs instanceof Date ? dateOrTs : new Date(dateOrTs || Date.now());
            const localeTag = I18n.getLocaleTag(lang);
            try {
                return d.toLocaleTimeString(localeTag, options);
            } catch (e) {
                return d.toTimeString().slice(0, 8);
            }
        },
        formatDate(dateOrTs?: Date | number | null, options: Intl.DateTimeFormatOptions = {}, lang?: SupportedLanguage): string {
            const d = dateOrTs instanceof Date ? dateOrTs : new Date(dateOrTs || Date.now());
            const localeTag = I18n.getLocaleTag(lang);
            try {
                return d.toLocaleDateString(localeTag, options);
            } catch (e) {
                return d.toISOString().slice(0, 10);
            }
        },
        formatDateTime(dateOrTs?: Date | number | null, options: Intl.DateTimeFormatOptions = {}, lang?: SupportedLanguage): string {
            const d = dateOrTs instanceof Date ? dateOrTs : new Date(dateOrTs || Date.now());
            const localeTag = I18n.getLocaleTag(lang);
            try {
                return d.toLocaleString(localeTag, options);
            } catch (e) {
                return d.toISOString();
            }
        }
    };
})();

export const t = (key: string, params?: Record<string, unknown> | null, lang?: SupportedLanguage): string => I18n.t(key, params, lang);

// Пресеты темпа работы. Все интервалы в миллисекундах [min, max]:
//  delay  - пауза перед переходом к следующей вакансии;
//  view   - чтение страницы вакансии (имитация просмотра);
//  action - микро-паузы между отдельными действиями (клики, ввод).
export const PRESETS: Record<SpeedPreset, { delay: [number, number]; view: [number, number]; action: [number, number] }> = deepFreeze({
    safe: {
        delay: [4000, 8000],
        view: [15000, 35000],
        action: [300, 1000]
    },
    balanced: {
        delay: [2000, 5000],
        view: [8000, 20000],
        action: [150, 600]
    },
    fast: {
        delay: [1500, 3000],
        view: [4000, 9000],
        action: [120, 350]
    },
    turbo: {
        delay: [80, 200],
        view: [0, 0],
        action: [25, 80]
    }
});

export const WORK_MODE_KEYS: readonly SpeedPreset[] = deepFreeze(['safe', 'balanced', 'fast', 'turbo']);
export const DEFAULT_PRESET: SpeedPreset = 'balanced';

export const presetLabel = (key?: SpeedPreset): string => I18n.t(`presets.${key || DEFAULT_PRESET}.label`);

export const modeKeyToIndex = (key?: SpeedPreset): number => {
    const idx = WORK_MODE_KEYS.indexOf(key as SpeedPreset);
    return idx >= 0 ? idx : 1;
};

export const modeIndexToKey = (idx: number): SpeedPreset => {
    return WORK_MODE_KEYS[Math.max(0, Math.min(WORK_MODE_KEYS.length - 1, idx))] || DEFAULT_PRESET;
};

export const getDefaultCoverText = (lang?: SupportedLanguage): string => {
    const target = lang || I18n.getLanguage();
    return (TRANSLATIONS as any)[target]?.cover?.defaultText || TRANSLATIONS[DEFAULT_LANGUAGE].cover.defaultText;
};

export const DEFAULTS: AppSettings = deepFreeze({
    coverText: TRANSLATIONS[DEFAULT_LANGUAGE].cover.defaultText,
    useCover: true,
    applyOnRejectWarning: false,
    skipHidden: true,
    preset: DEFAULT_PRESET,
    limit: 50
});
