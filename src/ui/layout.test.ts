import { test, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
    getResponsivePanelLayout,
    HostLayoutReservation,
    HHA_PREFERRED_PANEL_WIDTH,
    HHA_MIN_PANEL_WIDTH,
    HHA_MIN_HOST_WIDTH,
    SIDEBAR_WIDTH_PROPERTY
} from './layout.js';

const ROOT = path.resolve(__dirname, '../../');
const SCRIPT_PATH = path.join(ROOT, 'hh-apply-assistant.user.js');
const production = readFileSync(SCRIPT_PATH, 'utf8').replace(/\r\n/g, '\n');

test('responsive model defines measured panel and host constraints without body hacks', () => {
    expect(HHA_PREFERRED_PANEL_WIDTH).toBe(410);
    expect(HHA_MIN_PANEL_WIDTH).toBe(340);
    expect(HHA_MIN_HOST_WIDTH).toBe(980);
    expect(SIDEBAR_WIDTH_PROPERTY).toBe('--hha-sidebar-width');

    expect(production).not.toMatch(/html\.hha-(?:open|docked)[^\{]*\{[^\}]*(?:margin|padding)-right/);
    expect(production).not.toMatch(/html\.hha-docked body[^\{]*\{/);
    expect(production).not.toMatch(/transition\s*:\s*margin-right/);
    expect(production).toMatch(/const HHA_PREFERRED_PANEL_WIDTH = 410/);
    expect(production).toMatch(/const HHA_MIN_PANEL_WIDTH = 340/);
    expect(production).toMatch(/const HHA_MIN_HOST_WIDTH = 980/);
    expect(production).toMatch(/minimum practical width reserved for hh\.ru desktop layout before compact assistant mode is used/i);
    expect(production).toMatch(/--hha-panel-width:\$\{HHA_PREFERRED_PANEL_WIDTH\}px/);
    expect(production).toMatch(/width:min\(var\(--hha-panel-width\),100%\)/);
    expect(production).not.toMatch(/--hha-sidebar-width\s*:\s*410px/);
});

test('responsive helper produces full, compact, and overlay measurements', () => {
    expect(getResponsivePanelLayout(1920)).toEqual({ mode: 'full', panelWidth: 410, hostWidth: 1510 });
    expect(getResponsivePanelLayout(1536)).toEqual({ mode: 'full', panelWidth: 410, hostWidth: 1126 });
    expect(getResponsivePanelLayout(1366)).toEqual({ mode: 'compact', panelWidth: 386, hostWidth: 980 });
    expect(getResponsivePanelLayout(1280)).toEqual({ mode: 'overlay', panelWidth: 410, hostWidth: 1280 });
});

test('production docks the measured panel width against the real HH root', () => {
    expect(production).toMatch(/html\.hha-docked #HH-React-Root/);
    expect(production).toMatch(/width:min\(calc\(100vw - var\(--hha-sidebar-width\)\),calc\(100% - var\(--hha-sidebar-width\)\)\)/);
    expect(production).toMatch(/calc\(100vw - var\(--hha-sidebar-width\)\)/);
    expect(production).toMatch(/\.supernova-navi-container/);
    expect(production).toMatch(/\.supernova-navi-wrapper/);
    expect(production).toMatch(/\.supernova-navi-inner-wrapper/);
    expect(production).toMatch(/\.supernova-navi/);
    expect(production).toMatch(/\.HH-MainContent/);
    expect(production).toMatch(/main\.main-content/);
    expect(production).toMatch(/getBoundingClientRect/);
    expect(production).toMatch(/Math\.ceil\(Number\(rect\.width\)/);
    expect(production).toMatch(/new ResizeObserver\(syncHostLayoutReservation\)/);
    expect(production).toMatch(/window\.addEventListener\('resize', syncResponsiveDocking/);
    expect(production).toMatch(/\.sticky-buttonbar_float-top/);
    expect(production).toMatch(/\.notification-manager/);
    expect(production).toMatch(/sticky-vacancy-header-container-sticky/);
});

test('open, minimize, fallback, and teardown keep manual and responsive state separate', () => {
    expect(production).toMatch(/rootStyle\.removeProperty\(SIDEBAR_WIDTH_PROPERTY\)/);
    expect(production).toMatch(/document\.documentElement\.classList\.add\('hha-docked'\)/);
    expect(production).toMatch(/document\.documentElement\.classList\.remove\('hha-docked'\)/);
    expect(production).toMatch(/'hha-full-dock', 'hha-compact', 'hha-overlay'/);
    expect(production).toMatch(/let manualOpen = storage\.localGet\(KEYS\.uiOpen\) !== '0'/);
    expect(production).toMatch(/let overlayOpen = false/);
    expect(production).toMatch(/const isVisible = isOverlay \? overlayOpen : manualOpen/);
    expect(production).toMatch(/HostLayoutReservation\.setPanelVisible\(isVisible\)/);
    expect(production).toMatch(/HostLayoutReservation\.destroy\(\)/);
});
