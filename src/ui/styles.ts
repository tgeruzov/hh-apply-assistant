import { HHA_PREFERRED_PANEL_WIDTH } from '../dom/selectors.js';

export function injectPanelStyles(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById('ar-styles')) return;
    const style = document.createElement('style');
    style.id = 'ar-styles';
    style.textContent = `
    :root{--hha-panel-width:${HHA_PREFERRED_PANEL_WIDTH}px;}
    #ar-main-panel, #ar-main-panel *, #ar-toggle-btn, #ar-toggle-btn *{box-sizing:border-box;}
    #ar-main-panel, #ar-toggle-btn{--font:"HH Sans","Inter",-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-family:var(--font);letter-spacing:normal;text-transform:none;}
    /* min(..., 100% - sidebar) excludes a classic scrollbar that 100vw includes. */
    html.hha-docked #HH-React-Root{box-sizing:border-box!important;width:min(calc(100vw - var(--hha-sidebar-width)),calc(100% - var(--hha-sidebar-width)))!important;max-width:min(calc(100vw - var(--hha-sidebar-width)),calc(100% - var(--hha-sidebar-width)))!important;min-width:0!important;}
    html.hha-docked #HH-React-Root .supernova-navi-container,
    html.hha-docked #HH-React-Root .supernova-navi-wrapper{box-sizing:border-box!important;width:calc(100vw - var(--hha-sidebar-width))!important;max-width:100%!important;min-width:0!important;}
    html.hha-docked #HH-React-Root .supernova-navi-inner-wrapper,
    html.hha-docked #HH-React-Root .supernova-navi,
    html.hha-docked #HH-React-Root .HH-MainContent,
    html.hha-docked #HH-React-Root .HH-Supernova-MainContent,
    html.hha-docked #HH-React-Root main.main-content{box-sizing:border-box!important;width:100%!important;max-width:100%!important;min-width:0!important;}
    /* These HH surfaces are viewport-fixed, so root reflow cannot move their right edge. */
    html.hha-docked .sticky-buttonbar_float-top,
    html.hha-docked .notification-manager{right:var(--hha-sidebar-width)!important;}
    html.hha-docked [class*="sticky-vacancy-header-container-sticky--"]{width:calc(100% - var(--hha-sidebar-width))!important;max-width:calc(100% - var(--hha-sidebar-width))!important;}
    #ar-toggle-btn{position:fixed;top:50%;right:0;transform:translateY(-50%);border:none;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;z-index:2147483000;user-select:none;}
    #ar-toggle-btn .ar-tab-text{color:#fff;text-transform:none;line-height:1;}
    #ar-main-panel{position:fixed;top:0;right:0;bottom:0;height:100vh;width:min(var(--hha-panel-width),100%);max-width:100%;z-index:2147483000;font-family:var(--font);line-height:1.4;border-radius:0;display:flex;flex-direction:column;overflow:hidden;text-align:left;}
    #ar-main-panel a{text-decoration:none;}
    #ar-main-panel a:hover{text-decoration:underline;}
    .ar-view{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden;}
    .ar-diag-nav{display:flex;align-items:center;}
    .ar-btn-back{font-weight:600;}
    .ar-diag-body{display:flex;flex-direction:column;}
    .ar-diag-toolbar{padding:0;}
    .ar-diag-full-box{display:flex;flex-direction:column;gap:2px;}
    .ar-diag-footer{display:flex;align-items:center;justify-content:flex-start;padding:0;}
    .ar-diag-footer .ar-dropdown-menu{top:auto;bottom:calc(100% + 4px);right:auto;left:0;}
    .ar-header{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px;border-radius:11px;}
    .ar-brand{display:flex;align-items:baseline;min-width:0;}
    .ar-title{text-transform:none;white-space:nowrap;}
    .ar-header-right{display:flex;align-items:center;flex:0 1 auto;min-width:0;}
    .ar-lang-switcher{display:inline-flex;align-items:center;flex:none;}
    .ar-lang-btn{font-family:inherit;cursor:pointer;line-height:1;}
    .ar-lang-btn:focus-visible{outline-offset:1px;}
    .ar-lang-sep{color:var(--line);font-size:9px;user-select:none;}
    .ar-status{display:inline-flex;align-items:center;min-width:0;max-width:160px;white-space:nowrap;overflow:hidden;}
    #ar-status-text{overflow:hidden;text-overflow:ellipsis;}
    @keyframes ar-pulse{0%,100%{ opacity:1; transform:scale(1); } 50%{ opacity:.4; transform:scale(1.25); }}
    .ar-header-action{background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:inherit;}
    .ar-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;}
    .ar-scroll::-webkit-scrollbar{width:6px;}
    .ar-card{display:flex;flex-direction:column;position:relative;overflow:hidden;flex-shrink:0;}
    .ar-card-title{text-transform:uppercase;}
    #ar-mode-card{--ar-work-track-h:36px;--ar-work-track-pad:3px;--ar-work-thumb-w:44px;--ar-work-thumb-h:30px;--ar-work-thumb-duration:255ms;--ar-work-turbo-reveal-duration:380ms;--ar-work-turbo-exit-duration:220ms;--ar-work-shock-cycle-duration:5s;--ar-work-turbo-grid-duration:60s;--ar-work-grid-shift:-320px;--ar-work-move-ease:cubic-bezier(.22, .8, .3, 1);--thumb-source-x:0px;--thumb-center-x:50%;--ar-work-grid-cell:5px;--ar-work-grid-col-gap:2px;--ar-work-grid-row-gap:2px;}
    .ar-work-mode-header{display:flex;justify-content:space-between;}
    .ar-work-mode-title{display:flex;min-width:0;margin:0;font-size:13.5px;line-height:1.2;white-space:nowrap;}
    .ar-work-mode-title__label{text-transform:uppercase;}
    .ar-help-button{position:relative;flex:0 0 auto;display:grid;place-items:center;cursor:pointer;}
    .ar-help-button:hover{color:var(--ink);border-color:#94a3b8;background:rgba(0, 0, 0, 0.04);}
    .ar-help-button:focus-visible{outline-offset:2px;}
    .ar-work-mode-options{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;line-height:1;user-select:none;}
    .ar-work-mode-slider{position:relative;height:var(--ar-work-track-h);border-radius:11px;overflow:hidden;touch-action:none;user-select:none;cursor:pointer;isolation:isolate;perspective:800px;perspective-origin:var(--thumb-center-x, 50%) 50%;transform-style:preserve-3d;}
    .ar-work-mode-slider::before{content:"";position:absolute;inset:0;z-index:0;border-radius:11px;pointer-events:none;background:linear-gradient(90deg, rgba(255,255,255,.12), rgba(255,255,255,.025) 62%, transparent 100%);}
    .ar-work-mode-turbo-surface{position:absolute;inset:0;z-index:1;border-radius:11px;pointer-events:none;opacity:0;}
    .ar-work-mode-slider.has-turbo-grid .ar-work-mode-turbo-surface{will-change:opacity;}
    .ar-work-mode-slider.is-turbo .ar-work-mode-turbo-surface{opacity:1;}
    .ar-work-mode-grid-mask{position:absolute;inset:0;z-index:2;overflow:hidden;border-radius:11px;pointer-events:none;opacity:0;visibility:hidden;filter:blur(0);-webkit-mask-image:linear-gradient(
            to right,
            #000 0,
            #000 calc(var(--thumb-source-x, 0px) - 24px),
            transparent var(--thumb-source-x, 0px),
            transparent 100%
        );mask-image:linear-gradient(
            to right,
            #000 0,
            #000 calc(var(--thumb-source-x, 0px) - 24px),
            transparent var(--thumb-source-x, 0px),
            transparent 100%
        );transition:opacity var(--ar-work-turbo-exit-duration) ease,
            filter var(--ar-work-turbo-exit-duration) ease,
            visibility 0s linear var(--ar-work-turbo-exit-duration);}
    .ar-work-mode-slider.has-turbo-grid .ar-work-mode-grid-mask{will-change:opacity, filter;}
    .ar-work-mode-slider.is-turbo .ar-work-mode-grid-mask{visibility:visible;animation:ar-turbo-grid-fade-in calc(var(--ar-work-turbo-reveal-duration) + 80ms)
            cubic-bezier(.22, .72, .22, 1)
            1 both;transition:opacity var(--ar-work-turbo-reveal-duration) ease,
            filter var(--ar-work-turbo-reveal-duration) ease,
            visibility 0s linear 0s;}
    @keyframes ar-turbo-grid-fade-in{0% {
            opacity: 0;
            filter: blur(1.2px);
        }
        55% {
            opacity: .48;
            filter: blur(.45px);
        }
        100% {
            opacity: .62;
            filter: blur(0);
        }}
    .ar-work-mode-grid-strip{position:absolute;top:0;bottom:0;left:0;display:grid;grid-template-rows:repeat(5, var(--ar-work-grid-cell));grid-auto-flow:column;grid-auto-columns:var(--ar-work-grid-cell);align-content:center;column-gap:var(--ar-work-grid-col-gap);row-gap:var(--ar-work-grid-row-gap);width:max-content;transform:translate3d(0,0,0);}
    .ar-work-mode-slider.has-turbo-grid .ar-work-mode-grid-strip{will-change:transform;}
    .ar-work-mode-slider.is-turbo .ar-work-mode-grid-strip{animation:ar-turbo-grid-drift var(--ar-work-turbo-grid-duration) linear infinite;}
    @keyframes ar-turbo-grid-drift{from { transform: translate3d(0, 0, 0); }
        to { transform: translate3d(var(--ar-work-grid-shift), 0, 0); }}
    .ar-work-mode-grid-cell{--wave-boost:0;--wave-x:0px;--wave-y:0px;--wave-scale:1;width:var(--ar-work-grid-cell);height:var(--ar-work-grid-cell);clip-path:inset(0 round 1px);background:currentColor;opacity:calc(var(--cell-alpha, .15) + var(--wave-boost));transform:translate3d(
                var(--wave-x),
                var(--wave-y),
                0
            )
            scale(var(--wave-scale));transform-origin:center;}
    .ar-work-mode-slider.has-turbo-grid .ar-work-mode-grid-cell{will-change:transform, opacity;}
    .ar-work-mode-grid-cell.l0{--cell-alpha:0;}
    .ar-work-mode-grid-cell.l1{--cell-alpha:.10;}
    .ar-work-mode-grid-cell.l2{--cell-alpha:.20;}
    .ar-work-mode-grid-cell.l3{--cell-alpha:.35;}
    .ar-work-mode-grid-cell.l4{--cell-alpha:.55;}
    .ar-work-mode-grid-cell.l5{--cell-alpha:.75;}
    .ar-work-mode-snap-markers{position:absolute;z-index:3;top:50%;left:calc(var(--ar-work-track-pad) + var(--ar-work-thumb-w) / 2);right:calc(var(--ar-work-track-pad) + var(--ar-work-thumb-w) / 2);display:flex;align-items:center;justify-content:space-between;transform:translateY(-50%);pointer-events:none;}
    .ar-work-mode-snap-marker{width:3px;height:3px;flex:0 0 3px;clip-path:inset(0 round 1px);transition:opacity 100ms ease;}
    .ar-work-mode-slider:hover:not(.is-turbo) .ar-work-mode-snap-marker, .ar-work-mode-slider:focus-visible:not(.is-turbo) .ar-work-mode-snap-marker{opacity:.23;}
    .ar-work-mode-slider.is-turbo .ar-work-mode-snap-marker{opacity:0;}
    .ar-work-mode-thumb{position:absolute;z-index:5;top:var(--ar-work-track-pad);left:var(--ar-work-track-pad);width:var(--ar-work-thumb-w);height:var(--ar-work-thumb-h);transform:translate3d(0, 0, 0);transform-style:preserve-3d;transition:transform var(--ar-work-thumb-duration) var(--ar-work-move-ease);will-change:transform;pointer-events:none;}
    .ar-work-mode-slider.is-dragging .ar-work-mode-thumb{transition:none;}
    .ar-work-mode-thumb__shadow{position:absolute;inset:0;pointer-events:none;will-change:transform, box-shadow, opacity;transition:box-shadow 150ms ease;}
    .ar-work-mode-thumb__body{position:absolute;inset:0;border:1px solid rgba(92,105,122,.11);transform:translateZ(0);transform-style:preserve-3d;will-change:transform;transition:border-color 170ms ease,
            scale 100ms ease;pointer-events:none;}
    .ar-work-mode-slider.is-pressed .ar-work-mode-thumb__body{scale:.985;}
    .ar-work-mode-slider:focus{outline:none;}
    .ar-row{display:flex;align-items:center;justify-content:space-between;gap:10px;}
    .ar-row-label{flex:1;min-width:0;font-weight:500;line-height:1.4;}
    .ar-input{border:1px solid var(--line);background:var(--card);border-radius:10px;font-family:inherit;font-size:13px;color:var(--ink);transition:border-color .15s, box-shadow .15s;outline:none;}
    .ar-input:focus{border-color:var(--hh-blue);box-shadow:0 0 0 3px var(--hh-blue-soft);}
    .ar-input:hover:not(:focus){border-color:#cbd5e1;}
    .ar-input-num{flex:none;text-align:center;}
    .ar-input[type=number]{-moz-appearance:textfield;appearance:textfield;}
    .ar-input[type=number]::-webkit-outer-spin-button, .ar-input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
    .ar-textarea{width:100%;border:1px solid var(--line);background:var(--card);border-radius:11px;resize:vertical;font-family:inherit;color:var(--ink);transition:border-color .15s, box-shadow .15s, opacity .15s;}
    .ar-textarea:focus{outline:none;border-color:var(--hh-blue);box-shadow:0 0 0 3px var(--hh-blue-soft);}
    .ar-textarea:hover:not(:focus){border-color:#cbd5e1;}
    .ar-textarea:disabled{cursor:not-allowed;resize:none;}
    .ar-cover-counter.is-near{font-weight:700;}
    .ar-cover-counter.is-off{visibility:hidden;}
    .ar-switch-row{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;user-select:none;}
    .ar-switch-row-sub{padding-top:2px;}
    .ar-switch{position:relative;display:inline-block;flex:none;}
    .ar-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;z-index:1;}
    .ar-switch i{display:block;width:100%;height:100%;border-radius:7px;pointer-events:none;}
    .ar-switch i::after{content:"";position:absolute;}
    .ar-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font-family:inherit;line-height:1.15;cursor:pointer;white-space:nowrap;}
    .ar-btn:active{transform:translateY(1px);}
    .ar-btn:disabled{cursor:not-allowed;}
    .ar-btn:disabled:active{transform:none;}
    .ar-btn-cta{width:100%;box-shadow:0 2px 4px rgba(0,112,229,.18);}
    .ar-btn-soft{border:1px solid var(--line);}
    .ar-util-row{display:flex;align-items:center;justify-content:space-between;}
    .ar-util-btn{flex:1 1 0;min-width:0;font-size:11.5px;}
    .ar-progress{overflow:hidden;position:relative;}
    .ar-progress i{display:block;height:100%;width:0;border-radius:1.5px;position:relative;overflow:hidden;}
    .ar-stats{display:grid;}
    .ar-stat{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:0;text-align:center;}
    .ar-stat-num{line-height:1.1;font-variant-numeric:tabular-nums;}
    .ar-stat-cap{letter-spacing:.01em;}
    .ar-badge{display:inline-flex;align-items:center;justify-content:center;transition:all .15s ease;}
    .ar-badge-count{display:inline-flex;align-items:center;justify-content:center;font-weight:700;line-height:1;flex:none;margin-left:2px;}
    .ar-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}
    .ar-title-with-count{display:inline-flex;align-items:center;gap:6px;}
    .ar-manual{display:flex;flex-direction:column;}
    .ar-manual-item{display:flex;align-items:center;justify-content:space-between;gap:8px;}
    .ar-manual-main{flex:1 1 0;min-width:0;}
    .ar-manual-meta{display:flex;align-items:center;gap:4px;min-width:0;}
    .ar-manual-meta .ar-when{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .ar-vid{font-weight:600;flex:none;}
    .ar-manual-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .ar-manual-title.is-empty{font-weight:400;color:var(--ink-3);}
    .ar-manual-actions{margin-left:auto;}
    .ar-btn-open{font-size:11px;font-weight:600;}
    .ar-remove-btn{display:flex;align-items:center;justify-content:center;}
    .ar-queue-more-btn{width:100%;height:30px;font-size:11.5px;font-weight:600;margin-top:2px;}
    .ar-empty{text-align:center;font-size:11.5px;border:1px dashed var(--line);line-height:1.4;}
    .ar-dropdown{position:relative;display:inline-block;}
    .ar-dropdown-menu{display:none;position:absolute;right:0;top:calc(100% + 4px);z-index:100;flex-direction:column;gap:2px;}
    .ar-dropdown.is-open .ar-dropdown-menu{display:flex;}
    .ar-dropdown-item{display:flex;align-items:center;width:100%;font-size:11.5px;font-weight:500;text-align:left;cursor:pointer;}
    #ar-main-panel, #ar-toggle-btn{--hha-bg:#f5f7fa;--hha-surface:#ffffff;--hha-surface-hover:#f8fafc;--hha-surface-subtle:#f1f4f8;--hha-text:#18212f;--hha-text-secondary:#596578;--hha-text-muted:#626f80;--hha-border:#e2e7ee;--hha-border-strong:#ccd4df;--hha-accent:#6863b3;--hha-accent-hover:#5d58a6;--hha-accent-soft:#f0eff9;--hha-accent-ring:rgba(98,91,215,.17);--hha-turbo-deep:#4843ad;--hha-success:#0d6d4f;--hha-success-soft:#eaf8f2;--hha-warning:#955f0f;--hha-warning-soft:#fff7e8;--hha-danger:#c33448;--hha-danger-hover:#aa263a;--hha-danger-soft:#fff0f2;--hha-shadow-raised:0 12px 34px rgba(24,33,47,.12),0 2px 8px rgba(24,33,47,.06);--hha-shadow-focus:0 0 0 3px var(--hha-accent-ring);--hha-shadow-control-focus:0 0 0 3px rgba(98,91,215,.14);--hha-ease-standard:cubic-bezier(.2,.72,.3,1);--hha-ease-premium:cubic-bezier(.18,.82,.22,1);--hha-duration-fast:120ms;--hha-duration-medium:200ms;--hh-green:var(--hha-success);--hh-blue:var(--hha-accent);--hh-blue-hover:var(--hha-accent-hover);--hh-blue-soft:var(--hha-accent-soft);--ink:var(--hha-text);--ink-2:var(--hha-text-secondary);--ink-3:var(--hha-text-muted);--line:var(--hha-border);--line-2:#edf0f4;--card:var(--hha-surface);--bg:var(--hha-bg);--bg-2:var(--hha-surface-subtle);}
    #ar-main-panel{background:var(--hha-bg);color:var(--hha-text);border-left:1px solid var(--hha-border);box-shadow:-3px 0 12px rgba(24,33,47,.055);font-size:13px;}
    #ar-main-panel a{color:var(--hha-accent);}
    #ar-toggle-btn{width:32px;height:112px;padding:0;border:1px solid rgba(255,255,255,.20);border-right:0;border-radius:10px 0 0 10px;background:linear-gradient(155deg,#7471b4 0%,#6866aa 52%,#5d5998 100%);box-shadow:-1px 2px 5px rgba(20,30,45,.09);overflow:hidden;transition:background-position 180ms var(--hha-ease-premium),filter 180ms var(--hha-ease-premium),box-shadow 180ms var(--hha-ease-premium);}
    #ar-toggle-btn:hover{background:linear-gradient(155deg,#7b77bc 0%,#625fa6 54%,#57528f 100%);box-shadow:-1px 3px 7px rgba(20,30,45,.105);}
    #ar-toggle-btn:active{box-shadow:-1px 1px 3px rgba(20,30,45,.09);filter:brightness(.97);}
    #ar-toggle-btn:focus-visible{outline:2px solid #fff;outline-offset:-3px;box-shadow:-1px 2px 5px rgba(20,30,45,.09),0 0 0 3px rgba(98,91,215,.18);}
    #ar-toggle-btn .ar-tab-text{display:block;writing-mode:horizontal-tb;transform:rotate(-90deg);white-space:nowrap;font-size:11px;line-height:1;font-weight:750;letter-spacing:.035em;text-shadow:0 1px 1px rgba(44,40,91,.16);}
    @keyframes ar-tab-running-breathe{0%,100%{background-position:0% 50%;filter:brightness(1) saturate(.96);box-shadow:-2px 3px 7px rgba(69,64,137,.16),-1px 1px 3px rgba(20,30,45,.08);}50%{background-position:100% 50%;filter:brightness(1.075) saturate(1.08);box-shadow:-4px 5px 12px rgba(78,70,157,.24),-1px 2px 4px rgba(20,30,45,.10);}}
    #ar-toggle-btn.is-running{background:linear-gradient(125deg,#7772bb 0%,#5f5aa2 30%,#7b74c1 58%,#57528f 100%);background-size:230% 230%;animation:ar-tab-running-breathe 2.2s var(--hha-ease-standard) infinite;}
    #ar-toggle-btn.is-running .ar-tab-text{text-shadow:0 1px 2px rgba(42,37,91,.22),0 0 5px rgba(255,255,255,.13);}
    #ar-toggle-btn.is-running:hover{animation-play-state:paused;background-position:76% 50%;filter:brightness(1.065) saturate(1.04);}
    .ar-header{border-bottom:1px solid var(--hha-border);box-shadow:0 1px 0 rgba(24,33,47,.018);}
    .ar-brand{gap:7px;}
    .ar-title{font-size:14.5px;font-weight:720;letter-spacing:-.025em;color:var(--hha-text);}
    .ar-lang-switcher{gap:1px;padding:2px;}
    .ar-lang-sep{display:none;}
    .ar-lang-btn{min-width:26px;height:22px;padding:0 6px;font-size:10.5px;font-weight:750;transition:background var(--hha-duration-fast) var(--hha-ease-premium),color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium);}
    .ar-lang-btn:focus-visible{outline:none;box-shadow:var(--hha-shadow-control-focus);}
    .ar-header-action{border:1px solid transparent;color:var(--hha-text-muted);transition:background var(--hha-duration-fast) var(--hha-ease-premium),border-color var(--hha-duration-fast) var(--hha-ease-premium),color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium),transform var(--hha-duration-fast) var(--hha-ease-premium);}
    .ar-header-action:hover{background:var(--hha-surface-subtle);border-color:var(--hha-border);color:var(--hha-text);box-shadow:0 2px 6px rgba(24,33,47,.055);}
    .ar-header-action:active{background:#e9edf3;box-shadow:0 1px 2px rgba(24,33,47,.04);transform:translateY(0);}
    .ar-header-action:focus-visible{outline:none;box-shadow:var(--hha-shadow-control-focus);color:var(--hha-accent);}
    .ar-status{min-height:23px;padding:3px 8px;border-radius:7px;border:1px solid var(--hha-border);background:var(--hha-surface-subtle);color:var(--hha-text-secondary);font-size:10px;font-weight:650;}
    .ar-status--idle{background:var(--hha-surface-subtle);color:var(--hha-text-secondary);border-color:var(--hha-border);}
    .ar-status--running{background:var(--hha-accent-soft);color:var(--hha-accent);border-color:#d3d0e9;}
    .ar-status--stopped{background:var(--hha-danger-soft);color:var(--hha-danger);border-color:#f3cbd1;}
    .ar-status--error{background:var(--hha-warning-soft);color:var(--hha-warning);border-color:#f3dfb6;}
    .ar-status--done{background:var(--hha-success-soft);color:var(--hha-success);border-color:#c8e9dc;}
    .ar-scroll{padding:11px;gap:9px;scrollbar-color:#c8d0db transparent;}
    .ar-scroll::-webkit-scrollbar-thumb{background:#c8d0db;border-radius:2px;}
    .ar-card{padding:13px 14px;gap:10px;border:1px solid var(--hha-border);}
    .ar-card-title{font-size:11px;font-weight:750;color:var(--hha-text-secondary);}
    .ar-card-head{min-height:22px;}
    #ar-mode-card{border-color:#dce2ea;box-shadow:0 1px 2px rgba(24,33,47,.05),0 12px 28px rgba(24,33,47,.035);overflow:visible;}
    .ar-work-mode-header{align-items:center;gap:10px;}
    .ar-work-mode-title{align-items:center;gap:8px;}
    .ar-work-mode-title__label{font-size:11px;font-weight:780;letter-spacing:.065em;color:var(--hha-text-secondary);}
    .ar-help-wrap{position:relative;display:inline-flex;align-items:center;flex:0 0 auto;}
    .ar-help-button{width:22px;height:22px;padding:0;border:1px solid var(--hha-border-strong);border-radius:7px;background:var(--hha-surface);color:var(--hha-text-muted);transition:background var(--hha-duration-fast) var(--hha-ease-standard),border-color var(--hha-duration-fast) var(--hha-ease-standard),color var(--hha-duration-fast) var(--hha-ease-standard),box-shadow var(--hha-duration-fast) var(--hha-ease-standard);}
    .ar-help-button::before{content:"";position:absolute;inset:-3px;}
    .ar-help-button:hover,.ar-help-wrap.is-pinned .ar-help-button{background:var(--hha-accent-soft);border-color:#d1cee8;color:var(--hha-accent);}
    .ar-help-button:focus-visible{outline:none;box-shadow:var(--hha-shadow-focus);border-color:var(--hha-accent);}
    .ar-help-popover{position:absolute;z-index:120;top:calc(100% + 8px);right:0;width:min(276px,calc(100vw - 42px));padding:10px;border:1px solid var(--hha-border);border-radius:11px;background:rgba(255,255,255,.992);box-shadow:var(--hha-shadow-raised);opacity:0;visibility:hidden;transform:translateY(-3px);pointer-events:none;transition:opacity var(--hha-duration-medium) var(--hha-ease-standard),transform var(--hha-duration-medium) var(--hha-ease-standard),visibility 0s linear var(--hha-duration-medium);}
    .ar-help-wrap.is-open .ar-help-popover{opacity:1;visibility:visible;transform:translateY(0);pointer-events:auto;transition-delay:0s;}
    .ar-help-popover-title{display:block;margin:0 0 5px;font-size:11.5px;line-height:1.3;font-weight:760;color:var(--hha-text);}
    .ar-help-popover-copy{display:block;font-size:11px;line-height:1.45;color:var(--hha-text-secondary);}
    .ar-mode-help-item{display:grid;grid-template-columns:76px 1fr;gap:8px;align-items:start;padding:7px;border-radius:9px;}
    .ar-mode-help-item + .ar-mode-help-item{border-top:1px solid #f0f2f6;}
    .ar-mode-help-name{font-size:11px;line-height:1.35;font-weight:760;color:var(--hha-text);letter-spacing:.005em;}
    .ar-mode-help-copy{font-size:11px;line-height:1.35;color:var(--hha-text-secondary);font-variant-numeric:tabular-nums;}
    .ar-mode-help-item--turbo .ar-mode-help-name{color:var(--hha-turbo-deep);}
    .ar-mode-help-note{display:block;margin-top:5px;padding:7px;border-top:1px solid #edf0f4;color:var(--hha-text-muted);font-size:10.5px;line-height:1.42;}
    .ar-work-mode-options{margin-top:-1px;}
    .ar-work-mode-option{display:flex;align-items:center;justify-content:center;min-width:0;height:24px;padding:0 4px;border:1px solid transparent;border-radius:7px;font-size:10.5px;font-weight:620;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background var(--hha-duration-fast) var(--hha-ease-premium),border-color var(--hha-duration-fast) var(--hha-ease-premium),color var(--hha-duration-fast) var(--hha-ease-premium),font-weight var(--hha-duration-fast) var(--hha-ease-premium);}
    .ar-work-mode-option[data-mode="safe"]{background:#f2f4f7;border-color:#e2e6eb;color:#6a7585;}
    .ar-work-mode-option[data-mode="balanced"]{background:#f5f3fa;border-color:#e5e1ef;color:#686581;}
    .ar-work-mode-option[data-mode="fast"]{background:#efedf8;border-color:#dcd7ec;color:#5f5a91;}
    .ar-work-mode-option[data-mode="turbo"]{background:#e9e6f5;border-color:#cec8e6;color:#554f8d;}
    .ar-work-mode-option.is-active{font-weight:780;box-shadow:inset 0 0 0 1px rgba(92,86,160,.12),0 1px 2px rgba(24,33,47,.04);}
    .ar-work-mode-option[data-mode="safe"].is-active{background:#eceff3;border-color:#bdc6d2;color:#3f4b5b;}
    .ar-work-mode-option[data-mode="balanced"].is-active{background:#eeebf6;border-color:#c9c3df;color:#514d7e;}
    .ar-work-mode-option[data-mode="fast"].is-active{background:#e7e3f4;border-color:#bdb6da;color:#4f4989;}
    .ar-work-mode-option[data-mode="turbo"].is-active{background:#dfdaf0;border-color:#aaa2d0;color:#453f80;}
    .ar-work-mode-slider{background:linear-gradient(90deg,#e8ebf0 0%,#edf0f4 58%,#f0f2f5 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.8),inset 0 0 0 1px rgba(24,33,47,.035);}
    .ar-work-mode-slider:hover:not(.is-turbo){box-shadow:inset 0 1px 0 rgba(255,255,255,.86),inset 0 0 0 1px rgba(24,33,47,.055);}
    .ar-work-mode-turbo-surface{background:linear-gradient(90deg,rgba(98,91,215,.10) 0%,rgba(98,91,215,.20) 28%,rgba(103,91,220,.38) 56%,rgba(91,79,202,.64) 80%,rgba(72,67,173,.86) 100%);transition:opacity var(--ar-work-turbo-exit-duration) var(--hha-ease-standard);}
    .ar-work-mode-slider.is-turbo .ar-work-mode-turbo-surface{transition:opacity var(--ar-work-turbo-reveal-duration) var(--hha-ease-premium);}
    .ar-work-mode-grid-mask{color:#fff;}
    .ar-work-mode-slider.is-turbo .ar-work-mode-grid-mask{opacity:.58;}
    .ar-work-mode-snap-marker{background:#728094;opacity:.17;}
    .ar-work-mode-slider:hover:not(.is-turbo) .ar-work-mode-snap-marker,.ar-work-mode-slider:focus-visible:not(.is-turbo) .ar-work-mode-snap-marker{opacity:.27;}
    .ar-work-mode-slider:focus-visible{box-shadow:inset 0 1px 0 rgba(255,255,255,.75),inset 0 0 0 1px rgba(24,33,47,.04),0 0 0 3px var(--hha-accent-ring);}
    .ar-row-limit{padding-top:9px;border-top:1px solid #eef1f5;}
    .ar-row-label{font-size:12px;color:var(--hha-text-secondary);}
    .ar-input,.ar-textarea{border:1px solid var(--hha-border);background:var(--hha-surface);color:var(--hha-text);box-shadow:inset 0 1px 0 rgba(255,255,255,.72);transition:border-color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium),background var(--hha-duration-fast) var(--hha-ease-premium),opacity var(--hha-duration-fast) var(--hha-ease-premium);}
    .ar-input{padding:6px 9px;font-weight:700;}
    .ar-input-num{width:70px;height:32px;}
    .ar-input:hover:not(:focus),.ar-textarea:hover:not(:focus){border-color:var(--hha-border-strong);box-shadow:inset 0 1px 0 rgba(255,255,255,.82),0 1px 3px rgba(24,33,47,.035);}
    .ar-input:focus,.ar-textarea:focus{border-color:var(--hha-accent);box-shadow:var(--hha-shadow-control-focus),inset 0 1px 0 rgba(255,255,255,.78);}
    .ar-textarea{min-height:62px;padding:8px 10px;font-size:12px;line-height:1.48;}
    .ar-textarea::placeholder{color:#a1aab8;}
    .ar-textarea:disabled{opacity:.68;}
    .ar-cover-counter.is-near{color:var(--hha-warning);}
    .ar-card--settings{overflow:visible;}
    .ar-switch-row-sub{position:relative;}
    .ar-setting-label-group{display:flex;align-items:center;gap:6px;min-width:0;}
    .ar-setting-label-group .ar-row-label{flex:0 1 auto;min-width:0;}
    .ar-warning-help-wrap{position:static;}
    .ar-autosave-feedback{display:flex;align-items:center;gap:6px;min-height:16px;color:var(--hha-text-muted);font-size:11px;line-height:1.3;}
    .ar-autosave-feedback::before{content:"";width:5px;height:5px;flex:0 0 5px;border-radius:50%;background:#98a2b1;box-shadow:0 0 0 2px rgba(152,162,177,.09);transition:background var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium);}
    .ar-autosave-feedback.is-saved{color:#5e5a91;}
    .ar-autosave-feedback.is-saved::before{background:#7873b4;box-shadow:0 0 0 2px rgba(104,99,179,.11);}
    .ar-switch input:focus-visible + i{box-shadow:var(--hha-shadow-control-focus);}
    .ar-btn{min-height:34px;border-radius:10px;padding:0 13px;border:1px solid transparent;font-size:12px;font-weight:680;transition:background var(--hha-duration-fast) var(--hha-ease-premium),border-color var(--hha-duration-fast) var(--hha-ease-premium),color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium),transform var(--hha-duration-fast) var(--hha-ease-premium);}
    .ar-btn:not(:disabled):hover{transform:none;}
    .ar-btn:focus-visible{outline:none;box-shadow:var(--hha-shadow-control-focus);}
    .ar-btn:disabled{opacity:.46;}
    .ar-btn-cta{height:40px;border-radius:11px;font-size:13px;font-weight:720;}
    .ar-btn-primary{background:var(--hha-accent);color:#fff;box-shadow:0 4px 12px rgba(82,76,154,.16);}
    .ar-btn-primary:hover{background:var(--hha-accent-hover);box-shadow:0 6px 16px rgba(82,76,154,.21);}
    .ar-btn-danger{background:var(--hha-danger);color:#fff;box-shadow:0 4px 12px rgba(195,52,72,.15);}
    .ar-btn-danger:hover{background:var(--hha-danger-hover);box-shadow:0 6px 16px rgba(195,52,72,.20);}
    .ar-btn-soft{background:var(--hha-surface);color:var(--hha-text-secondary);border-color:var(--hha-border);box-shadow:inset 0 1px 0 rgba(255,255,255,.72);}
    .ar-btn-soft:hover{background:var(--hha-surface-hover);color:var(--hha-text);border-color:var(--hha-border-strong);box-shadow:inset 0 1px 0 rgba(255,255,255,.82),0 2px 6px rgba(24,33,47,.055);}
    .ar-btn-soft:active{box-shadow:inset 0 1px 2px rgba(24,33,47,.07),0 1px 2px rgba(24,33,47,.035);}
    .ar-btn-tertiary{background:var(--hha-surface-subtle);border:1px solid var(--hha-border);box-shadow:inset 0 1px 0 rgba(255,255,255,.46);}
    .ar-btn-tertiary:hover{background:#e9edf3;color:var(--hha-text);border-color:var(--hha-border-strong);box-shadow:0 2px 5px rgba(24,33,47,.045);}
    .ar-btn-tertiary:active{box-shadow:inset 0 1px 2px rgba(24,33,47,.06);}
    .ar-btn-sm{min-height:29px;padding:0 10px;font-size:11px;border-radius:9px;}
    .ar-util-row{gap:7px;}
    .ar-util-btn{height:31px;}
    .ar-progress{height:5px;background:#edf0f4;border-radius:1.5px;}
    .ar-progress i{background:linear-gradient(90deg,var(--hha-accent) 0%,#7771c3 100%);transition:width 300ms var(--hha-ease-standard);}
    .ar-stats{grid-template-columns:repeat(4,1fr);border:1px solid var(--hha-border);border-radius:11px;}
    .ar-stat{padding:7px 3px;gap:3px;}
    .ar-stat-num{font-size:16px;font-weight:780;color:var(--hha-text-muted);}
    .ar-stat-cap{font-size:10.5px;font-weight:650;color:var(--hha-text-muted);}
    .ar-stat.is-active-attempts .ar-stat-num{color:var(--hha-text);}
    .ar-stat.is-active-success .ar-stat-num{color:var(--hha-success);}
    .ar-stat.is-active-skip{background:transparent;border-color:transparent;}
    .ar-stat.is-active-skip .ar-stat-num{color:var(--hha-text-secondary);}
    .ar-badge{min-width:19px;height:19px;padding:0 6px;border:1px solid var(--hha-border);border-radius:6px;background:var(--hha-surface-subtle);color:var(--hha-text-secondary);font-size:10px;font-weight:700;}
    .ar-badge-count{min-width:17px;height:17px;padding:0 5px;border:1px solid #d7d3e9;border-radius:5px;background:var(--hha-accent-soft);color:var(--hha-accent);font-size:10px;}
    .ar-manual{gap:6px;}
    .ar-manual-item{padding:8px 9px 8px 10px;border:1px solid var(--hha-border);border-radius:11px;background:var(--hha-surface-subtle);transition:background var(--hha-duration-fast) var(--hha-ease-premium),border-color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium);}
    .ar-manual-item:hover{background:var(--hha-surface);border-color:var(--hha-border-strong);box-shadow:0 2px 7px rgba(24,33,47,.045);}
    .ar-manual-meta{color:var(--hha-text-muted);font-size:10.5px;}
    .ar-vid{color:var(--hha-text-muted);}
    .ar-manual-main{display:flex;flex-direction:column;justify-content:center;min-height:40px;}
    .ar-manual-meta{margin-bottom:3px;line-height:1.2;}
    .ar-manual-title{color:var(--hha-text);font-size:11.5px;font-weight:650;line-height:1.25;}
    .ar-manual-actions{flex:0 0 auto;align-self:center;display:flex;align-items:center;gap:10px;}
    .ar-btn-open, .ar-remove-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;align-self:center;vertical-align:middle;line-height:1;}
    .ar-btn-open{min-height:34px;height:34px;padding:0 16px;border-radius:10px;}
    .ar-btn-open > span{display:block;line-height:1;}
    .ar-remove-btn{width:34px;min-width:34px;height:34px;min-height:34px;padding:0;border-radius:10px;}
    .ar-empty{padding:15px 10px;border-color:var(--hha-border);border-radius:11px;background:var(--hha-surface-subtle);color:var(--hha-text-muted);}
    .ar-diag-body{background:var(--hha-bg);container-type:inline-size;}
    .ar-diag-nav{gap:8px;}
    .ar-diag-view-title{font-size:13px;font-weight:720;color:var(--hha-text);}
    .ar-btn-back{gap:5px;padding:0 9px 0 7px;line-height:1;}
    .ar-diag-full-box{border:1px solid #253247;border-radius:11px;background:#111927;color:#aab6c8;box-shadow:inset 0 1px 0 rgba(255,255,255,.025),0 8px 20px rgba(17,25,39,.08);}
    .ar-dropdown-menu{padding:5px;min-width:188px;border:1px solid var(--hha-border);border-radius:11px;}
    .ar-dropdown-item{padding:7px 9px;border-radius:9px;transition:background var(--hha-duration-fast) var(--hha-ease-premium),color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium);}
    .ar-dropdown-item:focus-visible{outline:none;box-shadow:var(--hha-shadow-control-focus);color:var(--hha-text);}
    .ar-dropdown-item--danger{color:var(--hha-danger);}
    .ar-diag-header{min-height:47px;}
    .ar-diag-nav{flex:1 1 auto;min-width:0;}
    .ar-btn-back .ar-icon-svg{width:15px;height:15px;}
    .ar-diag-header-actions{flex:0 0 auto;}
    .ar-diag-body{flex:1 1 auto;min-height:0;gap:8px;padding:10px 10px 12px;overflow:hidden;}
    .ar-diag-filter-row{display:grid;grid-template-columns:max-content minmax(0,1fr);align-items:center;gap:8px;min-width:0;}
    .ar-diag-filter-group{display:inline-flex;align-items:center;flex:0 0 auto;padding:2px;border:1px solid var(--hha-border);border-radius:9px;background:var(--hha-surface-subtle);}
    .ar-diag-filter-btn{display:inline-flex;align-items:center;gap:5px;height:27px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:var(--hha-text-muted);font-family:inherit;font-size:10.5px;font-weight:700;cursor:pointer;transition:background var(--hha-duration-fast) var(--hha-ease-premium),color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium);}
    .ar-diag-filter-btn:hover{color:var(--hha-text);}
    .ar-diag-filter-btn.is-active{background:var(--hha-surface);color:var(--hha-text);box-shadow:0 1px 3px rgba(24,33,47,.08);}
    .ar-diag-filter-btn:focus-visible{outline:none;box-shadow:var(--hha-shadow-control-focus);}
    .ar-diag-filter-count{min-width:16px;padding:1px 4px;border-radius:5px;background:rgba(92,104,128,.08);color:inherit;font-size:10px;line-height:1.25;text-align:center;font-variant-numeric:tabular-nums;transition:opacity .15s ease,background .15s ease,color .15s ease;}
    .ar-diag-filter-btn.is-active .ar-diag-filter-count{background:var(--hha-accent-soft);color:var(--hha-accent);}
    #ar-diag-filter-errors:not(.has-errors) .ar-diag-filter-count{opacity:1;background:rgba(92,104,128,.055);color:var(--hha-text-muted);box-shadow:none;}
    #ar-diag-filter-errors:not(.has-errors).is-active .ar-diag-filter-count{background:rgba(92,104,128,.055);color:var(--hha-text-muted);}
    #ar-diag-filter-errors.has-errors .ar-diag-filter-count{opacity:1;background:var(--hha-danger-soft);color:var(--hha-danger);}
    .ar-diag-search-wrap{position:relative;display:flex;align-items:center;flex:1 1 auto;min-width:0;height:32px;border:1px solid var(--hha-border);border-radius:9px;background:var(--hha-surface);transition:border-color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium);}
    .ar-diag-search-wrap:focus-within{border-color:var(--hha-accent);box-shadow:0 0 0 3px var(--hha-accent-soft);}
    .ar-diag-search-icon{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:24px;height:24px;margin-left:3px;color:var(--hha-text-muted);line-height:0;}
    .ar-diag-search-icon .ar-icon-svg{width:14px;height:14px;}
    .ar-diag-search{width:100%;min-width:0;height:100%;padding:0 30px 0 6px;border:0;outline:0;background:transparent;color:var(--hha-text);font-family:inherit;font-size:11px;}
    .ar-diag-search::-webkit-search-cancel-button{display:none;}
    .ar-diag-search::placeholder{color:var(--hha-text-muted);}
    .ar-diag-search-clear{position:absolute;right:2px;top:50%;transform:translateY(-50%);width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--hha-text-muted);font-family:inherit;line-height:0;cursor:pointer;}
    .ar-diag-search-clear[hidden]{display:none;}
    .ar-diag-search-clear .ar-icon-svg{width:13px;height:13px;}
    .ar-diag-search-clear:hover{background:var(--hha-surface-subtle);color:var(--hha-text);}
    .ar-diag-toolbar{min-height:34px;display:grid;grid-template-columns:minmax(0,1fr) max-content;align-items:center;gap:6px 3px;padding-block:0;}
    .ar-diag-check-zone{display:flex;align-items:center;gap:3px;min-width:0;}
    .ar-diag-check-btn{min-width:0;padding-inline:10px;}
    .ar-diag-check-status{display:inline-flex;align-items:center;flex:0 0 auto;gap:2px;height:21px;white-space:nowrap;}
    .ar-diag-check-status:empty{display:none;}
    .ar-diag-check-progress{color:var(--hha-text-muted);font-size:10.5px;line-height:1;font-weight:700;font-variant-numeric:tabular-nums;}
    .ar-diag-check-ok{display:inline-flex;align-items:center;height:21px;padding:0 6px;border-radius:6px;background:rgba(31,142,102,.08);color:var(--hha-success);font-size:10.5px;line-height:1;font-weight:750;}
    .ar-diag-autoscroll{display:inline-flex;align-items:center;justify-self:end;gap:4px;min-height:34px;color:var(--hha-text-muted);font-size:10.5px;line-height:1.2;font-weight:650;cursor:pointer;user-select:none;white-space:nowrap;}
    .ar-diag-footer-actions{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;min-width:0;}
    .ar-diag-footer-actions > *{min-width:0;}
    .ar-diag-save-btn,.ar-diag-more-btn{width:100%;min-width:0;height:32px;padding-inline:9px;font-size:11px;letter-spacing:0;}
    .ar-diag-full-dropdown{display:block;min-width:0;}
    .ar-diag-full-box{flex:1 1 0;height:auto;min-height:120px;max-height:none;padding:5px 10px 5px 0;border-color:#26344a;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:#465870 #0d1725;font-family:inherit;font-size:10.5px;line-height:1.35;}
    .ar-diag-full-box::-webkit-scrollbar{width:9px;}
    .ar-diag-full-box::-webkit-scrollbar-button,.ar-diag-full-box::-webkit-scrollbar-button:single-button{-webkit-appearance:none;appearance:none;display:none;width:0;height:0;background:transparent;}
    .ar-diag-full-box::-webkit-scrollbar-button:vertical:start:decrement,.ar-diag-full-box::-webkit-scrollbar-button:vertical:end:increment{display:none!important;width:0!important;height:0!important;max-height:0!important;border:0!important;background:#0d1725!important;background-image:none!important;}
    .ar-diag-full-box::-webkit-scrollbar-track{background:#0d1725;border-left:1px solid rgba(148,163,184,.06);border-radius:0;}
    .ar-diag-full-box::-webkit-scrollbar-thumb{background:#465870;border:2px solid #0d1725;border-radius:999px;}
    .ar-diag-full-box::-webkit-scrollbar-thumb:hover{background:#5b6d86;}
    .ar-diag-full-box:focus-visible{outline:none;box-shadow:inset 0 0 0 1px rgba(129,140,248,.42),0 0 0 2px rgba(129,140,248,.11);}
    .ar-log-row{display:grid;grid-template-columns:max-content max-content minmax(0,1fr) max-content;align-items:start;column-gap:6px;row-gap:3px;padding:6px 9px;border-bottom:1px solid rgba(148,163,184,.075);color:#c0cad8;}
    .ar-log-row:last-child{border-bottom:0;}
    .ar-log-row:hover{background:rgba(148,163,184,.045);}
    .ar-log-row.is-error{background:rgba(255,90,110,.035);}
    .ar-log-row.is-warning{background:rgba(245,158,11,.025);}
    .ar-log-time{color:#8796aa;font-family:"SFMono-Regular",ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;white-space:nowrap;font-variant-numeric:tabular-nums;}
    .ar-log-level{display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:18px;padding:0 5px;border-radius:5px;font-size:10px;line-height:1;font-weight:800;letter-spacing:.035em;background:rgba(71,126,204,.13);color:#8bb9ff;text-transform:uppercase;}
    .ar-log-level--ok{background:rgba(52,211,153,.11);color:#72ddb9;}
    .ar-log-level--warn{background:rgba(245,158,11,.12);color:#f6c66c;}
    .ar-log-level--err{background:rgba(255,100,120,.15);color:#ff8797;}
    .ar-log-message{min-width:0;color:#bec8d7;overflow-wrap:anywhere;word-break:normal;white-space:pre-wrap;}
    .ar-log-row.is-error .ar-log-message{color:#ffc1ca;}
    .ar-log-row.is-warning .ar-log-message{color:#f6dbad;}
    .ar-log-repeat{align-self:center;min-width:34px;width:max-content;height:24px;padding:0 7px;border:1px solid rgba(148,163,184,.16);border-radius:999px;background:rgba(148,163,184,.07);color:#9aa9bd;font-family:inherit;font-size:10.5px;font-weight:800;cursor:pointer;font-variant-numeric:tabular-nums;}
    .ar-log-repeat:hover{border-color:rgba(165,180,252,.34);background:rgba(129,140,248,.11);color:#c7ccff;}
    .ar-log-repeat:focus-visible{outline:1px solid #9ca3ff;outline-offset:1px;}
    .ar-log-group-children{margin:0 8px 5px 121px;border-left:1px solid rgba(148,163,184,.15);}
    .ar-log-child{display:flex;gap:8px;padding:3px 7px;color:#8796aa;font-size:10.5px;}
    .ar-log-child-time{flex:0 0 66px;color:#8796aa;font-family:"SFMono-Regular",ui-monospace,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;}
    .ar-log-empty{display:flex;align-items:center;justify-content:center;height:100%;min-height:100%;padding:28px;color:#8796aa;text-align:center;}
    .ar-log-empty-inner{display:flex;flex-direction:column;align-items:center;gap:8px;max-width:240px;}
    .ar-log-empty-icon{width:48px;height:48px;margin-bottom:2px;color:#63738a;opacity:.72;}
    .ar-log-empty-icon svg{display:block;width:100%;height:100%;}
    .ar-log-empty-title{font-size:12.5px;line-height:1.25;font-weight:750;color:#b8c3d2;}
    .ar-log-empty-hint{max-width:220px;color:#8796aa;font-size:10.5px;line-height:1.5;}
    .ar-diag-full-dropdown .ar-dropdown-menu{right:0;left:auto;top:auto;bottom:calc(100% + 5px);}
    @media (max-height:720px){
      .ar-diag-body{gap:5px;padding-top:8px;padding-bottom:8px;}
      .ar-diag-full-box{min-height:88px;}
    }
    @media (max-width:420px){
      .ar-work-mode-popover{width:min(272px,calc(100vw - 42px));}
    }
    #ar-main-panel, #ar-toggle-btn{--hha-flat-border:#d6dde6;--hha-flat-border-hover:#c2cbd6;--hha-flat-border-active:#b9c3cf;--hha-flat-surface:#ffffff;--hha-flat-surface-hover:#f7f9fb;--hha-flat-surface-active:#eef2f6;--hha-flat-violet:#6964b8;--hha-flat-violet-hover:#625dae;--hha-flat-violet-active:#5b56a4;--hha-flat-violet-deep:#56518f;--hha-shadow-level-1:0 1px 2px rgba(20,30,45,.055);--hha-shadow-level-1-hover:0 1px 3px rgba(20,30,45,.07);--hha-focus-ring:0 0 0 3px rgba(98,91,215,.16);--hha-focus-ring-strong:0 0 0 3px rgba(98,91,215,.19);}
    .ar-btn, .ar-header-action, .ar-lang-btn, .ar-dropdown-item, .ar-help-button{transition-property:background-color,background,border-color,color,box-shadow,transform;transition-duration:150ms;transition-timing-function:var(--hha-ease-premium);}
    .ar-btn:not(:disabled):hover, .ar-header-action:hover, .ar-lang-btn:hover, .ar-dropdown-item:hover, .ar-help-button:hover{transform:none;}
    .ar-btn:not(:disabled):active{transform:translateY(1px);}
    .ar-header-action:active, .ar-lang-btn:active, .ar-dropdown-item:active, .ar-help-button:active{transform:none;}
    .ar-btn-soft, .ar-btn-tertiary{border:1px solid var(--hha-flat-border);background:var(--hha-flat-surface);color:#4f5b6b;box-shadow:var(--hha-shadow-level-1);}
    .ar-btn-soft:hover, .ar-btn-tertiary:hover{border-color:var(--hha-flat-border-hover);background:var(--hha-flat-surface-hover);color:var(--hha-text);box-shadow:var(--hha-shadow-level-1-hover);}
    .ar-btn-soft:active, .ar-btn-tertiary:active{border-color:var(--hha-flat-border-active);background:var(--hha-flat-surface-active);box-shadow:none;}
    .ar-btn-tertiary{border-style:solid;color:#5c6776;}
    #ar-start-btn{color:#fff;border:1px solid var(--hha-flat-violet-deep);background:var(--hha-flat-violet);text-shadow:none;box-shadow:0 2px 4px rgba(74,68,145,.12),0 1px 1px rgba(20,30,45,.04);}
    #ar-start-btn:hover{border-color:#514d88;background:var(--hha-flat-violet-hover);box-shadow:0 3px 6px rgba(74,68,145,.14),0 1px 2px rgba(20,30,45,.04);}
    #ar-start-btn:active{border-color:#4d4982;background:var(--hha-flat-violet-active);box-shadow:0 1px 2px rgba(74,68,145,.10);transform:translateY(1px);}
    #ar-stop-btn{color:#925267;border:1px solid #d7b4be;background:#fff;text-shadow:none;box-shadow:var(--hha-shadow-level-1);}
    #ar-stop-btn:hover{color:#84475b;border-color:#c99ca9;background:#fff8fa;box-shadow:var(--hha-shadow-level-1-hover);}
    #ar-stop-btn:active{color:#7e4053;border-color:#c08f9d;background:#f8eef1;box-shadow:none;transform:translateY(1px);}
    .ar-btn-open{color:#57538f;border:1px solid #d1cfe5;background:#f6f5fb;box-shadow:var(--hha-shadow-level-1);}
    .ar-btn-open:hover{color:#4e4a84;border-color:#bfbcda;background:#efedf8;box-shadow:var(--hha-shadow-level-1-hover);}
    .ar-btn-open:active{color:#49457d;border-color:#b4b0d1;background:#e9e7f3;box-shadow:none;transform:translateY(1px);}
    .ar-input, .ar-textarea{border:1px solid var(--hha-flat-border);background:#fff;color:var(--hha-text);box-shadow:var(--hha-shadow-level-1);}
    .ar-input:hover:not(:focus), .ar-textarea:hover:not(:focus){border-color:var(--hha-flat-border-hover);background:#fff;box-shadow:var(--hha-shadow-level-1-hover);}
    .ar-input:focus, .ar-textarea:focus{outline:none;border-color:#8c87d0;background:#fff;box-shadow:var(--hha-shadow-level-1);}
    .ar-input:focus-visible, .ar-textarea:focus-visible{border-color:#6c66bf;box-shadow:var(--hha-focus-ring),var(--hha-shadow-level-1);}
    .ar-textarea:disabled{border-color:#e0e5eb;background:#f3f5f8;box-shadow:none;}
    .ar-switch{width:38px;height:22px;}
    .ar-switch i{position:relative;overflow:hidden;border:1px solid #c4ccd6;background:linear-gradient(180deg,#dfe4ea 0%,#d6dde5 100%);box-shadow:inset 0 1px 2px rgba(35,47,63,.10),inset 0 -1px 0 rgba(255,255,255,.62);transition:background 180ms var(--hha-ease-premium),border-color 180ms var(--hha-ease-premium),box-shadow 150ms var(--hha-ease-premium);}
    .ar-switch i::after{box-sizing:border-box;top:2px;left:2px;width:16px;height:16px;border-radius:5px;transform:translateX(0);border:1px solid rgba(197,205,215,.78);background:linear-gradient(180deg,#fff 0%,#fafbfc 100%);box-shadow:0 1px 2px rgba(20,30,45,.16),0 2px 4px rgba(20,30,45,.06);transition:transform 180ms var(--hha-ease-premium),box-shadow 150ms var(--hha-ease-premium),background 150ms var(--hha-ease-premium);}
    .ar-switch-row:hover .ar-switch i{border-color:#b5bfcb;background:linear-gradient(180deg,#dbe1e7 0%,#d1d9e1 100%);box-shadow:inset 0 1px 2px rgba(35,47,63,.12),inset 0 -1px 0 rgba(255,255,255,.66);}
    .ar-switch-row:hover .ar-switch i::after{box-shadow:0 1px 3px rgba(20,30,45,.17),0 2px 5px rgba(20,30,45,.07);}
    .ar-switch input:checked + i{border-color:#5c579d;background:linear-gradient(180deg,#7470b7 0%,#6662aa 100%);box-shadow:inset 0 1px 2px rgba(47,42,102,.18),inset 0 -1px 0 rgba(255,255,255,.13);}
    .ar-switch-row:hover .ar-switch input:checked + i{border-color:#514c8c;background:linear-gradient(180deg,#716cb4 0%,#5e599f 100%);}
    .ar-switch input:checked + i::after{transform:translateX(16px);}
    .ar-switch input:active + i{box-shadow:inset 0 2px 3px rgba(35,47,63,.14);}
    .ar-switch input:active + i::after{background:#fafbfc;box-shadow:0 1px 2px rgba(20,30,45,.10);transform:translateX(0) scale(.96);}
    .ar-switch input:checked:active + i::after{transform:translateX(16px) scale(.96);}
    .ar-switch input:focus-visible + i, .ar-switch input:checked:focus-visible + i{box-shadow:var(--hha-focus-ring);}
    .ar-lang-switcher{border:1px solid #d8dfe7;background:#eef2f6;box-shadow:none;}
    .ar-lang-btn{border:1px solid transparent;background:transparent;color:#5f6b7a;box-shadow:none;}
    .ar-lang-btn:hover{border-color:transparent;background:#f7f9fb;color:#4d5969;box-shadow:none;}
    .ar-lang-btn:active{border-color:transparent;background:#e6ebf0;box-shadow:none;}
    .ar-lang-btn.is-active{border-color:#d7dee7;background:#fff;color:#263344;box-shadow:var(--hha-shadow-level-1);}
    .ar-header-action, .ar-help-button{border:1px solid var(--hha-flat-border);background:#fff;color:#687486;box-shadow:var(--hha-shadow-level-1);}
    .ar-header-action:hover, .ar-help-button:hover{border-color:var(--hha-flat-border-hover);background:var(--hha-flat-surface-hover);color:#2f3b4b;box-shadow:var(--hha-shadow-level-1-hover);}
    .ar-header-action:active, .ar-help-button:active{border-color:var(--hha-flat-border-active);background:var(--hha-flat-surface-active);box-shadow:none;}
    .ar-remove-btn{border:1px solid var(--hha-flat-border);background:#fff;color:#8a7680;box-shadow:var(--hha-shadow-level-1);}
    .ar-remove-btn:hover{border-color:#d8b8c0;background:#fff5f7;color:#a03f56;box-shadow:var(--hha-shadow-level-1-hover);transform:none;}
    .ar-remove-btn:active{border-color:#cca4af;background:#f8e8ec;box-shadow:none;transform:translateY(1px);}
    .ar-dropdown-menu{border-color:#d3dbe4;background:#fff;box-shadow:0 4px 12px rgba(20,30,45,.09),0 1px 2px rgba(20,30,45,.04);}
    .ar-dropdown-item{border:1px solid transparent;background:transparent;color:#596577;box-shadow:none;}
    .ar-dropdown-item:hover{border-color:transparent;background:#f2f5f8;color:#253244;box-shadow:none;}
    .ar-dropdown-item:active{background:#e8edf2;box-shadow:none;}
    .ar-dropdown-item--danger:hover{background:#fff1f3;color:var(--hha-danger-hover);}
    #ar-clear-manual, #ar-reset-history{color:#97485b;border-color:#dfc3ca;background:#fff;}
    #ar-clear-manual:hover, #ar-reset-history:hover{color:#873c50;border-color:#d4aeb8;background:#fff7f8;}
    #ar-clear-manual:focus-visible, #ar-reset-history:focus-visible{box-shadow:0 0 0 3px rgba(195,52,72,.13);}
    .ar-btn:focus-visible, .ar-header-action:focus-visible, .ar-lang-btn:focus-visible, .ar-dropdown-item:focus-visible, .ar-help-button:focus-visible{outline:none;box-shadow:var(--hha-focus-ring);}
    #ar-start-btn:focus-visible{box-shadow:var(--hha-focus-ring-strong),0 2px 4px rgba(74,68,145,.12);}
    #ar-stop-btn:focus-visible, .ar-btn-open:focus-visible{box-shadow:var(--hha-focus-ring),var(--hha-shadow-level-1);}
    .ar-work-mode-slider::after{content:"";position:absolute;z-index:4;top:0;bottom:0;left:0;width:19%;border-radius:11px;pointer-events:none;opacity:0;background:linear-gradient(90deg,
            rgba(235,238,243,.78) 0%,
            rgba(235,237,244,.61) 24%,
            rgba(231,232,244,.38) 48%,
            rgba(225,222,246,.17) 72%,
            rgba(225,222,246,0) 100%);transition:opacity var(--ar-work-turbo-reveal-duration) var(--hha-ease-premium);}
    .ar-work-mode-slider.is-turbo::after{opacity:1;}
    .ar-card:hover{transform:none;}
    .ar-stat{transition:none;}
    .ar-stat:hover{background:inherit;border-color:transparent;box-shadow:none;transform:none;}
    .ar-stat.is-active-success:hover{background:var(--hha-success-soft);border-color:#d0ebe0;}
    #ar-main-panel, #ar-toggle-btn{--hha-control-accent:#6866aa;}
    .ar-card{border-radius:11px;border-color:#d7dee7;background:linear-gradient(180deg,#fff 0%,#fdfefe 58%,#fafbfd 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,1),
            inset 0 -1px 0 rgba(76,89,106,.028),
            0 1px 2px rgba(24,33,47,.045),
            0 7px 18px rgba(24,33,47,.026);}
    .ar-card-title{letter-spacing:.05em;}
    .ar-header{min-height:47px;padding:9px 12px 9px 14px;background:rgba(252,253,254,.975);border-bottom-color:#dfe5ec;}
    .ar-header-right{gap:6px;}
    .ar-lang-switcher{border-radius:9px;}
    .ar-lang-btn{border-radius:7px;}
    .ar-header-action{border-radius:9px;}
    .ar-scroll--content{padding:10px 11px 9px;gap:9px;overscroll-behavior:contain;}
    .ar-card--settings, .ar-card--stats, .ar-card--manual{flex-shrink:0;}
    .ar-manual-toolbar{display:flex;gap:6px;}
    .ar-stat{border-radius:11px;}
    .ar-header-action{width:auto;min-width:0;height:28px;padding:0 9px;font-size:10.5px;font-weight:650;line-height:1;}
    .ar-help-button{font-size:0;line-height:0;}
    .ar-status{gap:0;}
    .ar-btn-open{gap:0;}
    .ar-remove-btn{width:auto;min-width:0;padding:0 10px;font-size:10.5px;font-weight:650;line-height:1;}
    .ar-stats{gap:3px;padding:4px;border-color:#d3dbe5;background:linear-gradient(180deg,#eef2f6 0%,#f3f6f9 100%);box-shadow:inset 0 2px 5px rgba(35,47,63,.055),inset 0 1px 0 rgba(255,255,255,.54);}
    .ar-stat{min-height:52px;border:1px solid transparent;background:transparent;}
    .ar-stat.is-active-success{background:linear-gradient(180deg,#f4fbf8 0%,var(--hha-success-soft) 100%);border-color:#d0e9df;box-shadow:inset 0 1px 0 rgba(255,255,255,.76);}
    .ar-stat.is-active-manual{background:linear-gradient(180deg,#f8f8fd 0%,#f0f0fa 100%);border-color:#dcdced;box-shadow:inset 0 1px 0 rgba(255,255,255,.8);}
    .ar-stat.is-active-manual .ar-stat-num{color:var(--hha-control-accent);}
    .ar-execution-shell{position:relative;z-index:20;flex:0 0 auto;padding:7px 11px 11px;border-radius:11px;border-top:1px solid rgba(215,222,231,.78);background:linear-gradient(180deg,rgba(248,250,252,.70) 0%,rgba(248,250,252,.97) 18%,var(--hha-bg) 100%);box-shadow:0 -9px 20px rgba(24,33,47,.025);}
    .ar-execution-shell::before{content:"";position:absolute;left:11px;right:11px;top:-8px;height:14px;pointer-events:none;background:linear-gradient(180deg,rgba(248,250,252,0),rgba(248,250,252,.92));}
    #ar-mode-card.ar-execution-core{position:relative;z-index:1;padding:12px 13px 11px;gap:8px;overflow:visible;border-radius:11px;border-color:#cfd8e4;background:linear-gradient(180deg,#ffffff 0%,#fdfefe 46%,#f8fafc 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,1),
            inset 0 -1px 0 rgba(77,89,108,.045),
            0 2px 4px rgba(24,33,47,.055),
            0 10px 24px rgba(49,54,88,.055);transition:border-color 220ms var(--hha-ease-premium),
            box-shadow 220ms var(--hha-ease-premium),
            background 220ms var(--hha-ease-premium);}
    #ar-mode-card.ar-execution-core.is-running{border-color:#bebee0;background:linear-gradient(180deg,#fff 0%,#fdfdff 45%,#f7f7fc 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,1),
            inset 0 -1px 0 rgba(92,88,167,.055),
            0 2px 4px rgba(24,33,47,.055),
            0 11px 26px rgba(76,72,145,.09);}
    #ar-mode-card.ar-execution-core[data-mode="turbo"]{border-color:#c9c5ec;box-shadow:inset 0 1px 0 rgba(255,255,255,1),
            inset 0 -1px 0 rgba(98,91,215,.07),
            0 2px 4px rgba(24,33,47,.055),
            0 11px 28px rgba(84,77,171,.09);}
    .ar-execution-core .ar-help-popover{top:auto;bottom:calc(100% + 8px);transform:translateY(3px);}
    .ar-execution-core .ar-help-wrap.is-open .ar-help-popover{transform:translateY(0);}
    .ar-execution-limit{padding-top:8px;border-top:1px solid #e9edf2;}
    .ar-execution-limit .ar-row-label{font-size:11.5px;font-weight:590;color:#647083;}
    .ar-execution-limit .ar-input-num{width:68px;height:30px;border-radius:9px;}
    .ar-execution-runtime{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:24px;}
    .ar-execution-runtime .ar-status{min-height:22px;max-width:none;padding:3px 8px;background:#f1f4f7;border-color:#d4dce6;box-shadow:none;}
    .ar-execution-core.is-running .ar-status--running{color:#5c5998;border-color:#cecee6;background:#f1f0fa;}
    .ar-execution-count{height:22px;border-radius:7px;min-width:50px;padding:0 8px;border-color:#d4dce6;background:#fff;color:#596577;box-shadow:0 1px 2px rgba(20,30,45,.04);font-variant-numeric:tabular-nums;}
    .ar-execution-progress{height:4px;border-radius:1px;background:#e8ecf1;box-shadow:none;opacity:.72;transition:opacity 180ms var(--hha-ease-premium),background 180ms var(--hha-ease-premium);}
    .ar-execution-progress i{border-radius:1px;background:linear-gradient(90deg,#7773b4 0%,#6866aa 58%,#625bd7 100%);box-shadow:none;}
    .ar-execution-core.is-running .ar-execution-progress{opacity:1;background:#e4e5ed;}
    .ar-execution-actions{display:flex;flex-direction:column;gap:7px;}
    .ar-execution-actions #ar-start-btn, .ar-execution-actions #ar-stop-btn{border-radius:11px;}
    .ar-execution-utils{gap:7px;}
    .ar-execution-utils .ar-util-btn{height:30px;min-height:30px;border-radius:9px;}
    .ar-sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important;}
    .ar-cover-editor{position:relative;}
    .ar-cover-editor .ar-textarea{display:block;padding-right:64px;padding-bottom:18px;}
    .ar-cover-editor .ar-cover-counter{position:absolute;right:12px;bottom:6px;z-index:1;line-height:1;pointer-events:none;}
    .ar-card--stats{padding:0;border:0;background:transparent;box-shadow:none;overflow:visible;}
    .ar-card--stats .ar-stats{min-height:58px;}
    .ar-execution-meta{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:8px;border-top:1px solid #e9edf2;}
    .ar-execution-meta .ar-execution-runtime{flex:0 0 auto;min-height:0;}
    .ar-execution-meta .ar-execution-limit{flex:0 1 auto;min-width:0;padding-top:0;border-top:0;gap:7px;}
    .ar-execution-meta .ar-execution-limit .ar-row-label{flex:0 1 auto;min-width:0;white-space:nowrap;font-size:10.5px;}
    .ar-execution-meta .ar-execution-limit .ar-input-num{width:60px;}
    .ar-work-mode-thumb__body{border-radius:9px;border-color:rgba(72,84,100,.14);background:#fff;box-shadow:none;}
    .ar-work-mode-slider.is-turbo .ar-work-mode-thumb__body{border-color:rgba(98,91,215,.30);background:#fbfaff;box-shadow:none;}
    .ar-work-mode-thumb__shadow{border-radius:9px;box-shadow:0 2px 5px rgba(20,30,45,.09),0 1px 2px rgba(20,30,45,.05);}
    .ar-work-mode-slider:hover .ar-work-mode-thumb__shadow{box-shadow:0 3px 6px rgba(20,30,45,.10),0 1px 2px rgba(20,30,45,.05);}
    /* Canonical icon sizing and narrow-control containment. */
    #ar-main-panel{border-radius:0;}
    #ar-main-panel > .ar-view > .ar-header{border-radius:0;}
    .ar-icon-only{display:inline-flex;align-items:center;justify-content:center;padding:0;white-space:nowrap;}
    .ar-icon-svg{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;line-height:0;flex:none;pointer-events:none;}
    .ar-icon-svg svg{display:block;width:100%;height:100%;}
    .ar-icon-svg--trash{transform:translateY(-.25px);}
    .ar-header-action.ar-icon-only{width:28px;min-width:28px;height:28px;padding:0;font-size:0;}
    .ar-help-button.ar-icon-only{width:22px;min-width:22px;height:22px;padding:0;font-size:0;}
    .ar-help-button.ar-icon-only .ar-icon-svg{width:14px;height:14px;}
    .ar-remove-btn.ar-icon-only{width:34px;min-width:34px;height:34px;min-height:34px;padding:0;font-size:0;}
    .ar-remove-btn.ar-icon-only .ar-icon-svg{width:14px;height:14px;}
    .ar-brand{flex:1 1 auto;min-width:0;overflow:hidden;}
    .ar-title{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;}
    .ar-header-right{flex:0 0 auto;}
    .ar-card-head{min-width:0;}
    .ar-title-with-count{flex:1 1 auto;min-width:0;overflow:hidden;}
    .ar-title-with-count .ar-card-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .ar-title-with-count .ar-badge{flex:0 0 auto;}
    .ar-manual-toolbar{flex:0 0 auto;min-width:0;}
    .ar-manual-item{min-width:0;}
    .ar-manual-actions{min-width:0;gap:8px;}
    .ar-btn-open{max-width:84px;overflow:hidden;text-overflow:ellipsis;}
    .ar-stat-cap{display:block;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-inline:2px;}
    .ar-switch-row > .ar-card-title, .ar-switch-row > .ar-row-label{min-width:0;overflow-wrap:anywhere;}
    .ar-work-mode-header{align-items:center;gap:8px;}
    .ar-work-mode-title{flex:1 1 auto;min-width:0;align-items:center;gap:7px;overflow:hidden;}
    .ar-work-mode-title__label{min-width:0;overflow:hidden;text-overflow:ellipsis;}
    .ar-execution-runtime{min-width:0;}
    .ar-execution-meta .ar-execution-limit{flex:0 1 auto;}
    .ar-execution-actions .ar-btn > span, .ar-manual-toolbar .ar-btn{min-width:0;overflow:hidden;text-overflow:ellipsis;}
    .ar-diag-header .ar-diag-nav{overflow:hidden;}
    .ar-diag-view-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .ar-diag-filter-row{gap:8px;}
    .ar-diag-filter-group{min-width:0;}
    .ar-diag-filter-btn{min-width:0;}
    .ar-diag-filter-btn > span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .ar-diag-filter-count{flex:0 0 auto;}
    .ar-diag-search-wrap{min-width:118px;}
    .ar-diag-toolbar{align-items:center;gap:6px 3px;}
    .ar-diag-check-zone{overflow:hidden;}
    .ar-diag-check-btn{flex:0 1 auto;max-width:150px;overflow:hidden;text-overflow:ellipsis;}
    .ar-diag-check-status{min-width:0;overflow:hidden;}
    .ar-diag-more-btn{overflow:visible;}
    .ar-diag-more-btn > span{display:block;max-width:100%;line-height:1;white-space:nowrap;}
    .ar-diag-check-zone{flex-wrap:wrap;overflow:visible;}
    .ar-diag-check-btn,.ar-diag-save-btn{flex:0 0 auto;max-width:none;overflow:visible;text-overflow:clip;}
    html.hha-compact #ar-main-panel .ar-header{padding-inline:10px;}
    html.hha-compact #ar-main-panel .ar-scroll--content{padding-inline:10px;}
    html.hha-compact #ar-main-panel .ar-card{padding-inline:10px;}
    html.hha-compact #ar-main-panel .ar-card-head{gap:6px;}
    html.hha-compact #ar-main-panel .ar-manual-toolbar{gap:4px;}
    html.hha-compact #ar-main-panel .ar-manual-actions{gap:6px;}
    html.hha-compact #ar-main-panel .ar-execution-shell{left:10px;right:10px;}
    html.hha-compact #ar-main-panel .ar-diag-filter-row{gap:6px;}
    html.hha-compact #ar-main-panel .ar-diag-toolbar{column-gap:6px;}
    @container (max-width:350px){
      .ar-log-row{grid-template-columns:max-content minmax(84px,1fr) max-content;}
      .ar-log-time{grid-column:1 / -1;}
      .ar-log-level{grid-column:1;grid-row:2;}
      .ar-log-message{grid-column:2;grid-row:2;}
      .ar-log-repeat{grid-column:3;grid-row:2;}
      .ar-log-group-children{margin-left:8px;}
    }
    @container (max-width:315px){
      .ar-diag-filter-row,.ar-diag-toolbar{grid-template-columns:minmax(0,1fr);}
      .ar-diag-autoscroll{justify-self:start;}
    }
    @container (max-width:229px){
      .ar-diag-footer-actions{grid-template-columns:minmax(0,1fr);}
    }
    @media (max-height:720px){
      .ar-scroll--content{padding-top:8px;gap:7px;}
      .ar-execution-shell{padding-top:5px;padding-bottom:8px;}
      #ar-mode-card.ar-execution-core{padding:10px 12px 9px;gap:7px;}
      .ar-work-mode-options{gap:3px;}
      .ar-work-mode-option{height:22px;font-size:10px;}
      .ar-execution-meta{padding-top:6px;}
      .ar-execution-limit{padding-top:0;}
      .ar-execution-actions{gap:6px;}
      .ar-execution-utils .ar-util-btn{height:28px;min-height:28px;}
    }
    @media (prefers-reduced-motion: reduce){
      .ar-work-mode-thumb, .ar-work-mode-thumb__body, .ar-work-mode-thumb__shadow, .ar-work-mode-turbo-surface, .ar-work-mode-grid-mask, .ar-work-mode-option, .ar-work-mode-snap-marker{transition-duration:1ms!important;}
      .ar-work-mode-thumb__body{transform:none!important;}
      .ar-work-mode-grid-strip{animation:none!important;}
      .ar-work-mode-grid-cell{transform:none!important;opacity:var(--cell-alpha, .15)!important;}
      #ar-main-panel *, #ar-toggle-btn, #ar-toggle-btn *{animation:none!important;transition:none!important;}
      .ar-btn, .ar-header-action{transform:none!important;}
      #ar-toggle-btn.is-running{background:linear-gradient(155deg,#7a75bb 0%,#6661aa 52%,#56518e 100%);filter:brightness(1.045) saturate(1.035);box-shadow:-3px 4px 10px rgba(76,70,151,.22),-1px 2px 4px rgba(20,30,45,.09);}
    }
    `;
    (document.head || document.documentElement).appendChild(style);
}
