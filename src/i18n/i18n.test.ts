import { test, expect } from 'vitest';
import {
    I18n,
    SUPPORTED_LANGUAGES,
    LOCALE_TAGS,
    TRANSLATIONS,
    DEFAULT_LANGUAGE
} from './index.js';
import { DiagnosticI18n } from '../core/state-manager.js';

test('I18n configuration and dictionary integrity', () => {
    expect(SUPPORTED_LANGUAGES).toEqual(['ru', 'en']);
    expect(DEFAULT_LANGUAGE).toBe('ru');
    expect(LOCALE_TAGS.ru).toBe('ru-RU');
    expect(LOCALE_TAGS.en).toBe('en-US');
    expect(TRANSLATIONS.ru).toBeTruthy();
    expect(TRANSLATIONS.en).toBeTruthy();
});

test('I18n translates known keys and falls back for unknown keys', () => {
    I18n.setLanguage('ru');
    expect(I18n.t('panel.startBtn')).toBe('Запустить отклики');
    expect(I18n.t('unknown.key.foo')).toBe('unknown.key.foo');

    I18n.setLanguage('en');
    expect(I18n.t('panel.startBtn')).toBe('Start applying');
    expect(I18n.t('unknown.key.bar')).toBe('unknown.key.bar');

    I18n.setLanguage('ru');
});

test('I18n pluralization works correctly in RU and EN', () => {
    I18n.setLanguage('ru');
    expect(I18n.plural(1, 'error')).toBe('1 ошибка');
    expect(I18n.plural(2, 'error')).toBe('2 ошибки');
    expect(I18n.plural(5, 'error')).toBe('5 ошибок');
    expect(I18n.plural(21, 'error')).toBe('21 ошибка');

    I18n.setLanguage('en');
    expect(I18n.plural(1, 'error')).toBe('1 error');
    expect(I18n.plural(2, 'error')).toBe('2 errors');
    expect(I18n.plural(5, 'error')).toBe('5 errors');

    I18n.setLanguage('ru');
});

test('DiagnosticI18n formats and translates diagnostic messages across languages', () => {
    I18n.setLanguage('ru');
    const msg = '- Загрузка страницы: /search/vacancy (запуск=да, отправлено=5/50) -';
    const inferred = DiagnosticI18n.infer(msg, 'ru');
    expect(inferred).toBeTruthy();
    expect(inferred?.key).toBe('logs.pageLoad');

    I18n.setLanguage('en');
    const formatted = DiagnosticI18n.format({
        msg,
        i18nKey: inferred?.key,
        i18nParams: inferred?.params,
        i18nLang: 'ru'
    });
    expect(formatted).toMatch(/Page load: \/search\/vacancy/);
    I18n.setLanguage('ru');
});
