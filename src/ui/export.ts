import { VERSION } from '../core/runtime.js';
import { TAB_ID } from '../core/concurrency.js';
import { storage, KEYS } from '../storage/storage-service.js';
import { State, config, DiagLog, DiagnosticI18n, Metrics, log } from '../core/state-manager.js';
import { I18n, TRANSLATIONS } from '../i18n/index.js';
import { prettifyTitle } from '../core/utils.js';

// Универсальная выгрузка файла через Blob-ссылку.
export function downloadFile(filename: string, content: string, mime: string): void {
    if (typeof document === 'undefined') return;
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// Секция снимков DOM - по ней видно фактическую разметку в момент сбоя детекта.
export function buildSnapshotsSection(): string {
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const fmt = (t: number) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
    const snaps = (Metrics.getAll().snapshots) || [];
    const lines = ['', I18n.t('report.snapshotsTitle')];
    if (!snaps.length) {
        lines.push(I18n.t('report.snapshotsEmpty'));
        return lines.join('\n');
    }
    snaps.forEach((s: any, i: number) => {
        lines.push('');
        lines.push(`#${i + 1} [${fmt(s.t)}] label=${s.label} path=${s.path || '?'} hasModal=${!!s.hasModal}`);
        if (Array.isArray(s.dataQa) && s.dataQa.length) {
            lines.push('  data-qa:');
            s.dataQa.forEach((d: any) => lines.push(`    - <${d.tag}> qa="${d.qa}" vis=${d.vis} txt="${d.txt}"`));
        }
        if (Array.isArray(s.textareas) && s.textareas.length) {
            lines.push('  textareas:');
            s.textareas.forEach((t: any) => lines.push(`    - name="${t.name}" qa="${t.qa}" ph="${t.ph}" vis=${t.vis}`));
        }
        if (Array.isArray(s.taskFields) && s.taskFields.length) {
            lines.push(I18n.t('report.taskFieldsHeading'));
            s.taskFields.forEach((f: any) => lines.push(`    - <${f.tag}> type="${f.type}" name="${f.name}" vis=${f.vis}`));
        }
        if (Array.isArray(s.modalButtons) && s.modalButtons.length) {
            lines.push('  modalButtons:');
            s.modalButtons.forEach((b: any) => lines.push(`    - qa="${b.qa}" vis=${b.vis} txt="${b.txt}"`));
        }
    });
    return lines.join('\n') + '\n';
}

// Секция метрик: распределение сценариев, тайминги, здоровье и варианты селекторов.
export function buildMetricsSection(): string {
    const m = Metrics.getAll();
    const c = m.counters || {};
    const get = (k: string) => c[k] || 0;
    const lines: string[] = [];
    lines.push('', I18n.t('report.metricsTitle'));
    lines.push(I18n.t('report.metricsSince', { time: new Date(m.startedAt || Date.now()).toISOString() }));
    lines.push(I18n.t('report.scenariosHeading'));
    lines.push(I18n.t('report.scenarios.A', { val: get('scenario.A') }));
    lines.push(I18n.t('report.scenarios.B', { val: get('scenario.B') }));
    lines.push(I18n.t('report.scenarios.C', { val: get('scenario.C') }));
    lines.push(I18n.t('report.scenarios.relocation', { val: get('scenario.relocation') }));
    lines.push(I18n.t('report.scenarios.questions', { val: get('scenario.questions') }));
    lines.push(I18n.t('report.scenarios.questionsWatchdog', { val: get('scenario.questions.watchdog') }));
    lines.push(I18n.t('report.scenarios.timeout', { val: get('scenario.timeout'), unresolved: get('scenario.timeout.unresolved') }));
    lines.push(I18n.t('report.scenarios.noApply', { val: get('scenario.noApply') }));
    lines.push(I18n.t('report.scenarios.bNoConfirm', { val: get('scenario.B.noConfirm') }));

    const known = new Set(['scenario.A', 'scenario.B', 'scenario.C', 'scenario.relocation', 'scenario.questions', 'scenario.questions.watchdog', 'scenario.timeout', 'scenario.timeout.unresolved', 'scenario.noApply', 'scenario.B.noConfirm']);
    const others = Object.keys(c).filter(k => !known.has(k)).sort();
    if (others.length) {
        lines.push(I18n.t('report.otherCounters'));
        others.forEach(k => lines.push(`  ${k} : ${c[k]}`));
    }

    const t = m.timings || {};
    const tKeys = Object.keys(t);
    if (tKeys.length) {
        lines.push(I18n.t('report.timingsHeading'));
        tKeys.forEach(k => {
            const v = t[k];
            const avg = v.n ? Math.round(v.sum / v.n) : 0;
            lines.push(`  ${k} : n=${v.n} avg=${avg} max=${v.max} last=${v.last}`);
        });
    }

    const sel = m.selectors || {};
    const sKeys = Object.keys(sel);
    if (sKeys.length) {
        lines.push(I18n.t('report.selectorsHeading'));
        sKeys.forEach(k => lines.push(`  ${k} : ${sel[k].found} / ${sel[k].missing}`));
    }
    lines.push('==============================================');
    return lines.join('\n');
}

// Собираем диагностический отчёт: заголовок с окружением/состоянием + все строки лога.
export function buildDiagnosticReport(): string {
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const pad3 = (n: number) => String(n).padStart(3, '0');
    const fmtTime = (t: number) => {
        const d = new Date(t);
        return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
    };
    let cfgSnapshot = '{}';
    try { cfgSnapshot = JSON.stringify({ ...config, coverText: `(${(config.coverText || '').length} ${I18n.getLanguage() === 'ru' ? 'симв.' : 'chars'})` }); } catch (e) { /* ignore */ }
    const lockRaw = storage.localGet(KEYS.instanceLock) || I18n.t('report.none');

    const entries = DiagLog.getAll();
    const header = [
        I18n.t('report.headerTitle'),
        I18n.t('report.scriptVersion', { version: VERSION }),
        I18n.t('report.exportedAt', { time: new Date().toISOString() }),
        I18n.t('report.currentUrl', { url: typeof location !== 'undefined' ? location.href : '' }),
        I18n.t('report.userAgent', { ua: typeof navigator !== 'undefined' ? navigator.userAgent : '' }),
        I18n.t('report.tabId', { tabId: TAB_ID }),
        I18n.t('report.running', { running: State.amIRunning() }),
        I18n.t('report.sent', { sent: State.getSentCount(), limit: config.limit }),
        I18n.t('report.processedIds', { count: State.getProcessedIDs().size }),
        I18n.t('report.manualList', { count: State.getManualList().length }),
        I18n.t('report.instanceLock', { lock: lockRaw }),
        I18n.t('report.trapLock', { trap: State.hasTrapLock() }),
        I18n.t('report.f5Needed', { f5: State.isF5Needed() }),
        I18n.t('report.lastAttempt', { last: State.getLastAttemptID() || I18n.t('report.none') }),
        I18n.t('report.returnUrl', { url: State.getReturnUrl() || I18n.t('report.none') }),
        I18n.t('report.config', { cfg: cfgSnapshot }),
        I18n.t('report.logEntries', { count: entries.length }),
        '==============================================',
        ''
    ].join('\n');

    const body = entries.map(e => {
        const lvl = e.lvl === 'ERR' ? 'ERR ' : 'INFO';
        return `[${fmtTime(e.t)}] [${lvl}] [tab ${e.tab || '?'}] [${e.path || '?'}] ${DiagnosticI18n.format(e)}`;
    }).join('\n');

    return header + buildMetricsSection() + '\n' + body + '\n' + buildSnapshotsSection();
}

// Скачиваем диагностический отчёт файлом.
export function exportDiagnosticReport(): void {
    try {
        const report = buildDiagnosticReport();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        downloadFile(`hh_apply_assistant_log_${stamp}.txt`, report, 'text/plain;charset=utf-8');
        log(I18n.t('logs.diagExported'));
    } catch (e: any) {
        log(I18n.t('logs.diagExportFailed', { err: (e && e.message ? e.message : e) }), true);
    }
}

export function exportManualListHtml({ openInBrowser = false } = {}): void {
    const list = State.getManualList();
    if (!list || !list.length) { alert(I18n.t('alert.manualEmpty')); return; }

    const lang = I18n.getLanguage();
    const localeTag = I18n.getLocaleTag(lang);

    const seen = new Set<string>();
    const uniq: any[] = [];
    let duplicates = 0;
    for (const it of list) {
        const key = String(it.url || it.vid || '').trim();
        if (!key) continue;
        if (seen.has(key)) { duplicates++; continue; }
        seen.add(key);
        uniq.push({ ...it, title: prettifyTitle(it.title) });
    }

    const rowsJson = JSON.stringify(uniq).replace(/</g, '\\u003c');
    const expStringsJson = JSON.stringify((TRANSLATIONS as any)[lang].export).replace(/</g, '\\u003c');
    const exportDateStr = I18n.formatDateTime(Date.now(), {}, lang);

    const content = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${I18n.t('export.docTitle')}</title><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>
            :root{
                color-scheme:light;
                --ap-brand:#d6001c; --ap-brand-soft:#ffebee;
                --hh-blue:#6863b3; --hh-blue-hover:#5d58a6; --hh-blue-soft:#f0eff9;
                --hh-green:#059669;
                --ink:#1e293b; --ink-2:#475569; --ink-3:#626f80;
                --line:#e2e8f0; --line-2:#f1f5f9;
                --bg:#ffffff; --bg-2:#f8fafc; --bg-3:#f1f5f9;
                --radius:12px; --radius-xs:6px;
                --font:'HH Sans','Inter',-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
            }
            *{box-sizing:border-box;}
            body{font-family:var(--font);margin:0;padding:24px 20px 48px;color:var(--ink);background:var(--bg-2);line-height:1.45;}
            .wrap{max-width:1160px;margin:0 auto;}
            .topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px;flex-wrap:wrap;}
            .brand{display:flex;align-items:center;min-width:0;}
            .brand-heading{margin:0;font-size:20px;font-weight:700;color:var(--ink);letter-spacing:-.02em;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
            .brand-wordmark{font-weight:850;color:var(--ap-brand);letter-spacing:-.03em;text-transform:lowercase;font-size:21px;}
            .brand-sep{color:var(--ink-3);font-weight:400;}
            .brand-sub{font-weight:600;color:var(--ink-2);font-size:16px;}
            .meta{color:var(--ink-3);font-size:12px;margin-top:2px;}
            .panel{background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);box-shadow:0 2px 12px rgba(15,23,42,.04);overflow:hidden;}
            .stats{display:flex;align-items:stretch;flex-wrap:wrap;gap:0;flex:none;}
            .stat{display:flex;flex-direction:column;justify-content:center;gap:1px;padding:4px 18px;border-left:1px solid var(--line);}
            .stat:first-child{border-left:none;padding-left:0;}
            .stat-val{font-size:19px;font-weight:800;color:var(--ink);font-variant-numeric:tabular-nums;line-height:1.1;}
            .stat-lbl{font-size:10px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.04em;font-weight:600;white-space:nowrap;}
            .stat.new .stat-val{color:var(--hh-blue);}
            .stat.opened .stat-val{color:var(--hh-green);}
            .stat.shown .stat-val{color:var(--ink-2);}
            .toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line-2);background:var(--bg-2);}
            .search-field{position:relative;flex:1 1 280px;min-width:240px;display:flex;align-items:center;}
            .search-field .search-ic{position:absolute;left:11px;width:15px;height:15px;color:var(--ink-3);pointer-events:none;}
            input[type=text]{width:100%;height:36px;padding:0 12px 0 34px;border:1px solid var(--line);border-radius:var(--radius-xs);font-size:13px;font-family:inherit;color:var(--ink);background:#fff;transition:border-color .15s,box-shadow .15s;}
            input[type=text]:focus{outline:none;border-color:var(--hh-blue);box-shadow:0 0 0 3px var(--hh-blue-soft);}
            input[type=text]:hover:not(:focus){border-color:#cbd5e1;}
            .dropdown{position:relative;user-select:none;}
            .dropdown-trigger{display:flex;align-items:center;gap:8px;height:36px;padding:0 30px 0 12px;border:1px solid var(--line);border-radius:var(--radius-xs);font-size:12px;font-weight:600;font-family:inherit;color:var(--ink);background:#fff;cursor:pointer;white-space:nowrap;transition:all .15s;background-repeat:no-repeat;background-position:right 10px center;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23475569' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");}
            .dropdown-trigger:hover{border-color:#cbd5e1;}
            .dropdown.is-open .dropdown-trigger{border-color:var(--hh-blue);box-shadow:0 0 0 3px var(--hh-blue-soft);}
            .dropdown.is-open .dropdown-trigger{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236863b3' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M18 15l-6-6-6 6'/%3E%3C/svg%3E");}
            .dropdown-menu{display:none;position:absolute;top:calc(100% + 4px);left:0;min-width:100%;background:#fff;border:1px solid var(--line);border-radius:var(--radius-xs);box-shadow:0 8px 24px rgba(15,23,42,.12);z-index:10;padding:4px 0;overflow:hidden;}
            .dropdown.is-open .dropdown-menu{display:block;animation:dd-in .12s ease;}
            @keyframes dd-in{from{opacity:0;transform:translateY(-4px);}to{opacity:1;transform:none;}}
            .dropdown-item{display:flex;align-items:center;padding:8px 12px;font-size:12.5px;font-weight:500;color:var(--ink);cursor:pointer;transition:background .1s,color .1s;white-space:nowrap;}
            .dropdown-item:hover{background:var(--hh-blue-soft);color:var(--hh-blue);}
            .dropdown-item.is-active{font-weight:700;color:var(--hh-blue);background:var(--hh-blue-soft);}
            .toolbar-spacer{flex:1 1 0;min-width:0;}
            .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:38px;cursor:pointer;border-radius:var(--radius-xs);border:1px solid var(--line);background:#fff;color:var(--ink-2);padding:0 14px;font-size:12.5px;font-weight:600;font-family:inherit;white-space:nowrap;transition:all .15s ease;}
            .btn:hover{background:var(--bg-2);color:var(--ink);border-color:#cbd5e1;}
            .btn:active{transform:translateY(1px);}
            .btn svg{width:15px;height:15px;}
            .btn.primary{background:var(--hh-blue);color:#fff;border-color:var(--hh-blue);box-shadow:0 2px 4px rgba(82,76,154,.17);}
            .btn.primary:hover{background:var(--hh-blue-hover);border-color:var(--hh-blue-hover);box-shadow:0 4px 8px rgba(82,76,154,.23);}
            .btn.secondary{background:#fff;color:var(--ink-2);border-color:var(--line);}
            .btn.secondary:hover{background:var(--bg-3);color:var(--ink);border-color:#cbd5e1;}
            .table-wrap{overflow-x:auto;}
            table{border-collapse:separate;border-spacing:0;width:100%;font-size:13px;min-width:680px;table-layout:fixed;}
            th,td{padding:11px 14px;text-align:left;border-bottom:1px solid var(--line-2);vertical-align:middle;line-height:1.4;}
            th{background:var(--bg-3);color:var(--ink-3);position:sticky;top:0;z-index:2;font-weight:700;font-size:11px;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap;}
            tbody tr{transition:background .12s;}
            tbody tr:hover{background:var(--hh-blue-soft);}
            td a{color:var(--hh-blue);text-decoration:none;font-weight:600;word-break:break-word;}
            td a:hover{text-decoration:underline;}
            .col-check{width:44px;text-align:center;}
            .col-date{width:160px;white-space:nowrap;color:var(--ink-2);font-size:12.5px;}
            .col-title{width:auto;word-break:break-word;}
            .col-link{width:64px;white-space:nowrap;text-align:center;}
            .col-age{width:78px;white-space:nowrap;}
            .icon-link{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;color:var(--hh-blue);border-radius:var(--radius-xs);transition:background .15s,color .15s;}
            .icon-link:hover{background:var(--hh-blue-soft);text-decoration:none;}
            .icon-link svg{width:16px;height:16px;pointer-events:none;}
            .muted{color:var(--ink-3);font-weight:400;}
            .age{display:inline-block;padding:2px 8px;font-weight:600;font-size:11px;border-radius:999px;}
            .age.fresh{background:#ecfdf5;color:#059669;}
            .age.recent{background:var(--hh-blue-soft);color:var(--hh-blue);}
            .age.stale{background:#fffbeb;color:#d97706;}
            .age.old{background:var(--ap-brand-soft);color:#c01126;}
            .tag{display:inline-block;background:var(--bg-2);color:var(--ink-3);padding:2px 8px;font-size:11px;border-radius:999px;}
            .processed td{opacity:0.5;text-decoration:line-through;}
            input[type=checkbox]{-webkit-appearance:none;appearance:none;width:17px;height:17px;flex:none;margin:0;border:1.5px solid #cbd5e1;border-radius:4px;background:#fff;cursor:pointer;position:relative;vertical-align:middle;transition:background .15s,border-color .15s;}
            input[type=checkbox]:hover{border-color:var(--hh-blue);}
            input[type=checkbox]:checked{background:var(--hh-blue);border-color:var(--hh-blue);}
            input[type=checkbox]:checked::after{content:'';position:absolute;left:4px;top:1px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg);}
            input[type=checkbox]:focus-visible{outline:none;box-shadow:0 0 0 3px var(--hh-blue-soft);}
            .empty-state{padding:44px 20px;text-align:center;color:var(--ink-3);font-size:13.5px;}
            .empty-state svg{width:32px;height:32px;color:var(--ink-3);margin-bottom:10px;opacity:.7;}
            @media (max-width:640px){
                body{padding:16px 12px 36px;}
                .search-field{flex-basis:100%;}
                .toolbar-spacer{display:none;}
                .btn{flex:1;}
            }
        </style>
        </head><body>
        <div class="wrap">
            <header class="topbar">
                <div class="brand">
                    <div class="brand-txt">
                        <h1 class="brand-heading"><span class="brand-wordmark">${I18n.t('export.brandWordmark')}</span><span class="brand-sep">·</span><span class="brand-sub">${I18n.t('export.brandSub')}</span></h1>
                        <div class="meta">${I18n.t('export.metaText', { date: exportDateStr, duplicates })}</div>
                    </div>
                </div>
                <div class="stats" id="summary"></div>
            </header>
            <section class="panel">
                <div class="toolbar">
                    <div class="search-field">
                        <svg class="search-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
                        <input id="filter" type="text" placeholder="${I18n.t('export.searchPlaceholder')}">
                    </div>
                    <div class="dropdown" id="sort-dropdown">
                        <div class="dropdown-trigger" id="sort-dropdown-trigger" role="combobox" tabindex="0" aria-readonly="true" aria-haspopup="listbox" aria-expanded="false" aria-controls="sort-dropdown-listbox" aria-activedescendant="sort-option-ts-desc">${I18n.t('export.sortPrefix')}${I18n.t('export.sortOptions.ts_desc')}</div>
                        <div class="dropdown-menu" id="sort-dropdown-listbox" role="listbox" aria-labelledby="sort-dropdown-trigger">
                            <div class="dropdown-item is-active" id="sort-option-ts-desc" role="option" aria-selected="true" data-value="ts_desc">${I18n.t('export.sortOptions.ts_desc')}</div>
                            <div class="dropdown-item" id="sort-option-ts-asc" role="option" aria-selected="false" data-value="ts_asc">${I18n.t('export.sortOptions.ts_asc')}</div>
                            <div class="dropdown-item" id="sort-option-title-asc" role="option" aria-selected="false" data-value="title_asc">${I18n.t('export.sortOptions.title_asc')}</div>
                            <div class="dropdown-item" id="sort-option-title-desc" role="option" aria-selected="false" data-value="title_desc">${I18n.t('export.sortOptions.title_desc')}</div>
                        </div>
                    </div>
                    <div class="dropdown" id="view-mode-dropdown">
                        <div class="dropdown-trigger" id="view-mode-dropdown-trigger" role="combobox" tabindex="0" aria-readonly="true" aria-haspopup="listbox" aria-expanded="false" aria-controls="view-mode-dropdown-listbox" aria-activedescendant="view-mode-option-new">${I18n.t('export.statusPrefix')}${I18n.t('export.statusOptions.new')}</div>
                        <div class="dropdown-menu" id="view-mode-dropdown-listbox" role="listbox" aria-labelledby="view-mode-dropdown-trigger">
                            <div class="dropdown-item is-active" id="view-mode-option-new" role="option" aria-selected="true" data-value="new">${I18n.t('export.statusOptions.new')}</div>
                            <div class="dropdown-item" id="view-mode-option-opened" role="option" aria-selected="false" data-value="opened">${I18n.t('export.statusOptions.opened')}</div>
                        </div>
                    </div>
                    <div class="toolbar-spacer"></div>
                    <button id="open-selected" class="btn primary" title="${I18n.t('export.openSelectedTitle')}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg>
                        ${I18n.t('export.openSelected')}
                    </button>
                    <button id="clear-processed" class="btn secondary" title="${I18n.t('export.resetMarkersTitle')}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>
                        ${I18n.t('export.resetMarkers')}
                    </button>
                </div>
                <div class="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th class="col-check"><input type="checkbox" id="check-all" aria-label="${I18n.t('export.selectAll')}"></th>
                                <th class="col-date">${I18n.t('export.tableHeaders.saved')}</th>
                                <th class="col-title">${I18n.t('export.tableHeaders.vacancy')}</th>
                                <th class="col-link">${I18n.t('export.tableHeaders.link')}</th>
                                <th class="col-age">${I18n.t('export.tableHeaders.age')}</th>
                            </tr>
                        </thead>
                        <tbody id="rows"></tbody>
                    </table>
                </div>
            </section>
        </div>

        <script>
            const data = ${rowsJson};
            const exp = ${expStringsJson};
            const activeLocale = '${localeTag}';
            let sortKey = 'ts_desc';
            let filterText = '';
            let viewMode = 'new';
            const PROCESSED_KEY = ${JSON.stringify(KEYS.manualProcessed)};
            let processed = {};
            try {
                const raw = localStorage.getItem(PROCESSED_KEY);
                if (raw) processed = JSON.parse(raw) || {};
                if (!processed || typeof processed !== 'object' || Array.isArray(processed)) processed = {};
            } catch (e) {
                processed = {};
            }
            const selected = new Set();

            const qs = (id) => document.getElementById(id);
            const escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
            const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => escMap[ch] || ch);
            const keyOf = (item, idx) => {
                const composite = [item?.url, item?.returnUrl, item?.title, item?.ts].filter(Boolean).join('|');
                return String(item?.vid || composite || idx);
            };
            const encodeKey = (key) => encodeURIComponent(String(key || ''));
            const decodeKey = (key) => {
                try { return decodeURIComponent(String(key || '')); }
                catch (e) { return ''; }
            };
            const safeHttpUrl = (raw) => {
                if (!raw) return '';
                try {
                    const u = new URL(String(raw));
                    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
                    return u.href;
                } catch (e) {
                    return '';
                }
            };

            function humanAgo(ts) {
                const d = Date.now() - ts;
                const sec = Math.floor(d/1000);
                if (sec < 60) return sec + 's';
                const min = Math.floor(sec/60);
                if (min < 60) return min + 'm';
                const hr = Math.floor(min/60);
                if (hr < 24) return hr + 'h';
                const day = Math.floor(hr/24);
                return day + 'd';
            }

            function ageClass(ts) {
                const days = (Date.now() - ts)/(1000*60*60*24);
                if (days < 1) return 'fresh';
                if (days < 3) return 'recent';
                if (days < 7) return 'stale';
                return 'old';
            }

            function applySort(arr) {
                const sorted = [...arr];
                sorted.sort((a,b)=>{
                    if (sortKey === 'ts_desc') return (b.ts||0)-(a.ts||0);
                    if (sortKey === 'ts_asc') return (a.ts||0)-(b.ts||0);
                    const ta = (a.title||'').toLowerCase();
                    const tb = (b.title||'').toLowerCase();
                    if (sortKey === 'title_asc') return ta.localeCompare(tb, activeLocale);
                    if (sortKey === 'title_desc') return tb.localeCompare(ta, activeLocale);
                    return 0;
                });
                return sorted;
            }

            function render() {
                const tbody = qs('rows');
                if (!tbody) return;
                const ft = filterText.trim().toLowerCase();
                const filtered = data.filter((i, idx)=>{
                    const pKey = keyOf(i, idx);
                    if (viewMode === 'opened') {
                        if (!processed[pKey]) return false;
                    } else {
                        if (processed[pKey]) return false;
                    }
                    if (!ft) return true;
                    return [i.vid, i.title, i.url].some(v => (v||'').toLowerCase().includes(ft));
                });
                const sorted = applySort(filtered);
                const openIcon = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg>';
                let html = '';
                sorted.forEach((i, idx)=>{
                    const ts = i.ts || Date.now();
                    const ago = humanAgo(ts);
                    const aClass = ageClass(ts);
                    const key = keyOf(i, idx);
                    const keyEnc = encodeKey(key);
                    const checked = selected.has(key) ? 'checked' : '';
                    const rowClass = processed[key] ? ' class="processed"' : '';
                    const url = safeHttpUrl(i.url);
                    const link = url ? '<a class="icon-link" title="' + escHtml(exp.openLinkTitle) + '" aria-label="' + escHtml(exp.openLinkTitle) + '" data-open="1" href="' + escHtml(url) + '" target="_blank" rel="noopener noreferrer">' + openIcon + '</a>' : '<span class="tag">' + escHtml(exp.noLinkTag) + '</span>';
                    const title = (i.title && i.title.trim()) ? i.title.trim() : '';
                    const titleCell = (title && title !== 'Название недоступно' && title !== 'Title unavailable')
                        ? escHtml(title)
                        : '<span class="muted" title="' + escHtml(exp.noTitleTooltip) + '">' + escHtml(exp.noTitleText) + '</span>';
                    const selectionName = String(exp.selectVacancy || '').replace('{title}', title || String(i.vid || exp.noTitleText));
                    html += '<tr' + rowClass + ' data-key="' + keyEnc + '">'
                         + '<td class="col-check"><input type="checkbox" class="row-check" data-key="' + keyEnc + '" aria-label="' + escHtml(selectionName) + '" ' + checked + '></td>'
                         + '<td class="col-date">' + escHtml(new Date(ts).toLocaleString(activeLocale)) + '</td>'
                         + '<td class="col-title">' + titleCell + '</td>'
                         + '<td class="col-link">' + link + '</td>'
                         + '<td class="col-age"><span class="age ' + aClass + '">' + ago + '</span></td>'
                         + '</tr>';
                });
                if (!sorted.length) {
                    const emptyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M9 15h6"></path></svg>';
                    const msg = ft ? exp.emptyStates.filter : (viewMode === 'opened' ? exp.emptyStates.opened : exp.emptyStates.new);
                    html = '<tr><td colspan="5"><div class="empty-state">' + emptyIcon + '<div>' + escHtml(msg) + '</div></div></td></tr>';
                }
                tbody.innerHTML = html;
                const checkAll = qs('check-all');
                if (checkAll) {
                    checkAll.checked = sorted.length > 0 && sorted.every((i, idx) => selected.has(keyOf(i, idx)));
                }
                renderSummary(filtered.length);
            }

            function renderSummary(shown) {
                const box = qs('summary');
                if (!box) return;
                const total = data.length;
                let opened = 0;
                data.forEach((i, idx) => { if (processed[keyOf(i, idx)]) opened++; });
                const fresh = total - opened;
                const stat = (cls, val, lbl) => '<div class="stat' + (cls ? ' ' + cls : '') + '"><span class="stat-val">' + val + '</span><span class="stat-lbl">' + lbl + '</span></div>';
                let html = stat('', total, exp.summaryStats.total) + stat('new', fresh, exp.summaryStats.new) + stat('opened', opened, exp.summaryStats.opened);
                if (filterText.trim() !== '') html += stat('shown', typeof shown === 'number' ? shown : 0, exp.summaryStats.shown);
                box.innerHTML = html;
            }

            function saveProcessed() {
                try {
                    localStorage.setItem(PROCESSED_KEY, JSON.stringify(processed));
                } catch (_) {}
            }

            qs('filter').addEventListener('input', (e)=>{ filterText = e.target.value; render(); });
            const closeDropdowns = (except = null) => {
                document.querySelectorAll('.dropdown.is-open').forEach(dropdown => {
                    if (dropdown === except) return;
                    dropdown.classList.remove('is-open');
                    dropdown.querySelector('.dropdown-trigger')?.setAttribute('aria-expanded', 'false');
                });
            };
            function initDropdown(id, prefix, onSelect) {
                const wrap = qs(id);
                if (!wrap) return;
                const trigger = wrap.querySelector('.dropdown-trigger');
                const menu = wrap.querySelector('.dropdown-menu');
                const setOpen = (open) => {
                    wrap.classList.toggle('is-open', open);
                    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
                };
                const choose = (item) => {
                    trigger.textContent = prefix + item.textContent;
                    menu.querySelectorAll('.dropdown-item').forEach(i => {
                        const selected = i === item;
                        i.classList.toggle('is-active', selected);
                        i.setAttribute('aria-selected', selected ? 'true' : 'false');
                    });
                    trigger.setAttribute('aria-activedescendant', item.id);
                    setOpen(false);
                    onSelect(item.dataset.value);
                };
                trigger.addEventListener('click', (e) => {
                    e.stopPropagation();
                    closeDropdowns(wrap);
                    setOpen(!wrap.classList.contains('is-open'));
                });
                trigger.addEventListener('keydown', (e) => {
                    const items = [...menu.querySelectorAll('.dropdown-item')];
                    const activeIdx = items.findIndex(i => i.classList.contains('is-active'));
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        trigger.click();
                    } else if (e.key === 'Escape') {
                        setOpen(false);
                    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        const dir = e.key === 'ArrowDown' ? 1 : -1;
                        choose(items[(activeIdx + dir + items.length) % items.length]);
                    }
                });
                menu.addEventListener('click', (e) => {
                    const item = e.target.closest('.dropdown-item');
                    if (item) choose(item);
                });
                wrap.addEventListener('focusout', () => {
                    setTimeout(() => {
                        if (!wrap.contains(document.activeElement)) setOpen(false);
                    }, 0);
                });
            }
            document.addEventListener('click', () => closeDropdowns());
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') closeDropdowns();
            });

            initDropdown('sort-dropdown', exp.sortPrefix, (val) => { sortKey = val; render(); });
            initDropdown('view-mode-dropdown', exp.statusPrefix, (val) => {
                viewMode = val;
                selected.clear();
                render();
            });

            qs('check-all').addEventListener('change', (e)=>{
                const state = e.target.checked;
                document.querySelectorAll('.row-check').forEach(ch => {
                    ch.checked = state;
                    const key = decodeKey(ch.dataset.key);
                    if (!key) return;
                    if (state) selected.add(key);
                    else selected.delete(key);
                });
            });

            qs('rows').addEventListener('change', (e)=>{
                if (!e.target.classList.contains('row-check')) return;
                const key = decodeKey(e.target.dataset.key);
                if (!key) return;
                if (e.target.checked) selected.add(key);
                else selected.delete(key);
            });

            qs('open-selected').addEventListener('click', ()=>{
                document.querySelectorAll('.row-check:checked').forEach(ch=>{
                    const key = decodeKey(ch.dataset.key);
                    const row = data.find((i, idx) => keyOf(i, idx) === key);
                    const url = safeHttpUrl(row?.url);
                    if (url) window.open(url, '_blank', 'noopener,noreferrer');
                    if (key) processed[key] = true;
                });
                saveProcessed();
                selected.clear();
                render();
            });

            qs('rows').addEventListener('click', (e)=>{
                const a = e.target.closest('a');
                if (!a || a.dataset.open !== '1') return;
                const row = a.closest('tr');
                const key = decodeKey(row?.getAttribute('data-key'));
                if (!key) return;
                processed[key] = true;
                saveProcessed();
                render();
            });

            qs('clear-processed').addEventListener('click', ()=>{
                if (!confirm(exp.confirmReset)) return;
                const keys = Object.keys(processed);
                keys.forEach(k => delete processed[k]);
                saveProcessed();
                selected.clear();
                render();
            });

            render();
        </script>
        </body></html>`;

    if (openInBrowser) {
        const blob = new Blob([content], { type: 'text/html;charset=utf-8' });
        const objectUrl = URL.createObjectURL(blob);
        let queueWindow: Window | null = null;
        try {
            queueWindow = window.open(objectUrl, '_blank');
            if (queueWindow) queueWindow.opener = null;
        } catch (e) { /* popup feedback below */ }
        if (!queueWindow) {
            URL.revokeObjectURL(objectUrl);
            alert(I18n.t('alert.manualOpenBlocked'));
            return;
        }
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
        log(I18n.t('logs.htmlOpened'));
        return;
    }

    downloadFile('hh_apply_assistant_manual_queue.html', content, 'text/html;charset=utf-8');
    log(I18n.t('logs.htmlExported'));
}
