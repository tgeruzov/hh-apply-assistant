import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_SOURCE = readFileSync(resolve(TEST_DIR, '..', 'script.js'), 'utf8');

test('help tooltips expose descriptions and keep localized interactive state', () => {
    assert.match(SCRIPT_SOURCE, /id="ar-warning-help-btn"[^>]*aria-describedby="ar-warning-help-popover"[^>]*aria-controls="ar-warning-help-popover"[^>]*aria-expanded="false"/);
    assert.match(SCRIPT_SOURCE, /id="ar-work-mode-help-btn"[\s\S]{0,300}aria-describedby="ar-work-mode-popover"[\s\S]{0,200}aria-controls="ar-work-mode-popover"[\s\S]{0,200}aria-expanded="false"/);
    assert.match(SCRIPT_SOURCE, /button\.setAttribute\('aria-expanded', open \? 'true' : 'false'\)/);
    assert.match(SCRIPT_SOURCE, /setIconButton\('ar-work-mode-help-btn', 'help', I18n\.t\('panel\.modeHelpAria'\)\)/);
    assert.match(SCRIPT_SOURCE, /setIconButton\('ar-warning-help-btn', 'help', I18n\.t\('cover\.rejectWarningHelpAria'\)\)/);
});

test('manual export checkboxes and select-only dropdowns expose RU/EN accessible semantics', () => {
    assert.match(SCRIPT_SOURCE, /selectAll: 'Выбрать все вакансии'/);
    assert.match(SCRIPT_SOURCE, /selectVacancy: 'Выбрать вакансию: \{title\}'/);
    assert.match(SCRIPT_SOURCE, /selectAll: 'Select all vacancies'/);
    assert.match(SCRIPT_SOURCE, /selectVacancy: 'Select vacancy: \{title\}'/);
    assert.match(SCRIPT_SOURCE, /id="check-all" aria-label="\$\{I18n\.t\('export\.selectAll'\)\}"/);
    assert.match(SCRIPT_SOURCE, /class="row-check"[^>]*aria-label="' \+ escHtml\(selectionName\)/);

    assert.equal((SCRIPT_SOURCE.match(/role="combobox"/g) || []).length, 2);
    assert.equal((SCRIPT_SOURCE.match(/role="listbox"/g) || []).length, 2);
    assert.equal((SCRIPT_SOURCE.match(/role="option"/g) || []).length, 6);
    assert.match(SCRIPT_SOURCE, /aria-controls="sort-dropdown-listbox"[^>]*aria-activedescendant="sort-option-ts-desc"/);
    assert.match(SCRIPT_SOURCE, /i\.setAttribute\('aria-selected', selected \? 'true' : 'false'\)/);
    assert.match(SCRIPT_SOURCE, /trigger\.setAttribute\('aria-activedescendant', item\.id\)/);
    assert.match(SCRIPT_SOURCE, /e\.key === 'Enter' \|\| e\.key === ' '/);
    assert.match(SCRIPT_SOURCE, /e\.key === 'ArrowDown' \|\| e\.key === 'ArrowUp'/);
    assert.match(SCRIPT_SOURCE, /e\.key === 'Escape'/);
    assert.match(SCRIPT_SOURCE, /wrap\.addEventListener\('focusout'/);
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
        assert.equal(SCRIPT_SOURCE.includes(deadName), false, `${deadName} should not remain in production source`);
    }
    assert.doesNotMatch(SCRIPT_SOURCE, /function getMetrics\s*\(/);
    const diagnosticsSource = SCRIPT_SOURCE.slice(
        SCRIPT_SOURCE.indexOf('    const DiagnosticsView = (() => {'),
        SCRIPT_SOURCE.indexOf('    const LocalizationBinder = (() => {')
    );
    assert.doesNotMatch(diagnosticsSource, /function (?:render|update)\(\)/);
    assert.doesNotMatch(diagnosticsSource, /\n\s+(?:render|update),/);
});

test('declared custom properties have a var consumer or explicit dynamic JS usage', () => {
    const declared = new Set([...SCRIPT_SOURCE.matchAll(/(?<![\w-])(--[A-Za-z0-9_-]+)\s*:/g)].map(match => match[1]));
    const consumed = new Set([...SCRIPT_SOURCE.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].map(match => match[1]));
    const dynamic = new Set([...SCRIPT_SOURCE.matchAll(/(?:setProperty|getPropertyValue|removeProperty)\s*\(\s*['"](--[A-Za-z0-9_-]+)/g)].map(match => match[1]));

    const unused = [...declared].filter(name => !consumed.has(name) && !dynamic.has(name));
    const undefinedConsumers = [...consumed].filter(name => !declared.has(name) && !dynamic.has(name));
    assert.deepEqual(unused, []);
    assert.deepEqual(undefinedConsumers, ['--hha-sidebar-width']);
    assert.match(SCRIPT_SOURCE, /const SIDEBAR_WIDTH_PROPERTY = '--hha-sidebar-width'/);
    assert.match(SCRIPT_SOURCE, /setProperty\?\.\(SIDEBAR_WIDTH_PROPERTY,/);
    assert.doesNotMatch(SCRIPT_SOURCE, /--hha-font|var\(--hha-font\)/);
    assert.match(SCRIPT_SOURCE, /\.ar-diag-full-box\{[^}]*font-family:inherit/);
});

test('setupUI delegates SPA remount status restoration to the terminal-state policy', () => {
    assert.match(SCRIPT_SOURCE, /function restoreStatusAfterMount\(\)[\s\S]*currentStatusState\.statusKey === 'running'[\s\S]*setStatus\('idle'\)/);
    assert.match(SCRIPT_SOURCE, /el\('ar-limit-input'\)\.value = config\.limit;\s*restoreStatusAfterMount\(\);/);
});
