import { qa } from '../dom/dom-adapter.js';
import { config, persistSettings, State, setStatus, log } from '../core/state-manager.js';
import { modeKeyToIndex, modeIndexToKey, presetLabel, I18n } from '../i18n/index.js';
import { AutosaveFeedback } from './autosave.js';

export const WorkModeSlider = (() => {
    let resizeObserver: ResizeObserver | null = null;
    let activeTurboEffects: any = null;
    let onVisibilityChangeImpl: (isOpen: boolean) => void = () => {};

    function mount({ el, uiSignal }: { el: (id: string) => HTMLElement | null; uiSignal: AbortSignal }) {
        const modeCard = el('ar-mode-card');
        const slider = el('ar-work-mode-slider');
        const thumb = el('ar-work-mode-thumb');
        const thumbShadow = el('ar-work-mode-thumb-shadow');
        const thumbBody = el('ar-work-mode-thumb-body');
        const gridStrip = el('ar-work-mode-grid-strip');
        const reducedMotionQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia('(prefers-reduced-motion: reduce)')
            : { matches: false } as MediaQueryList;

        function isWorkModeVisible() {
            if (uiSignal?.aborted || (typeof document !== 'undefined' && document.hidden) || !slider) return false;
            const panelEl = document.getElementById('ar-main-panel');
            const mainView = document.getElementById('ar-view-main');
            if (!panelEl || panelEl.style.display === 'none') return false;
            if (mainView && mainView.style.display === 'none') return false;
            if (panelEl.isConnected === false || slider.isConnected === false) return false;
            if (typeof panelEl.contains === 'function' && !panelEl.contains(slider)) return false;
            return true;
        }

        function isTurboGridVisible() {
            return modeKeyToIndex(config.preset) === 3 && isWorkModeVisible();
        }

        function canRunTurboEffects() {
            return isTurboGridVisible() && !reducedMotionQuery.matches;
        }

        const STATE = {
            REST: 'REST',
            TRAVEL_LIFT: 'TRAVEL_LIFT',
            TRAVEL: 'TRAVEL',
            SETTLING: 'SETTLING',
            TURBO_DEPTH_OUT: 'TURBO_DEPTH_OUT',
            TURBO_DEPTH_RETURN: 'TURBO_DEPTH_RETURN',
            IMPACT: 'IMPACT',
            SHOCKWAVE: 'SHOCKWAVE'
        };

        let currentState = STATE.REST;

        const TRAVEL_LIFT_Z = 11;
        const TRAVEL_LIFT_DURATION = 150;
        const TRAVEL_SETTLE_DURATION = 220;
        const HORIZONTAL_SNAP_DURATION = 255;

        const TURBO_PEAK_Z = 26;
        const TURBO_OUT_DURATION = 420;
        const TURBO_HOLD_DURATION = 80;
        const TURBO_RETURN_DURATION = 280;
        const TURBO_SETTLE_PAUSE = 400;

        const EASE_PREMIUM = 'cubic-bezier(0.22, 0.8, 0.3, 1)';
        const EASE_TURBO_OUT = 'cubic-bezier(0.16, 0.84, 0.44, 1)';
        const EASE_TURBO_RETURN = 'cubic-bezier(0.45, 0, 0.8, 0.5)';

        let currentBodyAnimation: Animation | null = null;
        let currentShadowAnimation: Animation | null = null;
        let turboPulseTimer: any = 0;
        let turboHoldTimer: any = 0;
        let travelSettleTimer: any = 0;
        let isDragging = false;
        let isSnapping = false;

        let cachedMetrics = {
            pad: 3,
            thumbWidth: 44,
            travel: 0,
            sliderWidth: 1
        };

        let gridCells: any[] = [];
        let gridMetrics = {
            width: 1,
            columns: 1,
            rows: 5,
            periodWidth: 1
        };
        let gridCleanupTimer: any = 0;
        let gridCleanupGeneration = 0;
        let gridRefreshRafId = 0;
        let resizeRafId = 0;

        const SHOCK_CYCLE_SECONDS = 5;
        const GRID_DRIFT_SECONDS = 60;
        const TURBO_GRID_EXIT_CLEANUP_MS = 220;

        if (modeCard) {
            modeCard.style.setProperty('--ar-work-shock-cycle-duration', `${SHOCK_CYCLE_SECONDS}s`);
            modeCard.style.setProperty('--ar-work-turbo-grid-duration', `${GRID_DRIFT_SECONDS}s`);
        }

        let gridDriftAnimation: Animation | null = null;
        let shockCycleSeconds = SHOCK_CYCLE_SECONDS;
        let shockStart = 0;
        let shockTravelMs = 0;
        let shockRafId = 0;
        let shockActive = false;
        let lastShockStartedAt = 0;
        let currentThumbSourceX = 0;

        function updateCachedMetrics() {
            if (!slider || !thumb) return cachedMetrics;
            const style = getComputedStyle(slider);
            const pad = parseFloat(style.getPropertyValue('--ar-work-track-pad')) || 3;
            const thumbWidth = thumb.offsetWidth || 44;
            const sliderWidth = Math.max(1, slider.clientWidth);
            const travel = Math.max(0, sliderWidth - (pad * 2) - thumbWidth);
            cachedMetrics = { pad, thumbWidth, travel, sliderWidth };
            return cachedMetrics;
        }

        function positionForValue(val: number) {
            const { travel } = cachedMetrics;
            return (travel / 3) * val;
        }

        function setThumbX(x: number, animate = true) {
            if (!slider || !thumb) return;
            if (animate) {
                slider.classList.remove('is-dragging');
            } else {
                slider.classList.add('is-dragging');
            }
            const { pad, thumbWidth } = cachedMetrics;
            const leftEdge = Math.max(0, pad + x);
            const centerX = leftEdge + (thumbWidth / 2);
            currentThumbSourceX = leftEdge;
            slider.style.setProperty('--thumb-source-x', `${leftEdge.toFixed(2)}px`);
            slider.style.setProperty('--thumb-center-x', `${centerX.toFixed(2)}px`);
            thumb.style.transform = `translate3d(${x.toFixed(2)}px, 0, 0)`;
        }

        function getThumbSourceX() {
            if (Number.isFinite(currentThumbSourceX) && currentThumbSourceX > 0) {
                return currentThumbSourceX;
            }
            const { pad } = cachedMetrics;
            const curVal = modeKeyToIndex(config.preset);
            return pad + positionForValue(curVal);
        }

        function getCurrentBodyZ() {
            if (!thumbBody) return 0;
            try {
                const tr = getComputedStyle(thumbBody).transform;
                if (!tr || tr === 'none') return 0;
                const matrix = new DOMMatrixReadOnly(tr);
                return Number.isFinite(matrix.m43) ? matrix.m43 : 0;
            } catch (e) {
                return 0;
            }
        }

        function getShadowStyle(z: number) {
            const clampedZ = Math.max(0, Math.min(32, z));
            const norm = clampedZ / 26;
            const blur1 = (7 + norm * 15).toFixed(1);
            const y1 = (3 + norm * 8).toFixed(1);
            const alpha1 = (0.085 + norm * 0.075).toFixed(3);

            const blur2 = (2 + norm * 5).toFixed(1);
            const y2 = (1 + norm * 3).toFixed(1);
            const alpha2 = (0.065 + norm * 0.025).toFixed(3);

            return {
                boxShadow: `0 ${y1}px ${blur1}px rgba(27,35,48,${alpha1}), 0 ${y2}px ${blur2}px rgba(27,35,48,${alpha2})`,
                transform: `scale(${1 + norm * 0.035})`
            };
        }

        function stopDepthAnimations() {
            if (currentBodyAnimation) {
                try { currentBodyAnimation.cancel(); } catch (e) { /* ignore */ }
                currentBodyAnimation = null;
            }
            if (currentShadowAnimation) {
                try { currentShadowAnimation.cancel(); } catch (e) { /* ignore */ }
                currentShadowAnimation = null;
            }
        }

        function clearTurboTimers() {
            if (turboPulseTimer) {
                clearTimeout(turboPulseTimer);
                turboPulseTimer = 0;
            }
            if (turboHoldTimer) {
                clearTimeout(turboHoldTimer);
                turboHoldTimer = 0;
            }
            if (travelSettleTimer) {
                clearTimeout(travelSettleTimer);
                travelSettleTimer = 0;
            }
        }

        function animateThumbDepth(targetZ: number, durationMs: number, easing = EASE_PREMIUM, onFinish: (() => void) | null = null) {
            if (!thumbBody) {
                if (onFinish) onFinish();
                return;
            }

            const startZ = getCurrentBodyZ();
            stopDepthAnimations();

            if (reducedMotionQuery.matches || durationMs <= 0 || Math.abs(startZ - targetZ) < 0.01) {
                thumbBody.style.transform = targetZ === 0 ? 'translateZ(0)' : `translateZ(${targetZ.toFixed(2)}px)`;
                if (thumbShadow) {
                    const st = getShadowStyle(targetZ);
                    thumbShadow.style.boxShadow = st.boxShadow;
                    thumbShadow.style.transform = st.transform;
                }
                if (onFinish) onFinish();
                return;
            }

            const keyframes = [
                { transform: `translateZ(${startZ.toFixed(2)}px)` },
                { transform: `translateZ(${targetZ.toFixed(2)}px)` }
            ];

            try {
                currentBodyAnimation = thumbBody.animate(keyframes, {
                    duration: durationMs,
                    easing: easing,
                    fill: 'forwards'
                });

                if (thumbShadow) {
                    const fromSt = getShadowStyle(startZ);
                    const toSt = getShadowStyle(targetZ);
                    currentShadowAnimation = thumbShadow.animate([
                        { boxShadow: fromSt.boxShadow, transform: fromSt.transform },
                        { boxShadow: toSt.boxShadow, transform: toSt.transform }
                    ], {
                        duration: durationMs,
                        easing: easing,
                        fill: 'forwards'
                    });

                    currentShadowAnimation.onfinish = () => {
                        thumbShadow.style.boxShadow = toSt.boxShadow;
                        thumbShadow.style.transform = toSt.transform;
                        if (currentShadowAnimation) {
                            try { currentShadowAnimation.cancel(); } catch (e) {}
                            currentShadowAnimation = null;
                        }
                    };
                }

                currentBodyAnimation.onfinish = () => {
                    thumbBody.style.transform = targetZ === 0 ? 'translateZ(0)' : `translateZ(${targetZ.toFixed(2)}px)`;
                    if (currentBodyAnimation) {
                        try { currentBodyAnimation.cancel(); } catch (e) {}
                        currentBodyAnimation = null;
                    }
                    if (onFinish) onFinish();
                };
            } catch (e) {
                thumbBody.style.transform = targetZ === 0 ? 'translateZ(0)' : `translateZ(${targetZ.toFixed(2)}px)`;
                if (onFinish) onFinish();
            }
        }

        function cancelTurboPulse({ resetToRest = false } = {}) {
            clearTurboTimers();
            if (currentState === STATE.TURBO_DEPTH_OUT || currentState === STATE.TURBO_DEPTH_RETURN || currentState === STATE.IMPACT) {
                stopDepthAnimations();
            }
            if (shockActive) {
                stopShockwave({ clearSchedule: true });
            }
            if (resetToRest) {
                currentState = STATE.REST;
            }
        }

        function startTravelLift(onLiftComplete: (() => void) | null = null) {
            cancelTurboPulse();

            const currentZ = getCurrentBodyZ();
            currentState = STATE.TRAVEL_LIFT;

            if (Math.abs(currentZ - TRAVEL_LIFT_Z) < 0.5) {
                currentState = (isDragging || isSnapping) ? STATE.TRAVEL : STATE.TRAVEL_LIFT;
                if (onLiftComplete) onLiftComplete();
                return;
            }

            animateThumbDepth(TRAVEL_LIFT_Z, TRAVEL_LIFT_DURATION, EASE_PREMIUM, () => {
                if (currentState === STATE.TRAVEL_LIFT) {
                    currentState = (isDragging || isSnapping) ? STATE.TRAVEL : STATE.TRAVEL_LIFT;
                }
                if (onLiftComplete) onLiftComplete();
            });
        }

        function finishTravelAndSettle() {
            isDragging = false;
            isSnapping = false;

            if (travelSettleTimer) {
                clearTimeout(travelSettleTimer);
                travelSettleTimer = 0;
            }

            currentState = STATE.SETTLING;

            animateThumbDepth(0, TRAVEL_SETTLE_DURATION, EASE_PREMIUM, () => {
                currentState = STATE.REST;
                if (canRunTurboEffects() && !isDragging && !isSnapping) {
                    scheduleTurboPulse(TURBO_SETTLE_PAUSE);
                }
            });
        }

        function scheduleTurboPulse(delayMs = 0) {
            clearTurboTimers();
            if (!canRunTurboEffects() || isDragging || isSnapping || currentState !== STATE.REST) {
                return;
            }

            const intervalMs = Math.max(5000, shockCycleSeconds * 1000);
            const delay = delayMs > 0
                ? delayMs
                : (lastShockStartedAt ? Math.max(600, (lastShockStartedAt + intervalMs) - performance.now()) : 600);

            turboPulseTimer = setTimeout(() => {
                turboPulseTimer = 0;
                if (!canRunTurboEffects()) return;
                executeTurboPulse();
            }, delay);
        }

        function executeTurboPulse() {
            if (!canRunTurboEffects() || isDragging || isSnapping || currentState !== STATE.REST) {
                return;
            }

            currentState = STATE.TURBO_DEPTH_OUT;

            animateThumbDepth(TURBO_PEAK_Z, TURBO_OUT_DURATION, EASE_TURBO_OUT, () => {
                if (currentState !== STATE.TURBO_DEPTH_OUT) return;

                turboHoldTimer = setTimeout(() => {
                    turboHoldTimer = 0;
                    if (currentState !== STATE.TURBO_DEPTH_OUT) return;

                    currentState = STATE.TURBO_DEPTH_RETURN;

                    animateThumbDepth(0, TURBO_RETURN_DURATION, EASE_TURBO_RETURN, () => {
                        if (currentState !== STATE.TURBO_DEPTH_RETURN) return;

                        currentState = STATE.IMPACT;
                        startShockwave();
                        currentState = STATE.SHOCKWAVE;
                    });
                }, TURBO_HOLD_DURATION);
            });
        }

        function seededNoise(index: number) {
            const x = Math.sin(index * 12.9898 + 78.233) * 43758.5453;
            return x - Math.floor(x);
        }

        function levelFor(index: number) {
            const n = seededNoise(index + 91);
            if (n < .18) return 'l0';
            if (n < .35) return 'l1';
            if (n < .53) return 'l2';
            if (n < .69) return 'l3';
            if (n < .84) return 'l4';
            return 'l5';
        }

        function pxVar(name: string, fallback: number) {
            if (!modeCard && !slider) return fallback;
            const target = (modeCard || slider) as Element;
            const style = getComputedStyle(target);
            const n = parseFloat(style.getPropertyValue(name));
            return Number.isFinite(n) ? n : fallback;
        }

        function gaussian(distance: number, width: number) {
            const ratio = distance / width;
            return Math.exp(-.5 * ratio * ratio);
        }

        function clamp01(val: number) {
            return Math.max(0, Math.min(1, val));
        }

        function smoothstep(edge0: number, edge1: number, x: number) {
            if (edge0 === edge1) return x < edge0 ? 0 : 1;
            const t = clamp01((x - edge0) / (edge1 - edge0));
            return t * t * (3 - 2 * t);
        }

        function resetShockCells() {
            for (const cell of gridCells) {
                if (!cell.active && cell.lastBoost === '0' && cell.lastX === '0px' && cell.lastY === '0px' && cell.lastScale === '1') continue;
                const style = cell.element.style;
                style.setProperty('--wave-boost', '0');
                style.setProperty('--wave-x', '0px');
                style.setProperty('--wave-y', '0px');
                style.setProperty('--wave-scale', '1');
                cell.active = false;
                cell.lastBoost = '0';
                cell.lastX = '0px';
                cell.lastY = '0px';
                cell.lastScale = '1';
            }
        }

        function cancelGridCleanup() {
            gridCleanupGeneration++;
            if (!gridCleanupTimer) return;
            clearTimeout(gridCleanupTimer);
            gridCleanupTimer = 0;
        }

        function clearGridDom() {
            if (!gridStrip) return;
            if (gridRefreshRafId) {
                cancelAnimationFrame(gridRefreshRafId);
                gridRefreshRafId = 0;
            }
            gridStrip.replaceChildren();
            gridStrip.style.width = '';
            slider?.style.setProperty('--ar-work-grid-shift', '');
            slider?.classList.remove('has-turbo-grid');
            gridCells = [];
            gridMetrics = { width: 1, columns: 1, rows: 5, periodWidth: 1 };
            gridDriftAnimation = null;
        }

        function clearGridNow() {
            cancelGridCleanup();
            clearGridDom();
        }

        function scheduleGridCleanup() {
            cancelGridCleanup();
            if (!gridCells.length) return;
            const generation = gridCleanupGeneration;
            gridCleanupTimer = setTimeout(() => {
                if (generation !== gridCleanupGeneration) return;
                gridCleanupTimer = 0;
                if (isTurboGridVisible()) return;
                clearGridDom();
            }, TURBO_GRID_EXIT_CLEANUP_MS);
        }

        function rebuildGrid() {
            if (!slider || !gridStrip || !isTurboGridVisible()) return;
            const rows = 5;
            const cellSize = pxVar('--ar-work-grid-cell', 5);
            const gap = pxVar('--ar-work-grid-col-gap', 2);
            const cadence = cellSize + gap;
            const width = Math.max(1, slider.clientWidth);

            const columns = Math.max(1, Math.ceil((width + gap) / cadence) + 2);
            const periodWidth = columns * cadence;
            const fragment = document.createDocumentFragment();
            const metadata: any[] = [];

            for (let period = 0; period < 2; period++) {
                for (let column = 0; column < columns; column++) {
                    for (let row = 0; row < rows; row++) {
                        const index = column * rows + row;
                        const baseLevel = levelFor(index);
                        const element = document.createElement('span');

                        element.className = `ar-work-mode-grid-cell ${baseLevel}`;
                        fragment.appendChild(element);

                        metadata.push({
                            element,
                            column,
                            row,
                            period,
                            stripX: period * periodWidth + column * cadence + cellSize / 2,
                            phase: (seededNoise(index * 1.731 + 17.9) - .5) * .018,
                            interferenceStatic: row * 1.27,
                            echoStatic: row * 1.61,
                            baseLevel,
                            active: false,
                            lastBoost: '0',
                            lastX: '0px',
                            lastY: '0px',
                            lastScale: '1'
                        });
                    }
                }
            }

            gridStrip.replaceChildren(fragment);
            gridStrip.style.width = `${(periodWidth * 2) - gap}px`;
            slider.style.setProperty('--ar-work-grid-shift', `${-periodWidth}px`);
            slider.classList.add('has-turbo-grid');

            gridCells = metadata;
            gridMetrics = { width, columns, rows, periodWidth };

            refreshGridDriftAnimation();
            resetShockCells();
        }

        function ensureGrid() {
            cancelGridCleanup();
            if (!gridCells.length && isTurboGridVisible()) rebuildGrid();
        }

        function refreshGridDriftAnimation() {
            if (!gridStrip || typeof gridStrip.getAnimations !== 'function') {
                gridDriftAnimation = null;
                return;
            }
            const animations = gridStrip.getAnimations();
            gridDriftAnimation = animations.length ? animations[0] : null;
        }

        function currentGridDriftOffset() {
            if (!gridDriftAnimation) {
                refreshGridDriftAnimation();
            }

            if (!gridDriftAnimation) {
                return 0;
            }

            const timing = (gridDriftAnimation.effect as any)?.getComputedTiming?.();
            const progress = Number.isFinite(timing?.progress) ? timing.progress : 0;
            return -gridMetrics.periodWidth * progress;
        }

        function travelDurationMs(cycleSeconds = shockCycleSeconds) {
            const normalized = clamp01((cycleSeconds - 5) / 35);
            return 1800 + normalized * 1200;
        }

        function stopShockwave({ clearSchedule = true } = {}) {
            if (shockRafId) {
                cancelAnimationFrame(shockRafId);
                shockRafId = 0;
            }

            if (clearSchedule) {
                clearTurboTimers();
            }

            shockActive = false;
            resetShockCells();
        }

        function startShockwave() {
            if (!canRunTurboEffects() || !gridCells.length) return;

            if (shockRafId) {
                cancelAnimationFrame(shockRafId);
                shockRafId = 0;
            }

            shockActive = true;
            shockStart = performance.now();
            lastShockStartedAt = shockStart;
            shockTravelMs = travelDurationMs();

            shockRafId = requestAnimationFrame(updateShockwave);
        }

        function updateShockwave(now: number) {
            if (!shockActive || !canRunTurboEffects()) {
                stopShockwave({ clearSchedule: false });
                return;
            }

            const elapsed = now - shockStart;
            const travelProgress = clamp01(elapsed / shockTravelMs);
            const travelEase = 1 - Math.pow(1 - travelProgress, 1.08);
            const sliderWidth = Math.max(1, gridMetrics.width || slider?.clientWidth || 1);
            const thumbSourceX = getThumbSourceX();
            const originNorm = clamp01(thumbSourceX / sliderWidth);
            const frontX = originNorm - (originNorm + 0.08) * travelEase;
            const elapsedSeconds = elapsed / 1000;

            const settleMs = 950;
            const globalDecay = elapsed <= shockTravelMs
                ? 1
                : 1 - smoothstep(shockTravelMs, shockTravelMs + settleMs, elapsed);

            const driftOffset = currentGridDriftOffset();

            for (const cell of gridCells) {
                const visualXPx = cell.stripX + driftOffset;
                const visualX = visualXPx / sliderWidth;
                const x = visualX + cell.phase;
                const distance = x - frontX;

                if (visualX < -.25 || visualX > 1.25 || distance < -.22 || distance > .50) {
                    if (cell.active) {
                        const style = cell.element.style;
                        style.setProperty('--wave-boost', '0');
                        style.setProperty('--wave-x', '0px');
                        style.setProperty('--wave-y', '0px');
                        style.setProperty('--wave-scale', '1');
                        cell.active = false;
                        cell.lastBoost = '0';
                        cell.lastX = '0px';
                        cell.lastY = '0px';
                        cell.lastScale = '1';
                    }
                    continue;
                }

                const core = gaussian(distance, .026) * globalDecay;
                const compression = gaussian(distance + .034, .030) * globalDecay;
                const wakeGate = smoothstep(-.012, .018, distance);
                const wake = gaussian(distance - .075, .105) * wakeGate * globalDecay;
                const echoGate = smoothstep(.035, .075, distance);
                const echo = gaussian(distance - .135, .040) * echoGate * globalDecay;

                const boost = core * .50 + compression * .055 + wake * .13 + echo * .08;
                const scale = 1 + core * .185 + wake * .035 + echo * .018 - compression * .018;
                const waveX = core * -1.05 + compression * -.55 + wake * .30 + echo * .10;
                const interference = Math.sin(visualX * 19.0 + cell.interferenceStatic + elapsedSeconds * 6.2 + cell.phase * 55);
                const echoInterference = Math.sin(visualX * 14.0 + cell.echoStatic + elapsedSeconds * 4.1);
                const waveY = interference * wake * .46 + echoInterference * echo * .16;

                const boostText = boost.toFixed(3);
                const xText = `${waveX.toFixed(3)}px`;
                const yText = `${waveY.toFixed(3)}px`;
                const scaleText = scale.toFixed(3);
                const style = cell.element.style;
                if (boostText !== cell.lastBoost) { style.setProperty('--wave-boost', boostText); cell.lastBoost = boostText; }
                if (xText !== cell.lastX) { style.setProperty('--wave-x', xText); cell.lastX = xText; }
                if (yText !== cell.lastY) { style.setProperty('--wave-y', yText); cell.lastY = yText; }
                if (scaleText !== cell.lastScale) { style.setProperty('--wave-scale', scaleText); cell.lastScale = scaleText; }
                cell.active = true;
            }

            if (elapsed < shockTravelMs + settleMs) {
                shockRafId = requestAnimationFrame(updateShockwave);
                return;
            }

            shockRafId = 0;
            shockActive = false;
            resetShockCells();

            if (currentState === STATE.SHOCKWAVE) {
                currentState = STATE.REST;
            }

            if (canRunTurboEffects() && !isDragging && !isSnapping) {
                scheduleTurboPulse();
            }
        }

        function enterTurbo() {
            if (!isTurboGridVisible()) {
                cancelTurboPulse({ resetToRest: true });
                stopDepthAnimations();
                resetShockCells();
                clearGridNow();
                return;
            }

            ensureGrid();

            if (!canRunTurboEffects()) {
                cancelTurboPulse({ resetToRest: true });
                stopDepthAnimations();
                resetShockCells();
                return;
            }

            cancelTurboPulse();

            if (gridRefreshRafId) cancelAnimationFrame(gridRefreshRafId);
            gridRefreshRafId = requestAnimationFrame(() => {
                gridRefreshRafId = 0;
                if (canRunTurboEffects()) refreshGridDriftAnimation();
            });

            if (currentState === STATE.REST && !isDragging && !isSnapping) {
                scheduleTurboPulse(TURBO_SETTLE_PAUSE);
            }
        }

        function exitTurbo() {
            cancelTurboPulse({ resetToRest: true });
            lastShockStartedAt = 0;
            gridDriftAnimation = null;
            if (gridRefreshRafId) {
                cancelAnimationFrame(gridRefreshRafId);
                gridRefreshRafId = 0;
            }
            if (isWorkModeVisible()) {
                scheduleGridCleanup();
            } else {
                clearGridNow();
            }
        }

        const TurboEffects = Object.freeze({
            startTravelLift,
            finishTravelAndSettle,
            cancel: cancelTurboPulse,
            stopDepth: stopDepthAnimations,
            clearGrid: clearGridNow,
            ensureGrid,
            rebuildGrid,
            refreshGrid: refreshGridDriftAnimation,
            schedule: scheduleTurboPulse,
            enter: enterTurbo,
            exit: exitTurbo,
            destroy: () => {
                if (resizeRafId) {
                    cancelAnimationFrame(resizeRafId);
                    resizeRafId = 0;
                }
                clearGridNow();
            }
        });
        activeTurboEffects = TurboEffects;

        function syncThumb(animate = true) {
            const currentVal = modeKeyToIndex(config.preset);
            setThumbX(positionForValue(currentVal), animate);
        }

        function updateModeUI(val: number, { animateThumb = true } = {}) {
            const key = modeIndexToKey(val);
            const label = presetLabel(key);
            const wasTurbo = slider?.classList.contains('is-turbo') || false;
            const isTurbo = key === 'turbo';

            if (slider) {
                slider.dataset.value = String(val);
                slider.classList.toggle('is-turbo', isTurbo);
                slider.setAttribute('aria-valuenow', String(val));
                slider.setAttribute('aria-valuetext', label);
            }
            if (modeCard) {
                modeCard.dataset.mode = key;
                qa('.ar-work-mode-option', modeCard).forEach(option => {
                    option.classList.toggle('is-active', (option as HTMLElement).dataset.mode === key);
                });
            }
            syncThumb(animateThumb);

            if (!wasTurbo && isTurbo) {
                TurboEffects.enter();
            } else if (wasTurbo && !isTurbo) {
                TurboEffects.exit();
            }
        }

        function selectWorkMode(nextIndex: number, { focus = false, fromDrag = false } = {}) {
            const clampedIndex = Math.max(0, Math.min(3, nextIndex));
            const nextKey = modeIndexToKey(clampedIndex);

            if (!fromDrag) {
                TurboEffects.startTravelLift();
            }

            isSnapping = true;

            if (travelSettleTimer) {
                clearTimeout(travelSettleTimer);
                travelSettleTimer = 0;
            }

            if (config.preset !== nextKey) {
                const previousIndex = modeKeyToIndex(config.preset);
                if (persistSettings({ ...config, preset: nextKey })) {
                    updateModeUI(clampedIndex, { animateThumb: true });

                    if (State.amIRunning()) {
                        setStatus('running');
                    }

                    AutosaveFeedback.showSaved();
                    log(I18n.t('logs.modeSet', { mode: (nextKey === 'turbo' ? '↯ ' : '') + presetLabel(nextKey) }));
                } else {
                    updateModeUI(previousIndex, { animateThumb: true });
                }
            } else {
                updateModeUI(clampedIndex, { animateThumb: true });
            }

            travelSettleTimer = setTimeout(() => {
                TurboEffects.finishTravelAndSettle();
            }, HORIZONTAL_SNAP_DURATION);

            if (focus && slider) {
                slider.focus({ preventScroll: true });
            }
        }

        if (slider) {
            let pointerId: number | null = null;
            let dragX = 0;
            let pointerStartX = 0;
            let pointerMoved = false;
            let sliderRectLeft = 0;

            function valueFromPointer(clientX: number) {
                const { sliderWidth } = cachedMetrics;
                const local = Math.max(0, Math.min(sliderWidth, clientX - sliderRectLeft));
                const ratio = sliderWidth ? local / sliderWidth : 0;
                return Math.max(0, Math.min(3, Math.floor(ratio * 4)));
            }

            function dragPositionFromPointer(clientX: number) {
                const { pad, thumbWidth, travel } = cachedMetrics;
                const centered = clientX - sliderRectLeft - pad - (thumbWidth / 2);
                return Math.max(0, Math.min(travel, centered));
            }

            function nearestValueForX(x: number) {
                const { travel } = cachedMetrics;
                if (travel <= 0) return 0;
                return Math.max(0, Math.min(3, Math.round((x / travel) * 3)));
            }

            slider.addEventListener('pointerdown', (event: PointerEvent) => {
                if (event.button !== undefined && event.button !== 0) return;
                isDragging = true;
                pointerId = event.pointerId;
                pointerStartX = event.clientX;
                pointerMoved = false;

                updateCachedMetrics();
                sliderRectLeft = slider.getBoundingClientRect().left;

                try { slider.setPointerCapture?.(pointerId); } catch (e) { /* ignore */ }

                slider.classList.add('is-pressed', 'is-dragging');
                TurboEffects.startTravelLift();

                dragX = dragPositionFromPointer(event.clientX);
                setThumbX(dragX, false);
            }, { signal: uiSignal });

            slider.addEventListener('pointermove', (event: PointerEvent) => {
                if (!isDragging || event.pointerId !== pointerId) return;
                if (Math.abs(event.clientX - pointerStartX) > 4) {
                    pointerMoved = true;
                }
                dragX = dragPositionFromPointer(event.clientX);
                setThumbX(dragX, false);
            }, { signal: uiSignal });

            const finishPointer = (event: PointerEvent) => {
                if (!isDragging || event.pointerId !== pointerId) return;
                slider.classList.remove('is-pressed', 'is-dragging');
                try { slider.releasePointerCapture?.(pointerId); } catch (e) { /* ignore */ }
                pointerId = null;

                const target = pointerMoved
                    ? nearestValueForX(dragX)
                    : valueFromPointer(event.clientX);

                selectWorkMode(target, { focus: true, fromDrag: true });
            };

            slider.addEventListener('pointerup', finishPointer as EventListener, { signal: uiSignal });
            slider.addEventListener('pointercancel', ((event: PointerEvent) => {
                if (event.pointerId !== pointerId) return;
                slider.classList.remove('is-pressed', 'is-dragging');
                pointerId = null;
                const currentVal = modeKeyToIndex(config.preset);
                selectWorkMode(currentVal, { fromDrag: true });
            }) as EventListener, { signal: uiSignal });

            slider.addEventListener('keydown', (event: KeyboardEvent) => {
                const curVal = modeKeyToIndex(config.preset);
                let nextVal = curVal;
                switch (event.key) {
                    case 'ArrowLeft':
                    case 'ArrowDown':
                        nextVal = Math.max(0, curVal - 1);
                        break;
                    case 'ArrowRight':
                    case 'ArrowUp':
                        nextVal = Math.min(3, curVal + 1);
                        break;
                    case 'Home':
                        nextVal = 0;
                        break;
                    case 'End':
                        nextVal = 3;
                        break;
                    default:
                        return;
                }
                event.preventDefault();
                selectWorkMode(nextVal);
            }, { signal: uiSignal });

            resizeObserver = new ResizeObserver(() => {
                if (resizeRafId) return;
                resizeRafId = requestAnimationFrame(() => {
                    resizeRafId = 0;
                    updateCachedMetrics();
                    syncThumb(false);

                    if (isTurboGridVisible()) {
                        TurboEffects.cancel({ resetToRest: true });
                        TurboEffects.stopDepth();
                        if (thumbBody) {
                            thumbBody.style.transform = 'translateZ(0)';
                        }
                        if (thumbShadow) {
                            const st = getShadowStyle(0);
                            thumbShadow.style.boxShadow = st.boxShadow;
                            thumbShadow.style.transform = st.transform;
                        }

                        TurboEffects.rebuildGrid();
                        TurboEffects.refreshGrid();

                        if (canRunTurboEffects()) {
                            TurboEffects.schedule(TURBO_SETTLE_PAUSE);
                        }
                    }

                    requestAnimationFrame(() => {
                        slider?.classList.remove('is-dragging');
                    });
                });
            });
            resizeObserver.observe(slider);

            function handleReducedMotionChange() {
                if (reducedMotionQuery.matches) {
                    TurboEffects.ensureGrid();
                    TurboEffects.cancel({ resetToRest: true });
                    TurboEffects.stopDepth();
                    if (thumbBody) thumbBody.style.transform = 'translateZ(0)';
                    if (thumbShadow) {
                        const st = getShadowStyle(0);
                        thumbShadow.style.boxShadow = st.boxShadow;
                        thumbShadow.style.transform = st.transform;
                    }
                } else if (canRunTurboEffects()) {
                    TurboEffects.enter();
                }
            }

            if (typeof reducedMotionQuery.addEventListener === 'function') {
                try {
                    reducedMotionQuery.addEventListener('change', handleReducedMotionChange, { signal: uiSignal });
                } catch (e) {
                    reducedMotionQuery.addEventListener('change', handleReducedMotionChange);
                }
            } else if (typeof (reducedMotionQuery as any).addListener === 'function') {
                (reducedMotionQuery as any).addListener(handleReducedMotionChange);
            }

            function onVisibilityChange(isOpen: boolean) {
                if (!isOpen || !isTurboGridVisible()) {
                    if (resizeRafId) {
                        cancelAnimationFrame(resizeRafId);
                        resizeRafId = 0;
                    }
                    TurboEffects.cancel({ resetToRest: true });
                    TurboEffects.stopDepth();
                    TurboEffects.clearGrid();
                } else {
                    TurboEffects.enter();
                }
            }
            onVisibilityChangeImpl = onVisibilityChange;

            document.addEventListener('visibilitychange', () => {
                const panelEl = document.getElementById('ar-main-panel');
                const isPanelOpen = panelEl && panelEl.style.display !== 'none';
                onVisibilityChange(Boolean(isPanelOpen && !document.hidden));
            }, { signal: uiSignal });

            function cleanupWorkModeAnimation() {
                TurboEffects.cancel({ resetToRest: true });
                TurboEffects.stopDepth();
                TurboEffects.destroy();
                if (typeof reducedMotionQuery.removeEventListener === 'function') {
                    try { reducedMotionQuery.removeEventListener('change', handleReducedMotionChange); } catch (e) {}
                } else if (typeof (reducedMotionQuery as any).removeListener === 'function') {
                    try { (reducedMotionQuery as any).removeListener(handleReducedMotionChange); } catch (e) {}
                }
            }

            uiSignal.addEventListener('abort', cleanupWorkModeAnimation, { once: true });

            updateCachedMetrics();
            updateModeUI(modeKeyToIndex(config.preset), { animateThumb: false });
            TurboEffects.ensureGrid();
            requestAnimationFrame(() => {
                if (config.preset === 'turbo' && !isTurboGridVisible()) return;
                updateCachedMetrics();
                syncThumb(false);
                requestAnimationFrame(() => {
                    slider?.classList.remove('is-dragging');
                    if (canRunTurboEffects()) {
                        TurboEffects.enter();
                    }
                });
            });
        }
    }

    function destroy() {
        onVisibilityChangeImpl = () => {};
        if (activeTurboEffects) {
            try { activeTurboEffects.cancel({ resetToRest: true }); } catch (e) { /* ignore */ }
            try { activeTurboEffects.stopDepth(); } catch (e) { /* ignore */ }
            try { activeTurboEffects.destroy(); } catch (e) { /* ignore */ }
            activeTurboEffects = null;
        }
        if (resizeObserver) {
            try { resizeObserver.disconnect(); } catch (e) { /* ignore */ }
            resizeObserver = null;
        }
    }

    return {
        mount,
        onVisibilityChange: (isOpen: boolean) => onVisibilityChangeImpl(isOpen),
        destroy
    };
})();
