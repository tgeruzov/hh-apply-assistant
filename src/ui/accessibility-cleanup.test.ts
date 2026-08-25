import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../');
const SCRIPT_PATH = path.join(ROOT, 'hh-apply-assistant.user.js');
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, 'utf8');

test('help tooltips expose descriptions and keep localized interactive state', () => {
    expect(SCRIPT_SOURCE).toMatch(/id="ar-warning-help-btn"[^>]*aria-describedby="ar-warning-help-popover"[^>]*aria-controls="ar-warning-help-popover"[^>]*aria-expanded="false"/);
    expect(SCRIPT_SOURCE).toMatch(/id="ar-work-mode-help-btn"[\s\S]{0,300}aria-describedby="ar-work-mode-popover"[\s\S]{0,200}aria-controls="ar-work-mode-popover"[\s\S]{0,200}aria-expanded="false"/);
    expect(SCRIPT_SOURCE).toMatch(/button\.setAttribute\('aria-expanded', open \? 'true' : 'false'\)/);
    expect(SCRIPT_SOURCE).toMatch(/setIconButton\('ar-work-mode-help-btn', 'help', I18n\.t\('panel\.modeHelpAria'\)\)/);
    expect(SCRIPT_SOURCE).toMatch(/setIconButton\('ar-warning-help-btn', 'help', I18n\.t\('cover\.rejectWarningHelpAria'\)\)/);
});

test('manual export checkboxes and select-only dropdowns expose RU/EN accessible semantics', () => {
    expect(SCRIPT_SOURCE).toMatch(/selectAll: 'Выбрать все вакансии'/);
    expect(SCRIPT_SOURCE).toMatch(/selectVacancy: 'Выбрать вакансию: \{title\}'/);
    expect(SCRIPT_SOURCE).toMatch(/selectAll: 'Select all vacancies'/);
    expect(SCRIPT_SOURCE).toMatch(/selectVacancy: 'Select vacancy: \{title\}'/);
    expect(SCRIPT_SOURCE).toMatch(/id="check-all" aria-label="\$\{I18n\.t\('export\.selectAll'\)\}"/);
    expect(SCRIPT_SOURCE).toMatch(/class="row-check"[^>]*aria-label="' \+ escHtml\(selectionName\)/);

    expect((SCRIPT_SOURCE.match(/role="combobox"/g) || []).length).toBe(2);
    expect((SCRIPT_SOURCE.match(/role="listbox"/g) || []).length).toBe(2);
    expect((SCRIPT_SOURCE.match(/role="option"/g) || []).length).toBe(6);
    expect(SCRIPT_SOURCE).toMatch(/aria-controls="sort-dropdown-listbox"[^>]*aria-activedescendant="sort-option-ts-desc"/);
    expect(SCRIPT_SOURCE).toMatch(/i\.setAttribute\('aria-selected', selected \? 'true' : 'false'\)/);
    expect(SCRIPT_SOURCE).toMatch(/trigger\.setAttribute\('aria-activedescendant', item\.id\)/);
    expect(SCRIPT_SOURCE).toMatch(/e\.key === 'Enter' \|\| e\.key === ' '/);
    expect(SCRIPT_SOURCE).toMatch(/e\.key === 'ArrowDown' \|\| e\.key === 'ArrowUp'/);
    expect(SCRIPT_SOURCE).toMatch(/e\.key === 'Escape'/);
    expect(SCRIPT_SOURCE).toMatch(/wrap\.addEventListener\('focusout'/);
});

test('confirmed dead frontend selectors, health summary, and JS wrappers are absent from production', () => {
    for (const deadName of [
        'ar-diag-stat',
        'ar-diag-stat-row',
        'ar-cover-footer',
        'ar-btn-ghost',
        'ar-btn-full',
        'ar-badge--neutral',
        'ar-badge--error',
        'ar-badge--info',
        'ar-inline-check',
        'ar-log-line',
        'ar-log-err',
        'ar-diag-health-summary'
    ]) {
        expect(SCRIPT_SOURCE.includes(deadName)).toBe(false);
    }
    expect(SCRIPT_SOURCE).not.toMatch(/function getMetrics\s*\(/);
    const diagnosticsSource = SCRIPT_SOURCE.slice(
        SCRIPT_SOURCE.indexOf('    const DiagnosticsView = (() => {'),
        SCRIPT_SOURCE.indexOf('    const LocalizationBinder = (() => {')
    );
    expect(diagnosticsSource).not.toMatch(/function (?:render|update)\(\)/);
    expect(diagnosticsSource).not.toMatch(/\n\s+(?:render|update),/);
});

test('declared custom properties have a var consumer or explicit dynamic JS usage', () => {
    const declared = new Set([...SCRIPT_SOURCE.matchAll(/(?<![\w-])(--[A-Za-z0-9_-]+)\s*:/g)].map(match => match[1]));
    const consumed = new Set([...SCRIPT_SOURCE.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].map(match => match[1]));
    const dynamic = new Set([...SCRIPT_SOURCE.matchAll(/(?:setProperty|getPropertyValue|removeProperty)\s*\(\s*['"](--[A-Za-z0-9_-]+)/g)].map(match => match[1]));

    const unused = [...declared].filter(name => !consumed.has(name) && !dynamic.has(name));
    const undefinedConsumers = [...consumed].filter(name => !declared.has(name) && !dynamic.has(name));
    expect(unused).toEqual([]);
    expect(undefinedConsumers).toEqual(['--hha-sidebar-width']);
    expect(SCRIPT_SOURCE).toMatch(/const SIDEBAR_WIDTH_PROPERTY = '--hha-sidebar-width'/);
    expect(SCRIPT_SOURCE).toMatch(/setProperty\?\.\(SIDEBAR_WIDTH_PROPERTY,/);
    expect(SCRIPT_SOURCE).not.toMatch(/--hha-font|var\(--hha-font\)/);
    expect(SCRIPT_SOURCE).toMatch(/\.ar-diag-full-box\{[^}]*font-family:inherit/);
});

test('setupUI delegates SPA remount status restoration to the terminal-state policy', () => {
    expect(SCRIPT_SOURCE).toMatch(/function restoreStatusAfterMount\(\)[\s\S]*currentStatusState\.statusKey === 'running'[\s\S]*setStatus\('idle'\)/);
    expect(SCRIPT_SOURCE).toMatch(/el\('ar-limit-input'\)\.value = config\.limit;\s*restoreStatusAfterMount\(\);/);
});
