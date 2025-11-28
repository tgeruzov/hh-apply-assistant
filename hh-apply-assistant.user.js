// ==UserScript==
// @name         HH Apply Assistant
// @namespace    http://tampermonkey.net/
// @version      0.0.1
// @description  Авто-отклики на hh.ru без лишних зависимостей. Поддержка Magritte, редиректов и любых поддоменов. Сохранение состояния.
// @author       Timur Geruzov
// @match        *://*.hh.ru/search/vacancy*
// @match        *://*.hh.ru/vacancy/*
// @match        *://*.hh.ru/applicant/vacancy_response*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=hh.ru
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // --- CONFIG & CONSTANTS ---
    const STORAGE_PREFIX = 'hh_ar_v2_';
    const CFG = {
        key: STORAGE_PREFIX + 'settings',
        active: STORAGE_PREFIX + 'is_active',
        listUrl: STORAGE_PREFIX + 'return_url',
        history: STORAGE_PREFIX + 'processed_ids'
    };

    const UI = {
        applyBtn: '[data-qa="vacancy-serp__vacancy_response"]',
        modalAddCover: '[data-qa="add-cover-letter"]', // Кнопка "Написать сопроводительное"
        modalTextarea: 'textarea[data-qa="vacancy-response-popup-form-letter-input"]',
        modalSubmit: '[data-qa="vacancy-response-submit-popup"]',
        nativeWrapper: '[data-qa="textarea-native-wrapper"]'
    };

    const DEFAULTS = {
        coverText: 'Добрый день! Заинтересовала ваша вакансия. Опыт релевантен, подробности в резюме. Буду рад обратной связи!',
        useCover: true,
        delayMin: 1200,
        delayMax: 3000,
        limit: 50,
        skipHidden: true
    };

    // --- STATE MANAGEMENT ---
    const db = {
        load: () => {
            try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(CFG.key) || '{}') }; }
            catch { return DEFAULTS; }
        },
        save: (s) => localStorage.setItem(CFG.key, JSON.stringify(s)),
        getProcessed: () => {
            try { return new Set(JSON.parse(sessionStorage.getItem(CFG.history) || '[]')); }
            catch { return new Set(); }
        },
        addProcessed: (id) => {
            const s = db.getProcessed();
            s.add(id);
            sessionStorage.setItem(CFG.history, JSON.stringify([...s]));
        },
        isActive: () => sessionStorage.getItem(CFG.active) === '1',
        setActive: (state) => state ? sessionStorage.setItem(CFG.active, '1') : sessionStorage.removeItem(CFG.active),
        setReturnUrl: (url) => sessionStorage.setItem(CFG.listUrl, url || location.href),
        getReturnUrl: () => sessionStorage.getItem(CFG.listUrl)
    };

    let settings = db.load();
    let isRunning = false;
    let stopSignal = false;

    // --- HELPERS ---
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const log = (msg, isErr = false) => {
        const entry = document.createElement('div');
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        if (isErr) entry.style.color = '#ff4d4f';
        const con = document.getElementById('hh-ar-log');
        if (con) { con.appendChild(entry); con.scrollTop = con.scrollHeight; }
        console.log(`[HH-AR] ${msg}`);
    };

    // Обход React/Magritte инпутов. Просто el.value = x не сработает.
    function setNativeValue(el, value) {
        const proto = window.HTMLTextAreaElement.prototype;
        const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
        set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));

        // Фикс для визуального отображения в Magritte
        try {
            const wrapper = el.closest(UI.nativeWrapper) || el.parentElement;
            const clone = wrapper?.querySelector('pre');
            if (clone) clone.textContent = value || '\u200B';
        } catch (e) { /* ignore */ }
    }

    async function waitFor(selector, timeout = 4000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const el = document.querySelector(selector);
            if (el) return el;
            await sleep(200);
        }
        return null;
    }

    // --- LOGIC ---

    // Возврат назад если попали на страницу вопросов
    async function handleRedirectTrap() {
        if (!db.isActive()) return;
        
        // Проверяем, не на странице ли мы ответа с вопросами
        if (location.href.includes('/applicant/vacancy_response')) {
            log('Попали на страницу с тестом/вопросами. Пробуем вернуться.', true);
            const backUrl = db.getReturnUrl();
            
            // Сначала пробуем просто Back, это быстрее
            history.back();
            await sleep(1000);
            
            // Если всё ещё тут, форсим URL
            if (location.href.includes('/applicant/vacancy_response') && backUrl) {
                window.location.href = backUrl;
            }
        } else if (document.querySelector(UI.applyBtn)) {
            // Мы вернулись на список, нужно перезапустить процесс
            // Даем время прогрузиться
            setTimeout(() => {
                if (!document.getElementById('hh-ar-panel')) initUI();
                const startBtn = document.getElementById('hh-ar-start');
                if (startBtn) {
                    log('Восстановление работы после редиректа...');
                    startBtn.click();
                }
            }, 1500);
        }
    }

    function getVacancyId(node) {
        // Пытаемся вытащить ID из ссылки
        const href = node.href || node.getAttribute('href');
        const match = href?.match(/vacancyId=(\d+)/);
        if (match) return match[1];
        
        // Fallback: хэш от текста (если вдруг ссылка кривая)
        const text = node.closest('.vacancy-serp-item')?.innerText || href;
        let h = 0;
        for (let i = 0; i < text.length; i++) h = Math.imul(31, h) + text.charCodeAt(i) | 0;
        return 'h_' + h;
    }

    async function processVacancy(btn) {
        const vid = getVacancyId(btn);
        db.setReturnUrl(); // Запоминаем где были
        
        btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await sleep(300);
        btn.click();

        // Ждем модалку или редирект
        const modalBtn = await waitFor(UI.modalSubmit, 3000); // Кнопка "Отправить"
        
        // Если кнопки нет, возможно нас редиректнуло
        if (!modalBtn) {
            if (location.href.includes('/applicant/vacancy_response')) {
                db.addProcessed(vid); // Скипаем эту вакансию
                return 'REDIRECT';
            }
            return 'ERROR_NO_MODAL';
        }

        // Обработка сопроводительного
        if (settings.useCover) {
            const addCoverBtn = document.querySelector(UI.modalAddCover);
            if (addCoverBtn) {
                addCoverBtn.click();
                const area = await waitFor(UI.modalTextarea, 2000);
                if (area) setNativeValue(area, settings.coverText);
            } else {
                // Бывает поле уже открыто
                const area = document.querySelector(UI.modalTextarea);
                if (area) setNativeValue(area, settings.coverText);
            }
            await sleep(rnd(500, 1000));
        }

        const submit = document.querySelector(UI.modalSubmit);
        if (submit && !submit.disabled) {
            submit.click();
            db.addProcessed(vid);
            await sleep(1000); // Ждем пока модалка закроется
            return 'OK';
        }

        return 'ERROR_SUBMIT';
    }

    async function startLoop() {
        if (isRunning) return;
        isRunning = true;
        stopSignal = false;
        db.setActive(true);
        
        const status = document.getElementById('hh-ar-status');
        status.textContent = 'В работе';
        
        // Собираем кнопки
        const allBtns = Array.from(document.querySelectorAll(UI.applyBtn));
        const processed = db.getProcessed();
        
        const targets = allBtns.filter(b => {
            if (settings.skipHidden && b.offsetParent === null) return false;
            return !processed.has(getVacancyId(b));
        });

        log(`Найдено вакансий: ${allBtns.length}, Новых: ${targets.length}`);

        let count = 0;
        for (const btn of targets) {
            if (stopSignal || count >= settings.limit) break;
            
            const res = await processVacancy(btn);
            
            if (res === 'OK') {
                count++;
                log(`Отклик #${count} отправлен.`);
                await sleep(rnd(settings.delayMin, settings.delayMax));
            } else if (res === 'REDIRECT') {
                log('Сработал редирект на внешний тест. Пропуск.', true);
                // Скрипт перезагрузится после возврата, цикл прервется
                return; 
            } else {
                log(`Ошибка: ${res}`, true);
            }
        }

        isRunning = false;
        db.setActive(false);
        status.textContent = 'Готово';
        log(`Цикл завершен. Отправлено: ${count}`);
    }

    // --- GUI ---
    function initUI() {
        if (document.getElementById('hh-ar-panel')) return;

        const p = document.createElement('div');
        p.id = 'hh-ar-panel';
        p.style.cssText = `
            position: fixed; bottom: 20px; right: 20px; width: 320px;
            background: #fff; border: 1px solid #e0e0e0; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            border-radius: 8px; z-index: 99999; font-family: sans-serif; font-size: 13px; color: #333;
        `;
        
        p.innerHTML = `
            <div style="padding: 10px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; background: #f9f9f9; border-radius: 8px 8px 0 0;">
                <b>🤖 HH AutoResponder</b>
                <span id="hh-ar-status" style="font-weight: bold; color: #666;">Ожидание</span>
            </div>
            <div style="padding: 12px;">
                <label style="display:block; margin-bottom: 5px;">
                    <input type="checkbox" id="hh-ar-use-cover"> Сопроводительное письмо
                </label>
                <textarea id="hh-ar-cover" rows="4" style="width: 100%; box-sizing: border-box; border: 1px solid #ddd; padding: 5px; border-radius: 4px; resize: vertical; margin-bottom: 10px;"></textarea>
                
                <div style="display: flex; gap: 10px; margin-bottom: 10px;">
                    <div>
                        <div style="font-size: 11px; color: #888;">Задержка (мс)</div>
                        <input type="number" id="hh-ar-min" style="width: 50px; padding: 3px;" placeholder="Min"> - 
                        <input type="number" id="hh-ar-max" style="width: 50px; padding: 3px;" placeholder="Max">
                    </div>
                    <div>
                        <div style="font-size: 11px; color: #888;">Лимит</div>
                        <input type="number" id="hh-ar-limit" style="width: 50px; padding: 3px;">
                    </div>
                </div>

                <div style="display: flex; gap: 8px;">
                    <button id="hh-ar-start" style="flex: 1; padding: 8px; background: #22c55e; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">START</button>
                    <button id="hh-ar-stop" style="flex: 1; padding: 8px; background: #ef4444; color: #fff; border: none; border-radius: 4px; cursor: pointer;">STOP</button>
                    <button id="hh-ar-close" style="width: 30px; background: transparent; border: 1px solid #ddd; border-radius: 4px; cursor: pointer;">✕</button>
                </div>
            </div>
            <div id="hh-ar-log" style="height: 100px; overflow-y: auto; background: #1e1e1e; color: #00ff00; font-family: monospace; font-size: 11px; padding: 5px; border-radius: 0 0 8px 8px;"></div>
        `;

        document.body.appendChild(p);

        // Bindings
        const el = (id) => document.getElementById(id);
        
        el('hh-ar-cover').value = settings.coverText;
        el('hh-ar-use-cover').checked = settings.useCover;
        el('hh-ar-min').value = settings.delayMin;
        el('hh-ar-max').value = settings.delayMax;
        el('hh-ar-limit').value = settings.limit;

        const saveUI = () => {
            settings.coverText = el('hh-ar-cover').value;
            settings.useCover = el('hh-ar-use-cover').checked;
            settings.delayMin = +el('hh-ar-min').value;
            settings.delayMax = +el('hh-ar-max').value;
            settings.limit = +el('hh-ar-limit').value;
            db.save(settings);
        };

        ['hh-ar-cover', 'hh-ar-use-cover', 'hh-ar-min', 'hh-ar-max', 'hh-ar-limit'].forEach(id => {
            el(id).addEventListener('change', saveUI);
        });

        el('hh-ar-start').onclick = startLoop;
        el('hh-ar-stop').onclick = () => { stopSignal = true; isRunning = false; el('hh-ar-status').textContent = 'Остановлено'; };
        el('hh-ar-close').onclick = () => { p.style.display = 'none'; };
    }

    // --- BOOTSTRAP ---
    
    // Если мы на странице response — проверяем, нужно ли вернуться
    if (location.href.includes('/applicant/vacancy_response')) {
        handleRedirectTrap();
    } else {
        // Иначе инициализируем UI
        // Ждем пока прогрузится DOM (HH тяжелый сайт)
        const observer = new MutationObserver((mutations, obs) => {
            if (document.body) {
                initUI();
                handleRedirectTrap(); // Проверка на случай если мы вернулись
                obs.disconnect();
            }
        });
        observer.observe(document.documentElement, { childList: true });
    }

})();
