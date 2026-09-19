// ==UserScript==
// @name         HH Apply Assistant
// @namespace    http://tampermonkey.net/
// @version      0.0.9
// @author       Timur Geruzov
// @description  HH Apply Assistant - Автоматизация откликов на вакансии hh.ru с эргономичным плавающим HUD интерфейсом
// @license      GPL-3.0-only
// @homepageURL  https://github.com/tgeruzov/hh-apply-assistant
// @supportURL   https://github.com/tgeruzov/hh-apply-assistant/issues
// @match        *://*.hh.ru/search/vacancy*
// @match        *://*.hh.ru/vacancy/*
// @match        *://*.hh.ru/applicant/vacancy_response*
// @match        *://*.hh.ru/article/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// --- Global Shared Configuration Constants ---
const MAX_DAILY_LIMIT = 200;
const MAX_COVER_LENGTH = 5000;

// --- Global Shared Utilities ---
function clamp(val, min, max) {
  const num = Number(val);
  if (isNaN(num)) return min;
  return Math.max(min, Math.min(max, num));
}

const collapseSpaces = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const formatCleanSalary = (raw) => {
  if (!raw) return '';
  return collapseSpaces(
    String(raw)
      .replace(/(?:до\s+вычета\s+(?:налогов|ндфл)|на\s+руки|за\s+месяц|за\s+\d+\s+смен\w*|после\s+вычета|gross|net)/gi, '')
      .replace(/[,.]\s*$/g, '')
  );
};

function cleanVid(vid) {
  return vid ? String(vid).trim().replace(/^v_/i, '') : '';
}

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
  const VERSION = '2.1.0';
  const SELECTORS = {
    applyBtn: '[data-qa="vacancy-serp__vacancy_response"]',
    vacancyApply: '[data-qa="vacancy-response-link-bottom"], [data-qa="vacancy-response-link-top"], a[data-qa*="vacancy-response-link"]',
    attachCoverBtn: '[data-qa="responded-success-attach-cover-letter"]',
    attachCoverInModal: '[data-qa="responded-success-attach-cover-letter"], [data-qa="add-cover-letter"], [data-qa="vacancy-response-letter-toggle"]',
    letterTextarea: 'textarea[data-qa="vacancy-response-popup-form-letter-input"], textarea[name="text"], textarea[name="coverLetter"]',
    letterSubmit: '[data-qa="vacancy-response-letter-submit"], [data-qa*="response-submit" i]',
    responseChat: '[data-qa="vacancy-response-link-view-topic"]',
    nativeWrapper: '[data-qa="textarea-native-wrapper"]',
    relocationBtn: '[data-qa="relocation-warning-confirm"]',
    rejectWarning: '[data-qa="response-reject-warning"]',
    vacancyLink: 'a[data-qa="serp-item__title"], a[data-qa="vacancy-serp__vacancy-title"]',
    vacancyCard: 'div[data-qa="vacancy-serp__vacancy"], .vacancy-serp-item',
    pagerNext: '[data-qa="pager-next"]'
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
    dailyLimitReached: STORAGE_PREFIX + 'daily_limit_reached',
    pendingVacancyMeta: STORAGE_PREFIX + 'pending_vacancy_meta',
    blacklist: STORAGE_PREFIX + 'blacklist_v1',
    attempts: STORAGE_PREFIX + 'attempts_v1',
    dailyCounters: STORAGE_PREFIX + 'daily_counters',
    logBuffer: 'hha:log_buffer',
    watchdogStallCount: 'hha:watchdog_stall_count',
    watchdogStallVid: 'hha:watchdog_stall_vid',
    skipAlertShown: 'hha:skip_alert_shown',
    sessionProcessedTotal: 'hha:session_processed_total',
    sessionAnomalousSkips: 'hha:session_anomalous_skips'
  };

  const MAX_VACANCY_ATTEMPTS = 3;
  const BLACKLIST_TTL = 24 * 60 * 60 * 1000; // 24 hours
  const PAGE_WATCHDOG_TIMEOUT = 15000; // 15 seconds
  const WATCHDOG_STALL_TIMEOUT = 60000; // 60 seconds stall timeout
  const SKIP_ALERT_RATIO = 0.7; // 70% threshold for skip rate alert
  const MAX_LOG_ENTRIES = 300;
  const MAX_LOG_SIZE_BYTES = 40000;
  const REJECT_REGEX = /(?:не\s*соответствует(?:\s*требованиям)?|не\s*подходит|(?:^|[\s.,!?:;«»'"()—–-])отказ(?:а|у|ом|ы)?(?=[\s.,!?:;«»'"()—–-]|$)|reject|warning)/i;
  const pageLoadedAt = Date.now();

  const ACTION_TIMINGS = { delay: [2500, 5000], action: [250, 500] };

  const DEFAULT_COVER_TEXT = 'Здравствуйте! Меня заинтересовала ваша вакансия. Ознакомьтесь, пожалуйста, с моим резюме.';
  const DEFAULTS = {
    coverText: DEFAULT_COVER_TEXT,
    useCover: true,
    skipHidden: true,
    limit: MAX_DAILY_LIMIT
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
      } catch (e) {
        console.warn(`[HH] Storage quota exceeded on ${type}Storage (key: ${key}):`, e);
      }
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
      if (!s) return true;
      s.setItem('__hha_test__', '1');
      s.removeItem('__hha_test__');
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
  const toNum = (v, fallback) => { const n = Number(v); return Number.isNaN(n) ? fallback : n; };
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

  // --- 5. Error Reporting, Logging & Telemetry ---
  const SENSITIVE_KEYS = new Set(['covertext', 'letter', 'text', 'message', 'cover', 'name', 'phone', 'email', 'fio', 'resume', 'applicant', 'applicantname']);

  function sanitizeLogData(data) {
    if (!data || typeof data !== 'object') return {};
    const clean = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined || v === null) continue;
      if (SENSITIVE_KEYS.has(k.toLowerCase())) continue; // Never log cover letters or personal data
      if (typeof v === 'object' && !Array.isArray(v)) {
        clean[k] = sanitizeLogData(v);
      } else {
        clean[k] = v;
      }
    }
    return clean;
  }

  function formatLogTime(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function formatLogData(data) {
    if (!data || typeof data !== 'object') return '';
    const parts = [];
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'object') {
        parts.push(`${k}=${JSON.stringify(v)}`);
      } else {
        parts.push(`${k}=${v}`);
      }
    }
    return parts.join(' ');
  }

  function readLogBuffer() {
    try {
      const raw = storage.localGet(KEYS.logBuffer);
      if (!raw) return [];
      const arr = parseJson(raw, []);
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  function writeLogBuffer(entries) {
    try {
      let list = Array.isArray(entries) ? entries : [];
      if (list.length > MAX_LOG_ENTRIES) {
        list = list.slice(-MAX_LOG_ENTRIES);
      }
      let json = JSON.stringify(list);
      while (json.length > MAX_LOG_SIZE_BYTES && list.length > 5) {
        const dropCount = Math.max(1, Math.floor(list.length * 0.1));
        list = list.slice(dropCount);
        json = JSON.stringify(list);
      }
      storage.localSet(KEYS.logBuffer, json);
      return true;
    } catch (e) {
      console.warn('[HHA] Failed to write log buffer:', e);
      return false;
    }
  }

  function appendLogEntry(entry) {
    const list = readLogBuffer();
    list.push(entry);
    writeLogBuffer(list);
  }

  function hhaDumpLog() {
    const entries = readLogBuffer();
    return entries.map(e => JSON.stringify(e)).join('\n');
  }

  function hhaClearLog() {
    writeLogBuffer([]);
    console.info('[HHA] Log buffer cleared');
    return true;
  }

  function hhaLog(level, event, data = null) {
    const ts = Date.now();
    const cleanData = sanitizeLogData(data);
    const entry = {
      ts,
      level: level || 'info',
      event: String(event || 'unknown'),
      ...cleanData
    };

    appendLogEntry(entry);

    const timeStr = formatLogTime(new Date(ts));
    const dataStr = formatLogData(cleanData);
    const line = `[HHA] ${timeStr} ${entry.event}${dataStr ? ' ' + dataStr : ''}`;

    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.info(line);
    }
  }

  function reportError(msg, code = 'ERROR', details = null) {
    const entryCode = code || 'ERROR';
    const message = String(msg || '');
    try {
      console.error(`%c[HHA ERROR]%c [${entryCode}] ${message}`, 'background: #ef4444; color: #ffffff; font-weight: 700; border-radius: 3px; padding: 1px 5px; font-size: 11px;', 'color: #ef4444; font-weight: 600;', details || '');
    } catch (_) {}
    hhaLog('error', 'error', {
      code: entryCode,
      message,
      ...(details && typeof details === 'object' ? details : {})
    });
    events.emit('error', {
      code: entryCode,
      message,
      fatal: false,
      details: details || {}
    });
  }

  // --- Watchdog Progress Tracking ---
  let lastProgressTs = Date.now();
  function markProgress(step = '') {
    lastProgressTs = Date.now();
  }

  // --- Daily Counters Domain ---
  function getLocalDateKey(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function getDailyCounters() {
    const today = getLocalDateKey();
    const raw = storage.localGet(KEYS.dailyCounters);
    const data = parseJson(raw, null);
    if (data && data.date === today) {
      return {
        date: today,
        applied: Number(data.applied) || 0,
        queued: Number(data.queued) || 0,
        skipped: Number(data.skipped) || 0,
        error: Number(data.error) || 0
      };
    }
    const fresh = { date: today, applied: 0, queued: 0, skipped: 0, error: 0 };
    storage.localSet(KEYS.dailyCounters, JSON.stringify(fresh));
    return fresh;
  }

  function saveDailyCounters(counters) {
    storage.localSet(KEYS.dailyCounters, JSON.stringify(counters));
  }

  function resetDailyCounters() {
    const today = getLocalDateKey();
    const fresh = { date: today, applied: 0, queued: 0, skipped: 0, error: 0 };
    saveDailyCounters(fresh);
    return fresh;
  }

  function normalizeReasonCode(rawReason, defaultPrefix = 'skip') {
    if (!rawReason) return defaultPrefix + '_unknown';
    let s = String(rawReason).trim().toLowerCase().replace(/[-\s]+/g, '_');
    if (s.startsWith('skip_') || s.startsWith('queued_') || s.startsWith('error_') || s.startsWith('applied_') || s === 'hh_limit_reached') {
      return s;
    }
    if (s === 'reject_regex' || s.includes('reject_regex') || s.includes('regex')) return 'skip_reject_regex';
    if (s.includes('reject') || s.includes('warning')) return 'skip_reject_warning';
    if (s.includes('hidden')) return s.includes('resume') ? 'skip_resume_hidden' : 'skip_hidden_employer';
    if (s.includes('already')) return 'skip_already_applied';
    if (s.includes('access_denied') || s.includes('inaccessible')) return 'skip_inaccessible';
    if (s.includes('unknown_page')) return 'skip_unknown_page';
    if (s.includes('promo') || s.includes('article') || s.includes('lead_gen')) return 'queued_promo';
    if (s.includes('test') || s.includes('questionnaire')) return 'queued_questionnaire';
    if (s.includes('relocation')) return 'queued_relocation';
    if (s.includes('no_button') || s.includes('no_apply') || s.includes('no_submit')) return 'queued_no_button';
    if (s.includes('external')) return 'queued_external_site';
    if (s.includes('max_attempts')) return 'queued_max_attempts';
    if (s.includes('timeout')) return 'error_timeout';
    if (s.includes('selector')) return 'error_selector_missing';
    if (s.includes('captcha')) return 'error_captcha';
    if (s.includes('rate_limit')) return 'error_rate_limit';
    if (s.includes('daily_limit') || s.includes('limit_reached')) return 'hh_limit_reached';
    if (s.includes('submit')) return 'error_submit_failed';
    if (s.includes('unconfirmed')) return 'error_unconfirmed';
    if (s.includes('page_error') || s.includes('error')) return 'error_page_failed';
    return `${defaultPrefix}_${s}`;
  }

  function checkSkipRateAnomaly(outcome, reason) {
    let total = toNum(storage.sessionGet(KEYS.sessionProcessedTotal), 0) + 1;
    storage.sessionSet(KEYS.sessionProcessedTotal, String(total));

    let anomalousSkips = toNum(storage.sessionGet(KEYS.sessionAnomalousSkips), 0);
    const r = String(reason || '');
    const isAnomalous = r === 'skip_reject_regex' || r === 'skip_unknown_page' || r.startsWith('error_');
    if (isAnomalous) {
      anomalousSkips++;
      storage.sessionSet(KEYS.sessionAnomalousSkips, String(anomalousSkips));
    }

    if (total >= 20 && (anomalousSkips / total) > SKIP_ALERT_RATIO) {
      const alertKey = KEYS.skipAlertShown;
      if (storage.sessionGet(alertKey) !== '1') {
        storage.sessionSet(alertKey, '1');
        hhaLog('warn', 'skip_rate_alert', {
          anomalousSkips,
          total,
          ratio: ((anomalousSkips / total) * 100).toFixed(1) + '%'
        });
        reportError(
          `Пропущено много вакансий (${anomalousSkips} из ${total}). Проверь лог`,
          'SKIP_RATE_ALERT',
          { skipped: anomalousSkips, total, ratio: anomalousSkips / total }
        );
      }
    }
  }

  function recordOutcome(vid, outcome, reason, details = null) {
    const clean = cleanVid(vid);
    const validOutcomes = ['applied', 'queued', 'skipped', 'error'];
    const finalOutcome = validOutcomes.includes(outcome) ? outcome : 'error';
    const finalReason = normalizeReasonCode(reason, finalOutcome === 'applied' ? 'applied' : (finalOutcome === 'queued' ? 'queued' : (finalOutcome === 'skipped' ? 'skip' : 'error')));

    // 1. Update daily counters
    const counters = getDailyCounters();
    if (finalOutcome in counters && finalOutcome !== 'date') {
      counters[finalOutcome]++;
      saveDailyCounters(counters);
    }

    // 2. Clear watchdog stall tracking for this vacancy upon outcome
    storage.sessionRemove(KEYS.watchdogStallCount);
    storage.sessionRemove(KEYS.watchdogStallVid);
    markProgress('outcome:' + finalOutcome);

    // 3. Log event
    const logLevel = finalOutcome === 'error' ? 'error' : (finalOutcome === 'skipped' ? 'warn' : 'info');
    const logData = {
      vid: clean || undefined,
      outcome: finalOutcome,
      reason: finalReason
    };
    if (details && typeof details === 'object') {
      Object.assign(logData, details);
    }
    hhaLog(logLevel, 'outcome', logData);

    // 4. Output summary to console
    console.info(`[HHA] summary applied=${counters.applied} queued=${counters.queued} skipped=${counters.skipped} error=${counters.error}`);

    // 5. Anomaly check for session-processed items (excluding already_applied and hidden_employer)
    checkSkipRateAnomaly(finalOutcome, finalReason);

    // 6. Emit event on event bus
    events.emit('outcome', {
      vid: clean,
      outcome: finalOutcome,
      reason: finalReason,
      counters
    });
  }

  // --- 6. Configuration ---
  function normalizeConfig(raw) {
    const m = { ...DEFAULTS, ...(raw || {}) };
    return {
      coverText: String(m.coverText ?? DEFAULT_COVER_TEXT).slice(0, MAX_COVER_LENGTH),
      useCover: m.useCover !== false,
      skipHidden: m.skipHidden !== false,
      limit: MAX_DAILY_LIMIT
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

  const timings = () => ACTION_TIMINGS;
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
    timer = setTimeout(() => { cleanup(); markProgress('wait_done'); resolve(); }, ms);
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
    if (field in s && field !== 'attempts') s[field] = (s[field] || 0) + by;
    s.attempts = (s.attempts || 0) + by;
    saveStats(s);
  }

  function resetStats() {
    return saveStats({ attempts: 0, success: 0, manual: 0, skipped: 0, startedAt: Date.now() });
  }

  // --- 8. Manual Queue Domain ---

  function normalizeManualEntry(entry) {
    if (!entry) return null;
    const rawVid = String(entry.vid || entry.id || '').trim();
    const vid = cleanVid(rawVid);
    if (!vid) return null;
    return {
      vid,
      url: toSafeHhUrl(entry.url || entry.href || ''),
      title: collapseSpaces(entry.title || ''),
      employer: collapseSpaces(entry.employer || ''),
      salary: collapseSpaces(entry.salary || ''),
      reason: collapseSpaces(entry.reason || entry.note || ''),
      addedAt: Number(entry.addedAt || entry.ts) || Date.now(),
      returnUrl: toSafeHhUrl(entry.returnUrl || ''),
      viewed: Boolean(entry.viewed),
      viewedAt: entry.viewedAt ? Number(entry.viewedAt) : null
    };
  }

  const ManualQueue = {
    get() {
      const raw = parseJson(storage.localGet(KEYS.manualList), []);
      return Array.isArray(raw) ? raw.map(normalizeManualEntry).filter(Boolean) : [];
    },
    has(vid) {
      const targetVid = cleanVid(vid);
      if (!targetVid) return false;
      return this.get().some(it => cleanVid(it.vid) === targetVid);
    },
    markViewed(vid, viewed = true) {
      const queue = this.get();
      const targetVid = cleanVid(vid);
      const idx = queue.findIndex(it => cleanVid(it.vid) === targetVid);
      if (idx >= 0) {
        const isChange = queue[idx].viewed !== Boolean(viewed);
        if (isChange) {
          queue[idx].viewed = Boolean(viewed);
          queue[idx].viewedAt = viewed ? Date.now() : null;
          storage.localSet(KEYS.manualList, JSON.stringify(queue));
          events.emit('manualQueue', { action: 'update', item: queue[idx], queue });
        }
        return true;
      }
      return false;
    },
    save(list) {
      const clean = Array.isArray(list) ? list.map(normalizeManualEntry).filter(Boolean) : [];
      const ok = storage.localSet(KEYS.manualList, JSON.stringify(clean));
      events.emit('manualQueue', { action: 'sync', queue: clean });
      return ok;
    },
    add(entry) {
      const item = normalizeManualEntry(entry);
      if (!item) return { success: false, isNew: false };
      const queue = this.get();
      const idx = queue.findIndex(it => it.vid === item.vid);
      const isNew = idx < 0;
      if (idx >= 0) queue[idx] = { ...queue[idx], ...item };
      else queue.unshift(item);
      const ok = storage.localSet(KEYS.manualList, JSON.stringify(queue));
      events.emit('manualQueue', { action: isNew ? 'add' : 'update', item, queue });
      return { success: Boolean(ok), isNew: Boolean(isNew) };
    },
    remove(vid) {
      const queue = this.get();
      const targetVid = cleanVid(vid);
      const filtered = queue.filter(it => cleanVid(it.vid) !== targetVid);
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

  const getSentCount = () => getDailyCounters().applied;
  function resetSentCount() {
    resetDailyCounters();
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

  // --- Attempts & Blacklist Tracking (Circuit Breaker) ---
  function getVacancyAttemptsMap() {
    const raw = storage.sessionGet(KEYS.attempts);
    return parseJson(raw, {}) || {};
  }

  function recordVacancyAttempt(vid) {
    if (!vid) return 1;
    const clean = cleanVid(vid);
    const map = getVacancyAttemptsMap();
    const count = (Number(map[clean]) || 0) + 1;
    map[clean] = count;
    storage.sessionSet(KEYS.attempts, JSON.stringify(map));
    return count;
  }

  function getBlacklistMap() {
    const raw = storage.localGet(KEYS.blacklist);
    const map = parseJson(raw, {}) || {};
    const now = Date.now();
    let changed = false;
    for (const k of Object.keys(map)) {
      const entry = map[k];
      const ts = typeof entry === 'object' && entry !== null ? Number(entry.ts) : Number(entry);
      if (!ts || (now - ts) > BLACKLIST_TTL) {
        delete map[k];
        changed = true;
      }
    }
    if (changed) {
      storage.localSet(KEYS.blacklist, JSON.stringify(map));
    }
    return map;
  }

  function isBlacklisted(vid) {
    if (!vid) return false;
    const clean = cleanVid(vid);
    const map = getBlacklistMap();
    return Boolean(map[clean]);
  }

  function addToBlacklist(vid, reason = 'apply_failed') {
    if (!vid) return;
    const clean = cleanVid(vid);
    const map = getBlacklistMap();
    map[clean] = { ts: Date.now(), reason: String(reason || '') };
    storage.localSet(KEYS.blacklist, JSON.stringify(map));
  }

  function handleVacancyFailure(vid, reason = 'apply_failed', runId = currentRunId, meta = null) {
    if (!vid) return returnToList(null, { markProcessed: false, runId });
    const clean = cleanVid(vid);
    const attempts = recordVacancyAttempt(clean);
    bumpStat('attempts');

    if (attempts >= MAX_VACANCY_ATTEMPTS) {
      addToBlacklist(clean, reason);
      markVacancyProcessed(clean, runId);
      markVacancyProcessed('v_' + clean, runId);
      saveCurrentForManual(
        clean,
        reason || 'apply_failed',
        runId,
        meta?.title || '',
        meta?.employer || '',
        meta?.salary || '',
        meta?.url || ''
      );
      reportError(`Вакансия #${clean} превысила лимит попыток (${attempts}/${MAX_VACANCY_ATTEMPTS}). Отправлена в ручную очередь и заблокирована на 24ч.`, 'MAX_ATTEMPTS_EXCEEDED', { vid: clean, attempts, reason });
      return returnToList(vid, { markProcessed: true, runId });
    } else {
      hhaLog('warn', 'attempt_failed', { vid: clean, attempts, maxAttempts: MAX_VACANCY_ATTEMPTS, reason: reason || 'apply_failed' });
      reportError(`Сбой при отклике на вакансию #${clean} (попытка ${attempts}/${MAX_VACANCY_ATTEMPTS}). Возврат к списку.`, 'VACANCY_ATTEMPT_FAILED', { vid: clean, attempts, reason });
      return returnToList(vid, { markProcessed: false, runId });
    }
  }

  function checkAndResetStallVid(newVid) {
    const cNew = cleanVid(newVid);
    const stored = cleanVid(storage.sessionGet(KEYS.watchdogStallVid) || '');
    if (stored && cNew && stored !== cNew) {
      storage.sessionRemove(KEYS.watchdogStallCount);
      storage.sessionRemove(KEYS.watchdogStallVid);
    }
  }

  const getReturnUrl = () => storage.sessionGet(KEYS.returnUrl) || '';
  const setReturnUrl = (url) => storage.sessionSet(KEYS.returnUrl, url);
  const clearReturnUrl = () => storage.sessionRemove(KEYS.returnUrl);

  const getLastAttemptID = () => storage.sessionGet(KEYS.lastAttempt) || null;
  const setLastAttemptID = (id) => {
    if (id) {
      checkAndResetStallVid(id);
      return storage.sessionSet(KEYS.lastAttempt, id);
    }
    return storage.sessionRemove(KEYS.lastAttempt);
  };
  const clearLastAttemptID = () => storage.sessionRemove(KEYS.lastAttempt);

  const getPendingVacancyMeta = (vid) => {
    const raw = storage.sessionGet(KEYS.pendingVacancyMeta);
    if (!raw) return null;
    const meta = parseJson(raw, null);
    if (!meta) return null;
    const cleanTarget = cleanVid(vid);
    if (cleanTarget && meta.vid && cleanVid(meta.vid) !== cleanTarget) return null;
    return meta;
  };
  const setPendingVacancyMeta = (meta) => (meta ? storage.sessionSet(KEYS.pendingVacancyMeta, JSON.stringify(meta)) : storage.sessionRemove(KEYS.pendingVacancyMeta));
  const clearPendingVacancyMeta = () => storage.sessionRemove(KEYS.pendingVacancyMeta);

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
    hhaLog('info', 'lock_acquire', { tabId, leaseId });
    return true;
  }

  async function releaseInstanceLock(tabId) {
    const cur = readInstanceLock();
    if (cur && cur.tabId === tabId) {
      storage.localRemove(KEYS.instanceLock);
    }
    currentLeaseId = null;
    instanceLeaseVerified = false;
    await releaseWebLock();
    hhaLog('info', 'lock_release', { tabId });
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
  let isNavigating = false;

  const isRunCurrent = (runId) => !stopSignal && (runId === undefined || runId === null || runId === currentRunId) && isRunning();

  function guardOwnedCommit(runId = currentRunId) {
    if (globalThis.__HHA_TEST__) return true;
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
    isNavigating = false;
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
    const statusKey = (code === 'DAILY_LIMIT_REACHED' || code === 'TARGET_LIMIT_REACHED' || code === 'DONE') ? 'done' : (isError ? 'error' : (code === 'STOPPED_BY_USER' ? 'stopped' : code.toLowerCase()));
    setStatus(statusKey, code, details);
    hhaLog(isError ? 'error' : 'info', 'stop', { code, logMsg: logMsg || undefined, isError });
    if (logMsg && isError) reportError(logMsg, code, details);
  }

  function finalizeRun(runId, statusKey, msg = '') {
    if (runId !== currentRunId) return;
    terminateRun(statusKey.toUpperCase(), msg, { message: msg }, statusKey === 'error');
  }

  function haltEngine(code, logMsg, details = {}) {
    terminateRun(code, logMsg, details, true);
  }

  const haltForCaptcha = () => {
    const vid = getLastAttemptID() || (globalThis.location && getVacancyIDFromHref(globalThis.location.href)) || null;
    recordOutcome(vid, 'error', 'error_captcha');
    haltEngine('CAPTCHA_DETECTED', 'Captcha detected on page. Automation halted.');
  };
  const haltForRateLimit = () => {
    const vid = getLastAttemptID() || (globalThis.location && getVacancyIDFromHref(globalThis.location.href)) || null;
    recordOutcome(vid, 'error', 'error_rate_limit');
    haltEngine('RATE_LIMITED', 'Rate limit detected. Automation halted.');
  };
  const haltForDailyLimit = (msg = `Достигнут суточный лимит HeadHunter: не более ${MAX_DAILY_LIMIT} откликов за 24 часа. Автоматизация остановлена.`) => {
    try {
      storage.localSet(KEYS.dailyLimitReached, Date.now());
    } catch (_) {}
    hhaLog('warn', 'hh_limit_reached', { limit: MAX_DAILY_LIMIT, source: 'hh_ui' });
    terminateRun('DAILY_LIMIT_REACHED', msg, { limit: MAX_DAILY_LIMIT, period: '24h' }, false);
  };
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

  const REVIEW_SELECTORS = '[data-qa*="review" i], [data-qa*="feedback" i], [data-qa*="big-widget" i], [data-qa*="dream" i], [class*="review" i], [class*="feedback" i], [class*="dream" i], a[href*="/reviews" i], a[href*="BigWidget" i]';

  function isReviewOrFeedbackElement(el) {
    if (!el || el === globalThis.document || el === globalThis.document?.body || el === globalThis.document?.documentElement) {
      return false;
    }
    if (el.closest?.(REVIEW_SELECTORS)) return true;
    if (el.matches?.('[role="dialog"], [data-qa*="modal" i], [class*="modal" i], [data-qa*="popup" i]')) {
      return Boolean(el.querySelector?.(REVIEW_SELECTORS));
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

  function detectRelocationWarning(root = globalThis.document) {
    const scope = root || globalThis.document;
    const direct = q('[data-qa="relocation-warning-confirm"]', scope);
    if (direct && isVisible(direct) && !isReviewOrFeedbackElement(direct)) return direct;

    const alert = q('[data-qa="magritte-alert"], [role="dialog"]', scope);
    if (alert && isVisible(alert) && !isReviewOrFeedbackElement(alert)) {
      const confirmBtn = q('[data-qa="relocation-warning-confirm"]', alert)
        || findPatternElement(alert, 'button, [role="button"]', /^вс[её]\s*равно(?:\s*откликнуться)?$/i, 35);
      if (confirmBtn && isVisible(confirmBtn)) return confirmBtn;
    }

    const title = q('[data-qa="relocation-warning-title"]', scope)
      || findPatternElement(scope, 'h1, h2, h3, div, p, span', /откликаетесь\s+на\s+вакансию\s+в\s+другой\s+стране|в\s+другой\s+стране/i, 80);
    if (title && isVisible(title)) {
      const container = title.closest?.('[data-qa="magritte-alert"], [role="dialog"]') || title.parentElement;
      if (container && !isReviewOrFeedbackElement(container)) {
        const confirmBtn = q('[data-qa="relocation-warning-confirm"]', container)
          || findPatternElement(container, 'button, [role="button"]', /^вс[её]\s*равно(?:\s*откликнуться)?$/i, 35)
          || findPatternElement(container, 'button, [role="button"]', /^(?:откликнуться|подтвердить)$/i, 35);
        if (confirmBtn && isVisible(confirmBtn)) return confirmBtn;
      }
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
        || findPatternElement(r, 'button, [role="button"], input[type="submit"]', /отправить|сохранить|откликнуться|send|submit|apply/i, 50);
      if (el && !el.closest?.('[data-qa*="vacancy-response-link"]')) return el;
      return null;
    },
    relocationBtn: (r) => detectRelocationWarning(r),
    rejectWarning: (r) => {
      const scope = (r && r !== globalThis.document && r !== globalThis.document?.body) ? r : q('[data-qa*="modal" i], [class*="modal" i], [data-qa*="popup" i], [class*="popup" i], [role="dialog"], [data-qa="bottom-sheet-content"], [role="alert"]');
      if (!scope) return null;
      return findPatternElement(scope, 'div, p, span, section', REJECT_REGEX, 250);
    },
    responseChat: (r) => findPatternElement(r, 'a, button', /чат|перейти в чат|сообщения|chat/i, 60),
    pagerNext: (r) => findPatternElement(r, 'a, button', /дальше|впер[её]д|следующая|next/i, 60)
  };

  async function selectResumeIfRequired(scope, runId) {
    const root = scope || globalThis.document?.body;
    let radios = qa('input[type="radio"][name*="resume" i], [data-qa*="select-resume" i] input[type="radio"], [data-qa*="resume" i] input[type="radio"]', root);
    if (!radios.length && q('[data-qa*="resume" i], [class*="resume" i]', root)) {
      radios = qa('input[type="radio"]', root);
    }
    if (radios.length > 0) {
      const isChecked = radios.some(r => r.checked || r.getAttribute('aria-checked') === 'true');
      if (!isChecked) {
        const target = radios[0].closest?.('label') || radios[0];
        await clickElement(target);
        await actionPause();
        return isRunCurrent(runId);
      }
    } else {
      const cards = qa('[data-qa*="resume-item" i], [data-qa*="resume-card" i], [class*="resume-item" i]', root);
      if (cards.length > 0) {
        const isSelected = cards.some(c => c.getAttribute('aria-selected') === 'true' || /selected|active/i.test(c.className || ''));
        if (!isSelected) {
          await clickElement(cards[0]);
          await actionPause();
          return isRunCurrent(runId);
        }
      }
    }
    return true;
  }

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

    reportError(msg, 'DOM_SELECTOR_NOT_FOUND', {
      key,
      selector: key,
      selectorName,
      expectedCss,
      heuristic,
      snippet,
      contextSnippet: snippet,
      url,
      sub,
      ...extra
    });
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
    if (!href) return null;
    const str = String(href);
    const redirectMatch = str.match(/[?&](?:vacancyId|utm_redirect_vacancy_id)=(\d+)|(?:vacancyId|utm_redirect_vacancy_id)%3D(\d+)/i);
    if (redirectMatch) return String(redirectMatch[1] || redirectMatch[2]);
    const pathMatch = str.match(/\/vacancy\/(\d+)|\/article\/(\d+)/i);
    return pathMatch ? String(pathMatch[1] || pathMatch[2]) : null;
  }

  function hashString(str) {
    let hash = 2166136261 >>> 0;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(36);
  }

  function getVacancyID(node) {
    const card = getVacancyCard(node);
    const link = card ? query('vacancyLink', card) : null;
    const href = link?.href || node?.href || node?.getAttribute?.('href') || '';
    const id = getVacancyIDFromHref(href);
    if (id) return 'v_' + id;
    const cardId = card?.dataset?.id || (card?.innerText ? card.innerText.slice(0, 80).trim() : '') || String(node?.className || 'unknown');
    return 'v_' + hashString(cardId);
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

    try { el.scrollIntoView?.({ block: 'center', behavior: 'auto' }); } catch (_) {}
    try { el.focus?.(); } catch (_) {}

    const win = globalThis.window || undefined;
    const downOpts = { bubbles: true, cancelable: true, composed: true, view: win, button: 0, buttons: 1 };
    const upOpts = { bubbles: true, cancelable: true, composed: true, view: win, button: 0, buttons: 0 };
    const pointerDownOpts = { ...downOpts, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const pointerUpOpts = { ...upOpts, pointerId: 1, pointerType: 'mouse', isPrimary: true };

    const dispatchPointerSequence = (target) => {
      if (!target) return;
      if (typeof PointerEvent !== 'undefined') {
        try { target.dispatchEvent(new PointerEvent('pointerdown', pointerDownOpts)); } catch (_) {}
      }
      if (typeof MouseEvent !== 'undefined') {
        try { target.dispatchEvent(new MouseEvent('mousedown', downOpts)); } catch (_) {}
      }
      if (typeof PointerEvent !== 'undefined') {
        try { target.dispatchEvent(new PointerEvent('pointerup', pointerUpOpts)); } catch (_) {}
      }
      if (typeof MouseEvent !== 'undefined') {
        try { target.dispatchEvent(new MouseEvent('mouseup', upOpts)); } catch (_) {}
      }
    };

    const innerTarget = el.querySelector?.('span, [class*="label" i], [class*="text" i], [class*="content" i]');
    if (innerTarget && innerTarget !== el) dispatchPointerSequence(innerTarget);
    dispatchPointerSequence(el);

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
          observer.observe(doc.documentElement || doc, { childList: true, subtree: true });
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
    isSearch: () => Boolean(globalThis.location && (globalThis.location.href?.includes('/search/vacancy') || globalThis.location.pathname?.startsWith('/search'))),
    isArticle: () => Boolean(globalThis.location?.pathname?.startsWith('/article/'))
  };

  function isLeadGenRedirect() {
    if (!globalThis.location) return false;
    if (Page.isArticle()) return true;
    const url = globalThis.location.href || '';
    return /utm_redirect_vacancy_id|utm_source=hh_lead_gen|hhtmFromLabel=vacancy_immediate_redirect/i.test(url);
  }

  function getLeadGenRedirectVacancyId() {
    if (!globalThis.location) return null;
    try {
      const sp = new URLSearchParams(globalThis.location.search || '');
      const redirectVid = sp.get('utm_redirect_vacancy_id');
      if (redirectVid) return 'v_' + cleanVid(redirectVid);
    } catch (_) {}
    const hrefId = getVacancyIDFromHref(globalThis.location.href);
    if (hrefId) return 'v_' + cleanVid(hrefId);
    return getLastAttemptID();
  }

  function isGenericVacancyTitle(text) {
    if (!text || typeof text !== 'string') return true;
    const trimmed = text.trim();
    return /^(?:отклик на вакансию|отклик без резюме|поиск вакансий|работа в |hh\.ru)/i.test(trimmed);
  }

  function parseVacancyTitle(vid) {
    if (Page.isSearch()) return '';
    const clean = cleanVid(vid);

    // On response form pages (/applicant/vacancy_response), h1 is usually "Отклик на вакансию".
    // Look for link to vacancy or specific title attributes.
    if (Page.isResponseForm()) {
      const linkToVac = q('a[data-qa="vacancy-response-link-view-topic"], a[href*="/vacancy/"], [data-qa="vacancy-title"], [data-qa*="vacancy-response-header"]');
      if (linkToVac) {
        const text = collapseSpaces(linkToVac.innerText || linkToVac.textContent);
        if (text && !isGenericVacancyTitle(text)) return text;
      }
      const header = q('[data-qa="bloko-header-2"], [data-qa="bloko-header-3"], [data-qa*="vacancy-response"] h2');
      if (header) {
        const text = collapseSpaces(header.innerText || header.textContent);
        if (text && !isGenericVacancyTitle(text)) return text;
      }
    }

    const titleEl = q('[data-qa="vacancy-title"]');
    if (titleEl && isVisible(titleEl)) {
      const text = collapseSpaces(titleEl.innerText || titleEl.textContent);
      if (text && !isGenericVacancyTitle(text)) return text;
    }

    const h1 = q('h1');
    if (h1 && isVisible(h1)) {
      const text = collapseSpaces(h1.innerText || h1.textContent);
      if (text && !isGenericVacancyTitle(text)) return text;
    }

    const og = q('meta[property="og:title"]');
    if (og) {
      const content = collapseSpaces(og.getAttribute('content'));
      if (content && !isGenericVacancyTitle(content)) {
        const cleanOg = content.replace(/^Вакансия\s+/i, '').split(/\s+в\s+компании\s+/i)[0].trim();
        if (cleanOg && !isGenericVacancyTitle(cleanOg)) return cleanOg;
      }
    }

    const docTitle = collapseSpaces(globalThis.document?.title);
    if (docTitle && !isGenericVacancyTitle(docTitle)) {
      const cleanDoc = docTitle.replace(/\s*—\s*hh\.ru.*$/i, '').replace(/\s*-\s*hh\.ru.*$/i, '').trim();
      if (cleanDoc && !isGenericVacancyTitle(cleanDoc)) return cleanDoc;
    }

    const pendingMeta = getPendingVacancyMeta(clean);
    if (pendingMeta && pendingMeta.title && !isGenericVacancyTitle(pendingMeta.title)) {
      return pendingMeta.title;
    }

    return clean ? `Вакансия #${clean}` : '';
  }

  function parseVacancyEmployer(root = globalThis.document) {
    if (!root || (root === globalThis.document && Page.isSearch())) return '';
    const candidates = root.querySelectorAll?.('[data-qa="vacancy-company-name"], [data-qa="vacancy-response-company-name"], [data-qa="vacancy-serp__vacancy-employer"], a[href*="/employer/"], [data-qa*="company-name"]');
    if (!candidates || candidates.length === 0) return '';
    for (const el of candidates) {
      const text = collapseSpaces(el.innerText || el.textContent);
      if (text && !/^(?:наши\s+вакансии|все\s+вакансии|вакансии\s+компании|отклик\s+на\s+вакансию)$/i.test(text)) {
        return text;
      }
    }
    return '';
  }

  function parseVacancySalary(root = globalThis.document) {
    if (!root || (root === globalThis.document && Page.isSearch())) return '';
    const el = root.querySelector?.('[data-qa="vacancy-salary"], [data-qa="vacancy-response-salary"], [data-qa="vacancy-serp__vacancy-compensation"], [data-qa*="vacancy-salary"]');
    return el ? collapseSpaces(el.innerText || el.textContent) : '';
  }

  function readSerpCardTitle(linkEl) {
    if (!linkEl) return '';
    const direct = collapseSpaces(linkEl.innerText || linkEl.textContent);
    if (direct) return direct;
    const card = getVacancyCard(linkEl);
    const link = card ? query('vacancyLink', card) : null;
    return link ? collapseSpaces(link.innerText || link.textContent) : '';
  }

  const INACCESSIBLE_VACANCY_REGEX = /(?:вам\s+недоступна\s+эта\s+вакансия|войдите\s+как\s+пользователь[,\s]+у\s+которого\s+есть\s+доступ|вакансия\s+(?:закрыта|в\s+архиве|удалена|не\s+найдена)|эта\s+вакансия\s+была\s+удалена|похоже[,\s]+этой\s+вакансии\s+больше\s+нет)/i;

  function detectInaccessibleVacancy(root = globalThis.document) {
    if (!root || Page.isSearch()) return false;
    const body = root.body || (root.nodeType === 9 ? root.body : root);
    if (!body) return false;
    const text = (body.textContent || '').slice(0, 4000);
    return INACCESSIBLE_VACANCY_REGEX.test(text);
  }

  function detectCaptcha() {
    const doc = globalThis.document, loc = globalThis.location;
    if (!doc) return false;
    if (detectInaccessibleVacancy(doc)) return false;
    if (loc && /\/captcha|\/checkpoint|\/nocaptcha/i.test(loc.pathname)) return true;
    if (q('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="captcha" i], iframe[src*="smartcaptcha" i], [data-qa*="captcha" i], .g-recaptcha, .h-captcha, .smart-captcha, [class*="captcha" i], [id*="captcha" i]')) {
      return true;
    }
    const bodyText = (doc.body?.textContent || doc.documentElement?.textContent || '').slice(0, 3000);
    return /(?:подтвердите,?\s*что\s*вы\s*не\s*робот|введите\s*символы\s*с\s*картинки|вы\s+не\s+робот|not\s+a\s+robot|необычн\w*\s+активн|unusual\s+(?:activity|traffic))/i.test(bodyText);
  }

  const DAILY_LIMIT_REGEX = /(?:исчерпали\s+лимит\s+откликов|не\s+более\s+200\s+откликов|в\s+течение\s+24\s+часов\s+можно\s+совершить\s+не\s+более|лимит\s+откликов[,\s]+попробуйте\s+отправить\s+отклик\s+позднее|лимит\s+откликов.*попробуйте|24\s+часов?\s+можно\s+совершить\s+не\s+более|вы\s+исчерпали\s+лимит|daily\s+application\s+limit|reached\s+(?:the\s+)?limit\s+of\s+(?:200\s+)?applications)/i;

  function detectDailyLimit(root = globalThis.document) {
    if (!root) return false;

    // 1. Check all notification, toast, alert, snackbar and modal scopes first
    const notificationSelectors = [
      '[role="alert"]',
      '[role="status"]',
      '[data-qa*="notification" i]',
      '[class*="notification" i]',
      '[data-qa*="toast" i]',
      '[class*="toast" i]',
      '[data-qa*="snackbar" i]',
      '[class*="snackbar" i]',
      '[data-qa*="popup" i]',
      '[class*="popup" i]',
      '[data-qa*="modal" i]',
      '[class*="modal" i]',
      '[data-qa*="bloko-notification" i]',
      '[data-qa="bottom-sheet-content"]'
    ].join(', ');

    const candidates = qa(notificationSelectors, root);
    for (const el of candidates) {
      if (isVisible(el)) {
        const text = (el.textContent || el.innerText || '').trim();
        if (text && DAILY_LIMIT_REGEX.test(text)) {
          return true;
        }
      }
    }

    // 2. Check top-level overlay containers and last appended elements of document.body
    const body = root.body || (root.nodeType === 9 ? root.body : root);
    if (body && body.children) {
      const children = Array.from(body.children);
      const startIdx = Math.max(0, children.length - 20);
      for (let i = children.length - 1; i >= startIdx; i--) {
        const child = children[i];
        if (isVisible(child)) {
          const txt = (child.textContent || '').trim();
          if (txt && DAILY_LIMIT_REGEX.test(txt)) {
            return true;
          }
        }
      }

      // 3. Fallback check across root textContent
      const fullText = (body.textContent || '');
      if (DAILY_LIMIT_REGEX.test(fullText)) {
        return true;
      }
    }

    return false;
  }

  function detectRateLimit() {
    const doc = globalThis.document, loc = globalThis.location;
    if (!doc) return false;
    if (loc && /\/error|\/blocked|\/forbidden|\/denied|\/rate-limit/i.test(loc.pathname)) return true;
    if (doc.title && /(?:429|503|error\s+(?:429|503)|доступ\s+ограничен|too\s+many\s+requests|service\s+unavailable)/i.test(doc.title)) return true;
    if (q('[data-qa="error-429"], [data-qa="error-503"], .error-429, .error-503, [data-qa="error-page-title"], [data-qa="error-page"], .error-page, .cf-browser-verification, #challenge-running, #cf-challenge-running, .qrator-challenge, #qrator-clean-page, [data-qa="bloko-notification--error"]', doc)) {
      return true;
    }
    const bodyText = (doc.body?.textContent || doc.documentElement?.textContent || '');
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
  const hasReliableRejectWarning = (root) => {
    const scope = (root && root !== globalThis.document && root !== globalThis.document?.body) ? root : q('[data-qa*="modal" i], [class*="modal" i], [data-qa*="popup" i], [class*="popup" i], [role="dialog"], [data-qa="bottom-sheet-content"], [role="alert"]');
    if (!scope) return false;
    const el = query('rejectWarning', scope);
    return Boolean(el && isVisible(el));
  };
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
    if (detectDailyLimit(modal) || detectDailyLimit()) return 'DAILY_LIMIT';
    const text = (modal.textContent || modal.innerText || '').slice(0, 3000);
    if (/резюме\s*скрыто|resume\s*is\s*hidden/i.test(text)) return 'RESUME_HIDDEN';
    if (q('[data-qa="response-reject-warning"]', modal)) return 'REJECT_WARNING';
    if (REJECT_REGEX.test(text)) return 'REJECT_REGEX';
    if (/тестирование|анкета|вопросы|questionnaire|test/i.test(text)) return 'TEST_REQUIRED';
    if (detectCaptcha() || /капч[аеы]|captcha|recaptcha|smartcaptcha/i.test(text)) return 'CAPTCHA';
    if (detectRateLimit() || /слишком\s*много\s*запросов|доступ\s*ограничен|rate\s*limit|blocked/i.test(text)) return 'RATE_LIMIT';
    return null;
  }


  function detectResponseOutcomeInRoot(root, includeExactSelectors) {
    if (!root || isReviewOrFeedbackElement(root)) return null;
    if (detectDailyLimit(root) || detectDailyLimit()) return 'DAILY_LIMIT';
    if (detectCaptcha()) return 'CAPTCHA';
    if (detectRateLimit()) return 'RATE_LIMIT';
    const warningEl = q('[data-qa="response-reject-warning"]', root);
    if (warningEl && isVisible(warningEl)) return 'REJECT_WARNING';
    if (hasReliableRejectWarning(root)) return 'REJECT_REGEX';
    if (detectRelocationWarning()) return 'RELOCATION_WARNING';

    const isResumeModal = Boolean(
      q('input[type="radio"][name*="resume" i], [data-qa*="select-resume" i], [data-qa*="resume-item" i]', root) ||
      /(?:выберите|выбор)\s+(?:подходящее\s+)?резюме|резюме\s+для\s+отклика/i.test(root.textContent || '')
    );

    if (includeExactSelectors && query('attachCoverBtn', root)) {
      return 'ATTACH_COVER';
    }
    if (includeExactSelectors && (query('responseChat', root) || hasResponseTextConfirmation(root))) {
      return 'SUCCESS';
    }
    if (query('letterTextarea', root) || query('attachCoverInModal', root) || query('letterSubmit', root) || q('[data-qa="vacancy-response-popup-form"]', root) || isResumeModal) {
      return 'MODAL_OPEN';
    }
    return null;
  }

  function detectResponseOutcomeOnce({ allowDocumentStrongText = false } = {}) {
    // 0. Daily limit reached check
    if (detectDailyLimit()) return 'DAILY_LIMIT';

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
    markVacancyProcessed(vid, runId);
    bumpStat('success');
    recordOutcome(vid, 'applied', 'applied_success');
    const cur = getSentCount();
    storage.sessionSet(KEYS.sentCount, String(cur));
    events.emit('progress', {
      sent: cur,
      limit: config.limit,
      percentage: Math.min(100, Math.round((cur / Math.max(1, config.limit)) * 100))
    });
    return true;
  }

  function skipVacancy(vid, reason = 'skip_reject_warning', runId = currentRunId) {
    if (runId !== undefined && runId !== null && !guardOwnedCommit(runId)) return false;
    markVacancyProcessed(vid, runId);
    bumpStat('skipped');
    recordOutcome(vid, 'skipped', reason);
  }

  function saveCurrentForManual(vid, note = '', runId = currentRunId, customTitle = '', customEmployer = '', customSalary = '', customUrl = '') {
    if (runId !== undefined && runId !== null && !guardOwnedCommit(runId)) return false;
    const origin = globalThis.location?.origin || 'https://hh.ru';
    const clean = cleanVid(vid);
    const url = customUrl ? toSafeHhUrl(customUrl) : (clean ? `${origin}/vacancy/${clean}` : (toSafeHhUrl(globalThis.location?.href) || `${origin}/search/vacancy`));
    let title = customTitle || '';
    let employer = customEmployer || '';
    let salary = customSalary || '';

    if (Page.isSearch() && clean) {
      const links = qa('a[data-qa="serp-item__title"], a[data-qa="vacancy-serp__vacancy-title"], a[href*="/vacancy/"]');
      for (const l of links) {
        if (getVacancyIDFromHref(l.href) === clean) {
          if (!title) title = readSerpCardTitle(l);
          const card = getVacancyCard(l);
          if (card) {
            if (!employer) employer = parseVacancyEmployer(card);
            if (!salary) salary = parseVacancySalary(card);
          }
          break;
        }
      }
    }
    if (!title || isGenericVacancyTitle(title)) {
      const meta = getPendingVacancyMeta(clean);
      if (meta && meta.title && !isGenericVacancyTitle(meta.title)) {
        title = meta.title;
        if (!employer && meta.employer) employer = meta.employer;
        if (!salary && meta.salary) salary = meta.salary;
      }
    }
    if (!title) {
      title = parseVacancyTitle(vid);
    }
    if (!employer && !Page.isSearch()) {
      employer = parseVacancyEmployer();
    }
    if (!salary && !Page.isSearch()) {
      salary = parseVacancySalary();
    }
    if (!employer || !salary) {
      const meta = getPendingVacancyMeta(clean);
      if (meta) {
        if (!employer && meta.employer) employer = meta.employer;
        if (!salary && meta.salary) salary = meta.salary;
      }
    }
    const entry = {
      vid: clean || ('v_' + Math.random().toString(36).slice(2, 10)),
      url,
      returnUrl: getReturnUrl(),
      reason: note,
      addedAt: Date.now(),
      title: title || (clean ? `Вакансия #${clean}` : 'Вакансия'),
      employer,
      salary
    };
    const res = ManualQueue.add(entry);
    if (res.success) {
      if (res.isNew) {
        bumpStat('manual');
        recordOutcome(clean, 'queued', note || 'manual');
      }
      return true;
    }
    return false;
  }

  function returnToList(vid, { markProcessed = true, runId = currentRunId } = {}) {
    if (runId !== undefined && runId !== null && !guardOwnedCommit(runId)) return false;
    if (isNavigating) return false;
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
    }
    if (markProcessed) {
      if (vid) markVacancyProcessed(vid, runId);
      const last = getLastAttemptID();
      if (last && last !== vid) markVacancyProcessed(last, runId);
    }
    clearLastAttemptID();
    const rawReturn = getReturnUrl();
    const origin = globalThis.location?.origin || 'https://hh.ru';
    const returnUrl = (rawReturn && (rawReturn.includes('/search/vacancy') || rawReturn.startsWith('http') || rawReturn.startsWith('/'))) ? rawReturn : `${origin}/search/vacancy`;
    const loc = globalThis.location;
    if (loc && !Page.isSearchList() && loc.href !== returnUrl) {
      isNavigating = true;
      setTimeout(() => { isNavigating = false; }, 7000);
      try { loc.assign(returnUrl); } catch (_) { loc.href = returnUrl; }
    }
    return true;
  }

  async function submitCoverLetterForm(scope = null, runId = currentRunId) {
    if (!isRunCurrent(runId)) return false;
    const ta = query('letterTextarea', scope);
    if (ta && config.useCover) {fillTextarea(ta, config.coverText);
      await actionPause();
      if (!isRunCurrent(runId)) return false;
    }
    const submit = query('letterSubmit', scope)
      || q('button[type="submit"]', scope);
    if (!submit) {
      reportError('Кнопка отправки формы сопроводительного письма не найдена', 'SUBMIT_BTN_NOT_FOUND');
      return false;
    }

    if (submit.disabled || submit.getAttribute?.('aria-disabled') === 'true') {
      await waitForCondition(() => !submit.disabled && submit.getAttribute?.('aria-disabled') !== 'true', 1500, activeAbortController?.signal);
      if (submit.disabled || submit.getAttribute?.('aria-disabled') === 'true') {
        reportError('Кнопка отправки письма остается неактивной (disabled) после ожидания, пробуем клик...', 'SUBMIT_BTN_STILL_DISABLED');
      }
    }

    const formId = submit.getAttribute?.('form');
    const form = (formId && globalThis.document?.getElementById(formId)) || submit.form || submit.closest?.('form');
    if (form && typeof form.requestSubmit === 'function') {
      try {
        form.requestSubmit(submit);
      } catch (_) {
        await clickElement(submit);
      }
    } else {
      await clickElement(submit);
    }

    await actionPause();
    return isRunCurrent(runId);
  }

  async function handleScenarioA(btn, runId = currentRunId) {
    if (!config.useCover) {
      return 'OK';
    }
    await actionPause();
    if (!isRunCurrent(runId)) return 'STOPPED';

    const attachBtn = btn || query('attachCoverBtn');
    if (attachBtn) {
      await clickElement(attachBtn);
    } else {
      reportError('Кнопка «Приложить сопроводительное письмо» не найдена', 'ATTACH_BTN_NOT_FOUND');
      notifySelectorFailure('attachCoverBtn', globalThis.document?.body);
      return isRunCurrent(runId) ? 'OK' : 'STOPPED';
    }

    await actionPause();
    if (!isRunCurrent(runId)) return 'STOPPED';
    const ta = await waitForElement('letterTextarea', 5000, activeAbortController?.signal);
    if (!ta) {
      reportError('Поле ввода письма не появилось за 5 с', 'LETTER_FORM_TIMEOUT');
      notifySelectorFailure('letterTextarea', globalThis.document?.body);
      return isRunCurrent(runId) ? 'OK' : 'STOPPED';
    }

    const modalScope = q('[data-qa="bottom-sheet-content"], [role="dialog"]') || globalThis.document?.body;
    await submitCoverLetterForm(modalScope, runId);
    if (!isRunCurrent(runId)) return 'STOPPED';
    await waitForCondition(() => {
      const sheet = q('[data-qa="bottom-sheet-content"]');
      const isSheetClosed = !sheet || !isVisible(sheet);
      return isSheetClosed || isResponseConfirmed({ allowDocumentStrongText: true });
    }, 5000, activeAbortController?.signal);
    return isRunCurrent(runId) ? 'OK' : 'STOPPED';
  }

  async function handleScenarioB(modal, runId = currentRunId) {
    if (detectDailyLimit(modal) || detectDailyLimit()) { haltForDailyLimit(); return 'BLOCKED'; }
    const blockReason = detectModalBlockReason(modal);
    if (blockReason === 'DAILY_LIMIT') { haltForDailyLimit(); return 'BLOCKED'; }
    if (blockReason === 'CAPTCHA') { haltForCaptcha(); return 'CAPTCHA'; }
    if (blockReason === 'RATE_LIMIT') { haltForRateLimit(); return 'BLOCKED'; }
    if (blockReason === 'TEST_REQUIRED' || blockReason === 'RESUME_HIDDEN') return blockReason;
    if (blockReason === 'REJECT_WARNING' || blockReason === 'REJECT_REGEX') {
      const closeBtn = q('[data-qa="vacancy-response-popup-close"], [data-qa*="close" i], button[aria-label*="закрыть" i]', modal);
      if (closeBtn) clickElement(closeBtn);
      return blockReason === 'REJECT_REGEX' ? 'SKIP_REJECT_REGEX' : 'SKIP_REJECT_WARNING';
    }

    if (hasReliableRejectWarning(modal)) {
      const closeBtn = q('[data-qa="vacancy-response-popup-close"], [data-qa*="close" i], button[aria-label*="закрыть" i]', modal);
      if (closeBtn) clickElement(closeBtn);
      const isWarningSelector = Boolean(q('[data-qa="response-reject-warning"]', modal));
      return isWarningSelector ? 'SKIP_REJECT_WARNING' : 'SKIP_REJECT_REGEX';
    }

    const resumeOk = await selectResumeIfRequired(modal, runId);
    if (!resumeOk || !isRunCurrent(runId)) return 'STOPPED';

    const attachCoverToggle = query('attachCoverInModal', modal)
      || findPatternElement(modal, 'button, [role="button"], a', /добавить\s+сопроводительное|написать\s+письмо/i, 35);
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

    const confirmed = await waitForCondition(
      () => {
        if (detectDailyLimit(modal) || detectDailyLimit()) return 'DAILY_LIMIT';
        return isResponseConfirmed();
      },
      6000,
      activeAbortController?.signal,
      'подтверждение отклика после отправки модалки'
    );
    if (confirmed === 'DAILY_LIMIT' || detectDailyLimit()) {
      haltForDailyLimit();
      return 'BLOCKED';
    }
    return confirmed ? 'OK' : 'FAIL';
  }

  async function dispatchOutcome(outcome, vid, runId, relocAttempts = 0) {
    if (!outcome) return 'FAIL';
    if (outcome === 'DAILY_LIMIT') { haltForDailyLimit(); return 'BLOCKED'; }
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
      } else if ((res === 'SKIP' || res === 'SKIP_REJECT_WARNING' || res === 'SKIP_REJECT_REGEX') && vid) {
        skipVacancy(vid, res === 'SKIP_REJECT_REGEX' ? 'skip_reject_regex' : 'skip_reject_warning', runId);
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

    if (outcome === 'REJECT_WARNING' || outcome === 'REJECT_REGEX') {
      const modal = q('[data-qa*="modal" i], [class*="modal" i], [role="dialog"]');
      if (modal) {
        const closeBtn = q('[data-qa="vacancy-response-popup-close"], [data-qa*="close" i], button[aria-label*="закрыть" i]', modal);
        if (closeBtn) clickElement(closeBtn);
      }
      if (vid) skipVacancy(vid, outcome === 'REJECT_REGEX' ? 'skip_reject_regex' : 'skip_reject_warning', runId);
      return 'SKIP';
    }

    if (outcome === 'RELOCATION_WARNING') {
      if (relocAttempts >= 2) {
        reportError('Превышен лимит попыток подтверждения релокации (loop guard)', 'RELOCATION_LOOP_GUARD', { vid, relocAttempts });
        if (vid) {
          saveCurrentForManual(vid, 'relocation_loop', runId);
          markVacancyProcessed(vid, runId);
        }
        return 'FAIL';
      }
      const relocBtn = detectRelocationWarning() || query('relocationBtn');
      if (relocBtn) {
        await clickElement(relocBtn);
        await actionPause();
        if (!isRunCurrent(runId)) return 'STOPPED';

        await waitForCondition(() => !detectRelocationWarning(), 4000, activeAbortController?.signal);
        const nextOutcome = await waitForCondition(() => (Page.isResponseForm() ? 'RESPONSE_FORM' : detectResponseOutcomeOnce()), 8000, activeAbortController?.signal);
        if (nextOutcome) {
          return await dispatchOutcome(nextOutcome, vid, runId, relocAttempts + 1);
        }
        if (isResponseConfirmed()) {
          if (vid) commitSuccess(vid, runId);
          return 'OK';
        }
        reportError('После закрытия предупреждения о релокации исход не подтвержден', 'RELOCATION_TIMEOUT', { vid });
        if (vid) {
          saveCurrentForManual(vid, 'relocation_timeout', runId);
          markVacancyProcessed(vid, runId);
        }
        return 'FAIL';
      }
      if (vid) {
        reportError('Не удалось найти кнопку подтверждения релокации', 'RELOCATION_BTN_NOT_FOUND', { vid });
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

    for (let i = 1; i <= steps; i++) {
      if (!isRunCurrent(runId)) {
        return;
      }
      const curY = Math.round((targetY / steps) * i);
      try {
        win.scrollTo({ top: curY, behavior: 'smooth' });
      } catch (_) {
        win.scroll?.(0, curY);
      }
      await wait(stepDelay);
    }
  }

  async function handleVacancyPage(vid, runId = currentRunId) {
    try {
      const pageUrl = globalThis.location?.href || '';

      if (detectInaccessibleVacancy()) {
        if (vid) skipVacancy(vid, 'access_denied', runId);
        returnToList(vid, { markProcessed: true, runId });
        return 'SKIP';
      }

      if (detectDailyLimit()) {
        haltForDailyLimit();
        return 'BLOCKED';
      }

      if (detectAlreadyApplied()) {
        if (vid) skipVacancy(vid, 'already_applied', runId);
        returnToList(vid, { markProcessed: true, runId });
        return 'OK';
      }

      // Simulate human-like reading (45-75% scroll with random stops)
      await simulateHumanReading(vid, runId);
      if (!isRunCurrent(runId)) return 'STOPPED';
      const applyBtn = await waitForCondition(() => query('vacancyApply'), 4000, activeAbortController?.signal);
      if (!applyBtn) {
        reportError(`Кнопка «Откликнуться» не найдена на странице вакансии #${vid}`, 'NO_APPLY_BUTTON', { vid, url: pageUrl });
        notifySelectorFailure('vacancyApply', globalThis.document?.body);
        if (vid) saveCurrentForManual(vid, 'no-apply-button', runId);
        returnToList(vid, { markProcessed: true, runId });
        return 'FAIL';
      }
      await actionPause();
      if (!isRunCurrent(runId)) return 'STOPPED';
      await clickElement(applyBtn);
      await actionPause();
      if (!isRunCurrent(runId)) return 'STOPPED';
      const inspectOutcome = () => {
        const domDiag = inspectOutcomeDomState();
        return { label: `исход отклика #${vid}`, vid, ...domDiag };
      };

      let outcome = await waitForCondition(
        () => {
          if (detectDailyLimit()) return 'DAILY_LIMIT';
          if (Page.isResponseForm()) return 'RESPONSE_FORM';
          return detectResponseOutcomeOnce();
        },
        3500,
        activeAbortController?.signal,
        inspectOutcome
      );

      if (outcome === 'DAILY_LIMIT' || detectDailyLimit()) {
        haltForDailyLimit();
        return 'BLOCKED';
      }

      // Direct Link Navigation Fallback: if no modal opened within 3.5s and button links to response page
      if (!outcome && !Page.isResponseForm()) {
        const directHref = applyBtn.getAttribute?.('href') || applyBtn.href;
        if (directHref && (directHref.includes('/applicant/vacancy_response') || directHref.includes('vacancy_response'))) {
          const fullTarget = directHref.startsWith('http') ? directHref : (new URL(directHref, globalThis.location?.origin || 'https://hh.ru').href);
          setTrapLock(45000, runId);
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
          () => {
            if (detectDailyLimit()) return 'DAILY_LIMIT';
            if (Page.isResponseForm()) return 'RESPONSE_FORM';
            return detectResponseOutcomeOnce();
          },
          4500,
          activeAbortController?.signal,
          inspectOutcome
        );
      }

      if (!outcome) {
        const finalDiag = inspectOutcomeDomState();
        reportError(`Таймаут ожидания исхода отклика на вакансию #${vid}!`, 'OUTCOME_TIMEOUT', { vid, ...finalDiag });
      }

      const res = await dispatchOutcome(outcome, vid, runId);
      if (['OK', 'SKIP', 'TEST_REQUIRED', 'RESUME_HIDDEN'].includes(res)) {
        await actionPause();
        returnToList(vid, { markProcessed: true, runId });
      } else if (res === 'FAIL') {
        await actionPause();
        return handleVacancyFailure(vid, 'apply_failed', runId);
      } else if (res !== 'RESPONSE_PAGE' && res !== 'STOPPED' && res !== 'CAPTCHA' && res !== 'BLOCKED') {
        await actionPause();
        return handleVacancyFailure(vid, `unexpected_${res}`, runId);
      }
      return res;
    } catch (e) {
      reportError(`Ошибка при обработке страницы вакансии #${vid}: ${(e && e.message) || e}`, 'VACANCY_PAGE_ERROR', { vid, error: String(e) });
      return handleVacancyFailure(vid, 'vacancy-page-error', runId);
    }
  }

  async function submitResponsePage(vid, runId = currentRunId) {
    if (!isRunCurrent(runId)) return;
    if (touchInstanceLock(TAB_ID) !== 'OWNED') return haltForLostInstanceLock();
    setStatus('running', 'SUBMITTING_RESPONSE_PAGE');
    handlingResponsePage = true;
    try {
      if (pageLooksLikeTest()) {
        saveCurrentForManual(vid, 'test-questionnaire', runId);
        return returnToList(vid, { markProcessed: true, runId });
      }

      const resumeOk = await selectResumeIfRequired(globalThis.document?.body, runId);
      if (!resumeOk || !isRunCurrent(runId)) return;

      // Cover letter toggle support
      const coverToggle = query('attachCoverInModal')
        || findPatternElement(globalThis.document?.body, 'button, [role="button"], a', /добавить\s+сопроводительное|написать\s+письмо/i, 35);
      if (coverToggle && config.useCover) {
        await clickElement(coverToggle);
        await actionPause();
        if (!isRunCurrent(runId)) return;
      }

      const submitBtn = await waitForCondition(
        () => query('letterSubmit') || q('button[type="submit"]'),
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
        if (detectDailyLimit()) {
          haltForDailyLimit();
          return;
        }
        reportError('Не удалось нажать кнопку отправки формы отклика', 'SUBMIT_FAILED', { vid });
        return handleVacancyFailure(vid, 'submit-form-failed', runId);
      }
      const confirmed = await waitForCondition(
        () => {
          if (detectDailyLimit()) return 'DAILY_LIMIT';
          return isResponseConfirmed({ allowDocumentStrongText: true });
        },
        6000,
        activeAbortController?.signal,
        `подтверждение отправки отклика #${vid}`
      );
      if (confirmed === 'DAILY_LIMIT' || detectDailyLimit()) {
        haltForDailyLimit();
        return;
      }
      if (!confirmed) {
        reportError(`Не удалось подтвердить отправку отклика #${vid}`, 'SUBMIT_UNCONFIRMED', { vid });
        return handleVacancyFailure(vid, 'unconfirmed', runId);
      }
      commitSuccess(vid, runId);
      returnToList(vid, { markProcessed: true, runId });
    } catch (e) {
      reportError(`Ошибка при обработке страницы отклика #${vid}: ${(e && e.message) || e}`, 'RESPONSE_PAGE_ERROR', { vid, error: String(e) });
      return handleVacancyFailure(vid, 'response-page-error', runId);
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

  async function navigateToNextSearchPage(nextBtn, runId) {
    if (!nextBtn) return;
    await actionPause();
    if (!isRunCurrent(runId)) return;
    const href = nextBtn.getAttribute?.('href') || nextBtn.href;
    if (href && globalThis.location) {
      setReturnUrl(href);
      try { globalThis.location.assign(href); } catch (_) { globalThis.location.href = href; }
    } else {
      clickElement(nextBtn);
    }
  }

  // --- 15. Main Execution Loop ---
  async function startLoop() {
    if (isLoopActive || isNavigating) return;
    if (Page.isResponseForm() && handlingResponsePage) return;
    const wasRunning = isRunning();
    isLoopActive = true;
    const runId = ++currentRunId;
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
    if (activeAbortController) { try { activeAbortController.abort(); } catch (_) {} }
    activeAbortController = new AbortController();
    stopSignal = false;

    setRunning(true);
    setStatus('running', 'LOOP_STARTING');
    markProgress('start_loop');
    hhaLog('info', 'start', { runId, limit: config.limit });

    const acquired = await acquireInstanceLock(TAB_ID);
    if (runId !== currentRunId || stopSignal || !isRunning()) {
      if (acquired) await releaseInstanceLock(TAB_ID);
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
        reportError(isBlocked ? 'Доступ к хранилищу заблокирован.' : 'Другая вкладка уже выполняет отклики. Запуск в текущей вкладке отменен.', isBlocked ? 'STORAGE_BLOCKED' : 'TAB_BUSY');
      }
      return;
    }

    if (!wasRunning) {
      resetSentCount();
      resetStats();
    }

    try {
      if (detectDailyLimit()) return haltForDailyLimit();
      if (detectInaccessibleVacancy()) {
        const vid = getLastAttemptID() || (globalThis.location && getVacancyIDFromHref(globalThis.location.href) && ('v_' + getVacancyIDFromHref(globalThis.location.href)));
        if (vid) skipVacancy(vid, 'skip_inaccessible', runId);
        returnToList(vid, { markProcessed: true, runId });
        return;
      }
      if (detectCaptcha()) return haltForCaptcha();
      if (detectRateLimit()) return haltForRateLimit();

      const initialSent = getSentCount();
      if (initialSent >= config.limit) return terminateRun('TARGET_LIMIT_REACHED', `Application limit reached: ${config.limit}`, { sent: initialSent, limit: config.limit }, false);

      if (Page.isResponseForm()) {
        if (handlingResponsePage) {
          isLoopActive = false;
          return;
        }
        const vid = getLastAttemptID() || (globalThis.location && getVacancyIDFromHref(globalThis.location.href) && ('v_' + getVacancyIDFromHref(globalThis.location.href)));
        try {
          await submitResponsePage(vid, runId);
        } finally {
          isLoopActive = false;
        }
        return;
      }

      if (Page.isVacancy()) {
        const vid = getStableVacancyId();
        setLastAttemptID(vid);
        const title = parseVacancyTitle(vid);
        const employer = parseVacancyEmployer();
        const salary = parseVacancySalary();
        if (title && !isGenericVacancyTitle(title)) {
          setPendingVacancyMeta({ vid, title, employer, salary });
        }
        const res = await handleVacancyPage(vid, runId);
        if (runId !== currentRunId) return;
        if (res === 'STOPPED' || stopSignal) return finalizeRun(runId, 'stopped', 'Processing stopped on vacancy page');
        if (res === 'BLOCKED') return;
        if (res === 'CAPTCHA') { haltForCaptcha(); return; }
        if (res === 'RESPONSE_PAGE' || Page.isResponseForm()) {
          setStatus('running', 'RESPONSE_PAGE');
          const vid = getLastAttemptID();
          if (Page.isResponseForm() && !handlingResponsePage) {
            handlingResponsePage = true;
            setTrapLock(45000, runId);
            try {
              await submitResponsePage(vid, runId);
            } finally {
              isLoopActive = false;
            }
          } else {
            isLoopActive = false;
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

      if (Page.isArticle() || isLeadGenRedirect()) {
        const vid = getLeadGenRedirectVacancyId();
        const currentUrl = globalThis.location?.href || '';
        if (vid) {
          saveCurrentForManual(vid, 'queued_promo', runId, '', '', '', currentUrl);
          markVacancyProcessed(vid, runId);
        }
        setStatus('running', 'WAITING_TO_RETURN');
        resumeTimer = setTimeout(() => {
          resumeTimer = null;
          if (isRunning()) returnToList(vid, { markProcessed: true, runId });
        }, 1500);
        return;
      }

      if (!Page.isSearch()) {
        const vid = getLastAttemptID();
        if (vid) skipVacancy(vid, 'skip_unknown_page', runId);
        returnToList(vid, { markProcessed: true, runId });
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
            await navigateToNextSearchPage(nextBtn, runId);
            return;
          }
          notifySelectorFailure('applyBtn', cards[0], { cardsCount: cards.length });
          recordOutcome(null, 'error', 'error_selector_missing');
          return finalizeRun(runId, 'error', 'Селектор applyBtn не найден на странице поиска');
        }
      }

      const processed = getProcessedIDs();
      const targets = [];

      for (const b of allBtns) {
        const vid = getVacancyID(b);
        if (config.skipHidden && !isVisible(b)) {
          markVacancyProcessed(vid, runId);
          recordOutcome(vid, 'skipped', 'skip_hidden_employer');
          continue;
        }
        if (processed.has(vid) || isBlacklisted(vid)) {
          continue;
        }
        targets.push(b);
      }

      if (!targets.length) {
        const nextBtn = query('pagerNext');
        if (nextBtn) {
          await navigateToNextSearchPage(nextBtn, runId);
          return;
        }
        const finalSent = getSentCount();
        return finalizeRun(runId, 'done', `Все вакансии в выдаче обработаны. Всего отправлено: ${finalSent}`);
      }

      const btn = targets[0];
      const card = getVacancyCard(btn);
      const link = card ? query('vacancyLink', card) : null;
      const vid = getStableVacancyId(btn);
      const title = card ? readSerpCardTitle(link) : '';
      const employer = card ? parseVacancyEmployer(card) : '';
      const salary = card ? parseVacancySalary(card) : '';
      setPendingVacancyMeta({ vid, title, employer, salary });
      const origin = globalThis.location?.origin || 'https://hh.ru';
      const rawTargetUrl = link?.href ? (new URL(link.href, origin)).href : (cleanVid(vid) ? `${origin}/vacancy/${cleanVid(vid)}` : null);
      const safeTargetUrl = toSafeHhUrl(rawTargetUrl);

      if (!rawTargetUrl) {
        reportError(`Не удалось определить URL для вакансии #${vid}`, 'VACANCY_URL_NOT_FOUND', { vid });
        recordOutcome(vid, 'error', 'error_selector_missing');
        handleVacancyFailure(vid, 'no_url', runId, { title, employer, salary });
        return;
      }

      if (!safeTargetUrl) {
        reportError(`Вакансия #${vid} ведет на сторонний внешний сайт (${rawTargetUrl}). Сохранена в ручную очередь.`, 'EXTERNAL_VACANCY_URL', { vid, targetUrl: rawTargetUrl });
        saveCurrentForManual(vid, 'queued_external_site', runId, title, employer, salary, rawTargetUrl);
        addToBlacklist(vid, 'external_site');
        markVacancyProcessed(vid, runId);
        return;
      }

      setLastAttemptID(vid);
      if (globalThis.location) setReturnUrl(globalThis.location.href);
      hhaLog('info', 'navigate_vacancy', { vid, url: safeTargetUrl });
      await vacancyPause();
      if (stopSignal || runId !== currentRunId) return;
      try {
        globalThis.location.assign(safeTargetUrl);
      } catch (_) {
        globalThis.location.href = safeTargetUrl;
      }
    } catch (e) {
      finalizeRun(runId, 'error', `Main loop error: ${(e && e.message) || e}`);
    }
  }

  // --- 16. Watchdog & Recovery ---
  function watchdogTick() {
    if (!isRunning()) return;
    if (detectDailyLimit()) return haltForDailyLimit();
    if (detectInaccessibleVacancy()) {
      const vid = getLastAttemptID();
      if (vid) skipVacancy(vid, 'skip_inaccessible', currentRunId);
      returnToList(vid, { markProcessed: true, runId: currentRunId });
      return;
    }
    if (detectCaptcha()) return haltForCaptcha();
    if (detectRateLimit()) return haltForRateLimit();
    if (touchInstanceLock(TAB_ID) !== 'OWNED') return haltForLostInstanceLock();

    // 60-second stall watchdog
    const now = Date.now();
    if ((now - lastProgressTs) > WATCHDOG_STALL_TIMEOUT) {
      const currentVid = cleanVid(getLastAttemptID() || (globalThis.location && getVacancyIDFromHref(globalThis.location.href)) || '');
      const storedVid = cleanVid(storage.sessionGet(KEYS.watchdogStallVid) || '');
      let stallCount = (storedVid === currentVid && currentVid) ? toNum(storage.sessionGet(KEYS.watchdogStallCount), 0) : 0;

      const elapsedMs = now - lastProgressTs;
      if (stallCount < 2) {
        stallCount++;
        storage.sessionSet(KEYS.watchdogStallVid, currentVid);
        storage.sessionSet(KEYS.watchdogStallCount, String(stallCount));
        lastProgressTs = now;
        hhaLog('warn', 'watchdog_stall', {
          vid: currentVid || undefined,
          stallCount,
          elapsedMs
        });
        try {
          globalThis.location?.reload();
        } catch (_) {}
        return;
      } else {
        storage.sessionRemove(KEYS.watchdogStallVid);
        storage.sessionRemove(KEYS.watchdogStallCount);
        hhaLog('error', 'watchdog_giveup', {
          vid: currentVid || undefined,
          stallCount,
          elapsedMs
        });
        recordOutcome(currentVid, 'error', 'error_timeout');
        terminateRun('WATCHDOG_GIVEUP', 'Зависание при обработке вакансии после 2 перезагрузок.', { vid: currentVid }, true);
        reportError('Зависание при обработке вакансии. Автоматизация остановлена после 2 перезагрузок.', 'WATCHDOG_GIVEUP', { vid: currentVid });
        return;
      }
    }

    if (Page.isArticle() || isLeadGenRedirect()) {
      if (isNavigating) return;
      const vid = getLeadGenRedirectVacancyId();
      const currentUrl = globalThis.location?.href || '';
      if (vid) {
        saveCurrentForManual(vid, 'queued_promo', currentRunId, '', '', '', currentUrl);
        markVacancyProcessed(vid, currentRunId);
      }
      returnToList(vid, { markProcessed: true, runId: currentRunId });
      return;
    }

    if (Page.isResponseForm()) {
      if (isNavigating || handlingResponsePage) return;
      if (isLoopActive) return;
      if (getActiveTrapLock()) return;
      if (currentRunId === 0) currentRunId = 1;
      setTrapLock(45000, currentRunId);
      const loc = globalThis.location;
      const vid = getLastAttemptID() || (loc && getVacancyIDFromHref(loc.href) && ('v_' + getVacancyIDFromHref(loc.href))) || null;
      if (!pageLooksLikeTest()) {
        if (handlingResponsePage) return;
        handlingResponsePage = true;
        submitResponsePage(vid, currentRunId);
        return;
      }
      handlingResponsePage = true;
      if (resumeTimer) {
        clearTimeout(resumeTimer);
        resumeTimer = null;
      }
      if (saveCurrentForManual(vid, 'queued_questionnaire', currentRunId)) {
        markVacancyProcessed(vid, currentRunId);
        returnToList(vid, { markProcessed: true, runId: currentRunId });
      }
    } else {
      clearTrapLock();
      handlingResponsePage = false;
    }

    // 15-second hang watchdog for any non-search page
    if (!Page.isSearch() && !isNavigating && (Date.now() - pageLoadedAt) > PAGE_WATCHDOG_TIMEOUT) {
      const vid = getLastAttemptID() || (globalThis.location && getVacancyIDFromHref(globalThis.location.href) && ('v_' + getVacancyIDFromHref(globalThis.location.href))) || null;
      reportError(`Страница не ответила за ${PAGE_WATCHDOG_TIMEOUT / 1000} секунд. Принудительный возврат к поиску.`, 'PAGE_HANG_TIMEOUT', { vid, url: globalThis.location?.href });
      handleVacancyFailure(vid, 'error_timeout', currentRunId);
      return;
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

  function resetSessionCounters() {
    storage.sessionRemove(KEYS.sessionProcessedTotal);
    storage.sessionRemove(KEYS.sessionAnomalousSkips);
    storage.sessionRemove(KEYS.skipAlertShown);
  }

  // --- 17. Public API ---
  const HHApplyAssistant = {
    version: VERSION,
    start: () => startLoop(),
    stop: (code = 'STOPPED_BY_USER', reason = '') => terminateRun(code, reason || (code === 'STOPPED_BY_USER' ? 'Automation stopped by user' : code), {}, false),
    completeLimit: (reason = 'Application limit reached') => terminateRun('TARGET_LIMIT_REACHED', reason, { sent: getSentCount(), limit: config.limit }, false),
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
    async resetState() {
      if (isLoopActive) terminateRun('STOPPED_BY_USER', 'Stopped for reset', {}, false);
      stopSignal = true;
      isNavigating = false;
      handlingResponsePage = false;
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
      if (activeAbortController) { try { activeAbortController.abort(); } catch (_) {} activeAbortController = null; }
      setRunning(false);
      currentRunId = 0;
      await releaseInstanceLock(TAB_ID);
      clearLastAttemptID();
      clearTrapLock();
      clearReturnUrl();
      clearPendingVacancyMeta();
      resetSessionCounters();
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
      resetDailyCounters();
      resetSessionCounters();
      resetStats();
      return true;
    },
    getManualQueue: () => ManualQueue.get(),
    addManualItem: (entry) => Boolean(ManualQueue.add(entry).success),
    removeManualItem: (vid) => ManualQueue.remove(vid),
    clearManualQueue: () => ManualQueue.clear(),
    markManualItemViewed: (vid, viewed) => ManualQueue.markViewed(vid, viewed),
    isManualItem: (vid) => ManualQueue.has(vid),
    detectDailyLimit: () => detectDailyLimit(),
    on: (evt, fn) => events.on(evt, fn),
    off: (evt, fn) => events.off(evt, fn),
    once: (evt, fn) => events.once(evt, fn),
    destroy: () => teardownRuntime(),

    // Reliability & Diagnostic exports
    REJECT_REGEX,
    SKIP_ALERT_RATIO,
    MAX_VACANCY_ATTEMPTS,
    WATCHDOG_STALL_TIMEOUT,
    recordOutcome: (vid, outcome, reason, details) => recordOutcome(vid, outcome, reason, details),
    hhaLog: (level, event, data) => hhaLog(level, event, data),
    getLogBuffer: () => readLogBuffer(),
    clearLogBuffer: () => hhaClearLog(),
    hhaDumpLog: () => hhaDumpLog(),
    getDailyCounters: () => getDailyCounters(),
    resetDailyCounters: () => resetDailyCounters(),
    resetSessionCounters: () => resetSessionCounters(),
    markProgress: (step) => markProgress(step),
    parseVacancyTitle: (card) => parseVacancyTitle(card),
    cleanVid: (vid) => cleanVid(vid),
    normalizeReasonCode: (reason, prefix) => normalizeReasonCode(reason, prefix),
    handleVacancyFailure: (vid, reason, runId, meta) => handleVacancyFailure(vid, reason, runId, meta),
    watchdogTick: () => watchdogTick(),
    haltForDailyLimit: () => haltForDailyLimit()
  };

  // --- 18. Bootstrap & Global Binding ---
  function bootstrap() {
    if (globalThis.__HHA_TEST__) return;
    if (watchdogIntervalId === null) {
      watchdogIntervalId = setInterval(() => {
        try { watchdogTick(); } catch (e) { console.warn('[HH] Watchdog tick error:', e); }
      }, 1000);
    }

    const daily = getDailyCounters();
    hhaLog('info', 'page_start', {
      version: VERSION,
      path: (globalThis.location && globalThis.location.pathname) || '',
      state: isRunning() ? 'running' : 'idle',
      applied: daily.applied,
      queued: daily.queued,
      skipped: daily.skipped,
      error: daily.error
    });
    markProgress('bootstrap');

    if (isRunning()) {
      if (detectDailyLimit()) {
        haltForDailyLimit();
        return;
      }
      const lock = readInstanceLock();
      const now = Date.now();
      if (lock && isLiveLock(lock, now) && lock.tabId !== TAB_ID) {
        setRunning(false);
        setStatus('idle', 'TAB_BUSY', { message: 'Другая вкладка уже активна' });
      } else {
        setStatus('running', 'AUTO_STARTING');
        resumeTimer = setTimeout(() => {
          resumeTimer = null;
          if (isRunning()) startLoop();
        }, 1500);
      }
    }
    if (!Page.isResponseForm()) clearTrapLock();

    // Cross-tab auto-detection: if viewing an item from manual queue, mark viewed (or remove if applied)
    if (Page.isVacancy() || Page.isResponseForm()) {
      const currentVid = getStableVacancyId() || getLastAttemptID();
      if (currentVid && ManualQueue.has(currentVid)) {
        ManualQueue.markViewed(currentVid, true);
        if (detectAlreadyApplied()) {
          ManualQueue.remove(currentVid);
        }
      }
    }

    const win = globalThis.window;
    if (win) {
      win.hhaDumpLog = hhaDumpLog;
      win.hhaClearLog = hhaClearLog;
      if (typeof win.dispatchEvent === 'function') {
        try { win.dispatchEvent(new CustomEvent('hha:ready', { detail: HHApplyAssistant })); } catch (_) {}
      }
    }
    if (typeof globalThis.hhaDumpLog === 'undefined') globalThis.hhaDumpLog = hhaDumpLog;
    if (typeof globalThis.hhaClearLog === 'undefined') globalThis.hhaClearLog = hhaClearLog;

    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('HH Apply Assistant: Показать лог (JSONL)', () => {
          console.info(hhaDumpLog());
        });
        GM_registerMenuCommand('HH Apply Assistant: Очистить лог', () => {
          hhaClearLog();
        });
      }
    } catch (_) {}
  }

  const doc = globalThis.document;
  if (globalThis.__HHA_TEST__) {
    // In test environment, skip DOM bootstrap and observers
  } else if (doc?.body) {
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
  }

  const win = globalThis.window;
  if (win && typeof win.addEventListener === 'function') {
    function isUserscriptOrigin(filename, stack) {
      if (!filename && !stack) return false;
      const combined = `${filename || ''}\n${stack || ''}`;
      if (/hh\.ru\/(?:js|static|web\/build)|yandex|google|sentry|mail\.ru|criteo|doubleclick/i.test(combined) &&
          !/hh-apply-assistant|HhaHud|HHApplyAssistant/i.test(combined)) {
        return false;
      }
      const scriptMarkers = [
        'hh-apply-assistant',
        'HHApplyAssistant',
        'HhaHud',
        'hha-hud',
        'submitResponsePage',
        'watchdogTick',
        'startLoop',
        'handleVacancyPage',
        'clickElement',
        'waitForCondition',
        'queryAll',
        'tampermonkey',
        'violentmonkey',
        'greasemonkey'
      ];
      return scriptMarkers.some(m => combined.includes(m));
    }

    addGlobalListener(win, 'error', (event) => {
      const filename = event.filename || '';
      const stack = (event.error && event.error.stack) || '';
      if (!isUserscriptOrigin(filename, stack)) return;
      const msg = event.message || (event.error && event.error.message) || 'Unknown window error';
      const lineno = event.lineno || 0;
      const colno = event.colno || 0;
      reportError(`[Глобальная ошибка] ${msg} (${filename}:${lineno}:${colno})`, 'GLOBAL_UNCAUGHT_ERROR', {
        error: msg, filename, lineno, colno, stack
      });
    });
    addGlobalListener(win, 'unhandledrejection', (event) => {
      const reason = event.reason;
      const stack = (reason && reason.stack) || '';
      const filename = (reason && (reason.fileName || reason.filename)) || '';
      if (!isUserscriptOrigin(filename, stack)) return;
      const msg = (reason && (reason.message || reason.stack)) || String(reason) || 'Unhandled promise rejection';
      reportError(`[Необработанный Promise rejection] ${msg}`, 'GLOBAL_UNHANDLED_REJECTION', {
        error: msg, stack
      });
    });
    addGlobalListener(win, 'pageshow', (e) => {
      if (e.persisted && isRunning()) {
        isLoopActive = false;
        isNavigating = false;
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
    if (module.exports && module.exports.version) {
      module.exports.HhaHud = factory();
    } else {
      module.exports = factory();
    }
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

  const ERROR_TITLES = {
    GLOBAL_UNCAUGHT_ERROR: 'Внутренний сбой интерфейса',
    GLOBAL_UNHANDLED_REJECTION: 'Сбой асинхронной операции',
    DOM_SELECTOR_NOT_FOUND: 'Элемент страницы не найден',
    SUBMIT_BTN_NOT_FOUND: 'Кнопка отправки не найдена',
    SUBMIT_BTN_STILL_DISABLED: 'Кнопка отправки заблокирована',
    ATTACH_BTN_NOT_FOUND: 'Кнопка прикрепления письма не найдена',
    LETTER_FORM_TIMEOUT: 'Форма письма не открылась вовремя',
    RELOCATION_LOOP_GUARD: 'Зацикливание предупреждения о релокации',
    RELOCATION_TIMEOUT: 'Таймаут подтверждения релокации',
    RELOCATION_BTN_NOT_FOUND: 'Кнопка релокации не найдена',
    NO_APPLY_BUTTON: 'Кнопка отклика недоступна',
    OUTCOME_TIMEOUT: 'Превышено время ожидания отклика',
    VACANCY_FAILED: 'Не удалось отправить отклик',
    VACANCY_UNEXPECTED_RESULT: 'Неожиданный ответ страницы',
    VACANCY_PAGE_ERROR: 'Ошибка на странице вакансии',
    SUBMIT_FAILED: 'Сбой при отправке отклика',
    SUBMIT_UNCONFIRMED: 'Отправка отклика не подтвердилась',
    RESPONSE_PAGE_ERROR: 'Сбой на странице отклика',
    STORAGE_BLOCKED: 'Доступ к хранилищу заблокирован',
    TAB_BUSY: 'Скрипт уже запущен в другой вкладке',
    VACANCY_URL_NOT_FOUND: 'Не удалось определить ссылку вакансии',
    DAILY_LIMIT_REACHED: 'Достигнут лимит откликов на сегодня',
    MAX_ATTEMPTS_EXCEEDED: 'Превышен лимит попыток отклика',
    VACANCY_ATTEMPT_FAILED: 'Сбой отклика (повторим позже)',
    PAGE_HANG_TIMEOUT: 'Страница вакансии зависла',
    EXTERNAL_VACANCY_URL: 'Вакансия ведет на внешний сайт'
  };

  function formatHumanError(code, rawMessage) {
    const title = ERROR_TITLES[code];
    let cleanMsg = String(rawMessage || '').trim();
    cleanMsg = cleanMsg.replace(/^\[(?:Глобальная ошибка|Необработанный Promise rejection)\]\s*/i, '');
    cleanMsg = cleanMsg.replace(/\s*\([^)]*(?:userscript\.html|chrome-extension:)[^)]*\)\s*$/i, '');
    cleanMsg = cleanMsg.replace(/^Uncaught\s+/i, '');
    cleanMsg = cleanMsg.replace(/^ReferenceError:\s*/i, 'Сбой выполнения: ');
    cleanMsg = cleanMsg.replace(/^TypeError:\s*/i, 'Ошибка типа данных: ');
    cleanMsg = collapseSpaces(cleanMsg);

    if (title && cleanMsg) {
      if (cleanMsg.length > 70 || /^[a-z_]+$/i.test(cleanMsg)) return title;
      return `${title}: ${cleanMsg}`;
    }
    return title || cleanMsg || 'Произошла ошибка при выполнении';
  }

  function formatQueueReason(reason) {
    const r = String(reason || '').toLowerCase();
    if (r.includes('lead_gen') || r.includes('article') || r.includes('promo')) {
      return 'Промо / Лид';
    }
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
    if (r.includes('access_denied') || r.includes('inaccessible')) {
      return 'Закрыта';
    }
    return 'Ручной';
  }

  function formatQueueReasonInfo(reason) {
    const r = String(reason || '').toLowerCase();
    if (r.includes('lead_gen') || r.includes('article') || r.includes('promo')) {
      return { text: 'Промо / Лид', type: 'neutral' };
    }
    if (r.includes('access_denied') || r.includes('inaccessible')) {
      return { text: 'Нет доступа', type: 'error' };
    }
    if (r.includes('test') || r.includes('questionnaire') || r.includes('questions')) {
      return { text: 'Тест / анкета', type: 'info' };
    }
    if (r.includes('relocation')) {
      return { text: 'Релокация', type: 'info' };
    }
    if (r.includes('no-apply') || r.includes('no-submit') || r.includes('redirect')) {
      return { text: 'Нет кнопки', type: 'neutral' };
    }
    if (r.includes('external')) {
      return { text: 'Внешний сайт', type: 'neutral' };
    }
    if (r.includes('failed') || r.includes('error') || r.includes('max_retries') || r.includes('timeout') || r.includes('hang')) {
      return { text: 'Сбой отклика', type: 'error' };
    }
    if (r.includes('unconfirmed')) {
      return { text: 'Не подтверждено', type: 'neutral' };
    }
    if (r.includes('already')) {
      return { text: 'Уже откликались', type: 'neutral' };
    }
    return { text: 'Ручной отклик', type: 'info' };
  }

  function toVacancyUrl(vid, url) {
    const clean = cleanVid(vid);
    const origin = (typeof globalThis !== 'undefined' && globalThis.location?.origin) || 'https://hh.ru';
    if (clean) return `${origin}/vacancy/${clean}`;
    if (url && !url.includes('/applicant/vacancy_response')) return url;
    return url || '';
  }

  // --- 2. SVG Icons ---

  const ICONS = {
    play: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>`,
    stop: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>`,
    check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>`,
    reset: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>`,
    copy: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`,
    open: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>`,
    alert: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`,
    inboxEmpty: `<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v3.01c0 .72.43 1.34 1.04 1.63L3 20c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2l-.04-11.36c.61-.29 1.04-.91 1.04-1.63V4c0-1.1-.9-2-2-2zm-1 18H5l.04-11H19l-.04 11zM19 7H5V4h14v3zm-3 5H8v-2h8v2z"/></svg>`,
    close: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>`
  };

  // --- 3. Shadow DOM Stylesheet ---

  const STYLES = `
    /* ═══════════════════════════════════════════════════════════════
       1. HOST & MATERIAL DESIGN 3 DESIGN TOKENS
       Specification: https://m3.material.io/
       Token Names: https://m3.material.io/foundations/design-tokens
       Color Roles: https://m3.material.io/styles/color/system/overview
       Tonal Palette Seed: #006A60 (M3 Teal Baseline) via Theme Builder
       Typography: https://m3.material.io/styles/typography/type-scale-tokens
       Shape Scale: https://m3.material.io/styles/shape/shape-scale-tokens
       Elevation: https://m3.material.io/styles/elevation/tokens
       ═══════════════════════════════════════════════════════════════ */
    :host {
      all: initial;
      position: fixed;
      z-index: 2147483640;
      font-family: var(--md-sys-typescale-font-family);
      font-size: var(--md-sys-typescale-body-small-size);
      line-height: var(--md-sys-typescale-body-small-line-height);
      color: var(--md-sys-color-on-surface);
      box-sizing: border-box;
      user-select: none;
      -webkit-user-select: none;
      -webkit-font-smoothing: antialiased;
      pointer-events: auto;
      interpolate-size: allow-keywords;

      /* ── M3 Color System: Light Scheme (Seed: #006A60 Teal) ── */
      --md-sys-color-primary: #006A60;
      --md-sys-color-on-primary: #FFFFFF;
      --md-sys-color-primary-container: #BCECE3;
      --md-sys-color-on-primary-container: #00201D;
      --md-sys-color-inverse-primary: #52DBC7;

      --md-sys-color-secondary: #4A635F;
      --md-sys-color-on-secondary: #FFFFFF;
      --md-sys-color-secondary-container: #CCE8E2;
      --md-sys-color-on-secondary-container: #05201C;

      --md-sys-color-tertiary: #456179;
      --md-sys-color-on-tertiary: #FFFFFF;
      --md-sys-color-tertiary-container: #CCE5FF;
      --md-sys-color-on-tertiary-container: #001D31;

      --md-sys-color-error: #BA1A1A;
      --md-sys-color-on-error: #FFFFFF;
      --md-sys-color-error-container: #FFDAD6;
      --md-sys-color-on-error-container: #410002;

      --md-sys-color-background: #FAFDFB;
      --md-sys-color-on-background: #191C1B;
      --md-sys-color-surface: #FAFDFB;
      --md-sys-color-on-surface: #191C1B;
      --md-sys-color-surface-variant: #DAE5E1;
      --md-sys-color-on-surface-variant: #3F4946;

      --md-sys-color-outline: #707976;
      --md-sys-color-outline-variant: #E2E7E5;

      /* M3 Surface Container Roles (Tonal Elevation) */
      --md-sys-color-surface-container-lowest: #FFFFFF;
      --md-sys-color-surface-container-low: #F6F8F7;
      --md-sys-color-surface-container: #F0F4F2;
      --md-sys-color-surface-container-high: #EEF1EF;
      --md-sys-color-surface-container-highest: #E4E8E6;
      --md-sys-color-surface-dim: #D8DBD9;
      --md-sys-color-surface-bright: #FAFDFB;

      --md-sys-color-inverse-surface: #2E3130;
      --md-sys-color-inverse-on-surface: #EFF1EF;

      /* M3 Extended Semantic Roles: Warning (Harmonized with palette) */
      --md-custom-color-warning: #505F5C;
      --md-custom-color-on-warning: #FFFFFF;
      --md-custom-color-warning-container: #DAE5E1;
      --md-custom-color-on-warning-container: #191C1B;

      /* ── M3 Shape Scale ── */
      --md-sys-shape-corner-none: 0px;
      --md-sys-shape-corner-extra-small: 4px;
      --md-sys-shape-corner-small: 8px;
      --md-sys-shape-corner-medium: 12px;
      --md-sys-shape-corner-large: 16px;
      --md-sys-shape-corner-extra-large: 22px;
      --md-sys-shape-corner-full: 9999px;

      /* ── M3 Elevation (Soft Ambient Drop Shadows - No Dirty Halo) ── */
      --md-sys-elevation-level0: none;
      --md-sys-elevation-level1: 0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.04);
      --md-sys-elevation-level2: 0 4px 14px -1px rgba(0, 0, 0, 0.07), 0 2px 5px -1px rgba(0, 0, 0, 0.04);
      --md-sys-elevation-level3: 0 12px 28px -4px rgba(0, 0, 0, 0.08), 0 4px 10px -2px rgba(0, 0, 0, 0.03);
      --md-sys-elevation-level4: 0 16px 36px -4px rgba(0, 0, 0, 0.10), 0 6px 14px -2px rgba(0, 0, 0, 0.04);
      --md-sys-elevation-level5: 0 24px 48px -4px rgba(0, 0, 0, 0.12), 0 8px 20px -2px rgba(0, 0, 0, 0.05);

      /* ── M3 State Layer Opacities ── */
      --md-sys-state-hover-state-layer-opacity: 0.08;
      --md-sys-state-focus-state-layer-opacity: 0.12;
      --md-sys-state-pressed-state-layer-opacity: 0.12;
      --md-sys-state-dragged-state-layer-opacity: 0.16;

      /* ── Modern Apple HIG / iOS Typography Scale ── */
      --md-sys-typescale-font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      --md-sys-typescale-font-family-mono: 'SF Mono', 'SFMono-Regular', ui-monospace, Menlo, Monaco, Consolas, monospace;

      --md-sys-typescale-title-small-size: 14px;
      --md-sys-typescale-title-small-line-height: 20px;
      --md-sys-typescale-title-small-weight: 600;
      --md-sys-typescale-title-small-tracking: -0.15px;

      --md-sys-typescale-title-medium-size: 16px;
      --md-sys-typescale-title-medium-line-height: 22px;
      --md-sys-typescale-title-medium-weight: 600;
      --md-sys-typescale-title-medium-tracking: -0.2px;

      --md-sys-typescale-body-large-size: 15px;
      --md-sys-typescale-body-large-line-height: 22px;
      --md-sys-typescale-body-large-weight: 400;
      --md-sys-typescale-body-large-tracking: -0.1px;

      --md-sys-typescale-body-medium-size: 13px;
      --md-sys-typescale-body-medium-line-height: 18px;
      --md-sys-typescale-body-medium-weight: 400;
      --md-sys-typescale-body-medium-tracking: -0.05px;

      --md-sys-typescale-body-small-size: 12px;
      --md-sys-typescale-body-small-line-height: 16px;
      --md-sys-typescale-body-small-weight: 400;
      --md-sys-typescale-body-small-tracking: 0;

      --md-sys-typescale-label-large-size: 14px;
      --md-sys-typescale-label-large-line-height: 18px;
      --md-sys-typescale-label-large-weight: 600;
      --md-sys-typescale-label-large-tracking: -0.15px;

      --md-sys-typescale-label-medium-size: 12px;
      --md-sys-typescale-label-medium-line-height: 16px;
      --md-sys-typescale-label-medium-weight: 600;
      --md-sys-typescale-label-medium-tracking: -0.05px;

      --md-sys-typescale-label-small-size: 11px;
      --md-sys-typescale-label-small-line-height: 14px;
      --md-sys-typescale-label-small-weight: 600;
      --md-sys-typescale-label-small-tracking: 0;

      /* Control Height (M3 Compact Standard) */
      --md-comp-control-height: 32px;

      /* ── M3 Motion Tokens: Easing ── */
      --md-sys-motion-easing-linear: cubic-bezier(0, 0, 1, 1);
      --md-sys-motion-easing-standard: cubic-bezier(0.2, 0, 0, 1);
      --md-sys-motion-easing-standard-accelerate: cubic-bezier(0.3, 0, 1, 1);
      --md-sys-motion-easing-standard-decelerate: cubic-bezier(0, 0, 0.2, 1);
      --md-sys-motion-easing-emphasized: cubic-bezier(0.2, 0, 0, 1);
      --md-sys-motion-easing-emphasized-accelerate: cubic-bezier(0.3, 0, 0.8, 0.15);
      --md-sys-motion-easing-emphasized-decelerate: cubic-bezier(0.05, 0.7, 0.1, 1);

      /* ── M3 Motion Tokens: Duration ── */
      --md-sys-motion-duration-short1: 50ms;
      --md-sys-motion-duration-short2: 100ms;
      --md-sys-motion-duration-short3: 150ms;
      --md-sys-motion-duration-short4: 200ms;
      --md-sys-motion-duration-medium1: 250ms;
      --md-sys-motion-duration-medium2: 300ms;
      --md-sys-motion-duration-medium3: 350ms;
      --md-sys-motion-duration-medium4: 400ms;
      --md-sys-motion-duration-long1: 450ms;
      --md-sys-motion-duration-long2: 500ms;

      /* ── Centralized HUD Motion Specification Tokens ── */
      --hha-motion-expand-duration: 320ms;
      --hha-motion-expand-easing: cubic-bezier(0.16, 1, 0.3, 1);
      --hha-motion-spring-easing: cubic-bezier(0.34, 1.15, 0.64, 1);
      --hha-motion-collapse-duration: 220ms;
      --hha-motion-collapse-easing: cubic-bezier(0.36, 0, 0.66, -0.05);
      --hha-motion-tab-duration: 150ms;
      --hha-motion-tab-easing: cubic-bezier(0.2, 0, 0, 1);
      --hha-motion-tab-shift: 6px;
      --hha-motion-indicator-duration: 200ms;
      --hha-motion-indicator-easing: cubic-bezier(0.2, 0, 0, 1);

      /* Centralized Layout Padding Token */
      --hha-content-padding-x: 12px;

      /* Dynamic Island Shared Element Layout Tokens */
      --pill-width: 166px;
      --flyout-width: min(390px, calc(100vw - 16px));
      --shared-counter-offset: calc((var(--flyout-width, 390px) - var(--pill-width, 166px)) / 2 - var(--hha-content-padding-x, 12px));
      --shared-btn-offset: calc(-1 * var(--shared-counter-offset));
    }

    /* ── M3 Color System: Dark Scheme (Activated only via explicit dark-mode class) ── */

    :host-context(body.dark-mode),
    :host-context(.dark-mode),
    :host-context([data-theme="dark"]),
    :host(.dark-mode) {
      --md-sys-color-primary: #52DBC7;
      --md-sys-color-on-primary: #003731;
      --md-sys-color-primary-container: #005048;
      --md-sys-color-on-primary-container: #70F7E6;
      --md-sys-color-inverse-primary: #006A60;

      --md-sys-color-secondary: #B1CCC6;
      --md-sys-color-on-secondary: #1C3531;
      --md-sys-color-secondary-container: #324B47;
      --md-sys-color-on-secondary-container: #CCE8E2;

      --md-sys-color-tertiary: #AECACF;
      --md-sys-color-on-tertiary: #173338;
      --md-sys-color-tertiary-container: #2E4A4E;
      --md-sys-color-on-tertiary-container: #CCE5FF;

      --md-sys-color-error: #FFB4AB;
      --md-sys-color-on-error: #690005;
      --md-sys-color-error-container: #93000A;
      --md-sys-color-on-error-container: #FFDAD6;

      --md-sys-color-background: #0E1513;
      --md-sys-color-on-background: #DEE4E1;
      --md-sys-color-surface: #0E1513;
      --md-sys-color-on-surface: #DEE4E1;
      --md-sys-color-surface-variant: #3F4946;
      --md-sys-color-on-surface-variant: #BEC9C5;

      --md-sys-color-outline: #89938F;
      --md-sys-color-outline-variant: #3F4946;

      --md-sys-color-surface-container-lowest: #090F0E;
      --md-sys-color-surface-container-low: #171D1B;
      --md-sys-color-surface-container: #1B2120;
      --md-sys-color-surface-container-high: #252B2A;
      --md-sys-color-surface-container-highest: #303635;
      --md-sys-color-surface-dim: #0E1513;
      --md-sys-color-surface-bright: #353B39;

      --md-sys-color-inverse-surface: #DEE4E1;
      --md-sys-color-inverse-on-surface: #2B3230;

      --md-custom-color-warning: #BCEBE2;
      --md-custom-color-on-warning: #003731;
      --md-custom-color-warning-container: #334B46;
      --md-custom-color-on-warning-container: #DAE5E1;
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
      display: grid;
      place-items: end center;
      gap: 0;
      padding: 0;
      margin: 0;
      font-size: 0;
      line-height: 0;
      pointer-events: none;
      transition: none;
      transform: translateX(-50%);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: optimizeLegibility;
    }

    .hha-root > * {
      grid-area: 1 / 1;
      justify-self: center;
      align-self: end;
    }

    .hha-root.is-snapping {
      transition: left 240ms cubic-bezier(0.05, 0.7, 0.1, 1),
                  top 240ms cubic-bezier(0.05, 0.7, 0.1, 1),
                  bottom 240ms cubic-bezier(0.05, 0.7, 0.1, 1) !important;
    }

    .hha-root.dir-up {
      place-items: end center;
    }

    .hha-root:not(.dir-up) {
      place-items: start center;
    }

    /* ─── 3. PILL (DYNAMIC ISLAND) ────────────────────────────────── */
    .hha-pill {
      font-family: var(--md-sys-typescale-font-family);
      font-size: var(--md-sys-typescale-body-small-size);
      line-height: var(--md-sys-typescale-body-small-line-height);
      pointer-events: auto;
      display: inline-flex;
      align-items: center;
      height: 40px;
      width: fit-content;
      min-width: auto;
      max-width: min(390px, calc(100vw - 16px));
      padding: 4px;
      gap: 6px;
      border-radius: var(--md-sys-shape-corner-full);
      border: 1px solid var(--md-sys-color-outline-variant);
      background: var(--md-sys-color-surface-container-lowest);
      box-sizing: border-box;
      overflow: hidden;
      box-shadow: var(--md-sys-elevation-level2);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      cursor: grab;
      touch-action: none;
      white-space: nowrap;
      position: relative;
      z-index: 2;
      opacity: 1;
      visibility: visible;
      transform: scale(1) translate3d(0, 0, 0);
      transform-origin: center bottom;
      will-change: transform, opacity;
      transition: 
        opacity 140ms ease-out 70ms,
        transform 200ms cubic-bezier(0.34, 1.25, 0.64, 1) 60ms,
        visibility 0s linear 70ms,
        box-shadow var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard), 
        border-color var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard),
        background-color var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-standard);
    }

    .hha-pill:active {
      cursor: grabbing;
    }

    .hha-root.is-expanded .hha-pill {
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transform: translate3d(0, 0, 0);
      transition:
        opacity 60ms ease-out 0s,
        transform 80ms ease-out 0s,
        visibility 0s linear 60ms;
    }

    .hha-pill-status-group {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: grab;
      user-select: none;
      position: relative;
      overflow: hidden;
      isolation: isolate;
      border-radius: var(--md-sys-shape-corner-full);
      height: var(--md-comp-control-height);
      min-height: var(--md-comp-control-height);
      padding: 0 10px 0 12px;
      background: transparent;
      border: none;
      box-sizing: border-box;
      line-height: 1;
      vertical-align: middle;
      outline: none;
      transition: 
        background-color var(--md-sys-motion-duration-medium1) var(--md-sys-motion-easing-standard), 
        box-shadow var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard),
        transform var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
    }

    .hha-pill-status-group:hover,
    .hha-root.is-expanded .hha-pill-status-group {
      background: var(--md-sys-color-surface-container-low);
    }

    .hha-pill-status-group:active,
    .hha-root.is-dragging .hha-pill-status-group {
      background: var(--md-sys-color-surface-container);
      cursor: grabbing;
    }


    .hha-pill-status {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 44px;
      height: var(--md-comp-control-height);
      min-height: var(--md-comp-control-height);
      box-sizing: border-box;
      padding: 0 2px;
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
      background: var(--md-sys-color-secondary-container);
      opacity: 0.75;
      border-radius: var(--md-sys-shape-corner-full);
      z-index: 1;
      pointer-events: none;
      transition: width var(--md-sys-motion-duration-medium4) var(--md-sys-motion-easing-emphasized-decelerate);
    }

    .hha-pill-progress {
      font-size: var(--md-sys-typescale-label-medium-size);
      font-weight: var(--md-sys-typescale-label-medium-weight);
      letter-spacing: var(--md-sys-typescale-label-medium-tracking);
      color: var(--md-sys-color-on-surface-variant);
      font-variant-numeric: tabular-nums;
      position: relative;
      z-index: 2;
    }

    .hha-current-count {
      font-weight: 700;
      color: var(--md-sys-color-primary);
      transition: color var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-standard);
    }

    .hha-pill-limit-val {
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      color: var(--md-sys-color-on-surface-variant);
    }

    .hha-pill-status-group.has-error .hha-current-count {
      color: var(--md-sys-color-error);
    }

    .hha-pill-error-dot {
      display: none !important;
    }

    /* Pill Contextual Queue Badge */
    .hha-pill-queue-badge {
      display: inline-flex;
      height: var(--md-comp-control-height);
      min-height: var(--md-comp-control-height);
      box-sizing: border-box;
      align-items: center;
      justify-content: center;
      padding: 0 0 2px 0;
      border-radius: var(--md-sys-shape-corner-full);
      background: var(--md-sys-color-surface-container-high);
      color: var(--md-sys-color-on-surface);
      border: none;
      font-size: var(--md-sys-typescale-label-small-size);
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
      max-width: 0;
      opacity: 0;
      margin-left: -6px;
      overflow: hidden;
      visibility: hidden;
      pointer-events: none;
      transform: scale(0.7);
      will-change: width, max-width, opacity, margin-left, transform;
      transition: 
        width var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-emphasized-accelerate),
        max-width var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-emphasized-accelerate),
        margin-left var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-emphasized-accelerate),
        padding var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-emphasized-accelerate),
        opacity var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard),
        transform var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-emphasized-accelerate),
        background-color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard),
        color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard),
        visibility 0s linear var(--md-sys-motion-duration-short4);
    }

    .hha-pill-queue-badge.is-visible {
      width: 32px;
      min-width: 0;
      max-width: 32px;
      padding: 0 0 2px 0;
      margin-left: 0;
      opacity: 1;
      transform: scale(1);
      visibility: visible;
      pointer-events: auto;
      transition: 
        width var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-emphasized-decelerate),
        max-width var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-emphasized-decelerate),
        margin-left var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-emphasized-decelerate),
        padding var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-emphasized-decelerate),
        opacity var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard),
        transform var(--md-sys-motion-duration-medium1) var(--md-sys-motion-easing-emphasized-decelerate),
        background-color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard),
        color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard),
        visibility 0s linear 0s;
    }

    .hha-pill-queue-badge.is-visible.is-wide {
      width: 40px;
      max-width: 48px;
      padding: 0 6px 2px 6px;
    }

    .hha-pill-queue-badge:hover {
      background: var(--md-sys-color-primary-container);
      color: var(--md-sys-color-on-primary-container);
    }

    .hha-pill-queue-badge:active {
      transform: scale(0.92);
    }

    .hha-pill-queue-badge.is-popping {
      animation: hhaBadgePop var(--md-sys-motion-duration-medium1) var(--md-sys-motion-easing-emphasized);
    }

    /* ─── 4. QUICK ACTION BUTTON ──────────────────────────────────── */
    .hha-btn-start,
    .hha-btn-stop,
    .hha-btn-done,
    .hha-btn-error,
    .hha-btn-quick {
      margin-left: auto;
      width: 76px;
      min-width: 76px;
      max-width: 76px;
      flex: 0 0 76px;
      padding: 0 4px;
      border-radius: var(--md-sys-shape-corner-full);
      border: none;
      font-family: var(--md-sys-typescale-font-family);
      font-size: var(--md-sys-typescale-label-medium-size);
      font-weight: var(--md-sys-typescale-label-medium-weight);
      letter-spacing: var(--md-sys-typescale-label-medium-tracking);
      line-height: 1;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0;
      height: var(--md-comp-control-height);
      box-sizing: border-box;
      vertical-align: middle;
      position: relative;
      overflow: hidden;
      transition: 
        background-color var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-standard), 
        color var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-standard), 
        box-shadow var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard), 
        transform var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
    }

    .hha-btn-label {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: -1.5px;
      white-space: nowrap;
      transition: 
        transform var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-emphasized-decelerate),
        opacity var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard);
    }

    .hha-btn-label.is-swapping {
      transform: translateY(3px);
      opacity: 0;
    }

    .hha-pill .hha-btn-quick {
      opacity: 1;
      transition:
        opacity 140ms ease-out 60ms,
        background-color var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-standard), 
        color var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-standard), 
        box-shadow var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard), 
        transform var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
    }

    .hha-root.is-expanded .hha-pill .hha-btn-quick {
      opacity: 0;
      transition: opacity 50ms ease-out 0s;
    }

    /* M3 Filled Button for Start (Primary Role) */
    .hha-btn-start {
      background: var(--md-sys-color-primary);
      color: var(--md-sys-color-on-primary);
      box-shadow: var(--md-sys-elevation-level1);
    }

    .hha-btn-start:hover {
      background: color-mix(in srgb, var(--md-sys-color-primary) 92%, var(--md-sys-color-on-primary));
      box-shadow: var(--md-sys-elevation-level2);
      color: var(--md-sys-color-on-primary);
    }

    .hha-btn-start:active {
      background: color-mix(in srgb, var(--md-sys-color-primary) 88%, var(--md-sys-color-on-primary));
      box-shadow: var(--md-sys-elevation-level1);
      transform: scale(0.97);
    }

    /* M3 Filled Button for Stop (Error Role) */
    .hha-btn-stop {
      background: var(--md-sys-color-error);
      color: var(--md-sys-color-on-error);
      box-shadow: var(--md-sys-elevation-level1);
    }

    .hha-btn-stop:hover {
      background: color-mix(in srgb, var(--md-sys-color-error) 92%, var(--md-sys-color-on-error));
      box-shadow: var(--md-sys-elevation-level2);
      color: var(--md-sys-color-on-error);
    }

    .hha-btn-stop:active,
    .hha-btn-stop:focus-visible {
      background: color-mix(in srgb, var(--md-sys-color-error) 88%, var(--md-sys-color-on-error));
      box-shadow: var(--md-sys-elevation-level1);
      color: var(--md-sys-color-on-error);
      transform: scale(0.97);
    }

    /* Living Breathing Indicator when Automation is Running */
    .hha-root.is-running .hha-pill-progress-fill {
      animation: hhaProgressBreathe 2.4s ease-in-out infinite;
    }

    .hha-root.is-running .hha-btn-stop {
      animation: hhaStopPulse 2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }

    @keyframes hhaProgressBreathe {
      0%, 100% {
        opacity: 0.65;
      }
      50% {
        opacity: 0.95;
      }
    }

    @keyframes hhaStopPulse {
      0%, 100% {
        box-shadow: 0 0 0 0 color-mix(in srgb, var(--md-sys-color-error) 45%, transparent);
      }
      50% {
        box-shadow: 0 0 0 5px color-mix(in srgb, var(--md-sys-color-error) 15%, transparent);
      }
    }

    /* M3 Filled Success Button for Done / Limit Reached */
    .hha-btn-done {
      background: var(--md-sys-color-primary);
      color: var(--md-sys-color-on-primary);
      border: none;
      box-shadow: var(--md-sys-elevation-level1);
    }

    .hha-btn-done:hover {
      background: color-mix(in srgb, var(--md-sys-color-primary) 92%, var(--md-sys-color-on-primary));
      box-shadow: var(--md-sys-elevation-level2);
      color: var(--md-sys-color-on-primary);
    }

    .hha-btn-done:active {
      background: color-mix(in srgb, var(--md-sys-color-primary) 88%, var(--md-sys-color-on-primary));
      box-shadow: var(--md-sys-elevation-level1);
      transform: scale(0.97);
    }

    /* M3 Filled Error Button for Error / Reset State */
    .hha-btn-error {
      background: var(--md-sys-color-error);
      color: var(--md-sys-color-on-error);
      box-shadow: var(--md-sys-elevation-level1);
    }

    .hha-btn-error:hover {
      background: color-mix(in srgb, var(--md-sys-color-error) 92%, var(--md-sys-color-on-error));
      box-shadow: var(--md-sys-elevation-level2);
      color: var(--md-sys-color-on-error);
    }

    .hha-btn-error:active,
    .hha-btn-error:focus-visible {
      background: color-mix(in srgb, var(--md-sys-color-error) 88%, var(--md-sys-color-on-error));
      box-shadow: var(--md-sys-elevation-level1);
      transform: scale(0.97);
      color: var(--md-sys-color-on-error);
    }

    .hha-btn-quick:disabled,
    .hha-btn-quick.is-disabled {
      opacity: 0.38;
      cursor: not-allowed;
      pointer-events: none;
      box-shadow: none;
    }

    /* ─── 5. FLYOUT PANEL (DYNAMIC ISLAND EXPANDED SURFACE) ───────── */
    .hha-root[data-active-tab="settings"] {
      --flyout-height: min(320px, calc(100vh - 100px));
    }

    .hha-root[data-active-tab="queue"] {
      --flyout-height: min(520px, calc(100vh - 100px));
    }

    .hha-flyout {
      font-family: var(--md-sys-typescale-font-family);
      font-size: var(--md-sys-typescale-body-small-size);
      line-height: var(--md-sys-typescale-body-small-line-height);
      pointer-events: none;
      width: min(390px, calc(100vw - 16px));
      max-width: calc(100vw - 16px);
      height: var(--flyout-height, 320px);
      min-height: var(--flyout-height, 320px);
      max-height: min(var(--flyout-height, 320px), calc(100vh - 100px));
      box-sizing: border-box;
      background: var(--md-sys-color-surface-container);
      border: 1px solid var(--md-sys-color-outline-variant);
      border-radius: 20px;
      box-shadow: var(--md-sys-elevation-level2);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      overflow-x: hidden;
      padding-top: 0;
      position: relative;
      margin: 0;
      opacity: 0;
      visibility: hidden;
      z-index: 1;
      transform-origin: center bottom;
      transform: scale(calc(var(--pill-width, 196px) / 390px), calc(40px / var(--flyout-height, 320px)));
      will-change: transform, opacity, border-radius, box-shadow, height, min-height, max-height;
      backface-visibility: hidden;
      transition:
        height 280ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        min-height 280ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        max-height 280ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        transform var(--hha-motion-collapse-duration, 220ms) var(--hha-motion-collapse-easing, cubic-bezier(0.36, 0, 0.66, -0.05)),
        opacity var(--hha-motion-collapse-duration, 220ms) ease-out,
        border-radius var(--hha-motion-collapse-duration, 220ms) var(--hha-motion-collapse-easing, cubic-bezier(0.36, 0, 0.66, -0.05)),
        box-shadow var(--hha-motion-collapse-duration, 220ms) var(--hha-motion-collapse-easing, cubic-bezier(0.36, 0, 0.66, -0.05)),
        visibility 0s linear var(--hha-motion-collapse-duration, 220ms);
    }

    .hha-root.dir-up .hha-flyout {
      transform-origin: center bottom;
    }

    .hha-root:not(.dir-up) .hha-flyout {
      transform-origin: center top;
    }

    .hha-root.is-animating .hha-panel,
    .hha-root.is-animating .hha-log-stream,
    .hha-root:not(.is-expanded) .hha-panel,
    .hha-root:not(.is-expanded) .hha-log-stream {
      overflow: hidden !important;
      overflow-y: hidden !important;
    }

    .hha-root.is-animating .hha-panel::-webkit-scrollbar,
    .hha-root:not(.is-expanded) .hha-panel::-webkit-scrollbar {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
    }

    .hha-root.is-animating .hha-overlay-scrollbar,
    .hha-root:not(.is-expanded) .hha-overlay-scrollbar {
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }

    .hha-root.is-expanded .hha-flyout {
      border-radius: var(--md-sys-shape-corner-extra-large);
      box-shadow: var(--md-sys-elevation-level3);
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      z-index: 3;
      transform: scale(1) translate3d(0, 0, 0);
      transition:
        height 280ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        min-height 280ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        max-height 280ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        transform var(--hha-motion-expand-duration, 360ms) var(--hha-motion-expand-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        opacity 180ms ease-out 0s,
        border-radius var(--hha-motion-expand-duration, 360ms) var(--hha-motion-expand-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        box-shadow var(--hha-motion-expand-duration, 360ms) var(--hha-motion-expand-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        visibility 0s linear 0s;
    }

    /* ─── Inner Elements Unified Synchronous Transitions ─── */
    .hha-flyout .hha-island-header {
      flex-shrink: 0;
      opacity: 0;
      transform: translate3d(0, -8px, 0) scale(0.96);
      transition: opacity 140ms ease-out, transform 140ms ease-out;
    }

    .hha-root.is-expanded .hha-island-header {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
      transition: opacity 220ms ease-out 50ms, transform 300ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)) 50ms;
    }

    .hha-flyout .hha-panels {
      opacity: 0;
      transform: translate3d(0, 10px, 0) scale(0.94);
      transition: opacity 140ms ease-out, transform 140ms ease-out;
    }

    .hha-root.is-expanded .hha-panels {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
      transition: opacity 220ms ease-out 60ms, transform 320ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)) 60ms;
    }

    .hha-flyout .hha-island-footer {
      opacity: 0;
      transform: translate3d(0, 0, 0);
      transition: opacity 140ms ease-out, transform 140ms ease-out;
    }

    .hha-root.is-expanded .hha-island-footer {
      opacity: 1;
      transform: translate3d(0, 0, 0);
      transition: opacity 180ms ease-out 40ms, transform 300ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)) 40ms;
    }

    .hha-root.is-expanded .hha-panel.active .hha-card:nth-child(1),
    .hha-root.is-expanded .hha-panel.active .hha-card:nth-child(2),
    .hha-root.is-expanded .hha-panel.active .hha-log-card {
      animation: none !important;
    }

    /* ─── 5.1 ISLAND HEADER (M3 COMPACT BAR) ───────────────────────── */
    .hha-island-header {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      height: 42px;
      min-height: 42px;
      padding: 0 12px;
      background: var(--md-sys-color-surface-container-low);
      border-bottom: 1px solid var(--md-sys-color-outline-variant);
      border-radius: var(--md-sys-shape-corner-extra-large) var(--md-sys-shape-corner-extra-large) 0 0;
      gap: 8px;
      user-select: none;
      cursor: grab;
      touch-action: none;
      box-sizing: border-box;
      flex-shrink: 0;
      position: relative;
    }

    .hha-island-header:active {
      cursor: grabbing;
    }

    .hha-header-drag-handle {
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      z-index: 0;
    }

    .hha-header-grip {
      width: 32px;
      height: 4px;
      border-radius: 2px;
      background: var(--md-sys-color-outline-variant);
      transition: background-color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard), width var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard);
    }

    .hha-island-header:hover .hha-header-grip {
      background: var(--md-sys-color-outline);
      width: 40px;
    }

    .hha-btn-collapse {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      min-width: 28px;
      min-height: 28px;
      border-radius: var(--md-sys-shape-corner-full);
      background: transparent;
      border: none;
      color: var(--md-sys-color-on-surface-variant);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      padding: 0;
      line-height: 1;
      position: relative;
      z-index: 1;
      transition: background-color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard), color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard), transform var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
    }

    .hha-btn-collapse:hover {
      background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
      color: var(--md-sys-color-on-surface);
    }

    .hha-btn-collapse:active {
      transform: scale(0.92);
      background: color-mix(in srgb, var(--md-sys-color-on-surface) 12%, transparent);
    }

    /* ─── 6. BOTTOM NAVIGATION & ACTION DOCK (M3 FOOTER) ───────────── */
    .hha-island-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--md-sys-color-surface-container-low);
      margin: 0;
      padding: 8px var(--hha-content-padding-x, 12px);
      border: none;
      border-top: 1px solid var(--md-sys-color-outline-variant);
      border-radius: 0 0 var(--md-sys-shape-corner-extra-large) var(--md-sys-shape-corner-extra-large);
      gap: 8px;
      flex-shrink: 0;
      box-sizing: border-box;
      min-height: 52px;
    }

    .hha-footer-status-group {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      position: relative;
      overflow: hidden;
      isolation: isolate;
      border-radius: var(--md-sys-shape-corner-full);
      height: var(--md-comp-control-height);
      min-height: var(--md-comp-control-height);
      width: fit-content;
      min-width: auto;
      max-width: none;
      flex: 0 0 auto;
      padding: 0 8px;
      background: transparent;
      border: none;
      box-sizing: border-box;
      line-height: 1;
      vertical-align: middle;
      cursor: pointer;
      user-select: none;
      flex-shrink: 0;
      opacity: 0;
      transform: translate3d(var(--shared-counter-offset, 100px), 0, 0);
      will-change: transform, opacity;
      transition: 
        transform 180ms cubic-bezier(0.36, 0, 0.66, -0.05),
        opacity 120ms ease-out,
        background-color var(--md-sys-motion-duration-medium1) var(--md-sys-motion-easing-standard), 
        box-shadow var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard);
    }

    .hha-root.is-expanded .hha-footer-status-group {
      opacity: 1;
      transform: translate3d(0, 0, 0);
      transition:
        transform 300ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)) 50ms,
        opacity 160ms ease-out 50ms,
        background-color var(--md-sys-motion-duration-medium1) var(--md-sys-motion-easing-standard), 
        box-shadow var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard);
    }

    .hha-footer-status-group:hover {
      background: var(--md-sys-color-surface-container);
    }

    .hha-footer-status {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: auto;
      height: var(--md-comp-control-height);
      min-height: var(--md-comp-control-height);
      box-sizing: border-box;
      padding: 0;
      z-index: 2;
    }

    .hha-footer-progress {
      font-size: var(--md-sys-typescale-label-medium-size);
      font-weight: var(--md-sys-typescale-label-medium-weight);
      letter-spacing: var(--md-sys-typescale-label-medium-tracking);
      color: var(--md-sys-color-on-surface-variant);
      font-variant-numeric: tabular-nums;
      position: relative;
      z-index: 2;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .hha-island-footer .hha-tabs {
      display: inline-flex;
      align-items: center;
      margin: 0 auto;
      padding: 3px;
      border: 1px solid var(--md-sys-color-outline-variant);
      background: var(--md-sys-color-surface-container-high);
      border-radius: var(--md-sys-shape-corner-full);
      gap: 2px;
      min-height: auto;
      width: 204px;
      min-width: 204px;
      max-width: 204px;
      box-sizing: border-box;
      flex: 0 0 204px;
      position: relative;
      opacity: 0;
      transform: scale(0.85);
      will-change: transform, opacity;
      transition:
        transform 160ms ease-in,
        opacity 120ms ease-in;
    }

    .hha-root.is-expanded .hha-island-footer .hha-tabs {
      opacity: 1;
      transform: scale(1);
      transition:
        transform 300ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)) 70ms,
        opacity 200ms ease-out 70ms;
    }

    .hha-tab-indicator {
      position: absolute;
      top: 3px;
      left: 3px;
      width: 97px;
      height: 28px;
      border-radius: var(--md-sys-shape-corner-full);
      background: var(--md-sys-color-surface-container-lowest);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
      pointer-events: none;
      z-index: 0;
      box-sizing: border-box;
      will-change: left, width;
      transition:
        left var(--hha-motion-indicator-duration, 200ms) var(--hha-motion-indicator-easing, cubic-bezier(0.22, 1, 0.36, 1)),
        width var(--hha-motion-indicator-duration, 200ms) var(--hha-motion-indicator-easing, cubic-bezier(0.22, 1, 0.36, 1));
    }

    .hha-tabs[data-active="settings"] .hha-tab-indicator,
    .hha-tabs:not([data-active="queue"]) .hha-tab-indicator {
      left: 3px;
      width: 97px;
    }

    .hha-tabs[data-active="queue"] .hha-tab-indicator {
      left: 102px;
      width: 97px;
    }

    .hha-footer-actions {
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
      margin-left: 0;
    }

    .hha-footer-actions .hha-btn-quick {
      height: var(--md-comp-control-height);
      min-height: var(--md-comp-control-height);
      width: 76px;
      min-width: 76px;
      max-width: 76px;
      flex: 0 0 76px;
      padding: 0 4px;
      font-family: var(--md-sys-typescale-font-family);
      font-size: var(--md-sys-typescale-label-medium-size);
      font-weight: var(--md-sys-typescale-label-medium-weight);
      letter-spacing: var(--md-sys-typescale-label-medium-tracking);
      opacity: 0;
      transform: translate3d(var(--shared-btn-offset, -104px), 0, 0);
      will-change: transform, opacity;
      transition:
        transform 180ms cubic-bezier(0.36, 0, 0.66, -0.05),
        opacity 120ms ease-out;
    }

    .hha-root.is-expanded .hha-footer-actions .hha-btn-quick {
      opacity: 1;
      transform: translate3d(0, 0, 0);
      transition:
        transform 300ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)) 50ms,
        opacity 160ms ease-out 50ms;
    }

    /* Segmented Tab Badges */
    .hha-tab-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 5px 1px 5px;
      border-radius: var(--md-sys-shape-corner-full);
      font-size: var(--md-sys-typescale-label-small-size);
      font-weight: 700;
      line-height: 1;
      box-sizing: border-box;
      background: var(--md-sys-color-surface-container-highest);
      color: var(--md-sys-color-on-surface-variant);
      border: none;
      transition: background-color var(--hha-motion-indicator-duration, 200ms) var(--hha-motion-indicator-easing, cubic-bezier(0.22, 1, 0.36, 1)),
                  color var(--hha-motion-indicator-duration, 200ms) var(--hha-motion-indicator-easing, cubic-bezier(0.22, 1, 0.36, 1));
    }

    .hha-tab-badge.is-queue {
      background: var(--md-sys-color-surface-container-highest);
      color: var(--md-sys-color-on-surface-variant);
    }

    .hha-tab-error-dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--md-sys-color-error);
      flex-shrink: 0;
      margin-left: 2px;
      box-shadow: 0 0 0 1px var(--md-sys-color-surface-container-low);
    }

    .hha-tab-btn:hover .hha-tab-badge.is-queue {
      background: var(--md-sys-color-outline-variant);
      color: var(--md-sys-color-on-surface);
    }

    .hha-tab-btn {
      flex: 1 1 50%;
      width: 50%;
      min-width: 0;
      height: 28px;
      padding: 0 8px;
      background: transparent;
      border: none;
      outline: none;
      border-radius: var(--md-sys-shape-corner-full);
      font-family: var(--md-sys-typescale-font-family);
      font-size: var(--md-sys-typescale-label-medium-size);
      font-weight: 500;
      letter-spacing: var(--md-sys-typescale-label-medium-tracking);
      line-height: 1;
      color: var(--md-sys-color-on-surface-variant);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      position: relative;
      z-index: 1;
      transition: color var(--hha-motion-indicator-duration, 200ms) var(--hha-motion-indicator-easing, cubic-bezier(0.22, 1, 0.36, 1));
      box-shadow: none;
      -webkit-appearance: none;
      appearance: none;
      user-select: none;
      box-sizing: border-box;
      white-space: nowrap;
    }

    .hha-tab-btn:hover:not(.active) {
      color: var(--md-sys-color-on-surface);
      background: color-mix(in srgb, var(--md-sys-color-on-surface) 6%, transparent);
    }

    .hha-tab-btn:active:not(.active) {
      transform: scale(0.97);
      background: color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent);
    }

    /* M3 Active Tab Indicator */
    .hha-tab-btn.active {
      background: transparent !important;
      border: none !important;
      box-shadow: none !important;
      color: var(--md-sys-color-primary) !important;
      font-weight: 600;
    }

    .hha-tab-btn.active .hha-tab-badge,
    .hha-tab-btn.active .hha-tab-badge.is-queue {
      background: var(--md-sys-color-primary-container);
      color: var(--md-sys-color-on-primary-container);
    }

    .hha-tab-btn.active:active {
      transform: scale(0.98);
    }

    .hha-tab-btn.active .hha-tab-badge,
    .hha-tab-btn.active .hha-tab-badge.is-queue {
      background: var(--md-sys-color-primary);
      color: var(--md-sys-color-on-primary);
      border: none;
    }

    /* Focus Rings (M3 Dual Focus Indicators) */
    .hha-pill-status-group:focus-visible,
    .hha-pill-queue-badge:focus-visible,
    .hha-tab-btn:focus-visible,
    .hha-btn-quick:focus-visible,
    .hha-queue-title-link:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--md-sys-color-surface), 0 0 0 4px var(--md-sys-color-primary);
    }

    .hha-log-item-delete:focus-visible,
    .hha-btn-clear-all:focus-visible,
    .hha-btn-copy-error:focus-visible,
    .hha-btn-dismiss-error:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--md-sys-color-surface), 0 0 0 4px var(--md-sys-color-error);
    }

    /* ─── 7. TAB PANELS ───────────────────────────────────────────── */
    .hha-panels {
      flex: 1;
      display: grid;
      grid-template-columns: 100%;
      grid-template-rows: 100%;
      overflow: hidden;
      overflow-x: hidden;
      padding: 10px var(--hha-content-padding-x, 12px);
      box-sizing: border-box;
      position: relative;
    }

    .hha-panel {
      grid-area: 1 / 1;
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      height: 100%;
      min-height: 0;
      box-sizing: border-box;
      overflow-x: hidden;
      overflow-y: auto;
      padding: 0;
      scrollbar-width: thin;
      scrollbar-color: var(--md-sys-color-outline-variant) transparent;
      position: relative;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transform: translate3d(0, 0, 0);
      will-change: opacity, transform;
      transition:
        opacity var(--hha-motion-tab-duration, 140ms) var(--hha-motion-tab-easing, ease-out),
        transform var(--hha-motion-tab-duration, 140ms) var(--hha-motion-tab-easing, ease-out),
        visibility 0s linear var(--hha-motion-tab-duration, 140ms);
    }

    .hha-panel::-webkit-scrollbar {
      width: 4px;
      height: 4px;
    }

    .hha-panel::-webkit-scrollbar-track {
      background: transparent;
    }

    .hha-panel::-webkit-scrollbar-thumb {
      background: var(--md-sys-color-outline-variant);
      border-radius: var(--md-sys-shape-corner-full);
    }

    .hha-panel::-webkit-scrollbar-thumb:hover {
      background: var(--md-sys-color-outline);
    }

    .hha-panel.active {
      display: flex;
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transform: translate3d(0, 0, 0);
      transition:
        opacity var(--hha-motion-tab-duration, 140ms) var(--hha-motion-tab-easing, ease-out),
        transform var(--hha-motion-tab-duration, 140ms) var(--hha-motion-tab-easing, ease-out),
        visibility 0s linear 0s;
    }

    .hha-panels.slide-forward .hha-panel:not(.active) {
      transform: translate3d(calc(-1 * var(--hha-motion-tab-shift, 6px)), 0, 0);
    }

    .hha-panels.slide-backward .hha-panel:not(.active) {
      transform: translate3d(var(--hha-motion-tab-shift, 6px), 0, 0);
    }

    /* ─── 8. QUEUE & LOG CONTAINERS ───────────────────────────────── */
    /* Tab 2: Queue Container (M3 Unified List Surface) */
    [data-panel="queue"] .hha-log-card {
      flex: 1;
      height: 100%;
      min-height: 0;
      display: flex;
      flex-direction: column;
      background: var(--md-sys-color-surface-container-lowest);
      border: 1px solid var(--md-sys-color-outline-variant);
      border-radius: var(--md-sys-shape-corner-medium);
      box-shadow: none;
      padding: 0;
      box-sizing: border-box;
      overflow: hidden;
      position: relative;
    }

    [data-panel="queue"] .hha-log-empty-text {
      color: var(--md-sys-color-on-surface-variant);
      font-size: var(--md-sys-typescale-body-small-size);
      font-weight: 500;
      text-align: center;
      line-height: var(--md-sys-typescale-body-small-line-height);
    }

    [data-panel="queue"] .hha-log-empty-icon {
      color: var(--md-sys-color-outline);
      opacity: 0.85;
    }

    .hha-log-stream {
      flex: 1;
      height: 100%;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      margin-top: 0;
      padding: 0;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 0;
      scrollbar-width: none;
      -ms-overflow-style: none;
    }

    .hha-log-stream::-webkit-scrollbar {
      display: none;
      width: 0;
      height: 0;
    }

    /* Floating Overlay Scrollbar */
    .hha-overlay-scrollbar {
      position: absolute;
      top: 6px;
      bottom: 6px;
      right: 3px;
      width: 6px;
      pointer-events: auto;
      z-index: 10;
      opacity: 0;
      visibility: hidden;
      transition: opacity var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard), visibility var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard);
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
      border-radius: var(--md-sys-shape-corner-full);
      cursor: grab;
      touch-action: none;
      background: var(--md-sys-color-outline-variant);
      transition: width var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard), background-color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard);
    }

    .hha-overlay-thumb:hover,
    .hha-overlay-thumb.is-dragging {
      width: 6px;
      background: var(--md-sys-color-outline);
    }

    .hha-overlay-thumb.is-dragging {
      cursor: grabbing;
    }

    .hha-log-empty {
      position: absolute;
      top: 50%;
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

    .hha-log-empty-subtext {
      font-size: var(--md-sys-typescale-label-small-size);
      color: var(--md-sys-color-outline);
      text-align: center;
      line-height: 1.35;
      max-width: 240px;
    }

    /* Queue Toolbar (M3 Secondary List Header) */
    .hha-queue-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      background: var(--md-sys-color-surface-container-low);
      border-bottom: 1px solid var(--md-sys-color-outline-variant);
      gap: 8px;
      box-sizing: border-box;
      min-height: 36px;
      flex-shrink: 0;
    }

    .hha-queue-toolbar-title {
      font-size: var(--md-sys-typescale-label-small-size);
      font-weight: 600;
      color: var(--md-sys-color-on-surface-variant);
      letter-spacing: 0.2px;
    }

    /* Queue List Items (M3 Unified List Pattern) */
    .hha-queue-card {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px 12px;
      background: transparent;
      border: none;
      border-bottom: 1px solid var(--md-sys-color-outline-variant);
      border-radius: 0;
      box-shadow: none;
      box-sizing: border-box;
      cursor: pointer;
      user-select: none;
      transition: 
        opacity var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard),
        background-color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard);
    }

    .hha-queue-card.is-removing {
      opacity: 0 !important;
      transform: translate3d(24px, 0, 0) !important;
      max-height: 0 !important;
      padding-top: 0 !important;
      padding-bottom: 0 !important;
      margin-top: 0 !important;
      margin-bottom: 0 !important;
      border-color: transparent !important;
      overflow: hidden !important;
      pointer-events: none !important;
      transition: 
        opacity 180ms cubic-bezier(0.3, 0, 0.8, 0.15),
        transform 180ms cubic-bezier(0.3, 0, 0.8, 0.15),
        max-height 220ms cubic-bezier(0.05, 0.7, 0.1, 1),
        padding 220ms cubic-bezier(0.05, 0.7, 0.1, 1),
        border-color 180ms ease !important;
    }

    .hha-queue-card:last-child {
      border-bottom: none;
    }

    .hha-queue-card:hover {
      background: var(--md-sys-state-hover);
      box-shadow: none;
      transform: none;
    }

    .hha-queue-card:active {
      background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
      transform: none;
      box-shadow: none;
    }

    /* Viewed Queue Card state (M3 Accessible Subdued State) */
    .hha-queue-card.is-viewed {
      opacity: 1;
      background: var(--md-sys-color-surface-container-low);
    }

    .hha-queue-card.is-viewed:hover {
      background: var(--md-sys-state-hover);
    }

    .hha-queue-card.is-viewed .hha-queue-title-link {
      color: var(--md-sys-color-outline);
      font-weight: 500;
    }

    .hha-queue-card.is-viewed .hha-queue-title-link:hover {
      color: var(--md-sys-color-primary);
    }

    .hha-queue-card.is-viewed .hha-queue-salary {
      opacity: 0.75;
    }

    .hha-queue-card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
      height: 20px;
      min-height: 20px;
    }

    .hha-queue-title-link {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      flex: 1;
      height: 20px;
      line-height: 20px;
      color: var(--md-sys-color-on-surface);
      text-decoration: none;
      font-size: var(--md-sys-typescale-label-large-size);
      font-weight: var(--md-sys-typescale-label-large-weight);
      overflow: hidden;
      cursor: pointer;
      transition: color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard);
    }

    .hha-queue-title-link:hover {
      color: var(--md-sys-color-primary);
    }

    .hha-queue-title-text {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 20px;
    }

    .hha-queue-card-mid {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      height: 16px;
      min-height: 16px;
      line-height: 16px;
      margin: 0;
    }

    .hha-queue-employer {
      font-size: var(--md-sys-typescale-body-small-size);
      font-weight: 400;
      color: var(--md-sys-color-on-surface-variant);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      height: 16px;
      line-height: 16px;
      display: inline-flex;
      align-items: center;
    }

    .hha-queue-card.is-viewed .hha-queue-employer {
      color: var(--md-sys-color-outline);
    }

    .hha-queue-card-bottom {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      overflow: hidden;
      height: 20px;
      min-height: 20px;
      line-height: 20px;
      margin: 0;
    }

    /* M3 Assist Chips / Badges */
    .hha-queue-badge {
      display: inline-flex;
      align-items: center;
      height: 18px;
      line-height: 18px;
      padding: 0 7px;
      box-sizing: border-box;
      border-radius: var(--md-sys-shape-corner-small);
      font-size: 10.5px;
      font-weight: 500;
      letter-spacing: -0.05px;
      flex-shrink: 0;
    }

    .hha-queue-badge.badge-warning {
      background: var(--md-custom-color-warning-container);
      color: var(--md-custom-color-on-warning-container);
      border: none;
    }

    .hha-queue-badge.badge-error {
      background: var(--md-sys-color-error-container);
      color: var(--md-sys-color-on-error-container);
      border: none;
    }

    .hha-queue-badge.badge-info {
      background: var(--md-sys-color-tertiary-container);
      color: var(--md-sys-color-on-tertiary-container);
      border: none;
    }

    .hha-queue-badge.badge-neutral {
      background: var(--md-sys-color-surface-container-highest);
      color: var(--md-sys-color-on-surface-variant);
      border: none;
    }

    .hha-queue-badge.badge-viewed {
      background: var(--md-sys-color-surface-container-highest);
      color: var(--md-sys-color-on-surface-variant);
      border: none;
      font-weight: 500;
    }

    .hha-queue-salary {
      display: inline-flex;
      align-items: center;
      height: 18px;
      line-height: 18px;
      font-size: var(--md-sys-typescale-label-small-size);
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: var(--md-sys-color-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      flex-shrink: 1;
    }

    /* Delete item button with M3 Icon Button state layers */
    .hha-log-item-delete {
      width: 20px;
      height: 20px;
      min-width: 20px;
      min-height: 20px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      border-radius: var(--md-sys-shape-corner-full);
      color: var(--md-sys-color-on-surface-variant);
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      line-height: 20px;
      font-family: var(--md-sys-typescale-font-family);
      transition: color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard), background-color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard), transform var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
    }

    .hha-log-item-delete:hover {
      color: var(--md-sys-color-error);
      background: var(--md-sys-color-error-container);
    }

    .hha-log-item-delete:active {
      color: var(--md-sys-color-error);
      background: color-mix(in srgb, var(--md-sys-color-error-container) 80%, var(--md-sys-color-error));
      transform: scale(0.92);
    }

    /* ─── 9. FULL-SIZE ERROR CARD (IN PLACE OF COVER FORM) ───────── */
    .hha-card-error {
      flex: 1;
      height: 100%;
      min-height: 0;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      box-sizing: border-box;
      padding: 16px;
      margin-bottom: 0 !important;
      background: var(--md-sys-color-error-container);
      border: 1px solid color-mix(in srgb, var(--md-sys-color-error) 25%, transparent);
      border-radius: var(--md-sys-shape-corner-medium);
      box-shadow: none;
      overflow: hidden;
      animation: hhaErrorCardFadeIn var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-emphasized-decelerate);
    }

    @keyframes hhaErrorCardFadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .hha-card-error-body {
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 0;
      flex: 1;
      overflow-y: auto;
      scrollbar-width: thin;
    }

    .hha-card-error-title {
      font-size: var(--md-sys-typescale-body-medium-size);
      font-weight: 600;
      line-height: 1.4;
      color: var(--md-sys-color-on-error-container);
      word-break: break-word;
      user-select: text;
    }

    .hha-card-error-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: var(--md-sys-typescale-label-small-size);
      font-weight: 500;
      line-height: 1.4;
      color: color-mix(in srgb, var(--md-sys-color-on-error-container) 85%, transparent);
      background: color-mix(in srgb, var(--md-sys-color-error) 12%, transparent);
      padding: 8px 10px;
      border-radius: var(--md-sys-shape-corner-small);
      word-break: break-all;
      user-select: text;
    }

    .hha-card-error-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 12px;
      padding-top: 8px;
      flex-shrink: 0;
      border-top: 1px solid color-mix(in srgb, var(--md-sys-color-error) 15%, transparent);
    }

    .hha-card-error-actions .hha-btn-copy-error {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 32px;
      padding: 0 14px;
      border-radius: var(--md-sys-shape-corner-full);
      background: color-mix(in srgb, var(--md-sys-color-error) 12%, transparent);
      color: var(--md-sys-color-on-error-container);
      border: 1px solid color-mix(in srgb, var(--md-sys-color-error) 25%, transparent);
      font-family: var(--md-sys-typescale-font-family);
      font-size: var(--md-sys-typescale-label-medium-size);
      font-weight: 600;
      line-height: 1;
      cursor: pointer;
      box-sizing: border-box;
      transition: background-color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard), color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard), transform var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
    }

    .hha-card-error-actions .hha-btn-copy-error:hover {
      background: color-mix(in srgb, var(--md-sys-color-error) 20%, transparent);
    }

    .hha-card-error-actions .hha-btn-copy-error:active {
      transform: scale(0.96);
    }

    .hha-card-error-actions .hha-btn-copy-error.is-copied {
      background: var(--md-sys-color-primary-container);
      color: var(--md-sys-color-on-primary-container);
      border-color: transparent;
    }

    .hha-card-error-actions .hha-btn-dismiss-error {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 32px;
      padding: 0 16px;
      border-radius: var(--md-sys-shape-corner-full);
      background: var(--md-sys-color-error);
      color: var(--md-sys-color-on-error);
      border: none;
      font-family: var(--md-sys-typescale-font-family);
      font-size: var(--md-sys-typescale-label-medium-size);
      font-weight: 600;
      line-height: 1;
      cursor: pointer;
      box-sizing: border-box;
      transition: background-color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard), transform var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
    }

    .hha-card-error-actions .hha-btn-dismiss-error:hover {
      background: color-mix(in srgb, var(--md-sys-color-error) 85%, black);
    }

    .hha-card-error-actions .hha-btn-dismiss-error:active {
      transform: scale(0.96);
    }

    /* Clear all in queue: M3 Text Button (Error role) */
    .hha-btn-clear-all {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 24px;
      padding: 2px 8px;
      background: transparent;
      border: none;
      border-radius: var(--md-sys-shape-corner-full);
      font-family: var(--md-sys-typescale-font-family);
      font-size: var(--md-sys-typescale-label-small-size);
      font-weight: 500;
      color: var(--md-sys-color-on-surface-variant);
      cursor: pointer;
      line-height: 1;
      transition: color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard), background-color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard), transform var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
      white-space: nowrap;
    }

    .hha-btn-clear-all:hover:not(:disabled) {
      color: var(--md-sys-color-error);
      background: var(--md-sys-color-error-container);
    }

    .hha-btn-clear-all:active:not(:disabled) {
      transform: scale(0.96);
      background: color-mix(in srgb, var(--md-sys-color-error-container) 85%, var(--md-sys-color-error));
    }

    .hha-btn-clear-all.is-confirming {
      width: auto !important;
      padding: 2px 10px !important;
      background: var(--md-sys-color-error) !important;
      border: none !important;
      color: var(--md-sys-color-on-error) !important;
      font-weight: 600 !important;
    }

    .hha-btn-clear-all.is-confirming:hover {
      background: color-mix(in srgb, var(--md-sys-color-error) 90%, black) !important;
      color: var(--md-sys-color-on-error) !important;
    }

    .hha-btn-clear-all.is-confirming:active {
      transform: scale(0.96);
    }

    .hha-btn-clear-all:disabled,
    .hha-btn-clear-all[disabled] {
      display: none !important;
    }

    .hha-btn-clear-all-text,
    .hha-btn-confirm-text {
      font-size: var(--md-sys-typescale-label-small-size);
      line-height: 1;
    }

    /* ─── 10. TOOLTIP (M3 PLAIN TOOLTIP) ──────────────────────────── */
    .hha-tooltip {
      position: absolute;
      background: var(--md-sys-color-inverse-surface);
      color: var(--md-sys-color-inverse-on-surface);
      font-family: var(--md-sys-typescale-font-family);
      font-size: var(--md-sys-typescale-body-small-size);
      font-weight: 400;
      line-height: var(--md-sys-typescale-body-small-line-height);
      padding: 4px 8px;
      border-radius: var(--md-sys-shape-corner-extra-small);
      max-width: 260px;
      width: max-content;
      white-space: normal;
      word-break: break-word;
      box-shadow: var(--md-sys-elevation-level2);
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
      z-index: 1000;
    }

    .hha-tooltip.is-visible {
      opacity: 1;
      visibility: visible;
    }

    /* ─── 11. SETTINGS CONTROLS ───────────────────────────────────── */
    .hha-card {
      background: var(--md-sys-color-surface-container-lowest);
      border: 1px solid var(--md-sys-color-outline-variant);
      border-radius: var(--md-sys-shape-corner-medium);
      box-shadow: none;
      margin-bottom: 0;
      overflow: visible;
      box-sizing: border-box;
    }

    .hha-card:last-child {
      margin-bottom: 0;
    }

    .hha-row-label {
      font-size: var(--md-sys-typescale-body-medium-size);
      font-weight: 500;
      color: var(--md-sys-color-on-surface);
      letter-spacing: var(--md-sys-typescale-body-medium-tracking);
    }

    /* ─── 12. SWITCH & COVER LETTER ───────────────────────────────── */
    .hha-card-cover {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      margin-bottom: 0 !important;
      overflow: hidden;
      background: var(--md-sys-color-surface-container-lowest);
      border: 1px solid var(--md-sys-color-outline-variant);
      border-radius: var(--md-sys-shape-corner-medium);
      box-shadow: none;
    }

    .hha-switch-row {
      display: flex;
      align-items: center;
      padding: 6px 12px;
      min-height: 44px;
      box-sizing: border-box;
      border-bottom: 1px solid var(--md-sys-color-outline-variant);
      width: 100%;
      flex-shrink: 0;
      background: var(--md-sys-color-surface-container-lowest);
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
      font-size: var(--md-sys-typescale-body-medium-size);
      line-height: var(--md-sys-typescale-body-medium-line-height);
      font-weight: 500;
      color: var(--md-sys-color-on-surface);
    }

    /* M3 Switch Specification (m3.material.io/components/switch/specs) */
    .hha-switch {
      position: relative;
      display: inline-block;
      width: 44px;
      height: 24px;
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
      background-color: var(--md-sys-color-surface-container-highest);
      border-radius: var(--md-sys-shape-corner-full);
      border: 2px solid var(--md-sys-color-outline);
      box-sizing: border-box;
      transition: background-color var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard), border-color var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard);
    }

    .hha-switch-slider:hover {
      border-color: var(--md-sys-color-on-surface);
    }

    .hha-switch-slider::before {
      position: absolute;
      content: "";
      top: 50%;
      left: 4px;
      height: 12px;
      width: 12px;
      transform: translateY(-50%);
      background-color: var(--md-sys-color-outline);
      border-radius: var(--md-sys-shape-corner-full);
      transition: transform var(--md-sys-motion-duration-medium1) var(--md-sys-motion-easing-emphasized-decelerate), background-color var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard), width var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard), height var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard);
    }

    .hha-switch:hover .hha-switch-slider::before {
      background-color: var(--md-sys-color-on-surface);
    }

    /* M3 Checked Switch */
    .hha-switch-input:checked + .hha-switch-slider {
      background-color: var(--md-sys-color-primary);
      border: 2px solid var(--md-sys-color-primary);
    }

    .hha-switch-input:checked + .hha-switch-slider:hover {
      background-color: color-mix(in srgb, var(--md-sys-color-primary) 92%, var(--md-sys-color-on-primary));
      border-color: color-mix(in srgb, var(--md-sys-color-primary) 92%, var(--md-sys-color-on-primary));
    }

    .hha-switch-input:checked + .hha-switch-slider::before {
      transform: translateY(-50%) translateX(20px);
      height: 16px;
      width: 16px;
      background-color: var(--md-sys-color-on-primary);
    }

    /* M3 Squish Transition on Active/Press */
    .hha-switch:active .hha-switch-slider::before {
      width: 16px;
    }

    .hha-switch-input:checked:active + .hha-switch-slider::before {
      transform: translateY(-50%) translateX(16px);
      width: 20px;
    }

    .hha-switch-input:focus-visible + .hha-switch-slider {
      box-shadow: 0 0 0 2px var(--md-sys-color-surface), 0 0 0 4px var(--md-sys-color-primary);
    }

    .hha-cover-container {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      padding: 0;
      box-sizing: border-box;
      position: relative;
      background: transparent;
    }

    .hha-cover-textarea {
      width: 100%;
      flex: 1;
      height: 100%;
      min-height: 105px;
      background: transparent;
      border: none;
      border-radius: 0;
      color: var(--md-sys-color-on-surface);
      font-size: 13px;
      line-height: 19px;
      letter-spacing: -0.05px;
      font-family: var(--md-sys-typescale-font-family);
      padding: 10px 12px 28px 12px;
      margin: 0;
      resize: none;
      outline: none !important;
      box-sizing: border-box;
      box-shadow: none !important;
      scrollbar-width: thin;
      scrollbar-color: var(--md-sys-color-outline-variant) transparent;
      transition: opacity var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard), background-color var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard), color var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard);
    }

    .hha-cover-textarea:focus,
    .hha-cover-textarea:focus-visible {
      border: none !important;
      outline: none !important;
      box-shadow: none !important;
    }

    .hha-cover-textarea::-webkit-scrollbar {
      width: 4px;
    }

    .hha-cover-textarea::-webkit-scrollbar-track {
      background: transparent;
    }

    .hha-cover-textarea::-webkit-scrollbar-thumb {
      background: var(--md-sys-color-outline-variant);
      border-radius: var(--md-sys-shape-corner-full);
    }

    .hha-cover-textarea::-webkit-scrollbar-thumb:hover {
      background: var(--md-sys-color-outline);
    }

    .hha-cover-textarea::placeholder {
      color: var(--md-sys-color-outline);
      opacity: 1;
    }

    .hha-cover-textarea:disabled,
    .hha-cover-textarea.is-disabled {
      opacity: 0.38;
      background: var(--md-sys-color-surface-container-high);
      color: var(--md-sys-color-outline);
      cursor: not-allowed;
    }

    .hha-char-counter {
      position: absolute;
      bottom: 8px;
      right: 12px;
      z-index: 2;
      pointer-events: none;
      font-size: var(--md-sys-typescale-label-small-size);
      font-family: var(--md-sys-typescale-font-family-mono);
      line-height: 1;
      color: var(--md-sys-color-on-surface-variant);
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      background: transparent;
      padding: 0;
      border: none;
      box-shadow: none;
      transition: color var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard), opacity var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard);
    }

    .hha-cover-textarea:disabled ~ .hha-char-counter,
    .hha-cover-textarea.is-disabled ~ .hha-char-counter {
      opacity: 0.38;
      background: transparent;
    }

    .hha-char-counter.is-limit {
      color: var(--md-sys-color-error);
      font-weight: 600;
    }

    /* ─── 13. KEYFRAMES ───────────────────────────────────────────── */
    @keyframes hhaBadgePop {
      0% {
        transform: scale(1);
      }
      35% {
        transform: scale(1.18);
      }
      70% {
        transform: scale(0.96);
      }
      100% {
        transform: scale(1);
      }
    }

    /* Accessibility: M3 Motion Reduction (opacity only, <= 100ms, no transforms or growth) */
    @media (prefers-reduced-motion: reduce) {
      .hha-pill-progress-fill,
      .hha-btn-stop {
        animation: none !important;
      }

      .hha-pill,
      .hha-flyout,
      .hha-panel {
        transform: none !important;
        transition-duration: 100ms !important;
        transition-delay: 0s !important;
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

      this._isExpanded = false;
      this._activeTab = 'settings'; // 'settings' | 'queue'
      const initWinW = (typeof window !== 'undefined' && window.innerWidth) || 1024;
      const initWinH = (typeof window !== 'undefined' && window.innerHeight) || 768;
      this._pillPos = { x: Math.max(8, initWinW - 220), y: Math.max(8, initWinH - 36 - 24) };
      this._collapsedPillWidth = 166;
      this._isAnimating = false;
      this._queue = [];
      this._lastErrorPayload = null;
      this._toastTimer = null;
      this._config = {
        limit: MAX_DAILY_LIMIT,
        useCover: true,
        coverText: '',
        skipHidden: true
      };
      this._status = { status: 'idle', code: 'IDLE' };
      this._progress = { sent: 0, limit: MAX_DAILY_LIMIT, percentage: 0 };

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
      this._onDocKeyDown = null;
      this._queueConfirmTimer = null;

      this._onResize = this._onResize.bind(this);
      this._onPointerDown = this._onPointerDown.bind(this);
      this._onPointerMove = this._onPointerMove.bind(this);
      this._onPointerUp = this._onPointerUp.bind(this);
    }

    connectedCallback() {

      // Restore expanded state and active tab from localStorage across page navigations
      try {
        if (typeof localStorage !== 'undefined') {
          const savedExpanded = localStorage.getItem('hha_hud_expanded_v2');
          if (savedExpanded !== null) {
            this._isExpanded = savedExpanded === 'true';
          }
          const savedTab = localStorage.getItem('hha_hud_active_tab_v2');
          if (savedTab && ['settings', 'queue'].includes(savedTab)) {
            this._activeTab = savedTab;
          }
        }
      } catch (_) {}

      this._render();
      this._restorePosition();
      this._bindDomEvents();

      // Apply restored tab and expansion state to DOM
      if (this._shadow) {
        if (this._activeTab !== 'settings') {
          this.setActiveTab(this._activeTab);
        }
        if (this._isExpanded) {
          const root = this._shadow.querySelector('[data-el="root"]') || this._shadow.querySelector('.hha-root');
          const statusGroup = this._shadow.querySelector('[data-el="pill-status-group"]');
          if (root) root.classList.add('is-expanded');
          if (statusGroup) {
            statusGroup.setAttribute('aria-expanded', 'true');
            statusGroup.setAttribute('aria-label', 'Свернуть панель управления');
          }
          this._updatePosition();
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => this._updateTabIndicator());
          }
        }
      }

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
        if (this._onWindowUnload) {
          window.removeEventListener('beforeunload', this._onWindowUnload);
          window.removeEventListener('pagehide', this._onWindowUnload);
        }
      }
      if (this._onDocClick && typeof document !== 'undefined') {
        document.removeEventListener('click', this._onDocClick);
      }
      if (this._onDocKeyDown && typeof document !== 'undefined') {
        document.removeEventListener('keydown', this._onDocKeyDown);
      }
      if (this._coverDebounceTimer) { clearTimeout(this._coverDebounceTimer); this._coverDebounceTimer = null; }
      if (this._animTimer) { clearTimeout(this._animTimer); this._animTimer = null; }
      if (this._badgeClearTimer) { clearTimeout(this._badgeClearTimer); this._badgeClearTimer = null; }
      if (this._badgeAnimTimer) { clearTimeout(this._badgeAnimTimer); this._badgeAnimTimer = null; }
      if (this._queueConfirmTimer) { clearTimeout(this._queueConfirmTimer); this._queueConfirmTimer = null; }
      if (this._originalDocTitle && typeof document !== 'undefined') {
        document.title = this._originalDocTitle;
      }
    }

    // --- Public API ---

    bindAssistant(assistant) {
      if (!assistant || this._assistant === assistant) return;
      this.unbindAssistant();
      this._assistant = assistant;

      let stateLimit;
      if (typeof assistant.getState === 'function') {
        const s = assistant.getState();
        if (s) {
          const sent = s.sentCount !== undefined ? s.sentCount : s.sentToday;
          const lim = s.limit !== undefined ? s.limit : s.dailyLimit;
          if (lim !== undefined) {
            stateLimit = Math.max(1, Math.min(MAX_DAILY_LIMIT, parseInt(lim, 10) || 50));
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

      if (typeof assistant.getManualQueue === 'function') {
        const q = assistant.getManualQueue();
        if (Array.isArray(q)) this._queue = q;
      }

      if (typeof assistant.on === 'function') {
        this._unsubscribers.push(
          assistant.on('status', (payload) => {
            if (payload) this.updateStatus(payload.status, payload.code || payload.statusCode);
          }),
          assistant.on('progress', (payload) => {
            if (payload) this.updateProgress(payload.sent, payload.limit);
          }),
          assistant.on('error', (payload) => this._showError(payload)),
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
      
      if (this._toastTimer) {
        clearTimeout(this._toastTimer);
        this._toastTimer = null;
      }
      this._copyBtnOrigHtml = null;
      this._copyBtnOrigColor = null;
    }

    updateStatus(status, code) {
      let nextStatus = status || 'idle';
      let nextCode = code || 'IDLE';
      if (code === 'DAILY_LIMIT_REACHED') {
        nextStatus = 'done';
        nextCode = 'DAILY_LIMIT_REACHED';
      } else if (code === 'TARGET_LIMIT_REACHED') {
        nextStatus = 'done';
        nextCode = 'COMPLETED';
      } else {
        const lim = this._progress ? this._progress.limit : ((this._config && this._config.limit) || 50);
        const sent = this._progress ? this._progress.sent : 0;
        if (nextStatus === 'running' && sent >= lim && lim > 0) {
          if (this._assistant && typeof this._assistant.completeLimit === 'function') {
            this._assistant.completeLimit();
          } else if (this._assistant && typeof this._assistant.stop === 'function') {
            this._assistant.stop('TARGET_LIMIT_REACHED', 'Target limit reached');
          }
          nextStatus = 'done';
          nextCode = 'COMPLETED';
        }
      }
      this._status = { status: nextStatus, code: nextCode };
      this._syncStatus();
    }

    updateProgress(sent) {
      const s = Number(sent) || 0;
      const l = MAX_DAILY_LIMIT;
      const displayCurrent = Math.min(Math.max(0, s), l);
      const pct = l > 0 ? Math.min(100, Math.max(0, Math.round((displayCurrent / l) * 100))) : 0;
      this._progress = { sent: s, displayCurrent, limit: l, percentage: pct };
      this._syncProgress();

      if (s >= l && this._status && this._status.status === 'running') {
        if (this._assistant && typeof this._assistant.completeLimit === 'function') {
          this._assistant.completeLimit();
        } else if (this._assistant && typeof this._assistant.stop === 'function') {
          this._assistant.stop('TARGET_LIMIT_REACHED', 'Target limit reached');
        }
        this.updateStatus('done', 'COMPLETED');
      } else if (s < l && this._status && this._status.status === 'done') {
        this.updateStatus('idle', 'IDLE');
      }
    }

    

    updateQueue(queue) {
      if (queue && Array.isArray(queue.queue)) queue = queue.queue;
      this._queue = Array.isArray(queue) ? queue : [];
      this._syncQueue();
    }

    updateConfig(config) {
      if (!config) return;
      config.limit = MAX_DAILY_LIMIT;
      if (typeof config.coverText === 'string' && config.coverText.length > MAX_COVER_LENGTH) {
        config.coverText = config.coverText.slice(0, MAX_COVER_LENGTH);
      }
      this._config = { ...this._config, ...config };
      this.updateProgress(this._progress ? this._progress.sent : 0);
      this._syncConfig();
    }

    setTargetLimit() {
      return MAX_DAILY_LIMIT;
    }

    toggleExpand(force) {
      const next = typeof force === 'boolean' ? force : !this._isExpanded;
      if (this._isExpanded === next) return;
      this._isExpanded = next;
      this._isAnimating = true;

      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('hha_hud_expanded_v2', String(this._isExpanded));
        }
      } catch (_) {}

      this._hideTooltip();

      if (this._shadow) {
        const flyout = this._shadow.querySelector('.hha-flyout');
        const root = this._shadow.querySelector('[data-el="root"]') || this._shadow.querySelector('.hha-root');
        const pill = this._shadow.querySelector('[data-el="pill"]');
        const statusGroup = this._shadow.querySelector('[data-el="pill-status-group"]');
        if (statusGroup) {
          statusGroup.setAttribute('aria-expanded', String(this._isExpanded));
          statusGroup.setAttribute('aria-label', this._isExpanded ? 'Свернуть панель управления' : 'Открыть настройки и журнал');
        }
        if (pill && typeof pill.offsetWidth === 'number' && pill.offsetWidth > 0 && pill.offsetWidth < 300) {
          this._collapsedPillWidth = pill.offsetWidth;
        }
        if (root && typeof root.style.setProperty === 'function') {
          root.style.setProperty('--pill-width', `${this._collapsedPillWidth || 196}px`);
        }
        if (root) {
          root.classList.toggle('is-expanded', this._isExpanded);
          root.classList.add('is-animating');
        }
        if (flyout) {
          flyout.classList.add('is-animating');
        }
        this._updatePosition();
        if (this._isExpanded) {
          this._updateTabIndicator();
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => this._updateTabIndicator());
          }
        }

        if (this._animTimer) clearTimeout(this._animTimer);
        if (this._isExpanded && this._activeTab === 'queue') {
          const stream = this._shadow.querySelector('[data-el="queue-stream"]');
          if (!stream || !stream.children.length) {
            this._syncQueue();
          }
        }
        this._animTimer = setTimeout(() => {
          this._isAnimating = false;
          if (root) root.classList.remove('is-animating');
          if (flyout) flyout.classList.remove('is-animating');
          this._animTimer = null;
          if (this._isExpanded) {
            this._updateTabIndicator();
            if (this._activeTab === 'queue') {
              this._updateOverlayScrollbar();
            }
          }
          if (!this._isExpanded && this._shadow) {
            const pillEl = this._shadow.querySelector('[data-el="pill"]');
            if (pillEl && typeof pillEl.offsetWidth === 'number' && pillEl.offsetWidth > 0 && pillEl.offsetWidth < 300) {
              this._collapsedPillWidth = pillEl.offsetWidth;
              if (root && typeof root.style.setProperty === 'function') {
                root.style.setProperty('--pill-width', `${this._collapsedPillWidth}px`);
              }
            }
          }
        }, this._isExpanded ? 330 : 230);
      } else {
        this._isAnimating = false;
      }
    }

    open() {
      const res = this.toggleExpand(true);
      this._updateTabIndicator();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => this._updateTabIndicator());
      }
      return res;
    }

    close() {
      return this.toggleExpand(false);
    }

    _switchTab(tabName) {
      return this.setActiveTab(tabName);
    }

    setActiveTab(tabName) {
      if (!['settings', 'queue'].includes(tabName)) {
        tabName = 'settings';
      }
      const prevTab = this._activeTab;
      this._activeTab = tabName;
      this._resetClearQueueBtn();
      this._hideTooltip();

      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('hha_hud_active_tab_v2', this._activeTab);
        }
      } catch (_) {}

      if (!this._shadow) return;

      const root = this._shadow.querySelector('[data-el="root"]') || this._shadow.querySelector('.hha-root');
      if (root) {
        root.dataset.activeTab = tabName;
      }
      this._updatePosition();

      const tabOrder = { settings: 0, queue: 1 };
      const prevIdx = tabOrder[prevTab] !== undefined ? tabOrder[prevTab] : 0;
      const nextIdx = tabOrder[tabName] !== undefined ? tabOrder[tabName] : 0;
      const panelsContainer = this._shadow.querySelector('.hha-panels');
      if (panelsContainer) {
        panelsContainer.classList.toggle('slide-forward', nextIdx >= prevIdx);
        panelsContainer.classList.toggle('slide-backward', nextIdx < prevIdx);
      }

      const tabs = this._shadow.querySelectorAll('.hha-tab-btn');
      tabs.forEach(t => {
        const isActive = t.dataset.tab === tabName;
        t.classList.toggle('active', isActive);
        t.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });

      const panels = this._shadow.querySelectorAll('.hha-panel');
      panels.forEach(p => {
        const isActive = p.dataset.panel === tabName;
        p.classList.toggle('active', isActive);
        if (isActive) {
          p.removeAttribute('aria-hidden');
          p.removeAttribute('inert');
          p.inert = false;
        } else {
          p.setAttribute('aria-hidden', 'true');
          p.setAttribute('inert', '');
          p.inert = true;
        }
      });

      const tabsContainer = this._shadow.querySelector('.hha-tabs');
      if (tabsContainer) {
        tabsContainer.dataset.active = tabName;
      }

      this._updateTabIndicator();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          this._updateTabIndicator();
          this._updateOverlayScrollbar();
        });
      }
      this._syncQueueActions();
      if (this._isExpanded && tabName === 'queue') {
        const stream = this._shadow.querySelector('[data-el="queue-stream"]');
        if (!stream || !stream.children.length) {
          this._syncQueue();
        }
      }
    }

    _updateTabIndicator() {
      if (!this._shadow) return;
      const indicator = this._shadow.querySelector('[data-el="tab-indicator"]');
      const tabs = this._shadow.querySelector('.hha-tabs');
      if (!indicator || !tabs) return;

      tabs.dataset.active = this._activeTab;

      const isQueue = this._activeTab === 'queue';
      const left = isQueue ? 102 : 3;
      const width = 97;

      indicator.style.left = `${left}px`;
      indicator.style.width = `${width}px`;
      indicator.style.transform = 'none';
    }

    _resetClearQueueBtn() {
      if (this._queueConfirmTimer) {
        clearTimeout(this._queueConfirmTimer);
        this._queueConfirmTimer = null;
      }
      if (!this._shadow) return;
      const btn = this._shadow.querySelector('[data-action="clear-queue"]') || this._shadow.querySelector('[data-el="clear-queue-btn"]');
      if (btn) {
        btn.classList.remove('is-confirming');
        btn.innerHTML = `<span class="hha-btn-clear-all-text">Очистить всё</span>`;
      }
    }

    _syncQueueActions() {
      if (!this._shadow) return;
      const count = this._queue ? this._queue.length : 0;
      if (count === 0) {
        this._resetClearQueueBtn();
      }

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
    }

    getPosition() {
      return { ...this._pillPos };
    }

    setPosition(x, y) {
      const winW = (typeof window !== 'undefined' && window.innerWidth) || 1024;
      const winH = (typeof window !== 'undefined' && window.innerHeight) || 768;
      // Accept center X or left edge
      const centerX = x < 200 ? (x + 195) : x;
      this._pillPos = this._clampPillCoordinates(centerX, y, winW, winH);
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

    _clampPillCoordinates(centerX, y, winW, winH) {
      const padding = 16;
      const flyoutMaxW = 390;
      const halfW = flyoutMaxW / 2;
      const minX = padding + halfW;
      const maxX = Math.max(minX, winW - padding - halfW);

      const flyoutH = 520;
      const gap = 8;
      const pillH = 36;
      const maxFlyoutH = Math.max(120, winH - 100);
      const finalH = Math.min(flyoutH, maxFlyoutH);

      const maxY = Math.max(padding, winH - pillH - padding);
      const minY = Math.min(maxY, finalH + gap + padding);

      return {
        x: Math.round(clamp(centerX, minX, maxX)),
        y: Math.round(clamp(y, minY, maxY))
      };
    }

    // --- DOM Assembly ---

    _render() {
      const hasError = Boolean(this._lastErrorPayload);
      const errorHumanText = hasError ? formatHumanError(this._lastErrorPayload.code, this._lastErrorPayload.message) : '';
      const errCode = this._lastErrorPayload?.code || '';
      const errMsg = this._lastErrorPayload?.message || '';
      const errorCodeText = hasError ? (errCode ? (errMsg && errMsg !== errCode ? `${errCode}: ${errMsg}` : errCode) : errMsg) : '';

      this._shadow.innerHTML = `
        <style>${STYLES}</style>
        <div class="hha-root" data-el="root" data-active-tab="${this._activeTab}">
          <div class="hha-pill" data-el="pill">
            <div class="hha-pill-status-group" data-action="toggle-expand" data-el="pill-status-group" tabindex="0" role="button" aria-expanded="false" aria-label="Открыть настройки и очередь">
              <div class="hha-pill-progress-fill" data-el="pill-progress-fill"></div>
              <div class="hha-pill-status">
                <span class="hha-pill-progress" data-el="pill-progress"><span class="hha-current-count" data-el="pill-current-count">0</span> / <span class="hha-pill-limit-val" data-el="pill-limit-val">${MAX_DAILY_LIMIT}</span></span>
              </div>
              <span class="hha-pill-error-dot" data-el="pill-error-dot" style="${hasError ? 'display: inline-block;' : 'display: none;'}"></span>
            </div>
            <span class="hha-pill-queue-badge" data-action="open-queue-tab" data-el="pill-queue-badge" data-tooltip="Вакансии с анкетами в очереди" tabindex="0" role="button" aria-label="Очередь вакансий"></span>
            <button type="button" class="hha-btn-quick hha-btn-start" data-action="quick-toggle" data-el="pill-quick-btn">
              <span class="hha-btn-label" data-el="pill-quick-label">Старт</span>
            </button>
          </div>

          <!-- Flyout Overlay (390px wide, max 320px/520px height) -->
          <div class="hha-flyout" data-el="flyout" role="dialog" aria-modal="false" aria-label="Панель управления откликами">
            <!-- Top Header: Drag Handle & Collapse Button -->
            <header class="hha-island-header" data-el="island-header">
              <div class="hha-header-drag-handle" title="Перетащите для перемещения">
                <span class="hha-header-grip"></span>
              </div>
              <button type="button" class="hha-btn-collapse" data-action="collapse-island" aria-label="Свернуть панель" title="Свернуть">✕</button>
            </header>

            <!-- Floating Tooltip -->
            <div class="hha-tooltip" data-el="tooltip"></div>

            <!-- Panels -->
            <div class="hha-panels">
              <!-- Tab 1: Settings / Cover (Письмо) -->
              <div class="hha-panel ${this._activeTab === 'settings' ? 'active' : ''}" data-panel="settings"${this._activeTab === 'settings' ? '' : ' aria-hidden="true" inert'}>
                <div class="hha-card hha-card-cover" data-el="cover-card"${hasError ? ' style="display: none;"' : ''}>
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
                    <textarea class="hha-cover-textarea" data-el="setting-cover-text" maxlength="${MAX_COVER_LENGTH}" placeholder="Текст сопроводительного письма..."></textarea>
                    <div class="hha-char-counter" data-el="setting-cover-counter">0 / ${MAX_COVER_LENGTH}</div>
                  </div>
                </div>

                <div class="hha-card hha-card-error" data-el="error-card"${hasError ? '' : ' style="display: none;"'}>
                  <div class="hha-card-error-body">
                    <div class="hha-card-error-title" data-el="error-card-title">${errorHumanText}</div>
                    <div class="hha-card-error-code" data-el="error-card-code">${errorCodeText}</div>
                  </div>
                  <div class="hha-card-error-actions">
                    <button type="button" class="hha-btn-copy-error" data-action="copy-last-error" data-el="error-copy-btn" title="Скопировать детали ошибки">Скопировать</button>
                    <button type="button" class="hha-btn-dismiss-error" data-action="dismiss-error" data-el="error-dismiss-btn">Понятно</button>
                  </div>
                </div>
              </div>

              <!-- Tab 2: Queue (Очередь) -->
              <div class="hha-panel ${this._activeTab === 'queue' ? 'active' : ''}" data-panel="queue"${this._activeTab === 'queue' ? '' : ' aria-hidden="true" inert'}>
                <div class="hha-log-card">
                  <div class="hha-queue-toolbar">
                    <span class="hha-queue-toolbar-title" data-el="queue-toolbar-title">Вакансии с анкетами</span>
                    <button type="button" class="hha-btn-clear-all" data-action="clear-queue" data-el="clear-queue-btn">
                      <span class="hha-btn-clear-all-text">Очистить всё</span>
                    </button>
                  </div>
                  <div class="hha-log-stream" data-el="queue-stream">
                    <div class="hha-log-empty">
                      <div class="hha-log-empty-icon">${ICONS.inboxEmpty}</div>
                      <div class="hha-log-empty-text">Очередь пуста</div>
                      <div class="hha-log-empty-subtext">Сюда попадают вакансии с тестами и анкетами для ручного отклика</div>
                    </div>
                  </div>
                  <div class="hha-overlay-scrollbar" data-el="queue-scrollbar">
                    <div class="hha-overlay-thumb" data-el="queue-scroll-thumb"></div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Bottom Dock: Counter on the Left + Tabs in Center + Quick Action Button on the Right -->
            <footer class="hha-island-footer">
              <div class="hha-footer-status-group" data-action="toggle-expand" data-el="footer-status-group" tabindex="0" role="button" aria-expanded="true" aria-label="Свернуть панель" title="Отклики: текущие / лимит">
                <div class="hha-footer-status">
                  <span class="hha-footer-progress" data-el="footer-progress"><span class="hha-current-count" data-el="footer-current-count">0</span> / <span class="hha-pill-limit-val" data-el="footer-limit-val">${MAX_DAILY_LIMIT}</span></span>
                </div>
              </div>
              <div class="hha-tabs" data-active="${this._activeTab}" role="tablist" aria-label="Разделы панели">
                <div class="hha-tab-indicator" data-el="tab-indicator" style="left: ${this._activeTab === 'queue' ? 102 : 3}px; width: 97px;" aria-hidden="true"></div>
                <button type="button" class="hha-tab-btn ${this._activeTab === 'settings' ? 'active' : ''}" role="tab" aria-selected="${this._activeTab === 'settings' ? 'true' : 'false'}" data-action="switch-tab" data-tab="settings"><span>Письмо</span><span class="hha-tab-error-dot" data-el="settings-error-dot" style="${hasError ? 'display: inline-block;' : 'display: none;'}"></span></button>
                <button type="button" class="hha-tab-btn ${this._activeTab === 'queue' ? 'active' : ''}" role="tab" aria-selected="${this._activeTab === 'queue' ? 'true' : 'false'}" data-action="switch-tab" data-tab="queue"><span>Очередь</span><span class="hha-tab-badge is-queue" data-el="queue-tab-count" style="display: none;">0</span></button>
              </div>
              <div class="hha-footer-actions">
                <button type="button" class="hha-btn-quick hha-btn-start" data-action="quick-toggle" data-el="footer-quick-btn">
                  <span class="hha-btn-label" data-el="footer-quick-label">Старт</span>
                </button>
              </div>
            </footer>
          </div>
        </div>
      `;
    }

    _bindDomEvents() {
      if (!this._shadow || this._domEventsBound) return;
      this._domEventsBound = true;

      const root = this._shadow.querySelector('[data-el="root"]');
      const pill = this._shadow.querySelector('[data-el="pill"]');
      const header = this._shadow.querySelector('[data-el="island-header"]');
      if (!root || !pill) return;

      pill.addEventListener('pointerdown', (e) => this._onPointerDown(e, 'pill'));
      pill.addEventListener('pointermove', this._onPointerMove);
      pill.addEventListener('pointerup', this._onPointerUp);
      pill.addEventListener('pointercancel', this._onPointerUp);

      if (header) {
        header.addEventListener('pointerdown', (e) => this._onPointerDown(e, 'header'));
        header.addEventListener('pointermove', this._onPointerMove);
        header.addEventListener('pointerup', this._onPointerUp);
        header.addEventListener('pointercancel', this._onPointerUp);
      }

      root.addEventListener('click', (e) => this._handleRootClick(e));

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

      root.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          const target = e.target && typeof e.target.closest === 'function' 
            ? e.target.closest('[data-action], [role="button"]') 
            : null;
          if (target) {
            const tag = target.tagName.toLowerCase();
            if (tag !== 'button' && tag !== 'a' && tag !== 'input' && tag !== 'textarea') {
              if (e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault();
              }
              target.click();
            }
          }
        }
      });

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
            coverCounter.textContent = `${len} / ${MAX_COVER_LENGTH}`;
            coverCounter.classList.toggle('is-limit', len >= MAX_COVER_LENGTH);
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

      // Document Escape key listener to close overlay
      this._onDocKeyDown = (e) => {
        if (e && e.key === 'Escape' && this._isExpanded) {
          e.preventDefault();
          this.toggleExpand(false);
        }
      };
      if (typeof document !== 'undefined') {
        document.addEventListener('keydown', this._onDocKeyDown);
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
          if (this._isAnimating || !this._isExpanded) return;
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
      this._updateTabIndicator();
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

        if (this._isAnimating || !this._isExpanded || scrollH <= clientH + 1 || trackH <= 0) {
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
    }

    _handleAssistantError(payload) {
      return this._showError(payload);
    }

    _showError(errPayload) {
      if (!errPayload) return;
      const time = formatTime(errPayload.timestamp || Date.now());
      const code = errPayload.code || (errPayload.level === 'ERR' ? 'ERROR' : 'INFO');
      const message = String(errPayload.message || 'Произошла непредвиденная ошибка');
      const details = errPayload.details || errPayload.context || {};
      const url = details.url || (typeof window !== 'undefined' && window.location ? window.location.href : (typeof location !== 'undefined' ? location.href : ''));

      this._lastErrorPayload = {
        time,
        code,
        message,
        details,
        url
      };

      if (!this._shadow) return;

      const humanMsg = formatHumanError(code, message);
      const codeMsg = code ? (message && message !== code ? `${code}: ${message}` : code) : message;

      // 1. Update and show Error Card inside Settings tab, hide Cover Card
      const coverCard = this._shadow.querySelector('[data-el="cover-card"]');
      const errorCard = this._shadow.querySelector('[data-el="error-card"]');
      const errorTitle = this._shadow.querySelector('[data-el="error-card-title"]');
      const errorCode = this._shadow.querySelector('[data-el="error-card-code"]');

      if (coverCard) coverCard.style.display = 'none';
      if (errorCard) errorCard.style.display = 'flex';
      if (errorTitle) errorTitle.textContent = humanMsg;
      if (errorCode) errorCode.textContent = codeMsg;

      // 2. Show red error indicator on Settings tab button
      const settingsDot = this._shadow.querySelector('[data-el="settings-error-dot"]');
      if (settingsDot) settingsDot.style.display = 'inline-block';

      // 3. Switch tab to settings
      this._switchTab('settings');

      // 4. Show refined error indicator on collapsed pill
      const errorDot = this._shadow.querySelector('[data-el="pill-error-dot"]');
      if (errorDot) {
        errorDot.style.display = 'inline-block';
        errorDot.setAttribute('title', `${humanMsg} (нажмите для деталей)`);
      }
      const statusGroup = this._shadow.querySelector('[data-el="pill-status-group"]');
      if (statusGroup) {
        statusGroup.classList.add('has-error');
      }
      this._syncDocumentTitle();
    }

    _dismissError() {
      if (this._toastTimer) {
        clearTimeout(this._toastTimer);
        this._toastTimer = null;
      }
      this._lastErrorPayload = null;
      if (!this._shadow) return;

      // Hide error card, reveal cover card
      const coverCard = this._shadow.querySelector('[data-el="cover-card"]');
      const errorCard = this._shadow.querySelector('[data-el="error-card"]');
      if (errorCard) errorCard.style.display = 'none';
      if (coverCard) coverCard.style.display = 'flex';

      // Hide red error indicator on Settings tab button
      const settingsDot = this._shadow.querySelector('[data-el="settings-error-dot"]');
      if (settingsDot) settingsDot.style.display = 'none';

      const errorDot = this._shadow.querySelector('[data-el="pill-error-dot"]');
      if (errorDot) errorDot.style.display = 'none';
      const statusGroup = this._shadow.querySelector('[data-el="pill-status-group"]');
      if (statusGroup) statusGroup.classList.remove('has-error');
      this._syncDocumentTitle();
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
        requestAnimationFrame(() => {
          this._updateTabIndicator();
        });
      } else if (action === 'toggle-expand') {
        e.stopPropagation();
        this.toggleExpand();
      } else if (action === 'close-flyout' || action === 'collapse-island') {
        e.stopPropagation();
        this.toggleExpand(false);
      } else if (action === 'switch-tab') {
        e.stopPropagation();
        this.setActiveTab(actionTarget.dataset.tab);
      } else if (action === 'copy-last-error') {
        e.stopPropagation();
        this._copyLastErrorToClipboard(actionTarget);
      } else if (action === 'dismiss-error') {
        e.stopPropagation();
        this._dismissError();
      } else if (action === 'clear-queue') {
        e.stopPropagation();
        if (actionTarget.disabled || (typeof actionTarget.hasAttribute === 'function' && actionTarget.hasAttribute('disabled')) || this._queue.length === 0) {
          return;
        }
        if (this._queueConfirmTimer) {
          // Second click within confirmation window -> execute clear!
          clearTimeout(this._queueConfirmTimer);
          this._queueConfirmTimer = null;
          this._resetClearQueueBtn();
          if (this._assistant && typeof this._assistant.clearManualQueue === 'function') {
            this._assistant.clearManualQueue();
          } else {
            this._queue = [];
            this._syncQueue();
          }
        } else {
          // First click -> show inline confirmation "Точно очистить?"
          actionTarget.classList.add('is-confirming');
          actionTarget.innerHTML = '<span class="hha-btn-confirm-text">Точно очистить?</span>';
          this._queueConfirmTimer = setTimeout(() => {
            this._queueConfirmTimer = null;
            this._resetClearQueueBtn();
          }, 3000);
        }
      } else if (action === 'open-vacancy') {
        const vid = actionTarget.dataset.vid || actionTarget.dataset.cleanVid;
        const cVid = cleanVid(actionTarget.dataset.cleanVid || vid);
        const targetCard = actionTarget.closest('.hha-queue-card') || actionTarget;
        const url = targetCard.dataset.url || actionTarget.getAttribute('href') || targetCard.getAttribute('href');
        if (url && url !== '#' && !e.target.closest('a')) {
          try {
            window.open(url, '_blank', 'noopener,noreferrer');
          } catch (_) {}
        }
        if (cVid) {
          if (this._assistant && typeof this._assistant.markManualItemViewed === 'function') {
            this._assistant.markManualItemViewed(cVid, true);
          } else {
            const item = (this._queue || []).find(it => cleanVid(it.vid) === cVid);
            if (item) {
              item.viewed = true;
              item.viewedAt = Date.now();
              this._syncQueue();
            }
          }
        }
      } else if (action === 'delete-queue-item') {
        e.stopPropagation();
        const vid = actionTarget.dataset.vid || actionTarget.dataset.cleanVid;
        const cVid = cleanVid(actionTarget.dataset.cleanVid || vid);
        if (vid) {
          const card = actionTarget.closest('.hha-queue-card');
          if (card && !card.classList.contains('is-removing')) {
            card.style.maxHeight = `${card.offsetHeight}px`;
            void card.offsetHeight;
            card.classList.add('is-removing');
            setTimeout(() => {
              if (this._assistant && typeof this._assistant.removeManualItem === 'function') {
                this._assistant.removeManualItem(vid);
              } else {
                this._queue = this._queue.filter(it => cleanVid(it.vid) !== cVid);
                this._syncQueue();
              }
            }, 200);
          } else if (!card) {
            if (this._assistant && typeof this._assistant.removeManualItem === 'function') {
              this._assistant.removeManualItem(vid);
            } else {
              this._queue = this._queue.filter(it => cleanVid(it.vid) !== cVid);
              this._syncQueue();
            }
          }
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

    

    _copyLastErrorToClipboard(btnEl) {
      if (!this._lastErrorPayload) return;
      const err = this._lastErrorPayload;
      const lines = [
        `=== HH Apply Assistant Error Report ===`,
        `Time: ${err.time || formatTime()}`,
        `Code: ${err.code || 'UNKNOWN'}`,
        `Message: ${err.message || ''}`,
        `URL: ${err.url || (typeof window !== 'undefined' && window.location ? window.location.href : (typeof location !== 'undefined' ? location.href : ''))}`,
        `User-Agent: ${typeof navigator !== 'undefined' ? navigator.userAgent : ''}`
      ];
      if (err.details && Object.keys(err.details).length > 0) {
        try {
          lines.push(`Context: ${JSON.stringify(err.details, null, 2)}`);
        } catch (_) {
          lines.push(`Context: ${String(err.details)}`);
        }
      }
      const text = lines.join('\n');
      this._copyText(text);

      if (btnEl) {
        const origHtml = btnEl.innerHTML;
        btnEl.classList.add('is-copied');
        btnEl.textContent = 'Скопировано!';
        setTimeout(() => {
          btnEl.classList.remove('is-copied');
          btnEl.innerHTML = origHtml;
        }, 1800);
      }
    }

    

    _handleToggleAutomation() {
      if (!this._assistant) return;
      const now = Date.now();
      if (this._lastToggleTime && (now - this._lastToggleTime) < 250) return;
      this._lastToggleTime = now;

      if (this._status.status === 'running') {
        if (typeof this._assistant.stop === 'function') this._assistant.stop();
      } else if (this._status.status === 'done') {
        if (this._status.code === 'DAILY_LIMIT_REACHED') {
          if (this._assistant && typeof this._assistant.detectDailyLimit === 'function' && this._assistant.detectDailyLimit()) {
            this.open();
            this.setActiveTab('settings');
            return;
          }
          this.updateStatus('idle', 'IDLE');
          return;
        }
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
        partial.limit = Math.max(1, Math.min(MAX_DAILY_LIMIT, parseInt(partial.limit, 10) || 50));
      }
      if (partial && typeof partial.coverText === 'string' && partial.coverText.length > MAX_COVER_LENGTH) {
        partial.coverText = partial.coverText.slice(0, MAX_COVER_LENGTH);
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
        if (e.target.closest('button, input, textarea, a, select, .hha-pill-queue-badge, [data-action="collapse-island"]')) {
          return; // Let interactive controls handle their own events
        }
      }

      if (this._isPointerDown) return;

      const root = this._shadow ? (this._shadow.querySelector('[data-el="root"]') || this._shadow.querySelector('.hha-root')) : null;
      if (root) {
        root.classList.add('is-dragging');
      }

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
        const rawCenterX = this._dragStartPillPos.x + dx;
        const rawY = this._dragStartPillPos.y + dy;

        const winW = (typeof window !== 'undefined' && window.innerWidth) || 1024;
        const winH = (typeof window !== 'undefined' && window.innerHeight) || 768;

        this._pillPos = this._clampPillCoordinates(rawCenterX, rawY, winW, winH);
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
        const winW = (typeof window !== 'undefined' && window.innerWidth) || 1024;
        const winH = (typeof window !== 'undefined' && window.innerHeight) || 768;
        const flyoutMaxW = 390;
        const halfW = flyoutMaxW / 2;
        const padding = 16;
        const flyoutH = 520;
        const gap = 8;
        const pillH = 36;
        const maxFlyoutH = Math.max(120, winH - 100);
        const finalH = Math.min(flyoutH, maxFlyoutH);
        const maxY = Math.max(padding, winH - pillH - padding);
        const minY = Math.min(maxY, finalH + gap + padding);

        let snappedX = this._pillPos.x;
        let snappedY = this._pillPos.y;
        let didSnap = false;

        const leftDist = this._pillPos.x - halfW;
        const rightDist = winW - (this._pillPos.x + halfW);
        const topDist = this._pillPos.y - minY;
        const bottomDist = maxY - this._pillPos.y;

        if (leftDist < 36) {
          snappedX = 16 + halfW;
          didSnap = true;
        } else if (rightDist < 36) {
          snappedX = winW - 16 - halfW;
          didSnap = true;
        }

        if (topDist < 36) {
          snappedY = minY;
          didSnap = true;
        } else if (bottomDist < 36) {
          snappedY = maxY;
          didSnap = true;
        }

        if (didSnap) {
          this._pillPos = this._clampPillCoordinates(snappedX, snappedY, winW, winH);
          if (root) {
            root.classList.add('is-snapping');
            if (this._snapTimer) clearTimeout(this._snapTimer);
            this._snapTimer = setTimeout(() => {
              if (root) root.classList.remove('is-snapping');
              this._snapTimer = null;
            }, 260);
          }
        }

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

      // Pill is ALWAYS at the bottom, flyout is ALWAYS above the pill
      root.classList.add('dir-up');
      root.classList.toggle('is-expanded', this._isExpanded);

      // Strict Center Anchor positioning: Center X stays stable regardless of pill width expansions
      const padding = 16;
      const flyoutMaxW = 390;
      const halfW = flyoutMaxW / 2;
      const minX = padding + halfW;
      const maxX = Math.max(minX, winW - padding - halfW);
      const clampedCenterX = Math.round(clamp(this._pillPos.x, minX, maxX));
      root.style.left = `${clampedCenterX}px`;
      root.style.right = 'auto';
      root.style.alignItems = 'end';
      if (typeof root.style.setProperty === 'function') {
        root.style.setProperty('--center-x', `${clampedCenterX}px`);
        const pillWidth = this._getPillWidth();
        root.style.setProperty('--pill-width', `${pillWidth}px`);
        const isQueue = this._activeTab === 'queue';
        const baseH = isQueue ? 520 : 320;
        const maxFlyoutH = isQueue
          ? Math.max(120, winH - 100)
          : Math.max(120, winH - 36 - 8 - padding * 2);
        const finalH = Math.min(baseH, maxFlyoutH);
        root.style.setProperty('--flyout-height', `${finalH}px`);
      }

      // Vertical positioning: bottom anchor
      const bottomDist = Math.max(8, winH - (this._pillPos.y + 36));
      root.style.top = 'auto';
      root.style.bottom = `${bottomDist}px`;

      const flyout = this._shadow.querySelector('.hha-flyout');
      if (flyout) {
        flyout.style.maxHeight = '';
        flyout.style.height = '';
      }
    }

    _restorePosition() {
      const winW = (typeof window !== 'undefined' && window.innerWidth) || 1024;
      const winH = (typeof window !== 'undefined' && window.innerHeight) || 768;

      // Default position: Bottom-Right with 24px margin
      const defCenterX = Math.max(203, winW - 219);
      const defY = Math.max(8, winH - 36 - 24);

      let pos = null;
      try {
        if (typeof localStorage !== 'undefined') {
          const rawV3 = localStorage.getItem('hha_hud_pos_v3');
          if (rawV3) {
            pos = JSON.parse(rawV3);
          } else {
            // Migrate legacy v2 coordinate (v2 stored left coordinate)
            const rawV2 = localStorage.getItem('hha_hud_pos_v2');
            if (rawV2) {
              const p2 = JSON.parse(rawV2);
              if (p2 && typeof p2.x === 'number') {
                pos = { x: p2.x + 83, y: p2.y };
              }
            }
          }
        }
      } catch (_) {}

      if (pos && typeof pos.x === 'number' && !isNaN(pos.x) && typeof pos.y === 'number' && !isNaN(pos.y)) {
        this._pillPos = this._clampPillCoordinates(pos.x, pos.y, winW, winH);
      } else {
        this._pillPos = this._clampPillCoordinates(defCenterX, defY, winW, winH);
      }

      this._persistPosition();
      this._updatePosition();
    }

    _persistPosition() {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('hha_hud_pos_v3', JSON.stringify({ x: this._pillPos.x, y: this._pillPos.y }));
        }
      } catch (_) {}
    }

    // --- State Synchronizers ---

    _syncAll() {
      this._syncStatus();
      this._syncProgress();
      this._syncConfig();
      this._syncQueue();
    }

    _syncStatus() {
      if (!this._shadow) return;
      const { status = 'idle' } = this._status || {};
      const isRunning = status === 'running';

      const root = this._shadow.querySelector('[data-el="root"]') || this._shadow.querySelector('.hha-root');
      if (root) {
        root.classList.toggle('is-running', isRunning);
      }

      const quickBtns = this._shadow.querySelectorAll('.hha-btn-quick');
      if (quickBtns.length > 0) {
        let targetClass = 'hha-btn-start';
        let targetLabel = 'Старт';
        let targetTitle = 'Запустить автоматизацию';

        if (isRunning) {
          targetClass = 'hha-btn-stop';
          targetLabel = 'Стоп';
          targetTitle = 'Остановить автоматизацию';
        } else if (status === 'done' || (this._status && this._status.code === 'DAILY_LIMIT_REACHED')) {
          targetClass = 'hha-btn-done';
          const isDaily = this._status && this._status.code === 'DAILY_LIMIT_REACHED';
          targetLabel = isDaily ? 'Лимит 24ч' : 'Готово';
          targetTitle = isDaily ? `Достигнут суточный лимит HeadHunter (${MAX_DAILY_LIMIT} откликов за 24 часа)` : 'Лимит достигнут. Кликните для настройки';
        } else if (status === 'error') {
          targetClass = 'hha-btn-error';
          targetLabel = 'Сброс';
          targetTitle = 'Ошибка. Кликните для перезапуска';
        }

        const labelChanged = this._lastBtnLabel !== targetLabel;
        this._lastBtnLabel = targetLabel;

        quickBtns.forEach(quickBtn => {
          quickBtn.title = targetTitle;
          const desiredClassName = `hha-btn-quick ${targetClass}`;
          if (quickBtn.className !== desiredClassName) {
            quickBtn.className = desiredClassName;
          }

          let labelEl = quickBtn.querySelector('.hha-btn-label');
          if (!labelEl) {
            quickBtn.innerHTML = `<span class="hha-btn-label">${targetLabel}</span>`;
          } else if (!this._hasSyncedStatus) {
            labelEl.textContent = targetLabel;
          } else if (labelChanged) {
            labelEl.classList.add('is-swapping');
            setTimeout(() => {
              if (labelEl) {
                labelEl.textContent = targetLabel;
                labelEl.classList.remove('is-swapping');
              }
            }, 80);
          } else {
            labelEl.textContent = targetLabel;
          }
        });
        this._hasSyncedStatus = true;
      }
      this._syncDocumentTitle();
    }

    _cleanDocTitle(str) {
      if (!str) return 'HeadHunter';
      return String(str)
        .replace(/^[▶✓⚠]\s*(?:\([^)]*\))?\s*(?:Готово|Внимание!)?\s*[—–-]?\s*/i, '')
        .trim();
    }

    _syncDocumentTitle() {
      if (typeof document === 'undefined') return;
      if (!this._originalDocTitle) {
        this._originalDocTitle = document.title || 'HeadHunter';
      }
      const { status = 'idle', code = 'IDLE' } = this._status || {};
      const { displayCurrent = 0, limit = 50 } = this._progress || {};
      const baseTitle = this._cleanDocTitle(this._originalDocTitle);

      if (status === 'running') {
        document.title = `▶ (${displayCurrent}/${limit}) ${baseTitle}`;
      } else if (code === 'CAPTCHA_DETECTED' || status === 'error') {
        document.title = `⚠ Внимание! ${baseTitle}`;
      } else if (status === 'done') {
        document.title = `✓ (${displayCurrent}/${limit}) Готово — ${baseTitle}`;
      } else if (this._originalDocTitle) {
        document.title = this._originalDocTitle;
      }
    }

    _syncProgress() {
      if (!this._shadow) return;
      const { sent = 0, displayCurrent } = this._progress || {};
      const limitCount = MAX_DAILY_LIMIT;
      const cur = displayCurrent !== undefined ? displayCurrent : Math.min(Math.max(0, sent), limitCount);
      const text = `${cur} / ${limitCount}`;

      const currentEls = this._shadow.querySelectorAll('.hha-current-count');
      currentEls.forEach(el => { el.textContent = String(cur); });
      const limitEls = this._shadow.querySelectorAll('.hha-pill-limit-val');
      limitEls.forEach(el => { el.textContent = String(limitCount); });

      const pillProg = this._shadow.querySelector('[data-el="pill-progress"]');
      if (pillProg && currentEls.length === 0) {
        pillProg.textContent = text;
      }

      const pillFills = this._shadow.querySelectorAll('[data-el="pill-progress-fill"], [data-el="footer-progress-fill"]');
      if (pillFills.length) {
        const percent = limitCount > 0 ? Math.min(100, Math.max(0, Math.round((cur / limitCount) * 100))) : 0;
        pillFills.forEach(fill => { fill.style.width = `${percent}%`; });
      }
      this._syncDocumentTitle();
    }

    _syncQueue() {
      if (!this._shadow) return;
      this._hideTooltip();
      const count = this._queue ? this._queue.length : 0;

      const toolbarTitle = this._shadow.querySelector('[data-el="queue-toolbar-title"]');
      if (toolbarTitle) {
        toolbarTitle.textContent = count > 0 ? `Вакансии с анкетами (${count})` : 'Вакансии с анкетами';
      }

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
            if (typeof requestAnimationFrame === 'function') {
              requestAnimationFrame(() => {
                if (queueBadge) queueBadge.classList.add('is-popping');
              });
            } else {
              queueBadge.classList.add('is-popping');
            }
          }
        } else {
          queueBadge.style.display = '';
          queueBadge.classList.remove('is-visible', 'is-popping', 'is-wide');
          if (this._badgeClearTimer) clearTimeout(this._badgeClearTimer);
          this._badgeClearTimer = setTimeout(() => {
            if (this._queue && this._queue.length === 0 && queueBadge) {
              queueBadge.textContent = '';
            }
          }, 220);
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

      const queueTabCount = this._shadow.querySelector('[data-el="queue-tab-count"]');
      if (queueTabCount) {
        if (count > 0) {
          queueTabCount.textContent = String(count);
          queueTabCount.setAttribute('title', `В очереди: ${count}`);
          queueTabCount.setAttribute('aria-label', `В очереди: ${count}`);
          queueTabCount.style.display = 'inline-flex';
        } else {
          queueTabCount.textContent = '';
          queueTabCount.removeAttribute('title');
          queueTabCount.removeAttribute('aria-label');
          queueTabCount.style.display = 'none';
        }
        this._updateTabIndicator();
      }

      const queueStream = this._shadow.querySelector('[data-el="queue-stream"]');
      if (queueStream) {
        if (this._queue && this._queue.length > 0) {
          // Sort queue: unviewed items first, viewed items last; newest first within each group
          const sorted = [...this._queue].sort((a, b) => {
            const aViewed = a.viewed ? 1 : 0;
            const bViewed = b.viewed ? 1 : 0;
            if (aViewed !== bViewed) return aViewed - bViewed;
            return (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0);
          });
          queueStream.innerHTML = sorted.map(item => {
            const rawVid = item.vid ? String(item.vid) : '';
            const cVid = cleanVid(rawVid);
            const targetUrl = toVacancyUrl(cVid, item.url);
            let displayTitle = collapseSpaces(item.title || '');
            displayTitle = displayTitle.replace(/\s*#\d+\b/g, '').trim();
            if (!displayTitle || /^(?:отклик на вакансию|отклик без резюме)$/i.test(displayTitle)) {
              displayTitle = 'Вакансия';
            }
            const displayEmployer = collapseSpaces(item.employer || '');
            const reasonInfo = formatQueueReasonInfo(item.reason);
            const cleanSalary = formatCleanSalary(item.salary || '');
            const isViewed = Boolean(item.viewed);

            return `
              <div class="hha-queue-card ${isViewed ? 'is-viewed' : ''}" data-action="open-vacancy" data-vid="${escapeHtml(rawVid || cVid)}" data-clean-vid="${escapeHtml(cVid)}" data-url="${escapeHtml(targetUrl || '#')}" role="link" tabindex="0" title="Открыть вакансию в новой вкладке">
                <div class="hha-queue-card-top">
                  <a href="${escapeHtml(targetUrl || '#')}" target="_blank" rel="noopener noreferrer" class="hha-queue-title-link" data-action="open-vacancy" data-vid="${escapeHtml(rawVid || cVid)}" data-clean-vid="${escapeHtml(cVid)}" data-tooltip="${escapeHtml(displayTitle)}">
                    <span class="hha-queue-title-text">${escapeHtml(displayTitle)}</span>
                  </a>
                  <button type="button" class="hha-log-item-delete" data-action="delete-queue-item" data-vid="${escapeHtml(rawVid || cVid)}" data-clean-vid="${escapeHtml(cVid)}" data-tooltip="Удалить из очереди" aria-label="Удалить из очереди">✕</button>
                </div>
                ${displayEmployer ? `
                <div class="hha-queue-card-mid">
                  <span class="hha-queue-employer" title="${escapeHtml(displayEmployer)}">${escapeHtml(displayEmployer)}</span>
                </div>` : ''}
                <div class="hha-queue-card-bottom">
                  ${isViewed ? `<span class="hha-queue-badge badge-viewed">Просмотрено</span>` : ''}
                  <span class="hha-queue-badge badge-${escapeHtml(reasonInfo.type)}">${escapeHtml(reasonInfo.text)}</span>
                  ${cleanSalary ? `<span class="hha-queue-salary" title="${escapeHtml(item.salary || cleanSalary)}">${escapeHtml(cleanSalary)}</span>` : ''}
                </div>
              </div>
            `;
          }).join('');
        } else {
          queueStream.innerHTML = `
            <div class="hha-log-empty">
              <div class="hha-log-empty-icon">${ICONS.inboxEmpty}</div>
              <div class="hha-log-empty-text">Очередь пуста</div>
              <div class="hha-log-empty-subtext">Сюда попадают вакансии с тестами и анкетами для ручного отклика</div>
            </div>
          `;
        }
      }

      if (this._isExpanded && this._activeTab === 'queue' && !this._isAnimating) {
        this._updateOverlayScrollbar();
      }
    }

    _syncConfig() {
      if (!this._shadow) return;
      const c = this._config || {};

      const limitEl = this._shadow.querySelector('.hha-pill-limit-val') || this._shadow.querySelector('[data-el="pill-limit-val"]');
      if (limitEl) {
        limitEl.textContent = String(MAX_DAILY_LIMIT);
      }

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
        coverCounter.textContent = `${len} / ${MAX_COVER_LENGTH}`;
        coverCounter.classList.toggle('is-limit', len >= MAX_COVER_LENGTH);
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
  if (!globalThis.__HHA_TEST__ && typeof window !== 'undefined' && typeof document !== 'undefined') {
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
