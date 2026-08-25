export type SupportedLanguage = 'ru' | 'en';

export type LocaleTag = 'ru-RU' | 'en-US';

export interface TranslationSchema {
    [namespace: string]: Record<string, string>;
}
