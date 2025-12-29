// ==UserScript==
// @name         HH Apply Assistant
// @namespace    http://tampermonkey.net/
// @version      0.0.1
// @description  Авто-отклики на hh.ru.
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

    // --- НАСТРОЙКИ ХРАНИЛИЩА (SessionStorage/LocalStorage) ---
    const STORAGE_PREFIX = 'hh_ar_v2_';
    const KEYS = {
        // Локальные настройки (сохраняются)
        settings: STORAGE_PREFIX + 'cfg_data',
        // Состояние работы (для авто-возобновления после F5)
        isRunning: STORAGE_PREFIX + 'is_active',
        // URL списка вакансий (для возврата)
        returnUrl: STORAGE_PREFIX + 'list_url',
        // Список обработанных ID (чтобы не откликаться дважды)
        history: STORAGE_PREFIX + 'processed_ids',
        // Флаг: нужна ли принудительная перезагрузка страницы (F5)
        needF5: STORAGE_PREFIX + 'reload_flag'
    };

    const SELECTORS = {
        applyBtn: '[data-qa="vacancy-serp__vacancy_response"]',
        modalAddCover: '[data-qa="add-cover-letter"]',
        modalTextarea: 'textarea[data-qa="vacancy-response-popup-form-letter-input"]',
        modalSubmit: '[data-qa="vacancy-response-submit-popup"]',
        nativeWrapper: '[data-qa="textarea-native-wrapper"]',
        relocationBtn: '[data-qa="relocation-warning-confirm"]' // Кнопка "Готов к переезду"
    };

    const DEFAULTS = {
        coverText: 'Добрый день! Заинтересовала ваша вакансия. Опыт релевантен, подробности в резюме. Буду рад обратной связи!',
        useCover: true,
        delayMin: 1200,
        delayMax: 3000,
        limit: 50,
        skipHidden: true
    };

    // --- УПРАВЛЕНИЕ СОСТОЯНИЕМ (DB-обертка) ---
    const StateManager = {
        loadConfig: () => {
            try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEYS.settings) || '{}') }; }
            catch { return DEFAULTS; }
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
        // Флаг: мы сейчас в работе?
        amIRunning: () => sessionStorage.getItem(KEYS.isRunning) === '1',
        setRunning: (state) => state ? sessionStorage.setItem(KEYS.isRunning, '1') : sessionStorage.removeItem(KEYS.isRunning),
        // URL списка
        setReturnUrl: (url) => sessionStorage.setItem(KEYS.returnUrl, url || location.href),
        getReturnUrl: () => sessionStorage.getItem(KEYS.returnUrl),
        // Флаг: нужен ли F5
        setF5Needed: () => sessionStorage.setItem(KEYS.needF5, '1'),
        isF5Needed: () => sessionStorage.getItem(KEYS.needF5) === '1',
        clearF5Flag: () => sessionStorage.removeItem(KEYS.needF5)
    };

    let config = StateManager.loadConfig();
    let isLoopActive = false;
    let stopSignal = false;

    // --- ХЕЛПЕРЫ И УТИЛИТЫ ---
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

    // Пишем в наш кастомный лог
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

    // Обход хитрой реализации полей ввода в HH (React/Magritte)
    function fillTextarea(el, value) {
        const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        if (descriptor && descriptor.set) {
             descriptor.set.call(el, value);
        } else {
             el.value = value;
        }

        // Триггерим событие, чтобы React подхватил изменения
        el.dispatchEvent(new Event('input', { bubbles: true }));

        // Хак для визуального обновления (если нужно)
        try {
            const wrapper = el.closest(SELECTORS.nativeWrapper) || el.parentElement;
            const clone = wrapper?.querySelector('pre');
            if (clone) clone.textContent = value || '\u200B';
        } catch (e) { /* Игнорируем ошибки тут */ }
    }

    // Ждем элемент (с таймаутом, чтобы не зависнуть)
    async function waitForElement(selector, timeout = 4000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const el = document.querySelector(selector);
            if (el) return el;
            await wait(200);
        }
        return null;
    }

    // --- СТОРОЖЕВОЙ ПЕС (WATCHDOG) ---
    // Следит за тем, чтобы нас не выкинуло на страницу вопросов и возвращает нас.
    function watchTheURL() {
        setInterval(() => {
            if (!StateManager.amIRunning()) return;

            // 1. Сценарий: Мы в ловушке (страница вопросов)
            if (location.href.includes('/applicant/vacancy_response')) {
                // Если мы уже обрабатываем возврат, не спамим лог
                if (!sessionStorage.getItem('ar_trap_lock')) {
                    sessionStorage.setItem('ar_trap_lock', '1');
                    log('Попали на вопросы/тест. Инициирую возврат.', true);

                    StateManager.setF5Needed(); // Ставим флаг: по возврату нужна полная перезагрузка
                    const backUrl = StateManager.getReturnUrl();

                    history.back(); // План А: "Мягкий" возврат

                    // План Б: Если через секунду "мягкий" возврат не сработал, форсим URL
                    setTimeout(() => {
                        if (location.href.includes('/applicant/vacancy_response') && backUrl) {
                            log('History API глючит. Жесткий переход по сохраненному URL.');
                            window.location.href = backUrl;
                        }
                    }, 1000);
                }
            }
            // 2. Сценарий: Мы вернулись на список вакансий
            else if (document.querySelector(SELECTORS.applyBtn) || location.href.includes('/search/vacancy')) {
                 sessionStorage.removeItem('ar_trap_lock'); // Снимаем блокировку

                 // Если стоит флаг, который мы поставили в ловушке
                 if (StateManager.isF5Needed()) {
                     log('Возврат выполнен. Выполняю принудительную перезагрузку (F5) для прогрузки новых элементов...');
                     StateManager.clearF5Flag();
                     window.location.reload();
                 }
            }
        }, 1000); // Проверяем состояние каждую секунду
    }

    // Генерируем ID для отслеживания
    function getVacancyID(node) {
        const href = node.href || node.getAttribute('href');
        const match = href?.match(/vacancyId=(\d+)/);
        if (match) return match[1];

        // Хеш как запасной вариант (для вакансий без явного ID в ссылке)
        const text = node.closest('.vacancy-serp-item')?.innerText || href || '';
        let hash = 0;
        for (let i = 0; i < text.length; i++) hash = Math.imul(31, hash) + text.charCodeAt(i) | 0;
        return 'h_' + hash;
    }

    // --- ОСНОВНОЙ РАБОЧИЙ ПРОЦЕСС ---
    async function processVacancy(btn) {
        const vid = getVacancyID(btn);

        // ВАЖНО: Запоминаем текущий URL на случай, если нас прервут
        StateManager.setReturnUrl();

        btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await wait(300);
        btn.click();

        let submitButton = await waitForElement(SELECTORS.modalSubmit, 2500);

        // Сначала обрабатываем окно релокации (если оно есть)
        if (!submitButton) {
            const relocationBtn = document.querySelector(SELECTORS.relocationBtn);
            if (relocationBtn) {
                log('Найдено окно релокации. Подтверждаю...');
                relocationBtn.click();
                await wait(500);
                // Ищем кнопку отправки снова после закрытия релокации
                submitButton = await waitForElement(SELECTORS.modalSubmit, 2500);
            }
        }

        // Если кнопки отправки нет, проверяем, куда нас выкинуло
        if (!submitButton) {
            if (location.href.includes('/applicant/vacancy_response')) {
                StateManager.addProcessedID(vid);
                return 'REDIRECT'; // Нас редиректнуло на внешний тест
            }
            return 'ERROR_NO_MODAL'; // Что-то пошло не так, модалка не открылась
        }

        // Заполнение сопроводительного (если включено)
        if (config.useCover) {
            const addCoverBtn = document.querySelector(SELECTORS.modalAddCover);
            if (addCoverBtn) {
                addCoverBtn.click();
                const area = await waitForElement(SELECTORS.modalTextarea, 2000);
                if (area) fillTextarea(area, config.coverText);
            } else {
                const area = document.querySelector(SELECTORS.modalTextarea);
                if (area) fillTextarea(area, config.coverText);
            }
            await wait(randomDelay(500, 1000));
        }
        
        // Всегда пробуем получить кнопку отправки, даже если сопроводительное отключено
        if (!submitButton) {
            submitButton = await waitForElement(SELECTORS.modalSubmit, 2500);
        }
        
        // Отправка
        if (submitButton && !submitButton.disabled) {
            submitButton.click();
            StateManager.addProcessedID(vid);
            await wait(1000);
            return 'OK';
        }


        return 'ERROR_SUBMIT';
    }

    async function startLoop() {
        if (isLoopActive) return;

        isLoopActive = true;
        stopSignal = false;
        StateManager.setRunning(true);

        const statusEl = document.getElementById('ar-status-text');
        if(statusEl) statusEl.textContent = 'В работе';

        // Собираем все кнопки и фильтруем по ID
        const allBtns = Array.from(document.querySelectorAll(SELECTORS.applyBtn));
        const processed = StateManager.getProcessedIDs();

        const targets = allBtns.filter(b => {
            // Пропускаем скрытые (часто они не подходят по фильтрам HH)
            if (config.skipHidden && b.offsetParent === null) return false;
            return !processed.has(getVacancyID(b));
        });

        log(`Найдено вакансий: ${allBtns.length}. Новых к обработке: ${targets.length}.`);
        let count = 0;

        for (const btn of targets) {
            if (stopSignal || count >= config.limit) break;

            // Проверка, не убрала ли HH кнопку динамически
            if (!document.body.contains(btn)) {
                log('Элемент кнопки потерян. Перезапуск поиска...', true);
                break;
            }

            const result = await processVacancy(btn);

            if (result === 'OK') {
                count++;
                log(`Отклик #${count} отправлен.`);
                await wait(randomDelay(config.delayMin, config.delayMax));
            } else if (result === 'REDIRECT') {
                log('Внешний тест. Выход из цикла. Watchdog сам перезагрузит страницу.', true);
                return; // Выходим, чтобы Watchdog успел сделать свою работу
            } else {
                log(`Ошибка при обработке: ${result}`, true);
            }
        }

        // Нормальное завершение цикла (не прервано редиректом)
        if (!location.href.includes('/applicant/vacancy_response')) {
             isLoopActive = false;
             StateManager.setRunning(false); // Снимаем флаг активности
             if(statusEl) statusEl.textContent = 'Завершено';
             log(`Работа завершена. Отправлено всего: ${count}`);
        }
    }

    // --- GUI И НАСТРОЙКИ ---
    function setupUI() {
        if (document.getElementById('ar-main-panel')) return;

        // Кнопка для сворачивания/разворачивания
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

        // Основная панель
        const panel = document.createElement('div');
        panel.id = 'ar-main-panel';
        panel.style.position = 'fixed';
        panel.style.bottom = '20px';
        panel.style.right = '20px';
        panel.style.width = '320px';
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
                        <div style="font-size: 10px; color: #888; margin-bottom: 2px;">Задержка (мс)</div>
                        <div style="display:flex; align-items:center; gap: 4px;">
                            <input type="number" id="ar-min-delay" style="width: 100%; padding: 4px; border:1px solid #ddd; border-radius: 4px;" placeholder="Min">
                            <span style="color:#888">-</span>
                            <input type="number" id="ar-max-delay" style="width: 100%; padding: 4px; border:1px solid #ddd; border-radius: 4px;" placeholder="Max">
                        </div>
                    </div>
                    <div style="width: 60px;">
                        <div style="font-size: 10px; color: #888; margin-bottom: 2px;">Лимит</div>
                        <input type="number" id="ar-limit-input" style="width: 100%; padding: 4px; border:1px solid #ddd; border-radius: 4px;">
                    </div>
                </div>

                <div style="display: flex; gap: 8px;">
                    <button id="ar-start-btn" style="flex: 1; padding: 8px; background: #22c55e; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; transition: opacity 0.2s;">START</button>
                    <button id="ar-stop-btn" style="flex: 1; padding: 8px; background: #ef4444; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; transition: opacity 0.2s;">STOP</button>
                </div>
            </div>
            <div id="ar-log-box" style="height: 100px; overflow-y: auto; background: #1e1e1e; color: #00ff00; font-family: monospace; font-size: 11px; padding: 8px; border-top: 1px solid #333;"></div>
        `;

        document.body.appendChild(panel);

        // Привязка элементов к данным и событиям
        const el = (id) => document.getElementById(id);

        el('ar-cover-text').value = config.coverText;
        el('ar-use-cover-check').checked = config.useCover;
        el('ar-min-delay').value = config.delayMin;
        el('ar-max-delay').value = config.delayMax;
        el('ar-limit-input').value = config.limit;

        const saveSettings = () => {
            config.coverText = el('ar-cover-text').value;
            config.useCover = el('ar-use-cover-check').checked;
            config.delayMin = +el('ar-min-delay').value;
            config.delayMax = +el('ar-max-delay').value;
            config.limit = +el('ar-limit-input').value;
            StateManager.saveConfig(config);
        };

        ['ar-cover-text', 'ar-use-cover-check', 'ar-min-delay', 'ar-max-delay', 'ar-limit-input'].forEach(id => el(id).addEventListener('change', saveSettings));

        el('ar-start-btn').onclick = startLoop;

        el('ar-stop-btn').onclick = () => {
            stopSignal = true;
            isLoopActive = false;
            StateManager.setRunning(false);
            el('ar-status-text').textContent = 'Остановлено';
        };

        const toggleVisibility = (isOpen) => {
            panel.style.display = isOpen ? 'block' : 'none';
            toggleBtn.style.display = isOpen ? 'none' : 'flex';
        };
        el('ar-minimize-btn').onclick = () => toggleVisibility(false);
        toggleBtn.onclick = () => toggleVisibility(true);
    }

    // --- ЗАПУСК СКРИПТА ---

    // Запускаем постоянный мониторинг URL
    watchTheURL();

    // Ждем прогрузки DOM, чтобы нарисовать UI и начать работу
    const domReadyObserver = new MutationObserver((mutations, obs) => {
        if (document.body) {
            setupUI();

            // Если скрипт был активен до перезагрузки (Watchdog его перезапустил)
            if (StateManager.amIRunning()) {
                log('Обнаружена незавершенная работа. Автоматическое возобновление через 1.5 сек...');
                const statusEl = document.getElementById('ar-status-text');
                if(statusEl) statusEl.textContent = 'Авто-запуск...';

                // Даем сайту HH время прогрузиться после F5
                setTimeout(() => {
                    const startButton = document.getElementById('ar-start-btn');
                    if (startButton) startButton.click();
                }, 1500);
            }

            obs.disconnect();
        }
    });
    // Начинаем следить за изменениями в DOM
    domReadyObserver.observe(document.documentElement, { childList: true });

})();
