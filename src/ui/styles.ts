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
    #ar-main-panel, #ar-toggle-btn{
        --font-mono:"SFMono-Regular",Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;
        --hha-radius-xs:5px;
        --hha-radius-sm:7px;
        --hha-radius-md:9px;
        --hha-radius-lg:11px;
        --hha-radius-pill:9999px;
        --hha-bg:#f5f7fa;
        --hha-surface:#ffffff;
        --hha-surface-subtle:#f7f9fc;
        --hha-surface-hover:#f1f4f8;
        --hha-surface-active:#e6ebf2;
        --hha-text:#141c28;
        --hha-text-secondary:#485466;
        --hha-text-muted:#647285;
        --hha-border:#d9e1ec;
        --hha-border-subtle:#e8edf4;
        --hha-border-strong:#c2cbd7;
        --hha-border-hover:#b4c0cf;
        --hha-accent:#605bb5;
        --hha-accent-hover:#544ea7;
        --hha-accent-active:#4a4497;
        --hha-accent-soft:#f1f0fa;
        --hha-accent-ring:rgba(96,91,181,0.22);
        --hha-turbo-deep:#433da8;
        --hha-success:#0d7350;
        --hha-success-soft:#eaf8f2;
        --hha-success-border:#bfe6d7;
        --hha-warning:#955e09;
        --hha-warning-soft:#fff7e6;
        --hha-warning-border:#f8dfaa;
        --hha-danger:#c3293e;
        --hha-danger-hover:#ab2134;
        --hha-danger-soft:#fdf0f2;
        --hha-danger-border:#f6c0c8;
        --hha-shadow-xs:0 1px 2px rgba(20,30,45,0.05);
        --hha-shadow-sm:0 1px 3px rgba(20,30,45,0.06),0 1px 2px rgba(20,30,45,0.04);
        --hha-shadow-md:0 3px 8px rgba(20,30,45,0.07),0 1px 2px rgba(20,30,45,0.04);
        --hha-shadow-lg:0 10px 26px rgba(20,30,45,0.09),0 2px 6px rgba(20,30,45,0.04);
        --hha-shadow-raised:0 14px 36px rgba(20,30,45,0.12),0 2px 8px rgba(20,30,45,0.06);
        --hha-shadow-focus:0 0 0 3px var(--hha-accent-ring);
        --hha-shadow-control-focus:0 0 0 3px var(--hha-accent-ring);
        --hha-focus-ring:0 0 0 3px var(--hha-accent-ring);
        --hha-focus-ring-strong:0 0 0 3px rgba(96,91,181,0.28);
        --hha-ease-spring:cubic-bezier(0.16,1,0.3,1);
        --hha-ease-premium:cubic-bezier(0.18,0.82,0.22,1);
        --hha-ease-standard:cubic-bezier(0.2,0.72,0.3,1);
        --hha-duration-fast:130ms;
        --hha-duration-base:180ms;
        --hha-duration-medium:220ms;
        --hh-green:var(--hha-success);
        --hh-blue:var(--hha-accent);
        --hh-blue-hover:var(--hha-accent-hover);
        --hh-blue-soft:var(--hha-accent-soft);
        --ink:var(--hha-text);
        --ink-2:var(--hha-text-secondary);
        --ink-3:var(--hha-text-muted);
        --line:var(--hha-border);
        --line-2:var(--hha-border-subtle);
        --card:var(--hha-surface);
        --bg:var(--hha-bg);
        --bg-2:var(--hha-surface-subtle);
        --hha-control-accent:var(--hha-accent);
    }
    #ar-toggle-btn{position:fixed;top:50%;right:0;transform:translateY(-50%);width:32px;height:116px;padding:0;border:1px solid rgba(255,255,255,0.24);border-right:0;border-radius:var(--hha-radius-lg) 0 0 var(--hha-radius-lg);background:linear-gradient(155deg,#7471b4 0%,#6866aa 52%,#5d5998 100%);box-shadow:-2px 3px 8px rgba(20,30,45,0.10);color:#ffffff;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;z-index:2147483000;user-select:none;overflow:hidden;transition:background var(--hha-duration-base) var(--hha-ease-premium),filter var(--hha-duration-base) var(--hha-ease-premium),box-shadow var(--hha-duration-base) var(--hha-ease-premium);}
    #ar-toggle-btn:hover{background:linear-gradient(155deg,#7b77bc 0%,#625fa6 54%,#57528f 100%);box-shadow:-2px 4px 10px rgba(20,30,45,0.14);}
    #ar-toggle-btn:active{box-shadow:-1px 2px 4px rgba(20,30,45,0.08);filter:brightness(0.97);}
    #ar-toggle-btn:focus-visible{outline:2px solid #ffffff;outline-offset:-3px;box-shadow:-1px 2px 5px rgba(20,30,45,0.09),var(--hha-shadow-control-focus);}
    #ar-toggle-btn .ar-tab-text{display:block;writing-mode:horizontal-tb;transform:rotate(-90deg);white-space:nowrap;font-size:11px;line-height:1;font-weight:750;letter-spacing:0.04em;color:#ffffff;text-shadow:0 1px 1px rgba(44,40,91,0.18);}
    @keyframes ar-tab-running-breathe{0%,100%{background-position:0% 50%;filter:brightness(1) saturate(0.96);box-shadow:-2px 3px 8px rgba(69,64,137,0.18),-1px 1px 3px rgba(20,30,45,0.08);}50%{background-position:100% 50%;filter:brightness(1.08) saturate(1.08);box-shadow:-4px 5px 14px rgba(78,70,157,0.26),-1px 2px 4px rgba(20,30,45,0.10);}}
    #ar-toggle-btn.is-running{background:linear-gradient(125deg,#7772bb 0%,#5f5aa2 30%,#7b74c1 58%,#57528f 100%);background-size:230% 230%;animation:ar-tab-running-breathe 2.2s var(--hha-ease-standard) infinite;}
    #ar-toggle-btn.is-running .ar-tab-text{text-shadow:0 1px 2px rgba(42,37,91,0.24),0 0 6px rgba(255,255,255,0.15);}
    #ar-toggle-btn.is-running:hover{animation-play-state:paused;background-position:76% 50%;filter:brightness(1.07) saturate(1.04);}
    #ar-main-panel{position:fixed;top:0;right:0;bottom:0;height:100vh;width:min(var(--hha-panel-width),100%);max-width:100%;z-index:2147483000;font-family:var(--font);line-height:1.4;border-radius:0;border-left:1px solid var(--hha-border);background:var(--hha-bg);color:var(--hha-text);box-shadow:-4px 0 16px rgba(20,30,45,0.06);font-size:13px;display:flex;flex-direction:column;overflow:hidden;text-align:left;}
    #ar-main-panel a{color:var(--hha-accent);text-decoration:none;}
    #ar-main-panel a:hover{text-decoration:underline;}
    .ar-view{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden;}
    .ar-header{flex:0 0 auto;min-height:48px;padding:9px 12px 9px 14px;display:flex;align-items:center;justify-content:space-between;gap:8px;border-radius:0;border-bottom:1px solid var(--hha-border);background:rgba(253,254,255,0.98);box-shadow:0 1px 0 rgba(20,30,45,0.02);}
    .ar-brand{display:flex;align-items:baseline;gap:7px;min-width:0;overflow:hidden;}
    .ar-title{font-size:14.5px;font-weight:720;letter-spacing:-0.025em;color:var(--hha-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .ar-header-right{display:flex;align-items:center;gap:6px;flex:0 0 auto;}
    .ar-lang-switcher{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--hha-border);border-radius:var(--hha-radius-md);background:var(--hha-surface-subtle);}
    .ar-lang-sep{display:none;}
    .ar-lang-btn{min-width:26px;height:22px;padding:0 6px;border:1px solid transparent;border-radius:var(--hha-radius-sm);background:transparent;color:var(--hha-text-secondary);font-family:inherit;font-size:10.5px;font-weight:750;cursor:pointer;line-height:1;transition:background var(--hha-duration-fast) var(--hha-ease-premium),color var(--hha-duration-fast) var(--hha-ease-premium),border-color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium);}
    .ar-lang-btn:hover{background:var(--hha-surface-hover);color:var(--hha-text);}
    .ar-lang-btn:active{background:var(--hha-surface-active);}
    .ar-lang-btn.is-active{border-color:var(--hha-border);background:var(--hha-surface);color:var(--hha-text);box-shadow:var(--hha-shadow-xs);}
    .ar-lang-btn:focus-visible{outline:none;box-shadow:var(--hha-shadow-control-focus);}
    .ar-header-action{width:28px;min-width:28px;height:28px;padding:0;border:1px solid var(--hha-border);border-radius:var(--hha-radius-md);background:var(--hha-surface);color:var(--hha-text-muted);cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:inherit;font-size:0;line-height:1;box-shadow:var(--hha-shadow-xs);transition:background var(--hha-duration-fast) var(--hha-ease-premium),border-color var(--hha-duration-fast) var(--hha-ease-premium),color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium),transform var(--hha-duration-fast) var(--hha-ease-premium);}
    .ar-header-action:hover{border-color:var(--hha-border-hover);background:var(--hha-surface-hover);color:var(--hha-text);box-shadow:var(--hha-shadow-sm);}
    .ar-header-action:active{border-color:var(--hha-border-strong);background:var(--hha-surface-active);box-shadow:none;transform:scale(0.96);}
    .ar-header-action:focus-visible{outline:none;border-color:var(--hha-accent);box-shadow:var(--hha-shadow-control-focus);color:var(--hha-accent);}
    .ar-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;padding:10px 11px 9px;gap:9px;scrollbar-color:#c8d0db transparent;scrollbar-width:thin;overscroll-behavior:contain;}
    .ar-scroll::-webkit-scrollbar{width:6px;}
    .ar-scroll::-webkit-scrollbar-thumb{background:#c8d0db;border-radius:3px;}
    .ar-card{display:flex;flex-direction:column;position:relative;overflow:hidden;flex-shrink:0;padding:12px 13px;gap:9px;border-radius:var(--hha-radius-lg);border:1px solid var(--hha-border);background:linear-gradient(180deg,#ffffff 0%,#fdfefe 58%,#fafbfd 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,1),inset 0 -1px 0 rgba(76,89,106,0.028),0 1px 2px rgba(20,30,45,0.045),0 6px 16px rgba(20,30,45,0.025);}
    .ar-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:22px;min-width:0;}
    .ar-card-title{font-size:11px;font-weight:750;letter-spacing:0.05em;text-transform:uppercase;color:var(--hha-text-secondary);}
    .ar-title-with-count{display:inline-flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;overflow:hidden;}
    .ar-title-with-count .ar-card-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .ar-card--settings{overflow:visible;}
    .ar-card--stats{padding:0;border:0;background:transparent;box-shadow:none;overflow:visible;}
    .ar-cover-editor{position:relative;}
    .ar-cover-editor .ar-textarea{display:block;padding-right:64px;padding-bottom:18px;}
    .ar-cover-editor .ar-cover-counter{position:absolute;right:10px;bottom:6px;z-index:1;line-height:1;font-size:10px;font-variant-numeric:tabular-nums;color:var(--hha-text-muted);pointer-events:none;}
    .ar-cover-counter.is-near{font-weight:700;color:var(--hha-warning);}
    .ar-cover-counter.is-off{visibility:hidden;}
    .ar-row{display:flex;align-items:center;justify-content:space-between;gap:10px;}
    .ar-row-label{flex:1;min-width:0;font-size:12px;font-weight:500;line-height:1.4;color:var(--hha-text-secondary);}
    .ar-input,.ar-textarea{border:1px solid var(--hha-border);background:var(--card);border-radius:var(--hha-radius-md);font-family:inherit;font-size:13px;color:var(--hha-text);box-shadow:var(--hha-shadow-xs);transition:border-color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium),background var(--hha-duration-fast) var(--hha-ease-premium),opacity var(--hha-duration-fast) var(--hha-ease-premium);outline:none;}
    .ar-input{padding:6px 9px;font-weight:700;}
    .ar-input-num{flex:none;width:70px;height:32px;text-align:center;}
    .ar-input[type=number]{-moz-appearance:textfield;appearance:textfield;}
    .ar-input[type=number]::-webkit-outer-spin-button,.ar-input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
    .ar-input:hover:not(:focus),.ar-textarea:hover:not(:focus){border-color:var(--hha-border-hover);background:#ffffff;box-shadow:var(--hha-shadow-sm);}
    .ar-input:focus,.ar-textarea:focus{border-color:var(--hha-accent);box-shadow:var(--hha-focus-ring),var(--hha-shadow-xs);}
    .ar-textarea{width:100%;min-height:64px;padding:8px 10px;font-size:12px;line-height:1.48;resize:vertical;}
    .ar-textarea::placeholder{color:#9ba6b6;}
    .ar-textarea:disabled{border-color:var(--hha-border-subtle);background:var(--hha-surface-subtle);color:var(--hha-text-muted);cursor:not-allowed;resize:none;opacity:0.72;}
    .ar-switch-row{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;user-select:none;}
    .ar-switch-row-sub{position:relative;padding-top:2px;}
    .ar-setting-label-group{display:flex;align-items:center;gap:6px;min-width:0;}
    .ar-setting-label-group .ar-row-label{flex:0 1 auto;min-width:0;}
    .ar-switch{position:relative;display:inline-block;flex:none;width:38px;height:22px;}
    .ar-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;z-index:1;}
    .ar-switch i{display:block;width:100%;height:100%;border-radius:var(--hha-radius-sm);border:1px solid var(--hha-border-strong);background:linear-gradient(180deg,#dfe4ea 0%,#d6dde5 100%);box-shadow:inset 0 1px 2px rgba(35,47,63,0.10),inset 0 -1px 0 rgba(255,255,255,0.62);pointer-events:none;transition:background 180ms var(--hha-ease-premium),border-color 180ms var(--hha-ease-premium),box-shadow 150ms var(--hha-ease-premium);}
    .ar-switch i::after{content:"";box-sizing:border-box;position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:var(--hha-radius-xs);border:1px solid rgba(197,205,215,0.82);background:linear-gradient(180deg,#ffffff 0%,#fafbfc 100%);box-shadow:0 1px 2px rgba(20,30,45,0.16),0 2px 4px rgba(20,30,45,0.06);transform:translateX(0);transition:transform 180ms var(--hha-ease-premium),box-shadow 150ms var(--hha-ease-premium),background 150ms var(--hha-ease-premium);}
    .ar-switch-row:hover .ar-switch i{border-color:var(--hha-border-hover);background:linear-gradient(180deg,#dbe1e7 0%,#d1d9e1 100%);}
    .ar-switch-row:hover .ar-switch i::after{box-shadow:0 1px 3px rgba(20,30,45,0.18),0 2px 5px rgba(20,30,45,0.07);}
    .ar-switch input:checked + i{border-color:#585397;background:linear-gradient(180deg,#726eb2 0%,#635faa 100%);box-shadow:inset 0 1px 2px rgba(47,42,102,0.18),inset 0 -1px 0 rgba(255,255,255,0.14);}
    .ar-switch-row:hover .ar-switch input:checked + i{border-color:#4e498c;background:linear-gradient(180deg,#6d68ae 0%,#5b569e 100%);}
    .ar-switch input:checked + i::after{transform:translateX(16px);}
    .ar-switch input:active + i{box-shadow:inset 0 2px 3px rgba(35,47,63,0.14);}
    .ar-switch input:active + i::after{transform:translateX(0) scale(0.96);}
    .ar-switch input:checked:active + i::after{transform:translateX(16px) scale(0.96);}
    .ar-switch input:focus-visible + i,.ar-switch input:checked:focus-visible + i{box-shadow:var(--hha-focus-ring);}
    .ar-autosave-feedback{display:flex;align-items:center;gap:6px;min-height:16px;color:var(--hha-text-muted);font-size:11px;line-height:1.3;}
    .ar-autosave-feedback::before{content:"";width:5px;height:5px;flex:0 0 5px;border-radius:var(--hha-radius-pill);background:#98a2b1;box-shadow:0 0 0 2px rgba(152,162,177,0.09);transition:background var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium);}
    .ar-autosave-feedback.is-saved{color:#5e5a91;}
    .ar-autosave-feedback.is-saved::before{background:#7873b4;box-shadow:0 0 0 2px rgba(104,99,179,0.11);}
    .ar-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:0 13px;border:1px solid transparent;border-radius:var(--hha-radius-md);font-family:inherit;font-size:12px;font-weight:680;line-height:1.15;cursor:pointer;white-space:nowrap;user-select:none;transition:background var(--hha-duration-fast) var(--hha-ease-premium),border-color var(--hha-duration-fast) var(--hha-ease-premium),color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium),transform var(--hha-duration-fast) var(--hha-ease-spring);}
    .ar-btn:active{transform:scale(0.985);}
    .ar-btn:disabled{cursor:not-allowed;opacity:0.46;}
    .ar-btn:disabled:active{transform:none;}
    .ar-btn:focus-visible{outline:none;box-shadow:var(--hha-focus-ring);}
    .ar-btn-cta{width:100%;height:40px;border-radius:var(--hha-radius-lg);font-size:13px;font-weight:720;}
    .ar-btn-primary{background:var(--hha-accent);color:#ffffff;border-color:#544fa0;box-shadow:0 2px 4px rgba(74,68,145,0.14),0 1px 2px rgba(20,30,45,0.05);}
    .ar-btn-primary:hover{border-color:#4b4792;background:var(--hha-accent-hover);box-shadow:var(--hha-shadow-md);}
    .ar-btn-primary:active{border-color:#444085;background:var(--hha-accent-active);box-shadow:0 1px 2px rgba(74,68,145,0.10);transform:scale(0.99);}
    .ar-btn-primary:focus-visible{box-shadow:var(--hha-focus-ring-strong),0 2px 4px rgba(74,68,145,0.12);}
    .ar-btn-danger{background:#ffffff;color:#925267;border:1px solid #d7b4be;box-shadow:var(--hha-shadow-xs);}
    .ar-btn-danger:hover{color:#84475b;border-color:#c99ca9;background:#fff8fa;box-shadow:var(--hha-shadow-sm);}
    .ar-btn-danger:active{color:#7e4053;border-color:#c08f9d;background:#f8eef1;box-shadow:none;transform:scale(0.99);}
    .ar-btn-danger:focus-visible{box-shadow:0 0 0 3px rgba(195,41,62,0.16);}
    .ar-btn-soft,.ar-btn-tertiary{border:1px solid var(--hha-border);background:var(--hha-surface);color:var(--hha-text-secondary);box-shadow:var(--hha-shadow-xs);}
    .ar-btn-soft:hover,.ar-btn-tertiary:hover{border-color:var(--hha-border-hover);background:var(--hha-surface-hover);color:var(--hha-text);box-shadow:var(--hha-shadow-sm);}
    .ar-btn-soft:active,.ar-btn-tertiary:active{border-color:var(--hha-border-strong);background:var(--hha-surface-active);box-shadow:none;transform:scale(0.985);}
    .ar-btn-tertiary{background:var(--hha-surface-subtle);border-color:var(--hha-border);}
    .ar-btn-sm{min-height:29px;padding:0 10px;font-size:11px;border-radius:var(--hha-radius-md);}
    .ar-btn-open{min-height:34px;height:34px;padding:0 14px;border-radius:var(--hha-radius-md);font-size:11px;font-weight:650;color:#57538f;border:1px solid #d1cfe5;background:#f6f5fb;box-shadow:var(--hha-shadow-xs);}
    .ar-btn-open:hover{color:#4e4a84;border-color:#bfbcda;background:#efedf8;box-shadow:var(--hha-shadow-sm);}
    .ar-btn-open:active{color:#49457d;border-color:#b4b0d1;background:#e9e7f3;box-shadow:none;transform:scale(0.985);}
    .ar-btn-open:focus-visible{box-shadow:var(--hha-focus-ring),var(--hha-shadow-xs);}
    .ar-remove-btn{width:34px;min-width:34px;height:34px;min-height:34px;padding:0;border:1px solid var(--hha-border);border-radius:var(--hha-radius-md);background:var(--hha-surface);color:#8a7680;box-shadow:var(--hha-shadow-xs);display:flex;align-items:center;justify-content:center;}
    .ar-remove-btn:hover{border-color:#d8b8c0;background:#fff5f7;color:#a03f56;box-shadow:var(--hha-shadow-sm);}
    .ar-remove-btn:active{border-color:#cca4af;background:#f8e8ec;box-shadow:none;transform:scale(0.96);}
    .ar-remove-btn:focus-visible{box-shadow:0 0 0 3px rgba(195,41,62,0.14);}
    .ar-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:3px;padding:4px;border:1px solid #d3dbe5;border-radius:var(--hha-radius-lg);background:linear-gradient(180deg,#eef2f6 0%,#f3f6f9 100%);box-shadow:inset 0 2px 5px rgba(35,47,63,0.055),inset 0 1px 0 rgba(255,255,255,0.54);}
    .ar-stat{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:0;min-height:52px;padding:7px 3px;gap:3px;text-align:center;border:1px solid transparent;border-radius:var(--hha-radius-md);background:transparent;}
    .ar-stat-num{line-height:1.1;font-size:16px;font-weight:780;color:var(--hha-text-muted);font-variant-numeric:tabular-nums;}
    .ar-stat-cap{font-size:10.5px;font-weight:650;color:var(--hha-text-muted);letter-spacing:0.01em;display:block;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-inline:2px;}
    .ar-stat.is-active-attempts .ar-stat-num{color:var(--hha-text);}
    .ar-stat.is-active-success{background:linear-gradient(180deg,#f4fbf8 0%,var(--hha-success-soft) 100%);border-color:#d0e9df;box-shadow:inset 0 1px 0 rgba(255,255,255,0.76);}
    .ar-stat.is-active-success .ar-stat-num{color:var(--hha-success);}
    .ar-stat.is-active-manual{background:linear-gradient(180deg,#f8f8fd 0%,#f0f0fa 100%);border-color:#dcdced;box-shadow:inset 0 1px 0 rgba(255,255,255,0.8);}
    .ar-stat.is-active-manual .ar-stat-num{color:var(--hha-control-accent);}
    .ar-stat.is-active-skip .ar-stat-num{color:var(--hha-text-secondary);}
    .ar-badge{display:inline-flex;align-items:center;justify-content:center;min-width:19px;height:19px;padding:0 6px;border:1px solid var(--hha-border);border-radius:var(--hha-radius-xs);background:var(--hha-surface-subtle);color:var(--hha-text-secondary);font-size:10px;font-weight:700;transition:all var(--hha-duration-fast) ease;}
    .ar-badge-count{display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:17px;padding:0 5px;border:1px solid #d7d3e9;border-radius:var(--hha-radius-xs);background:var(--hha-accent-soft);color:var(--hha-accent);font-size:10px;font-weight:700;line-height:1;flex:none;margin-left:2px;}
    .ar-status{display:inline-flex;align-items:center;min-width:0;min-height:23px;padding:3px 8px;border-radius:var(--hha-radius-sm);border:1px solid var(--hha-border);background:var(--hha-surface-subtle);color:var(--hha-text-secondary);font-size:10px;font-weight:650;white-space:nowrap;overflow:hidden;}
    #ar-status-text{overflow:hidden;text-overflow:ellipsis;}
    .ar-status--idle{background:var(--hha-surface-subtle);color:var(--hha-text-secondary);border-color:var(--hha-border);}
    .ar-status--running{background:var(--hha-accent-soft);color:var(--hha-accent);border-color:#d3d0e9;}
    .ar-status--stopped{background:var(--hha-danger-soft);color:var(--hha-danger);border-color:var(--hha-danger-border);}
    .ar-status--error{background:var(--hha-warning-soft);color:var(--hha-warning);border-color:var(--hha-warning-border);}
    .ar-status--done{background:var(--hha-success-soft);color:var(--hha-success);border-color:var(--hha-success-border);}
    .ar-manual{display:flex;flex-direction:column;gap:6px;}
    .ar-manual-toolbar{display:flex;gap:6px;flex:0 0 auto;min-width:0;}
    .ar-manual-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 9px 8px 10px;border:1px solid var(--hha-border);border-radius:var(--hha-radius-lg);background:var(--hha-surface-subtle);transition:background var(--hha-duration-fast) var(--hha-ease-premium),border-color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium);}
    .ar-manual-item:hover{background:var(--hha-surface);border-color:var(--hha-border-hover);box-shadow:0 2px 7px rgba(20,30,45,0.045);}
    .ar-manual-main{flex:1 1 0;min-width:0;display:flex;flex-direction:column;justify-content:center;min-height:40px;}
    .ar-manual-meta{display:flex;align-items:center;gap:4px;min-width:0;margin-bottom:3px;color:var(--hha-text-muted);font-size:10.5px;line-height:1.2;}
    .ar-manual-meta .ar-when{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .ar-vid{font-weight:600;color:var(--hha-text-muted);flex:none;}
    .ar-manual-title{color:var(--hha-text);font-size:11.5px;font-weight:650;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .ar-manual-title.is-empty{font-weight:400;color:var(--hha-text-muted);}
    .ar-manual-actions{margin-left:auto;flex:0 0 auto;align-self:center;display:flex;align-items:center;gap:8px;}
    .ar-queue-more-btn{width:100%;height:30px;font-size:11.5px;font-weight:600;margin-top:2px;}
    .ar-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:18px 12px;border:1px dashed var(--hha-border-strong);border-radius:var(--hha-radius-lg);background:var(--hha-surface-subtle);color:var(--hha-text-muted);font-size:11.5px;line-height:1.4;text-align:center;}
    .ar-empty-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;color:var(--hha-text-muted);opacity:0.8;}
    .ar-empty-icon .ar-icon-svg{width:22px;height:22px;}
    .ar-execution-shell{position:relative;z-index:20;flex:0 0 auto;padding:7px 11px 11px;border-radius:var(--hha-radius-lg);border-top:1px solid rgba(215,222,231,0.78);background:linear-gradient(180deg,rgba(248,250,252,0.70) 0%,rgba(248,250,252,0.97) 18%,var(--hha-bg) 100%);box-shadow:0 -9px 20px rgba(20,30,45,0.025);}
    .ar-execution-shell::before{content:"";position:absolute;left:11px;right:11px;top:-8px;height:14px;pointer-events:none;background:linear-gradient(180deg,rgba(248,250,252,0),rgba(248,250,252,0.92));}
    #ar-mode-card.ar-execution-core{position:relative;z-index:1;padding:12px 13px 11px;gap:8px;overflow:visible;border-radius:var(--hha-radius-lg);border-color:#cfd8e4;background:linear-gradient(180deg,#ffffff 0%,#fdfefe 46%,#f8fafc 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,1),inset 0 -1px 0 rgba(77,89,108,0.045),0 2px 4px rgba(20,30,45,0.055),0 10px 24px rgba(49,54,88,0.055);transition:border-color var(--hha-duration-medium) var(--hha-ease-premium),box-shadow var(--hha-duration-medium) var(--hha-ease-premium),background var(--hha-duration-medium) var(--hha-ease-premium);}
    #ar-mode-card.ar-execution-core.is-running{border-color:#bebee0;background:linear-gradient(180deg,#ffffff 0%,#fdfdff 45%,#f7f7fc 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,1),inset 0 -1px 0 rgba(92,88,167,0.055),0 2px 4px rgba(20,30,45,0.055),0 11px 26px rgba(76,72,145,0.09);}
    #ar-mode-card.ar-execution-core[data-mode="turbo"]{border-color:#c9c5ec;box-shadow:inset 0 1px 0 rgba(255,255,255,1),inset 0 -1px 0 rgba(98,91,215,0.07),0 2px 4px rgba(20,30,45,0.055),0 11px 28px rgba(84,77,171,0.09);}
    .ar-work-mode-header{display:flex;justify-content:space-between;align-items:center;gap:8px;}
    .ar-work-mode-title{display:flex;align-items:center;gap:7px;min-width:0;margin:0;font-size:13.5px;line-height:1.2;white-space:nowrap;overflow:hidden;}
    .ar-work-mode-title__label{font-size:11px;font-weight:780;letter-spacing:0.065em;text-transform:uppercase;color:var(--hha-text-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;}
    .ar-help-wrap{position:relative;display:inline-flex;align-items:center;flex:0 0 auto;}
    .ar-help-button{position:relative;flex:0 0 auto;display:grid;place-items:center;width:22px;min-width:22px;height:22px;padding:0;border:1px solid var(--hha-border-strong);border-radius:var(--hha-radius-sm);background:var(--hha-surface);color:var(--hha-text-muted);cursor:pointer;font-size:0;line-height:0;box-shadow:var(--hha-shadow-xs);transition:background var(--hha-duration-fast) var(--hha-ease-standard),border-color var(--hha-duration-fast) var(--hha-ease-standard),color var(--hha-duration-fast) var(--hha-ease-standard),box-shadow var(--hha-duration-fast) var(--hha-ease-standard);}
    .ar-help-button::before{content:"";position:absolute;inset:-3px;}
    .ar-help-button:hover,.ar-help-wrap.is-pinned .ar-help-button{background:var(--hha-accent-soft);border-color:#d1cee8;color:var(--hha-accent);}
    .ar-help-button:focus-visible{outline:none;border-color:var(--hha-accent);box-shadow:var(--hha-shadow-focus);}
    .ar-help-popover{position:absolute;z-index:120;top:calc(100% + 8px);right:0;width:min(276px,calc(100vw - 42px));padding:10px;border:1px solid var(--hha-border);border-radius:var(--hha-radius-lg);background:rgba(255,255,255,0.992);box-shadow:var(--hha-shadow-raised);opacity:0;visibility:hidden;transform:translateY(-3px);pointer-events:none;transition:opacity var(--hha-duration-medium) var(--hha-ease-standard),transform var(--hha-duration-medium) var(--hha-ease-standard),visibility 0s linear var(--hha-duration-medium);}
    .ar-help-wrap.is-open .ar-help-popover{opacity:1;visibility:visible;transform:translateY(0);pointer-events:auto;transition-delay:0s;}
    .ar-execution-core .ar-help-popover{top:auto;bottom:calc(100% + 8px);transform:translateY(3px);}
    .ar-execution-core .ar-help-wrap.is-open .ar-help-popover{transform:translateY(0);}
    .ar-help-popover-title{display:block;margin:0 0 5px;font-size:11.5px;line-height:1.3;font-weight:760;color:var(--hha-text);}
    .ar-help-popover-copy{display:block;font-size:11px;line-height:1.45;color:var(--hha-text-secondary);}
    .ar-mode-help-item{display:grid;grid-template-columns:76px 1fr;gap:8px;align-items:start;padding:7px;border-radius:var(--hha-radius-md);}
    .ar-mode-help-item + .ar-mode-help-item{border-top:1px solid #f0f2f6;}
    .ar-mode-help-name{font-size:11px;line-height:1.35;font-weight:760;color:var(--hha-text);letter-spacing:0.005em;}
    .ar-mode-help-copy{font-size:11px;line-height:1.35;color:var(--hha-text-secondary);font-variant-numeric:tabular-nums;}
    .ar-mode-help-item--turbo .ar-mode-help-name{color:var(--hha-turbo-deep);}
    .ar-mode-help-note{display:block;margin-top:5px;padding:7px;border-top:1px solid #edf0f4;color:var(--hha-text-muted);font-size:10.5px;line-height:1.42;}
    #ar-mode-card{--ar-work-track-h:36px;--ar-work-track-pad:3px;--ar-work-thumb-w:44px;--ar-work-thumb-h:30px;--ar-work-thumb-duration:255ms;--ar-work-turbo-reveal-duration:380ms;--ar-work-turbo-exit-duration:220ms;--ar-work-shock-cycle-duration:5s;--ar-work-turbo-grid-duration:60s;--ar-work-grid-shift:-320px;--ar-work-move-ease:cubic-bezier(0.22,0.8,0.3,1);--thumb-source-x:0px;--thumb-center-x:50%;--ar-work-grid-cell:5px;--ar-work-grid-col-gap:2px;--ar-work-grid-row-gap:2px;}
    .ar-work-mode-slider{position:relative;height:var(--ar-work-track-h);border-radius:var(--hha-radius-lg);overflow:hidden;touch-action:none;user-select:none;cursor:pointer;isolation:isolate;perspective:800px;perspective-origin:var(--thumb-center-x,50%) 50%;transform-style:preserve-3d;background:linear-gradient(90deg,#e8ebf0 0%,#edf0f4 58%,#f0f2f5 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,0.8),inset 0 0 0 1px rgba(20,30,45,0.035);}
    .ar-work-mode-slider::before{content:"";position:absolute;inset:0;z-index:0;border-radius:var(--hha-radius-lg);pointer-events:none;background:linear-gradient(90deg,rgba(255,255,255,0.12),rgba(255,255,255,0.025) 62%,transparent 100%);}
    .ar-work-mode-slider::after{content:"";position:absolute;z-index:4;top:0;bottom:0;left:0;width:19%;border-radius:var(--hha-radius-lg);pointer-events:none;opacity:0;background:linear-gradient(90deg,rgba(235,238,243,0.78) 0%,rgba(235,237,244,0.61) 24%,rgba(231,232,244,0.38) 48%,rgba(225,222,246,0.17) 72%,rgba(225,222,246,0) 100%);transition:opacity var(--ar-work-turbo-reveal-duration) var(--hha-ease-premium);}
    .ar-work-mode-slider.is-turbo::after{opacity:1;}
    .ar-work-mode-slider:focus-visible{outline:none;box-shadow:inset 0 1px 0 rgba(255,255,255,0.75),inset 0 0 0 1px rgba(20,30,45,0.04),var(--hha-shadow-focus);}
    .ar-work-mode-turbo-surface{position:absolute;inset:0;z-index:1;border-radius:var(--hha-radius-lg);pointer-events:none;opacity:0;background:linear-gradient(90deg,rgba(98,91,215,0.10) 0%,rgba(98,91,215,0.20) 28%,rgba(103,91,220,0.38) 56%,rgba(91,79,202,0.64) 80%,rgba(72,67,173,0.86) 100%);transition:opacity var(--ar-work-turbo-exit-duration) var(--hha-ease-standard);}
    .ar-work-mode-slider.has-turbo-grid .ar-work-mode-turbo-surface{will-change:opacity;}
    .ar-work-mode-slider.is-turbo .ar-work-mode-turbo-surface{opacity:1;transition:opacity var(--ar-work-turbo-reveal-duration) var(--hha-ease-premium);}
    .ar-work-mode-grid-mask{position:absolute;inset:0;z-index:2;overflow:hidden;border-radius:var(--hha-radius-lg);pointer-events:none;opacity:0;visibility:hidden;filter:blur(0);color:#ffffff;-webkit-mask-image:linear-gradient(to right,#000 0,#000 calc(var(--thumb-source-x,0px) - 24px),transparent var(--thumb-source-x,0px),transparent 100%);mask-image:linear-gradient(to right,#000 0,#000 calc(var(--thumb-source-x,0px) - 24px),transparent var(--thumb-source-x,0px),transparent 100%);transition:opacity var(--ar-work-turbo-exit-duration) ease,filter var(--ar-work-turbo-exit-duration) ease,visibility 0s linear var(--ar-work-turbo-exit-duration);}
    .ar-work-mode-slider.has-turbo-grid .ar-work-mode-grid-mask{will-change:opacity,filter;}
    .ar-work-mode-slider.is-turbo .ar-work-mode-grid-mask{visibility:visible;opacity:0.58;animation:ar-turbo-grid-fade-in calc(var(--ar-work-turbo-reveal-duration) + 80ms) cubic-bezier(0.22,0.72,0.22,1) 1 both;transition:opacity var(--ar-work-turbo-reveal-duration) ease,filter var(--ar-work-turbo-reveal-duration) ease,visibility 0s linear 0s;}
    @keyframes ar-turbo-grid-fade-in{0%{opacity:0;filter:blur(1.2px);}55%{opacity:0.48;filter:blur(0.45px);}100%{opacity:0.62;filter:blur(0);}}
    .ar-work-mode-grid-strip{position:absolute;top:0;bottom:0;left:0;display:grid;grid-template-rows:repeat(5,var(--ar-work-grid-cell));grid-auto-flow:column;grid-auto-columns:var(--ar-work-grid-cell);align-content:center;column-gap:var(--ar-work-grid-col-gap);row-gap:var(--ar-work-grid-row-gap);width:max-content;transform:translate3d(0,0,0);}
    .ar-work-mode-slider.has-turbo-grid .ar-work-mode-grid-strip{will-change:transform;}
    .ar-work-mode-slider.is-turbo .ar-work-mode-grid-strip{animation:ar-turbo-grid-drift var(--ar-work-turbo-grid-duration) linear infinite;}
    @keyframes ar-turbo-grid-drift{from{transform:translate3d(0,0,0);}to{transform:translate3d(var(--ar-work-grid-shift),0,0);}}
    .ar-work-mode-grid-cell{--wave-boost:0;--wave-x:0px;--wave-y:0px;--wave-scale:1;width:var(--ar-work-grid-cell);height:var(--ar-work-grid-cell);clip-path:inset(0 round 1px);background:currentColor;opacity:calc(var(--cell-alpha,0.15) + var(--wave-boost));transform:translate3d(var(--wave-x),var(--wave-y),0) scale(var(--wave-scale));transform-origin:center;}
    .ar-work-mode-slider.has-turbo-grid .ar-work-mode-grid-cell{will-change:transform,opacity;}
    .ar-work-mode-grid-cell.l0{--cell-alpha:0;}
    .ar-work-mode-grid-cell.l1{--cell-alpha:0.10;}
    .ar-work-mode-grid-cell.l2{--cell-alpha:0.20;}
    .ar-work-mode-grid-cell.l3{--cell-alpha:0.35;}
    .ar-work-mode-grid-cell.l4{--cell-alpha:0.55;}
    .ar-work-mode-grid-cell.l5{--cell-alpha:0.75;}
    .ar-work-mode-snap-markers{position:absolute;z-index:3;top:50%;left:calc(var(--ar-work-track-pad) + var(--ar-work-thumb-w) / 2);right:calc(var(--ar-work-track-pad) + var(--ar-work-thumb-w) / 2);display:flex;align-items:center;justify-content:space-between;transform:translateY(-50%);pointer-events:none;}
    .ar-work-mode-snap-marker{width:3px;height:3px;flex:0 0 3px;clip-path:inset(0 round 1px);background:#728094;opacity:0.17;transition:opacity 100ms ease;}
    .ar-work-mode-slider:hover:not(.is-turbo) .ar-work-mode-snap-marker,.ar-work-mode-slider:focus-visible:not(.is-turbo) .ar-work-mode-snap-marker{opacity:0.27;}
    .ar-work-mode-slider.is-turbo .ar-work-mode-snap-marker{opacity:0;}
    .ar-work-mode-thumb{position:absolute;z-index:5;top:var(--ar-work-track-pad);left:var(--ar-work-track-pad);width:var(--ar-work-thumb-w);height:var(--ar-work-thumb-h);transform:translate3d(0,0,0);transform-style:preserve-3d;transition:transform var(--ar-work-thumb-duration) var(--ar-work-move-ease);will-change:transform;pointer-events:none;}
    .ar-work-mode-slider.is-dragging .ar-work-mode-thumb{transition:none;}
    .ar-work-mode-thumb__shadow{position:absolute;inset:0;border-radius:var(--hha-radius-md);box-shadow:0 2px 5px rgba(20,30,45,0.09),0 1px 2px rgba(20,30,45,0.05);pointer-events:none;will-change:transform,box-shadow,opacity;transition:box-shadow 150ms ease;}
    .ar-work-mode-slider:hover .ar-work-mode-thumb__shadow{box-shadow:0 3px 6px rgba(20,30,45,0.10),0 1px 2px rgba(20,30,45,0.05);}
    .ar-work-mode-thumb__body{position:absolute;inset:0;border-radius:var(--hha-radius-md);border:1px solid rgba(72,84,100,0.14);background:#ffffff;transform:translateZ(0);transform-style:preserve-3d;will-change:transform;transition:border-color 170ms ease,scale 100ms ease;pointer-events:none;}
    .ar-work-mode-slider.is-turbo .ar-work-mode-thumb__body{border-color:rgba(98,91,215,0.30);background:#fbfaff;}
    .ar-work-mode-slider.is-pressed .ar-work-mode-thumb__body{scale:0.985;}
    .ar-work-mode-options{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;line-height:1;user-select:none;margin-top:-1px;}
    .ar-work-mode-option{display:flex;align-items:center;justify-content:center;min-width:0;height:24px;padding:0 4px;border:1px solid transparent;border-radius:var(--hha-radius-sm);font-size:10.5px;font-weight:620;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background var(--hha-duration-fast) var(--hha-ease-premium),border-color var(--hha-duration-fast) var(--hha-ease-premium),color var(--hha-duration-fast) var(--hha-ease-premium),font-weight var(--hha-duration-fast) var(--hha-ease-premium);}
    .ar-work-mode-option[data-mode="safe"]{background:#f2f4f7;border-color:#e2e6eb;color:#6a7585;}
    .ar-work-mode-option[data-mode="balanced"]{background:#f5f3fa;border-color:#e5e1ef;color:#686581;}
    .ar-work-mode-option[data-mode="fast"]{background:#efedf8;border-color:#dcd7ec;color:#5f5a91;}
    .ar-work-mode-option[data-mode="turbo"]{background:#e9e6f5;border-color:#cec8e6;color:#554f8d;}
    .ar-work-mode-option.is-active{font-weight:780;box-shadow:inset 0 0 0 1px rgba(92,86,160,0.12),0 1px 2px rgba(20,30,45,0.04);}
    .ar-work-mode-option[data-mode="safe"].is-active{background:#eceff3;border-color:#bdc6d2;color:#3f4b5b;}
    .ar-work-mode-option[data-mode="balanced"].is-active{background:#eeebf6;border-color:#c9c3df;color:#514d7e;}
    .ar-work-mode-option[data-mode="fast"].is-active{background:#e7e3f4;border-color:#bdb6da;color:#4f4989;}
    .ar-work-mode-option[data-mode="turbo"].is-active{background:#dfdaf0;border-color:#aaa2d0;color:#453f80;}
    .ar-execution-meta{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:8px;border-top:1px solid #e9edf2;}
    .ar-execution-meta .ar-execution-runtime{flex:0 0 auto;min-height:0;display:flex;align-items:center;gap:8px;}
    .ar-execution-meta .ar-execution-limit{flex:0 1 auto;min-width:0;padding-top:0;border-top:0;gap:7px;}
    .ar-execution-meta .ar-execution-limit .ar-row-label{flex:0 1 auto;min-width:0;white-space:nowrap;font-size:10.5px;font-weight:590;color:#647083;}
    .ar-execution-meta .ar-execution-limit .ar-input-num{width:60px;height:30px;border-radius:var(--hha-radius-md);}
    .ar-execution-runtime .ar-status{min-height:22px;max-width:none;padding:3px 8px;background:#f1f4f7;border-color:#d4dce6;box-shadow:none;}
    .ar-execution-core.is-running .ar-status--running{color:#5c5998;border-color:#cecee6;background:#f1f0fa;}
    .ar-execution-count{height:22px;border-radius:var(--hha-radius-sm);min-width:50px;padding:0 8px;border-color:#d4dce6;background:#ffffff;color:#596577;box-shadow:0 1px 2px rgba(20,30,45,0.04);font-variant-numeric:tabular-nums;}
    .ar-progress{overflow:hidden;position:relative;height:4px;border-radius:2px;background:#e8ecf1;box-shadow:none;opacity:0.72;transition:opacity var(--hha-duration-base) var(--hha-ease-premium),background var(--hha-duration-base) var(--hha-ease-premium);}
    .ar-progress i{display:block;height:100%;width:0;border-radius:2px;position:relative;overflow:hidden;background:linear-gradient(90deg,#7773b4 0%,#6866aa 58%,#625bd7 100%);transition:width 300ms var(--hha-ease-standard);}
    .ar-execution-core.is-running .ar-progress{opacity:1;background:#e4e5ed;}
    .ar-execution-actions{display:flex;flex-direction:column;gap:7px;}
    .ar-execution-utils{display:flex;align-items:center;justify-content:space-between;gap:7px;}
    .ar-util-btn{flex:1 1 0;min-width:0;height:30px;min-height:30px;border-radius:var(--hha-radius-md);font-size:11.5px;}
    .ar-diag-header{min-height:48px;}
    .ar-diag-nav{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;overflow:hidden;}
    .ar-btn-back{gap:5px;padding:0 9px 0 7px;line-height:1;font-weight:600;}
    .ar-btn-back .ar-icon-svg{width:15px;height:15px;}
    .ar-diag-view-title{font-size:13px;font-weight:720;color:var(--hha-text);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .ar-diag-header-actions{flex:0 0 auto;}
    .ar-diag-body{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;gap:8px;padding:10px 10px 12px;background:var(--hha-bg);overflow:hidden;container-type:inline-size;}
    .ar-diag-filter-row{display:grid;grid-template-columns:max-content minmax(0,1fr);align-items:center;gap:8px;min-width:0;}
    .ar-diag-filter-group{display:inline-flex;align-items:center;flex:0 0 auto;padding:2px;border:1px solid var(--hha-border);border-radius:var(--hha-radius-md);background:var(--hha-surface-subtle);min-width:0;}
    .ar-diag-filter-btn{display:inline-flex;align-items:center;gap:5px;height:27px;padding:0 8px;border:0;border-radius:var(--hha-radius-sm);background:transparent;color:var(--hha-text-muted);font-family:inherit;font-size:10.5px;font-weight:700;cursor:pointer;min-width:0;transition:background var(--hha-duration-fast) var(--hha-ease-premium),color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium);}
    .ar-diag-filter-btn > span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .ar-diag-filter-btn:hover{color:var(--hha-text);}
    .ar-diag-filter-btn.is-active{background:var(--hha-surface);color:var(--hha-text);box-shadow:0 1px 3px rgba(20,30,45,0.08);}
    .ar-diag-filter-btn:focus-visible{outline:none;box-shadow:var(--hha-shadow-control-focus);}
    .ar-diag-filter-count{min-width:16px;padding:1px 4px;border-radius:var(--hha-radius-xs);background:rgba(92,104,128,0.08);color:inherit;font-size:10px;line-height:1.25;text-align:center;font-variant-numeric:tabular-nums;flex:0 0 auto;transition:opacity 0.15s ease,background 0.15s ease,color 0.15s ease;}
    .ar-diag-filter-btn.is-active .ar-diag-filter-count{background:var(--hha-accent-soft);color:var(--hha-accent);}
    #ar-diag-filter-errors:not(.has-errors) .ar-diag-filter-count{opacity:1;background:rgba(92,104,128,0.055);color:var(--hha-text-muted);}
    #ar-diag-filter-errors.has-errors .ar-diag-filter-count{opacity:1;background:var(--hha-danger-soft);color:var(--hha-danger);}
    .ar-diag-search-wrap{position:relative;display:flex;align-items:center;flex:1 1 auto;min-width:118px;height:32px;border:1px solid var(--hha-border);border-radius:var(--hha-radius-md);background:var(--hha-surface);transition:border-color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium);}
    .ar-diag-search-wrap:focus-within{border-color:var(--hha-accent);box-shadow:0 0 0 3px var(--hha-accent-soft);}
    .ar-diag-search-icon{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:24px;height:24px;margin-left:4px;color:var(--hha-text-muted);line-height:0;}
    .ar-diag-search-icon .ar-icon-svg{width:14px;height:14px;}
    .ar-diag-search{width:100%;min-width:0;height:100%;padding:0 28px 0 6px;border:0;outline:0;background:transparent;color:var(--hha-text);font-family:inherit;font-size:11px;}
    .ar-diag-search::-webkit-search-cancel-button{display:none;}
    .ar-diag-search::placeholder{color:var(--hha-text-muted);}
    .ar-diag-search-clear{position:absolute;right:2px;top:50%;transform:translateY(-50%);width:28px;height:28px;padding:0;border:0;border-radius:var(--hha-radius-xs);background:transparent;color:var(--hha-text-muted);font-family:inherit;line-height:0;cursor:pointer;}
    .ar-diag-search-clear[hidden]{display:none;}
    .ar-diag-search-clear .ar-icon-svg{width:13px;height:13px;}
    .ar-diag-search-clear:hover{background:var(--hha-surface-subtle);color:var(--hha-text);}
    .ar-diag-toolbar{min-height:34px;display:grid;grid-template-columns:minmax(0,1fr) max-content;align-items:center;gap:6px 3px;padding:0;}
    .ar-diag-check-zone{display:flex;align-items:center;flex-wrap:wrap;gap:4px;min-width:0;}
    .ar-diag-check-btn{flex:0 0 auto;padding-inline:10px;}
    .ar-diag-check-status{display:inline-flex;align-items:center;flex:0 0 auto;gap:3px;height:21px;white-space:nowrap;}
    .ar-diag-check-status:empty{display:none;}
    .ar-diag-check-progress{color:var(--hha-text-muted);font-size:10.5px;line-height:1;font-weight:700;font-variant-numeric:tabular-nums;}
    .ar-diag-check-ok{display:inline-flex;align-items:center;height:21px;padding:0 6px;border-radius:var(--hha-radius-xs);background:rgba(31,142,102,0.08);color:var(--hha-success);font-size:10.5px;line-height:1;font-weight:750;}
    .ar-diag-autoscroll{display:inline-flex;align-items:center;justify-self:end;gap:4px;min-height:34px;color:var(--hha-text-muted);font-size:10.5px;line-height:1.2;font-weight:650;cursor:pointer;user-select:none;white-space:nowrap;}
    .ar-diag-full-box{flex:1 1 0;height:auto;min-height:120px;max-height:none;padding:5px 10px 5px 0;border:1px solid #253247;border-radius:var(--hha-radius-lg);background:#111927;color:#aab6c8;box-shadow:inset 0 1px 0 rgba(255,255,255,0.025),0 8px 20px rgba(17,25,39,0.08);overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:#465870 #0d1725;font-family:inherit;font-size:10.5px;line-height:1.35;}
    .ar-diag-full-box::-webkit-scrollbar{width:9px;}
    .ar-diag-full-box::-webkit-scrollbar-track{background:#0d1725;border-left:1px solid rgba(148,163,184,0.06);}
    .ar-diag-full-box::-webkit-scrollbar-thumb{background:#465870;border:2px solid #0d1725;border-radius:var(--hha-radius-pill);}
    .ar-diag-full-box::-webkit-scrollbar-thumb:hover{background:#5b6d86;}
    .ar-diag-full-box:focus-visible{outline:none;box-shadow:inset 0 0 0 1px rgba(129,140,248,0.42),0 0 0 2px rgba(129,140,248,0.11);}
    .ar-log-row{display:grid;grid-template-columns:max-content max-content minmax(0,1fr) max-content;align-items:start;column-gap:6px;row-gap:3px;padding:6px 9px;border-bottom:1px solid rgba(148,163,184,0.075);color:#c0cad8;}
    .ar-log-row:last-child{border-bottom:0;}
    .ar-log-row:hover{background:rgba(148,163,184,0.045);}
    .ar-log-row.is-error{background:rgba(255,90,110,0.035);}
    .ar-log-row.is-warning{background:rgba(245,158,11,0.025);}
    .ar-log-time{color:#8796aa;font-family:var(--font-mono);font-size:10.5px;white-space:nowrap;font-variant-numeric:tabular-nums;}
    .ar-log-level{display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:18px;padding:0 5px;border-radius:var(--hha-radius-xs);font-size:10px;line-height:1;font-weight:800;letter-spacing:0.035em;background:rgba(71,126,204,0.13);color:#8bb9ff;text-transform:uppercase;}
    .ar-log-level--ok{background:rgba(52,211,153,0.11);color:#72ddb9;}
    .ar-log-level--warn{background:rgba(245,158,11,0.12);color:#f6c66c;}
    .ar-log-level--err{background:rgba(255,100,120,0.15);color:#ff8797;}
    .ar-log-message{min-width:0;color:#bec8d7;overflow-wrap:anywhere;word-break:normal;white-space:pre-wrap;}
    .ar-log-row.is-error .ar-log-message{color:#ffc1ca;}
    .ar-log-row.is-warning .ar-log-message{color:#f6dbad;}
    .ar-log-repeat{align-self:center;min-width:34px;width:max-content;height:24px;padding:0 7px;border:1px solid rgba(148,163,184,0.16);border-radius:var(--hha-radius-pill);background:rgba(148,163,184,0.07);color:#9aa9bd;font-family:inherit;font-size:10.5px;font-weight:800;cursor:pointer;font-variant-numeric:tabular-nums;transition:all var(--hha-duration-fast) ease;}
    .ar-log-repeat:hover{border-color:rgba(165,180,252,0.34);background:rgba(129,140,248,0.11);color:#c7ccff;}
    .ar-log-repeat:focus-visible{outline:1px solid #9ca3ff;outline-offset:1px;}
    .ar-log-group-children{margin:0 8px 5px 121px;border-left:1px solid rgba(148,163,184,0.15);}
    .ar-log-child{display:flex;gap:8px;padding:3px 7px;color:#8796aa;font-size:10.5px;}
    .ar-log-child-time{flex:0 0 66px;color:#8796aa;font-family:var(--font-mono);font-variant-numeric:tabular-nums;}
    .ar-log-empty{display:flex;align-items:center;justify-content:center;height:100%;min-height:100%;padding:28px;color:#8796aa;text-align:center;}
    .ar-log-empty-inner{display:flex;flex-direction:column;align-items:center;gap:8px;max-width:240px;}
    .ar-log-empty-icon{width:48px;height:48px;margin-bottom:2px;color:#63738a;opacity:0.72;}
    .ar-log-empty-icon svg{display:block;width:100%;height:100%;}
    .ar-log-empty-title{font-size:12.5px;line-height:1.25;font-weight:750;color:#b8c3d2;}
    .ar-log-empty-hint{max-width:220px;color:#8796aa;font-size:10.5px;line-height:1.5;}
    .ar-diag-footer-actions{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;min-width:0;}
    .ar-diag-footer-actions > *{min-width:0;}
    .ar-diag-save-btn,.ar-diag-more-btn{width:100%;min-width:0;height:32px;padding-inline:9px;font-size:11px;letter-spacing:0;}
    .ar-dropdown{position:relative;display:inline-block;}
    .ar-dropdown-menu{display:none;position:absolute;right:0;top:calc(100% + 4px);z-index:100;flex-direction:column;gap:2px;padding:5px;min-width:188px;border:1px solid var(--hha-border);border-radius:var(--hha-radius-lg);background:#ffffff;box-shadow:var(--hha-shadow-lg);}
    .ar-dropdown.is-open .ar-dropdown-menu{display:flex;}
    .ar-diag-full-dropdown{display:block;min-width:0;}
    .ar-diag-full-dropdown .ar-dropdown-menu{right:0;left:auto;top:auto;bottom:calc(100% + 5px);}
    .ar-dropdown-item{display:flex;align-items:center;width:100%;padding:7px 9px;border:1px solid transparent;border-radius:var(--hha-radius-md);background:transparent;color:var(--hha-text-secondary);font-size:11.5px;font-weight:500;text-align:left;cursor:pointer;transition:background var(--hha-duration-fast) var(--hha-ease-premium),color var(--hha-duration-fast) var(--hha-ease-premium),box-shadow var(--hha-duration-fast) var(--hha-ease-premium);}
    .ar-dropdown-item:hover{background:var(--hha-surface-hover);color:var(--hha-text);}
    .ar-dropdown-item:active{background:var(--hha-surface-active);}
    .ar-dropdown-item:focus-visible{outline:none;box-shadow:var(--hha-shadow-control-focus);color:var(--hha-text);}
    .ar-dropdown-item--danger{color:var(--hha-danger);}
    .ar-dropdown-item--danger:hover{background:var(--hha-danger-soft);color:var(--hha-danger-hover);}
    .ar-icon-only{display:inline-flex;align-items:center;justify-content:center;padding:0;white-space:nowrap;}
    .ar-icon-svg{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;line-height:0;flex:none;pointer-events:none;}
    .ar-icon-svg svg{display:block;width:100%;height:100%;}
    .ar-icon-svg--trash{transform:translateY(-0.25px);}
    .ar-sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important;}
    html.hha-compact #ar-main-panel .ar-header{padding-inline:10px;}
    html.hha-compact #ar-main-panel .ar-scroll{padding-inline:10px;}
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
        .ar-scroll{padding-top:8px;gap:7px;}
        .ar-execution-shell{padding-top:5px;padding-bottom:8px;}
        #ar-mode-card.ar-execution-core{padding:10px 12px 9px;gap:7px;}
        .ar-work-mode-options{gap:3px;}
        .ar-work-mode-option{height:22px;font-size:10px;}
        .ar-execution-meta{padding-top:6px;}
        .ar-execution-actions{gap:6px;}
        .ar-execution-utils .ar-util-btn{height:28px;min-height:28px;}
        .ar-diag-body{gap:5px;padding-top:8px;padding-bottom:8px;}
        .ar-diag-full-box{min-height:88px;}
    }
    @media (prefers-reduced-motion: reduce){
        .ar-work-mode-thumb,
        .ar-work-mode-thumb__body,
        .ar-work-mode-thumb__shadow,
        .ar-work-mode-turbo-surface,
        .ar-work-mode-grid-mask,
        .ar-work-mode-option,
        .ar-work-mode-snap-marker{transition-duration:1ms!important;}
        .ar-work-mode-thumb__body{transform:none!important;}
        .ar-work-mode-grid-strip{animation:none!important;}
        .ar-work-mode-grid-cell{transform:none!important;opacity:var(--cell-alpha,0.15)!important;}
        #ar-main-panel *,#ar-toggle-btn,#ar-toggle-btn *{animation:none!important;transition:none!important;}
        .ar-btn,.ar-header-action{transform:none!important;}
        #ar-toggle-btn.is-running{background:linear-gradient(155deg,#7a75bb 0%,#6661aa 52%,#56518e 100%);filter:brightness(1.045) saturate(1.035);box-shadow:-3px 4px 10px rgba(76,70,151,0.22),-1px 2px 4px rgba(20,30,45,0.09);}
    }
    `;
    (document.head || document.documentElement).appendChild(style);
}
