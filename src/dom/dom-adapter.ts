import { SELECTORS, TUNING, DOM_SNAPSHOT_MAX } from './selectors.js';
import { collapseSpaces, fnv1a32, randBetween, toNum, prettifyTitle } from '../core/utils.js';
import { I18n } from '../i18n/index.js';
import { Metrics, log, Stats, State, config } from '../core/state-manager.js';
import {
    currentRunId,
    stopSignal,
    activeAbortController,
    isRunCurrent,
    guardOwnedCommit,
    wait
} from '../core/concurrency.js';

// Безопасный querySelector: не бросает исключение на битом селекторе и без DOM.
export const q = <E extends Element = Element>(selector: string, root?: ParentNode | null): E | null => {
    try { return (root || document).querySelector<E>(selector); } catch (e) { return null; }
};

export const qa = <E extends Element = Element>(selector: string, root?: ParentNode | null): E[] => {
    try { return Array.from((root || document).querySelectorAll<E>(selector)); } catch (e) { return []; }
};

export const isVisible = (el: Element | null | undefined): boolean => {
    if (!el) return false;
    try {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    } catch (e) {
        return (el as HTMLElement).offsetParent !== null;
    }
};

export function isAutoResponderUI(el: Element | null | undefined): boolean {
    if (!el) return false;
    let curr: Element | null = el;
    while (curr && curr !== (typeof document !== 'undefined' ? document.body : null)) {
        if (curr.id && String(curr.id).startsWith('ar-')) return true;
        if (curr.className && typeof curr.className === 'string' && curr.className.split(/\s+/).some(c => c.startsWith('ar-'))) return true;
        curr = curr.parentElement;
    }
    return false;
}

export function recordSelectorVariant(name: string, newSel: string, legacySel?: string | null, knownVariant?: string): void {
    try {
        if (knownVariant) {
            Metrics.bump(`sel.${name}.${knownVariant}`);
            return;
        }
        const hasNew = typeof document !== 'undefined' ? !!document.querySelector(newSel) : false;
        const hasLegacy = legacySel && typeof document !== 'undefined' ? !!document.querySelector(legacySel) : false;
        const variant = hasNew ? 'new' : (hasLegacy ? 'legacy' : 'none');
        Metrics.bump(`sel.${name}.${variant}`);
    } catch (e) { /* ignore */ }
}

export function queryExact(key: string, root?: ParentNode | null): Element | null {
    const selector = (SELECTORS as any)[key];
    if (!selector) return null;
    const el = q(selector, root);
    if (!el || isAutoResponderUI(el)) return null;
    recordSelectorVariant(key, selector, null, 'new');
    return el;
}

export function queryHeuristic(key: string, root?: ParentNode | null): Element | null {
    const found = runHeuristic(key, root || (typeof document !== 'undefined' ? document : null));
    if (!found || isAutoResponderUI(found)) return null;
    Metrics.bump(`heuristic.fallback.${key}`);
    log(I18n.t('logs.heuristicFallback', { key, tag: found.tagName.toLowerCase() }));
    return found;
}

// Интеллектуальный поиск элементов с эвристиками на случай изменения верстки
export function query(keyOrSelector: string, root?: ParentNode | null): Element | null {
    const selector = (SELECTORS as any)[keyOrSelector];
    if (!selector) {
        // Если это не ключ из SELECTORS, а сырой селектор, проверим, вдруг это само значение селектора
        const matchedKey = Object.keys(SELECTORS).find(k => (SELECTORS as any)[k] === keyOrSelector);
        if (matchedKey) {
            return query(matchedKey, root);
        }
        const el = q(keyOrSelector, root);
        return isAutoResponderUI(el) ? null : el;
    }
    const el = queryExact(keyOrSelector, root);
    if (el) return el;
    // Запуск эвристического поиска
    return queryHeuristic(keyOrSelector, root);
}

export function queryAll(keyOrSelector: string, root?: ParentNode | null): Element[] {
    const selector = (SELECTORS as any)[keyOrSelector];
    if (!selector) {
        const matchedKey = Object.keys(SELECTORS).find(k => (SELECTORS as any)[k] === keyOrSelector);
        if (matchedKey) {
            return queryAll(matchedKey, root);
        }
        return qa(keyOrSelector, root).filter(el => !isAutoResponderUI(el));
    }
    let elements = qa(selector, root).filter(el => !isAutoResponderUI(el));
    if (elements.length > 0) {
        return elements;
    }
    let found = runHeuristicAll(keyOrSelector, root || (typeof document !== 'undefined' ? document : null)).filter(el => !isAutoResponderUI(el));
    if (found.length > 0) {
        Metrics.bump(`heuristic.fallback.all.${keyOrSelector}`);
        log(I18n.t('logs.heuristicFallbackAll', { key: keyOrSelector, count: found.length }));
    }
    return found;
}

export function runHeuristic(key: string, root?: ParentNode | null): Element | null {
    root = root || (typeof document !== 'undefined' ? document : null);
    if (!root) return null;
    try {
        switch (key) {
            case 'applyBtn':
            case 'vacancyApply':
            {
                const elements = Array.from(root.querySelectorAll('button, a, [role="button"]'));
                const matchText = /откликнуться|отклик без резюме|перейти к отклику|apply|respond|no resume necessary|apply now/i;
                for (const el of elements) {
                    if (matchText.test((el?.textContent || '').trim()) && isVisible(el)) {
                        return el;
                    }
                }
                const candidates = qa('a[href*="/applicant/vacancy_response"], a[data-qa*="response"], button[data-qa*="response"], a[data-qa*="apply"], button[data-qa*="apply"], [role="button"][data-qa*="response"]', root);
                const notApply = /status|success|view-topic|error|chat/i;
                for (const el of candidates) {
                    const qaAttr = el?.getAttribute?.('data-qa') || '';
                    if (notApply.test(qaAttr)) continue;
                    if (isVisible(el)) return el;
                }
                break;
            }
            case 'attachCoverBtn':
            case 'attachCoverInModal': {
                const matchText = /сопроводительное|добавить сопроводительное|написать сопроводительное|письмо|cover letter|attach cover|write cover|add cover/i;
                const activeEls = Array.from(root.querySelectorAll('button, a, [role="button"]'));
                for (const el of activeEls) {
                    if (matchText.test((el?.textContent || '').trim()) && isVisible(el)) {
                        return el;
                    }
                }
                break;
            }
            case 'letterTextarea': {
                const textareas = Array.from(root.querySelectorAll<HTMLTextAreaElement>('textarea'));
                const visibleTextarea = textareas.find(t => isVisible(t));
                if (visibleTextarea) return visibleTextarea;
                const matchText = /сопроводительное|письмо|cover|message|letter/i;
                for (const t of textareas) {
                    const placeholder = t?.getAttribute?.('placeholder') || '';
                    const name = t?.name || '';
                    if (matchText.test(placeholder) || matchText.test(name)) {
                        return t;
                    }
                }
                break;
            }
            case 'letterSubmit': {
                const elements = Array.from(root.querySelectorAll('button, input[type="submit"], [role="button"]'));
                const matchText = /отправить|откликнуться|готово|send|submit|done|apply/i;
                for (const el of elements) {
                    if (!matchText.test((el?.textContent || '').trim())) continue;
                    const qaAttr = el?.getAttribute?.('data-qa') || '';
                    if (qaAttr.includes('vacancy-response-link') || qaAttr.includes('vacancy-serp__vacancy_response')) continue;
                    if (isVisible(el)) return el;
                }
                const submitBtn = root.querySelector('button[type="submit"], input[type="submit"]');
                if (submitBtn && isVisible(submitBtn)) {
                    const qaAttr = submitBtn?.getAttribute?.('data-qa') || '';
                    if (qaAttr.includes('vacancy-response-link') || qaAttr.includes('vacancy-serp__vacancy_response')) {
                        // skip
                    } else {
                        return submitBtn;
                    }
                }
                break;
            }
            case 'relocationBtn': {
                const scopeSelector = '[data-qa*="relocation" i], [role="dialog"], [data-qa*="modal" i], [class*="modal" i]';
                const scope = (root as any).matches?.(scopeSelector) ? root : root.querySelector?.(scopeSelector);
                if (!scope) break;
                const elements = Array.from(scope.querySelectorAll('button, a, [role="button"]'));
                const exact = /^(да|yes|ok|хорошо)[.!]?$/i;
                const phrase = /всё равно|все равно|подтвердить|подтверждаю|согласен|продолжить|confirm|agree|proceed|apply anyway/i;
                for (const el of elements) {
                    const t = collapseSpaces(el?.textContent || '');
                    if (!t || !isVisible(el)) continue;
                    if (exact.test(t) || phrase.test(t)) return el;
                }
                break;
            }
            case 'rejectWarning': {
                const elements = Array.from(root.querySelectorAll('div, span, p, h1, h2, h3'));
                const matchText = /(?:скорее всего|вероятн\w*|возможен|может быть)\W{0,30}отказ|(?:likely|probably|may)\W{0,30}(?:reject|declin)|likely to get a rejection/i;
                for (const el of elements) {
                    if (matchText.test((el?.textContent || '').trim()) && isVisible(el)) {
                        return el;
                    }
                }
                break;
            }
            case 'responseChat': {
                const elements = Array.from(root.querySelectorAll('a, button'));
                const matchText = /перейти (?:в|к) (?:чат|переписк\w*|сообщени\w*)|написать сообщени\w*|открыть чат|(?:go|open|view) (?:the )?(?:chat|conversation|topic)|message (?:the )?employer/i;
                for (const el of elements) {
                    if (matchText.test((el?.textContent || '').trim()) && isVisible(el)) {
                        return el;
                    }
                }
                const chatLink = root.querySelector('a[href*="/chats/"], a[href*="/conversations/"]');
                if (chatLink && isVisible(chatLink)) return chatLink;
                break;
            }
            case 'vacancyCard': {
                const cards = Array.from(root.querySelectorAll('div'));
                for (const c of cards) {
                    const cls = typeof c?.className === 'string' ? c.className : '';
                    if (cls && (cls.includes('serp-item') || cls.includes('vacancy-serp-item'))) {
                        return c;
                    }
                }
                break;
            }
            case 'vacancyLink': {
                const link = root.querySelector('a[href*="/vacancy/"]');
                if (link) return link;
                break;
            }
        }
    } catch (e) {
        console.warn('[HH Apply Assistant] Ошибка в эвристике для ' + key, e);
    }
    return null;
}

export function runHeuristicAll(key: string, root?: ParentNode | null): Element[] {
    root = root || (typeof document !== 'undefined' ? document : null);
    if (!root) return [];
    try {
        switch (key) {
            case 'applyBtn': {
                const buttons = Array.from(root.querySelectorAll('button, a, [role="button"]'));
                const matchText = /откликнуться|отклик без резюме|apply|respond|no resume necessary/i;
                const results = buttons.filter(el => matchText.test((el?.textContent || '').trim()) && isVisible(el));
                if (results.length > 0) return results;
                const notApply = /status|success|view-topic|error|chat/i;
                const hrefs = Array.from(root.querySelectorAll('a[href*="/applicant/vacancy_response"], a[data-qa*="response"], button[data-qa*="response"], a[data-qa*="apply"], button[data-qa*="apply"]'));
                return hrefs.filter(el => !notApply.test(el?.getAttribute?.('data-qa') || '') && isVisible(el));
            }
            case 'vacancyApply': {
                const buttons = Array.from(root.querySelectorAll('button, a, [role="button"]'));
                const matchText = /откликнуться|respond|apply/i;
                return buttons.filter(el => matchText.test((el?.textContent || '').trim()) && isVisible(el));
            }
        }
    } catch (e) {
        console.warn('[HH Apply Assistant] Ошибка в групповой эвристике для ' + key, e);
    }
    return [];
}

export function getVacancyCard(node: Node | null): Element | null {
    if (!node || node.nodeType !== 1) return null;
    let card: Element | null = null;
    try { card = (node as Element).closest?.(SELECTORS.vacancyCard); } catch (e) {}
    if (card) return card;
    const isSingleVacancyNode = (el: Element | null) => el ? qa('a[href*="/vacancy/"]', el).length === 1 : false;
    let curr: Element | null = (node as Element).parentElement;
    while (curr && curr !== (typeof document !== 'undefined' ? document.body : null)) {
        const className = typeof curr.className === 'string' ? curr.className : '';
        const dataQa = curr.getAttribute?.('data-qa') || '';
        if (className.includes('serp-item') || className.includes('vacancy-serp-item') || dataQa.includes('vacancy') || dataQa.includes('serp-item')) {
            if (isSingleVacancyNode(curr)) return curr;
            break;
        }
        curr = curr.parentElement;
    }
    let fallback = (node as Element).parentElement;
    for (let i = 0; i < 4 && fallback && fallback !== (typeof document !== 'undefined' ? document.body : null); i++) {
        const links = qa('a[href*="/vacancy/"]', fallback);
        if (links.length === 1) return fallback;
        if (links.length > 1) break;
        fallback = fallback.parentElement;
    }
    return null;
}

export function getNativeWrapper(el: Element | null): Element | null {
    if (!el) return null;
    let wrapper: Element | null = null;
    try { wrapper = el.closest?.(SELECTORS.nativeWrapper); } catch (e) {}
    if (wrapper) return wrapper;
    return el.closest?.('[data-qa="textarea-native-wrapper"]') || el.closest?.('[class*="native-wrapper"]') || el.parentElement;
}

export async function waitForElement(keyOrSelector: string, timeout = TUNING.waitForModalMs, signal?: AbortSignal | null): Promise<Element | null> {
    const sig = signal || activeAbortController?.signal;
    if (stopSignal || sig?.aborted) return null;
    const el = query(keyOrSelector);
    if (el) return el;
    return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let onAbort: (() => void) | null = null;
        let observer: MutationObserver | null = null;
        let finished = false;

        const finish = (result: Element | null) => {
            if (finished) return;
            finished = true;
            if (timer) { clearTimeout(timer); timer = null; }
            if (observer) { observer.disconnect(); observer = null; }
            if (onAbort && sig) {
                try { sig.removeEventListener('abort', onAbort); } catch (e) {}
            }
            resolve(result);
        };

        if (stopSignal || sig?.aborted) {
            return finish(null);
        }

        onAbort = () => finish(null);
        if (sig) {
            try { sig.addEventListener('abort', onAbort, { once: true }); } catch (e) {}
        }

        if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
            observer = new MutationObserver(() => {
                if (stopSignal || sig?.aborted) {
                    finish(null);
                    return;
                }
                const found = query(keyOrSelector);
                if (found) finish(found);
            });
            try {
                observer.observe(document.documentElement || document, { childList: true, subtree: true });
            } catch (e) {}
        }
        timer = setTimeout(() => finish(null), timeout);
    });
}

export function mutationBelongsToAssistantUI(mutation: MutationRecord | null): boolean {
    if (!mutation) return false;
    if (isAutoResponderUI(mutation.target as Element)) return true;
    const changedNodes = [
        ...Array.from(mutation.addedNodes || []),
        ...Array.from(mutation.removedNodes || [])
    ];
    return changedNodes.length > 0 && changedNodes.every(node => {
        if (node?.nodeType === 1) return isAutoResponderUI(node as Element);
        return isAutoResponderUI((node?.parentElement || mutation.target) as Element);
    });
}

// Ждём выполнения условия (возвращающего не-false значение или truthy результат).
export async function waitForCondition<T>(checkFn: () => T, timeout = TUNING.waitForModalMs, signal?: AbortSignal | null): Promise<T | false> {
    const sig = signal || activeAbortController?.signal;
    if (stopSignal || sig?.aborted) return false;
    try {
        const initial = checkFn();
        if (initial) return initial;
    } catch (e) { /* ignore */ }

    return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let pollTimer: ReturnType<typeof setInterval> | null = null;
        let onAbort: (() => void) | null = null;
        let observer: MutationObserver | null = null;
        let scheduledId: ReturnType<typeof setTimeout> | null = null;
        let finished = false;

        const finish = (result: T | false) => {
            if (finished) return;
            finished = true;
            if (timer) { clearTimeout(timer); timer = null; }
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            if (observer) { observer.disconnect(); observer = null; }
            if (scheduledId) {
                clearTimeout(scheduledId);
                scheduledId = null;
            }
            if (onAbort && sig) {
                try { sig.removeEventListener('abort', onAbort); } catch (e) {}
            }
            resolve(result);
        };

        if (stopSignal || sig?.aborted) return finish(false);

        onAbort = () => finish(false);
        if (sig) {
            try { sig.addEventListener('abort', onAbort, { once: true }); } catch (e) {}
        }

        const executeCheck = () => {
            scheduledId = null;
            if (finished || stopSignal || sig?.aborted) {
                finish(false);
                return;
            }
            try {
                const res = checkFn();
                if (res) finish(res);
            } catch (e) { /* ignore */ }
        };

        if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
            observer = new MutationObserver((mutations) => {
                if (finished || stopSignal || sig?.aborted) {
                    finish(false);
                    return;
                }
                if (mutations?.length && mutations.every(mutationBelongsToAssistantUI)) return;
                if (!scheduledId) {
                    scheduledId = setTimeout(executeCheck, 40);
                }
            });
            try {
                observer.observe(document.documentElement || document, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-busy', 'disabled', 'data-state', 'data-qa']
                });
            } catch (e) {}
        }

        pollTimer = setInterval(executeCheck, 300);
        timer = setTimeout(() => finish(false), timeout);
    });
}

// Корректная вставка текста в textarea (учитывает React/Magritte)
export function fillTextarea(el: HTMLTextAreaElement, value: string): void {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        if (descriptor && descriptor.set) {
            descriptor.set.call(el, value);
        } else {
            el.value = value;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        const wrapper = getNativeWrapper(el);
        const clone = wrapper ? q('pre', wrapper) : null;
        if (clone) clone.textContent = value || '​';
    } catch (e) { console.warn('[HH Apply Assistant] fillTextarea error', e); }
}

export const lastMousePos = { x: 0, y: 0 };

export function updateMousePos(x: number, y: number): void {
    lastMousePos.x = x;
    lastMousePos.y = y;
}

// Максимально человеческий клик: полная последовательность pointer/mouse-событий + нативный click.
export async function realisticClick(el: HTMLElement | null, runId = currentRunId): Promise<boolean> {
    if (!el || !isRunCurrent(runId)) return false;
    try { el.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (e) { /* ignore */ }
    const isTurbo = config?.preset === 'turbo';
    try {
        const rect = el.getBoundingClientRect();
        const offsetX = randBetween(-Math.floor(rect.width / 8), Math.floor(rect.width / 8));
        const offsetY = randBetween(-Math.floor(rect.height / 8), Math.floor(rect.height / 8));
        const cx = Math.max(0, Math.round(rect.left + rect.width / 2 + offsetX));
        const cy = Math.max(0, Math.round(rect.top + rect.height / 2 + offsetY));

        if (!isTurbo) {
            const startX = lastMousePos.x || randBetween(50, 300);
            const startY = lastMousePos.y || randBetween(50, 300);
            const dx = cx - startX;
            const dy = cy - startY;
            const distance = Math.hypot(dx, dy);

            if (distance > 30) {
                const ctrlX1 = startX + dx * 0.25 + randBetween(-40, 40);
                const ctrlY1 = startY + dy * 0.25 + randBetween(-40, 40);
                const ctrlX2 = startX + dx * 0.75 + randBetween(-40, 40);
                const ctrlY2 = startY + dy * 0.75 + randBetween(-40, 40);

                const steps = Math.max(5, Math.min(20, Math.floor(distance / 50)));

                for (let i = 0; i <= steps; i++) {
                    if (!isRunCurrent(runId)) return false;
                    const t = i / steps;
                    const mt = 1 - t;
                    const w0 = mt * mt * mt;
                    const w1 = 3 * mt * mt * t;
                    const w2 = 3 * mt * t * t;
                    const w3 = t * t * t;

                    let px = w0 * startX + w1 * ctrlX1 + w2 * ctrlX2 + w3 * cx;
                    let py = w0 * startY + w1 * ctrlY1 + w2 * ctrlY2 + w3 * cy;

                    if (i > 0 && i < steps) {
                        px += randBetween(-1, 1);
                        py += randBetween(-1, 1);
                    }

                    px = Math.round(px);
                    py = Math.round(py);

                    const moveOpts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: px, clientY: py };
                    const PointerCtor = (window as any).PointerEvent || MouseEvent;
                    try { el.dispatchEvent(new PointerCtor('pointermove', moveOpts)); } catch (e) {}
                    try { el.dispatchEvent(new MouseEvent('mousemove', moveOpts)); } catch (e) {}

                    lastMousePos.x = px;
                    lastMousePos.y = py;

                    const delay = randBetween(6, 12) + (t > 0.85 ? randBetween(5, 10) : 0);
                    await wait(delay);
                    if (!isRunCurrent(runId)) return false;
                }
            }
        }

        if (!isRunCurrent(runId)) return false;

        const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: 1 };
        const PointerCtor = (window as any).PointerEvent || MouseEvent;
        const fire = (Ctor: any, type: string, opts: any) => { try { el.dispatchEvent(new Ctor(type, opts)); } catch (e) { /* ignore */ }; };

        if (!isRunCurrent(runId)) return false;
        fire(PointerCtor, 'pointerover', base);
        fire(MouseEvent, 'mouseover', base);
        fire(PointerCtor, 'pointerdown', base);
        fire(MouseEvent, 'mousedown', base);
        try { el.focus && el.focus(); } catch (e) { /* ignore */ }

        await wait(isTurbo ? randBetween(15, 30) : randBetween(60, 140));
        if (!isRunCurrent(runId)) return false;

        fire(PointerCtor, 'pointerup', { ...base, buttons: 0 });
        fire(MouseEvent, 'mouseup', { ...base, buttons: 0 });

        if (!guardOwnedCommit(runId)) return false;

        let clicked = false;
        try {
            if (typeof el.click === 'function') {
                el.click();
                clicked = true;
            }
        } catch (e) { /* ignore */ }

        if (!clicked) {
            if (!isRunCurrent(runId)) return false;
            fire(MouseEvent, 'click', { ...base, buttons: 0 });
        }

        lastMousePos.x = cx;
        lastMousePos.y = cy;
    } catch (e) { /* ignore */ }

    return isRunCurrent(runId);
}

export function safeClick(el: HTMLElement | null): boolean {
    if (!el) return false;
    try { el.click(); return true; } catch (e) { return false; }
}

export const Page = {
    isVacancy: (): boolean => typeof location !== 'undefined' && location.pathname.startsWith('/vacancy/'),
    isResponseForm: (): boolean => typeof location !== 'undefined' && location.pathname.startsWith('/applicant/vacancy_response'),
    isSearchList: (): boolean => typeof location !== 'undefined' && location.pathname.startsWith('/search/vacancy'),
    isSearch: (): boolean => typeof location !== 'undefined' && (location.href.includes('/search/vacancy') || location.pathname.startsWith('/search'))
};

export function getVacancyIDFromHref(href?: string | null): string | null {
    if (!href) return null;
    const m1 = href.match(/\/vacancy\/(\d+)/);
    if (m1) return String(m1[1]);
    const m2 = href.match(/[?&]vacancyId=(\d+)/);
    if (m2) return String(m2[1]);
    const m3 = href.match(/vacancyId%3D(\d+)/);
    if (m3) return String(m3[1]);
    return null;
}

export function getVacancyID(node: Element | null): string {
    try {
        const card = getVacancyCard(node);
        const link = card ? query('vacancyLink', card) as HTMLAnchorElement | null : null;
        const href = (link && link.href) || ((node as HTMLAnchorElement)?.href) || (node && node.getAttribute && node.getAttribute('href')) || '';
        const id = getVacancyIDFromHref(href);
        if (id) return 'v_' + id;
        let text = '';
        if (card && (card as HTMLElement).innerText) text = (card as HTMLElement).innerText.slice(0, 300);
        if (!text && href) text = href;
        if (!text && typeof document !== 'undefined') text = (document.title || '') + '|' + (card ? (card as HTMLElement).dataset?.id || '' : '');
        return 'h_' + fnv1a32(text).toString(36);
    } catch (e) {
        return 'h_' + Date.now().toString(36);
    }
}

export function getStableVacancyId(btn?: Element | null): string {
    const direct = typeof location !== 'undefined' ? getVacancyIDFromHref(location.href) : null;
    if (direct) return 'v_' + direct;
    const last = State.getLastAttemptID();
    if (last) return last;
    return getVacancyID(btn || (typeof document !== 'undefined' ? document.body : null));
}

export function pageLooksLikeTest(): boolean {
    if (typeof document === 'undefined') return false;
    if (q('textarea[name^="task_"], input[name^="task_"], select[name^="task_"], [data-qa^="task_"], [data-qa^="task-"]')) return true;
    if (typeof location !== 'undefined' && /[?&]startedWithQuestion=true/i.test(location.search)) return true;
    return false;
}

export function getResponseDetectionScope(): Element | null {
    const scopeSelector = '[data-qa="modal-content-scroll-container"], [data-qa="modal-content"], [role="dialog"], form[action*="vacancy_response"], form[id^="cover-letter-"], [data-qa*="modal" i], [class*="modal" i]';
    return qa(scopeSelector).find(el => !isAutoResponderUI(el) && isVisible(el)) || null;
}

export function hasReliableRejectWarning(): boolean {
    if (isVisible(queryExact('rejectWarning'))) return true;
    const scope = getResponseDetectionScope();
    return !!(scope && queryHeuristic('rejectWarning', scope));
}

export function hasResponseTextConfirmation(root?: ParentNode | null): boolean {
    try {
        const nodes = (root || (typeof document !== 'undefined' ? document : null))?.querySelectorAll('h1,h2,h3,p,div,span') || [];
        for (const el of Array.from(nodes)) {
            const t = el.childElementCount === 0 ? collapseSpaces(el.textContent || '') : '';
            if (t && t.length <= 240 && /(?:резюме доставлено|resume delivered|application sent|response sent)/i.test(t) && isVisible(el)) return true;
        }
    } catch (e) { /* ignore */ }
    return false;
}

export function hasExactResponseConfirmation(root?: ParentNode | null): boolean {
    const chat = queryExact('responseChat', root);
    if (chat && isVisible(chat)) return true;
    const success = q('[data-qa="vacancy-response-success"], .vacancy-response-success', root);
    return !!(success && !isAutoResponderUI(success) && isVisible(success));
}

export function isResponseConfirmed({ allowDocumentStrongText = false } = {}): boolean {
    if (typeof document === 'undefined') return false;
    if (hasExactResponseConfirmation(document)) return true;

    const scope = getResponseDetectionScope();
    if (scope) {
        const scopedChat = queryHeuristic('responseChat', scope);
        if (scopedChat && isVisible(scopedChat)) return true;
        if (hasResponseTextConfirmation(scope)) return true;
    }

    if (allowDocumentStrongText && hasResponseTextConfirmation(document)) return true;
    return false;
}

export function detectAlreadyApplied(): boolean {
    const errs = qa('[data-qa="vacancy-response-error-notification"], [data-qa*="response-error"]');
    for (const n of errs) {
        if (isVisible(n)) {
            const t = (n.textContent || '').toLowerCase();
            if (/already applied|уже отклик|отклик уже|response already/.test(t)) return true;
        }
    }
    const exactChat = queryExact('responseChat');
    if (exactChat && isVisible(exactChat)) return true;
    const scope = getResponseDetectionScope();
    const scopedChat = scope ? queryHeuristic('responseChat', scope) : null;
    return !!(scopedChat && isVisible(scopedChat));
}

export function detectModalBlockReason(): string {
    if (hasReliableRejectWarning()) return 'reject-warning';
    const c = q('[data-qa="modal-content-scroll-container"], [data-qa="modal-content"]');
    if (c && isVisible(c)) {
        const t = (c.textContent || '').toLowerCase();
        if (/visibilit|видимост/.test(t)) return 'resume-hidden';
    }
    return '';
}

export function readJsonLdTitle(): string {
    try {
        for (const s of qa('script[type="application/ld+json"]')) {
            let data: any;
            try { data = JSON.parse(s.textContent || ''); } catch (e) { continue; }
            const nodes = Array.isArray(data) ? data : [data];
            for (const node of nodes) {
                if (!node || typeof node !== 'object') continue;
                const type = node['@type'];
                const isJob = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
                if (!isJob) continue;
                const pos = collapseSpaces(node.title || node.name || '');
                const org = node.hiringOrganization;
                const comp = collapseSpaces((org && (org.name || org)) || '');
                const parts = [pos, comp].filter(Boolean);
                if (parts.length) return parts.join(' · ').slice(0, 300);
            }
        }
    } catch (e) { /* ignore */ }
    return '';
}

export function readOgTitle(): string {
    const og = q('meta[property="og:title"], meta[name="og:title"]');
    return og ? prettifyTitle(og.getAttribute('content')) : '';
}

export function cleanDocTitle(): string {
    return typeof document !== 'undefined' ? prettifyTitle(document.title) : '';
}

export function parseVacancyTitle(): string {
    try {
        const pick = (sel: string) => {
            const n = q(sel);
            return n ? collapseSpaces(n.textContent) : '';
        };
        const position = pick('[data-qa="vacancy-title"]')
            || pick('h1[data-qa="vacancy-title"]')
            || pick('h1.vacancy-title');
        if (position) {
            const employer = pick('[data-qa="vacancy-company-name"]')
                || pick('[data-qa="bloko-header-2"] a')
                || pick('.vacancy-company-name');
            let city = pick('[data-qa="vacancy-view-location"]');
            if (!city) {
                const addr = pick('[data-qa="vacancy-view-raw-address"]');
                if (addr) city = addr.split(',')[0].trim();
            }
            const parts = [position, city, employer].filter(Boolean);
            if (parts.length) return parts.join(' · ').slice(0, 300);
        }
    } catch (e) { /* ignore */ }
    return readJsonLdTitle() || readOgTitle() || cleanDocTitle();
}

export function readSerpCardTitle(linkEl: Element | null): string {
    if (!linkEl) return '';
    try {
        const titleSpan = linkEl.querySelector('[data-qa="serp-item__title-text"]');
        if (titleSpan) {
            const t = collapseSpaces(titleSpan.textContent);
            if (t) return t;
        }
        const titleEl = linkEl.querySelector('[data-qa="serp-item__title-text"], .serp-item__title');
        if (titleEl) {
            const t = collapseSpaces(titleEl.textContent);
            if (t) return t;
        }
        return prettifyTitle(linkEl.textContent);
    } catch (e) {
        return prettifyTitle(linkEl.textContent || '');
    }
}

export function resolveManualTitle(vid?: string | null): string {
    const meta = State.getLastVacancyMeta();
    if (meta && meta.title) {
        const rawVid = String(vid || '');
        const rawMetaVid = String(meta.vid || '');
        const numVid = rawVid.replace(/^v_/, '');
        const numMeta = rawMetaVid.replace(/^v_/, '');
        const isNumVid = /^\d+$/.test(numVid);
        const isNumMeta = /^\d+$/.test(numMeta);

        if (rawVid && rawMetaVid && rawVid === rawMetaVid) {
            return meta.title;
        } else if (isNumVid && isNumMeta) {
            if (numVid === numMeta) return meta.title;
        } else if (Date.now() - (Number(meta.ts) || 0) < 15 * 60 * 1000) {
            return meta.title;
        }
    }
    if (Page.isVacancy()) {
        const t = parseVacancyTitle();
        if (t) return t;
    }
    return readJsonLdTitle() || readOgTitle() || '';
}

export function saveCurrentForManual(vid?: string | null, note?: string | null, runId = currentRunId): boolean {
    if (runId && !guardOwnedCommit(runId)) return false;
    try {
        const res = State.addManualEntry({
            vid: vid || undefined,
            url: typeof location !== 'undefined' ? location.href : '',
            returnUrl: State.getReturnUrl() || '',
            ts: Date.now(),
            title: resolveManualTitle(vid)
        });
        if (res === 'ADDED') {
            Stats.bump('manual');
            log(I18n.t('logs.manualSaved', { note: note ? ' (' + note + ')' : '', vid }));
            try { (window as any)._hhApplyAssistantRenderManualQueue?.(); } catch (e) { /* ignore */ }
            return true;
        } else if (res === 'EXISTS' || res === 'UPDATED') {
            log(I18n.t('logs.manualAlready', { note: note ? ' (' + note + ')' : '', vid }));
            try { (window as any)._hhApplyAssistantRenderManualQueue?.(); } catch (e) { /* ignore */ }
            return true;
        } else {
            log(I18n.t('logs.manualSaveFailed', { note: note ? ' [' + note + ']' : '', vid }), true);
            return false;
        }
    } catch (e) {
        console.warn('[HH Apply Assistant] saveCurrentForManual error', e);
        log(I18n.t('logs.manualSaveFailed', { note: '', vid }), true);
        return false;
    }
}

export function captureResponseDom(label: string): void {
    if (typeof document === 'undefined') return;
    try {
        const wanted = /response|cover|letter|submit|relocation|resume|popup|modal|apply|vacancy-response/i;
        const dataQa: any[] = [];
        document.querySelectorAll('[data-qa]').forEach(el => {
            if (dataQa.length >= 50) return;
            const qaAttr = el.getAttribute('data-qa') || '';
            if (!wanted.test(qaAttr)) return;
            dataQa.push({
                tag: el.tagName.toLowerCase(),
                qa: qaAttr.slice(0, 90),
                vis: (el as HTMLElement).offsetParent !== null,
                txt: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)
            });
        });
        const textareas = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea')).slice(0, 10).map(t => ({
            name: t.name || '',
            qa: t.getAttribute('data-qa') || '',
            ph: (t.getAttribute('placeholder') || '').slice(0, 40),
            vis: t.offsetParent !== null
        }));
        const taskFields = Array.from(document.querySelectorAll('[name^="task_"]')).slice(0, 15).map(f => ({
            tag: f.tagName.toLowerCase(),
            type: (f.getAttribute('type') || '').slice(0, 20),
            name: (f.getAttribute('name') || '').slice(0, 60),
            vis: (f as HTMLElement).offsetParent !== null
        }));
        let modal: Element | null = null;
        try { modal = document.querySelector('[data-qa*="modal" i], [class*="modal" i]'); } catch (e) { /* ignore */ }
        const modalButtons: any[] = [];
        if (modal) {
            modal.querySelectorAll('button, [role="button"], a[data-qa]').forEach(b => {
                if (modalButtons.length >= 20) return;
                modalButtons.push({
                    qa: b.getAttribute('data-qa') || '',
                    txt: (b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
                    vis: (b as HTMLElement).offsetParent !== null
                });
            });
        }
        Metrics.snapshot(label, {
            path: typeof location !== 'undefined' ? (location.pathname + location.search).slice(0, 200) : '',
            hasModal: !!modal,
            dataQa,
            textareas,
            taskFields,
            modalButtons
        });
        log(I18n.t('logs.domSnapshot', { label, dataQa: dataQa.length, textareas: textareas.length, taskFields: taskFields.length, modalBtns: modalButtons.length }));
    } catch (e) { /* ignore */ }
}
