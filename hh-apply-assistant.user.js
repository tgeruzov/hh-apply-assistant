// ==UserScript==
// @name         HH Apply Assistant
// @namespace    http://tampermonkey.net/
// @version      0.0.2
// @description  Авто-отклики на hh.ru — надежнее работает с редиректами и динамическим DOM
// @author       Timur Geruzov (modified)
// @match        *://*.hh.ru/search/vacancy*
// @match        *://*.hh.ru/vacancy/*
// @match        *://*.hh.ru/applicant/vacancy_response*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=hh.ru
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // Настройки хранилищ и ключи для local/session storage
    const STORAGE_PREFIX = 'hh_ar_v2_';
    const KEYS = {
        settings: STORAGE_PREFIX + 'cfg_data',
        isRunning: STORAGE_PREFIX + 'is_active',
        returnUrl: STORAGE_PREFIX + 'list_url',
        history: STORAGE_PREFIX + 'processed_ids',
        needF5: STORAGE_PREFIX + 'reload_flag',
        trapLock: STORAGE_PREFIX + 'ar_trap_lock',
        instanceLock: STORAGE_PREFIX + 'instance_lock',
        lastAttempt: STORAGE_PREFIX + 'last_attempt_id',
        state: STORAGE_PREFIX + 'state'
    };

    // Важные селекторы, используемые в скрипте
    const SELECTORS = {
        applyBtn: '[data-qa="vacancy-serp__vacancy_response"], button[data-qa="vacancy-serp__vacancy_response"]',
        topApply: '[data-qa="vacancy-response-link-top"], a[data-qa="vacancy-response-link-top"]',
        modalAddCover: '[data-qa="add-cover-letter"]',
        modalTextarea: 'textarea[data-qa="vacancy-response-popup-form-letter-input"], textarea[name="coverLetter"]',
        modalSubmit: '[data-qa="vacancy-response-submit-popup"], button[data-qa="vacancy-response-submit-popup"]',
        nativeWrapper: '[data-qa="textarea-native-wrapper"]',
        relocationBtn: '[data-qa="relocation-warning-confirm"]',
        vacancyLink: 'a[data-qa="serp-item__title"], a[data-qa="vacancy-serp__vacancy-title"]',
        vacancyCard: 'div[data-qa="vacancy-serp__vacancy"], .vacancy-serp-item'
    };

    // Параметры по умолчанию
    const DEFAULTS = {
        coverText: 'Добрый день! Заинтересовала ваша вакансия. Опыт релевантен, подробности в резюме. Буду рад обратной связи!',
        useCover: true,
        delayMin: 2000,
        delayMax: 5000,
        limit: 50,
        skipHidden: true,
        viewMin: 8000,
        viewMax: 25000,
        scrollStepMs: 200,
        actionDelayMin: 150,
        actionDelayMax: 700,
        waitForModalMs: 8000,
        instanceLockTtl: 30000 // время жизни локального lock (ms) для кросс-вкладочной блокировки
    };

    // Небольшой менеджер состояния — работа с local/session storage
    const StateManager = {
        loadConfig: () => {
            try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEYS.settings) || '{}') }; }
            catch { return { ...DEFAULTS }; }
        },
        saveConfig: (s) => localStorage.setItem(KEYS.settings, JSON.stringify(s)),
        getProcessedIDs: () => {
            try { return new Set(JSON.parse(sessionStorage.getItem(KEYS.history) || '[]')); }
            catch { return new Set(); }
        },
        addProcessedID: (id) => {
            const s = StateManager.getProcessedIDs();
            s.add(id);
            sessionStorage.setItem(KEYS.history, JSON.stringify([...s]));
        },
        clearProcessedIDs: () => sessionStorage.removeItem(KEYS.history),
        amIRunning: () => sessionStorage.getItem(KEYS.isRunning) === '1',
        setRunning: (state) => state ? sessionStorage.setItem(KEYS.isRunning, '1') : sessionStorage.removeItem(KEYS.isRunning),
        setReturnUrl: (url) => sessionStorage.setItem(KEYS.returnUrl, url || location.href),
        getReturnUrl: () => sessionStorage.getItem(KEYS.returnUrl),
        setF5Needed: () => sessionStorage.setItem(KEYS.needF5, '1'),
        isF5Needed: () => sessionStorage.getItem(KEYS.needF5) === '1',
        clearF5Flag: () => sessionStorage.removeItem(KEYS.needF5),
        // "Ловушка" — пометка, что мы уже обрабатываем возврат с тестовой страницы
        setTrapLock: () => {
            sessionStorage.setItem(KEYS.trapLock, '1');
            // авто-очистка через 15 сек, если что-то пошло не так
            setTimeout(() => {
                if (sessionStorage.getItem(KEYS.trapLock) === '1') {
                    sessionStorage.removeItem(KEYS.trapLock);
                    log('Очистил ar_trap_lock по таймауту.');
                }
            }, 15000);
        },
        clearTrapLock: () => sessionStorage.removeItem(KEYS.trapLock),
        hasTrapLock: () => sessionStorage.getItem(KEYS.trapLock) === '1',
        // Запоминаем последнюю попытку отклика — пригодится при редиректах
        setLastAttemptID: (id) => {
            if (id) sessionStorage.setItem(KEYS.lastAttempt, id);
        },
        getLastAttemptID: () => sessionStorage.getItem(KEYS.lastAttempt),
        clearLastAttemptID: () => sessionStorage.removeItem(KEYS.lastAttempt),
        // Простая кросс-вкладочная блокировка (instance lock)
        acquireInstanceLock: (tabId) => {
            try {
                const now = Date.now();
                const raw = localStorage.getItem(KEYS.instanceLock);
                if (raw) {
                    const obj = JSON.parse(raw);
                    if (now - obj.ts < config.instanceLockTtl && obj.tabId !== tabId) {
                        return false;
                    }
                }
                localStorage.setItem(KEYS.instanceLock, JSON.stringify({ tabId, ts: now }));
                return true;
            } catch (e) { return true; }
        },
        releaseInstanceLock: (tabId) => {
            try {
                const raw = localStorage.getItem(KEYS.instanceLock);
                if (!raw) return;
                const obj = JSON.parse(raw);
                if (obj.tabId === tabId) localStorage.removeItem(KEYS.instanceLock);
            } catch (e) { /* ignore */ }
        },
        // Обновляем timestamp блокировки, чтобы другие вкладки видели, что мы живы
        touchInstanceLock: (tabId) => {
            try {
                const raw = localStorage.getItem(KEYS.instanceLock);
                if (!raw) return;
                const obj = JSON.parse(raw);
                if (obj.tabId === tabId) localStorage.setItem(KEYS.instanceLock, JSON.stringify({ tabId, ts: Date.now() }));
            } catch (e) { /* ignore */ }
        }
    };

    let config = StateManager.loadConfig();
    let isLoopActive = false;
    let stopSignal = false;
    const TAB_ID = Math.random().toString(36).slice(2, 9);

    // Пытаемся поставить кросс-вкладочный lock — если не получилось, предупреждаем в консоли
    const hasInstance = StateManager.acquireInstanceLock(TAB_ID);
    if (!hasInstance) {
        console.warn('[HH-AR] Похоже, в другой вкладке уже запущен процесс. Продолжаю, но возможны дубликаты.');
    }

    // Утилиты
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const actionPause = async () => await wait(randomDelay(config.actionDelayMin, config.actionDelayMax));
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    // Лог в панели + консоль
    const log = (msg, isError = false) => {
        const timestamp = new Date().toLocaleTimeString();
        const entry = document.createElement('div');
        entry.textContent = `[${timestamp}] ${msg}`;
        if (isError) entry.style.color = '#ff4d4f';
        const logBox = document.getElementById('ar-log-box');
        if (logBox) {
            logBox.appendChild(entry);
            logBox.scrollTop = logBox.scrollHeight;
        }
        console.log(`[HH-AR] ${msg}`);
    };

    // Корректная вставка текста в textarea (учитывает React/Magritte)
    function fillTextarea(el, value) {
        try {
            const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
            if (descriptor && descriptor.set) {
                 descriptor.set.call(el, value);
            } else {
                 el.value = value;
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            // Обновляем визуальный wrapper, если он есть
            const wrapper = el.closest(SELECTORS.nativeWrapper) || el.parentElement;
            const clone = wrapper?.querySelector('pre');
            if (clone) clone.textContent = value || '\u200B';
        } catch (e) { console.warn('fillTextarea error', e); }
    }

    // Ждём появления элемента — MutationObserver помогает при динамическом DOM
    async function waitForElement(selector, timeout = config.waitForModalMs) {
        const el = document.querySelector(selector);
        if (el) return el;
        return new Promise((resolve) => {
            const observer = new MutationObserver(() => {
                const found = document.querySelector(selector);
                if (found) {
                    observer.disconnect();
                    resolve(found);
                }
            });
            observer.observe(document.documentElement || document, { childList: true, subtree: true });
            setTimeout(() => {
                observer.disconnect();
                resolve(null);
            }, timeout);
        });
    }

    // Человеческий скролл: вниз к секции компании (или 60% страницы), пауза, и возврат вверх
    async function humanScrollToCompanySectionAndReturn(viewTime) {
        try {
            await actionPause();

            const stepMs = Math.max(100, config.scrollStepMs || DEFAULTS.scrollStepMs);
            const docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
            const winH = window.innerHeight || document.documentElement.clientHeight;
            const maxY = Math.max(0, docHeight - winH);

            const needle = 'подходящие вакансии в этой компании';
            let sectionEl = null;
            const candidates = Array.from(document.querySelectorAll('h1,h2,h3,h4,div,section'));
            for (const el of candidates) {
                try {
                    if (!el.innerText) continue;
                    if (el.innerText.trim().toLowerCase().includes(needle)) {
                        sectionEl = el;
                        break;
                    }
                } catch (e) { continue; }
            }

            let targetY = null;
            if (sectionEl) {
                const rect = sectionEl.getBoundingClientRect();
                targetY = Math.max(0, Math.round(rect.top + window.pageYOffset - 100));
                if (targetY > maxY) targetY = maxY;
                log('Найдена секция "Подходящие вакансии..." — скроллю до неё.');
            } else {
                targetY = Math.round(maxY * 0.6);
                log('Секция не найдена — скроллю до 60% страницы (фоллбек).');
            }

            const totalSteps = Math.max(6, Math.floor((viewTime / stepMs) / 2));
            const startY = window.pageYOffset || 0;

            for (let i = 1; i <= totalSteps; i++) {
                if (stopSignal) return;
                const frac = i / totalSteps;
                const y = Math.round(startY + (targetY - startY) * frac);
                window.scrollTo({ top: y, behavior: 'auto' });
                await wait(stepMs + randomDelay(-Math.floor(stepMs/3), Math.floor(stepMs/3)));
                await actionPause();
            }

            await wait(randomDelay(800, 1600));
            await actionPause();

            const upSteps = Math.max(4, Math.floor(totalSteps / 2));
            for (let i = upSteps; i >= 0; i--) {
                if (stopSignal) return;
                const frac = i / upSteps;
                const y = Math.round(startY + (targetY - startY) * frac);
                window.scrollTo({ top: y, behavior: 'auto' });
                await wait(stepMs + randomDelay(-Math.floor(stepMs/4), Math.floor(stepMs/4)));
                await actionPause();
            }

            window.scrollTo({ top: 0, behavior: 'auto' });
            await wait(200 + randomDelay(0, 500));
            await actionPause();
        } catch (e) {
            console.warn('humanScrollToCompanySectionAndReturn error', e);
        }
    }

    // Watchdog: если попали на страницу с вопросами — пытаемся безопасно вернуться и помечаем вакансию
    function watchTheURL() {
        setInterval(() => {
            // Обновляем timestamp instance lock
            StateManager.touchInstanceLock(TAB_ID);

            if (!StateManager.amIRunning()) return;

            // Если оказались на странице вопросов/теста
            if (location.href.includes('/applicant/vacancy_response')) {
                if (!StateManager.hasTrapLock()) {
                    StateManager.setTrapLock();
                    log('Попали на вопросы/тест. Инициирую возврат (попытка history.go(-2)).', true);

                    // Старательно пытаемся найти ID вакансии, чтобы пометить её как обработанную
                    let vid = null;
                    try {
                        if (document.referrer) {
                            vid = getVacancyIDFromHref(document.referrer);
                            if (vid) vid = 'v_' + vid;
                        }
                    } catch (e) { /* ignore */ }

                    if (!vid) {
                        const last = StateManager.getLastAttemptID();
                        if (last) vid = last;
                    }

                    if (!vid) {
                        const cur = getVacancyIDFromHref(location.href);
                        if (cur) vid = 'v_' + cur;
                    }

                    if (vid) {
                        StateManager.addProcessedID(vid);
                        log(`Пометил вакансию ${vid} как обработанную (чтобы избежать зацикливания).`);
                        StateManager.clearLastAttemptID();
                    } else {
                        log('Не удалось определить ID вакансии на странице с вопросами.', true);
                    }

                    StateManager.setF5Needed(); // после возвращения нужно обновить список
                    const backUrl = StateManager.getReturnUrl();

                    // Пытаемся откатиться двумя шагами назад: list <- vacancy <- applicant
                    try {
                        history.go(-2);
                    } catch (e) {
                        history.back();
                    }

                    // Если через 1.2 сек всё ещё на странице с тестом — форсим переход по сохранённому URL
                    setTimeout(() => {
                        if (location.href.includes('/applicant/vacancy_response')) {
                            if (backUrl) {
                                log('Двухшаговый возврат не сработал. Перехожу по сохранённому URL.', true);
                                window.location.href = backUrl;
                            } else {
                                log('Двухшаговый возврат не сработал и returnUrl недоступен. Делаю history.back().', true);
                                history.back();
                            }
                        }
                    }, 1200);
                }
            }
            // Если вернулись на список вакансий — снимаем ловушку и при необходимости обновляем страницу
            else if (document.querySelector(SELECTORS.applyBtn) || location.href.includes('/search/vacancy')) {
                 StateManager.clearTrapLock();

                 if (StateManager.isF5Needed()) {
                     log('Возврат выполнен. Перезагружаю страницу, чтобы обновить список вакансий...');
                     StateManager.clearF5Flag();
                     window.location.reload();
                 }
            }
        }, 1000);
    }

    // Попытки извлечь ID вакансии из URL в разных форматах
    function getVacancyIDFromHref(href) {
        if (!href) return null;
        const m1 = href.match(/\/vacancy\/(\d+)/);
        if (m1) return String(m1[1]);
        const m2 = href.match(/[?&]vacancyId=(\d+)/);
        if (m2) return String(m2[1]);
        const m3 = href.match(/vacancyId%3D(\d+)/);
        if (m3) return String(m3[1]);
        return null;
    }

    // Простой стабильный хеш (FNV-1a 32) — запасной вариант для уникальности
    function fnv1a32(str) {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
            h >>>= 0;
        }
        return h >>> 0;
    }

    // Получение уникального ID вакансии для отслеживания — сначала по ссылке, затем по хешу
    function getVacancyID(node) {
        try {
            const card = node.closest ? node.closest(SELECTORS.vacancyCard) : null;
            const link = (card && card.querySelector) ? card.querySelector(SELECTORS.vacancyLink) : null;
            const href = (link && link.href) || node.href || (node.getAttribute && node.getAttribute('href')) || '';
            const id = getVacancyIDFromHref(href);
            if (id) return 'v_' + id;
            let text = '';
            if (card && card.innerText) text = card.innerText.slice(0, 300);
            if (!text && href) text = href;
            if (!text) text = (document.title || '') + '|' + (card ? card.dataset?.id || '' : '');
            const h = fnv1a32(text);
            return 'h_' + h.toString(36);
        } catch (e) {
            return 'h_' + (Date.now()).toString(36);
        }
    }

    // Открываем вакансию с списка: запоминаем lastAttempt и переходим по ссылке
    async function processVacancyOnListing(vacancyLinkEl, applyBtnOnList) {
        const href = vacancyLinkEl?.href || vacancyLinkEl.getAttribute('href');
        const vid = getVacancyID(vacancyLinkEl || applyBtnOnList);

        await actionPause();
        StateManager.setReturnUrl();

        try {
            vacancyLinkEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch (e) { /* ignore */ }
        await actionPause();

        if (href) {
            log(`Открываю страницу вакансии ${vid} для чтения...`);
            await actionPause();
            StateManager.setLastAttemptID(vid); // запомним, на какую вакансию кликаем
            window.location.href = href;
            return 'NAVIGATED';
        } else {
            log('Не удалось получить href вакансии — пропускаю.', true);
            return 'ERROR_NO_HREF';
        }
    }

    // Обработка вакансии: работает и на странице вакансии, и для кнопки на листинге
    async function processVacancy(btn) {
        if (location.pathname.startsWith('/vacancy/')) {
            const vid = getVacancyID(btn || document);
            StateManager.setReturnUrl(document.referrer || '/search/vacancy');

            const viewTime = randomDelay(config.viewMin, config.viewMax);
            log(`Читаю ~${Math.round(viewTime/1000)} сек (имитирую просмотр страницы).`);
            await humanScrollToCompanySectionAndReturn(viewTime);

            await actionPause();

            let applyBtn = document.querySelector(SELECTORS.topApply) || await waitForElement(SELECTORS.applyBtn, config.waitForModalMs);
            if (!applyBtn) {
                // Если нас уже редиректнуло на страницу с вопросами — помечаем вакансию и уходим
                if (location.href.includes('/applicant/vacancy_response')) {
                    StateManager.addProcessedID(vid);
                    StateManager.clearLastAttemptID();
                    return 'REDIRECT';
                }
                // Если кнопки нет — помечаем вакансию обработанной и возвращаемся к списку
                StateManager.addProcessedID(vid);
                StateManager.clearLastAttemptID();
                StateManager.setF5Needed();
                log('Кнопка "Откликнуться" не найдена — помечаю вакансию как обработанную и возвращаюсь.', true);

                const backUrl = StateManager.getReturnUrl();
                if (backUrl && backUrl.includes('/search/vacancy')) {
                    try {
                        window.location.href = backUrl;
                    } catch (e) {
                        try { history.back(); } catch (err) { /* ignore */ }
                    }
                } else {
                    try { history.back(); } catch (e) { /* ignore */ }
                }
                return 'NO_APPLY_RETURNED';
            }

            // Пометим, что сейчас пытаемся откликнуться на эту вакансию
            StateManager.setLastAttemptID(vid);

            window.scrollTo({ top: 0, behavior: 'auto' });
            await actionPause();

            const topBtn = document.querySelector(SELECTORS.topApply);
            if (topBtn) {
                topBtn.scrollIntoView({ block: 'center', behavior: 'auto' });
                await actionPause();
                topBtn.click();
            } else {
                applyBtn.scrollIntoView({ block: 'center', behavior: 'auto' });
                await actionPause();
                applyBtn.click();
            }

            await actionPause();

            let submitButton = await waitForElement(SELECTORS.modalSubmit, config.waitForModalMs);
            if (!submitButton) {
                const relocationBtn = document.querySelector(SELECTORS.relocationBtn);
                if (relocationBtn) {
                    await actionPause();
                    relocationBtn.click();
                    await actionPause();
                    submitButton = await waitForElement(SELECTORS.modalSubmit, config.waitForModalMs);
                }
            }

            if (!submitButton) {
                if (location.href.includes('/applicant/vacancy_response')) {
                    StateManager.addProcessedID(vid);
                    StateManager.clearLastAttemptID();
                    return 'REDIRECT';
                }
                return 'ERROR_NO_MODAL';
            }

            if (config.useCover) {
                await actionPause();
                const addCoverBtn = document.querySelector(SELECTORS.modalAddCover);
                if (addCoverBtn) {
                    addCoverBtn.click();
                    await actionPause();
                    const area = await waitForElement(SELECTORS.modalTextarea, 2000);
                    if (area) {
                        fillTextarea(area, config.coverText);
                        await actionPause();
                    }
                } else {
                    const area = document.querySelector(SELECTORS.modalTextarea);
                    if (area) {
                        fillTextarea(area, config.coverText);
                        await actionPause();
                    }
                }
                await wait(randomDelay(500, 1000));
            }

            submitButton = submitButton || await waitForElement(SELECTORS.modalSubmit, 2000);
            if (submitButton && !submitButton.disabled) {
                await actionPause();
                submitButton.click();
                await actionPause();
                StateManager.addProcessedID(vid);
                StateManager.clearLastAttemptID();
                await wait(1000);
                await actionPause();
                history.back();
                return 'OK';
            }
            return 'ERROR_SUBMIT';
        }

        if (btn) {
            const vacLink = btn.closest(SELECTORS.vacancyCard)?.querySelector(SELECTORS.vacancyLink)
                            || document.querySelector(SELECTORS.vacancyLink);
            if (!vacLink) {
                log('Не найден селектор ссылки вакансии. Проверьте структуру карточки.', true);
                return 'ERROR_NO_LINK';
            }
            return await processVacancyOnListing(vacLink, btn);
        }

        return 'ERROR_UNKNOWN';
    }

    // Основной цикл обработчика
    async function startLoop() {
        if (isLoopActive) return;

        // Пробуем занять instance lock заново
        if (!StateManager.acquireInstanceLock(TAB_ID)) {
            log('В другой вкладке уже запущен процесс (instance lock). Продолжаю, но возможны дубликаты.', true);
        }

        isLoopActive = true;
        stopSignal = false;
        StateManager.setRunning(true);

        const statusEl = document.getElementById('ar-status-text');
        if(statusEl) statusEl.textContent = 'В работе';

        // Если уже на странице вакансии — обрабатываем её напрямую
        if (location.pathname.startsWith('/vacancy/')) {
            log('На странице вакансии — продолжаю обработку тут.');
            const res = await processVacancy();
            if (res === 'OK') {
                log('Отклик отправлен. Завершаю цикл для корректного возврата.');
                isLoopActive = false;
                return;
            } else if (res === 'REDIRECT') {
                log('Произошёл редирект/вопрос при обработке. Завершаю; watchdog вернёт нас назад.', true);
                isLoopActive = false;
                StateManager.setRunning(false);
                return;
            } else if (res === 'NO_APPLY_RETURNED' || res === 'ERROR_NO_MODAL' || res === 'ERROR_SUBMIT') {
                log(`Обработка завершилась с кодом ${res}. Завершаю цикл.`, true);
                isLoopActive = false;
                StateManager.setRunning(false);
                return;
            }
        }

        const allBtns = Array.from(document.querySelectorAll(SELECTORS.applyBtn));
        const processed = StateManager.getProcessedIDs();

        const targets = allBtns.filter(b => {
            if (config.skipHidden && b.offsetParent === null) return false;
            return !processed.has(getVacancyID(b));
        });

        log(`Найдено вакансий: ${allBtns.length}. Новых к обработке: ${targets.length}.`);
        let count = 0;

        for (const btn of targets) {
            if (stopSignal || count >= config.limit) break;
            if (!document.body.contains(btn)) {
                log('Кнопка исчезла из DOM — перезапускаю поиск.', true);
                break;
            }

            await actionPause();

            const result = await processVacancy(btn);

            if (result === 'OK') {
                count++;
                log(`Отклик #${count} отправлен.`);
                await actionPause();
            } else if (result === 'NAVIGATED') {
                // Перешли на страницу вакансии — завершаем цикл, оставляя флаг running для авто-старта на новой странице
                log('Переход на страницу вакансии — завершаю цикл для корректной навигации.');
                isLoopActive = false;
                return;
            } else if (result === 'REDIRECT') {
                log('Редирект/внешний тест. Выход из цикла — watchdog займётся возвратом.', true);
                isLoopActive = false;
                StateManager.setRunning(false);
                return;
            } else {
                log(`Ошибка при обработке: ${result}`, true);
            }
        }

        if (!location.href.includes('/applicant/vacancy_response')) {
             isLoopActive = false;
             StateManager.setRunning(false);
             if(statusEl) statusEl.textContent = 'Завершено';
             log(`Работа завершена. Отправлено всего: ${count}`);
        }
    }

    // UI — панель с настройками и логом
    function setupUI() {
        if (document.getElementById('ar-main-panel')) return;

        const toggleBtn = document.createElement('div');
        toggleBtn.id = 'ar-toggle-btn';
        toggleBtn.textContent = '🤖';
        toggleBtn.style.cssText = `
            position: fixed; top: 50%; right: 20px; transform: translateY(-50%);
            width: 48px; height: 48px;
            background: #222; color: #fff; border-radius: 50%; display: none;
            align-items: center; justify-content: center; font-size: 24px; cursor: pointer;
            z-index: 99999; box-shadow: 0 4px 12px rgba(0,0,0,0.3); border: 2px solid #fff;
            user-select: none; transition: all 0.2s;
        `;
        document.body.appendChild(toggleBtn);

        const panel = document.createElement('div');
        panel.id = 'ar-main-panel';
        panel.style.position = 'fixed';
        panel.style.bottom = '20px';
        panel.style.right = '20px';
        panel.style.width = '420px';
        panel.style.background = '#fff';
        panel.style.border = '1px solid #e0e0e0';
        panel.style.boxShadow = '0 4px 20px rgba(0,0,0,0.2)';
        panel.style.borderRadius = '12px';
        panel.style.zIndex = '99999';
        panel.style.fontFamily = 'sans-serif';
        panel.style.fontSize = '13px';
        panel.style.color = '#333';
        panel.style.overflow = 'hidden';
        panel.style.display = 'block';

        panel.innerHTML = `
            <div style="padding: 12px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; background: #f9f9f9;">
                <b>🤖 HH AutoResponder</b>
                <div style="display:flex; gap: 8px; align-items: center;">
                    <span id="ar-status-text" style="font-weight: bold; color: #666; font-size: 11px;">Ожидание</span>
                    <button id="ar-minimize-btn" style="background:none; border:none; cursor:pointer; font-size: 16px; color:#888;">—</button>
                </div>
            </div>
            <div style="padding: 12px;">
                <label style="display:block; margin-bottom: 8px; cursor: pointer;">
                    <input type="checkbox" id="ar-use-cover-check"> Сопроводительное письмо
                </label>
                <textarea id="ar-cover-text" rows="4" style="width: 100%; box-sizing: border-box; border: 1px solid #ddd; padding: 8px; border-radius: 6px; resize: vertical; margin-bottom: 12px; font-family: inherit;"></textarea>

                <div style="display: flex; gap: 10px; margin-bottom: 12px;">
                    <div style="flex: 1;">
                        <div style="font-size: 10px; color: #888; margin-bottom: 2px;">Задержка между действиями (мс)</div>
                        <div style="display:flex; align-items:center; gap: 4px;">
                            <input type="number" id="ar-min-delay" style="width: 100%; padding: 4px; border:1px solid #ddd; border-radius: 4px;" placeholder="Min">
                            <span style="color:#888">-</span>
                            <input type="number" id="ar-max-delay" style="width: 100%; padding: 4px; border:1px solid #ddd; border-radius: 4px;" placeholder="Max">
                        </div>
                    </div>
                    <div style="width: 60px;">
                        <div style="font-size: 10px; color:#888; margin-bottom:2px;">Лимит</div>
                        <input type="number" id="ar-limit-input" style="width: 100%; padding: 4px; border:1px solid #ddd; border-radius: 4px;">
                    </div>
                </div>

                <div style="display:flex; gap:8px; margin-bottom:8px;">
                    <div style="flex:1;">
                        <div style="font-size:10px; color:#888; margin-bottom:2px;">Время чтения вакансии (мс)</div>
                        <div style="display:flex; gap:4px;">
                            <input type="number" id="ar-view-min" style="width:100%; padding:4px; border:1px solid #ddd; border-radius:4px;" placeholder="Min">
                            <input type="number" id="ar-view-max" style="width:100%; padding:4px; border:1px solid #ddd; border-radius:4px;" placeholder="Max">
                        </div>
                    </div>
                </div>

                <div style="display:flex; gap:8px; margin-bottom:12px;">
                    <div style="flex:1;">
                        <div style="font-size:10px; color:#888; margin-bottom:2px;">Задержки действий (мс)</div>
                        <div style="display:flex; gap:4px;">
                            <input type="number" id="ar-action-min" style="width:100%; padding:4px; border:1px solid #ddd; border-radius:4px;" placeholder="Min">
                            <input type="number" id="ar-action-max" style="width:100%; padding:4px; border:1px solid #ddd; border-radius:4px;" placeholder="Max">
                        </div>
                    </div>
                </div>

                <div style="display: flex; gap: 8px; margin-bottom:8px;">
                    <button id="ar-start-btn" style="flex: 1; padding: 8px; background: #22c55e; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; transition: opacity 0.2s;">START</button>
                    <button id="ar-stop-btn" style="flex: 1; padding: 8px; background: #ef4444; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; transition: opacity 0.2s;">STOP</button>
                </div>

                <div style="display:flex; gap:8px; margin-bottom:10px;">
                    <button id="ar-health-btn" style="flex:1; padding:6px; border-radius:6px; border:1px solid #ddd; cursor:pointer;">Healthcheck</button>
                    <button id="ar-reset-history" style="flex:1; padding:6px; border-radius:6px; border:1px solid #ddd; cursor:pointer;">Reset history</button>
                </div>

            </div>
            <div id="ar-log-box" style="height: 140px; overflow-y: auto; background: #1e1e1e; color: #00ff00; font-family: monospace; font-size: 11px; padding: 8px; border-top: 1px solid #333;"></div>
        `;

        document.body.appendChild(panel);

        const el = (id) => document.getElementById(id);

        el('ar-cover-text').value = config.coverText;
        el('ar-use-cover-check').checked = config.useCover;
        el('ar-min-delay').value = config.delayMin;
        el('ar-max-delay').value = config.delayMax;
        el('ar-limit-input').value = config.limit;
        el('ar-view-min').value = config.viewMin;
        el('ar-view-max').value = config.viewMax;
        el('ar-action-min').value = config.actionDelayMin;
        el('ar-action-max').value = config.actionDelayMax;

        const saveSettings = () => {
            config.coverText = el('ar-cover-text').value;
            config.useCover = el('ar-use-cover-check').checked;
            config.delayMin = +el('ar-min-delay').value || DEFAULTS.delayMin;
            config.delayMax = +el('ar-max-delay').value || DEFAULTS.delayMax;
            config.limit = +el('ar-limit-input').value || DEFAULTS.limit;
            config.viewMin = +el('ar-view-min').value || DEFAULTS.viewMin;
            config.viewMax = +el('ar-view-max').value || DEFAULTS.viewMax;
            config.actionDelayMin = +el('ar-action-min').value || DEFAULTS.actionDelayMin;
            config.actionDelayMax = +el('ar-action-max').value || DEFAULTS.actionDelayMax;
            if (config.delayMin > config.delayMax) [config.delayMin, config.delayMax] = [config.delayMax, config.delayMin];
            if (config.viewMin > config.viewMax) [config.viewMin, config.viewMax] = [config.viewMax, config.viewMin];
            if (config.actionDelayMin > config.actionDelayMax) [config.actionDelayMin, config.actionDelayMax] = [config.actionDelayMax, config.actionDelayMin];
            StateManager.saveConfig(config);
            log('Настройки сохранены.');
        };

        ['ar-cover-text', 'ar-use-cover-check', 'ar-min-delay', 'ar-max-delay', 'ar-limit-input', 'ar-view-min', 'ar-view-max', 'ar-action-min', 'ar-action-max'].forEach(id => el(id).addEventListener('change', saveSettings));

        el('ar-start-btn').onclick = startLoop;
        el('ar-stop-btn').onclick = () => {
            stopSignal = true;
            isLoopActive = false;
            StateManager.setRunning(false);
            el('ar-status-text').textContent = 'Остановлено';
            StateManager.releaseInstanceLock(TAB_ID);
            log('Остановлено пользователем.');
        };

        el('ar-reset-history').onclick = () => {
            StateManager.clearProcessedIDs();
            log('История откликов сброшена.');
        };

        el('ar-health-btn').onclick = () => {
            runHealthCheck();
        };

        const toggleVisibility = (isOpen) => {
            panel.style.display = isOpen ? 'block' : 'none';
            toggleBtn.style.display = isOpen ? 'none' : 'flex';
        };
        el('ar-minimize-btn').onclick = () => toggleVisibility(false);
        toggleBtn.onclick = () => toggleVisibility(true);
    }

    // Пробегает по ключевым селекторам и пишет результат в лог
    function runHealthCheck() {
        const checks = [
            { name: 'Кнопка отклика (list)', sel: SELECTORS.applyBtn },
            { name: 'Верхняя кнопка отклика (vacancy page)', sel: SELECTORS.topApply },
            { name: 'Ссылка вакансии (card)', sel: SELECTORS.vacancyLink },
            { name: 'modal submit', sel: SELECTORS.modalSubmit },
            { name: 'modal textarea', sel: SELECTORS.modalTextarea }
        ];
        log('Запускаю HealthCheck...');
        checks.forEach(c => {
            const found = document.querySelector(c.sel);
            log(`${c.name}: ${found ? 'OK' : 'НЕ НАЙДЕНО'} (${c.sel})`, !found);
        });
        const raw = localStorage.getItem(KEYS.instanceLock);
        if (raw) {
            try {
                const obj = JSON.parse(raw);
                log(`Instance lock: tabId=${obj.tabId} ts=${new Date(obj.ts).toLocaleTimeString()}`);
            } catch (e) { log('Instance lock: ошибка чтения', true); }
        } else {
            log('Instance lock: отсутствует');
        }
    }

    // Инициализация
    watchTheURL();

    const domReadyObserver = new MutationObserver((mutations, obs) => {
        if (document.body) {
            setupUI();
            // Авто-возобновление, если скрипт был в работе перед перезагрузкой
            if (StateManager.amIRunning()) {
                log('Обнаружена незавершенная работа. Авто-возобновление через 1.5 сек...');
                const statusEl = document.getElementById('ar-status-text');
                if(statusEl) statusEl.textContent = 'Авто-запуск...';
                setTimeout(() => {
                    const startButton = document.getElementById('ar-start-btn');
                    if (startButton) startButton.click();
                }, 1500);
            }
            // Сбрасываем ловушку при открытии новых страниц
            StateManager.clearTrapLock();
            obs.disconnect();
        }
    });
    domReadyObserver.observe(document.documentElement, { childList: true, subtree: true });

    // Очищаем instance lock при закрытии вкладки
    window.addEventListener('beforeunload', () => {
        StateManager.releaseInstanceLock(TAB_ID);
    });
    window.addEventListener('unload', () => {
        StateManager.releaseInstanceLock(TAB_ID);
    });
})();
