import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const production = readFileSync(new URL('../hh-apply-assistant.user.js', import.meta.url), 'utf8');
const labUrl = new URL('../hh-apply-assistant-ui-lab.html', import.meta.url);
const lab = existsSync(labUrl) ? readFileSync(labUrl, 'utf8') : '';

test('responsive model defines measured panel and host constraints without body hacks', () => {
    assert.doesNotMatch(production, /html\.hha-(?:open|docked)[^\{]*\{[^\}]*(?:margin|padding)-right/);
    assert.doesNotMatch(production, /html\.hha-docked body[^\{]*\{/);
    assert.doesNotMatch(production, /transition\s*:\s*margin-right/);
    assert.match(production, /const HHA_PREFERRED_PANEL_WIDTH = 410/);
    assert.match(production, /const HHA_MIN_PANEL_WIDTH = 340/);
    assert.match(production, /const HHA_MIN_HOST_WIDTH = 980/);
    assert.match(production, /minimum practical width reserved for hh\.ru desktop layout before compact assistant mode is used/i);
    assert.match(production, /--hha-panel-width:\$\{HHA_PREFERRED_PANEL_WIDTH\}px/);
    assert.match(production, /width:min\(var\(--hha-panel-width\),100%\)/);
    assert.doesNotMatch(production, /--hha-sidebar-width\s*:\s*410px/);
});

test('responsive helper produces full, compact, and overlay measurements', () => {
    const start = production.indexOf('function getResponsivePanelLayout');
    const end = production.indexOf('\n\n    const HostLayoutReservation', start);
    assert.ok(start >= 0 && end > start);
    const helperSource = production.slice(start, end);
    const getLayout = Function(
        'HHA_PREFERRED_PANEL_WIDTH',
        'HHA_MIN_PANEL_WIDTH',
        'HHA_MIN_HOST_WIDTH',
        `${helperSource}; return getResponsivePanelLayout;`
    )(410, 340, 980);

    assert.deepEqual(getLayout(1920), { mode: 'full', panelWidth: 410, hostWidth: 1510 });
    assert.deepEqual(getLayout(1536), { mode: 'full', panelWidth: 410, hostWidth: 1126 });
    assert.deepEqual(getLayout(1366), { mode: 'compact', panelWidth: 386, hostWidth: 980 });
    assert.deepEqual(getLayout(1280), { mode: 'overlay', panelWidth: 410, hostWidth: 1280 });
});

test('production docks the measured panel width against the real HH root', () => {
    assert.match(production, /html\.hha-docked #HH-React-Root/);
    assert.match(production, /width:min\(calc\(100vw - var\(--hha-sidebar-width\)\),calc\(100% - var\(--hha-sidebar-width\)\)\)/);
    assert.match(production, /calc\(100vw - var\(--hha-sidebar-width\)\)/);
    assert.match(production, /\.supernova-navi-container/);
    assert.match(production, /\.supernova-navi-wrapper/);
    assert.match(production, /\.supernova-navi-inner-wrapper/);
    assert.match(production, /\.supernova-navi/);
    assert.match(production, /\.HH-MainContent/);
    assert.match(production, /main\.main-content/);
    assert.match(production, /getBoundingClientRect/);
    assert.match(production, /Math\.ceil\(Number\(rect\.width\)/);
    assert.match(production, /new ResizeObserver\(syncHostLayoutReservation\)/);
    assert.match(production, /window\.addEventListener\('resize', syncResponsiveDocking/);
    assert.match(production, /\.sticky-buttonbar_float-top/);
    assert.match(production, /\.notification-manager/);
    assert.match(production, /sticky-vacancy-header-container-sticky/);
});

test('open, minimize, fallback, and teardown keep manual and responsive state separate', () => {
    assert.match(production, /rootStyle\.removeProperty\(SIDEBAR_WIDTH_PROPERTY\)/);
    assert.match(production, /document\.documentElement\.classList\.add\('hha-docked'\)/);
    assert.match(production, /document\.documentElement\.classList\.remove\('hha-docked'\)/);
    assert.match(production, /'hha-full-dock', 'hha-compact', 'hha-overlay'/);
    assert.match(production, /let manualOpen = storage\.localGet\(KEYS\.uiOpen\) !== '0'/);
    assert.match(production, /let overlayOpen = false/);
    assert.match(production, /const isVisible = isOverlay \? overlayOpen : manualOpen/);
    assert.match(production, /HostLayoutReservation\.setPanelVisible\(isVisible\)/);
    assert.match(production, /HostLayoutReservation\.destroy\(\)/);
});

test('UI Lab previews responsive compact panel without HH host integration', { skip: !lab }, () => {
    assert.match(lab, /--hha-panel-preferred-width:410px/);
    assert.match(lab, /--hha-panel-min-width:340px/);
    assert.match(lab, /--hha-host-min-width:980px/);
    assert.match(lab, /--hha-panel-width:clamp\(/);
    assert.match(lab, /@container \(max-width:409px\)/);
    assert.doesNotMatch(lab, /hha-docked|--hha-sidebar-width:|HH-React-Root/);
});
