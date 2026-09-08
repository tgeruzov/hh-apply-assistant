// ==UserScript==
// @name         HH Apply Assistant
// @namespace    http://tampermonkey.net/
// @version      0.0.6
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
    vacancyApply: '[data-qa="vacancy-response-link-top"], a[data-qa="vacancy-response-link-top"], [data-qa="vacancy-response-link-bottom"], a[data-qa="vacancy-response-link-bottom"]',
    attachCoverBtn: '[data-qa="responded-success-attach-cover-letter"]',
    attachCoverInModal: '[data-qa="responded-success-attach-cover-letter"], [data-qa="add-cover-letter"], button[data-qa="add-cover-letter"], [data-qa="vacancy-response-letter-toggle"]',
    letterTextarea: 'textarea[name="text"], textarea[data-qa="vacancy-response-popup-form-letter-input"], textarea[name="coverLetter"]',
    letterSubmit: '[data-qa="vacancy-response-letter-submit"], button[data-qa="vacancy-response-letter-submit"], button[data-qa="vacancy-response-submit-popup"], [data-qa="vacancy-response-submit-popup"]',
    responseChat: '[data-qa="vacancy-response-link-view-topic"]',
    nativeWrapper: '[data-qa="textarea-native-wrapper"]',
    relocationBtn: '[data-qa="relocation-warning-confirm"]',
    rejectWarning: '[data-qa="response-reject-warning"]',
    vacancyLink: 'a[data-qa="serp-item__title"], a[data-qa="vacancy-serp__vacancy-title"]',
    vacancyCard: 'div[data-qa="vacancy-serp__vacancy"], .vacancy-serp-item'
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
      heuristic: 'button /всё равно|подтвер|переезд|confirm/i'
    },
    vacancyCard: {
      name: 'Карточка вакансии в выдаче',
      heuristic: 'div, article с одиночной ссылкой на /vacancy/'
    }
  };

  const STORAGE_PREFIX = 'hh_apply_assistant_s1_';
  const KEYS = {
    settings: STORAGE_PREFIX + 'settings',
    isRunning: STORAGE_PREFIX + 'is_active',
    returnUrl: STORAGE_PREFIX + 'return_url',
    history: STORAGE_PREFIX + 'processed_ids',
    needF5: STORAGE_PREFIX + 'reload_flag',
    trapLock: STORAGE_PREFIX + 'trap_lock',
    instanceLock: STORAGE_PREFIX + 'instance_lock',
    lastAttempt: STORAGE_PREFIX + 'last_attempt_id',
    manualList: STORAGE_PREFIX + 'manual_queue',
    tabId: STORAGE_PREFIX + 'tab_id',
    sentCount: STORAGE_PREFIX + 'sent_count',
    stats: STORAGE_PREFIX + 'run_stats'
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
  function log(msg, isError = false, code = '', context = null) {
    const level = isError ? 'ERR' : 'INFO';
    const entryCode = code || (isError ? 'ERROR' : 'INFO');
    events.emit('log', {
      level,
      message: String(msg || ''),
      code: entryCode,
      timestamp: Date.now(),
      context: context || {}
    });

    if (isError) {
      events.emit('error', {
        code: entryCode,
        message: String(msg || ''),
        fatal: false,
        details: context
      });
    }
  }

  // --- 6. Configuration ---
  function normalizeConfig(raw) {
    const m = { ...DEFAULTS, ...(raw || {}) };
    return {
      coverText: String(m.coverText ?? DEFAULT_COVER_TEXT).slice(0, 5000),
      useCover: m.useCover !== false,
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
    let id = storage.sessionGet(KEYS.tabId);
    if (!id) {
      id = Math.random().toString(36).slice(2, 9);
      storage.sessionSet(KEYS.tabId, id);
    }
    return id;
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

  const isF5Needed = () => storage.sessionGet(KEYS.needF5) === '1';
  const clearF5Flag = () => storage.sessionRemove(KEYS.needF5);

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

  function findPatternElement(root, selector, regex, maxLen = Infinity) {
    for (const el of (root || globalThis.document)?.querySelectorAll?.(selector) || []) {
      if (!isVisible(el)) continue;
      const txt = (el.innerText || el.textContent || el.value || '').trim();
      if (txt.length <= maxLen && regex.test(txt)) return el;
    }
    return null;
  }

  const applyBtnHeuristic = (r) => findPatternElement(r, 'button, a, [role="button"]', /откликнуться|отклик без резюме|перейти к отклику|apply|respond/i);
  const coverBtnHeuristic = (r) => findPatternElement(r, 'button, a, [role="button"], span', /сопроводительное|письмо|cover letter|add cover/i);

  const HEURISTIC_RESOLVERS = {
    applyBtn: applyBtnHeuristic,
    vacancyApply: applyBtnHeuristic,
    attachCoverBtn: coverBtnHeuristic,
    attachCoverInModal: coverBtnHeuristic,
    letterTextarea: (r) => Array.from((r || globalThis.document)?.querySelectorAll?.('textarea') || []).find(isVisible) || null,
    letterSubmit: (r) => findPatternElement(r, 'button, input[type="submit"], [role="button"]', /отправить|сохранить|откликнуться|send|submit/i),
    relocationBtn: (r) => findPatternElement(r, 'button, [role="button"]', /вс[её] равно|подтвер|переезд|confirm|relocation/i),
    rejectWarning: (r) => findPatternElement(r, 'div, p, span, section', /не соответствует|отказ|не подходит|warning|reject/i, 250),
    responseChat: (r) => findPatternElement(r, 'a, button', /чат|перейти в чат|сообщения|chat/i),
    vacancyCard: (r) => Array.from((r || globalThis.document)?.querySelectorAll?.('div, article, section') || []).find(el => qa('a[href*="/vacancy/"]', el).length === 1 && isVisible(el)) || null
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
      const wrapper = el.closest?.(SELECTORS.nativeWrapper) || el.closest?.('[data-qa="textarea-native-wrapper"]') || el.parentElement;
      const clone = wrapper ? q('pre', wrapper) : null;
      if (clone) clone.textContent = value || '\u200B';

      el.dispatchEvent(new Event('input', { bubbles: true, composed: true, cancelable: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true, cancelable: true }));
      if (typeof el.blur === 'function') el.blur();
    } catch (_) {
      el.value = value;
    }
  }

  // --- Direct element click ---
  function clickElement(el) {
    if (!el || stopSignal) return false;
    try { el.scrollIntoView?.({ block: 'center', behavior: 'auto' }); } catch (_) {}
    try { el.focus?.(); } catch (_) {}
    if (typeof el.click === 'function') {
      el.click();
      return true;
    }
    return el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
  }

  function waitForCondition(checkFn, timeout = 8000, signal = null) {
    if (stopSignal || signal?.aborted) return Promise.resolve(false);
    try {
      const init = checkFn();
      if (init) return Promise.resolve(init);
    } catch (_) {}

    return new Promise((resolve) => {
      let timer = null, pollTimer = null, observer = null;
      const cleanup = (res) => {
        if (timer) clearTimeout(timer);
        if (pollTimer) clearInterval(pollTimer);
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
    return card ? collapseSpaces(query('vacancyLink', card)?.innerText || query('vacancyLink', card)?.textContent) : '';
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
    return Boolean(doc && /(?:тестирован|тест|вопрос|анкет|опрос|задани|questionnaire|test|assessment)/i.test(((doc.body || doc.documentElement)?.textContent || '').slice(0, 4000)));
  };

  const detectAlreadyApplied = () => {
    const doc = globalThis.document;
    return Boolean(doc && /(?:вы уже откликались|отклик уже отправлен|already applied)/i.test(((doc.body || doc.documentElement)?.textContent || '').slice(0, 3000)));
  };

  const getResponseDetectionScope = () => q('[data-qa*="modal" i], [class*="modal" i], [role="dialog"]') || globalThis.document?.body || globalThis.document?.documentElement;
  const hasReliableRejectWarning = () => Boolean(query('rejectWarning') && isVisible(query('rejectWarning')));
  const hasResponseTextConfirmation = (root) => /(?:отклик отправлен|вы откликнулись|резюме доставлено|резюме отправлено|response sent|applied successfully)/i.test(((root || getResponseDetectionScope())?.textContent || '').slice(0, 4000));
  const hasExactResponseConfirmation = (root) => {
    const scope = root || getResponseDetectionScope();
    return Boolean(scope && (query('responseChat', scope) || query('attachCoverBtn', scope) || q('[data-qa="vacancy-response-popup-close"]', scope)));
  };

  function isResponseConfirmed({ allowDocumentStrongText = false } = {}) {
    if (hasExactResponseConfirmation() || hasResponseTextConfirmation()) return true;
    const doc = globalThis.document;
    return Boolean(allowDocumentStrongText && doc && /(?:отклик отправлен|вы уже откликались|вы откликнулись)/i.test((doc.body?.innerText || doc.body?.textContent || '').slice(0, 4000)));
  }

  function detectModalBlockReason() {
    const modal = q('[data-qa*="modal" i], [class*="modal" i], [role="dialog"]');
    if (!modal) return null;
    const text = (modal.textContent || modal.innerText || '').slice(0, 3000);
    if (/резюме\s*скрыто|resume\s*is\s*hidden/i.test(text)) return 'RESUME_HIDDEN';
    if (/не\s*соответствует\s*требованиям|отказ|reject/i.test(text)) return 'REJECT_WARNING';
    if (/тестирование|анкета|вопросы|questionnaire|test/i.test(text)) return 'TEST_REQUIRED';
    if (detectCaptcha() || /капч[аеы]|captcha|recaptcha|smartcaptcha/i.test(text)) return 'CAPTCHA';
    if (detectRateLimit() || /слишком\s*много\s*запросов|доступ\s*ограничен|rate\s*limit|blocked/i.test(text)) return 'RATE_LIMIT';
    return null;
  }

  function detectResponseOutcomeInRoot(root, includeExactSelectors) {
    if (!root) return null;
    if (detectCaptcha()) return 'CAPTCHA';
    if (detectRateLimit()) return 'RATE_LIMIT';
    if (hasReliableRejectWarning()) return 'REJECT_WARNING';
    if (query('relocationBtn', root)) return 'RELOCATION_WARNING';
    if (query('letterTextarea', root)) return 'MODAL_OPEN';
    if (includeExactSelectors && (query('attachCoverBtn', root) || query('responseChat', root) || hasResponseTextConfirmation(root))) {
      return 'ATTACH_COVER';
    }
    return null;
  }

  function detectResponseOutcomeOnce({ allowDocumentStrongText = false } = {}) {
    const modal = q('[data-qa*="modal" i], [class*="modal" i], [role="dialog"]');
    if (modal) {
      const outcome = detectResponseOutcomeInRoot(modal, true);
      if (outcome) return outcome;
    }
    if (hasExactResponseConfirmation() || isResponseConfirmed({ allowDocumentStrongText })) return 'SUCCESS';
    const docRoot = globalThis.document?.body || globalThis.document?.documentElement;
    return docRoot ? detectResponseOutcomeInRoot(docRoot, false) : null;
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
    return true;
  }

  function skipVacancy(vid, reason = 'reject_warning', runId = currentRunId) {
    if (runId !== undefined && runId !== null && !guardOwnedCommit(runId)) return false;
    markVacancyProcessed(vid, runId);
    bumpStat('skipped');
    events.emit('entity', { vid, action: 'skipped', reason });
  }

  function saveCurrentForManual(vid, note = '', runId = currentRunId) {
    if (runId !== undefined && runId !== null && !guardOwnedCommit(runId)) return false;
    let url = globalThis.location?.href || '';
    if ((!url || url.includes('/search/vacancy')) && vid && String(vid).startsWith('v_')) {
      url = `https://hh.ru/vacancy/${String(vid).slice(2)}`;
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
      log(`Saved vacancy to manual queue: #${entry.vid} (${note || 'manual'})`, false, 'MANUAL_SAVED', { vid: entry.vid, note });
      return true;
    }
    return false;
  }

  function returnToList(vid, { markProcessed = true, runId = currentRunId } = {}) {
    if (runId !== undefined && runId !== null && !guardOwnedCommit(runId)) return false;
    if (markProcessed && vid) markVacancyProcessed(vid, runId);
    clearLastAttemptID();
    const rawReturn = getReturnUrl();
    const returnUrl = (rawReturn && (rawReturn.includes('/search/vacancy') || rawReturn.startsWith('http') || rawReturn.startsWith('/'))) ? rawReturn : '/search/vacancy';
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
      fillTextarea(ta, config.coverText);
      await actionPause();
      if (!isRunCurrent(runId)) return false;
    }
    const submit = query('letterSubmit', scope) || findPatternElement(scope, 'button, input[type="submit"], [role="button"]', /отправить|сохранить|откликнуться|send|submit/i);
    if (!submit) return false;
    await clickElement(submit);
    await actionPause();
    return isRunCurrent(runId);
  }

  async function handleScenarioA(btn, runId = currentRunId) {
    if (!config.useCover) return 'OK';
    log('Scenario A: Attaching cover letter after direct apply', false, 'SCENARIO_A');
    await actionPause();
    if (!isRunCurrent(runId)) return 'STOPPED';
    if (btn) await clickElement(btn);
    await actionPause();
    if (!isRunCurrent(runId)) return 'STOPPED';
    const ta = await waitForElement('letterTextarea', 3000, activeAbortController?.signal);
    if (!ta) {
      notifySelectorFailure('letterTextarea', btn ? getVacancyCard(btn) : null);
      return isRunCurrent(runId) ? 'OK' : 'STOPPED';
    }
    await submitCoverLetterForm(null, runId);
    return isRunCurrent(runId) ? 'OK' : 'STOPPED';
  }

  async function handleScenarioB(modal, runId = currentRunId) {
    log('Scenario B: Response modal opened', false, 'SCENARIO_B');
    const blockReason = detectModalBlockReason();
    if (blockReason === 'CAPTCHA') { haltForCaptcha(); return 'CAPTCHA'; }
    if (blockReason === 'RATE_LIMIT') { haltForRateLimit(); return 'BLOCKED'; }
    if (blockReason === 'TEST_REQUIRED' || blockReason === 'RESUME_HIDDEN') return blockReason;

    if (hasReliableRejectWarning()) {
      const closeBtn = q('[data-qa="vacancy-response-popup-close"], [data-qa*="close" i], button[aria-label*="закрыть" i]', modal);
      if (closeBtn) clickElement(closeBtn);
      return 'SKIP';
    }

    const attachCoverToggle = query('attachCoverInModal', modal);
    if (attachCoverToggle && config.useCover) {
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

    const confirmed = await waitForCondition(() => isResponseConfirmed(), 6000, activeAbortController?.signal);
    return confirmed ? 'OK' : 'FAIL';
  }

  async function dispatchOutcome(outcome, vid, runId) {
    if (!outcome) return Page.isVacancy() ? 'NAVIGATED' : 'FAIL';
    if (outcome === 'RESPONSE_FORM') return 'RESPONSE_PAGE';
    if (outcome === 'CAPTCHA') { haltForCaptcha(); return 'CAPTCHA'; }
    if (outcome === 'RATE_LIMIT') { haltForRateLimit(); return 'BLOCKED'; }

    if (outcome === 'ATTACH_COVER') {
      const res = await handleScenarioA(query('attachCoverBtn'), runId);
      if (res === 'OK' && vid) commitSuccess(vid, runId);
      return res;
    }

    if (outcome === 'MODAL_OPEN') {
      const modal = q('[data-qa*="modal" i], [class*="modal" i], [role="dialog"]');
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
      const relocBtn = query('relocationBtn');
      if (relocBtn) {
        await clickElement(relocBtn);
        await actionPause();
        if (!isRunCurrent(runId)) return 'STOPPED';
        if (vid) commitSuccess(vid, runId);
        return 'OK';
      }
      if (vid) {
        saveCurrentForManual(vid, 'relocation_unconfirmed', runId);
        markVacancyProcessed(vid, runId);
      }
      return 'FAIL';
    }

    return 'FAIL';
  }

  async function handleVacancyPage(vid, runId = currentRunId) {
    try {
      if (detectAlreadyApplied()) {
        log('Already applied to this vacancy', false, 'ALREADY_APPLIED');
        if (vid) skipVacancy(vid, 'already_applied', runId);
        returnToList(vid, { markProcessed: true, runId });
        return 'OK';
      }
      const applyBtn = query('vacancyApply') || findPatternElement(globalThis.document?.body, 'button, a, [role="button"]', /откликнуться|отклик без резюме|перейти к отклику|apply|respond/i);
      if (!applyBtn) {
        notifySelectorFailure('vacancyApply', globalThis.document?.body);
        if (vid) saveCurrentForManual(vid, 'no-apply-button', runId);
        returnToList(vid, { markProcessed: true, runId });
        return 'FAIL';
      }
      await clickElement(applyBtn);
      await actionPause();
      if (!isRunCurrent(runId)) return 'STOPPED';
      const outcome = await waitForCondition(() => (Page.isResponseForm() ? 'RESPONSE_FORM' : detectResponseOutcomeOnce()), 8000, activeAbortController?.signal);
      const res = await dispatchOutcome(outcome, vid, runId);
      if (['OK', 'SKIP', 'TEST_REQUIRED', 'RESUME_HIDDEN'].includes(res)) {
        returnToList(vid, { markProcessed: true, runId });
      }
      return res;
    } catch (e) {
      log(`Error on vacancy page: ${(e && e.message) || e}`, true, 'VACANCY_PAGE_ERROR');
      if (vid) saveCurrentForManual(vid, 'vacancy-page-error', runId);
      returnToList(vid, { markProcessed: true, runId });
      return 'FAIL';
    }
  }

  async function submitResponsePage(vid, runId = currentRunId) {
    if (!isRunCurrent(runId)) return;
    if (touchInstanceLock(TAB_ID) !== 'OWNED') return haltForLostInstanceLock();
    log('Handling dedicated vacancy response page', false, 'RESPONSE_PAGE');
    setStatus('running', 'SUBMITTING_RESPONSE_PAGE');
    handlingResponsePage = true;
    try {
      if (pageLooksLikeTest()) {
        log('Test or questionnaire detected on response page. Routing to manual queue.', false, 'QUESTIONS_DETECTED');
        saveCurrentForManual(vid, 'test-questionnaire', runId);
        return returnToList(vid, { markProcessed: true, runId });
      }
      const submitBtn = await waitForCondition(() => query('letterSubmit') || findPatternElement(null, 'button, input[type="submit"], [role="button"]', /отправить|сохранить|откликнуться|send|submit/i), 4000, activeAbortController?.signal);
      if (!isRunCurrent(runId)) return;
      if (!submitBtn) {
        notifySelectorFailure('letterSubmit', globalThis.document?.body);
        saveCurrentForManual(vid, 'no-submit-button', runId);
        return returnToList(vid, { markProcessed: true, runId });
      }
      const submitted = await submitCoverLetterForm(null, runId);
      if (!isRunCurrent(runId)) return;
      if (!submitted) {
        log('Failed submitting cover letter form on response page', true, 'SUBMIT_FAILED');
        saveCurrentForManual(vid, 'submit-form-failed', runId);
        return returnToList(vid, { markProcessed: true, runId });
      }
      const confirmed = await waitForCondition(() => isResponseConfirmed({ allowDocumentStrongText: true }), 6000, activeAbortController?.signal);
      log(confirmed ? 'Application confirmed on response page' : 'Could not confirm response submission', !confirmed, confirmed ? 'APPLICATION_CONFIRMED' : 'SUBMIT_UNCONFIRMED');
      if (confirmed) commitSuccess(vid, runId); else saveCurrentForManual(vid, 'unconfirmed', runId);
      returnToList(vid, { markProcessed: true, runId });
    } catch (e) {
      log(`Error handling response page: ${(e && e.message) || e}`, true, 'RESPONSE_PAGE_ERROR');
      if (vid) saveCurrentForManual(vid, 'response-page-error', runId);
      returnToList(vid, { markProcessed: true, runId });
    } finally {
      handlingResponsePage = false;
      clearTrapLock();
    }
  }

  function getStableVacancyId(btn) {
    const loc = globalThis.location;
    if (Page.isVacancy() && loc) {
      const direct = getVacancyIDFromHref(loc.href);
      if (direct) return 'v_' + direct;
    }
    if (btn) return getVacancyID(btn);
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
        terminateRun(isBlocked ? 'STORAGE_BLOCKED' : 'TAB_BUSY', isBlocked ? 'Storage access is blocked.' : 'Another tab is active.', {}, true);
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
        const cards = qa(SELECTORS.vacancyCard) || qa('.vacancy-serp-item, [data-qa="vacancy-serp__vacancy"]');
        if (cards.length > 0) {
          notifySelectorFailure('applyBtn', cards[0], { cardsCount: cards.length });
          return finalizeRun(runId, 'error', 'Селектор applyBtn не найден на странице поиска');
        }
      }

      const processed = getProcessedIDs();
      let targets = allBtns.filter(b => (config.skipHidden && !isVisible(b) ? false : !processed.has(getVacancyID(b))));
      log(`Search page scanned: ${allBtns.length} buttons, ${targets.length} pending, ${initialSent}/${config.limit} sent`, false, 'VACANCIES_SCANNED', {
        total: allBtns.length, pending: targets.length, sent: initialSent, limit: config.limit
      });

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
      if (isF5Needed()) { clearF5Flag(); }
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
      isF5Needed: isF5Needed(),
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
      clearF5Flag();
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
      setStatus('running', 'AUTO_STARTING');
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        if (isRunning()) startLoop();
      }, 1500);
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
      if (!isRunning()) releaseInstanceLock(TAB_ID);
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
    return clean ? `https://hh.ru/vacancy/${clean}` : '';
  }

  function formatStatusLabel(status, code) {
    const c = String(code || '').toUpperCase();
    if (status === 'running') {
      if (c === 'RESPONSE_PAGE' || c === 'SUBMITTING_RESPONSE_PAGE') return 'Страница отклика';
      if (c === 'RETURNING_TO_LIST') return 'Возврат к поиску';
      if (c === 'LOOP_STARTING') return 'Запуск цикла...';
      return 'Автоматизация активна';
    }
    if (status === 'done') return 'Дневной лимит достигнут';
    if (status === 'stopped') return 'Остановлено пользователем';
    if (status === 'error') {
      if (c === 'TAB_BUSY') return 'Активна другая вкладка';
      if (c === 'STORAGE_BLOCKED') return 'Хранилище заблокировано';
      if (c === 'CAPTCHA_DETECTED') return 'Обнаружена капча!';
      if (c === 'RATE_LIMITED') return 'Ограничение запросов (429)';
      return `Ошибка: ${c || 'SYSTEM'}`;
    }
    return 'Готов к запуску';
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

    .hha-root {
      position: fixed;
      left: var(--center-x, var(--hud-center-x, 0px));
      bottom: var(--hud-bottom, 24px);
      top: auto;
      display: flex;
      flex-direction: column-reverse;
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

    .hha-root.is-dragging {
      transition: none;
    }

    /* --- 1. Compact Pill (Glass Bevel Border 2px, Height: 36px) --- */
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

    .hha-pill-queue-badge.is-visible,
    .hha-pill-queue-badge.visible {
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

    /* Quick Action Button: Soft pastel tone, capsule shape */
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

    .hha-btn-quick.btn-start,
    .hha-btn-start {
      background: #dcfce7;
      color: #15803d;
      border: 1px solid #bbf7d0;
    }

    .hha-btn-quick.btn-start:hover,
    .hha-btn-start:hover {
      background: #bbf7d0;
      border-color: #86efac;
    }

    .hha-btn-quick.btn-stop,
    .hha-btn-stop {
      background: #fee2e2;
      color: #b91c1c;
      border: 1px solid #fecaca;
    }

    .hha-btn-quick.btn-stop:hover,
    .hha-btn-stop:hover {
      background: #fecaca;
      border-color: #fca5a5;
    }

    .hha-btn-quick.btn-stop:active,
    .hha-btn-quick.btn-stop:focus-visible,
    .hha-btn-stop:active,
    .hha-btn-stop:focus-visible {
      background: #fecaca;
      color: #991b1b;
      border-color: #f87171;
    }

    .hha-btn-quick.hha-btn-done,
    .hha-btn-done {
      background: #f1f5f9;
      color: #475569;
      border: 1px solid #e2e8f0;
    }

    .hha-btn-quick.hha-btn-done:hover,
    .hha-btn-done:hover {
      background: #e2e8f0;
      border-color: #cbd5e1;
      color: #0f172a;
    }

    .hha-btn-quick.hha-btn-error,
    .hha-btn-error {
      background: #fee2e2;
      color: #b91c1c;
      border: 1px solid #fecaca;
    }

    .hha-btn-quick.hha-btn-error:hover,
    .hha-btn-error:hover {
      background: #fecaca;
      border-color: #fca5a5;
    }


    /* --- 2. Flyout Overlay Panel (390px, Glass Bevel Border 2px) --- */
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

    .hha-flyout.is-animating,
    .hha-root.is-animating .hha-flyout,
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

    /* --- Segmented Tabs (Apple HIG Inset Track) --- */
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

    .hha-tab-count {
      font-size: 10px;
      font-weight: 600;
      color: #ea580c;
      margin-left: 2px;
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

    .hha-tab-btn:focus {
      outline: none;
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
    .hha-log-item-delete:focus-visible,
    .hha-cover-textarea:focus-visible,
    .hha-textarea:focus-visible {
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

    /* --- Tab Panels Body --- */
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

    /* Activity and Queue Block */
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

    .hha-log-tag {
      padding: 1px 5px;
      border-radius: var(--hha-radius-micro, 4px);
      font-size: 10px;
      font-weight: 600;
      flex-shrink: 0;
      line-height: 1.2;
    }

    .hha-log-tag.is-queue {
      background: #ffedd5;
      color: #c2410c;
    }

    .hha-queue-title-link {
      display: inline-flex;
      align-items: center;
      gap: 4px;
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

    .hha-queue-ext-icon {
      display: inline-flex;
      align-items: center;
      opacity: 0.35;
      flex-shrink: 0;
      transition: opacity 100ms ease;
    }

    .hha-queue-title-link:hover .hha-queue-ext-icon {
      opacity: 1;
      color: #2563eb;
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

    /* Segmented Tab Error Badge */
    .hha-seg-badge-error {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 15px;
      height: 15px;
      padding: 0 4px;
      border-radius: var(--hha-radius-full, 9999px);
      background: #fee2e2;
      color: #b91c1c;
      border: 1px solid #fca5a5;
      font-size: 9px;
      font-weight: 700;
      line-height: 1;
      box-sizing: border-box;
      margin-left: 2px;
      animation: hhaPopIn 180ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    /* DevTools Compact Row Stream */
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
      border-left: 2px solid #2563eb;
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

    .hha-log-dev-badge {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
      font-size: 9px;
      font-weight: 600;
      padding: 1px 4px;
      border-radius: 3px;
      background: #f1f5f9;
      color: #64748b;
      flex-shrink: 0;
    }

    .hha-log-dev-badge.badge-apply {
      background: #ecfdf5;
      color: #059669;
    }

    .hha-log-dev-badge.badge-queue {
      background: #fffbeb;
      color: #d97706;
      border: 1px solid #fde68a;
    }

    .hha-log-dev-badge.badge-error {
      background: #fef2f2;
      color: #dc2626;
    }

    .hha-log-dev-badge.badge-dom_err {
      background: #fef2f2;
      color: #b91c1c;
      border: 1px solid #fca5a5;
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
      color: #64748b;
      opacity: 0.35;
      pointer-events: none;
      cursor: default;
      display: none !important;
    }

    /* Custom Apple HIG Floating Tooltip (Dynamic Bounds-Clamped) */
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

    /* Grouped Cards */
    .hha-group,
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

    .hha-group-row,
    .hha-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 10px;
      min-height: 36px;
      box-sizing: border-box;
    }

    .hha-group-row + .hha-group-row,
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

    .hha-setting-label {
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

    .hha-segmented-btn.is-active,
    .hha-segmented-btn.active {
      background: #ffffff !important;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0, 0, 0, 0.06) !important;
      color: #0f172a !important;
      font-weight: 600 !important;
    }

    /* Apple HIG iOS Switch Toggle & Seamless Cover Letter Card */
    .hha-card-cover {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      margin-bottom: 0;
      overflow: hidden;
      transition: border-color 140ms ease, box-shadow 140ms ease;
    }

    .hha-card-cover:focus-within {
      border-color: #3b82f6;
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15);
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
      background-color: #cbd5e1;
      border-radius: 9999px;
      transition: background-color 200ms cubic-bezier(0.16, 1, 0.3, 1);
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
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2), 0 0 1px rgba(0, 0, 0, 0.1);
      transition: transform 200ms cubic-bezier(0.34, 1.3, 0.64, 1);
    }

    .hha-switch-input:checked + .hha-switch-slider {
      background-color: #22c55e;
    }

    .hha-switch-input:checked + .hha-switch-slider::before {
      transform: translateX(16px);
    }

    .hha-switch-input:focus-visible + .hha-switch-slider {
      box-shadow: 0 0 0 2px #3b82f6;
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

    .hha-cover-textarea,
    .hha-textarea {
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

    .hha-cover-textarea:focus,
    .hha-cover-textarea:focus-visible,
    .hha-textarea:focus,
    .hha-textarea:focus-visible {
      outline: none;
      border: none;
      box-shadow: none !important;
    }

    .hha-cover-textarea:disabled,
    .hha-cover-textarea.is-disabled,
    .hha-textarea:disabled {
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
      this._activeTab = 'settings'; // 'settings' | 'logs'
      this._logFilterMode = 'queue'; // 'queue' | 'events'
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

      // Bound Event Handlers
      this._onResize = this._onResize.bind(this);
      this._onPointerDown = this._onPointerDown.bind(this);
      this._onPointerMove = this._onPointerMove.bind(this);
      this._onPointerUp = this._onPointerUp.bind(this);
    }

    connectedCallback() {
      this._render();
      this._restorePosition();
      this._bindDomEvents();
      this._syncAll();

      if (typeof window !== 'undefined') {
        window.addEventListener('resize', this._onResize, { passive: true });
      }

      // Auto-bind to global assistant if present
      const globalAssistant = globalThis.HHApplyAssistant || (globalThis.window && globalThis.window.HHApplyAssistant);
      if (globalAssistant && !this._assistant) {
        this.bindAssistant(globalAssistant);
      }
    }

    disconnectedCallback() {
      this._domEventsBound = false;
      this.unbindAssistant();
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', this._onResize);
      }
      if (this._onDocClick && typeof document !== 'undefined') {
        document.removeEventListener('click', this._onDocClick);
      }
      if (this._coverDebounceTimer) clearTimeout(this._coverDebounceTimer);
      if (this._animTimer) clearTimeout(this._animTimer);
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

      if (event.action === 'applied' || tagType === 'apply') {
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
        metaBadge = rReason ? rReason.toLowerCase() : '';
      } else if (event.action === 'error' || tagType === 'error') {
        tag = event.tag || 'ERROR';
        tagType = 'error';
        msg = event.msg || event.reason || event.error || 'Сбой выполнения запроса';
        sub = event.sub || 'Ошибка API: требуется подтверждение или проверка суточных лимитов';
        metaBadge = event.metaBadge || 'ERR';
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
        isDevLog: true
      };

      this._liveFeed.unshift(item);
      if (this._liveFeed.length > 50) this._liveFeed.length = 50;
      this._syncLogs();
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

    _switchLogMode(mode) {
      if (mode === 'queue') {
        this.setActiveTab('queue');
      } else {
        this.setActiveTab('logs');
      }
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
      const resetBtn = this._shadow.querySelector('[data-action="clear-logs"]') || this._shadow.querySelector('[data-el="clear-logs-btn"]');
      const copyBtn = this._shadow.querySelector('[data-action="copy-logs"]') || this._shadow.querySelector('[data-el="copy-logs-btn"]');
      if (resetBtn) resetBtn.style.display = 'inline-flex';
      if (copyBtn) copyBtn.style.display = 'inline-flex';
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

          <!-- Flyout Overlay (360px wide, fixed 350px height) -->
          <div class="hha-flyout" data-el="flyout">
            <!-- Floating Tooltip -->
            <div class="hha-tooltip" data-el="tooltip"></div>

            <!-- Segmented Control Tabs (3 columns) -->
            <div class="hha-tabs">
              <button type="button" class="hha-tab-btn active" data-action="switch-tab" data-tab="settings">Настройки</button>
              <button type="button" class="hha-tab-btn" data-action="switch-tab" data-tab="queue"><span>Очередь</span> <span class="hha-tab-count" data-el="queue-tab-count" style="display: none;">(0)</span></button>
              <button type="button" class="hha-tab-btn" data-action="switch-tab" data-tab="logs"><span>Журнал</span><span class="hha-seg-badge-error" data-el="log-error-badge" style="display: none;">0</span></button>
            </div>

            <!-- Panels -->
            <div class="hha-panels">
              <!-- Tab 1: Settings (Настройки) -->
              <div class="hha-panel active" data-panel="settings">
                <div class="hha-card hha-group">
                  <div class="hha-row hha-group-row">
                    <span class="hha-row-label hha-setting-label">Лимит откликов</span>
                    <div class="hha-stepper">
                      <button type="button" class="hha-stepper-btn" data-action="step-limit" data-step="-5" aria-label="Уменьшить лимит">−</button>
                      <input type="number" class="hha-stepper-input" data-el="setting-limit" min="1" max="200" step="5" value="50">
                      <button type="button" class="hha-stepper-btn" data-action="step-limit" data-step="5" aria-label="Увеличить лимит">+</button>
                    </div>
                  </div>
                  <div class="hha-speed-row hha-group-row">
                    <span class="hha-row-label">Скорость</span>
                    <div class="hha-segmented-control">
                      <button type="button" class="hha-segmented-btn" data-action="set-preset" data-preset="safe" data-tooltip="Безопасно: интервал 4–8 с">Безопасно</button>
                      <button type="button" class="hha-segmented-btn is-active" data-action="set-preset" data-preset="balanced" data-tooltip="Баланс: интервал 2–5 с">Баланс</button>
                      <button type="button" class="hha-segmented-btn" data-action="set-preset" data-preset="fast" data-tooltip="Быстро: интервал 1.5–3 с">Быстро</button>
                    </div>
                  </div>
                </div>

                <div class="hha-card hha-group hha-card-cover">
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
                    <textarea class="hha-cover-textarea hha-textarea" data-el="setting-cover-text" maxlength="5000" placeholder="Текст сопроводительного письма..."></textarea>
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
                    <span class="hha-log-header-title" data-el="log-status-text">События и отклики</span>
                    <div class="hha-log-actions">
                      <button type="button" class="hha-btn-icon hha-btn-ghost hha-btn-clear-logs" data-action="clear-logs" data-el="clear-logs-btn" data-tooltip="Очистить журнал">${ICONS.reset}</button>
                      <button type="button" class="hha-btn-icon hha-btn-ghost hha-btn-copy-log" data-action="copy-logs" data-el="copy-logs-btn" data-tooltip="Скопировать журнал">${ICONS.copy}</button>
                    </div>
                  </div>
                  <div class="hha-log-stream" data-el="log-stream">
                    <div class="hha-log-empty">
                      <div class="hha-log-empty-icon">${ICONS.inboxEmpty}</div>
                      <div class="hha-log-empty-text">Нет записей в журнале</div>
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
      const coverContainer = this._shadow.querySelector('[data-el="setting-cover-container"]');
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
      } else if (action === 'clear-logs' || action === 'reset-history') {
        e.stopPropagation();
        this._liveFeed = [];
        this._expandedLogIds.clear();
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
      const tag = item.tag ? `[${item.tag}]` : `[${item.badgeText || 'EVENT'}]`;
      const badge = item.metaBadge ? ` [${item.metaBadge}]` : '';
      const msg = item.msg || item.title || '';

      const isDomOrDetailedError = Boolean(item.selector || item.expectedCss || item.heuristic || item.contextSnippet);

      if (isDomOrDetailedError) {
        const parts = [`${time} ${tag}${badge} ${msg}`];
        if (item.url) parts.push(`  URL: ${item.url}`);
        if (item.selector) parts.push(`  Селектор: ${item.selector}${item.selectorName ? ` (${item.selectorName})` : ''}`);
        if (item.expectedCss) parts.push(`  Ожидался CSS: ${item.expectedCss}`);
        if (item.heuristic) parts.push(`  Эвристика: ${item.heuristic}`);
        if (item.vid) parts.push(`  ID вакансии: v_${item.vid}`);
        if (item.employer) parts.push(`  Компания: ${item.employer}`);
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

      if (this._activeTab === 'queue' || this._logFilterMode === 'queue') {
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
      const handleType = this._dragHandleType;

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
          queueBadge.classList.add('is-visible', 'visible');

          if (countChanged && wasVisible) {
            queueBadge.classList.remove('is-popping');
            void queueBadge.offsetWidth; // force reflow
            queueBadge.classList.add('is-popping');
          }
        } else {
          queueBadge.style.display = '';
          queueBadge.classList.remove('is-visible', 'visible', 'is-popping', 'is-wide');
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
          queueTabCount.textContent = `(${count})`;
          queueTabCount.style.display = 'inline';
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
            const reasonText = formatQueueReason(item.reason || item.note);

            return `
              <div class="hha-log-item is-queue">
                <div class="hha-log-item-left">
                  <span class="hha-log-tag is-queue hha-reason-badge">${escapeHtml(reasonText)}</span>
                  <a href="${escapeHtml(targetUrl || '#')}" target="_blank" rel="noopener noreferrer" class="hha-queue-title-link" data-tooltip="${escapeHtml(item.title || 'Вакансия')}" onclick="event.stopPropagation();">
                    <span class="hha-queue-title-text">${escapeHtml(item.title || 'Вакансия')}</span>
                    <span class="hha-queue-ext-icon">${ICONS.open}</span>
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
          logStream.innerHTML = this._liveFeed.map(item => {
            const isExpanded = this._expandedLogIds && this._expandedLogIds.has(item.id);
            const cleanSub = item.sub ? item.sub.replace(/^Причина:\s*Причина:\s*/i, 'Причина: ') : '';
            return `
              <div class="hha-log-dev-row ${isExpanded ? 'is-expanded' : ''}" data-action="toggle-log-detail" data-log-id="${escapeHtml(item.id)}">
                <div class="hha-log-dev-main">
                  <span class="hha-log-dev-time">${escapeHtml(item.time)}</span>
                  <span class="hha-log-dev-tag tag-${escapeHtml(item.tagType)}">[${escapeHtml(item.tag)}]</span>
                  <span class="hha-log-dev-msg" title="${escapeHtml(item.msg)}">${escapeHtml(item.msg)}</span>
                  ${item.metaBadge ? `<span class="hha-log-dev-badge badge-${escapeHtml(String(item.metaBadge).toLowerCase())} badge-${escapeHtml(item.tagType)}">${escapeHtml(item.metaBadge)}</span>` : ''}
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
        } else {
          logStream.innerHTML = `
            <div class="hha-log-empty">
              <div class="hha-log-empty-icon">${ICONS.inboxEmpty}</div>
              <div class="hha-log-empty-text">Нет записей в журнале</div>
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
      const coverContainer = this._shadow.querySelector('[data-el="setting-cover-container"]');
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
    formatStatusLabel,
    ICONS,
    STYLES
  };
});
