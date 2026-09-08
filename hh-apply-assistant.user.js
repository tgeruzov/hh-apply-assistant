// ==UserScript==
// @name         HH Apply Assistant
// @namespace    http://tampermonkey.net/
// @version      0.0.7
// @author       Timur Geruzov
// @description  HH Apply Assistant - Автоматизация откликов на вакансии hh.ru с эргономичным плавающим HUD интерфейсом
// @license      GPL-3.0-only
// @homepageURL  https://github.com/tgeruzov/hh-apply-assistant
// @supportURL   https://github.com/tgeruzov/hh-apply-assistant/issues
// @match        *://*.hh.ru/search/vacancy*
// @match        *://*.hh.ru/vacancy/*
// @match        *://*.hh.ru/applicant/vacancy_response*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/**
 * ============================================================================
 * Part 1: Automation Engine (Headless Core)
 * ============================================================================
 */

(function (root, factory) {
  const api = factory();
  if (typeof root !== 'undefined') root.HHApplyAssistant = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // --- 1. Constants, Selectors & Defaults ---
  const VERSION = '2.0.0';
  const SELECTORS = {
    applyBtn: '[data-qa="vacancy-serp__vacancy_response"], button[data-qa="vacancy-serp__vacancy_response"]',
    vacancyApply: '[data-qa="vacancy-response-link-bottom"], [data-qa="vacancy-response-link-top"], a[data-qa*="vacancy-response-link"]',
    attachCoverBtn: '[data-qa="responded-success-attach-cover-letter"], button[data-qa="responded-success-attach-cover-letter"]',
    attachCoverInModal: '[data-qa="responded-success-attach-cover-letter"], [data-qa="add-cover-letter"], button[data-qa="add-cover-letter"], [data-qa="vacancy-response-letter-toggle"]',
    letterTextarea: 'textarea[data-qa="vacancy-response-popup-form-letter-input"], textarea[name="text"], textarea[name="coverLetter"]',
    letterSubmit: 'button[data-qa="vacancy-response-letter-submit"], [data-qa="vacancy-response-letter-submit"], button[data-qa="vacancy-response-submit-popup"], [data-qa="vacancy-response-submit-popup"], [data-qa="vacancy-response-submit"], button[data-qa*="response-submit" i], [data-qa*="response-submit" i]',
    responseChat: '[data-qa="vacancy-response-link-view-topic"]',
    nativeWrapper: '[data-qa="textarea-native-wrapper"]',
    relocationBtn: '[data-qa="relocation-warning-confirm"]',
    rejectWarning: '[data-qa="response-reject-warning"]',
    vacancyLink: 'a[data-qa="serp-item__title"], a[data-qa="vacancy-serp__vacancy-title"]',
    vacancyCard: 'div[data-qa="vacancy-serp__vacancy"], .vacancy-serp-item',
    pagerNext: '[data-qa="pager-next"], a[data-qa="pager-next"]'
  };

  const SELECTOR_METADATA = {
    applyBtn: {
      name: 'Кнопка «Откликнуться» в поисковой выдаче',
      heuristic: 'button, [role="button"] /откликнуться|apply|respond/i'
    },
    vacancyApply: {
      name: 'Кнопка «Откликнуться» на странице вакансии',
      heuristic: 'button, a, [role="button"] /откликнуться|отклик без резюме|перейти к отклику/i'
    },
    attachCoverBtn: {
      name: 'Кнопка «Прикрепить сопроводительное» после отклика',
      heuristic: 'button, a /сопроводительное|письмо|cover/i'
    },
    attachCoverInModal: {
      name: 'Переключатель письма в модальном окне',
      heuristic: 'button, [role="button"] /добавить сопроводительное|написать письмо/i'
    },
    letterTextarea: {
      name: 'Поле ввода текста письма',
      heuristic: 'textarea[name="text"] или первый видимый <textarea>'
    },
    letterSubmit: {
      name: 'Кнопка отправки формы отклика',
      heuristic: 'button, input[type="submit"] /отправить|сохранить|откликнуться|send|submit/i'
    },
    relocationBtn: {
      name: 'Подтверждение предупреждения о релокации',
      heuristic: 'button[data-qa="relocation-warning-confirm"] или кнопка «Все равно откликнуться» в алерте'
    },
    vacancyCard: {
      name: 'Карточка вакансии в выдаче',
      heuristic: 'div, article с одиночной ссылкой на /vacancy/'
    },
    pagerNext: {
      name: 'Кнопка «Дальше» (пагинация поиска)',
      heuristic: 'a[data-qa="pager-next"], a /дальше|вперёд|следующая/i'
    }
  };

  const STORAGE_PREFIX = 'hh_apply_assistant_s1_';
  const KEYS = {
    settings: STORAGE_PREFIX + 'settings',
    isRunning: STORAGE_PREFIX + 'is_active',
    returnUrl: STORAGE_PREFIX + 'return_url',
    history: STORAGE_PREFIX + 'processed_ids',
    trapLock: STORAGE_PREFIX + 'trap_lock',
    instanceLock: STORAGE_PREFIX + 'instance_lock',
    lastAttempt: STORAGE_PREFIX + 'last_attempt_id',
    manualList: STORAGE_PREFIX + 'manual_queue',
    tabId: STORAGE_PREFIX + 'tab_id',
    sentCount: STORAGE_PREFIX + 'sent_count',
    stats: STORAGE_PREFIX + 'run_stats',
    logHistory: STORAGE_PREFIX + 'log_history'
  };

  const PRESETS = {
    safe: { delay: [4000, 8000], action: [300, 1000] },
    balanced: { delay: [2000, 5000], action: [200, 600] },
    fast: { delay: [1500, 3000], action: [150, 400] }
  };

  const DEFAULT_COVER_TEXT = 'Здравствуйте! Меня заинтересовала ваша вакансия. Ознакомьтесь, пожалуйста, с моим резюме.';
  const DEFAULTS = {
    coverText: DEFAULT_COVER_TEXT,
    useCover: true,
    openVacancy: true,
    skipHidden: true,
    preset: 'balanced',
    limit: 50
  };

  // --- 2. Event Bus ---
  class EventEmitter {
    constructor() { this._e = Object.create(null); }
    on(event, fn) {
      if (typeof fn !== 'function') return () => {};
      (this._e[event] = this._e[event] || []).push(fn);
      return () => this.off(event, fn);
    }
    off(event, fn) {
      if (!this._e[event]) return;
      if (!fn) { delete this._e[event]; return; }
      this._e[event] = this._e[event].filter(h => h !== fn && h.fn !== fn);
      if (!this._e[event].length) delete this._e[event];
    }
    once(event, fn) {
      if (typeof fn !== 'function') return () => {};
      const wrapper = (...args) => { this.off(event, wrapper); fn(...args); };
      wrapper.fn = fn;
      return this.on(event, wrapper);
    }
    emit(event, ...args) {
      const handlers = this._e[event];
      if (handlers) {
        for (const h of handlers.slice()) {
          try { h(...args); } catch (err) { console.error(`[HH] Listener error for "${event}":`, err); }
        }
      }
      const win = globalThis.window;
      if (win && typeof win.dispatchEvent === 'function') {
        try {
          win.dispatchEvent(new CustomEvent('hha:' + event, { detail: args.length === 1 ? args[0] : (args.length > 1 ? args : null) }));
        } catch (_) {}
      }
    }
    removeAllListeners(event) {
      if (event) delete this._e[event]; else this._e = Object.create(null);
    }
  }
  const events = new EventEmitter();

  // --- 3. Storage Layer with Fallbacks (No Duplicate Memory Writes) ---
  const memLocal = new Map();
  const memSession = new Map();

  function getNativeStore(type) {
    try {
      return globalThis[type === 'local' ? 'localStorage' : 'sessionStorage'] || null;
    } catch (_) {
      return null;
    }
  }

  function storeGet(type, key) {
    const s = getNativeStore(type);
    if (s) {
      try {
        const v = s.getItem(key);
        if (v !== null) return v;
      } catch (_) {}
    }
    return (type === 'local' ? memLocal : memSession).get(key) ?? null;
  }

  function storeSet(type, key, val) {
    const str = String(val);
    const s = getNativeStore(type);
    if (s) {
      try {
        s.setItem(key, str);
        return true;
      } catch (_) {}
    }
    (type === 'local' ? memLocal : memSession).set(key, str);
    return !s;
  }

  function storeRemove(type, key) {
    const s = getNativeStore(type);
    if (s) {
      try { s.removeItem(key); } catch (_) {}
    }
    (type === 'local' ? memLocal : memSession).delete(key);
    return true;
  }

  function isLocalBlocked() {
    try {
      const s = getNativeStore('local');
      if (s) s.getItem('__test__');
      return false;
    } catch (_) {
      return true;
    }
  }

  const storage = {
    localGet: (k) => storeGet('local', k),
    localSet: (k, v) => storeSet('local', k, v),
    localRemove: (k) => storeRemove('local', k),
    sessionGet: (k) => storeGet('session', k),
    sessionSet: (k, v) => storeSet('session', k, v),
    sessionRemove: (k) => storeRemove('session', k),
    isLocalBlocked
  };

  // --- 4. Utilities ---
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const toNum = (v, fallback) => { const n = Number(v); return Number.isNaN(n) ? fallback : n; };
  const collapseSpaces = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const randBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const parseJson = (raw, fallback) => {
    if (!raw || typeof raw !== 'string') return fallback;
    try { return JSON.parse(raw); } catch (_) { return fallback; }
  };

  function toSafeHhUrl(rawUrl) {
    if (!rawUrl) return '';
    try {
      const base = globalThis.location?.href || 'https://hh.ru';
      const u = new URL(String(rawUrl), base);
      return (['http:', 'https:'].includes(u.protocol) && /(^|\.)(hh\.ru|localhost|127\.0\.0\.1)$/i.test(u.hostname)) ? u.href : '';
    } catch (_) {
      return '';
    }
  }

  // --- 5. Logging & Telemetry ---
  const earlyLogsBuffer = [];

  function log(msg, isError = false, code = '', context = null) {
    const level = isError ? 'ERR' : 'INFO';
    const entryCode = code || (isError ? 'ERROR' : 'INFO');
    const timestamp = Date.now();

    try {
      const timeStr = new Date(timestamp).toTimeString().slice(0, 8);
      const isWarn = /WARN|SKIP|DELAY|SCROLL_SKIP/i.test(entryCode);
      const isSuccess = /SUCCESS|CONFIRM|DONE|DELIVERED/i.test(entryCode);
      const color = isError ? '#ef4444' : (isSuccess ? '#10b981' : (isWarn ? '#f59e0b' : '#3b82f6'));
      const badgeStyle = `background: ${color}; color: #ffffff; font-weight: 700; border-radius: 3px; padding: 1px 5px; font-size: 11px;`;
      const textStyle = isError ? 'color: #ef4444; font-weight: 600;' : 'color: inherit;';
      const ctxOutput = context ? (typeof context === 'object' ? context : { detail: context }) : '';

      if (isError) {
        console.error(`%c[HHA ${timeStr}]%c [${entryCode}] ${msg}`, badgeStyle, textStyle, ctxOutput);
      } else if (isWarn) {
        console.warn(`%c[HHA ${timeStr}]%c [${entryCode}] ${msg}`, badgeStyle, textStyle, ctxOutput);
      } else {
        console.log(`%c[HHA ${timeStr}]%c [${entryCode}] ${msg}`, badgeStyle, textStyle, ctxOutput);
      }
    } catch (_) {}

    const payload = {
      level,
      message: String(msg || ''),
      code: entryCode,
      timestamp,
      context: context || {}
    };

    earlyLogsBuffer.push(payload);
    if (earlyLogsBuffer.length > 50) earlyLogsBuffer.shift();

    events.emit('log', payload);

    if (isError) {
      events.emit('error', {
        code: entryCode,
        message: String(msg || ''),
        fatal: false,
        details: context
      });
    }
  }

  function flushTelemetryBeforeNav() {
    try {
      const hudEl = globalThis.document?.querySelector('hha-hud');
      if (hudEl && typeof hudEl._flushLogs === 'function') {
        hudEl._flushLogs();
      }
    } catch (_) {}
  }

  // --- 6. Configuration ---
  function normalizeConfig(raw) {
    const m = { ...DEFAULTS, ...(raw || {}) };
    return {
      coverText: String(m.coverText ?? DEFAULT_COVER_TEXT).slice(0, 5000),
      useCover: m.useCover !== false,
      openVacancy: m.openVacancy !== false,
      skipHidden: m.skipHidden !== false,
      preset: PRESETS[m.preset] ? m.preset : 'balanced',
      limit: clamp(Math.round(toNum(m.limit, DEFAULTS.limit)), 1, 500)
    };
  }

  let config = normalizeConfig(parseJson(storage.localGet(KEYS.settings), null));

  function persistSettings(nextPartial) {
    const prev = { ...config };
    const nextConfig = normalizeConfig({ ...config, ...(nextPartial || {}) });
    const success = storage.localSet(KEYS.settings, JSON.stringify(nextConfig));
    config = nextConfig;
    events.emit('config', { current: config, previous: prev });
    return success;
  }

  function ensureCurrentRunLimit() {
    const sent = getSentCount();
    if (sent > config.limit) persistSettings({ limit: Math.min(500, sent) });
  }

  const timings = () => PRESETS[config.preset] || PRESETS.balanced;
  const actionPause = () => wait(randBetween(timings().action[0], timings().action[1]));
  const vacancyPause = () => wait(Math.max(1500, randBetween(timings().delay[0], timings().delay[1])));

  const wait = (ms) => new Promise((resolve) => {
    const sig = activeAbortController?.signal;
    if (stopSignal || sig?.aborted || ms <= 0) return resolve();
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (sig) sig.removeEventListener('abort', onAbort);
    };
    const onAbort = () => { cleanup(); resolve(); };
    if (sig) sig.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => { cleanup(); resolve(); }, ms);
  });

  // --- 7. Statistics & History ---
  function getStats() {
    const v = parseJson(storage.sessionGet(KEYS.stats), null);
    return {
      attempts: Number(v?.attempts) || 0,
      success: Number(v?.success) || 0,
      manual: Number(v?.manual) || 0,
      skipped: Number(v?.skipped) || 0,
      startedAt: Number(v?.startedAt) || Date.now()
    };
  }

  function saveStats(d) {
    const ok = storage.sessionSet(KEYS.stats, JSON.stringify(d));
    events.emit('stats', d);
    return ok;
  }

  function bumpStat(field, by = 1) {
    const s = getStats();
    if (field in s) s[field] = (s[field] || 0) + by;
    s.attempts = (s.attempts || 0) + by;
    saveStats(s);
  }

  function resetStats() {
    return saveStats({ attempts: 0, success: 0, manual: 0, skipped: 0, startedAt: Date.now() });
  }

  // --- 8. Manual Queue Domain ---
  function normalizeManualEntry(entry) {
    if (!entry) return null;
    const vid = String(entry.vid || entry.id || '').trim();
    if (!vid) return null;
    return {
      vid,
      url: toSafeHhUrl(entry.url || entry.href || ''),
      title: collapseSpaces(entry.title || ''),
      employer: collapseSpaces(entry.employer || ''),
      salary: collapseSpaces(entry.salary || ''),
      reason: collapseSpaces(entry.reason || entry.note || ''),
      addedAt: Number(entry.addedAt || entry.ts) || Date.now(),
      returnUrl: toSafeHhUrl(entry.returnUrl || '')
    };
  }

  const ManualQueue = {
    get() {
      const raw = parseJson(storage.localGet(KEYS.manualList), []);
      return Array.isArray(raw) ? raw.map(normalizeManualEntry).filter(Boolean) : [];
    },
    save(list) {
      const clean = Array.isArray(list) ? list.map(normalizeManualEntry).filter(Boolean) : [];
      const ok = storage.localSet(KEYS.manualList, JSON.stringify(clean));
      events.emit('manualQueue', { action: 'sync', queue: clean });
      return ok;
    },
    add(entry) {
      const item = normalizeManualEntry(entry);
      if (!item) return false;
      const queue = this.get();
      const idx = queue.findIndex(it => it.vid === item.vid);
      if (idx >= 0) queue[idx] = { ...queue[idx], ...item };
      else queue.unshift(item);
      const ok = storage.localSet(KEYS.manualList, JSON.stringify(queue));
      events.emit('manualQueue', { action: idx >= 0 ? 'update' : 'add', item, queue });
      return ok;
    },
    remove(vid) {
      const queue = this.get();
      const targetVid = String(vid || '').replace(/^v_/, '');
      const filtered = queue.filter(it => String(it.vid || '').replace(/^v_/, '') !== targetVid);
      if (filtered.length !== queue.length) {
        storage.localSet(KEYS.manualList, JSON.stringify(filtered));
        events.emit('manualQueue', { action: 'remove', item: { vid }, queue: filtered });
      }
      return true;
    },
    clear() {
      storage.localRemove(KEYS.manualList);
      events.emit('manualQueue', { action: 'clear', queue: [] });
      return true;
    }
  };

  // --- 9. State Accessors ---
  const TAB_ID = (() => {
    const win = globalThis.window;
    const sessionTabId = storage.sessionGet(KEYS.tabId);
    const winName = (win && typeof win.name === 'string') ? win.name : '';

    // Check if this window was navigated or refreshed in the SAME tab
    // In browsers, window.name persists across navigations in the same tab,
    // but is empty or unlinked when a new tab is cloned via target="_blank" or window.open.
    const isSameTab = Boolean(sessionTabId && winName && winName === sessionTabId && winName.startsWith('hha_'));

    if (isSameTab) {
      return sessionTabId;
    }

    // New or cloned tab: generate a fresh unique Tab ID
    const newTabId = 'hha_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
    try {
      if (win) win.name = newTabId;
    } catch (_) {}
    storage.sessionSet(KEYS.tabId, newTabId);

    // If this tab inherited cloned sessionStorage from a parent tab, disarm the cloned state
    if (sessionTabId && sessionTabId !== newTabId) {
      storage.sessionRemove(KEYS.isRunning);
      storage.sessionRemove(KEYS.trapLock);
      storage.sessionRemove(KEYS.lastAttempt);
    }

    return newTabId;
  })();

  const isRunning = () => storage.sessionGet(KEYS.isRunning) === '1';
  const setRunning = (val) => (val ? storage.sessionSet(KEYS.isRunning, '1') : storage.sessionRemove(KEYS.isRunning));

  const getSentCount = () => toNum(storage.sessionGet(KEYS.sentCount), 0);
  function incSentCount() {
    const cur = getSentCount() + 1;
    storage.sessionSet(KEYS.sentCount, String(cur));
    events.emit('progress', {
      sent: cur,
      limit: config.limit,
      percentage: Math.min(100, Math.round((cur / Math.max(1, config.limit)) * 100))
    });
    return cur;
  }
  function resetSentCount() {
    storage.sessionSet(KEYS.sentCount, '0');
    events.emit('progress', { sent: 0, limit: config.limit, percentage: 0 });
    return true;
  }

  function getProcessedIDs() {
    const arr = parseJson(storage.sessionGet(KEYS.history), []);
    return new Set(Array.isArray(arr) ? arr : []);
  }
  function addProcessedID(id) {
    if (!id) return true;
    const ids = getProcessedIDs();
    ids.add(id);
    return storage.sessionSet(KEYS.history, JSON.stringify(Array.from(ids)));
  }
  function clearProcessedIDs() {
    return storage.sessionRemove(KEYS.history);
  }

  const getReturnUrl = () => storage.sessionGet(KEYS.returnUrl) || '';
  const setReturnUrl = (url) => storage.sessionSet(KEYS.returnUrl, url);
  const clearReturnUrl = () => storage.sessionRemove(KEYS.returnUrl);

  const getLastAttemptID = () => storage.sessionGet(KEYS.lastAttempt) || null;
  const setLastAttemptID = (id) => (id ? storage.sessionSet(KEYS.lastAttempt, id) : storage.sessionRemove(KEYS.lastAttempt));
  const clearLastAttemptID = () => storage.sessionRemove(KEYS.lastAttempt);

  function getActiveTrapLock() {
    const val = storage.sessionGet(KEYS.trapLock);
    if (!val) return null;
    const p = parseJson(val, null);
    if (!p || typeof p.token !== 'string' || typeof p.expiresAt !== 'number') return null;
    if (Date.now() >= p.expiresAt) {
      storage.sessionRemove(KEYS.trapLock);
      return null;
    }
    return p;
  }
  function setTrapLock(ttlMs = 45000, runId = currentRunId) {
    const token = Math.random().toString(36).slice(2, 10);
    return storage.sessionSet(KEYS.trapLock, JSON.stringify({ token, expiresAt: Date.now() + ttlMs, runId })) ? token : null;
  }
  function clearTrapLock() {
    return storage.sessionRemove(KEYS.trapLock);
  }

  let currentStatus = { statusKey: 'idle', code: 'IDLE', details: null };
  function setStatus(statusKey, code = null, details = null) {
    const key = ['idle', 'running', 'stopped', 'error', 'done'].includes(statusKey) ? statusKey : 'idle';
    currentStatus = { statusKey: key, code: code || key.toUpperCase(), details };
    events.emit('status', { status: key, code: currentStatus.code, details: details || {} });
  }

  // --- 10. Concurrency & Instance Locks ---
  const INSTANCE_LOCK_TTL = 30000;
  let currentLeaseId = null;
  let instanceLeaseVerified = false;
  let hasActiveWebLock = false;
  let webLockAbortController = null;
  let webLockReleaseResolver = null;
  let webLockPendingPromise = null;

  async function releaseWebLock() {
    if (!hasActiveWebLock && !webLockPendingPromise) return;
    if (webLockReleaseResolver) {
      try { webLockReleaseResolver(); } catch (_) {}
      webLockReleaseResolver = null;
    }
    if (webLockAbortController) {
      try { webLockAbortController.abort(); } catch (_) {}
      webLockAbortController = null;
    }
    hasActiveWebLock = false;
    if (webLockPendingPromise) {
      try { await webLockPendingPromise; } catch (_) {}
      webLockPendingPromise = null;
    }
  }

  function readInstanceLock() {
    return parseJson(storage.localGet(KEYS.instanceLock), null);
  }

  function isLiveLock(lock, now = Date.now()) {
    return Boolean(lock && Number.isFinite(Number(lock.ts)) && (now - Number(lock.ts)) < INSTANCE_LOCK_TTL);
  }

  async function acquireInstanceLock(tabId) {
    await releaseWebLock();
    const now = Date.now();
    const existing = readInstanceLock();

    // Conflict check in localStorage
    if (existing && isLiveLock(existing, now) && existing.tabId !== tabId) {
      instanceLeaseVerified = false;
      return false;
    }

    // Web Locks non-blocking acquisition
    const nav = globalThis.navigator;
    if (nav?.locks?.request) {
      let webLockAcquired = false;
      const lockController = new AbortController();
      try {
        let lockResolver;
        const lockPromise = new Promise(res => { lockResolver = res; });

        webLockPendingPromise = nav.locks.request(
          KEYS.instanceLock,
          { mode: 'exclusive', ifAvailable: true, signal: lockController.signal },
          (lock) => {
            if (!lock) {
              lockResolver(false);
              return;
            }
            webLockAcquired = true;
            hasActiveWebLock = true;
            webLockAbortController = lockController;
            lockResolver(true);
            return new Promise(resRelease => {
              webLockReleaseResolver = resRelease;
            });
          }
        ).catch(() => {
          hasActiveWebLock = false;
          if (!webLockAcquired) lockResolver(null);
        });

        let timeoutId;
        const timeoutPromise = new Promise(resolve => {
          timeoutId = setTimeout(() => resolve('TIMEOUT'), 400);
        });
        const acquired = await Promise.race([lockPromise, timeoutPromise]);
        clearTimeout(timeoutId);

        if (acquired === 'TIMEOUT') {
          try { lockController.abort(); } catch (_) {}
        }
        if (acquired === false || acquired === 'TIMEOUT') {
          instanceLeaseVerified = false;
          return false;
        }
      } catch (_) {
        hasActiveWebLock = false;
      }
    }

    const leaseId = `${tabId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const written = storage.localSet(KEYS.instanceLock, JSON.stringify({ tabId, leaseId, ts: now }));
    if (!written) {
      await releaseWebLock();
      instanceLeaseVerified = false;
      return false;
    }

    currentLeaseId = leaseId;
    instanceLeaseVerified = true;
    return true;
  }

  function releaseInstanceLock(tabId) {
    releaseWebLock();
    const cur = readInstanceLock();
    if (cur && cur.tabId === tabId) {
      storage.localRemove(KEYS.instanceLock);
    }
    currentLeaseId = null;
    instanceLeaseVerified = false;
    return true;
  }

  function touchInstanceLock(tabId) {
    const now = Date.now();
    const cur = readInstanceLock();
    if (!cur || cur.tabId !== tabId || !isLiveLock(cur, now)) {
      instanceLeaseVerified = false;
      return 'LOST';
    }
    const leaseId = currentLeaseId || cur.leaseId;
    currentLeaseId = leaseId;
    if (!storage.localSet(KEYS.instanceLock, JSON.stringify({ tabId, leaseId, ts: now }))) {
      instanceLeaseVerified = false;
      return 'LOST';
    }
    instanceLeaseVerified = true;
    return 'OWNED';
  }

  // --- 11. Run Lifecycle & Guards ---
  let isLoopActive = false;
  let stopSignal = false;
  let currentRunId = 0;
  let resumeTimer = null;
  let activeAbortController = null;
  let handlingResponsePage = false;

  const isRunCurrent = (runId) => !stopSignal && (runId === undefined || runId === null || runId === currentRunId) && isRunning();

  function guardOwnedCommit(runId = currentRunId) {
    if (!isRunCurrent(runId)) return false;
    if (touchInstanceLock(TAB_ID) !== 'OWNED') {
      haltForLostInstanceLock();
      return false;
    }
    return true;
  }

  function terminateRun(code, logMsg = '', details = {}, isError = false) {
    currentRunId++;
    stopSignal = true;
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
    handlingResponsePage = false;
    clearTrapLock();
    if (activeAbortController) {
      try { activeAbortController.abort(); } catch (_) {}
      activeAbortController = null;
    }
    isLoopActive = false;
    setRunning(false);
    releaseInstanceLock(TAB_ID);
    const statusKey = isError ? 'error' : (code === 'STOPPED_BY_USER' ? 'stopped' : code.toLowerCase());
    setStatus(statusKey, code, details);
    if (logMsg) log(logMsg, isError, code, details);
  }

  function finalizeRun(runId, statusKey, msg = '') {
    if (runId !== currentRunId) return;
    terminateRun(statusKey.toUpperCase(), msg, { message: msg }, statusKey === 'error');
  }

  function haltEngine(code, logMsg, details = {}) {
    terminateRun(code, logMsg, details, true);
  }

  const haltForCaptcha = () => haltEngine('CAPTCHA_DETECTED', 'Captcha detected on page. Automation halted.');
  const haltForRateLimit = () => haltEngine('RATE_LIMITED', 'Rate limit detected. Automation halted.');
  const haltForLostInstanceLock = () => {
    const isBlocked = storage.isLocalBlocked();
    haltEngine(isBlocked ? 'STORAGE_BLOCKED' : 'TAB_LOCK_LOST', isBlocked ? 'Storage access blocked. Lost tab lock.' : 'Active tab lock lost.');
  };

  // --- 12. DOM Queries & Form Automation ---
  function q(sel, root) {
    try { return (root || globalThis.document)?.querySelector(sel) || null; } catch (_) { return null; }
  }

  function qa(sel, root) {
    try {
      const s = root || globalThis.document;
      return s ? Array.from(s.querySelectorAll(sel)) : [];
    } catch (_) {
      return [];
    }
  }

  function isVisible(el) {
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (_) {
      return el.offsetParent !== null;
    }
  }

  function isReviewOrFeedbackElement(el) {
    if (!el || el === globalThis.document || el === globalThis.document?.body || el === globalThis.document?.documentElement) {
      return false;
    }
    // 1. Element itself or any ancestor matches review, feedback, or Dream Job widget
    if (el.closest?.(
      '[data-qa*="review" i], [data-qa*="feedback" i], [data-qa*="employer-review" i], ' +
      '[data-qa*="review-card" i], [data-qa*="reviews-slider" i], [data-qa*="all-reviews" i], ' +
      '[data-qa*="big-widget" i], [class*="review" i], [class*="feedback" i], ' +
      '[class*="dreamjob" i], [class*="dream-job" i], [data-qa*="dream-job" i], [data-qa*="dreamjob" i], ' +
      'a[href*="/reviews"], a[href*="BigWidget"], [data-qa="employer-reviews-stars"]'
    )) {
      return true;
    }

    // 2. If element is a modal, dialog or popup container, check if it contains reviews or Dream Job
    const isModalOrDialog = el.matches?.('[role="dialog"], [data-qa*="modal" i], [class*="modal" i], [data-qa*="popup" i]');
    if (isModalOrDialog) {
      if (el.querySelector?.('[data-qa*="employer-review" i], [data-qa*="review-card" i], [data-qa*="reviews-slider" i], [data-qa*="all-reviews" i], [data-qa*="dream-job" i], a[href*="hhtmFrom=BigWidget"], a[href*="/reviews"]')) {
        return true;
      }
    }

    return false;
  }

  function findPatternElement(root, selector, regex, maxLen = Infinity) {
    for (const el of (root || globalThis.document)?.querySelectorAll?.(selector) || []) {
      if (!isVisible(el)) continue;
      if (isReviewOrFeedbackElement(el)) continue;
      const txt = (el.innerText || el.textContent || el.value || '').trim();
      if (txt.length <= maxLen && regex.test(txt)) return el;
    }
    return null;
  }

  const applyBtnHeuristic = (r) => findPatternElement(r, 'button, a, [role="button"]', /откликнуться|отклик без резюме|перейти к отклику|apply|respond/i, 60);
  const coverBtnHeuristic = (r) => findPatternElement(r, 'button, a, [role="button"], span', /сопроводительное|письмо|cover letter|add cover/i, 60);

  const HEURISTIC_RESOLVERS = {
    applyBtn: applyBtnHeuristic,
    vacancyApply: applyBtnHeuristic,
    attachCoverBtn: coverBtnHeuristic,
    attachCoverInModal: coverBtnHeuristic,
    letterSubmit: (r) => {
      const el = findPatternElement(r, 'button, [role="button"], input[type="submit"]', /^(отправить|сохранить|отправить отклик|откликнуться|продолжить|выбрать|send|submit|apply)$/i, 50)
        || findPatternElement(r, 'button, [role="button"], input[type="submit"]', /отправить|сохранить|откликнуться|send|submit|apply/i, 50)
        || q('button[type="submit"], [data-qa*="response-submit" i], [data-qa="vacancy-response-submit"]', r);
      if (el && !el.closest?.('[data-qa*="vacancy-response-link"]')) return el;
      return null;
    },
    relocationBtn: (r) => {
      const direct = q('[data-qa="relocation-warning-confirm"]', r);
      if (direct && isVisible(direct) && !isReviewOrFeedbackElement(direct)) return direct;
      const alert = q('[data-qa="magritte-alert"], [role="dialog"]', r);
      if (alert && !isReviewOrFeedbackElement(alert)) {
        return findPatternElement(alert, 'button, [role="button"]', /^вс[её]\s*равно(?:\s*откликнуться)?$/i, 35);
      }
      return null;
    },
    rejectWarning: (r) => findPatternElement(r, 'div, p, span, section', /не соответствует|отказ|не подходит|warning|reject/i, 250),
    responseChat: (r) => findPatternElement(r, 'a, button', /чат|перейти в чат|сообщения|chat/i, 60),
    pagerNext: (r) => findPatternElement(r, 'a, button', /дальше|впер[её]д|следующая|next/i, 60)
  };

  function queryExact(key, root) {
    return (key in SELECTORS) ? q(SELECTORS[key], root) : null;
  }

  function queryHeuristic(key, root) {
    return HEURISTIC_RESOLVERS[key]?.(root || globalThis.document) || null;
  }

  function query(keyOrSelector, root) {
    if (keyOrSelector in SELECTORS) {
      return queryExact(keyOrSelector, root) || queryHeuristic(keyOrSelector, root);
    }
    return q(keyOrSelector, root);
  }

  function queryAll(keyOrSelector, root) {
    if (keyOrSelector in SELECTORS) {
      const list = qa(SELECTORS[keyOrSelector], root);
      if (list.length) return list;
      const heur = queryHeuristic(keyOrSelector, root);
      return heur ? [heur] : [];
    }
    return qa(keyOrSelector, root);
  }

  function notifySelectorFailure(key, scope = null, extra = {}) {
    const meta = SELECTOR_METADATA[key] || {};
    const selectorName = meta.name || key;
    const expectedCss = SELECTORS[key] || '';
    const heuristic = meta.heuristic || '';

    let snippet = '';
    try {
      if (scope) {
        const rawHtml = scope.outerHTML || (scope.body && scope.body.outerHTML) || '';
        if (rawHtml) {
          snippet = rawHtml.slice(0, 160).replace(/\s+/g, ' ').trim();
          if (rawHtml.length > 160) snippet += '...';
        }
      }
    } catch (_) {}

    const url = globalThis.location?.href || '';
    const msg = `Не найден селектор: ${key} (${selectorName})`;
    const sub = `Ожидался CSS: ${expectedCss}`;

    events.emit('entity', {
      action: 'error',
      tagType: 'error',
      category: 'error',
      tag: 'ERROR',
      metaBadge: 'DOM_ERR',
      selector: key,
      selectorName,
      expectedCss,
      heuristic,
      contextSnippet: snippet,
      url,
      msg,
      sub,
      ...extra
    });

    log(msg, true, 'DOM_SELECTOR_NOT_FOUND', { key, expectedCss, heuristic, url });
  }

  function getVacancyCard(node) {
    if (!node || node.nodeType !== 1) return null;
    const card = node.closest?.(SELECTORS.vacancyCard);
    if (card) return card;
    let curr = node.parentElement;
    const doc = globalThis.document;
    while (curr && curr !== doc?.body) {
      const cls = String(curr.className || '');
      const dataQa = curr.getAttribute?.('data-qa') || '';
      if ((cls.includes('serp-item') || cls.includes('vacancy-serp-item') || dataQa.includes('vacancy') || dataQa.includes('serp-item')) && qa('a[href*="/vacancy/"]', curr).length === 1) {
        return curr;
      }
      curr = curr.parentElement;
    }
    return null;
  }

  function getVacancyIDFromHref(href) {
    const m = String(href || '').match(/\/vacancy\/(\d+)|[?&]vacancyId=(\d+)|vacancyId%3D(\d+)/);
    return m ? String(m[1] || m[2] || m[3]) : null;
  }

  function getVacancyID(node) {
    const card = getVacancyCard(node);
    const link = card ? query('vacancyLink', card) : null;
    const href = link?.href || node?.href || node?.getAttribute?.('href') || '';
    const id = getVacancyIDFromHref(href);
    if (id) return 'v_' + id;
    const cardId = card?.dataset?.id || (card?.innerText ? card.innerText.slice(0, 80).trim() : '');
    return 'v_' + (cardId ? encodeURIComponent(cardId).slice(0, 32) : Math.random().toString(36).slice(2, 10));
  }

  // --- Form Input Dispatch ---
  function fillTextarea(el, value) {
    try {
      if (typeof el.focus === 'function') el.focus();
      if (el._valueTracker?.setValue) {
        try { el._valueTracker.setValue(''); } catch (_) {}
      }
      const setter = Object.getOwnPropertyDescriptor(globalThis.HTMLTextAreaElement?.prototype || {}, 'value')?.set;
      if (setter) {
        setter.call(el, value);
      } else {
        el.value = value;
      }
      const wrapper = el.closest?.(SELECTORS.nativeWrapper) || el.parentElement;
      const clone = wrapper ? q('pre', wrapper) : null;
      if (clone) clone.textContent = value || '\u200B';

      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, cancelable: true, data: value, inputType: 'insertText' }));
      } catch (_) {
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true, cancelable: true }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true, cancelable: true }));
      if (typeof el.blur === 'function') el.blur();
    } catch (_) {
      el.value = value;
    }
  }

  // --- Direct element click ---
  function clickElement(el) {
    if (!el || stopSignal) return false;
    if (el.tagName === 'A' && el.target && el.target.toLowerCase() === '_blank') {
      try { el.target = '_self'; } catch (_) {}
    }
    const tag = (el.tagName || '').toLowerCase();
    const qa = el.getAttribute?.('data-qa') || '';
    const href = el.getAttribute?.('href') || el.href || '';
    const cls = (el.className && typeof el.className === 'string' ? el.className.trim() : '') || '';
    const textSnippet = collapseSpaces(el.innerText || el.textContent || '').slice(0, 50);
    const disabled = Boolean(el.disabled || el.getAttribute?.('aria-disabled') === 'true');
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    const rectInfo = rect ? `${Math.round(rect.width)}x${Math.round(rect.height)} at (${Math.round(rect.left)},${Math.round(rect.top)})` : 'unknown';

    log(`Клик по элементу: <${tag}${qa ? ` data-qa="${qa}"` : ''}${href ? ` href="${href}"` : ''}> "${textSnippet}" [${rectInfo}]`, false, 'ELEMENT_CLICK', {
      tag,
      qa: qa || undefined,
      href: href ? href.slice(0, 150) : undefined,
      class: cls ? cls.slice(0, 80) : undefined,
      text: textSnippet,
      disabled,
      rect: rectInfo
    });

    try { el.scrollIntoView?.({ block: 'center', behavior: 'auto' }); } catch (_) {}
    try { el.focus?.(); } catch (_) {}

    const win = globalThis.window || undefined;
    const downOpts = { bubbles: true, cancelable: true, composed: true, view: win, button: 0, buttons: 1 };
    const upOpts = { bubbles: true, cancelable: true, composed: true, view: win, button: 0, buttons: 0 };
    const pointerDownOpts = { ...downOpts, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const pointerUpOpts = { ...upOpts, pointerId: 1, pointerType: 'mouse', isPrimary: true };

    const innerTarget = el.querySelector?.('span, [class*="label" i], [class*="text" i], [class*="content" i]');
    if (innerTarget && innerTarget !== el) {
      if (typeof PointerEvent !== 'undefined') {
        try { innerTarget.dispatchEvent(new PointerEvent('pointerdown', pointerDownOpts)); } catch (_) {}
      }
      if (typeof MouseEvent !== 'undefined') {
        try { innerTarget.dispatchEvent(new MouseEvent('mousedown', downOpts)); } catch (_) {}
      }
      if (typeof PointerEvent !== 'undefined') {
        try { innerTarget.dispatchEvent(new PointerEvent('pointerup', pointerUpOpts)); } catch (_) {}
      }
      if (typeof MouseEvent !== 'undefined') {
        try { innerTarget.dispatchEvent(new MouseEvent('mouseup', upOpts)); } catch (_) {}
      }
    }

    if (typeof PointerEvent !== 'undefined') {
      try { el.dispatchEvent(new PointerEvent('pointerdown', pointerDownOpts)); } catch (_) {}
    }
    if (typeof MouseEvent !== 'undefined') {
      try { el.dispatchEvent(new MouseEvent('mousedown', downOpts)); } catch (_) {}
    }
    if (typeof PointerEvent !== 'undefined') {
      try { el.dispatchEvent(new PointerEvent('pointerup', pointerUpOpts)); } catch (_) {}
    }
    if (typeof MouseEvent !== 'undefined') {
      try { el.dispatchEvent(new MouseEvent('mouseup', upOpts)); } catch (_) {}
    }

    let clickDispatched = false;
    if (typeof el.click === 'function') {
      try {
        el.click();
        clickDispatched = true;
      } catch (_) {}
    }
    if (!clickDispatched && typeof MouseEvent !== 'undefined') {
      clickDispatched = Boolean(el.dispatchEvent(new MouseEvent('click', upOpts)));
    }
    return clickDispatched;
  }

  function waitForCondition(checkFn, timeout = 8000, signal = null, diagnosticName = '') {
    if (stopSignal || signal?.aborted) return Promise.resolve(false);
    try {
      const init = checkFn();
      if (init) return Promise.resolve(init);
    } catch (_) {}

    return new Promise((resolve) => {
      let timer = null, pollTimer = null, observer = null, heartbeatTimer = null;
      const startTime = Date.now();
      const cleanup = (res) => {
        if (timer) clearTimeout(timer);
        if (pollTimer) clearInterval(pollTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (observer) observer.disconnect();
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(res);
      };
      const onAbort = () => cleanup(false);

      if (stopSignal || signal?.aborted) return resolve(false);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      const check = () => {
        if (stopSignal || signal?.aborted) return cleanup(false);
        try {
          const r = checkFn();
          if (r) cleanup(r);
        } catch (_) {}
      };

      const doc = globalThis.document;
      if (typeof MutationObserver !== 'undefined' && doc) {
        try {
          observer = new MutationObserver(check);
          observer.observe(doc.documentElement || doc, { childList: true, subtree: true, attributes: true });
        } catch (_) {}
      }

      pollTimer = setInterval(check, 100);

      if (diagnosticName && timeout >= 2500) {
        heartbeatTimer = setInterval(() => {
          if (stopSignal || signal?.aborted) return;
          const elapsed = Date.now() - startTime;
          const diagContext = typeof diagnosticName === 'function' ? diagnosticName() : null;
          const label = typeof diagnosticName === 'string' ? diagnosticName : (diagContext?.label || 'условие');
          log(
            `Ожидание: ${label} (${(elapsed / 1000).toFixed(1)}с / ${(timeout / 1000).toFixed(1)}с)...`,
            false,
            'WAIT_HEARTBEAT',
            { elapsedMs: elapsed, timeoutMs: timeout, ...(diagContext || {}) }
          );
        }, 1800);
      }

      timer = setTimeout(() => cleanup(false), timeout);
    });
  }

  function waitForElement(keyOrSelector, timeout = 8000, signal = null) {
    return waitForCondition(() => query(keyOrSelector), timeout, signal);
  }

  // --- 13. Page Classification & Security Anomalies ---
  const Page = {
    isVacancy: () => Boolean(globalThis.location?.pathname?.startsWith('/vacancy/')),
    isResponseForm: () => Boolean(globalThis.location?.pathname?.startsWith('/applicant/vacancy_response')),
    isSearchList: () => Boolean(globalThis.location?.pathname?.startsWith('/search/vacancy')),
    isSearch: () => Boolean(globalThis.location && (globalThis.location.href?.includes('/search/vacancy') || globalThis.location.pathname?.startsWith('/search')))
  };

  function parseVacancyTitle() {
    const h1 = q('h1');
    if (h1 && isVisible(h1)) return collapseSpaces(h1.innerText || h1.textContent);
    const og = q('meta[property="og:title"]');
    if (og) return collapseSpaces(og.getAttribute('content'));
    return collapseSpaces(globalThis.document?.title);
  }

  function readSerpCardTitle(linkEl) {
    if (!linkEl) return '';
    const direct = collapseSpaces(linkEl.innerText || linkEl.textContent);
    if (direct) return direct;
    const card = getVacancyCard(linkEl);
    const link = card ? query('vacancyLink', card) : null;
    return link ? collapseSpaces(link.innerText || link.textContent) : '';
  }

  function detectCaptcha() {
    const doc = globalThis.document, loc = globalThis.location;
    if (!doc) return false;
    if (loc && /\/captcha|\/checkpoint|\/nocaptcha/i.test(loc.pathname)) return true;
    if (q('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="captcha" i], iframe[src*="smartcaptcha" i], [data-qa*="captcha" i], .g-recaptcha, .h-captcha, .smart-captcha, [class*="captcha" i], [id*="captcha" i]')) {
      return true;
    }
    const bodyText = (doc.body?.textContent || doc.documentElement?.textContent || '').slice(0, 3000);
    return /(?:подтвердите,?\s*что\s*вы\s*не\s*робот|введите\s*символы\s*с\s*картинки|вы\s+не\s+робот|not\s+a\s+robot|необычн\w*\s+активн|unusual\s+(?:activity|traffic))/i.test(bodyText);
  }

  function detectRateLimit() {
    const doc = globalThis.document, loc = globalThis.location;
    if (!doc) return false;
    if (loc && /\/error|\/blocked|\/forbidden|\/denied|\/rate-limit/i.test(loc.pathname)) return true;
    if (doc.title && /(?:429|503|error\s+(?:429|503)|доступ\s+ограничен|too\s+many\s+requests|service\s+unavailable)/i.test(doc.title)) return true;
    if (q('[data-qa="error-429"], [data-qa="error-503"], .error-429, .error-503, [data-qa="error-page-title"], [data-qa="error-page"], .error-page, .cf-browser-verification, #challenge-running, #cf-challenge-running, .qrator-challenge, #qrator-clean-page, [data-qa="bloko-notification--error"]')) {
      return true;
    }
    const bodyText = (doc.body?.textContent || doc.documentElement?.textContent || '').slice(0, 3000);
    return /(?:слишком\s*много\s*запросов|429\s*Too\s*Many\s*Requests|503\s*Service\s*Unavailable|доступ\s*(?:временно\s*)?ограничен|access\s*(?:temporarily\s*)?denied|error\s+429|error\s+503)/i.test(bodyText);
  }

  const pageLooksLikeTest = () => {
    const doc = globalThis.document;
    if (!doc) return false;
    if (q('[data-qa*="question" i], [data-qa*="test-task" i], [data-qa*="questionnaire" i], [class*="questionnaire" i], [class*="response-test" i]')) {
      return true;
    }
    const form = q('[data-qa*="response-form" i], [data-qa*="vacancy-response" i], form');
    const text = ((form || doc.body || doc.documentElement)?.textContent || '').slice(0, 4000);
    return /(?:необходимо\s+пройти\s+тест|ответьте\s+на\s+(?:следующие\s+)?вопрос|тестовое\s+задание\s*работодателя|анкета\s+работодателя|пройти\s+опрос)/i.test(text);
  };

  const detectAlreadyApplied = () => {
    const doc = globalThis.document;
    if (!doc) return false;
    if (query('responseChat')) return true;
    const bodyText = ((doc.body || doc.documentElement)?.textContent || '').slice(0, 3000);
    return /(?:вы уже откликались|отклик уже отправлен|already applied)/i.test(bodyText);
  };

  const getResponseDetectionScope = () => q('[data-qa*="modal" i], [class*="modal" i], [data-qa*="popup" i], [class*="popup" i], [role="dialog"]') || globalThis.document?.body || globalThis.document?.documentElement;
  const hasReliableRejectWarning = () => Boolean(query('rejectWarning') && isVisible(query('rejectWarning')));
  const hasResponseTextConfirmation = (root) => /(?:отклик отправлен|вы откликнулись|резюме доставлено|резюме отправлено|response sent|applied successfully)/i.test(((root || getResponseDetectionScope())?.textContent || '').slice(0, 4000));
  const hasExactResponseConfirmation = (root) => {
    const scope = root || getResponseDetectionScope();
    return Boolean(scope && (query('responseChat', scope) || (!config.useCover && query('attachCoverBtn', scope))));
  };

  function isResponseConfirmed({ allowDocumentStrongText = false } = {}) {
    if (hasExactResponseConfirmation() || hasResponseTextConfirmation()) return true;
    const loc = globalThis.location;
    if (loc && (/\/success/i.test(loc.pathname) || /[?&]success\b/i.test(loc.search))) return true;
    if (detectAlreadyApplied()) return true;
    const doc = globalThis.document;
    return Boolean((allowDocumentStrongText || Page.isVacancy()) && doc && /(?:отклик отправлен|вы уже откликались|вы откликнулись|резюме доставлено)/i.test((doc.body?.innerText || doc.body?.textContent || '').slice(0, 4000)));
  }

  function inspectOutcomeDomState() {
    const url = globalThis.location?.href || '';
    const modals = Array.from(globalThis.document?.querySelectorAll('[role="dialog"], [data-qa*="modal" i], [class*="modal" i], [data-qa*="popup" i], [data-qa*="sheet" i]') || [])
      .filter(el => isVisible(el) && !isReviewOrFeedbackElement(el));
    const modalSummary = modals.map(m => {
      const qa = m.getAttribute?.('data-qa') || '';
      const cls = (m.className && typeof m.className === 'string') ? m.className.slice(0, 40) : '';
      const txt = collapseSpaces(m.innerText || m.textContent || '').slice(0, 80);
      return `<${(m.tagName || '').toLowerCase()}${qa ? ` data-qa="${qa}"` : ''}${cls ? ` class="${cls}"` : ''}> "${txt}"`;
    });
    const hasReloc = Boolean(detectRelocationWarning());
    const hasCoverBtn = Boolean(query('attachCoverBtn'));
    const hasChat = Boolean(query('responseChat'));
    const hasAppliedText = detectAlreadyApplied();
    return {
      url,
      visibleModalsCount: modals.length,
      modals: modalSummary,
      hasReloc,
      hasCoverBtn,
      hasChat,
      hasAppliedText
    };
  }

  function detectModalBlockReason(modalScope = null) {
    const modal = modalScope || qa('[data-qa="bottom-sheet-content"], [data-qa="vacancy-response-popup-form"], [data-qa*="modal" i], [class*="modal" i], [data-qa*="popup" i], [class*="popup" i], [role="dialog"]').find(m => isVisible(m) && !isReviewOrFeedbackElement(m)) || null;
    if (!modal) return null;
    const text = (modal.textContent || modal.innerText || '').slice(0, 3000);
    if (/резюме\s*скрыто|resume\s*is\s*hidden/i.test(text)) return 'RESUME_HIDDEN';
    if (/не\s*соответствует\s*требованиям|отказ|reject/i.test(text)) return 'REJECT_WARNING';
    if (/тестирование|анкета|вопросы|questionnaire|test/i.test(text)) return 'TEST_REQUIRED';
    if (detectCaptcha() || /капч[аеы]|captcha|recaptcha|smartcaptcha/i.test(text)) return 'CAPTCHA';
    if (detectRateLimit() || /слишком\s*много\s*запросов|доступ\s*ограничен|rate\s*limit|blocked/i.test(text)) return 'RATE_LIMIT';
    return null;
  }

  function detectRelocationWarning() {
    // 1. Direct standard data-qa selector
    const direct = q('[data-qa="relocation-warning-confirm"]');
    if (direct && isVisible(direct) && !isReviewOrFeedbackElement(direct)) return direct;

    // 2. Alert container with relocation warning
    const alert = q('[data-qa="magritte-alert"]');
    if (alert && isVisible(alert) && !isReviewOrFeedbackElement(alert)) {
      const confirmBtn = q('[data-qa="relocation-warning-confirm"]', alert)
        || findPatternElement(alert, 'button, [role="button"]', /^вс[её]\s*равно(?:\s*откликнуться)?$/i, 35);
      if (confirmBtn && isVisible(confirmBtn)) return confirmBtn;
    }

    // 3. Explicit relocation warning title
    const title = q('[data-qa="relocation-warning-title"]')
      || findPatternElement(null, 'h1, h2, h3, div, p, span', /откликаетесь\s+на\s+вакансию\s+в\s+другой\s+стране|в\s+другой\s+стране/i, 80);
    if (title && isVisible(title)) {
      const scope = title.closest?.('[data-qa="magritte-alert"], [role="dialog"]') || title.parentElement;
      if (scope && !isReviewOrFeedbackElement(scope)) {
        const confirmBtn = q('[data-qa="relocation-warning-confirm"]', scope)
          || findPatternElement(scope, 'button, [role="button"]', /^вс[её]\s*равно(?:\s*откликнуться)?$/i, 35)
          || findPatternElement(scope, 'button, [role="button"]', /^(?:откликнуться|подтвердить)$/i, 35);
        if (confirmBtn && isVisible(confirmBtn)) return confirmBtn;
      }
    }
    return null;
  }

  function detectResponseOutcomeInRoot(root, includeExactSelectors) {
    if (!root || isReviewOrFeedbackElement(root)) return null;
    if (detectCaptcha()) return 'CAPTCHA';
    if (detectRateLimit()) return 'RATE_LIMIT';
    if (hasReliableRejectWarning()) return 'REJECT_WARNING';
    if (detectRelocationWarning()) return 'RELOCATION_WARNING';

    const isResumeModal = Boolean(
      q('[data-qa*="resume" i], [class*="resume" i], input[type="radio"][name*="resume" i], [data-qa*="vacancy-response" i]', root) ||
      /выберите\s+(?:подходящее\s+)?резюме|выбор\s+резюме|откликнуться\s+с\s+резюме|каким\s+резюме|резюме\s+для\s+отклика/i.test(root.textContent || '')
    );
    const hasResponseSubmit = Boolean(
      query('letterSubmit', root) ||
      q('button[data-qa*="submit" i], button[type="submit"], [data-qa*="response-submit" i], [data-qa="vacancy-response-submit-popup"], [data-qa="vacancy-response-submit"]', root) ||
      findPatternElement(root, 'button, [role="button"], a, input[type="submit"]', /^(?:откликнуться|выбрать|продолжить|отправить(?:\s*отклик)?)$/i, 35)
    );

    if (query('letterTextarea', root) || query('attachCoverInModal', root) || query('letterSubmit', root) || q('[data-qa="vacancy-response-popup-form"]', root) || (isResumeModal && hasResponseSubmit) || isResumeModal) {
      return 'MODAL_OPEN';
    }
    if (includeExactSelectors && (query('attachCoverBtn', root) || query('responseChat', root) || hasResponseTextConfirmation(root))) {
      return 'ATTACH_COVER';
    }
    return null;
  }

  function detectResponseOutcomeOnce({ allowDocumentStrongText = false } = {}) {
    // 1. Relocation warning alert has absolute top priority
    if (detectRelocationWarning()) return 'RELOCATION_WARNING';

    // 2. Cover letter attachment on vacancy page banner
    const attachBtn = query('attachCoverBtn');
    if (config.useCover && attachBtn && isVisible(attachBtn) && !isReviewOrFeedbackElement(attachBtn)) {
      return 'ATTACH_COVER';
    }

    // 3. Modals and bottom sheets (iterate through all visible dialogs)
    const modals = qa('[data-qa="bottom-sheet-content"], [data-qa="vacancy-response-popup-form"], [data-qa*="modal" i], [class*="modal" i], [data-qa*="popup" i], [class*="popup" i], [role="dialog"]');
    for (const modal of modals) {
      if (isVisible(modal) && !isReviewOrFeedbackElement(modal)) {
        const outcome = detectResponseOutcomeInRoot(modal, true);
        if (outcome) return outcome;
      }
    }

    // 4. Exact response confirmations
    if (hasExactResponseConfirmation() || isResponseConfirmed({ allowDocumentStrongText })) return 'SUCCESS';

    return null;
  }

  // --- 14. Application Flow & Scenarios ---
  function markVacancyProcessed(vid, runId = currentRunId) {
    if (runId !== undefined && runId !== null && !guardOwnedCommit(runId)) return false;
    return vid ? addProcessedID(vid) : true;
  }

  function commitSuccess(vid, runId = currentRunId) {
    if (runId !== undefined && runId !== null && !guardOwnedCommit(runId)) return false;
    incSentCount();
    bumpStat('success');
    markVacancyProcessed(vid, runId);
    events.emit('entity', { vid, action: 'applied', reason: 'APPLIED' });
    log(`Отклик успешно доставлен на вакансию #${vid}`, false, 'APPLY_SUCCESS', { vid });
    return true;
  }

  function skipVacancy(vid, reason = 'reject_warning', runId = currentRunId) {
    if (runId !== undefined && runId !== null && !guardOwnedCommit(runId)) return false;
    markVacancyProcessed(vid, runId);
    bumpStat('skipped');
    events.emit('entity', { vid, action: 'skipped', reason });
    log(`Вакансия #${vid} пропущена (${reason})`, false, 'VACANCY_SKIPPED', { vid, reason });
  }

  function saveCurrentForManual(vid, note = '', runId = currentRunId) {
    if (runId !== undefined && runId !== null && !guardOwnedCommit(runId)) return false;
    let url = globalThis.location?.href || '';
    const origin = globalThis.location?.origin || 'https://hh.ru';
    if ((!url || url.includes('/search/vacancy')) && vid && String(vid).startsWith('v_')) {
      url = `${origin}/vacancy/${String(vid).slice(2)}`;
    }
    const entry = {
      vid: vid || ('v_' + Math.random().toString(36).slice(2, 10)),
      url,
      returnUrl: getReturnUrl(),
      reason: note,
      addedAt: Date.now(),
      title: parseVacancyTitle()
    };
    const added = ManualQueue.add(entry);
    if (added) {
      bumpStat('manual');
      events.emit('entity', { vid: entry.vid, title: entry.title, url: entry.url, action: 'manual', reason: note, note });
      log(`Вакансия #${entry.vid} сохранена в ручную очередь (${note || 'manual'})`, false, 'MANUAL_SAVED', { vid: entry.vid, note, url: entry.url });
      return true;
    }
    return false;
  }

  function returnToList(vid, { markProcessed = true, runId = currentRunId } = {}) {
    if (runId !== undefined && runId !== null && !guardOwnedCommit(runId)) return false;
    if (markProcessed && vid) markVacancyProcessed(vid, runId);
    clearLastAttemptID();
    const rawReturn = getReturnUrl();
    const origin = globalThis.location?.origin || 'https://hh.ru';
    const returnUrl = (rawReturn && (rawReturn.includes('/search/vacancy') || rawReturn.startsWith('http') || rawReturn.startsWith('/'))) ? rawReturn : `${origin}/search/vacancy`;
    log(`Возврат к поисковой выдаче: ${returnUrl}`, false, 'RETURN_TO_LIST', { vid, returnUrl });
    flushTelemetryBeforeNav();
    const loc = globalThis.location;
    if (loc && !Page.isSearchList() && loc.href !== returnUrl) {
      try { loc.assign(returnUrl); } catch (_) { loc.href = returnUrl; }
    }
    return true;
  }

  async function submitCoverLetterForm(scope = null, runId = currentRunId) {
    if (!isRunCurrent(runId)) return false;
    const ta = query('letterTextarea', scope);
    if (ta && config.useCover) {
      const letterLen = (config.coverText || '').length;
      log(`Заполнение сопроводительного письма (${letterLen} симв.) в поле ввода...`, false, 'FILL_LETTER_START', { letterLen });
      fillTextarea(ta, config.coverText);
      log(`Текст письма введен, клон синхронизирован, события отправлены`, false, 'FILL_LETTER_DONE', { letterLen });
      await actionPause();
      if (!isRunCurrent(runId)) return false;
    }
    const submit = query('letterSubmit', scope)
      || q('button[data-qa*="submit" i], button[type="submit"], [data-qa*="response-submit" i], [data-qa="vacancy-response-submit-popup"], [data-qa="vacancy-response-submit"]', scope)
      || findPatternElement(scope, 'button, [role="button"], a, input[type="submit"]', /^(?:откликнуться|отправить(?:\s*отклик)?|продолжить|сохранить|выбрать|send|submit|apply)$/i, 40);
    if (!submit) {
      log('Кнопка отправки формы сопроводительного письма не найдена', true, 'SUBMIT_BTN_NOT_FOUND');
      return false;
    }

    if (submit.disabled || submit.getAttribute?.('aria-disabled') === 'true') {
      log('Кнопка отправки письма отключена (disabled), ожидаем активации...', false, 'SUBMIT_DISABLED_WAIT');
      await waitForCondition(() => !submit.disabled && submit.getAttribute?.('aria-disabled') !== 'true', 1500, activeAbortController?.signal, 'активация кнопки отправки');
    }

    const submitQa = submit.getAttribute?.('data-qa') || submit.className || 'button[submit]';
    log(`Нажатие кнопки отправки письма (${submitQa})...`, false, 'SUBMIT_LETTER_CLICK', { selector: submitQa });

    const formId = submit.getAttribute?.('form');
    const form = (formId && globalThis.document?.getElementById(formId)) || submit.form || submit.closest?.('form');
    await clickElement(submit);
    if (form && typeof form.requestSubmit === 'function') {
      try {
        form.requestSubmit(submit);
      } catch (_) {}
    }

    await actionPause();
    return isRunCurrent(runId);
  }

  async function handleScenarioA(btn, runId = currentRunId) {
    if (!config.useCover) {
      log('Сопроводительное письмо отключено в настройках, сценарий A завершен', false, 'COVER_DISABLED');
      return 'OK';
    }
    log('Сценарий A: Прикрепление сопроводительного письма после прямого отклика', false, 'SCENARIO_A');
    await actionPause();
    if (!isRunCurrent(runId)) return 'STOPPED';

    const attachBtn = btn || query('attachCoverBtn');
    if (attachBtn) {
      const attachQa = attachBtn.getAttribute?.('data-qa') || 'attachCoverBtn';
      log(`Нажатие кнопки «Приложить сопроводительное письмо» (${attachQa})...`, false, 'ATTACH_COVER_CLICK', { selector: attachQa });
      await clickElement(attachBtn);
    } else {
      log('Кнопка «Приложить сопроводительное письмо» не найдена', true, 'ATTACH_BTN_NOT_FOUND');
      notifySelectorFailure('attachCoverBtn', globalThis.document?.body);
      return isRunCurrent(runId) ? 'OK' : 'STOPPED';
    }

    await actionPause();
    if (!isRunCurrent(runId)) return 'STOPPED';

    log('Ожидание появления шторки ввода письма (bottom-sheet)...', false, 'WAIT_LETTER_FORM');
    const ta = await waitForElement('letterTextarea', 5000, activeAbortController?.signal);
    if (!ta) {
      log('Поле ввода письма не появилось за 5 с', true, 'LETTER_FORM_TIMEOUT');
      notifySelectorFailure('letterTextarea', globalThis.document?.body);
      return isRunCurrent(runId) ? 'OK' : 'STOPPED';
    }

    const modalScope = q('[data-qa="bottom-sheet-content"], [role="dialog"]') || globalThis.document?.body;
    log('Шторка письма открыта, отправляем форму...', false, 'SUBMITTING_COVER_SHEET');
    await submitCoverLetterForm(modalScope, runId);
    if (!isRunCurrent(runId)) return 'STOPPED';

    log('Ожидание закрытия шторки письма и подтверждения доставки...', false, 'WAIT_COVER_DELIVERED');
    await waitForCondition(() => {
      const sheet = q('[data-qa="bottom-sheet-content"]');
      const isSheetClosed = !sheet || !isVisible(sheet);
      return isSheetClosed || isResponseConfirmed({ allowDocumentStrongText: true });
    }, 5000, activeAbortController?.signal);

    log('Сопроводительное письмо успешно прикреплено и отправлено!', false, 'COVER_ATTACH_SUCCESS');
    return isRunCurrent(runId) ? 'OK' : 'STOPPED';
  }

  async function handleScenarioB(modal, runId = currentRunId) {
    log('Scenario B: Response modal opened', false, 'SCENARIO_B');
    const blockReason = detectModalBlockReason(modal);
    if (blockReason === 'CAPTCHA') { haltForCaptcha(); return 'CAPTCHA'; }
    if (blockReason === 'RATE_LIMIT') { haltForRateLimit(); return 'BLOCKED'; }
    if (blockReason === 'TEST_REQUIRED' || blockReason === 'RESUME_HIDDEN') return blockReason;

    if (hasReliableRejectWarning()) {
      const closeBtn = q('[data-qa="vacancy-response-popup-close"], [data-qa*="close" i], button[aria-label*="закрыть" i]', modal);
      if (closeBtn) clickElement(closeBtn);
      return 'SKIP';
    }

    // Support resume selection in modal (e.g. accounts with multiple resumes)
    const radios = qa('input[type="radio"]', modal);
    if (radios.length > 0) {
      const isChecked = radios.some(r => r.checked || r.getAttribute('aria-checked') === 'true');
      if (!isChecked) {
        log(`В модальном окне обнаружен выбор резюме (${radios.length} вариантов). Выбираем первое доступное...`, false, 'RESUME_SELECT', { optionsCount: radios.length });
        const firstRadio = radios[0];
        const clickable = firstRadio.closest?.('label') || firstRadio;
        await clickElement(clickable);
        await actionPause();
        if (!isRunCurrent(runId)) return 'STOPPED';
      } else {
        log('В модальном окне резюме уже выбрано по умолчанию', false, 'RESUME_ALREADY_SELECTED');
      }
    } else {
      const resumeCards = qa('[data-qa*="resume-item" i], [data-qa*="resume-card" i], [class*="resume-item" i]', modal);
      if (resumeCards.length > 0) {
        const isSelected = resumeCards.some(c => c.getAttribute('aria-selected') === 'true' || /selected|active/i.test(c.className || ''));
        if (!isSelected) {
          log(`В модальном окне обнаружены карточки резюме (${resumeCards.length}). Выбираем первое доступное...`, false, 'RESUME_CARD_SELECT', { cardsCount: resumeCards.length });
          await clickElement(resumeCards[0]);
          await actionPause();
          if (!isRunCurrent(runId)) return 'STOPPED';
        }
      }
    }

    const attachCoverToggle = query('attachCoverInModal', modal)
      || findPatternElement(modal, 'button, [role="button"], a', /добавить\s+сопроводительное|написать\s+письмо/i, 35);
    if (attachCoverToggle && config.useCover) {
      log('Нажатие на переключатель сопроводительного письма в модалке...', false, 'COVER_TOGGLE_CLICK');
      await clickElement(attachCoverToggle);
      await actionPause();
      if (!isRunCurrent(runId)) return 'STOPPED';
    }

    const submitted = await submitCoverLetterForm(modal, runId);
    if (!submitted) {
      if (!isRunCurrent(runId)) return 'STOPPED';
      notifySelectorFailure('letterSubmit', modal);
      return 'FAIL';
    }

    const confirmed = await waitForCondition(() => isResponseConfirmed(), 6000, activeAbortController?.signal, 'подтверждение отклика после отправки модалки');
    return confirmed ? 'OK' : 'FAIL';
  }

  async function dispatchOutcome(outcome, vid, runId, relocAttempts = 0) {
    if (!outcome) return 'FAIL';
    if (outcome === 'RESPONSE_FORM') return 'RESPONSE_PAGE';
    if (outcome === 'CAPTCHA') { haltForCaptcha(); return 'CAPTCHA'; }
    if (outcome === 'RATE_LIMIT') { haltForRateLimit(); return 'BLOCKED'; }

    if (outcome === 'ATTACH_COVER') {
      const res = await handleScenarioA(query('attachCoverBtn'), runId);
      if (res === 'OK' && vid) commitSuccess(vid, runId);
      return res;
    }

    if (outcome === 'MODAL_OPEN') {
      const modals = qa('[data-qa="bottom-sheet-content"], [data-qa="vacancy-response-popup-form"], [data-qa*="modal" i], [class*="modal" i], [data-qa*="popup" i], [class*="popup" i], [role="dialog"]');
      const modal = modals.find(m => isVisible(m) && !isReviewOrFeedbackElement(m)) || modals[0] || null;
      const res = await handleScenarioB(modal, runId);
      if (res === 'OK' && vid) {
        commitSuccess(vid, runId);
      } else if (res === 'SKIP' && vid) {
        skipVacancy(vid, 'reject_warning', runId);
      } else if (res === 'TEST_REQUIRED') {
        if (vid) {
          saveCurrentForManual(vid, 'test_required', runId);
          markVacancyProcessed(vid, runId);
        }
        const closeBtn = q('[data-qa="vacancy-response-popup-close"], [data-qa*="close" i]', modal);
        if (closeBtn) clickElement(closeBtn);
      } else if (res === 'RESUME_HIDDEN') {
        if (vid) skipVacancy(vid, 'resume_hidden', runId);
        const closeBtn = q('[data-qa="vacancy-response-popup-close"], [data-qa*="close" i]', modal);
        if (closeBtn) clickElement(closeBtn);
      } else if (res === 'FAIL') {
        if (vid) {
          saveCurrentForManual(vid, 'modal_submit_failed', runId);
          markVacancyProcessed(vid, runId);
        }
        const closeBtn = q('[data-qa="vacancy-response-popup-close"], [data-qa*="close" i], button[aria-label*="закрыть" i]', modal);
        if (closeBtn) clickElement(closeBtn);
      }
      return res;
    }

    if (outcome === 'SUCCESS') {
      if (vid) commitSuccess(vid, runId);
      return 'OK';
    }

    if (outcome === 'REJECT_WARNING') {
      const modal = q('[data-qa*="modal" i], [class*="modal" i], [role="dialog"]');
      if (modal) {
        const closeBtn = q('[data-qa="vacancy-response-popup-close"], [data-qa*="close" i], button[aria-label*="закрыть" i]', modal);
        if (closeBtn) clickElement(closeBtn);
      }
      if (vid) skipVacancy(vid, 'reject_warning', runId);
      return 'SKIP';
    }

    if (outcome === 'RELOCATION_WARNING') {
      if (relocAttempts >= 2) {
        log('Превышен лимит попыток подтверждения релокации (loop guard)', true, 'RELOCATION_LOOP_GUARD', { vid, relocAttempts });
        if (vid) {
          saveCurrentForManual(vid, 'relocation_loop', runId);
          markVacancyProcessed(vid, runId);
        }
        return 'FAIL';
      }
      log('Предупреждение о релокации в другую страну: подтверждаем («Все равно откликнуться»)', false, 'RELOCATION_CONFIRM');
      const relocBtn = detectRelocationWarning() || query('relocationBtn');
      if (relocBtn) {
        await clickElement(relocBtn);
        log('Кнопка «Все равно откликнуться» нажата, ожидаем закрытия алерта...', false, 'RELOCATION_CLICKED');
        await actionPause();
        if (!isRunCurrent(runId)) return 'STOPPED';

        await waitForCondition(() => !detectRelocationWarning(), 4000, activeAbortController?.signal);

        log('Предупреждение о релокации закрыто, ожидаем следующего этапа...', false, 'RELOCATION_RESOLVED');
        const nextOutcome = await waitForCondition(() => (Page.isResponseForm() ? 'RESPONSE_FORM' : detectResponseOutcomeOnce()), 8000, activeAbortController?.signal);
        log(`Следующий этап после релокации: ${nextOutcome || 'TIMEOUT'}`, false, 'RELOCATION_NEXT_OUTCOME', { outcome: nextOutcome });
        if (nextOutcome) {
          return await dispatchOutcome(nextOutcome, vid, runId, relocAttempts + 1);
        }
        if (isResponseConfirmed()) {
          if (vid) commitSuccess(vid, runId);
          return 'OK';
        }
        log('После закрытия предупреждения о релокации исход не подтвержден', true, 'RELOCATION_TIMEOUT', { vid });
        if (vid) {
          saveCurrentForManual(vid, 'relocation_timeout', runId);
          markVacancyProcessed(vid, runId);
        }
        return 'FAIL';
      }
      if (vid) {
        log('Не удалось найти кнопку подтверждения релокации', true, 'RELOCATION_BTN_NOT_FOUND', { vid });
        saveCurrentForManual(vid, 'relocation_unconfirmed', runId);
        markVacancyProcessed(vid, runId);
      }
      return 'FAIL';
    }

    return 'FAIL';
  }

  async function simulateHumanReading(vid, runId = currentRunId) {
    if (!isRunCurrent(runId)) return;
    const doc = globalThis.document;
    const win = globalThis.window;
    if (!doc || !win) return;

    const totalHeight = Math.max(doc.body?.scrollHeight || 0, doc.documentElement?.scrollHeight || 0);
    const viewportHeight = win.innerHeight || 800;
    const maxScroll = Math.max(0, totalHeight - viewportHeight);
    if (maxScroll < 150) {
      log(`Страница короткая (${totalHeight}px), симуляция скролла пропущена`, false, 'SCROLL_SKIP', { vid, totalHeight });
      return;
    }

    // Random viewing depth between 45% and 75%
    const pct = 0.45 + Math.random() * 0.30;
    const targetY = Math.round(maxScroll * pct);

    // 2 to 4 micro-steps simulating natural pauses while reading
    const steps = Math.floor(Math.random() * 3) + 2;
    const t = timings();
    const minDelay = Math.max(1200, Math.round(t.delay[0] * 0.7));
    const maxDelay = Math.round(t.delay[1] * 0.85);
    const totalDuration = randBetween(minDelay, maxDelay);
    const stepDelay = Math.round(totalDuration / steps);

    const title = parseVacancyTitle();
    log(`Изучение вакансии (просмотр ~${Math.round(pct * 100)}%, цель: ${targetY}px, шагов: ${steps}, пауза: ${(totalDuration / 1000).toFixed(1)} с)`, false, 'HUMAN_READING', {
      vid, pct: Math.round(pct * 100), targetY, steps, duration: totalDuration
    });
    events.emit('entity', {
      vid,
      title,
      url: globalThis.location?.href || '',
      action: 'viewing',
      msg: title ? `${title} (~${Math.round(pct * 100)}%)` : `Изучение вакансии (~${Math.round(pct * 100)}%)`
    });

    for (let i = 1; i <= steps; i++) {
      if (!isRunCurrent(runId)) {
        log('Симуляция чтения прервана пользователем', false, 'SCROLL_ABORT', { vid, step: i });
        return;
      }
      const curY = Math.round((targetY / steps) * i);
      try {
        win.scrollTo({ top: curY, behavior: 'smooth' });
      } catch (_) {
        win.scroll?.(0, curY);
      }
      log(`Чтение шага ${i}/${steps}: скролл до ${curY}px, пауза ${(stepDelay / 1000).toFixed(1)}с`, false, 'SCROLL_STEP', { vid, step: i, steps, targetY: curY, pauseMs: stepDelay });
      await wait(stepDelay);
    }
    log(`Симуляция чтения вакансии #${vid} завершена`, false, 'SCROLL_DONE', { vid, finalY: targetY });
  }

  async function handleVacancyPage(vid, runId = currentRunId) {
    try {
      const pageUrl = globalThis.location?.href || '';
      const title = parseVacancyTitle();
      log(`Загружена страница вакансии #${vid}: ${title}`, false, 'VACANCY_PAGE_LOADED', { vid, title, url: pageUrl });

      if (detectAlreadyApplied()) {
        log(`На вакансию #${vid} уже был отправлен отклик ранее`, false, 'ALREADY_APPLIED', { vid });
        if (vid) skipVacancy(vid, 'already_applied', runId);
        returnToList(vid, { markProcessed: true, runId });
        return 'OK';
      }

      // Simulate human-like reading (45-75% scroll with random stops)
      await simulateHumanReading(vid, runId);
      if (!isRunCurrent(runId)) return 'STOPPED';

      log(`Поиск кнопки отклика на странице вакансии #${vid}...`, false, 'SEARCH_APPLY_BTN', { vid });
      const applyBtn = await waitForCondition(() => query('vacancyApply'), 4000, activeAbortController?.signal, `поиск кнопки отклика #${vid}`);
      if (!applyBtn) {
        log(`Кнопка «Откликнуться» не найдена на странице вакансии #${vid}`, true, 'NO_APPLY_BUTTON', { vid, url: pageUrl });
        notifySelectorFailure('vacancyApply', globalThis.document?.body);
        if (vid) saveCurrentForManual(vid, 'no-apply-button', runId);
        returnToList(vid, { markProcessed: true, runId });
        return 'FAIL';
      }

      const applyQa = applyBtn.getAttribute?.('data-qa') || applyBtn.className || 'button';
      const applyHref = applyBtn.getAttribute?.('href') || applyBtn.href || '';
      log(`Кнопка «Откликнуться» найдена (${applyQa}${applyHref ? `, href: ${applyHref}` : ''}), нажатие...`, false, 'APPLY_CLICK', {
        vid, selector: applyQa, href: applyHref
      });
      await actionPause();
      if (!isRunCurrent(runId)) return 'STOPPED';
      await clickElement(applyBtn);
      await actionPause();
      if (!isRunCurrent(runId)) return 'STOPPED';

      log(`Ожидание исхода отклика (модалка, релокация, форма или подтверждение)...`, false, 'WAIT_OUTCOME', { vid });
      const inspectOutcome = () => {
        const domDiag = inspectOutcomeDomState();
        return { label: `исход отклика #${vid}`, vid, ...domDiag };
      };

      let outcome = await waitForCondition(
        () => (Page.isResponseForm() ? 'RESPONSE_FORM' : detectResponseOutcomeOnce()),
        3500,
        activeAbortController?.signal,
        inspectOutcome
      );

      // Direct Link Navigation Fallback: if no modal opened within 3.5s and button links to response page
      if (!outcome && !Page.isResponseForm()) {
        const directHref = applyBtn.getAttribute?.('href') || applyBtn.href;
        if (directHref && (directHref.includes('/applicant/vacancy_response') || directHref.includes('vacancy_response'))) {
          const fullTarget = directHref.startsWith('http') ? directHref : (new URL(directHref, globalThis.location?.origin || 'https://hh.ru').href);
          log(`Модальное окно не появилось за 3.5с. Запуск прямого перехода по ссылке отклика: ${fullTarget}`, false, 'DIRECT_LINK_FALLBACK', { vid, href: fullTarget });
          flushTelemetryBeforeNav();
          setLastAttemptID(vid);
          try {
            globalThis.location.assign(fullTarget);
          } catch (_) {
            globalThis.location.href = fullTarget;
          }
          return 'RESPONSE_PAGE';
        }
      }

      if (!outcome) {
        outcome = await waitForCondition(
          () => (Page.isResponseForm() ? 'RESPONSE_FORM' : detectResponseOutcomeOnce()),
          4500,
          activeAbortController?.signal,
          inspectOutcome
        );
      }

      if (!outcome) {
        const finalDiag = inspectOutcomeDomState();
        log(`Таймаут ожидания исхода отклика на вакансию #${vid}!`, true, 'OUTCOME_TIMEOUT', { vid, ...finalDiag });
      }

      log(`Определен исход отклика: ${outcome || 'TIMEOUT/UNKNOWN'}`, false, 'OUTCOME_DETECTED', { vid, outcome });

      const res = await dispatchOutcome(outcome, vid, runId);
      log(`Результат обработки вакансии #${vid}: ${res}`, false, 'OUTCOME_RESULT', { vid, outcome, result: res });
      if (['OK', 'SKIP', 'TEST_REQUIRED', 'RESUME_HIDDEN'].includes(res)) {
        await actionPause();
        returnToList(vid, { markProcessed: true, runId });
      } else if (res === 'FAIL') {
        log(`Не удалось завершить отклик на вакансию #${vid} (FAIL), сохраняем в ручную очередь и возвращаемся к поиску...`, true, 'VACANCY_FAILED', { vid });
        if (vid) saveCurrentForManual(vid, 'apply_failed', runId);
        await actionPause();
        returnToList(vid, { markProcessed: true, runId });
      } else if (res !== 'RESPONSE_PAGE' && res !== 'STOPPED' && res !== 'CAPTCHA' && res !== 'BLOCKED') {
        log(`Неожиданный результат обработки вакансии #${vid}: ${res}. Сохраняем в ручную очередь и возвращаемся к поиску...`, true, 'VACANCY_UNEXPECTED_RESULT', { vid, result: res });
        if (vid) saveCurrentForManual(vid, `unexpected_${res}`, runId);
        await actionPause();
        returnToList(vid, { markProcessed: true, runId });
      }
      return res;
    } catch (e) {
      log(`Ошибка при обработке страницы вакансии #${vid}: ${(e && e.message) || e}`, true, 'VACANCY_PAGE_ERROR', { vid, error: String(e) });
      if (vid) saveCurrentForManual(vid, 'vacancy-page-error', runId);
      returnToList(vid, { markProcessed: true, runId });
      return 'FAIL';
    }
  }

  async function submitResponsePage(vid, runId = currentRunId) {
    if (!isRunCurrent(runId)) return;
    if (touchInstanceLock(TAB_ID) !== 'OWNED') return haltForLostInstanceLock();
    log('Handling dedicated vacancy response page', false, 'RESPONSE_PAGE', { vid, url: globalThis.location?.href });
    setStatus('running', 'SUBMITTING_RESPONSE_PAGE');
    handlingResponsePage = true;
    try {
      if (pageLooksLikeTest()) {
        log('Обнаружен тест или анкета на странице отклика. Перенаправляем в ручную очередь.', false, 'QUESTIONS_DETECTED', { vid });
        saveCurrentForManual(vid, 'test-questionnaire', runId);
        return returnToList(vid, { markProcessed: true, runId });
      }

      // Resume selection support (for multi-resume profiles)
      const radios = qa('input[type="radio"][name*="resume" i], [data-qa*="resume" i] input[type="radio"], input[type="radio"]');
      if (radios.length > 0) {
        const isChecked = radios.some(r => r.checked || r.getAttribute('aria-checked') === 'true');
        if (!isChecked) {
          log(`На странице отклика обнаружен выбор резюме (${radios.length} вариантов). Выбираем первое доступное...`, false, 'RESUME_SELECT', { vid, optionsCount: radios.length });
          const firstRadio = radios[0];
          const clickable = firstRadio.closest?.('label') || firstRadio;
          await clickElement(clickable);
          await actionPause();
          if (!isRunCurrent(runId)) return;
        } else {
          log('На странице отклика резюме уже выбрано по умолчанию', false, 'RESUME_ALREADY_SELECTED', { vid });
        }
      } else {
        const resumeCards = qa('[data-qa*="resume-item" i], [data-qa*="resume-card" i], [class*="resume-item" i]');
        if (resumeCards.length > 0) {
          const isSelected = resumeCards.some(c => c.getAttribute('aria-selected') === 'true' || /selected|active/i.test(c.className || ''));
          if (!isSelected) {
            log(`На странице отклика обнаружены карточки резюме (${resumeCards.length}). Выбираем первое доступное...`, false, 'RESUME_CARD_SELECT', { vid, cardsCount: resumeCards.length });
            await clickElement(resumeCards[0]);
            await actionPause();
            if (!isRunCurrent(runId)) return;
          }
        }
      }

      // Cover letter toggle support
      const coverToggle = query('attachCoverInModal')
        || findPatternElement(globalThis.document?.body, 'button, [role="button"], a', /добавить\s+сопроводительное|написать\s+письмо/i, 35);
      if (coverToggle && config.useCover) {
        log('Нажатие на переключатель сопроводительного письма...', false, 'COVER_TOGGLE_CLICK', { vid });
        await clickElement(coverToggle);
        await actionPause();
        if (!isRunCurrent(runId)) return;
      }

      const submitBtn = await waitForCondition(
        () => query('letterSubmit')
          || q('button[data-qa*="submit" i], button[type="submit"], [data-qa*="response-submit" i], [data-qa="vacancy-response-submit"]'),
        4000,
        activeAbortController?.signal,
        `поиск кнопки отправки отклика #${vid}`
      );
      if (!isRunCurrent(runId)) return;
      if (!submitBtn) {
        notifySelectorFailure('letterSubmit', globalThis.document?.body);
        saveCurrentForManual(vid, 'no-submit-button', runId);
        return returnToList(vid, { markProcessed: true, runId });
      }
      const submitted = await submitCoverLetterForm(null, runId);
      if (!isRunCurrent(runId)) return;
      if (!submitted) {
        log('Не удалось нажать кнопку отправки формы отклика', true, 'SUBMIT_FAILED', { vid });
        saveCurrentForManual(vid, 'submit-form-failed', runId);
        return returnToList(vid, { markProcessed: true, runId });
      }
      const confirmed = await waitForCondition(
        () => isResponseConfirmed({ allowDocumentStrongText: true }),
        6000,
        activeAbortController?.signal,
        `подтверждение отправки отклика #${vid}`
      );
      log(confirmed ? `Отклик подтвержден на странице вакансии #${vid}` : `Не удалось подтвердить отправку отклика #${vid}`, !confirmed, confirmed ? 'APPLICATION_CONFIRMED' : 'SUBMIT_UNCONFIRMED', { vid });
      if (confirmed) commitSuccess(vid, runId); else saveCurrentForManual(vid, 'unconfirmed', runId);
      returnToList(vid, { markProcessed: true, runId });
    } catch (e) {
      log(`Ошибка при обработке страницы отклика #${vid}: ${(e && e.message) || e}`, true, 'RESPONSE_PAGE_ERROR', { vid, error: String(e) });
      if (vid) saveCurrentForManual(vid, 'response-page-error', runId);
      returnToList(vid, { markProcessed: true, runId });
    } finally {
      handlingResponsePage = false;
      clearTrapLock();
    }
  }

  function getStableVacancyId(btn) {
    if (btn) return getVacancyID(btn);
    const loc = globalThis.location;
    if (loc) {
      const direct = getVacancyIDFromHref(loc.href);
      if (direct) return 'v_' + direct;
    }
    return getLastAttemptID() || getVacancyID(globalThis.document?.body);
  }

  async function processVacancy(btn, runId = currentRunId) {
    if (!isRunCurrent(runId)) return 'STOPPED';
    const vid = getStableVacancyId(btn);
    setLastAttemptID(vid);
    if (Page.isVacancy()) return await handleVacancyPage(vid, runId);
    if (Page.isSearch() && globalThis.location) setReturnUrl(globalThis.location.href);
    const card = getVacancyCard(btn);
    events.emit('entity', { vid, title: card ? readSerpCardTitle(query('vacancyLink', card)) : '', action: 'processing' });
    await clickElement(btn);
    await actionPause();
    if (!isRunCurrent(runId)) return 'STOPPED';
    const outcome = await waitForCondition(() => (Page.isResponseForm() ? 'RESPONSE_FORM' : detectResponseOutcomeOnce()), 8000, activeAbortController?.signal);
    return await dispatchOutcome(outcome, vid, runId);
  }

  // --- 15. Main Execution Loop ---
  async function startLoop() {
    if (isLoopActive) return;
    const wasRunning = isRunning();
    isLoopActive = true;
    const runId = ++currentRunId;
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
    if (activeAbortController) { try { activeAbortController.abort(); } catch (_) {} }
    activeAbortController = new AbortController();
    stopSignal = false;

    setRunning(true);
    setStatus('running', 'LOOP_STARTING');

    const acquired = await acquireInstanceLock(TAB_ID);
    if (runId !== currentRunId || stopSignal || !isRunning()) {
      if (acquired) releaseInstanceLock(TAB_ID);
      return;
    }
    if (!acquired) {
      if (runId === currentRunId) {
        const isBlocked = storage.isLocalBlocked();
        currentRunId++;
        stopSignal = true;
        isLoopActive = false;
        setRunning(false);
        setStatus('idle', isBlocked ? 'STORAGE_BLOCKED' : 'TAB_BUSY', {
          message: isBlocked ? 'Доступ к хранилищу заблокирован.' : 'Другая вкладка уже активна. Остановите её перед запуском здесь.'
        });
        log(isBlocked ? 'Доступ к хранилищу заблокирован.' : 'Другая вкладка уже выполняет отклики. Запуск в текущей вкладке отменен.', true, isBlocked ? 'STORAGE_BLOCKED' : 'TAB_BUSY');
      }
      return;
    }

    if (!wasRunning) {
      resetSentCount();
      resetStats();
      log(`Run started in "${config.preset}" preset (Limit: ${config.limit})`, false, 'RUN_INITIATED', { preset: config.preset, limit: config.limit });
    }

    try {
      if (detectCaptcha()) return haltForCaptcha();
      if (detectRateLimit()) return haltForRateLimit();

      const initialSent = getSentCount();
      if (initialSent >= config.limit) return finalizeRun(runId, 'done', `Application limit reached: ${config.limit}`);

      if (Page.isResponseForm()) {
        if (handlingResponsePage) return;
        const vid = getLastAttemptID() || (globalThis.location && getVacancyIDFromHref(globalThis.location.href) && ('v_' + getVacancyIDFromHref(globalThis.location.href)));
        await submitResponsePage(vid, runId);
        return;
      }

      if (Page.isVacancy()) {
        log('Processing single vacancy page', false, 'ON_VACANCY_PAGE');
        const res = await processVacancy(null, runId);
        if (runId !== currentRunId) return;
        if (res === 'STOPPED' || stopSignal) return finalizeRun(runId, 'stopped', 'Processing stopped on vacancy page');
        if (res === 'CAPTCHA') { haltForCaptcha(); return; }
        if (res === 'RESPONSE_PAGE' || Page.isResponseForm()) {
          isLoopActive = false;
          setStatus('running', 'RESPONSE_PAGE');
          const vid = getLastAttemptID();
          if (Page.isResponseForm() && !handlingResponsePage) {
            handlingResponsePage = true;
            setTrapLock(45000, runId);
            submitResponsePage(vid, runId);
          }
          return;
        }
        isLoopActive = false;
        setStatus('running', res === 'OK' ? 'RETURNING_TO_LIST' : 'WAITING_TO_RETURN');
        if (res !== 'OK' && res !== 'RESPONSE_PAGE' && !Page.isResponseForm()) {
          resumeTimer = setTimeout(() => {
            const targetVid = getLastAttemptID();
            if (isRunning()) returnToList(targetVid, { markProcessed: true, runId });
          }, 2500);
        }
        return;
      }

      if (Page.isSearch() && globalThis.location) setReturnUrl(globalThis.location.href);

      let allBtns = queryAll('applyBtn');
      if (!allBtns.length && Page.isSearch()) {
        await waitForCondition(() => stopSignal || runId !== currentRunId || queryAll('applyBtn').length > 0 || q('[data-qa*="empty" i], [class*="empty" i]'), 2000, activeAbortController?.signal);
        if (!stopSignal && runId === currentRunId) allBtns = queryAll('applyBtn');
      }
      if (stopSignal || runId !== currentRunId) return;

      if (Page.isSearch() && !allBtns.length) {
        const cards = qa(SELECTORS.vacancyCard);
        if (cards.length > 0) {
          const anyAlreadyApplied = cards.some(c => /(?:вы откликнулись|резюме доставлено|отклик отправлен)/i.test(c.textContent || ''));
          const nextBtn = query('pagerNext');
          if (anyAlreadyApplied && nextBtn) {
            log('Все вакансии на странице уже имеют отклики. Переход на следующую страницу...', false, 'PAGINATION_ALL_APPLIED');
            await actionPause();
            if (!isRunCurrent(runId)) return;
            const href = nextBtn.getAttribute?.('href') || nextBtn.href;
            if (href && globalThis.location) {
              setReturnUrl(href);
              flushTelemetryBeforeNav();
              try { globalThis.location.assign(href); } catch (_) { globalThis.location.href = href; }
            } else {
              clickElement(nextBtn);
            }
            return;
          }
          notifySelectorFailure('applyBtn', cards[0], { cardsCount: cards.length });
          return finalizeRun(runId, 'error', 'Селектор applyBtn не найден на странице поиска');
        }
      }

      const processed = getProcessedIDs();
      let targets = allBtns.filter(b => (config.skipHidden && !isVisible(b) ? false : !processed.has(getVacancyID(b))));
      log(`Поисковая выдача: найдено ${allBtns.length} вакансий, ожидают обработки: ${targets.length}, отправлено в сеансе: ${initialSent}/${config.limit}`, false, 'VACANCIES_SCANNED', {
        total: allBtns.length, pending: targets.length, sent: initialSent, limit: config.limit
      });

      if (!targets.length) {
        const nextBtn = query('pagerNext');
        if (nextBtn) {
          log('Все вакансии на текущей странице обработаны. Переход к следующей странице (пагинация)...', false, 'PAGINATION_NEXT');
          await actionPause();
          if (!isRunCurrent(runId)) return;
          const href = nextBtn.getAttribute?.('href') || nextBtn.href;
          if (href && globalThis.location) {
            setReturnUrl(href);
            flushTelemetryBeforeNav();
            try { globalThis.location.assign(href); } catch (_) { globalThis.location.href = href; }
          } else {
            clickElement(nextBtn);
          }
          return;
        }
        const finalSent = getSentCount();
        return finalizeRun(runId, 'done', `Все вакансии в выдаче обработаны. Всего отправлено: ${finalSent}`);
      }

      if (config.openVacancy) {
        const btn = targets[0];
        const card = getVacancyCard(btn);
        const link = card ? query('vacancyLink', card) : null;
        const vid = getStableVacancyId(btn);
        const title = card ? readSerpCardTitle(link) : '';
        const origin = globalThis.location?.origin || 'https://hh.ru';
        const targetUrl = link?.href ? (new URL(link.href, origin)).href : (vid && String(vid).startsWith('v_') ? `${origin}/vacancy/${String(vid).slice(2)}` : null);

        if (!targetUrl) {
          log(`Не удалось определить URL для вакансии #${vid}`, true, 'VACANCY_URL_NOT_FOUND', { vid });
          skipVacancy(vid, 'no_url', runId);
          return;
        }

        setLastAttemptID(vid);
        if (globalThis.location) setReturnUrl(globalThis.location.href);
        events.emit('entity', { vid, title, url: targetUrl, action: 'viewing' });
        log(`Переход к вакансии #${vid} («${title}»)...`, false, 'OPEN_VACANCY', { vid, title, url: targetUrl });
        await vacancyPause();
        if (stopSignal || runId !== currentRunId) return;

        flushTelemetryBeforeNav();
        try {
          globalThis.location.assign(targetUrl);
        } catch (_) {
          globalThis.location.href = targetUrl;
        }
        return;
      }

      let rescanCount = 0;
      while (targets.length > 0) {
        if (stopSignal || runId !== currentRunId) break;
        if (detectCaptcha()) return haltForCaptcha();
        if (detectRateLimit()) return haltForRateLimit();

        const btn = targets.shift();
        const sent = getSentCount();
        if (sent >= config.limit) return finalizeRun(runId, 'done', `Application limit reached: ${config.limit}`);
        if (touchInstanceLock(TAB_ID) !== 'OWNED') return haltForLostInstanceLock();

        const doc = globalThis.document;
        if (!doc?.body?.contains(btn)) {
          if (rescanCount++ < 3) {
            const curProcessed = getProcessedIDs();
            targets = queryAll('applyBtn').filter(b => (config.skipHidden && !isVisible(b) ? false : !curProcessed.has(getVacancyID(b))));
            continue;
          }
          break;
        }

        await vacancyPause();
        if (stopSignal || runId !== currentRunId) break;
        if (touchInstanceLock(TAB_ID) !== 'OWNED') return haltForLostInstanceLock();

        const result = await processVacancy(btn, runId);
        if (runId !== currentRunId) return;
        if (result === 'STOPPED' || stopSignal) return finalizeRun(runId, 'stopped', 'Processing stopped');
        if (result === 'CAPTCHA') { haltForCaptcha(); return; }

        if (result === 'RESPONSE_PAGE' || Page.isResponseForm()) {
          isLoopActive = false;
          setStatus('running', 'RESPONSE_PAGE');
          log('Response page encountered: breaking search loop and transitioning to response page submission', false, 'RESPONSE_PAGE_HANDOFF');
          const vid = getStableVacancyId(btn) || getLastAttemptID();
          if (Page.isResponseForm() && !handlingResponsePage) {
            handlingResponsePage = true;
            setTrapLock(45000, runId);
            submitResponsePage(vid, runId);
          }
          return;
        }

        if (result === 'NAVIGATED') {
          isLoopActive = false;
          return;
        }

        if (result === 'FAIL') {
          skipVacancy(getStableVacancyId(btn), 'action_failed', runId);
        }
      }

      if (stopSignal || runId !== currentRunId) return finalizeRun(runId, 'stopped', 'Processing stopped');
      if (!Page.isResponseForm()) {
        const finalSent = getSentCount();
        finalizeRun(runId, 'done', `Run completed. Total sent in session: ${finalSent}`);
      }
    } catch (e) {
      finalizeRun(runId, 'error', `Main loop error: ${(e && e.message) || e}`);
    }
  }

  // --- 16. Watchdog & Recovery ---
  function watchdogTick() {
    if (!isRunning()) return;
    if (detectCaptcha()) return haltForCaptcha();
    if (detectRateLimit()) return haltForRateLimit();
    if (touchInstanceLock(TAB_ID) !== 'OWNED') return haltForLostInstanceLock();

    if (Page.isResponseForm()) {
      if (getActiveTrapLock()) return;
      if (currentRunId === 0) currentRunId = 1;
      setTrapLock(45000, currentRunId);
      const loc = globalThis.location;
      const vid = getLastAttemptID() || (loc && getVacancyIDFromHref(loc.href) && ('v_' + getVacancyIDFromHref(loc.href))) || null;
      if (!pageLooksLikeTest()) {
        if (handlingResponsePage) return;
        handlingResponsePage = true;
        log('Watchdog detected response page, submitting...', false, 'WATCHDOG_RESPONSE_PAGE');
        submitResponsePage(vid, currentRunId);
        return;
      }
      log('Watchdog detected test/questions on response page. Saving to manual queue.', false, 'QUESTIONS_WATCHDOG');
      if (saveCurrentForManual(vid, 'watchdog-test-page', currentRunId)) {
        if (vid) { markVacancyProcessed(vid, currentRunId); clearLastAttemptID(); }
        returnToList(vid, { markProcessed: true, runId: currentRunId });
      }
    } else {
      clearTrapLock();
      handlingResponsePage = false;
    }
  }

  let watchdogIntervalId = null;
  let domReadyObserver = null;
  const globalListeners = [];

  function addGlobalListener(target, type, handler, options) {
    if (!target?.addEventListener) return;
    try {
      target.addEventListener(type, handler, options);
      globalListeners.push({ target, type, handler, options });
    } catch (_) {}
  }

  function teardownRuntime() {
    if (watchdogIntervalId !== null) {
      clearInterval(watchdogIntervalId);
      watchdogIntervalId = null;
    }
    if (domReadyObserver) {
      try { domReadyObserver.disconnect(); } catch (_) {}
      domReadyObserver = null;
    }
    for (const l of globalListeners.splice(0)) {
      try { l.target.removeEventListener(l.type, l.handler, l.options); } catch (_) {}
    }
    terminateRun('RUNTIME_TEARDOWN', '', {}, false);
    events.removeAllListeners();
  }

  // --- 17. Public API ---
  const HHApplyAssistant = {
    version: VERSION,
    start: () => startLoop(),
    stop: () => terminateRun('STOPPED_BY_USER', 'Automation stopped by user', {}, false),
    getConfig: () => ({ ...config }),
    setConfig: (p) => persistSettings(p),
    getState: () => ({
      version: VERSION,
      tabId: TAB_ID,
      isRunning: isRunning(),
      runId: currentRunId,
      status: currentStatus.statusKey,
      statusCode: currentStatus.code,
      statusDetails: currentStatus.details,
      sentCount: getSentCount(),
      limit: config.limit,
      hasInstanceLock: instanceLeaseVerified,
      hasTrapLock: Boolean(getActiveTrapLock()),
      lastAttemptId: getLastAttemptID(),
      returnUrl: getReturnUrl()
    }),
    resetState() {
      if (isLoopActive) terminateRun('STOPPED_BY_USER', 'Stopped for reset', {}, false);
      stopSignal = true;
      handlingResponsePage = false;
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
      if (activeAbortController) { try { activeAbortController.abort(); } catch (_) {} activeAbortController = null; }
      setRunning(false);
      currentRunId = 0;
      releaseInstanceLock(TAB_ID);
      clearLastAttemptID();
      clearTrapLock();
      clearReturnUrl();
      setStatus('idle', 'IDLE');
      return true;
    },
    setStatus(statusKey, code, details) {
      setStatus(statusKey, code, details);
      return true;
    },
    getStats: () => getStats(),
    resetStats: () => resetStats(),
    resetHistory() {
      clearProcessedIDs();
      resetSentCount();
      resetStats();
      log('Application history and sent counters have been reset', false, 'HISTORY_RESET');
      return true;
    },
    getManualQueue: () => ManualQueue.get(),
    addManualItem: (entry) => Boolean(ManualQueue.add(entry)),
    removeManualItem: (vid) => ManualQueue.remove(vid),
    clearManualQueue: () => ManualQueue.clear(),
    getLogHistory: () => parseJson(storage.localGet(KEYS.logHistory), []),
    clearLogHistory() {
      storage.localRemove(KEYS.logHistory);
      log('История логов очищена', false, 'LOGS_CLEARED');
      return true;
    },
    getEarlyLogs: () => earlyLogsBuffer.slice(),
    on: (evt, fn) => events.on(evt, fn),
    off: (evt, fn) => events.off(evt, fn),
    once: (evt, fn) => events.once(evt, fn),
    destroy: () => teardownRuntime()
  };

  // --- 18. Bootstrap & Global Binding ---
  function bootstrap() {
    ensureCurrentRunLimit();
    if (watchdogIntervalId === null) {
      watchdogIntervalId = setInterval(() => {
        try { watchdogTick(); } catch (e) { console.warn('[HH] Watchdog tick error:', e); }
      }, 1000);
    }
    log(`HH Apply Assistant Headless Engine v${VERSION} initialized`, false, 'ENGINE_INITIALIZED', {
      running: isRunning(), sent: getSentCount(), limit: config.limit
    });

    if (isRunning()) {
      const lock = readInstanceLock();
      const now = Date.now();
      if (lock && isLiveLock(lock, now) && lock.tabId !== TAB_ID) {
        setRunning(false);
        setStatus('idle', 'TAB_BUSY', { message: 'Другая вкладка уже активна' });
        log('Обнаружена активная сессия в другой вкладке. Авто-старт в текущей вкладке отменен.', false, 'TAB_BUSY');
      } else {
        setStatus('running', 'AUTO_STARTING');
        resumeTimer = setTimeout(() => {
          resumeTimer = null;
          if (isRunning()) startLoop();
        }, 1500);
      }
    }
    if (!Page.isResponseForm()) clearTrapLock();

    const win = globalThis.window;
    if (win && typeof win.dispatchEvent === 'function') {
      try { win.dispatchEvent(new CustomEvent('hha:ready', { detail: HHApplyAssistant })); } catch (_) {}
    }
  }

  const doc = globalThis.document;
  if (doc?.body) {
    bootstrap();
  } else if (doc && typeof MutationObserver !== 'undefined') {
    domReadyObserver = new MutationObserver((_, o) => {
      if (doc.body) {
        o.disconnect();
        domReadyObserver = null;
        bootstrap();
      }
    });
    domReadyObserver.observe(doc.documentElement || doc, { childList: true, subtree: true });
  } else {
    ensureCurrentRunLimit();
  }

  const win = globalThis.window;
  if (win && typeof win.addEventListener === 'function') {
    addGlobalListener(win, 'error', (event) => {
      const msg = event.message || (event.error && event.error.message) || 'Unknown window error';
      const filename = event.filename || '';
      const lineno = event.lineno || 0;
      const colno = event.colno || 0;
      const stack = (event.error && event.error.stack) || '';
      log(`[Глобальная ошибка] ${msg} (${filename}:${lineno}:${colno})`, true, 'GLOBAL_UNCAUGHT_ERROR', {
        error: msg, filename, lineno, colno, stack
      });
    });
    addGlobalListener(win, 'unhandledrejection', (event) => {
      const reason = event.reason;
      const msg = (reason && (reason.message || reason.stack)) || String(reason) || 'Unhandled promise rejection';
      const stack = (reason && reason.stack) || '';
      log(`[Необработанный Promise rejection] ${msg}`, true, 'GLOBAL_UNHANDLED_REJECTION', {
        error: msg, stack
      });
    });
    addGlobalListener(win, 'pageshow', (e) => {
      if (e.persisted && isRunning()) {
        isLoopActive = false;
        handlingResponsePage = false;
        startLoop();
      }
    });
    addGlobalListener(win, 'popstate', () => {
      try { watchdogTick(); } catch (_) {}
    });
    addGlobalListener(win, 'beforeunload', () => {
      flushTelemetryBeforeNav();
      if (!isRunning()) releaseInstanceLock(TAB_ID);
    });
    addGlobalListener(win, 'pagehide', () => {
      flushTelemetryBeforeNav();
    });
  }

  return HHApplyAssistant;
});

/**
 * ============================================================================
 * Part 2: Floating HUD UI Module (Web Component)
 * ============================================================================
 */

/**
 * HH Apply Assistant - Floating HUD UI Module
 * Form factor: Floating Pill + Flyout Overlay
 * Implementation: Native Web Component with Closed Shadow DOM
  */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const api = factory();
    if (typeof root !== 'undefined') {
      root.HhaHud = api;
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // --- 1. Utilities & Pure Functions ---

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clamp(val, min, max) {
    const num = Number(val);
    if (isNaN(num)) return min;
    return Math.max(min, Math.min(max, num));
  }

  function clampCoordinates(x, y, width, height, windowWidth, windowHeight, padding = 8) {
    const maxX = Math.max(padding, windowWidth - width - padding);
    const maxY = Math.max(padding, windowHeight - height - padding);
    return {
      x: Math.round(clamp(x, padding, maxX)),
      y: Math.round(clamp(y, padding, maxY))
    };
  }

  function formatTime(ts) {
    const d = ts ? new Date(ts) : new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function formatQueueReason(reason) {
    const r = String(reason || '').toLowerCase();
    if (r.includes('test') || r.includes('questionnaire') || r.includes('questions')) {
      return 'Анкета';
    }
    if (r.includes('redirect') || r.includes('no-apply') || r.includes('relocation')) {
      return 'Редирект';
    }
    if (r.includes('reject') || r.includes('warning') || r.includes('experience')) {
      return 'Опыт';
    }
    if (r.includes('resume_hidden') || r.includes('hidden')) {
      return 'Скрыто';
    }
    if (r.includes('unconfirmed')) {
      return 'Проверка';
    }
    return 'Ручной';
  }

  function cleanVid(vid) {
    return vid ? String(vid).replace(/^v_/, '').trim() : '';
  }

  function toVacancyUrl(vid, url) {
    if (url) return url;
    const clean = cleanVid(vid);
    const origin = (typeof globalThis !== 'undefined' && globalThis.location?.origin) || 'https://hh.ru';
    return clean ? `${origin}/vacancy/${clean}` : '';
  }
  // --- 2. SVG Icons ---

  const ICONS = {
    play: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
    stop: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>`,
    check: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    reset: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`,
    copy: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    open: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
    trash: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`,
    inboxEmpty: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`
  };

  // --- 3. Shadow DOM Stylesheet ---

  const STYLES = `
    /* ═══════════════════════════════════════════════════════════════
       1. HOST & DESIGN TOKENS
       ═══════════════════════════════════════════════════════════════ */
    :host {
      all: initial;
      position: fixed;
      z-index: 2147483640;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-size: 12px;
      line-height: 1.4;
      color: #0f172a;
      box-sizing: border-box;
      user-select: none;
      -webkit-user-select: none;
      -webkit-font-smoothing: antialiased;
      pointer-events: auto;
      interpolate-size: allow-keywords;

      /* Design Tokens: Border Radii */
      --hha-radius-lg: 16px;    /* External overlay container */
      --hha-radius-md: 10px;    /* Inner cards, groups, tabs track */
      --hha-radius-sm: 8px;     /* Interactive elements: stepper, textarea, active tab */
      --hha-radius-xs: 6px;     /* Segmented buttons, ghost action icons, log items */
      --hha-radius-micro: 4px;  /* Compact tags, inline inputs, link badges */
      --hha-radius-full: 9999px;/* Dynamic island pill, status chips, badges */

      /* Control Dimensions */
      --hha-control-height: 28px;
    }

    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    /* ─── 2. ROOT POSITIONING ─────────────────────────────────────── */
    .hha-root {
      position: fixed;
      left: var(--center-x, 0px);
      bottom: 24px;
      top: auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 0;
      margin: 0;
      font-size: 0;
      line-height: 0;
      pointer-events: none;
      transition: none;
      transform: translateX(-50%);
    }

    .hha-root.dir-up {
      flex-direction: column-reverse;
    }


    /* ─── 3. PILL (DYNAMIC ISLAND) ────────────────────────────────── */
    .hha-pill {
      font-size: 12px;
      line-height: 1.4;
      pointer-events: auto;
      display: inline-flex;
      align-items: center;
      height: 36px;
      width: fit-content;
      min-width: auto;
      max-width: min(390px, calc(100vw - 16px));
      padding: 2px;
      gap: 4px;
      border-radius: var(--hha-radius-full, 9999px);
      border: 2px solid rgba(203, 213, 225, 0.9);
      background: #ffffff;
      box-sizing: border-box;
      overflow: hidden;
      box-shadow: 
        inset 0 1px 1px 0 rgba(255, 255, 255, 0.9),
        inset 0 0 0 1px rgba(255, 255, 255, 0.4),
        0 4px 16px -2px rgba(15, 23, 42, 0.12),
        0 2px 6px -1px rgba(15, 23, 42, 0.06);
      cursor: grab;
      touch-action: none;
      white-space: nowrap;
      position: relative;
      transition: 
        box-shadow 180ms cubic-bezier(0.16, 1, 0.3, 1),
        border-color 180ms ease;
    }

    .hha-pill:active {
      cursor: grabbing;
    }

    .hha-root.is-expanded .hha-pill {
      box-shadow: 
        inset 0 1px 1px 0 rgba(255, 255, 255, 0.9),
        inset 0 0 0 1px rgba(255, 255, 255, 0.4),
        0 8px 24px -4px rgba(15, 23, 42, 0.16),
        0 2px 6px -1px rgba(15, 23, 42, 0.08);
    }

    .hha-root.is-expanded .hha-pill-queue-badge {
      width: 0 !important;
      margin-left: 0 !important;
      padding: 0 !important;
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
      transform: scale(0.85);
    }

    .hha-pill-status-group:hover,
    .hha-root.is-expanded .hha-pill-status-group {
      background: #e2e8f0;
    }

    .hha-pill-status-group {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      user-select: none;
      position: relative;
      overflow: hidden;
      isolation: isolate;
      border-radius: var(--hha-radius-full, 9999px);
      height: var(--hha-control-height, 28px);
      min-height: var(--hha-control-height, 28px);
      padding: 0 10px;
      background: #f1f5f9;
      border: none;
      box-sizing: border-box;
      line-height: 1;
      vertical-align: middle;
      outline: none;
      transition: background 150ms ease;
    }

    .hha-pill-status {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 48px;
      height: var(--hha-control-height, 28px);
      min-height: var(--hha-control-height, 28px);
      box-sizing: border-box;
      padding: 0 4px;
      border-radius: 0;
      overflow: visible;
      z-index: 2;
      border: none;
      cursor: pointer;
      user-select: none;
    }

    .hha-pill-progress-fill {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      height: 100%;
      width: 0%;
      background: #dcfce7;
      border-radius: 0;
      z-index: 1;
      pointer-events: none;
      transition: width 260ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    .hha-pill-progress,
    .hha-current-count {
      font-size: 12px;
      font-weight: 600;
      color: #475569;
      font-variant-numeric: tabular-nums;
      position: relative;
      z-index: 2;
    }

    .hha-pill-limit-val {
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }

    /* Pill Contextual Queue Badge (Apple Dynamic Island Fluid Spring Capsule) */
    .hha-pill-queue-badge {
      display: inline-flex;
      height: var(--hha-control-height, 28px);
      min-height: var(--hha-control-height, 28px);
      box-sizing: border-box;
      align-items: center;
      justify-content: center;
      padding: 0;
      border-radius: var(--hha-radius-full, 9999px);
      background: #ffedd5;
      color: #c2410c;
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      flex-shrink: 0;
      vertical-align: middle;
      width: 0;
      min-width: 0;
      max-width: none;
      opacity: 0;
      margin-left: -4px; /* absorbs parent gap when hidden */
      overflow: hidden;
      visibility: hidden;
      pointer-events: none;
      will-change: width, opacity, margin-left;
      transition: 
        width 240ms cubic-bezier(0.16, 1, 0.3, 1),
        margin-left 240ms cubic-bezier(0.16, 1, 0.3, 1),
        opacity 180ms ease,
        transform 100ms ease,
        visibility 240ms;
    }

    .hha-pill-queue-badge.is-visible {
      width: 28px;
      min-width: 0;
      padding: 0;
      margin-left: 0;
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transition: 
        width 240ms cubic-bezier(0.16, 1, 0.3, 1),
        margin-left 240ms cubic-bezier(0.16, 1, 0.3, 1),
        opacity 180ms ease,
        transform 100ms ease,
        visibility 240ms;
    }

    .hha-pill-queue-badge.is-wide {
      width: 36px;
      padding: 0 4px;
    }

    .hha-pill-queue-badge:hover {
      background: #fed7aa;
    }

    .hha-pill-queue-badge:active {
      transform: scale(0.94);
    }

    .hha-pill-queue-badge.is-popping {
      animation: hhaBadgePop 200ms cubic-bezier(0.25, 1, 0.5, 1);
    }

    /* ─── 4. QUICK ACTION BUTTON ──────────────────────────────────── */
    .hha-btn-start,
    .hha-btn-stop,
    .hha-btn-quick {
      margin-left: auto;
      width: 80px;
      min-width: 80px;
      padding: 0 8px;
      border-radius: var(--hha-radius-full, 9999px);
      border: none;
      font-weight: 500;
      font-size: 12px;
      line-height: 1;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      height: var(--hha-control-height, 28px);
      min-height: var(--hha-control-height, 28px);
      box-sizing: border-box;
      vertical-align: middle;
      transition: background-color 100ms ease, border-color 100ms ease;
    }

    .hha-btn-start {
      background: #dcfce7;
      color: #15803d;
      border: 1px solid #bbf7d0;
    }

    .hha-btn-start:hover {
      background: #bbf7d0;
      border-color: #86efac;
    }

    .hha-btn-stop {
      background: #fee2e2;
      color: #b91c1c;
      border: 1px solid #fecaca;
    }

    .hha-btn-stop:hover {
      background: #fecaca;
      border-color: #fca5a5;
    }

    .hha-btn-stop:active,
    .hha-btn-stop:focus-visible {
      background: #fecaca;
      color: #991b1b;
      border-color: #f87171;
    }

    .hha-btn-done {
      background: #f1f5f9;
      color: #475569;
      border: 1px solid #e2e8f0;
    }

    .hha-btn-done:hover {
      background: #e2e8f0;
      border-color: #cbd5e1;
      color: #0f172a;
    }

    .hha-btn-error {
      background: #fee2e2;
      color: #b91c1c;
      border: 1px solid #fecaca;
    }

    .hha-btn-error:hover {
      background: #fecaca;
      border-color: #fca5a5;
    }


    /* ─── 5. FLYOUT PANEL ─────────────────────────────────────────── */
    .hha-flyout {
      font-size: 12px;
      line-height: 1.4;
      pointer-events: auto;
      width: min(390px, calc(100vw - 16px));
      max-width: calc(100vw - 16px);
      height: 420px;
      min-height: 160px;
      max-height: min(420px, calc(100vh - 56px));
      box-sizing: border-box;
      background: #f1f5f9;
      border: 2px solid rgba(203, 213, 225, 0.9);
      border-radius: var(--hha-radius-lg, 16px);
      box-shadow: 
        inset 0 1px 1px 0 rgba(255, 255, 255, 0.9),
        inset 0 0 0 1px rgba(255, 255, 255, 0.4),
        0 20px 40px -6px rgba(15, 23, 42, 0.16),
        0 8px 16px -4px rgba(15, 23, 42, 0.08);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      overflow-x: hidden;
      padding-top: 0;
      position: relative;
      margin: 0;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      will-change: opacity, transform;
      backface-visibility: hidden;
      transition:
        opacity 180ms cubic-bezier(0.16, 1, 0.3, 1),
        transform 180ms cubic-bezier(0.16, 1, 0.3, 1),
        visibility 180ms;
    }

    .hha-root.dir-up .hha-flyout {
      margin: 0;
      transform-origin: center bottom;
      transform: scale(0.96) translateY(6px);
    }

    .hha-root:not(.dir-up) .hha-flyout {
      margin: 0;
      transform-origin: center top;
      transform: scale(0.96) translateY(-6px);
    }

    .hha-root.is-animating .hha-panel,
    .hha-root:not(.is-expanded) .hha-panel {
      overflow: hidden;
      overflow-y: hidden;
    }

    .hha-root.is-expanded .hha-flyout {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transform: scale(1) translateY(0);
    }

    /* ─── 6. TABS (SEGMENTED CONTROL) ─────────────────────────────── */
    .hha-tabs {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      background: #e2e8f0;
      margin: 6px;
      padding: 2px;
      border: 1px solid #cbd5e1;
      border-radius: var(--hha-radius-md, 10px);
      gap: 2px;
      flex-shrink: 0;
      box-sizing: border-box;
    }

    /* Segmented Tab Badges */
    .hha-tab-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 15px;
      height: 15px;
      padding: 0 4px;
      border-radius: var(--hha-radius-full, 9999px);
      font-size: 9px;
      font-weight: 700;
      line-height: 1;
      box-sizing: border-box;
      margin-left: 3px;
    }

    .hha-tab-badge.is-queue {
      background: #ffedd5;
      color: #c2410c;
      border: 1px solid #fed7aa;
    }

    .hha-tab-badge.is-error {
      background: #fee2e2;
      color: #b91c1c;
      border: 1px solid #fca5a5;
      animation: hhaBadgePop 180ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    .hha-tab-btn {
      flex: 1;
      height: var(--hha-control-height, 28px);
      background: transparent;
      border: none;
      outline: none;
      border-radius: var(--hha-radius-sm, 8px);
      font-size: 11px;
      font-weight: 500;
      color: #64748b;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background-color 100ms ease, color 100ms ease;
      box-shadow: none;
      -webkit-appearance: none;
      appearance: none;
    }

    .hha-tab-btn:hover {
      color: #0f172a;
    }


    .hha-pill-status-group:focus-visible,
    .hha-pill-queue-badge:focus-visible,
    .hha-tab-btn:focus-visible,
    .hha-segmented-btn:focus-visible,
    .hha-stepper-btn:focus-visible,
    .hha-stepper-input:focus-visible,
    .hha-btn-quick:focus-visible,
    .hha-queue-title-link:focus-visible,
    .hha-btn-icon:focus-visible,
    .hha-log-item-delete:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px #3b82f6;
    }

    .hha-tab-btn.active {
      background: #ffffff;
      border: none !important;
      border-radius: var(--hha-radius-sm, 8px);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
      color: #0f172a;
      font-weight: 600;
    }

    .hha-tab-btn.active:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px #3b82f6, 0 1px 2px rgba(0, 0, 0, 0.05);
    }

    /* ─── 7. TAB PANELS ───────────────────────────────────────────── */
    .hha-panels {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      overflow-x: hidden;
      padding: 0 6px 6px 6px;
      box-sizing: border-box;
      position: relative;
    }

    .hha-panel {
      display: none;
      flex-direction: column;
      gap: 0;
      flex: 1;
      width: 100%;
      height: 100%;
      min-height: 0;
      box-sizing: border-box;
      overflow-x: hidden;
      overflow-y: auto;
      padding: 0;
      scrollbar-width: thin;
      scrollbar-color: #cbd5e1 transparent;
      position: relative;
    }

    .hha-panel.active {
      display: flex;
    }

    /* ─── 8. LOG & QUEUE CARD ─────────────────────────────────────── */
    .hha-log-card {
      flex: 1;
      min-height: 220px;
      display: flex;
      flex-direction: column;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: var(--hha-radius-md, 10px);
      box-shadow: 0 1px 3px 0 rgba(15, 23, 42, 0.05);
      padding: 8px 10px;
      box-sizing: border-box;
      overflow: hidden;
      position: relative;
    }

    .hha-log-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 26px;
      padding-bottom: 6px;
      border-bottom: 1px solid #f1f5f9;
      width: 100%;
      flex-shrink: 0;
      box-sizing: border-box;
    }

    .hha-log-header-title {
      font-size: 11px;
      font-weight: 600;
      color: #64748b;
      letter-spacing: -0.1px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .hha-log-actions {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .hha-btn-icon {
      width: 24px;
      height: 24px;
      min-width: 24px;
      min-height: 24px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: none;
      background: transparent;
      border-radius: var(--hha-radius-xs, 6px);
      font-size: 13px;
      color: #64748b;
      cursor: pointer;
      transition: background 140ms ease, color 140ms ease;
    }

    .hha-btn-icon:hover {
      background: #f1f5f9;
      color: #0f172a;
    }

    .hha-btn-icon:active {
      background: #e2e8f0;
    }

    .hha-btn-ghost {
      background: transparent;
      border: none;
      border-radius: var(--hha-radius-xs, 6px);
      font-size: 11px;
      color: #64748b;
      cursor: pointer;
      padding: 2px 6px;
      transition: background 140ms ease, color 140ms ease;
    }

    .hha-btn-ghost:hover {
      background: #f1f5f9;
      color: #0f172a;
    }

    .hha-btn-ghost:active {
      background: #e2e8f0;
    }

    .hha-btn-copy-log,
    .hha-btn-clear-logs {
      font-weight: 500;
    }

    .hha-log-stream {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      margin-top: 8px;
      padding-top: 6px;
      padding-bottom: 8px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 4px;
      scrollbar-width: none;
      -ms-overflow-style: none;
    }

    .hha-log-stream::-webkit-scrollbar {
      display: none;
      width: 0;
      height: 0;
    }

    /* Floating Overlay Scrollbar (macOS / iOS capsule style) */
    .hha-overlay-scrollbar {
      position: absolute;
      top: 48px;
      bottom: 8px;
      right: 3px;
      width: 6px;
      pointer-events: auto;
      z-index: 10;
      opacity: 0;
      visibility: hidden;
      transition: opacity 200ms ease, visibility 200ms ease;
      user-select: none;
      cursor: pointer;
    }

    .hha-overlay-scrollbar.is-visible {
      opacity: 1;
      visibility: visible;
    }

    .hha-overlay-thumb {
      position: absolute;
      top: 0;
      right: 0;
      width: 4px;
      min-height: 24px;
      border-radius: var(--hha-radius-full, 9999px);
      background: rgba(148, 163, 184, 0.6);
      cursor: grab;
      touch-action: none;
      transition: width 150ms ease, background-color 150ms ease;
    }

    .hha-overlay-thumb:hover,
    .hha-overlay-thumb.is-dragging {
      width: 6px;
      background: rgba(100, 116, 139, 0.85);
    }

    .hha-overlay-thumb.is-dragging {
      cursor: grabbing;
    }

    .hha-log-empty {
      position: absolute;
      top: calc(50% + 14px);
      left: 0;
      right: 0;
      transform: translateY(-50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 0 16px;
      user-select: none;
      background: transparent;
      border: none;
      pointer-events: none;
    }

    .hha-log-empty-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.8;
    }

    .hha-log-empty-text {
      color: #64748b;
      font-size: 11px;
      font-weight: 500;
      text-align: center;
      line-height: 1.4;
    }

    .hha-log-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 8px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: var(--hha-radius-xs, 6px);
      font-size: 11px;
      gap: 6px;
      min-height: 28px;
      box-sizing: border-box;
    }

    .hha-log-item-left {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex: 1;
    }

    .hha-queue-title-link {
      display: inline-flex;
      align-items: center;
      min-width: 0;
      flex: 1;
      color: #0f172a;
      text-decoration: none;
      font-weight: 500;
      font-size: 11px;
      overflow: hidden;
      cursor: pointer;
      transition: color 100ms ease;
    }

    .hha-queue-title-link:hover {
      color: #2563eb;
    }

    .hha-queue-title-text {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .hha-log-item-right {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }

    .hha-log-item-delete {
      width: 24px;
      height: 24px;
      min-width: 24px;
      min-height: 24px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: #94a3b8;
      cursor: pointer;
      transition: color 100ms ease, background-color 100ms ease;
    }

    .hha-log-item-delete:hover {
      color: #ef4444;
      background: #fee2e2;
    }


    /* ─── 9. DEVTOOLS LOG STREAM ──────────────────────────────────── */
    .hha-log-dev-row {
      display: flex;
      flex-direction: column;
      border-bottom: 1px solid #f1f5f9;
      background: #ffffff;
      box-sizing: border-box;
      transition: background-color 100ms ease;
      cursor: pointer;
      user-select: none;
      border-radius: 3px;
    }

    .hha-log-dev-row:hover {
      background: #f8fafc;
    }

    .hha-log-dev-row.is-expanded {
      background: #f8fafc;
    }

    .hha-log-dev-main {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 6px;
      min-height: 24px;
      box-sizing: border-box;
    }

    .hha-log-dev-time {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 10px;
      color: #94a3b8;
      flex-shrink: 0;
      width: 44px;
      letter-spacing: -0.2px;
    }

    .hha-log-dev-tag {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 9px;
      font-weight: 700;
      padding: 1px 4px;
      border-radius: var(--hha-radius-micro, 3px);
      flex-shrink: 0;
      letter-spacing: 0.2px;
      line-height: 1.2;
    }

    .hha-log-dev-tag.tag-scan {
      background: #eff6ff;
      color: #2563eb;
      border: 1px solid #bfdbfe;
    }

    .hha-log-dev-tag.tag-filter {
      background: #f5f3ff;
      color: #7c3aed;
      border: 1px solid #ddd6fe;
    }

    .hha-log-dev-tag.tag-apply {
      background: #ecfdf5;
      color: #059669;
      border: 1px solid #a7f3d0;
    }

    .hha-log-dev-tag.tag-cover {
      background: #eef2ff;
      color: #4f46e5;
      border: 1px solid #c7d2fe;
    }

    .hha-log-dev-tag.tag-queue {
      background: #fffbeb;
      color: #d97706;
      border: 1px solid #fde68a;
    }

    .hha-log-dev-tag.tag-delay {
      background: #f1f5f9;
      color: #64748b;
      border: 1px solid #e2e8f0;
    }

    .hha-log-dev-tag.tag-error {
      background: #fef2f2;
      color: #dc2626;
      border: 1px solid #fecaca;
    }

    .hha-log-dev-tag.tag-status {
      background: #f0fdf4;
      color: #16a34a;
      border: 1px solid #bbf7d0;
    }

    .hha-log-dev-msg {
      flex: 1;
      min-width: 0;
      color: #1e293b;
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }


    .hha-log-dev-arrow {
      font-size: 10px;
      color: #94a3b8;
      transition: transform 150ms ease, color 150ms ease;
      flex-shrink: 0;
      transform: rotate(-90deg);
      display: inline-block;
      width: 10px;
      text-align: center;
    }

    .hha-log-dev-row.is-expanded .hha-log-dev-arrow {
      transform: rotate(0deg);
      color: #2563eb;
    }

    /* Accordion Details Block */
    .hha-log-dev-details {
      display: none;
      padding: 8px 10px 10px 10px;
      background: #f8fafc;
      border-top: 1px dashed #e2e8f0;
      font-size: 10px;
      box-sizing: border-box;
      animation: hhaFadeIn 150ms ease;
    }

    .hha-log-dev-row.is-expanded .hha-log-dev-details {
      display: block;
    }

    .hha-log-detail-grid {
      display: grid;
      grid-template-columns: minmax(65px, auto) 1fr;
      gap: 4px 8px;
      align-items: baseline;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
    }

    .hha-log-detail-key {
      color: #64748b;
      font-weight: 600;
      white-space: nowrap;
      font-size: 10px;
    }

    .hha-log-detail-val {
      color: #0f172a;
      overflow-wrap: break-word;
      word-break: normal;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 5px;
      font-size: 10px;
      min-width: 0;
    }

    .hha-log-detail-note {
      color: #475569;
      font-size: 9.5px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      word-break: normal;
      overflow-wrap: break-word;
    }

    .hha-log-detail-block {
      grid-column: 1 / -1;
      display: flex;
      flex-direction: column;
      gap: 3px;
      margin-top: 2px;
    }

    .hha-log-detail-block-title {
      color: #64748b;
      font-weight: 600;
      font-size: 10px;
    }

    .hha-log-detail-link {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      color: #2563eb;
      text-decoration: none;
      padding: 1px 5px;
      border-radius: 3px;
      background: rgba(37, 99, 235, 0.08);
      font-size: 10px;
      font-weight: 500;
      border: 1px solid rgba(37, 99, 235, 0.18);
      line-height: 1.2;
    }

    .hha-log-detail-link:hover {
      background: rgba(37, 99, 235, 0.18);
    }

    .hha-log-detail-url {
      color: #2563eb;
      text-decoration: underline;
      font-size: 10px;
      overflow-wrap: break-word;
      word-break: break-all;
    }

    .hha-code-highlight {
      color: #b91c1c;
      background: rgba(239, 68, 68, 0.08);
      padding: 4px 6px;
      border-radius: 4px;
      border: 1px solid rgba(239, 68, 68, 0.2);
      display: block;
      width: 100%;
      box-sizing: border-box;
      white-space: pre-wrap;
      overflow-wrap: break-word;
      word-break: break-all;
      font-size: 9.5px;
      line-height: 1.35;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
    }

    .hha-code-heuristic {
      color: #1e293b;
      background: #e2e8f0;
      padding: 4px 6px;
      border-radius: 4px;
      border: 1px solid #cbd5e1;
      display: block;
      width: 100%;
      box-sizing: border-box;
      white-space: pre-wrap;
      overflow-wrap: break-word;
      word-break: break-all;
      font-size: 9.5px;
      line-height: 1.35;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
    }

    .hha-dom-snippet {
      margin: 0;
      padding: 6px 8px;
      background: #0f172a;
      color: #f1f5f9;
      border-radius: 4px;
      font-size: 9px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
      white-space: pre-wrap;
      overflow-wrap: break-word;
      word-break: normal;
      max-height: 90px;
      overflow-y: auto;
      line-height: 1.35;
    }

    .hha-log-detail-footer {
      display: flex;
      justify-content: flex-end;
      margin-top: 6px;
      padding-top: 5px;
      border-top: 1px dashed #e2e8f0;
    }

    .hha-btn-copy-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: var(--hha-radius-xs, 6px);
      border: 1px solid #cbd5e1;
      background: #ffffff;
      color: #475569;
      font-size: 10px;
      font-weight: 500;
      cursor: pointer;
      line-height: 1.2;
      transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
    }

    .hha-btn-copy-item:hover {
      background: #f1f5f9;
      color: #0f172a;
      border-color: #94a3b8;
    }

    .hha-btn-copy-item:active {
      background: #e2e8f0;
    }

    .hha-btn-copy-item.is-copied {
      color: #15803d;
      border-color: #86efac;
      background: #f0fdf4;
    }

    .hha-btn-clear-queue {
      color: #64748b;
    }

    .hha-btn-clear-queue:hover:not(:disabled) {
      background: #fee2e2;
      color: #b91c1c;
    }

    .hha-btn-clear-queue:disabled,
    .hha-btn-clear-queue[disabled] {
      display: none !important;
    }

    /* ─── 10. TOOLTIP ─────────────────────────────────────────────── */
    .hha-tooltip {
      position: absolute;
      background: #0f172a;
      color: #ffffff;
      font-size: 11px;
      font-weight: 500;
      line-height: 1.3;
      padding: 4px 8px;
      border-radius: var(--hha-radius-xs, 6px);
      max-width: 260px;
      width: max-content;
      white-space: normal;
      word-break: break-word;
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.2);
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity 120ms ease;
      z-index: 1000;
    }

    .hha-tooltip.is-visible {
      opacity: 1;
      visibility: visible;
    }

    /* ─── 11. SETTINGS CONTROLS ───────────────────────────────────── */
    .hha-card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: var(--hha-radius-md, 10px);
      box-shadow: 0 1px 3px 0 rgba(15, 23, 42, 0.05);
      margin-bottom: 6px;
      overflow: visible;
      box-sizing: border-box;
    }

    .hha-card:last-child {
      margin-bottom: 0;
    }

    .hha-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 10px;
      min-height: 36px;
      box-sizing: border-box;
    }

    .hha-row + .hha-row {
      border-top: 1px solid #f1f5f9;
    }

    .hha-speed-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 10px;
      min-height: 36px;
      box-sizing: border-box;
      border-top: 1px solid #f1f5f9;
      flex-wrap: nowrap;
    }

    .hha-row-label {
      font-size: 13px;
      font-weight: 500;
      color: #0f172a;
    }

    .hha-stepper {
      display: inline-flex;
      align-items: stretch;
      border: 1px solid #e2e8f0;
      border-radius: var(--hha-radius-sm, 8px);
      background: #ffffff;
      overflow: hidden;
      height: var(--hha-control-height, 28px);
      box-sizing: border-box;
    }

    .hha-stepper-btn {
      width: 28px;
      min-width: 28px;
      height: var(--hha-control-height, 28px);
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      color: #0f172a;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      padding: 0;
      transition: background 140ms ease;
      user-select: none;
      box-sizing: border-box;
    }

    .hha-stepper-btn:hover {
      background: #f1f5f9;
    }

    .hha-stepper-btn:active {
      background: #e2e8f0;
    }

    .hha-stepper-input {
      width: 44px;
      height: var(--hha-control-height, 28px);
      border: none;
      border-left: 1px solid #e2e8f0;
      border-right: 1px solid #e2e8f0;
      text-align: center;
      font-size: 12px;
      font-weight: 600;
      color: #0f172a;
      padding: 0;
      outline: none;
      box-sizing: border-box;
      -moz-appearance: textfield;
    }

    .hha-stepper-input:focus,
    .hha-stepper-input.is-focused {
      background: #eff6ff;
    }

    .hha-stepper-input::-webkit-outer-spin-button,
    .hha-stepper-input::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }

    .hha-segmented-control {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      max-width: 204px;
      min-width: 170px;
      width: 100%;
      height: 28px;
      padding: 2px;
      gap: 2px;
      background: #f1f5f9;
      border-radius: 8px;
      box-sizing: border-box;
    }

    .hha-segmented-btn {
      width: 100%;
      height: 100%;
      min-width: 0;
      padding: 0 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      font-size: 11px;
      font-weight: 500;
      line-height: 1;
      border: none;
      border-radius: var(--hha-radius-xs, 6px);
      background: transparent;
      color: #64748b;
      cursor: pointer;
      box-sizing: border-box;
      transition: background-color 120ms ease, color 120ms ease, box-shadow 120ms ease;
    }

    .hha-segmented-btn:hover {
      color: #0f172a;
    }

    .hha-segmented-btn.is-active {
      background: #ffffff !important;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0, 0, 0, 0.06) !important;
      color: #0f172a !important;
      font-weight: 600 !important;
    }

    /* ─── 12. SWITCH & COVER LETTER ───────────────────────────────── */
    .hha-card-cover {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      margin-bottom: 0;
      overflow: hidden;
    }

    .hha-switch-row {
      display: flex;
      align-items: center;
      padding: 7px 10px 7px 10px;
      box-sizing: border-box;
      border-bottom: 1px solid #f1f5f9;
      width: 100%;
      flex-shrink: 0;
      background: #ffffff;
    }

    .hha-switch-label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      cursor: pointer;
      user-select: none;
      gap: 12px;
    }

    .hha-switch-label .hha-row-label {
      font-size: 12px;
      line-height: 1.35;
      font-weight: 500;
      color: #0f172a;
    }

    .hha-switch {
      position: relative;
      display: inline-block;
      width: 36px;
      height: 20px;
      flex-shrink: 0;
    }

    .hha-switch-input {
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
      margin: 0;
      pointer-events: none;
    }

    .hha-switch-slider {
      position: absolute;
      cursor: pointer;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-color: #e2e8f0;
      border-radius: 9999px;
      box-shadow: inset 0 0 0 1px #cbd5e1;
      transition: background-color 200ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 200ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    .hha-switch-slider:hover {
      box-shadow: inset 0 0 0 1px #94a3b8;
    }

    .hha-switch-slider::before {
      position: absolute;
      content: "";
      height: 16px;
      width: 16px;
      left: 2px;
      bottom: 2px;
      background-color: #ffffff;
      border-radius: 50%;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.16), 0 0 1px rgba(15, 23, 42, 0.1);
      transition: transform 200ms cubic-bezier(0.34, 1.3, 0.64, 1);
    }

    .hha-switch-input:checked + .hha-switch-slider {
      background-color: #bbf7d0;
      box-shadow: inset 0 0 0 1px #86efac;
    }

    .hha-switch-input:checked + .hha-switch-slider:hover {
      background-color: #a7f3d0;
      box-shadow: inset 0 0 0 1px #4ade80;
    }

    .hha-switch-input:checked + .hha-switch-slider::before {
      transform: translateX(16px);
    }

    .hha-switch-input:focus-visible + .hha-switch-slider {
      box-shadow: 0 0 0 2px #86efac;
    }

    .hha-cover-container {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      padding: 0;
      box-sizing: border-box;
      position: relative;
      background: #ffffff;
    }

    .hha-cover-textarea {
      width: 100%;
      flex: 1;
      height: 100%;
      min-height: 105px;
      background: transparent;
      border: none;
      border-radius: 0;
      color: #0f172a;
      font-size: 12px;
      line-height: 1.45;
      font-family: inherit;
      padding: 8px 10px 28px 10px;
      margin: 0;
      resize: none;
      outline: none;
      box-sizing: border-box;
      box-shadow: none !important;
      scrollbar-width: thin;
      scrollbar-color: #cbd5e1 transparent;
      transition: 
        opacity 180ms ease,
        background-color 180ms ease,
        color 180ms ease;
    }


    .hha-cover-textarea:disabled,
    .hha-cover-textarea.is-disabled {
      opacity: 0.55;
      background: #f8fafc;
      color: #64748b;
      cursor: not-allowed;
    }

    .hha-char-counter {
      position: absolute;
      bottom: 7px;
      right: 9px;
      z-index: 2;
      pointer-events: none;
      font-size: 10.5px;
      line-height: 1;
      color: #94a3b8;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      background: rgba(255, 255, 255, 0.85);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      padding: 3px 6px;
      border-radius: 6px;
      border: 1px solid rgba(226, 232, 240, 0.7);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
      transition: color 120ms ease, border-color 120ms ease, opacity 180ms ease;
    }

    .hha-cover-textarea:disabled ~ .hha-char-counter,
    .hha-cover-textarea.is-disabled ~ .hha-char-counter {
      opacity: 0.55;
      background: rgba(248, 250, 252, 0.85);
    }

    .hha-char-counter.is-limit {
      color: #e11d48;
      border-color: rgba(244, 63, 94, 0.4);
      font-weight: 600;
    }

    /* ─── 13. KEYFRAMES ───────────────────────────────────────────── */

    @keyframes hhaBadgePop {
      0% {
        transform: scale(1);
      }
      40% {
        transform: scale(1.06);
      }
      100% {
        transform: scale(1);
      }
    }

    @keyframes hhaFadeIn {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }
  `;

  // --- 4. Web Component Implementation (Closed Shadow DOM) ---

  const BaseElement = (typeof HTMLElement !== 'undefined') ? HTMLElement : class {};

  class HhaHudElement extends BaseElement {
    constructor() {
      super();
      this._shadow = (typeof this.attachShadow === 'function')
        ? this.attachShadow({ mode: 'closed' })
        : null;
      this._assistant = null;
      this._unsubscribers = [];

      // UI State
      this._isExpanded = false;
      this._activeTab = 'settings'; // 'settings' | 'queue' | 'logs'
      this._expandedLogIds = new Set();
      const initWinW = (typeof window !== 'undefined' && window.innerWidth) || 1024;
      const initWinH = (typeof window !== 'undefined' && window.innerHeight) || 768;
      this._pillPos = { x: Math.max(8, initWinW - 220), y: Math.max(8, initWinH - 36 - 24) };
      this._collapsedPillWidth = 166;
      this._isAnimating = false;
      this._liveFeed = [];
      this._stats = { attempts: 0, success: 0, manual: 0, skipped: 0 };
      this._queue = [];
      this._config = {
        limit: 50,
        preset: 'balanced',
        useCover: true,
        openVacancy: true,
        coverText: '',
        skipHidden: true
      };
      this._status = { status: 'idle', code: 'IDLE' };
      this._progress = { sent: 0, limit: 50, percentage: 0 };

      // Drag & Drop State
      this._isPointerDown = false;
      this._dragMoved = false;
      this._pointerId = null;
      this._dragHandleType = null; // 'pill'
      this._dragTarget = null;
      this._dragStartPointer = { x: 0, y: 0 };
      this._dragStartPillPos = { x: 0, y: 0 };
      this._dragOpenDirection = null; // locked direction while dragging
      this._justDragged = false;
      this._coverDebounceTimer = null;
      this._animTimer = null;
      this._domEventsBound = false;
      this._onDocClick = null;
      this._copyFeedbackTimer = null;
      this._copyBtnOrigHtml = null;
      this._copyBtnOrigColor = null;
      this._persistLogsTimer = null;

      // Bound Event Handlers
      this._onResize = this._onResize.bind(this);
      this._onPointerDown = this._onPointerDown.bind(this);
      this._onPointerMove = this._onPointerMove.bind(this);
      this._onPointerUp = this._onPointerUp.bind(this);
    }

    connectedCallback() {
      try {
        const savedLogs = parseJson(storage.localGet(KEYS.logHistory), []);
        if (Array.isArray(savedLogs) && savedLogs.length > 0) {
          this._liveFeed = savedLogs.slice(0, 2000);
        }
      } catch (_) {}

      this._render();
      this._restorePosition();
      this._bindDomEvents();
      this._syncAll();

      if (typeof window !== 'undefined') {
        window.addEventListener('resize', this._onResize, { passive: true });
        this._onWindowUnload = () => this._flushLogs();
        window.addEventListener('beforeunload', this._onWindowUnload);
        window.addEventListener('pagehide', this._onWindowUnload);
      }

      // Auto-bind to global assistant if present
      const globalAssistant = globalThis.HHApplyAssistant || (globalThis.window && globalThis.window.HHApplyAssistant);
      if (globalAssistant && !this._assistant) {
        this.bindAssistant(globalAssistant);
      }
    }

    _flushLogs() {
      if (this._persistLogsTimer) {
        clearTimeout(this._persistLogsTimer);
        this._persistLogsTimer = null;
      }
      try {
        if (this._liveFeed && this._liveFeed.length > 0) {
          storage.localSet(KEYS.logHistory, JSON.stringify(this._liveFeed.slice(0, 2000)));
        }
      } catch (_) {}
    }

    disconnectedCallback() {
      this._domEventsBound = false;
      this.unbindAssistant();
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', this._onResize);
        if (this._onWindowUnload) {
          window.removeEventListener('beforeunload', this._onWindowUnload);
          window.removeEventListener('pagehide', this._onWindowUnload);
        }
      }
      if (this._onDocClick && typeof document !== 'undefined') {
        document.removeEventListener('click', this._onDocClick);
      }
      if (this._coverDebounceTimer) clearTimeout(this._coverDebounceTimer);
      if (this._animTimer) clearTimeout(this._animTimer);
      this._flushLogs();
    }

    // --- Public API ---

    bindAssistant(assistant) {
      if (!assistant || this._assistant === assistant) return;
      this.unbindAssistant();
      this._assistant = assistant;

      // Initial state sync
      let stateLimit;
      if (typeof assistant.getState === 'function') {
        const s = assistant.getState();
        if (s) {
          const sent = s.sentCount !== undefined ? s.sentCount : s.sentToday;
          const lim = s.limit !== undefined ? s.limit : s.dailyLimit;
          if (lim !== undefined) {
            stateLimit = Math.max(1, Math.min(200, parseInt(lim, 10) || 50));
            this._config.limit = stateLimit;
          }
          this.updateStatus(s.status, s.statusCode || s.code);
          this.updateProgress(sent, lim);
        }
      }

      if (typeof assistant.getConfig === 'function') {
        const c = assistant.getConfig();
        if (c) {
          if (c.dailyLimit !== undefined && c.limit === undefined) {
            c.limit = c.dailyLimit;
          }
          this._config = { ...this._config, ...c };
          if (stateLimit !== undefined) {
            this._config.limit = stateLimit;
          }
        }
      }

      if (typeof assistant.getStats === 'function') {
        const st = assistant.getStats();
        if (st) {
          const successVal = (st.success !== undefined ? st.success : st.applied) || 0;
          this._stats = {
            ...this._stats,
            ...st,
            success: Number(successVal) || 0
          };
        }
      }

      if (typeof assistant.getManualQueue === 'function') {
        const q = assistant.getManualQueue();
        if (Array.isArray(q)) this._queue = q;
      }

      // Reactive Event Subscriptions
      if (typeof assistant.on === 'function') {
        this._unsubscribers.push(
          assistant.on('status', (payload) => {
            if (payload) this.updateStatus(payload.status, payload.code || payload.statusCode);
          }),
          assistant.on('progress', (payload) => {
            if (payload) this.updateProgress(payload.sent, payload.limit);
          }),
          assistant.on('stats', (stats) => this.updateStats(stats)),
          assistant.on('entity', (event) => this.updateLiveFeed(event)),
          assistant.on('log', (payload) => this._onEngineLog(payload)),
          assistant.on('manualQueue', (payload) => {
            const q = payload && Array.isArray(payload.queue) ? payload.queue : payload;
            this.updateQueue(q);
          }),
          assistant.on('config', (payload) => {
            const current = payload?.current || payload;
            this.updateConfig(current);
          })
        );
      }

      // Replay any early logs emitted by engine before HUD mounted
      if (typeof assistant.getEarlyLogs === 'function') {
        const early = assistant.getEarlyLogs();
        if (Array.isArray(early) && early.length > 0) {
          for (const item of early) {
            this._onEngineLog(item);
          }
        }
      }

      this._syncAll();
    }

    unbindAssistant() {
      for (const unsub of this._unsubscribers) {
        try { if (typeof unsub === 'function') unsub(); } catch (_) {}
      }
      this._unsubscribers = [];
      this._assistant = null;
      if (this._copyFeedbackTimer) {
        clearTimeout(this._copyFeedbackTimer);
        this._copyFeedbackTimer = null;
      }
      this._copyBtnOrigHtml = null;
      this._copyBtnOrigColor = null;
    }

    updateStatus(status, code) {
      let nextStatus = status || 'idle';
      let nextCode = code || 'IDLE';
      const lim = this._progress ? this._progress.limit : ((this._config && this._config.limit) || 50);
      const sent = this._progress ? this._progress.sent : 0;
      if (nextStatus === 'running' && sent >= lim && lim > 0) {
        if (this._assistant && typeof this._assistant.stop === 'function') {
          this._assistant.stop();
        }
        nextStatus = 'done';
        nextCode = 'COMPLETED';
      }
      this._status = { status: nextStatus, code: nextCode };
      this._syncStatus();
    }

    updateProgress(sent, limit) {
      const s = Number(sent) || 0;
      const l = Math.max(1, Math.min(200, parseInt(limit, 10) || (this._config && this._config.limit) || 50));
      const displayCurrent = Math.min(Math.max(0, s), l);
      const pct = l > 0 ? Math.min(100, Math.max(0, Math.round((displayCurrent / l) * 100))) : 0;
      this._progress = { sent: s, displayCurrent, limit: l, percentage: pct };
      this._syncProgress();

      if (s >= l && this._status && this._status.status === 'running') {
        if (this._assistant && typeof this._assistant.stop === 'function') {
          this._assistant.stop();
        }
        this.updateStatus('done', 'COMPLETED');
      } else if (s < l && this._status && this._status.status === 'done') {
        this.updateStatus('idle', 'IDLE');
      }
    }

    updateStats(stats) {
      if (!stats) return;
      const successCount = stats.success !== undefined ? stats.success : stats.applied;
      this._stats = {
        attempts: stats.attempts !== undefined ? (Number(stats.attempts) || 0) : this._stats.attempts,
        success: successCount !== undefined ? (Number(successCount) || 0) : this._stats.success,
        manual: stats.manual !== undefined ? (Number(stats.manual) || 0) : this._stats.manual,
        skipped: stats.skipped !== undefined ? (Number(stats.skipped) || 0) : this._stats.skipped
      };
      }

    getStats() {
      return { ...this._stats };
    }

    updateLiveFeed(event) {
      if (!event) return;

      const cVid = cleanVid(event.vid);
      const url = toVacancyUrl(cVid, event.url);
      const time = event.time || formatTime(Date.now());
      const logId = event.id || 'log_' + (++this._logCounter || (this._logCounter = 1)) + '_' + Date.now();

      let tag = event.tag || 'EVENT';
      let tagType = event.tagType || 'scan';
      let msg = event.msg || event.title || 'Событие';
      let sub = event.sub || '';
      let metaBadge = event.metaBadge || '';

      if (event.action === 'viewing') {
        tag = 'VIEW';
        tagType = 'scan';
        msg = event.title || (cVid ? `Вакансия #${cVid}` : 'Вакансия');
        sub = `Открытие карточки вакансии для просмотра и отклика`;
        metaBadge = 'просмотр';
      } else if (event.action === 'processing') {
        tag = 'APPLY';
        tagType = 'apply';
        msg = event.title || (cVid ? `Вакансия #${cVid}` : 'Вакансия');
        sub = `Подготовка к отклику на вакансию #${cVid || 'N/A'}`;
        metaBadge = 'отклик';
      } else if (event.action === 'applied' || tagType === 'apply') {
        tag = 'APPLY';
        tagType = 'apply';
        const emp = event.employer ? `${event.employer} • ` : '';
        msg = `${emp}${event.title || (cVid ? `Вакансия #${cVid}` : 'Вакансия')}`;
        sub = `ID: v_${cVid || 'N/A'}${event.employer ? ` • Компания: ${event.employer}` : ''} • HTTP 200 OK • Отклик успешно доставлен`;
        metaBadge = '200 OK';
      } else if (event.action === 'skipped' || tagType === 'filter') {
        tag = 'FILTER';
        tagType = 'filter';
        msg = `${event.title || (cVid ? `Вакансия #${cVid}` : 'Вакансия')}`;
        sub = `Причина отсева: ${event.reason || 'не соответствует фильтрам поиска'}`;
        metaBadge = 'отсев';
      } else if (event.action === 'manual' || tagType === 'queue') {
        tag = 'QUEUE';
        tagType = 'queue';
        msg = event.title || (cVid ? `Вакансия #${cVid}` : 'Вакансия');
        const rReason = formatQueueReason(event.note || event.reason);
        sub = `Причина: ${rReason}`;
        metaBadge = '';
      } else if (event.action === 'error' || tagType === 'error') {
        tag = event.tag || 'ERROR';
        tagType = 'error';
        msg = event.msg || event.reason || event.error || 'Сбой выполнения запроса';
        sub = event.sub || 'Ошибка API: требуется подтверждение или проверка суточных лимитов';
        metaBadge = '';
      } else if (event.action === 'scan' || tagType === 'scan') {
        tag = 'SCAN';
        tagType = 'scan';
        msg = event.msg || `Поиск вакансий (страница ${event.page || 1})`;
        sub = event.sub || `Найдено элементов в выдаче: ${event.found || 20}`;
        metaBadge = `${event.found || 20} вак.`;
      } else if (event.action === 'delay' || tagType === 'delay') {
        tag = 'DELAY';
        tagType = 'delay';
        msg = event.msg || `Анти-спам задержка`;
        sub = event.sub || `Пауза безопасности перед следующим действием`;
        metaBadge = event.delay ? `${event.delay}s` : '1.6s';
      } else if (event.action === 'cover' || tagType === 'cover') {
        tag = 'COVER';
        tagType = 'cover';
        msg = event.msg || `Сопроводительное письмо`;
        sub = event.sub || `Сгенерировано письмо (${event.chars || 178} симв.)`;
        metaBadge = `${event.chars || 178} с.`;
      } else if (event.action === 'status' || tagType === 'status') {
        tag = 'STATUS';
        tagType = 'status';
        msg = event.msg || `Статус цикла: ${event.status || 'активен'}`;
        sub = event.sub || '';
        metaBadge = event.status ? String(event.status).toUpperCase() : 'OK';
      }

      const item = {
        id: logId,
        time,
        tag,
        tagType,
        msg,
        sub,
        employer: event.employer || '',
        metaBadge,
        vid: cVid,
        url,
        selector: event.selector || '',
        selectorName: event.selectorName || '',
        expectedCss: event.expectedCss || '',
        heuristic: event.heuristic || '',
        contextSnippet: event.contextSnippet || '',
        context: event,
        isDevLog: true
      };

      this._appendLogItem(item);
    }

    _appendLogItem(item) {
      if (!item) return;
      if (!this._liveFeed) this._liveFeed = [];

      // Avoid immediate consecutive duplicate log messages
      if (this._liveFeed.length > 0) {
        const prev = this._liveFeed[0];
        if (prev.msg === item.msg && prev.tag === item.tag && prev.vid === item.vid) {
          return;
        }
      }

      this._liveFeed.unshift(item);
      if (this._liveFeed.length > 2000) {
        this._liveFeed.length = 2000;
      }
      this._persistLogs();
      this._syncLogs();
    }

    _persistLogs() {
      if (this._persistLogsTimer) return;
      this._persistLogsTimer = setTimeout(() => {
        this._persistLogsTimer = null;
        try {
          if (this._liveFeed) {
            storage.localSet(KEYS.logHistory, JSON.stringify(this._liveFeed.slice(0, 2000)));
          }
        } catch (_) {}
      }, 250);
    }

    _onEngineLog(payload) {
      if (!payload) return;
      const isErr = payload.level === 'ERR';
      const code = payload.code || (isErr ? 'ERROR' : 'INFO');
      const time = formatTime(payload.timestamp || Date.now());
      const ctx = payload.context || {};
      const cVid = ctx.vid ? cleanVid(ctx.vid) : '';
      const url = ctx.url || (cVid ? toVacancyUrl(cVid) : '');

      let tag = code;
      let tagType = isErr ? 'error' : 'status';
      if (/SCROLL|READING|VIEW|SCAN/i.test(code)) tagType = 'scan';
      else if (/APPLY|COVER|CONFIRM|SCENARIO/i.test(code)) tagType = 'apply';
      else if (/FILTER|SKIP|ALREADY/i.test(code)) tagType = 'filter';

      let sub = '';
      if (typeof ctx === 'string') {
        sub = ctx;
      } else if (ctx && typeof ctx === 'object') {
        const parts = [];
        if (ctx.targetY !== undefined) parts.push(`Цель: ${ctx.targetY}px (${ctx.pct ? ctx.pct + '%' : ''})`);
        if (ctx.step !== undefined) parts.push(`Шаг: ${ctx.step}/${ctx.steps}`);
        if (ctx.pauseMs !== undefined) parts.push(`Пауза: ${(ctx.pauseMs / 1000).toFixed(1)}с`);
        if (ctx.total !== undefined) parts.push(`Всего кнопок: ${ctx.total}`);
        if (ctx.pending !== undefined) parts.push(`К обработке: ${ctx.pending}`);
        if (ctx.outcome !== undefined) parts.push(`Исход: ${ctx.outcome}`);
        if (ctx.result !== undefined) parts.push(`Результат: ${ctx.result}`);
        if (ctx.reason !== undefined) parts.push(`Причина: ${ctx.reason}`);
        if (ctx.selector !== undefined) parts.push(`Селектор: ${ctx.selector}`);
        if (ctx.qa !== undefined) parts.push(`data-qa: ${ctx.qa}`);
        if (ctx.tag !== undefined) parts.push(`<${ctx.tag}>`);
        if (ctx.text !== undefined) parts.push(`«${ctx.text}»`);
        if (ctx.optionsCount !== undefined) parts.push(`Вариантов: ${ctx.optionsCount}`);
        if (ctx.cardsCount !== undefined) parts.push(`Карточек: ${ctx.cardsCount}`);
        if (ctx.elapsedMs !== undefined) parts.push(`Прошло: ${(ctx.elapsedMs / 1000).toFixed(1)}с${ctx.timeoutMs ? ` / ${(ctx.timeoutMs / 1000).toFixed(1)}с` : ''}`);
        if (ctx.visibleModalsCount !== undefined) parts.push(`Модалок: ${ctx.visibleModalsCount}`);
        if (ctx.href && ctx.href !== url) parts.push(`href: ${ctx.href}`);
        if (ctx.error !== undefined) parts.push(`Ошибка: ${ctx.error}`);
        sub = parts.join(' • ');
      }

      const item = {
        id: 'log_' + (++this._logCounter || (this._logCounter = 1)) + '_' + Date.now(),
        time,
        tag,
        tagType,
        msg: String(payload.message || ''),
        sub,
        vid: cVid,
        url,
        selector: ctx.selector || '',
        selectorName: ctx.selectorName || '',
        expectedCss: ctx.expectedCss || '',
        heuristic: ctx.heuristic || '',
        contextSnippet: ctx.snippet || ctx.contextSnippet || '',
        context: ctx,
        isDevLog: true
      };

      this._appendLogItem(item);
    }

    updateQueue(queue) {
      if (queue && Array.isArray(queue.queue)) queue = queue.queue;
      this._queue = Array.isArray(queue) ? queue : [];
      this._syncLogs();
    }

    updateConfig(config) {
      if (!config) return;
      if (config.dailyLimit !== undefined && config.limit === undefined) {
        config.limit = config.dailyLimit;
      }
      if (config.limit !== undefined) {
        config.limit = Math.max(1, Math.min(200, parseInt(config.limit, 10) || 50));
      }
      if (typeof config.coverText === 'string' && config.coverText.length > 5000) {
        config.coverText = config.coverText.slice(0, 5000);
      }
      this._config = { ...this._config, ...config };
      const nextLimit = typeof this._config.limit === 'number' ? this._config.limit : this._config.dailyLimit;
      if (nextLimit !== undefined) {
        this.updateProgress(this._progress ? this._progress.sent : 0, nextLimit);
      }
      this._syncConfig();
    }

    setTargetLimit(newVal) {
      const parsed = parseInt(newVal, 10);
      const val = isNaN(parsed) ? 50 : Math.max(1, Math.min(200, parsed));
      this._config.limit = val;
      if (this._progress) {
        this._progress.limit = val;
      }
      if (this._assistant) {
        if (this._assistant.state) {
          this._assistant.state.targetLimit = val;
          if (this._assistant.state.limit !== undefined) {
            this._assistant.state.limit = val;
          }
        }
        if (typeof this._assistant.setConfig === 'function') {
          this._assistant.setConfig({ limit: val });
        }
      }
      if (this._shadow) {
        const input = this._shadow.querySelector('[data-el="setting-limit"]');
        if (input) input.value = val;
        const limitEl = this._shadow.querySelector('.hha-pill-limit-val') || this._shadow.querySelector('[data-el="pill-limit-val"]');
        if (limitEl) {
          limitEl.textContent = String(val);
        }
      }
      this.updateProgress(this._progress ? this._progress.sent : 0, val);
      return val;
    }

    toggleExpand(force) {
      const next = typeof force === 'boolean' ? force : !this._isExpanded;
      if (this._isExpanded === next) return;
      this._isExpanded = next;
      this._isAnimating = true;

      this._hideTooltip();

      if (this._shadow) {
        const flyout = this._shadow.querySelector('.hha-flyout');
        const root = this._shadow.querySelector('[data-el="root"]') || this._shadow.querySelector('.hha-root');
        const statusGroup = this._shadow.querySelector('[data-el="pill-status-group"]');
        if (statusGroup) {
          statusGroup.setAttribute('aria-expanded', String(this._isExpanded));
          statusGroup.setAttribute('aria-label', this._isExpanded ? 'Свернуть панель управления' : 'Открыть настройки и журнал');
        }
        if (root) {
          root.classList.toggle('is-expanded', this._isExpanded);
          root.classList.add('is-animating');
        }
        if (flyout) {
          flyout.classList.add('is-animating');
        }
        this._updatePosition();

        if (this._animTimer) clearTimeout(this._animTimer);
        this._animTimer = setTimeout(() => {
          this._isAnimating = false;
          if (root) root.classList.remove('is-animating');
          if (flyout) flyout.classList.remove('is-animating');
          this._animTimer = null;
          if (this._isExpanded && this._activeTab === 'logs') {
            this._updateOverlayScrollbar();
          }
          if (!this._isExpanded && this._shadow) {
            const pill = this._shadow.querySelector('[data-el="pill"]');
            if (pill && typeof pill.offsetWidth === 'number' && pill.offsetWidth > 0 && pill.offsetWidth < 300) {
              this._collapsedPillWidth = pill.offsetWidth;
            }
            this._updatePosition();
          }
        }, 190);
      } else {
        this._isAnimating = false;
      }
    }

    open() {
      return this.toggleExpand(true);
    }

    close() {
      return this.toggleExpand(false);
    }

    setActiveTab(tabName) {
      if (tabName === 'feed') {
        tabName = 'logs';
      }
      if (!['settings', 'queue', 'logs'].includes(tabName)) return;
      this._activeTab = tabName;
      this._hideTooltip();

      if (!this._shadow) return;
      const tabs = this._shadow.querySelectorAll('.hha-tab-btn');
      tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));

      const panels = this._shadow.querySelectorAll('.hha-panel');
      panels.forEach(p => p.classList.toggle('active', p.dataset.panel === tabName));

      this._syncLogActions();
      requestAnimationFrame(() => this._updateOverlayScrollbar());
    }

    _syncLogActions() {
      if (!this._shadow) return;
      const count = this._queue ? this._queue.length : 0;

      // Clear queue button
      const clearBtn = this._shadow.querySelector('[data-action="clear-queue"]') || this._shadow.querySelector('[data-el="clear-queue-btn"]');
      if (clearBtn) {
        if (count > 0) {
          clearBtn.removeAttribute('disabled');
          clearBtn.disabled = false;
          clearBtn.style.display = 'inline-flex';
        } else {
          clearBtn.setAttribute('disabled', '');
          clearBtn.disabled = true;
          clearBtn.style.display = 'none';
        }
      }

      // Clear logs and Copy buttons
      const clearLogsBtn = this._shadow.querySelector('[data-action="clear-logs"]') || this._shadow.querySelector('[data-el="clear-logs-btn"]');
      const hasLogs = Boolean(this._liveFeed && this._liveFeed.length > 0);
      if (clearLogsBtn) {
        clearLogsBtn.style.opacity = hasLogs ? '1' : '0.4';
        clearLogsBtn.style.pointerEvents = hasLogs ? 'auto' : 'none';
      }

      // Log header title with rolling count
      const logHeaderTitle = this._shadow.querySelector('[data-el="log-header-title"]') || this._shadow.querySelector('[data-panel="logs"] .hha-log-header-title');
      if (logHeaderTitle) {
        const logCount = this._liveFeed ? this._liveFeed.length : 0;
        logHeaderTitle.textContent = logCount > 0 ? `События и отклики (${logCount} / 2000)` : 'События и отклики';
      }
    }

    _toggleLogDetail(logId, rowEl) {
      if (!logId) return;
      if (this._expandedLogIds.has(logId)) {
        this._expandedLogIds.delete(logId);
        if (rowEl) rowEl.classList.remove('is-expanded');
      } else {
        if (this._shadow) {
          this._shadow.querySelectorAll('.hha-log-dev-row.is-expanded').forEach(r => {
            r.classList.remove('is-expanded');
          });
        }
        this._expandedLogIds.clear();
        this._expandedLogIds.add(logId);
        if (rowEl) rowEl.classList.add('is-expanded');
      }
      this._updateOverlayScrollbar();
    }

    getPosition() {
      return { ...this._pillPos };
    }

    setPosition(x, y) {
      const winW = (typeof window !== 'undefined' && window.innerWidth) || 1024;
      const winH = (typeof window !== 'undefined' && window.innerHeight) || 768;
      this._pillPos = this._clampPillCoordinates(x, y, winW, winH);
      this._persistPosition();
      this._updatePosition();
    }

    _getPillWidth() {
      if (!this._isExpanded && !this._isAnimating && this._shadow) {
        const pill = this._shadow.querySelector('[data-el="pill"]');
        if (pill && typeof pill.offsetWidth === 'number' && pill.offsetWidth > 0 && pill.offsetWidth < 300) {
          this._collapsedPillWidth = pill.offsetWidth;
          return pill.offsetWidth;
        }
      }
      return this._collapsedPillWidth || 166;
    }

    _clampPillCoordinates(x, y, winW, winH) {
      const pillW = this._getPillWidth();
      const targetW = Math.min(390, Math.max(100, winW - 16));
      const maxW = Math.max(targetW, pillW);
      const offset = (maxW - pillW) / 2;
      const clamped = clampCoordinates(x - offset, y, maxW, 36, winW, winH, 8);
      return {
        x: Math.round(clamped.x + offset),
        y: clamped.y
      };
    }

    // --- DOM Assembly ---

    _render() {
      this._shadow.innerHTML = `
        <style>${STYLES}</style>
        <div class="hha-root" data-el="root">
          <div class="hha-pill" data-el="pill">
            <div class="hha-pill-status-group" data-action="toggle-expand" data-el="pill-status-group" tabindex="0" role="button" aria-expanded="false" aria-label="Открыть настройки и журнал">
              <div class="hha-pill-progress-fill" data-el="pill-progress-fill"></div>
              <div class="hha-pill-status">
                <span class="hha-pill-progress" data-el="pill-progress"><span class="hha-current-count" data-el="pill-current-count">0</span> / <span class="hha-pill-limit-val" data-el="pill-limit-val">50</span></span>
              </div>
            </div>
            <span class="hha-pill-queue-badge" data-action="open-queue-tab" data-el="pill-queue-badge" data-tooltip="Вакансии с анкетами в очереди" tabindex="0" role="button" aria-label="Очередь вакансий"></span>
            <button type="button" class="hha-btn-quick hha-btn-start" data-action="quick-toggle" data-el="pill-quick-btn">
              ${ICONS.play}
              <span data-el="pill-quick-label">Старт</span>
            </button>
          </div>

          <!-- Flyout Overlay (390px wide, max 420px height) -->
          <div class="hha-flyout" data-el="flyout">
            <!-- Floating Tooltip -->
            <div class="hha-tooltip" data-el="tooltip"></div>

            <!-- Segmented Control Tabs (3 columns) -->
            <div class="hha-tabs">
              <button type="button" class="hha-tab-btn active" data-action="switch-tab" data-tab="settings">Настройки</button>
              <button type="button" class="hha-tab-btn" data-action="switch-tab" data-tab="queue"><span>Очередь</span> <span class="hha-tab-badge is-queue" data-el="queue-tab-count" style="display: none;">0</span></button>
              <button type="button" class="hha-tab-btn" data-action="switch-tab" data-tab="logs"><span>Логи</span><span class="hha-tab-badge is-error" data-el="log-error-badge" style="display: none;">0</span></button>
            </div>

            <!-- Panels -->
            <div class="hha-panels">
              <!-- Tab 1: Settings (Настройки) -->
              <div class="hha-panel active" data-panel="settings">
                <div class="hha-card">
                  <div class="hha-row">
                    <span class="hha-row-label">Лимит откликов</span>
                    <div class="hha-stepper">
                      <button type="button" class="hha-stepper-btn" data-action="step-limit" data-step="-5" aria-label="Уменьшить лимит">−</button>
                      <input type="number" class="hha-stepper-input" data-el="setting-limit" min="1" max="200" step="5" value="50">
                      <button type="button" class="hha-stepper-btn" data-action="step-limit" data-step="5" aria-label="Увеличить лимит">+</button>
                    </div>
                  </div>
                  <div class="hha-speed-row">
                    <span class="hha-row-label">Скорость</span>
                    <div class="hha-segmented-control">
                      <button type="button" class="hha-segmented-btn" data-action="set-preset" data-preset="safe" data-tooltip="Безопасно: интервал 4–8 с">Безопасно</button>
                      <button type="button" class="hha-segmented-btn is-active" data-action="set-preset" data-preset="balanced" data-tooltip="Баланс: интервал 2–5 с">Баланс</button>
                      <button type="button" class="hha-segmented-btn" data-action="set-preset" data-preset="fast" data-tooltip="Быстро: интервал 1.5–3 с">Быстро</button>
                    </div>
                  </div>
                </div>

                <div class="hha-card hha-card-cover">
                  <div class="hha-switch-row">
                    <label class="hha-switch-label" for="hha-use-cover-input">
                      <span class="hha-row-label">Отправлять сопроводительное письмо</span>
                      <span class="hha-switch">
                        <input type="checkbox" id="hha-use-cover-input" class="hha-switch-input" data-el="setting-use-cover" checked>
                        <span class="hha-switch-slider"></span>
                      </span>
                    </label>
                  </div>
                  <div class="hha-cover-container" data-el="setting-cover-container">
                    <textarea class="hha-cover-textarea" data-el="setting-cover-text" maxlength="5000" placeholder="Текст сопроводительного письма..."></textarea>
                    <div class="hha-char-counter" data-el="setting-cover-counter">0 / 5000</div>
                  </div>
                </div>
              </div>

              <!-- Tab 2: Queue (Очередь) -->
              <div class="hha-panel" data-panel="queue">
                <div class="hha-log-card">
                  <div class="hha-log-header">
                    <span class="hha-log-header-title" data-el="queue-status-text">Очередь откликов</span>
                    <div class="hha-log-actions">
                      <button type="button" class="hha-btn-icon hha-btn-ghost hha-btn-clear-queue" data-action="clear-queue" data-el="clear-queue-btn" data-tooltip="Очистить очередь" disabled style="display: none;">${ICONS.trash}</button>
                    </div>
                  </div>
                  <div class="hha-log-stream" data-el="queue-stream">
                    <div class="hha-log-empty">
                      <div class="hha-log-empty-icon">${ICONS.inboxEmpty}</div>
                      <div class="hha-log-empty-text">Очередь пуста</div>
                    </div>
                  </div>
                  <div class="hha-overlay-scrollbar" data-el="queue-scrollbar">
                    <div class="hha-overlay-thumb" data-el="queue-scroll-thumb"></div>
                  </div>
                </div>
              </div>

              <!-- Tab 3: Logs (Журнал) -->
              <div class="hha-panel" data-panel="logs">
                <div class="hha-log-card">
                  <div class="hha-log-header">
                    <span class="hha-log-header-title" data-el="log-header-title">События и отклики</span>
                    <div class="hha-log-actions">
                      <button type="button" class="hha-btn-icon hha-btn-ghost hha-btn-clear-logs" data-action="clear-logs" data-el="clear-logs-btn" data-tooltip="Очистить логи">${ICONS.reset}</button>
                      <button type="button" class="hha-btn-icon hha-btn-ghost hha-btn-copy-log" data-action="copy-logs" data-el="copy-logs-btn" data-tooltip="Скопировать логи">${ICONS.copy}</button>
                    </div>
                  </div>
                  <div class="hha-log-stream" data-el="log-stream">
                    <div class="hha-log-empty">
                      <div class="hha-log-empty-icon">${ICONS.inboxEmpty}</div>
                      <div class="hha-log-empty-text">Нет записей в логах</div>
                    </div>
                  </div>
                  <div class="hha-overlay-scrollbar" data-el="log-scrollbar">
                    <div class="hha-overlay-thumb" data-el="log-scroll-thumb"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    _bindDomEvents() {
      if (!this._shadow || this._domEventsBound) return;
      this._domEventsBound = true;

      const root = this._shadow.querySelector('[data-el="root"]');
      const pill = this._shadow.querySelector('[data-el="pill"]');
      if (!root || !pill) return;

      // Drag & Drop Pointer Events on Pill
      pill.addEventListener('pointerdown', (e) => this._onPointerDown(e, 'pill'));
      pill.addEventListener('pointermove', this._onPointerMove);
      pill.addEventListener('pointerup', this._onPointerUp);
      pill.addEventListener('pointercancel', this._onPointerUp);

      // Event delegation for clicks inside Shadow Root
      root.addEventListener('click', (e) => this._handleRootClick(e));

      // Floating Tooltip Event Delegation
      root.addEventListener('pointerover', (e) => {
        const target = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-tooltip]') : null;
        if (target && target.getAttribute('data-tooltip')) {
          this._showTooltip(target);
        }
      });

      root.addEventListener('pointerout', (e) => {
        const fromTarget = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-tooltip]') : null;
        const toTarget = e.relatedTarget && typeof e.relatedTarget.closest === 'function' ? e.relatedTarget.closest('[data-tooltip]') : null;
        if (fromTarget && fromTarget !== toTarget) {
          this._hideTooltip();
        }
      });

      root.addEventListener('scroll', () => {
        this._hideTooltip();
      }, { capture: true, passive: true });

      // Keyboard support for status group
      const statusGroup = this._shadow.querySelector('[data-el="pill-status-group"]');
      if (statusGroup) {
        statusGroup.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            e.stopPropagation();
            if (!this._isExpanded) this.setActiveTab('settings');
            this.toggleExpand();
          }
        });
      }

      // Keyboard support for pill queue badge
      const pillQueueBadge = this._shadow.querySelector('[data-el="pill-queue-badge"]');
      if (pillQueueBadge) {
        pillQueueBadge.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            e.stopPropagation();
            this.setActiveTab('queue');
            this.open();
          }
        });
      }

      // Settings Inputs
      const limitInput = this._shadow.querySelector('[data-el="setting-limit"]');
      if (limitInput) {
        const normalizeLimit = () => {
          limitInput.classList.remove('is-focused');
          const val = Math.max(1, Math.min(200, parseInt(limitInput.value, 10) || 50));
          limitInput.value = val;
          this.setTargetLimit(val);
        };
        limitInput.addEventListener('focus', () => limitInput.classList.add('is-focused'));
        limitInput.addEventListener('blur', normalizeLimit);
        limitInput.addEventListener('input', () => {
          const raw = parseInt(limitInput.value, 10);
          if (!isNaN(raw) && raw >= 1 && raw <= 200) {
            this.setTargetLimit(raw);
          }
        });
        limitInput.addEventListener('change', normalizeLimit);
      }

      const useCoverCb = this._shadow.querySelector('[data-el="setting-use-cover"]');
      const coverTextarea = this._shadow.querySelector('[data-el="setting-cover-text"]');
      const coverCounter = this._shadow.querySelector('[data-el="setting-cover-counter"]');

      if (useCoverCb) {
        useCoverCb.addEventListener('change', () => {
          const checked = useCoverCb.checked;
          if (coverTextarea) {
            coverTextarea.disabled = !checked;
            coverTextarea.classList.toggle('is-disabled', !checked);
          }
          this._applyConfig({ useCover: checked });
        });
      }

      if (coverTextarea) {
        const updateCharCounter = () => {
          const len = coverTextarea.value.length;
          if (coverCounter) {
            coverCounter.textContent = `${len} / 5000`;
            coverCounter.classList.toggle('is-limit', len >= 5000);
          }
        };
        const flushCoverText = () => {
          if (this._coverDebounceTimer) {
            clearTimeout(this._coverDebounceTimer);
            this._coverDebounceTimer = null;
          }
          updateCharCounter();
          this._applyConfig({ coverText: coverTextarea.value });
        };
        coverTextarea.addEventListener('input', () => {
          updateCharCounter();
          if (this._coverDebounceTimer) clearTimeout(this._coverDebounceTimer);
          this._coverDebounceTimer = setTimeout(flushCoverText, 300);
        });
        coverTextarea.addEventListener('blur', flushCoverText);
        coverTextarea.addEventListener('change', flushCoverText);
      }

      // Document click listener to close overlay when clicking outside
      this._onDocClick = (e) => {
        if (this._isExpanded && e) {
          const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
          if (!path.includes(this) && (!e.target || (typeof this.contains === 'function' && !this.contains(e.target)))) {
            this.toggleExpand(false);
          }
        }
      };
      if (typeof document !== 'undefined') {
        document.addEventListener('click', this._onDocClick);
      }

      this._initOverlayScrollbar();
    }

    _initOverlayScrollbar() {
      const attach = (streamSel, scrollbarSel, thumbSel) => {
        const stream = this._shadow.querySelector(streamSel);
        const scrollbar = this._shadow.querySelector(scrollbarSel);
        const thumb = this._shadow.querySelector(thumbSel);
        const logCard = stream ? stream.closest('.hha-log-card') : null;
        if (!stream || !logCard || !scrollbar || !thumb) return;

        let isHovered = false;
        let isDragging = false;
        let hideTimer = null;

        const scheduleHide = (delay = 800) => {
          if (hideTimer) clearTimeout(hideTimer);
          hideTimer = setTimeout(() => {
            if (!isHovered && !isDragging) {
              scrollbar.classList.remove('is-visible');
            }
          }, delay);
        };

        const showScrollbar = () => {
          if (stream.scrollHeight > stream.clientHeight + 1) {
            this._updateOverlayScrollbar();
            scrollbar.classList.add('is-visible');
          }
        };

        stream.addEventListener('scroll', () => {
          this._updateOverlayScrollbar();
          showScrollbar();
          if (!isHovered && !isDragging) {
            scheduleHide(800);
          }
        }, { passive: true });

        logCard.addEventListener('mouseenter', () => {
          isHovered = true;
          if (hideTimer) clearTimeout(hideTimer);
          showScrollbar();
        });

        logCard.addEventListener('mouseleave', () => {
          isHovered = false;
          if (!isDragging) {
            scheduleHide(300);
          }
        });

        // Pointer drag interaction on thumb
        let startY = 0;
        let startScrollTop = 0;

        const onPointerMove = (e) => {
          if (!isDragging) return;
          const deltaY = e.clientY - startY;
          const trackH = scrollbar.clientHeight;
          const scrollH = stream.scrollHeight;
          const clientH = stream.clientHeight;
          const thumbH = thumb.offsetHeight || 24;
          const maxThumbTop = trackH - thumbH;
          const maxScrollTop = scrollH - clientH;
          if (maxThumbTop > 0 && maxScrollTop > 0) {
            const scrollDelta = (deltaY / maxThumbTop) * maxScrollTop;
            stream.scrollTop = startScrollTop + scrollDelta;
          }
        };

        const onPointerUp = (e) => {
          if (!isDragging) return;
          isDragging = false;
          thumb.classList.remove('is-dragging');
          try { thumb.releasePointerCapture(e.pointerId); } catch (_) {}
          window.removeEventListener('pointermove', onPointerMove);
          window.removeEventListener('pointerup', onPointerUp);
          window.removeEventListener('pointercancel', onPointerUp);
          if (!isHovered) {
            scheduleHide(800);
          }
        };

        thumb.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          isDragging = true;
          startY = e.clientY;
          startScrollTop = stream.scrollTop;
          thumb.classList.add('is-dragging');
          scrollbar.classList.add('is-visible');
          try { thumb.setPointerCapture(e.pointerId); } catch (_) {}
          window.addEventListener('pointermove', onPointerMove);
          window.addEventListener('pointerup', onPointerUp);
          window.addEventListener('pointercancel', onPointerUp);
        });

        // Click on scrollbar track to jump
        scrollbar.addEventListener('pointerdown', (e) => {
          if (e.target === thumb) return;
          e.preventDefault();
          const rect = scrollbar.getBoundingClientRect();
          const clickY = e.clientY - rect.top;
          const trackH = scrollbar.clientHeight;
          const scrollH = stream.scrollHeight;
          const clientH = stream.clientHeight;
          const thumbH = thumb.offsetHeight || 24;
          const targetThumbTop = Math.max(0, Math.min(trackH - thumbH, clickY - thumbH / 2));
          const maxThumbTop = trackH - thumbH;
          const maxScrollTop = scrollH - clientH;
          if (maxThumbTop > 0) {
            stream.scrollTop = (targetThumbTop / maxThumbTop) * maxScrollTop;
          }
        });
      };

      attach('[data-el="queue-stream"]', '[data-el="queue-scrollbar"]', '[data-el="queue-scroll-thumb"]');
      attach('[data-el="log-stream"]', '[data-el="log-scrollbar"]', '[data-el="log-scroll-thumb"]');
    }

    _updateOverlayScrollbar() {
      if (!this._shadow) return;
      const update = (streamSel, scrollbarSel, thumbSel) => {
        const stream = this._shadow.querySelector(streamSel);
        const scrollbar = this._shadow.querySelector(scrollbarSel);
        const thumb = this._shadow.querySelector(thumbSel);
        if (!stream || !scrollbar || !thumb) return;

        const scrollH = stream.scrollHeight;
        const clientH = stream.clientHeight;
        const trackH = scrollbar.clientHeight;

        if (scrollH <= clientH + 1 || trackH <= 0) {
          scrollbar.classList.remove('is-visible');
          thumb.style.height = '0px';
          return;
        }

        const thumbH = Math.max(24, Math.round((clientH / scrollH) * trackH));
        const maxScrollTop = scrollH - clientH;
        const maxThumbTop = trackH - thumbH;
        const thumbTop = maxScrollTop > 0 ? Math.round((stream.scrollTop / maxScrollTop) * maxThumbTop) : 0;

        thumb.style.height = `${thumbH}px`;
        thumb.style.transform = `translateY(${thumbTop}px)`;
      };

      update('[data-el="queue-stream"]', '[data-el="queue-scrollbar"]', '[data-el="queue-scroll-thumb"]');
      update('[data-el="log-stream"]', '[data-el="log-scrollbar"]', '[data-el="log-scroll-thumb"]');
    }

    _handleRootClick(e) {
      if (this._justDragged) {
        e.stopPropagation();
        e.preventDefault();
        return;
      }

      this._hideTooltip();

      const pillTarget = e.target.closest('[data-el="pill"]');
      const isInteractive = e.target.closest('button, input, textarea, a, select') || (e.target.closest('[data-action]') && e.target.closest('[data-action]').dataset.action !== 'toggle-expand');
      const actionTarget = e.target.closest('[data-action]');

      // Click on pill free surface via event delegation
      if (pillTarget && !isInteractive && !actionTarget && !this._dragMoved) {
        this.toggleExpand();
        return;
      }

      if (!actionTarget) return;

      const action = actionTarget.dataset.action;

      if (action === 'quick-toggle') {
        e.stopPropagation();
        this._handleToggleAutomation();
      } else if (action === 'open-queue-tab') {
        e.stopPropagation();
        this.setActiveTab('queue');
        this.open();
      } else if (action === 'toggle-expand') {
        e.stopPropagation();
        this.toggleExpand();
      } else if (action === 'switch-tab') {
        e.stopPropagation();
        this.setActiveTab(actionTarget.dataset.tab);
      } else if (action === 'copy-logs') {
        e.stopPropagation();
        this._copyLogsToClipboard();
      } else if (action === 'toggle-log-detail') {
        e.stopPropagation();
        const logId = actionTarget.dataset.logId;
        this._toggleLogDetail(logId, actionTarget);
      } else if (action === 'copy-single-log') {
        e.stopPropagation();
        const logId = actionTarget.dataset.logId;
        this._copySingleLogToClipboard(logId, actionTarget);
      } else if (action === 'clear-logs') {
        e.stopPropagation();
        this._liveFeed = [];
        this._expandedLogIds.clear();
        if (this._persistLogsTimer) {
          clearTimeout(this._persistLogsTimer);
          this._persistLogsTimer = null;
        }
        storage.localRemove(KEYS.logHistory);
        this._syncLogs();
      } else if (action === 'clear-queue') {
        e.stopPropagation();
        if (actionTarget.disabled || (typeof actionTarget.hasAttribute === 'function' && actionTarget.hasAttribute('disabled')) || this._queue.length === 0) {
          return;
        }
        if (this._assistant && typeof this._assistant.clearManualQueue === 'function') {
          this._assistant.clearManualQueue();
        } else {
          this._queue = [];
          this._syncLogs();
        }
      } else if (action === 'delete-queue-item') {
        e.stopPropagation();
        const vid = actionTarget.dataset.vid || actionTarget.dataset.cleanVid;
        const cVid = cleanVid(actionTarget.dataset.cleanVid || vid);
        if (vid) {
          if (this._assistant && typeof this._assistant.removeManualItem === 'function') {
            this._assistant.removeManualItem(vid);
          } else {
            this._queue = this._queue.filter(it => cleanVid(it.vid) !== cVid);
            this._syncLogs();
          }
        }
      } else if (action === 'step-limit') {
        e.stopPropagation();
        const step = parseInt(actionTarget.dataset.step, 10) || 0;
        const input = this._shadow.querySelector('[data-el="setting-limit"]');
        const cur = parseInt(input ? input.value : this._config.limit, 10) || 50;
        const next = Math.max(1, Math.min(200, cur + step));
        if (input) input.value = next;
        this.setTargetLimit(next);
      } else if (action === 'set-preset') {
        e.stopPropagation();
        const preset = actionTarget.dataset.preset;
        if (['safe', 'balanced', 'fast'].includes(preset)) {
          this._applyConfig({ preset });
        }
      }
    }

    _fallbackCopyText(text) {
      if (typeof document === 'undefined') return false;
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '-9999px';
        ta.style.opacity = '0';
        ta.setAttribute('readonly', '');
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (_) {
        return false;
      }
    }

    _copyText(text) {
      if (!text) return Promise.resolve(false);
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          return navigator.clipboard.writeText(text).catch(() => this._fallbackCopyText(text));
        }
      } catch (_) {}
      return Promise.resolve(this._fallbackCopyText(text));
    }

    _formatLogItemForClipboard(item) {
      if (!item) return '';
      const time = String(item.time || '').startsWith('[') ? item.time : `[${item.time || formatTime()}]`;
      const tag = item.tag ? `[${item.tag}]` : '[EVENT]';
      const badge = item.metaBadge ? ` [${item.metaBadge}]` : '';
      const msg = item.msg || item.title || '';
      const ctx = item.context || {};

      const hasMultiLineDetails = Boolean(
        item.selector || item.expectedCss || item.heuristic || item.contextSnippet ||
        ctx.error || ctx.stack || (Array.isArray(ctx.modals) && ctx.modals.length > 0) ||
        (ctx.href && ctx.href !== item.url) || ctx.tag || ctx.qa || ctx.text || ctx.rect ||
        ctx.optionsCount !== undefined || ctx.cardsCount !== undefined ||
        ctx.elapsedMs !== undefined || ctx.visibleModalsCount !== undefined ||
        ctx.snippet || ctx.details || ctx.outcome !== undefined || ctx.result !== undefined || ctx.reason !== undefined
      );

      if (hasMultiLineDetails) {
        const parts = [`${time} ${tag}${badge} ${msg}`];
        if (item.url) parts.push(`  URL: ${item.url}`);
        if (item.vid) parts.push(`  ID вакансии: v_${item.vid}`);
        if (item.selector) parts.push(`  Селектор: ${item.selector}${item.selectorName ? ` (${item.selectorName})` : ''}`);
        if (ctx.qa && ctx.qa !== item.selector) parts.push(`  data-qa: ${ctx.qa}`);
        if (ctx.tag) parts.push(`  Элемент: <${ctx.tag}>`);
        if (ctx.text) parts.push(`  Текст: "${ctx.text}"`);
        if (ctx.class) parts.push(`  CSS-класс: ${ctx.class}`);
        if (ctx.rect && ctx.rect !== 'unknown') parts.push(`  Координаты: ${ctx.rect}`);
        if (ctx.disabled !== undefined) parts.push(`  Отключен (disabled): ${ctx.disabled}`);
        if (item.expectedCss) parts.push(`  Ожидался CSS: ${item.expectedCss}`);
        if (item.heuristic) parts.push(`  Эвристика: ${item.heuristic}`);
        if (item.employer) parts.push(`  Компания: ${item.employer}`);
        if (ctx.href && ctx.href !== item.url) parts.push(`  Ссылка (href): ${ctx.href}`);
        if (ctx.outcome !== undefined) parts.push(`  Исход: ${ctx.outcome}`);
        if (ctx.result !== undefined) parts.push(`  Результат: ${ctx.result}`);
        if (ctx.reason !== undefined) parts.push(`  Причина: ${ctx.reason}`);
        if (ctx.optionsCount !== undefined) parts.push(`  Вариантов резюме: ${ctx.optionsCount}`);
        if (ctx.cardsCount !== undefined) parts.push(`  Карточек резюме: ${ctx.cardsCount}`);
        if (ctx.elapsedMs !== undefined) parts.push(`  Время ожидания: ${(ctx.elapsedMs / 1000).toFixed(1)}с${ctx.timeoutMs ? ` из ${(ctx.timeoutMs / 1000).toFixed(1)}с` : ''}`);
        if (ctx.visibleModalsCount !== undefined) parts.push(`  Видимых модалок: ${ctx.visibleModalsCount}`);
        if (Array.isArray(ctx.modals) && ctx.modals.length > 0) {
          parts.push('  Обнаруженные модальные окна:');
          ctx.modals.forEach(m => parts.push(`    • ${m}`));
        }
        if (ctx.filename) parts.push(`  Файл: ${ctx.filename}${ctx.lineno ? `:${ctx.lineno}:${ctx.colno || 0}` : ''}`);
        if (ctx.error) parts.push(`  Ошибка: ${ctx.error}`);
        if (ctx.stack) {
          parts.push('  Стек вызовов:');
          const stackLines = String(ctx.stack).trim().split(/\r?\n/);
          stackLines.forEach(l => parts.push(`    ${l}`));
        }
        if (item.contextSnippet) {
          parts.push('  HTML родителя:');
          const snippetLines = String(item.contextSnippet).trim().split(/\r?\n/);
          snippetLines.forEach(l => parts.push(`    ${l}`));
        }
        return parts.join('\n');
      }

      const idPart = item.vid ? ` (v_${item.vid}${item.url ? ' / ' + item.url : ''})` : (item.url ? ` (${item.url})` : '');
      const sub = item.sub ? ` • ${item.sub}` : '';
      return `${time} ${tag} ${msg}${idPart}${sub}`;
    }

    _copySingleLogToClipboard(logId, btnEl) {
      if (!logId || !this._liveFeed) return;
      const item = this._liveFeed.find(l => l.id === logId);
      if (!item) return;
      const textToCopy = this._formatLogItemForClipboard(item);
      if (!textToCopy) return;

      this._copyText(textToCopy);

      if (btnEl) {
        const origHtml = btnEl.innerHTML;
        btnEl.classList.add('is-copied');
        btnEl.innerHTML = `${ICONS.check} <span>Скопировано</span>`;
        setTimeout(() => {
          btnEl.classList.remove('is-copied');
          btnEl.innerHTML = origHtml;
        }, 1500);
      }
    }

    _copyLogsToClipboard() {
      let textToCopy = '';
      const lines = [];

      if (this._activeTab === 'queue') {
        if (this._queue && this._queue.length > 0) {
          for (const item of this._queue) {
            const cVid = cleanVid(item.vid);
            const url = toVacancyUrl(cVid, item.url);
            const idUrl = cVid && url ? `${cVid} / ${url}` : (cVid || url || '');
            const suffix = idUrl ? ` (${idUrl})` : '';
            const time = item.time ? (String(item.time).startsWith('[') ? item.time : `[${item.time}]`) : `[${formatTime()}]`;
            const badge = 'В очередь';
            const title = item.title || 'Вакансия';
            lines.push(`${time} [${badge}] ${title}${suffix}`);
          }
          textToCopy = lines.join('\n');
        }
      } else {
        if (this._liveFeed && this._liveFeed.length > 0) {
          const formattedItems = this._liveFeed.map(item => this._formatLogItemForClipboard(item)).filter(Boolean);
          const hasMultiline = formattedItems.some(str => str.includes('\n'));
          textToCopy = hasMultiline ? formattedItems.join('\n\n') : formattedItems.join('\n');
        }
      }

      if (!textToCopy) {
        textToCopy = 'Нет недавних действий';
      }

      this._copyText(textToCopy);

      const copyBtn = this._shadow ? (this._shadow.querySelector('[data-action="copy-logs"]') || this._shadow.querySelector('[data-el="copy-logs-btn"]')) : null;
      if (copyBtn) {
        if (!this._copyBtnOrigHtml) {
          this._copyBtnOrigHtml = copyBtn.innerHTML;
          this._copyBtnOrigColor = copyBtn.style.color;
        }
        copyBtn.innerHTML = ICONS.check;
        copyBtn.style.color = '#15803d';
        if (this._copyFeedbackTimer) clearTimeout(this._copyFeedbackTimer);
        this._copyFeedbackTimer = setTimeout(() => {
          if (copyBtn) {
            copyBtn.innerHTML = this._copyBtnOrigHtml || ICONS.copy;
            copyBtn.style.color = this._copyBtnOrigColor || '';
          }
          this._copyBtnOrigHtml = null;
          this._copyBtnOrigColor = null;
          this._copyFeedbackTimer = null;
        }, 1500);
      }
      return textToCopy;
    }

    _handleToggleAutomation() {
      if (!this._assistant) return;
      const now = Date.now();
      if (this._lastToggleTime && (now - this._lastToggleTime) < 250) return;
      this._lastToggleTime = now;

      if (this._status.status === 'running') {
        if (typeof this._assistant.stop === 'function') this._assistant.stop();
      } else if (this._status.status === 'done') {
        const lim = this._progress ? this._progress.limit : ((this._config && this._config.limit) || 50);
        const sent = this._progress ? this._progress.sent : 0;
        if (sent < lim) {
          this.updateStatus('idle', 'IDLE');
          if (typeof this._assistant.start === 'function') this._assistant.start();
        } else {
          this.open();
          this.setActiveTab('settings');
        }
      } else if (this._status.status === 'error') {
        if (typeof this._assistant.resetState === 'function') {
          this._assistant.resetState();
        } else if (typeof this._assistant.setStatus === 'function') {
          this._assistant.setStatus('idle', 'IDLE');
        }
        this.updateStatus('idle', 'IDLE');
      } else {
        const lim = this._progress ? this._progress.limit : (this._config.limit || 50);
        const sent = this._progress ? this._progress.sent : 0;
        if (sent >= lim && lim > 0) {
          this.updateStatus('done', 'COMPLETED');
          return;
        }
        if (typeof this._assistant.start === 'function') this._assistant.start();
      }
    }

    _applyConfig(partial) {
      if (partial && partial.limit !== undefined) {
        partial.limit = Math.max(1, Math.min(200, parseInt(partial.limit, 10) || 50));
      }
      if (partial && typeof partial.coverText === 'string' && partial.coverText.length > 5000) {
        partial.coverText = partial.coverText.slice(0, 5000);
      }
      this._config = { ...this._config, ...partial };
      const nextLimit = typeof this._config.limit === 'number' ? this._config.limit : this._config.dailyLimit;
      if (nextLimit !== undefined) {
        this.updateProgress(this._progress ? this._progress.sent : 0, nextLimit);
      }
      if (this._assistant && typeof this._assistant.setConfig === 'function') {
        this._assistant.setConfig(partial);
      }
      this._syncConfig();
    }

    _showTooltip(target) {
      if (!this._shadow || !target || !this._isExpanded) return;
      const text = target.getAttribute('data-tooltip');
      if (!text) return;
      const tooltip = this._shadow.querySelector('[data-el="tooltip"]');
      const flyout = this._shadow.querySelector('[data-el="flyout"]');
      if (!tooltip || !flyout) return;

      tooltip.textContent = text;
      tooltip.classList.add('is-visible');

      const flyoutRect = flyout.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const tipW = tooltip.offsetWidth;
      const tipH = tooltip.offsetHeight;

      const targetCenterX = (targetRect.left + targetRect.width / 2) - flyoutRect.left;
      const minX = 8;
      const maxX = Math.max(minX, flyoutRect.width - tipW - 8);
      const x = clamp(targetCenterX - tipW / 2, minX, maxX);

      const spaceAbove = targetRect.top - flyoutRect.top;
      let y;
      if (spaceAbove >= tipH + 8) {
        y = (targetRect.top - flyoutRect.top) - tipH - 5;
      } else {
        y = (targetRect.bottom - flyoutRect.top) + 5;
      }
      const maxY = Math.max(8, flyoutRect.height - tipH - 8);
      y = clamp(y, 8, maxY);

      tooltip.style.left = `${Math.round(x)}px`;
      tooltip.style.top = `${Math.round(y)}px`;
    }

    _hideTooltip() {
      if (!this._shadow) return;
      const tooltip = this._shadow.querySelector('[data-el="tooltip"]');
      if (tooltip) {
        tooltip.classList.remove('is-visible');
      }
    }

    // --- Drag & Drop with Pointer Capture API ---

    _onPointerDown(e, handleType) {
      if (e.target && typeof e.target.closest === 'function') {
        if (e.target.closest('button, input, textarea, a, select, .hha-pill-queue-badge')) {
          return; // Let interactive controls handle their own events
        }
      }

      if (this._isPointerDown) return;

      const root = this._shadow ? (this._shadow.querySelector('[data-el="root"]') || this._shadow.querySelector('.hha-root')) : null;
      if (root) {
        root.classList.add('is-dragging');
      }

      this._dragOpenDirection = root ? root.classList.contains('dir-up') : null;

      const target = e.currentTarget;
      this._isPointerDown = true;
      this._dragMoved = false;
      this._pointerId = e.pointerId;
      this._dragHandleType = handleType;
      this._dragTarget = target;
      this._dragStartPointer = { x: e.clientX, y: e.clientY };
      this._dragStartPillPos = { ...this._pillPos };

      if (typeof window !== 'undefined') {
        window.addEventListener('pointermove', this._onPointerMove, { capture: true });
        window.addEventListener('pointerup', this._onPointerUp, { capture: true });
        window.addEventListener('pointercancel', this._onPointerUp, { capture: true });
        window.addEventListener('blur', this._onPointerUp, { capture: true });
      }
      if (target && typeof target.addEventListener === 'function') {
        target.addEventListener('lostpointercapture', this._onPointerUp, { once: true });
      }

      try {
        if (typeof target.setPointerCapture === 'function') {
          target.setPointerCapture(e.pointerId);
        }
      } catch (_) {}
    }

    _onPointerMove(e) {
      if (!this._isPointerDown || (e.pointerId !== undefined && this._pointerId !== null && e.pointerId !== this._pointerId)) return;

      const dx = e.clientX - this._dragStartPointer.x;
      const dy = e.clientY - this._dragStartPointer.y;

      // Threshold check: 4-5px displacement (dx^2 + dy^2 >= 16)
      if (!this._dragMoved) {
        if ((dx * dx + dy * dy) >= 16) {
          this._dragMoved = true;
        }
      }

      if (this._dragMoved) {
        const rawX = this._dragStartPillPos.x + dx;
        const rawY = this._dragStartPillPos.y + dy;

        const winW = (typeof window !== 'undefined' && window.innerWidth) || 1024;
        const winH = (typeof window !== 'undefined' && window.innerHeight) || 768;

        this._pillPos = this._clampPillCoordinates(rawX, rawY, winW, winH);
        this._updatePosition();
      }
    }

    _onPointerUp(e) {
      if (!this._isPointerDown) return;
      if (e && e.pointerId !== undefined && this._pointerId !== null && e.pointerId !== this._pointerId) return;
      const target = this._dragTarget || (e ? e.currentTarget : null);
      if (typeof window !== 'undefined') {
        window.removeEventListener('pointermove', this._onPointerMove, { capture: true });
        window.removeEventListener('pointerup', this._onPointerUp, { capture: true });
        window.removeEventListener('pointercancel', this._onPointerUp, { capture: true });
        window.removeEventListener('blur', this._onPointerUp, { capture: true });
      }
      if (target && typeof target.removeEventListener === 'function') {
        target.removeEventListener('lostpointercapture', this._onPointerUp);
      }
      try {
        if (target && typeof target.releasePointerCapture === 'function' && e && e.pointerId !== undefined) {
          target.releasePointerCapture(e.pointerId);
        }
      } catch (_) {}

      const root = this._shadow ? (this._shadow.querySelector('[data-el="root"]') || this._shadow.querySelector('.hha-root')) : null;
      if (root) {
        root.classList.remove('is-dragging');
      }

      const wasDragging = this._dragMoved;
      this._isPointerDown = false;
      this._pointerId = null;
      this._dragHandleType = null;
      this._dragTarget = null;
      this._dragOpenDirection = null;

      if (wasDragging) {
        this._persistPosition();
        this._suppressNextClick();
      }
      this._updatePosition();
    }

    _suppressNextClick() {
      this._justDragged = true;
      const suppress = (ev) => {
        ev.stopPropagation();
        if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        this._justDragged = false;
        this._dragMoved = false;
      };
      if (this._shadow && typeof this._shadow.addEventListener === 'function') {
        this._shadow.addEventListener('click', suppress, { capture: true, once: true });
        setTimeout(() => {
          try { this._shadow.removeEventListener('click', suppress, { capture: true }); } catch (_) {}
          this._justDragged = false;
          this._dragMoved = false;
        }, 120);
      } else {
        setTimeout(() => {
          this._justDragged = false;
          this._dragMoved = false;
        }, 60);
      }
    }

    _onResize() {
      const winW = (typeof window !== 'undefined' && window.innerWidth) || 1024;
      const winH = (typeof window !== 'undefined' && window.innerHeight) || 768;
      this._pillPos = this._clampPillCoordinates(this._pillPos.x, this._pillPos.y, winW, winH);
      this._persistPosition();
      this._updatePosition();
    }

    _updatePosition() {
      if (!this._shadow) return;
      const root = this._shadow.querySelector('[data-el="root"]') || this._shadow.querySelector('.hha-root');
      if (!root) return;

      const winW = (typeof window !== 'undefined' && window.innerWidth) || 1024;
      const winH = (typeof window !== 'undefined' && window.innerHeight) || 768;
      const pillW = this._getPillWidth();

      // Determine open direction dynamically based on available screen space
      const flyoutH = 420;
      const spaceBelow = Math.max(0, winH - (this._pillPos.y + 36) - 8);
      const spaceAbove = Math.max(0, this._pillPos.y - 8);

      let opensUp = false;
      if (this._isPointerDown && this._dragOpenDirection !== null) {
        opensUp = this._dragOpenDirection;
      } else if (spaceBelow < flyoutH && spaceAbove >= flyoutH) {
        opensUp = true;
      } else if (spaceAbove < flyoutH && spaceBelow >= flyoutH) {
        opensUp = false;
      } else {
        opensUp = spaceAbove > spaceBelow;
      }

      root.classList.toggle('dir-up', opensUp);
      root.classList.toggle('is-expanded', this._isExpanded);

      // Strict center alignment positioning (Center Anchor)
      const padding = 8;
      const centerX = Math.round(this._pillPos.x + pillW / 2);
      const targetW = Math.min(390, Math.max(100, winW - padding * 2));
      const maxW = Math.max(targetW, pillW);
      const halfW = maxW / 2;
      const minX = padding + halfW;
      const maxX = Math.max(minX, winW - padding - halfW);
      const clampedCenterX = Math.round(clamp(centerX, minX, maxX));
      root.style.left = `${clampedCenterX}px`;
      root.style.right = 'auto';
      root.style.alignItems = 'center';
      if (typeof root.style.setProperty === 'function') {
        root.style.setProperty('--center-x', `${clampedCenterX}px`);
      }

      // Vertical positioning
      if (opensUp) {
        const bottomDist = Math.max(8, winH - (this._pillPos.y + 36));
        root.style.top = 'auto';
        root.style.bottom = `${bottomDist}px`;
      } else {
        root.style.top = `${this._pillPos.y}px`;
        root.style.bottom = 'auto';
      }

      // Lock flyout height dynamically to available screen space
      const flyout = this._shadow.querySelector('.hha-flyout');
      if (flyout) {
        const availSpace = Math.floor(opensUp ? spaceAbove : spaceBelow);
        const maxAvail = Math.max(100, Math.min(availSpace, winH - 44));
        const finalH = Math.min(420, maxAvail);
        flyout.style.maxHeight = `${finalH}px`;
        flyout.style.height = `${finalH}px`;
      }
    }

    _restorePosition() {
      const winW = (typeof window !== 'undefined' && window.innerWidth) || 1024;
      const winH = (typeof window !== 'undefined' && window.innerHeight) || 768;
      const pillW = this._getPillWidth();
      const targetW = Math.min(390, Math.max(100, winW - 16));
      const maxW = Math.max(targetW, pillW);

      // Default position: Bottom-Right with 24px margin
      const offset = (maxW - pillW) / 2;
      const defX = Math.max(8, winW - maxW - 24 + offset);
      const defY = Math.max(8, winH - 36 - 24);

      let pos = null;
      try {
        if (typeof localStorage !== 'undefined') {
          // Versioned storage key 'hha_hud_pos_v2' cleanly resets any legacy positions from when pill could be on top
          const raw = localStorage.getItem('hha_hud_pos_v2');
          if (raw) pos = JSON.parse(raw);
        }
      } catch (_) {}

      if (pos && typeof pos.x === 'number' && !isNaN(pos.x) && typeof pos.y === 'number' && !isNaN(pos.y)) {
        this._pillPos = this._clampPillCoordinates(pos.x, pos.y, winW, winH);
      } else {
        this._pillPos = this._clampPillCoordinates(defX, defY, winW, winH);
      }

      this._persistPosition();
      this._updatePosition();
    }

    _persistPosition() {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('hha_hud_pos_v2', JSON.stringify({ x: this._pillPos.x, y: this._pillPos.y }));
        }
      } catch (_) {}
    }

    // --- State Synchronizers ---

    _syncAll() {
      this._syncStatus();
      this._syncProgress();
      this._syncLogs();
      this._syncConfig();
      this._syncLogs();
    }

    _syncStatus() {
      if (!this._shadow) return;
      const { status = 'idle' } = this._status || {};
      const isRunning = status === 'running';

      // Pill Quick Button
      const quickBtn = this._shadow.querySelector('[data-el="pill-quick-btn"]');
      if (quickBtn) {
        if (isRunning) {
          quickBtn.className = 'hha-btn-quick hha-btn-stop';
          quickBtn.innerHTML = `${ICONS.stop} <span data-el="pill-quick-label">Стоп</span>`;
          quickBtn.title = 'Остановить автоматизацию';
        } else if (status === 'done') {
          quickBtn.className = 'hha-btn-quick hha-btn-done';
          quickBtn.innerHTML = `${ICONS.check} <span data-el="pill-quick-label">Готово</span>`;
          quickBtn.title = 'Лимит достигнут. Кликните для настройки';
        } else if (status === 'error') {
          quickBtn.className = 'hha-btn-quick hha-btn-error';
          quickBtn.innerHTML = `${ICONS.reset} <span data-el="pill-quick-label">Сброс</span>`;
          quickBtn.title = 'Ошибка. Кликните для перезапуска';
        } else {
          quickBtn.className = 'hha-btn-quick hha-btn-start';
          quickBtn.innerHTML = `${ICONS.play} <span data-el="pill-quick-label">Старт</span>`;
          quickBtn.title = 'Запустить автоматизацию';
        }
      }


    }

    _syncProgress() {
      if (!this._shadow) return;
      const { sent = 0, displayCurrent, limit = 50 } = this._progress || {};
      const limitCount = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
      const cur = displayCurrent !== undefined ? displayCurrent : Math.min(Math.max(0, sent), limitCount);
      const text = `${cur} / ${limitCount}`;

      const pillProg = this._shadow.querySelector('[data-el="pill-progress"]');
      const currentEl = this._shadow.querySelector('.hha-current-count') || this._shadow.querySelector('[data-el="pill-current-count"]');
      const limitEl = this._shadow.querySelector('.hha-pill-limit-val') || this._shadow.querySelector('[data-el="pill-limit-val"]');

      if (currentEl && limitEl) {
        currentEl.textContent = String(cur);
        limitEl.textContent = String(limitCount);
      } else if (pillProg) {
        pillProg.textContent = text;
      }

      const pillFill = this._shadow.querySelector('[data-el="pill-progress-fill"]');
      if (pillFill) {
        const percent = limitCount > 0 ? Math.min(100, Math.max(0, Math.round((cur / limitCount) * 100))) : 0;
        pillFill.style.width = `${percent}%`;
      }
    }



    _syncLogs() {
      if (!this._shadow) return;
      this._hideTooltip();
      const count = this._queue ? this._queue.length : 0;

      // Update contextual queue badge in pill with Dynamic Island spring animation
      const queueBadge = this._shadow.querySelector('[data-el="pill-queue-badge"]');
      if (queueBadge) {
        const prevCount = this._prevQueueBadgeCount !== undefined ? this._prevQueueBadgeCount : 0;
        this._prevQueueBadgeCount = count;

        if (count > 0) {
          if (this._badgeClearTimer) {
            clearTimeout(this._badgeClearTimer);
            this._badgeClearTimer = null;
          }
          const countChanged = prevCount > 0 && prevCount !== count;
          queueBadge.textContent = String(count);
          queueBadge.classList.toggle('is-wide', count >= 10);
          queueBadge.style.display = '';
          const wasVisible = queueBadge.classList.contains('is-visible');
          queueBadge.classList.add('is-visible');

          if (countChanged && wasVisible) {
            queueBadge.classList.remove('is-popping');
            void queueBadge.offsetWidth; // force reflow
            queueBadge.classList.add('is-popping');
          }
        } else {
          queueBadge.style.display = '';
          queueBadge.classList.remove('is-visible', 'is-popping', 'is-wide');
          if (this._badgeClearTimer) clearTimeout(this._badgeClearTimer);
          this._badgeClearTimer = setTimeout(() => {
            if (this._queue && this._queue.length === 0 && queueBadge) {
              queueBadge.textContent = '';
            }
          }, 300);
        }

        // Refresh pill width cache after animation settles
        if (this._badgeAnimTimer) clearTimeout(this._badgeAnimTimer);
        this._badgeAnimTimer = setTimeout(() => {
          if (!this._isExpanded && this._shadow) {
            const pill = this._shadow.querySelector('[data-el="pill"]');
            if (pill && typeof pill.offsetWidth === 'number' && pill.offsetWidth > 0 && pill.offsetWidth < 300) {
              this._collapsedPillWidth = pill.offsetWidth;
            }
          }
        }, 300);
      }

      // Update queue count badge in tabs
      const queueTabCount = this._shadow.querySelector('[data-el="queue-tab-count"]');
      if (queueTabCount) {
        if (count > 0) {
          queueTabCount.textContent = String(count);
          queueTabCount.style.display = 'inline-flex';
        } else {
          queueTabCount.textContent = '';
          queueTabCount.style.display = 'none';
        }
      }

      // Update queue status text in queue list header
      const queueStatusText = this._shadow.querySelector('[data-el="queue-status-text"]');
      if (queueStatusText) {
        queueStatusText.textContent = count > 0 ? `Вакансий в очереди: ${count}` : 'Очередь откликов';
      }

      // Update error badge on Journal tab button
      let countError = 0;
      if (this._liveFeed && this._liveFeed.length > 0) {
        for (const it of this._liveFeed) {
          if (it.category === 'error' || it.tagType === 'error') countError++;
        }
      }
      const errBadge = this._shadow.querySelector('[data-el="log-error-badge"]');
      if (errBadge) {
        if (countError > 0) {
          errBadge.textContent = String(countError);
          errBadge.style.display = 'inline-flex';
        } else {
          errBadge.style.display = 'none';
        }
      }

      // Sync action buttons visibility
      this._syncLogActions();

      // Render Queue Stream
      const queueStream = this._shadow.querySelector('[data-el="queue-stream"]');
      if (queueStream) {
        if (this._queue && this._queue.length > 0) {
          queueStream.innerHTML = this._queue.map(item => {
            const rawVid = item.vid ? String(item.vid) : '';
            const cVid = cleanVid(rawVid);
            const targetUrl = toVacancyUrl(cVid, item.url);

            return `
              <div class="hha-log-item">
                <div class="hha-log-item-left">
                  <a href="${escapeHtml(targetUrl || '#')}" target="_blank" rel="noopener noreferrer" class="hha-queue-title-link" data-tooltip="${escapeHtml(item.title || 'Вакансия')}" onclick="event.stopPropagation();">
                    <span class="hha-queue-title-text">${escapeHtml(item.title || 'Вакансия')}</span>
                  </a>
                </div>
                <div class="hha-log-item-right">
                  <button type="button" class="hha-log-item-delete" data-action="delete-queue-item" data-vid="${escapeHtml(rawVid || cVid)}" data-clean-vid="${escapeHtml(cVid)}" data-tooltip="Удалить из очереди" aria-label="Удалить">${ICONS.trash}</button>
                </div>
              </div>
            `;
          }).join('');
        } else {
          queueStream.innerHTML = `
            <div class="hha-log-empty">
              <div class="hha-log-empty-icon">${ICONS.inboxEmpty}</div>
              <div class="hha-log-empty-text">Очередь пуста</div>
            </div>
          `;
        }
      }

      // Render Logs Stream
      const logStream = this._shadow.querySelector('[data-el="log-stream"]');
      if (logStream) {
        if (this._liveFeed && this._liveFeed.length > 0) {
          const itemsToRender = this._liveFeed.slice(0, 150);
          const html = itemsToRender.map(item => {
            const isExpanded = this._expandedLogIds && this._expandedLogIds.has(item.id);
            const cleanSub = item.sub ? item.sub.replace(/^Причина:\s*Причина:\s*/i, 'Причина: ') : '';
            return `
              <div class="hha-log-dev-row ${isExpanded ? 'is-expanded' : ''}" data-action="toggle-log-detail" data-log-id="${escapeHtml(item.id)}">
                <div class="hha-log-dev-main">
                  <span class="hha-log-dev-time">${escapeHtml(item.time)}</span>
                  <span class="hha-log-dev-tag tag-${escapeHtml(item.tagType)}">[${escapeHtml(item.tag)}]</span>
                  <span class="hha-log-dev-msg" title="${escapeHtml(item.msg)}">${escapeHtml(item.msg)}</span>
                  <span class="hha-log-dev-arrow">▾</span>
                </div>
                <div class="hha-log-dev-details">
                  <div class="hha-log-detail-grid">
                    ${item.selector ? `
                      <div class="hha-log-detail-key">Селектор:</div>
                      <div class="hha-log-detail-val"><code>${escapeHtml(item.selector)}</code> ${item.selectorName ? `<span class="hha-log-detail-note">(${escapeHtml(item.selectorName)})</span>` : ''}</div>
                    ` : ''}
                    ${item.expectedCss ? `
                      <div class="hha-log-detail-block">
                        <div class="hha-log-detail-block-title">Ожидался CSS:</div>
                        <code class="hha-code-highlight">${escapeHtml(item.expectedCss)}</code>
                      </div>
                    ` : ''}
                    ${item.heuristic ? `
                      <div class="hha-log-detail-block">
                        <div class="hha-log-detail-block-title">Эвристика:</div>
                        <code class="hha-code-heuristic">${escapeHtml(item.heuristic)}</code>
                      </div>
                    ` : ''}
                    ${item.contextSnippet ? `
                      <div class="hha-log-detail-block">
                        <div class="hha-log-detail-block-title">HTML родителя:</div>
                        <pre class="hha-dom-snippet">${escapeHtml(item.contextSnippet)}</pre>
                      </div>
                    ` : ''}
                    ${item.vid ? `
                      <div class="hha-log-detail-key">Вакансия:</div>
                      <div class="hha-log-detail-val">
                        <code>v_${escapeHtml(item.vid)}</code>
                        ${item.url ? `
                          <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="hha-log-detail-link" onclick="event.stopPropagation();" title="Открыть вакансию в новой вкладке">
                            ${ICONS.open} <span>Открыть на hh.ru</span>
                          </a>
                        ` : ''}
                      </div>
                    ` : (item.url ? `
                      <div class="hha-log-detail-key">URL:</div>
                      <div class="hha-log-detail-val">
                        <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="hha-log-detail-url" onclick="event.stopPropagation();">${escapeHtml(item.url)}</a>
                      </div>
                    ` : '')}
                    ${item.employer ? `
                      <div class="hha-log-detail-key">Компания:</div>
                      <div class="hha-log-detail-val">${escapeHtml(item.employer)}</div>
                    ` : ''}
                    ${cleanSub ? `
                      <div class="hha-log-detail-key">${cleanSub.startsWith('Причина:') ? 'Причина:' : 'Инфо:'}</div>
                      <div class="hha-log-detail-val">${escapeHtml(cleanSub.replace(/^Причина:\s*/i, ''))}</div>
                    ` : ''}
                  </div>
                  <div class="hha-log-detail-footer">
                    <button type="button" class="hha-btn-copy-item" data-action="copy-single-log" data-log-id="${escapeHtml(item.id)}">
                      ${ICONS.copy} <span>Скопировать детали</span>
                    </button>
                  </div>
                </div>
              </div>
            `;
          }).join('');
          const footerNote = this._liveFeed.length > 150
            ? `<div class="hha-log-footer-note" style="padding: 10px 14px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px dashed rgba(226, 232, 240, 0.6);">Показаны последние 150 из ${this._liveFeed.length} записей.<br>Кнопка «Скопировать» экспортирует всю историю (${this._liveFeed.length}).</div>`
            : '';
          logStream.innerHTML = html + footerNote;
        } else {
          logStream.innerHTML = `
            <div class="hha-log-empty">
              <div class="hha-log-empty-icon">${ICONS.inboxEmpty}</div>
              <div class="hha-log-empty-text">Нет записей в логах</div>
            </div>
          `;
        }
      }

      this._updateOverlayScrollbar();
    }



    _syncConfig() {
      if (!this._shadow) return;
      const c = this._config || {};

      // Limit
      const limitInput = this._shadow.querySelector('[data-el="setting-limit"]');
      const lim = typeof c.limit === 'number' ? c.limit : c.dailyLimit;
      if (limitInput && lim !== undefined && limitInput.value !== String(lim)) {
        limitInput.value = lim;
      }
      const limitEl = this._shadow.querySelector('.hha-pill-limit-val') || this._shadow.querySelector('[data-el="pill-limit-val"]');
      if (limitEl && lim !== undefined) {
        limitEl.textContent = String(lim);
      }

      // Preset Segmented Buttons
      const presetBtns = this._shadow.querySelectorAll('[data-action="set-preset"]');
      presetBtns.forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.preset === c.preset);
      });

      // Cover Letter
      const useCoverCb = this._shadow.querySelector('[data-el="setting-use-cover"]');
      const coverTextarea = this._shadow.querySelector('[data-el="setting-cover-text"]');
      const coverCounter = this._shadow.querySelector('[data-el="setting-cover-counter"]');

      const isCoverActive = Boolean(c.useCover);
      if (useCoverCb) useCoverCb.checked = isCoverActive;
      if (coverTextarea) {
        coverTextarea.disabled = !isCoverActive;
        coverTextarea.classList.toggle('is-disabled', !isCoverActive);
        const isFocused = this._shadow.activeElement === coverTextarea;
        if (!isFocused && coverTextarea.value !== (c.coverText || '')) {
          coverTextarea.value = c.coverText || '';
        }
      }
      if (coverCounter) {
        const len = coverTextarea ? coverTextarea.value.length : (c.coverText || '').length;
        coverCounter.textContent = `${len} / 5000`;
        coverCounter.classList.toggle('is-limit', len >= 5000);
      }
    }
  }

  // --- 5. Custom Element Registration & Mounting Helper ---

  if (typeof customElements !== 'undefined' && !customElements.get('hha-hud')) {
    customElements.define('hha-hud', HhaHudElement);
  }

  function mountHud(assistant = null) {
    if (typeof document === 'undefined' || !document.body) return null;
    let hud = document.querySelector('hha-hud');
    if (!hud) {
      hud = document.createElement('hha-hud');
      document.body.appendChild(hud);
    }
    const targetAssistant = assistant || globalThis.HHApplyAssistant || (globalThis.window && globalThis.window.HHApplyAssistant);
    if (targetAssistant && typeof hud.bindAssistant === 'function') {
      hud.bindAssistant(targetAssistant);
    }
    return hud;
  }

  // Auto-mount in browser if document is ready
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.body) {
      mountHud();
    } else {
      document.addEventListener('DOMContentLoaded', () => mountHud(), { once: true });
    }

    // Listen for late-arriving engine ready event
    window.addEventListener('hha:ready', (e) => {
      mountHud(e.detail);
    }, { once: true });

    // Safety polling for async script loading
    let pollCount = 0;
    const pollInterval = setInterval(() => {
      pollCount++;
      const target = globalThis.HHApplyAssistant || (globalThis.window && globalThis.window.HHApplyAssistant);
      if (target) {
        mountHud(target);
        clearInterval(pollInterval);
      } else if (pollCount > 25) {
        clearInterval(pollInterval);
      }
    }, 200);
  }

  return {
    HhaHudElement,
    mountHud,
    clamp,
    clampCoordinates,
    formatTime,
    formatQueueReason,
    ICONS,
    STYLES
  };
});
