// ==UserScript==
// @name         HH Apply Assistant
// @namespace    https://github.com/tgeruzov/hh-apply-assistant
// @version      0.2.25
// @author       Timur Geruzov
// @description  Автоматические отклики на вакансии hh.ru из поиска. Вакансии с тестами и анкетами откладывает в очередь для ручного отклика
// @license      GPL-3.0-only
// @homepageURL  https://github.com/tgeruzov/hh-apply-assistant
// @supportURL   https://github.com/tgeruzov/hh-apply-assistant/issues
// @updateURL    https://raw.githubusercontent.com/tgeruzov/hh-apply-assistant/main/hh-apply-assistant.user.js
// @downloadURL  https://raw.githubusercontent.com/tgeruzov/hh-apply-assistant/main/hh-apply-assistant.user.js
// @match        https://*.hh.ru/search/vacancy*
// @match        https://*.hh.ru/vacancy/*
// @match        https://*.hh.ru/applicant/vacancy_response*
// @match        https://*.hh.ru/article/*
// @match        https://*.hh.ru/vrsurvey/*
// @noframes
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// --- Global Shared Configuration Constants ---
const MAX_DAILY_LIMIT = 200;
const MAX_COVER_LENGTH = 5000;

// Set by the engine (part 1) and read by the HUD (part 2). The userscript manager wraps
// the file in a function, so it is not visible to the page.
let hhaEngine = null;

// --- Global Shared Utilities ---
function clamp(val, min, max) {
  const num = Number(val);
  if (isNaN(num)) return min;
  return Math.max(min, Math.min(max, num));
}

const collapseSpaces = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// At most n UTF-16 units, without cutting a surrogate pair in half: half an emoji turns
// into a replacement sign once the text is sent.
function sliceSafe(s, n) {
  const str = String(s ?? '');
  if (str.length <= n) return str;
  const last = str.charCodeAt(n - 1);
  return str.slice(0, last >= 0xD800 && last <= 0xDBFF ? n - 1 : n);
}

// A stored value as text: strings and numbers only. Anything else in storage (an object
// written by another script or by hand) would show up as "[object Object]".
const asText = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

const formatCleanSalary = (raw) => {
  if (!raw) return '';
  return collapseSpaces(
    String(raw)
      // [а-яё], not \w: without the u flag \w is Latin only, and "за 1 смену" left a stray "у".
      .replace(/(?:до\s+вычета\s+(?:налогов|ндфл)|на\s+руки|за\s+месяц|за\s+\d+\s+смен[а-яё]*|после\s+вычета|gross|net)/gi, '')
      .replace(/[,.]\s*$/g, '')
  );
};

function cleanVid(vid) {
  return vid ? String(vid).trim().replace(/^v_/i, '') : '';
}

// Russian plural: pluralRu(5, 'отклик', 'отклика', 'откликов') gives 'откликов'.
function pluralRu(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

// "4 с" with a narrow no-break space: the unit stays next to the number and never
// wraps to the next line on its own. A minute or more is "1:45": "105 с" is hard to read
// and does not fit the pill.
const formatSeconds = (n) => (n >= 60 ? `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}` : `${n}\u202Fс`);

function formatTime(dOrTs = new Date()) {
  const d = dOrTs instanceof Date ? dOrTs : (dOrTs ? new Date(dOrTs) : new Date());
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Cover letter variables: {должность} is the vacancy title, {компания} the employer.
// Text after a bar, {компания|вашей компании}, is used when the page has no such name.
const LETTER_VARS = Object.freeze({ 'должность': 'title', 'компания': 'employer' });
const LETTER_VAR_RE = /\{([^{}|]*)(?:\|([^{}]*))?\}/g;
const letterVarKey = (rawName) => LETTER_VARS[collapseSpaces(rawName).toLowerCase().replace(/ё/g, 'е')] || null;

// Fills the variables in a letter. A variable with no value and no fallback stays as
// written and is listed in `missing`; unknown names like {React} are left alone.
function renderLetter(template, values = {}) {
  const missing = [];
  const text = String(template || '').replace(LETTER_VAR_RE, (whole, rawName, fallback) => {
    const key = letterVarKey(rawName);
    if (!key) return whole;
    if (values[key]) return values[key];
    if (fallback !== undefined && fallback.trim()) return fallback.trim();
    missing.push(collapseSpaces(rawName).toLowerCase());
    return whole;
  });
  return { text, missing };
}

// Names in braces that are not letter variables, e.g. a typo like {компанiя}.
function unknownLetterVars(template) {
  const names = [];
  for (const m of String(template || '').matchAll(LETTER_VAR_RE)) {
    if (!letterVarKey(m[1]) && !names.includes(m[0])) names.push(m[0]);
  }
  return names;
}

// "ООО HeadHunter::Analytics" becomes "HeadHunter" and "Сбер. Начало карьеры" becomes
// "Сбер": the legal form and the department read badly in a letter, and so do quotes
// around the whole name. hh.ru writes a department either after "::" or after a one-word
// brand and a dot; "Иванов И. И." or "2ГИС.Коммерция" do not match the second form.
function cleanEmployerName(raw) {
  let name = collapseSpaces(raw).split('::')[0].trim();
  name = name.replace(/^(?:ООО|ОАО|ЗАО|ПАО|НАО|АО|ИП|АНО|НКО|ФГУП|ГУП|МУП|LLC)\s+/, '');
  const dept = /^([^\s.]{3,})\.\s+[А-ЯЁA-Z]/.exec(name);
  if (dept) name = dept[1];
  const quoted = /^["'\u00ab\u201e\u201c](.+)["'\u00bb\u201c\u201d]$/.exec(name);
  if (quoted && !/["'\u00ab\u00bb\u201e\u201c\u201d]/.test(quoted[1])) name = quoted[1].trim();
  return name;
}

// "Специалист поддержки, г.Ставрополь" becomes "Специалист поддержки": a city at the end
// of the title is for the search, in a letter it reads as a typo.
function cleanVacancyTitle(raw) {
  return collapseSpaces(raw).replace(/\s*(?:,\s*|\(\s*)г\.\s*[А-ЯЁ][^,()]*\)?$/, '').trim();
}

/**
 * ============================================================================
 * Part 1: Automation Engine (Headless Core)
 * ============================================================================
 */

(function () {
  'use strict';

  // --- 1. Constants, Selectors & Defaults ---
  // GM_info is available to every userscript, including @grant none; 'dev' is for runs outside a manager.
  const VERSION = (typeof GM_info !== 'undefined' && GM_info.script?.version) || 'dev';
  // This file's address as stack traces show it (Tampermonkey's userscript.html?name=...,
  // the mock's /hha.user.js), to tell this script's errors from the page's. Empty when the
  // stack has no address of its own or it is the page itself (a script injected inline).
  const OWN_SCRIPT_URL = (() => {
    try {
      const m = /((?:https?|chrome-extension|moz-extension|safari-web-extension|blob):[^\s()@]+?):\d+:\d+/.exec(new Error().stack || '');
      const url = m ? m[1] : '';
      const page = String(globalThis.location?.href || '').split('#')[0];
      return url && url !== page ? url : '';
    } catch (_) {
      return '';
    }
  })();
  const SELECTORS = {
    modal: '[data-qa="bottom-sheet-content"], [data-qa="vacancy-response-popup-form"], [data-qa*="modal" i], [class*="modal" i], [data-qa*="popup" i], [class*="popup" i], [role="dialog"]',
    modalClose: '[data-qa="vacancy-response-popup-close"], [data-qa*="close" i], button[aria-label*="закрыть" i]',
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
    applyBtn: { name: 'Кнопка "Откликнуться" в поисковой выдаче' },
    vacancyApply: { name: 'Кнопка "Откликнуться" на странице вакансии' },
    attachCoverBtn: { name: 'Кнопка "Прикрепить сопроводительное" после отклика' },
    attachCoverInModal: { name: 'Переключатель письма в модальном окне' },
    letterTextarea: { name: 'Поле ввода текста письма' },
    letterSubmit: { name: 'Кнопка отправки формы отклика' },
    relocationBtn: { name: 'Подтверждение предупреждения о релокации' },
    vacancyCard: { name: 'Карточка вакансии в выдаче' },
    pagerNext: { name: 'Кнопка "Дальше" (пагинация поиска)' },
    rejectWarning: { name: 'Предупреждение о возможном отказе' },
    responseChat: { name: 'Ссылка на чат после отклика' },
    vacancyLink: { name: 'Ссылка на вакансию в выдаче' }
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
    pendingVacancyMeta: STORAGE_PREFIX + 'pending_vacancy_meta',
    blacklist: STORAGE_PREFIX + 'blacklist_v1',
    appliedHistory: STORAGE_PREFIX + 'applied_v1',
    queuedHistory: STORAGE_PREFIX + 'queued_v1',
    skippedHistory: STORAGE_PREFIX + 'skipped_v1',
    attempts: STORAGE_PREFIX + 'attempts_v1',
    dailyCounters: STORAGE_PREFIX + 'daily_counters',
    lastCommittedVid: STORAGE_PREFIX + 'last_committed_vid',
    captchas: STORAGE_PREFIX + 'captchas_v1',
    logBuffer: 'hha:log_buffer',
    watchdogStallCount: 'hha:watchdog_stall_count',
    watchdogStallVid: 'hha:watchdog_stall_vid',
    hiddenSince: 'hha:hidden_since',
    skipAlertShown: 'hha:skip_alert_shown',
    sessionProcessedTotal: 'hha:session_processed_total',
    sessionAnomalousSkips: 'hha:session_anomalous_skips',
    runStats: 'hha:run_stats',
    runVisits: 'hha:run_visits',
    runPages: 'hha:run_pages',
    noButtonStreak: 'hha:no_button_streak',
    inflight: 'hha:inflight',
    lateApplied: 'hha:late_applied',
    paceState: 'hha:pace_state',
    paceTest: 'hha:pace_test',
    lastRun: 'hha:last_run'
  };

  const MAX_VACANCY_ATTEMPTS = 3;
  const BLACKLIST_TTL = 24 * 60 * 60 * 1000; // 24 hours
  const PAGE_WATCHDOG_TIMEOUT = 15000; // 15 seconds
  const WATCHDOG_STALL_TIMEOUT = 60000; // 60 seconds stall timeout
  const SKIP_ALERT_RATIO = 0.7; // 70% threshold for skip rate alert
  const MAX_LOG_ENTRIES = 1000;
  // A watchdog tick normally comes every second. A longer gap means the page did not run
  // at all: the computer slept, or the browser paused the background tab.
  const TIMER_GAP_MS = 30000;
  // A tick this late means the page's timers were held back, not that the run hung.
  const TICK_LATE_MS = 3000;

  // Text rules of the detectors, in one place so they can be narrowed by the decision log.
  // Several of them look alike on purpose: each one is tuned to where it is applied.
  const TEXT_RULES = Object.freeze({
    // Access and page state.
    inaccessible: /(?:вам\s+недоступна\s+эта\s+вакансия|войдите\s+как\s+пользователь[,\s]+у\s+которого\s+есть\s+доступ|вакансия\s+(?:закрыта|в\s+архиве|удалена|не\s+найдена)|эта\s+вакансия\s+была\s+удалена|похоже[,\s]+этой\s+вакансии\s+больше\s+нет)/i,
    captcha: /(?:подтвердите,?\s*что\s*вы\s*не\s*робот|введите\s*символы\s*с\s*картинки|вы\s+не\s+робот|not\s+a\s+robot|необычн\w*\s+активн|unusual\s+(?:activity|traffic))/i,
    dailyLimit: /(?:исчерпали\s+лимит\s+откликов|не\s+более\s+200\s+откликов|в\s+течение\s+24\s+часов\s+можно\s+совершить\s+не\s+более|лимит\s+откликов[,\s]+попробуйте\s+отправить\s+отклик\s+позднее|лимит\s+откликов.*попробуйте|24\s+часов?\s+можно\s+совершить\s+не\s+более|вы\s+исчерпали\s+лимит|daily\s+application\s+limit|reached\s+(?:the\s+)?limit\s+of\s+(?:200\s+)?applications)/i,
    // Document title; a bare 429/503 would also match a salary like "смена 4290".
    rateLimitTitle: /(?:^\s*(?:429|503)\b|(?:error|ошибка)\s*(?:429|503)\b|доступ\s+ограничен|too\s+many\s+requests|service\s+(?:temporarily\s+)?unavailable)/i,
    rateLimitPage: /(?:слишком\s*много\s*запросов|429\s*Too\s*Many\s*Requests|503\s*Service\s*Unavailable|доступ\s*(?:временно\s*)?ограничен|access\s*(?:temporarily\s*)?denied|error\s+429|error\s+503)/i,

    // Reasons to skip or queue a vacancy.
    reject: /(?:не\s*соответствует(?:\s*требованиям)?|не\s*подходит|(?:^|[\s.,!?:;\u00ab\u00bb'"()\u2014\u2013-])отказ(?:а|у|ом|ы)?(?=[\s.,!?:;\u00ab\u00bb'"()\u2014\u2013-]|$)|reject|warning)/i,
    testPage: /(?:необходимо\s+пройти\s+тест|ответьте\s+на\s+(?:следующие\s+)?вопрос|тестовое\s+задание\s*работодателя|анкета\s+работодателя|пройти\s+опрос)/i,
    // "Чтобы откликнуться на эту вакансию, поменяйте видимость резюме на 'Видно всем'" (2026-10-18):
    // the employer takes only resumes visible to all, so the response cannot go.
    resumeHidden: /резюме\s*скрыто|resume\s*is\s*hidden|(?:поменяйте|измените)\s+видимость\s+резюме/i,
    // Only a request to take a test counts: a bare "test" or "тестирование" also matched the
    // vacancy and resume titles the modal shows, like "QA Test Engineer".
    modalTest: /анкета|вопросы|questionnaire|(?:пройти|пройдите)\s+тест|take\s+(?:a|the)\s+test/i,
    modalCaptcha: /капч[аеы]|captcha|recaptcha|smartcaptcha/i,
    modalRateLimit: /слишком\s*много\s*запросов|доступ\s*ограничен|rate\s*limit|blocked/i,
    resumeChoice: /(?:выберите|выбор)\s+(?:подходящее\s+)?резюме|резюме\s+для\s+отклика/i,

    // Relocation warning: its text and the confirm buttons.
    relocationText: /откликаетесь\s+на\s+вакансию\s+в\s+другой\s+стране|в\s+другой\s+стране/i,
    relocationConfirm: /^вс[её]\s*равно(?:\s*откликнуться)?$/i,
    relocationConfirmPlain: /^(?:откликнуться|подтвердить)$/i,

    // A response exists. The sets differ by scope: the page text, a modal, the vacancy
    // page, a search card, and the visible text logged for an unconfirmed submit.
    alreadyApplied: /(?:вы уже откликались|отклик уже отправлен|already applied)/i,
    sentInModal: /(?:отклик отправлен|вы откликнулись|резюме доставлено|резюме отправлено|response sent|applied successfully)/i,
    sentOnPage: /(?:отклик отправлен|вы уже откликались|вы откликнулись|резюме доставлено)/i,
    serpCardApplied: /(?:вы откликнулись|резюме доставлено|отклик отправлен)/i,
    sentAnyVisible: /(?:отклик отправлен|вы откликнулись|резюме доставлено|резюме отправлено|вы уже откликались)/i
  });

  const ACTION_TIMINGS = { delay: [3500, 6500], action: [250, 500] };

  const DEFAULT_COVER_TEXT = 'Здравствуйте! Меня заинтересовала ваша вакансия. Ознакомьтесь, пожалуйста, с моим резюме.';
  const DEFAULTS = {
    coverText: DEFAULT_COVER_TEXT,
    useCover: false,
    skipHidden: true,
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
      this._e[event] = this._e[event].filter(h => h !== fn);
      if (!this._e[event].length) delete this._e[event];
    }

    emit(event, ...args) {
      const handlers = this._e[event];
      if (!handlers) return;
      for (const h of handlers.slice()) {
        try { h(...args); } catch (err) { console.error(`[HH] Listener error for "${event}":`, err); }
      }
    }
    removeAllListeners(event) {
      if (event) delete this._e[event]; else this._e = Object.create(null);
    }
  }
  const events = new EventEmitter();

  // --- 3. Storage Layer ---
  function getNativeStore(type) {
    try {
      return globalThis[type === 'local' ? 'localStorage' : 'sessionStorage'] || null;
    } catch (_) {
      return null;
    }
  }

  function storeGet(type, key) {
    try {
      const s = getNativeStore(type);
      return s ? s.getItem(key) : null;
    } catch (_) {
      return null;
    }
  }

  // The log is the biggest key in localStorage and the least needed one: when the storage
  // is full, it gives way to the queue, the counters and the lists, down to its last entries.
  const LOG_KEEP_ON_FULL = 100;
  function freeLogSpace(s) {
    try {
      const list = JSON.parse(s.getItem(KEYS.logBuffer) || '[]');
      if (!Array.isArray(list) || list.length <= LOG_KEEP_ON_FULL) return false;
      s.setItem(KEYS.logBuffer, JSON.stringify(list.slice(-LOG_KEEP_ON_FULL)));
      return true;
    } catch (_) {
      return false;
    }
  }

  let storageFailureLogged = false;
  function storeSet(type, key, val) {
    let s = null;
    try {
      s = getNativeStore(type);
      if (!s) return false;
      s.setItem(key, String(val));
      return true;
    } catch (e) {
      if (s && type === 'local' && key !== KEYS.logBuffer && freeLogSpace(s)) {
        try {
          s.setItem(key, String(val));
          return true;
        } catch (_) {}
      }
      console.warn(`[HH] Storage write failed on ${type}Storage (key: ${key}):`, e);
      // Once per page: a write that did not go through is lost data, and the log says which.
      if (key !== KEYS.logBuffer && !storageFailureLogged) {
        storageFailureLogged = true;
        hhaLog('warn', 'storage_write_failed', { storage: type, key, error: String(e && e.name || e) });
      }
      return false;
    }
  }

  function storeRemove(type, key) {
    try {
      const s = getNativeStore(type);
      if (s) s.removeItem(key);
      return true;
    } catch (_) {
      return false;
    }
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

  // A local address counts only on a local page, that is in a mock of hh.ru. On hh.ru a
  // stored link to localhost (the queue is in localStorage, open to the page's scripts)
  // would open a local service, and an apply button with one would be followed.
  const LOCAL_HOST_RE = /^(?:localhost|127\.0\.0\.1)$/i;
  function toSafeHhUrl(rawUrl) {
    if (!rawUrl) return '';
    try {
      const base = globalThis.location?.href || 'https://hh.ru';
      const u = new URL(String(rawUrl), base);
      const isHh = /(^|\.)hh\.ru$/i.test(u.hostname);
      const isLocal = LOCAL_HOST_RE.test(u.hostname) && LOCAL_HOST_RE.test(globalThis.location?.hostname || '');
      return (['http:', 'https:'].includes(u.protocol) && (isHh || isLocal)) ? u.href : '';
    } catch (_) {
      return '';
    }
  }

  function toSearchListUrl(rawUrl) {
    const safe = toSafeHhUrl(rawUrl);
    return safe && new URL(safe).pathname.startsWith('/search/vacancy') ? safe : '';
  }

  // --- 5. Error Reporting, Logging & Telemetry ---
  const SENSITIVE_KEYS = new Set(['covertext', 'letter', 'text', 'cover', 'name', 'phone', 'email', 'fio', 'resume', 'applicant', 'applicantname', 'covermessage', 'chatmessage', 'usermessage']);

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

  // Entries of this tab that are not in storage yet. Several hh.ru tabs share one log
  // (a run in one, vacancies from the queue in others), so a flush appends to what is
  // stored instead of replacing it with this tab's copy.
  let pendingLog = [];
  let logFlushTimer = null;

  function readStoredLog() {
    const arr = parseJson(storage.localGet(KEYS.logBuffer), []);
    return Array.isArray(arr) ? arr : [];
  }

  function flushLogBuffer() {
    if (logFlushTimer) {
      clearTimeout(logFlushTimer);
      logFlushTimer = null;
    }
    if (!pendingLog.length) return;
    try {
      const list = readStoredLog().concat(pendingLog).slice(-MAX_LOG_ENTRIES);
      if (storage.localSet(KEYS.logBuffer, JSON.stringify(list))) pendingLog = [];
    } catch (e) {
      console.warn('[HHA] Failed to write log buffer:', e);
    }
  }

  function scheduleLogFlush() {
    if (!logFlushTimer && typeof setTimeout !== 'undefined') {
      logFlushTimer = setTimeout(() => {
        logFlushTimer = null;
        flushLogBuffer();
      }, 3000);
    }
  }

  function appendLogEntry(entry) {
    pendingLog.push(entry);
    if (pendingLog.length > MAX_LOG_ENTRIES) pendingLog = pendingLog.slice(-MAX_LOG_ENTRIES);
    scheduleLogFlush();
  }

  function hhaDumpLog() {
    flushLogBuffer();
    // Entries of different tabs come in flush order, so they are put back in time order.
    const entries = readStoredLog().concat(pendingLog).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return entries.map(e => JSON.stringify(e)).join('\n');
  }

  function hhaClearLog() {
    pendingLog = [];
    if (logFlushTimer) {
      clearTimeout(logFlushTimer);
      logFlushTimer = null;
    }
    storage.localSet(KEYS.logBuffer, JSON.stringify([]));
    console.info('[HHA] Log buffer cleared');
    return true;
  }

  function hhaLog(level, event, data = null) {
    const ts = Date.now();
    const cleanData = sanitizeLogData(data);
    // Ids come with a v_ prefix from some pages and without it from others; one form in
    // the log lets a vacancy be followed from navigate_vacancy to its outcome.
    if (typeof cleanData.vid === 'string') cleanData.vid = cleanVid(cleanData.vid);
    const entry = {
      ts,
      level: level || 'info',
      event: String(event || 'unknown'),
      ...cleanData
    };

    appendLogEntry(entry);

    const timeStr = formatTime(ts);
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

  // For problems the run gets past by itself (a retry, a vacancy sent to the queue).
  // They go to the log only, so the HUD does not show a routine retry as a failure.
  function reportWarning(msg, code, details = null) {
    hhaLog('warn', 'warning', {
      code,
      message: String(msg || ''),
      ...(details && typeof details === 'object' ? details : {})
    });
  }

  // --- Watchdog Progress Tracking ---
  let lastProgressTs = Date.now();
  let lastCommittedVid = null;
  // The vacancy whose letter field the script filled last, so a response sent from a
  // form with no letter field can still get the letter through the attach button.
  let letterFilledVid = null;
  function markProgress() {
    lastProgressTs = Date.now();
  }

  // --- Daily Counters Domain ---
  function getLocalDateKey(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function makeFreshCounters(today = getLocalDateKey()) {
    return { date: today, applied: 0, queued: 0, skipped: 0, error: 0 };
  }

  // Today's counters. Reading never writes: the next outcome saves a new day. The stored
  // day is kept when it is today or tomorrow: tomorrow means the time zone or the clock
  // went back (a trip, an OS zone fixed), and those counts are the user's real day.
  // A read during a short visit to another date used to wipe them.
  function getDailyCounters() {
    const now = new Date();
    const today = getLocalDateKey(now);
    const tomorrow = getLocalDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    const data = parseJson(storage.localGet(KEYS.dailyCounters), null);
    if (data && typeof data === 'object' && (data.date === today || data.date === tomorrow)) {
      const n = (v) => Math.max(0, Math.floor(Number(v)) || 0);
      return {
        date: data.date,
        applied: n(data.applied),
        queued: n(data.queued),
        skipped: n(data.skipped),
        error: n(data.error)
      };
    }
    return makeFreshCounters(today);
  }

  function emitProgress() {
    const cur = getSentCount();
    events.emit('progress', {
      sent: cur,
      percentage: Math.min(100, Math.round((cur / MAX_DAILY_LIMIT) * 100))
    });
  }

  function saveDailyCounters(counters) {
    storage.localSet(KEYS.dailyCounters, JSON.stringify(counters));
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

  function checkSkipRateAnomaly(reason) {
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

  // Outcomes of the current run, for the summary shown after it stops. The daily
  // counters span all runs of the day; these start from zero on every start. They live
  // in sessionStorage, since a run goes through many page loads of the same tab.
  function readRunStats() {
    return parseJson(storage.sessionGet(KEYS.runStats), null);
  }

  function startRunStats() {
    storage.sessionSet(KEYS.runStats, JSON.stringify({ startedAt: Date.now(), applied: 0, queued: 0, skipped: 0, error: 0 }));
    storage.sessionRemove(KEYS.lastRun);
    events.emit('runSummary', null);
  }

  function bumpRunStats(outcome) {
    const stats = readRunStats();
    if (!stats || !(outcome in stats)) return;
    stats[outcome] = (Number(stats[outcome]) || 0) + 1;
    storage.sessionSet(KEYS.runStats, JSON.stringify(stats));
  }

  function closeRunStats(code) {
    const stats = readRunStats();
    if (!stats) return;
    storage.sessionRemove(KEYS.runStats);
    const summary = { ...stats, endedAt: Date.now(), code };
    storage.sessionSet(KEYS.lastRun, JSON.stringify(summary));
    events.emit('runSummary', summary);
  }

  function recordOutcome(vid, outcome, reason, details = null) {
    const clean = cleanVid(vid);
    const validOutcomes = ['applied', 'queued', 'skipped', 'error'];
    const finalOutcome = validOutcomes.includes(outcome) ? outcome : 'error';
    const finalReason = normalizeReasonCode(reason, finalOutcome === 'applied' ? 'applied' : (finalOutcome === 'queued' ? 'queued' : (finalOutcome === 'skipped' ? 'skip' : 'error')));

    const counters = getDailyCounters();
    if (finalOutcome in counters && finalOutcome !== 'date') {
      counters[finalOutcome]++;
      saveDailyCounters(counters);
    }

    storage.sessionRemove(KEYS.watchdogStallCount);
    storage.sessionRemove(KEYS.watchdogStallVid);
    markProgress();
    if (clean) {
      clearInflight(clean);
      // Any other outcome of a vacancy ends a series of vacancies without the apply button.
      if (finalReason !== 'queued_no_button') storage.sessionRemove(KEYS.noButtonStreak);
    }

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

    checkSkipRateAnomaly(finalReason);
    if (isRunning()) bumpRunStats(finalOutcome);

    events.emit('outcome', {
      vid: clean,
      outcome: finalOutcome,
      reason: finalReason,
      counters
    });
  }

  // --- 6. Configuration ---
  function normalizeConfig(raw) {
    const m = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
    // Booleans written as strings ("false") by hand or by another script mean what they say.
    return {
      coverText: sliceSafe(typeof m.coverText === 'string' ? m.coverText : (asText(m.coverText) || DEFAULT_COVER_TEXT), MAX_COVER_LENGTH),
      useCover: m.useCover === true || m.useCover === 'true',
      skipHidden: !(m.skipHidden === false || m.skipHidden === 'false'),
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

  const actionPause = () => wait(randBetween(ACTION_TIMINGS.action[0], ACTION_TIMINGS.action[1]));

  // --- Pace ---
  // A person does not keep one rhythm for an hour. On top of the pauses above: now and then a
  // longer pause before a vacancy, a break every few dozen vacancies, the letter pasted and
  // read before the submit, and all pauses longer for 12 hours after a captcha. Together about
  // a fifth slower than a steady run. On a local page (the dev mocks) this is off, so their
  // timed scenarios keep the old pace, unless a test turns it on with its own numbers in
  // hha:pace_test; on hh.ru that key is not read.
  const PACE_DEFAULTS = Object.freeze({
    tailChance: 0.06,
    tailMs: [10000, 30000],
    breakEvery: [25, 40],
    breakMs: [40000, 100000],
    resumeMs: [1000, 2200],
    letterBeforeMs: [400, 1000],
    letterAfterMs: [1000, 2500],
    cooldownMs: 12 * 60 * 60 * 1000
  });
  const PACE = (() => {
    if (!LOCAL_HOST_RE.test(globalThis.location?.hostname || '')) return { on: true, ...PACE_DEFAULTS };
    const test = parseJson(storage.localGet(KEYS.paceTest), null);
    return test && typeof test === 'object' ? { ...PACE_DEFAULTS, ...test, on: true } : { ...PACE_DEFAULTS, on: false };
  })();
  const randIn = (range) => randBetween(range[0], range[1]);

  // Captchas of the last 12 hours, shared by all tabs. One makes the pauses 1.5 times longer,
  // two or more twice as long.
  function recentCaptchas(now = Date.now()) {
    const list = parseJson(storage.localGet(KEYS.captchas), []);
    return (Array.isArray(list) ? list : []).map(Number).filter((ts) => ts <= now && now - ts < PACE.cooldownMs);
  }
  function noteCaptcha() {
    storage.localSet(KEYS.captchas, JSON.stringify(recentCaptchas().concat(Date.now()).slice(-10)));
  }
  const paceFactor = () => (PACE.on ? 1 + 0.5 * Math.min(2, recentCaptchas().length) : 1);

  function vacancyPauseMs() {
    const f = paceFactor();
    let ms = randIn(ACTION_TIMINGS.delay) * f;
    if (PACE.on && Math.random() < PACE.tailChance) ms += randIn(PACE.tailMs) * f;
    return Math.max(2000, Math.round(ms));
  }

  // A pause longer than the watchdog allows for a step (a minute, then it reloads the page):
  // while it lasts, the watchdog takes the page as resting, not hung.
  let restingUntil = 0;
  async function rest(ms) {
    restingUntil = Date.now() + ms;
    try {
      await wait(ms);
    } finally {
      restingUntil = 0;
      markProgress();
    }
  }

  // The vacancies opened in this run and the count at which the next break comes.
  function readPaceState() {
    const st = parseJson(storage.sessionGet(KEYS.paceState), null);
    return st && typeof st === 'object' ? { opened: Math.max(0, Number(st.opened) || 0), nextBreak: Number(st.nextBreak) || 0 } : { opened: 0, nextBreak: 0 };
  }
  const nextBreakAfter = (opened) => opened + Math.max(1, Math.round(randIn(PACE.breakEvery) / paceFactor()));

  async function breakIfDue() {
    if (!PACE.on) return;
    const st = readPaceState();
    if (!st.nextBreak) st.nextBreak = nextBreakAfter(st.opened);
    if (st.opened >= st.nextBreak) {
      const ms = Math.round(randIn(PACE.breakMs) * paceFactor());
      hhaLog('info', 'pace_break', { opened: st.opened, ms });
      setActivity('break', { durationMs: ms });
      await rest(ms);
      st.nextBreak = nextBreakAfter(st.opened);
    }
    storage.sessionSet(KEYS.paceState, JSON.stringify(st));
  }

  function notePaceOpened() {
    if (!PACE.on) return;
    const st = readPaceState();
    st.opened++;
    storage.sessionSet(KEYS.paceState, JSON.stringify(st));
  }

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
    timer = setTimeout(() => { cleanup(); markProgress(); resolve(); }, ms);
  });

  // --- 7. Manual Queue Domain ---

  function normalizeManualEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const rawVid = (asText(entry.vid) || asText(entry.id)).trim();
    const vid = cleanVid(rawVid);
    if (!vid) return null;
    return {
      vid,
      url: toSafeHhUrl(asText(entry.url) || asText(entry.href)),
      title: collapseSpaces(asText(entry.title)),
      employer: collapseSpaces(asText(entry.employer)),
      salary: collapseSpaces(asText(entry.salary)),
      reason: collapseSpaces(asText(entry.reason) || asText(entry.note)),
      addedAt: Number(entry.addedAt || entry.ts) || Date.now(),
      returnUrl: toSafeHhUrl(asText(entry.returnUrl)),
      viewed: entry.viewed === true || entry.viewed === 'true',
      viewedAt: entry.viewedAt ? (Number(entry.viewedAt) || null) : null,
      questions: normalizeQuestions(entry.questions)
    };
  }

  // How many questions the employer's form asks and the first of them, shown on the
  // queue card so the queue can be sorted out without opening every vacancy.
  function normalizeQuestions(q) {
    const count = Math.round(Number(q && q.count) || 0);
    if (count < 1) return null;
    return { count: Math.min(count, 99), first: sliceSafe(collapseSpaces(asText(q.first)), 200) };
  }

  // The questions on the page right now: hh.ru renders each one as
  // div[data-qa="task-question"] (seen on the response form page, 2026-10-13).
  function readTaskQuestions() {
    const texts = qa('[data-qa="task-question"]').map((el) => collapseSpaces(el.innerText || el.textContent)).filter(Boolean);
    return texts.length ? { count: texts.length, first: texts[0] } : null;
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
    add(entry) {
      const item = normalizeManualEntry(entry);
      if (!item) return { success: false, isNew: false };
      const queue = this.get();
      const idx = queue.findIndex(it => it.vid === item.vid);
      const isNew = idx < 0;
      if (idx >= 0) queue[idx] = { ...queue[idx], ...item };
      else queue.unshift(item);
      const ok = storage.localSet(KEYS.manualList, JSON.stringify(queue));
      // A queue that was not saved is not shown either: the HUD would list a vacancy that
      // is gone after the next page load.
      if (ok) events.emit('manualQueue', { action: isNew ? 'add' : 'update', item, queue });
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

  // --- 8. State Accessors ---
  const TAB_ID = (() => {
    const win = globalThis.window;
    const sessionTabId = storage.sessionGet(KEYS.tabId);
    const winName = (win && typeof win.name === 'string') ? win.name : '';

    // Check if this window was navigated or refreshed in the SAME tab
    // In browsers, window.name persists across navigations in the same tab,
    // but may be empty or unlinked if not explicitly set.
    const isSameTab = Boolean(sessionTabId && sessionTabId.startsWith('hha_') && (!winName || winName === sessionTabId));

    if (isSameTab) {
      try {
        if (win && win.name !== sessionTabId) win.name = sessionTabId;
      } catch (_) {}
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

  // The lists below are written to storage at once. They used to be written on pagehide
  // only, and in a live run that write was lost: a skipped vacancy was not in the list on
  // the search page and was opened again and again.
  let memProcessedIds = null;

  // Ids are kept without the v_ prefix: some pages give it and others do not.
  function getProcessedIDs() {
    if (!memProcessedIds) {
      const arr = parseJson(storage.sessionGet(KEYS.history), []);
      memProcessedIds = new Set((Array.isArray(arr) ? arr : []).map(cleanVid).filter(Boolean));
    }
    return memProcessedIds;
  }

  function isProcessedID(id) {
    return Boolean(id) && getProcessedIDs().has(cleanVid(id));
  }

  function addProcessedID(id) {
    const clean = cleanVid(id);
    if (!clean) return true;
    const ids = getProcessedIDs();
    if (!ids.has(clean)) {
      ids.add(clean);
      storage.sessionSet(KEYS.history, JSON.stringify(Array.from(ids)));
    }
    return true;
  }

  // How many times each vacancy was opened from the search in this run. A vacancy is
  // opened again only after a failure, at most MAX_VACANCY_ATTEMPTS times; more visits
  // mean it was not marked as processed, and the run would go round in a loop.
  function readRunVisits() {
    const map = parseJson(storage.sessionGet(KEYS.runVisits), {});
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  }

  function countRunVisit(vid) {
    const clean = cleanVid(vid);
    if (!clean) return;
    const map = readRunVisits();
    map[clean] = (Number(map[clean]) || 0) + 1;
    storage.sessionSet(KEYS.runVisits, JSON.stringify(map));
  }

  // --- Attempts & Blacklist Tracking (Circuit Breaker) ---
  let memVacancyAttempts = null;
  let memVacancyAttemptsDirty = false;

  // A stored map, or an empty one when the key holds anything else: a string or a number
  // there made every later write throw in strict mode and stopped each run at once.
  const asMap = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

  function getVacancyAttemptsMap() {
    if (!memVacancyAttempts) {
      memVacancyAttempts = asMap(parseJson(storage.sessionGet(KEYS.attempts), {}));
    }
    return memVacancyAttempts;
  }

  function flushVacancyAttempts() {
    if (memVacancyAttemptsDirty && memVacancyAttempts) {
      storage.sessionSet(KEYS.attempts, JSON.stringify(memVacancyAttempts));
      memVacancyAttemptsDirty = false;
    }
  }

  function recordVacancyAttempt(vid) {
    if (!vid) return 1;
    const clean = cleanVid(vid);
    const map = getVacancyAttemptsMap();
    const count = (Number(map[clean]) || 0) + 1;
    map[clean] = count;
    memVacancyAttemptsDirty = true;
    flushVacancyAttempts();
    return count;
  }

  let memBlacklist = null;
  let memBlacklistDirty = false;

  function getBlacklistMap() {
    if (!memBlacklist) {
      const raw = storage.localGet(KEYS.blacklist);
      const parsed = parseJson(raw, {});
      const map = asMap(parsed);
      const now = Date.now();
      let changed = Boolean(raw) && map !== parsed;
      for (const k of Object.keys(map)) {
        const entry = map[k];
        const ts = typeof entry === 'object' && entry !== null ? Number(entry.ts) : Number(entry);
        if (!ts || (now - ts) > BLACKLIST_TTL) {
          delete map[k];
          changed = true;
        }
      }
      memBlacklist = map;
      if (changed) {
        memBlacklistDirty = true;
      }
    }
    return memBlacklist;
  }

  function flushBlacklist() {
    if (memBlacklistDirty && memBlacklist) {
      storage.localSet(KEYS.blacklist, JSON.stringify(memBlacklist));
      memBlacklistDirty = false;
    }
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
    memBlacklistDirty = true;
    flushBlacklist();
  }

  // Vacancies with a response, kept across tabs and sessions. Some search cards keep the
  // apply button after a response (a pinned card at the top of the list), and the session
  // list of processed ids starts empty in every tab, so without this such a vacancy is
  // opened on every run only to find the response already there. Written at once, since
  // a queued vacancy can be answered in another tab.
  const VID_HISTORY_TTL = 30 * 24 * 60 * 60 * 1000;
  // 30 days at hh.ru's limit of 200 responses a day, with room to spare: with 2000 the
  // oldest ids went after 10 days, while README promises 30.
  const VID_HISTORY_MAX = 6500;

  // A map of vacancy id to the time it was stored, kept for ttl.
  function createVidHistory(key, ttl = VID_HISTORY_TTL) {
    const read = () => {
      const map = parseJson(storage.localGet(key), {});
      return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    };
    const write = (map) => {
      const now = Date.now();
      const kept = Object.entries(map)
        .filter(([, ts]) => now - Number(ts) < ttl)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .slice(0, VID_HISTORY_MAX);
      storage.localSet(key, JSON.stringify(Object.fromEntries(kept)));
    };
    return {
      remember(vid) {
        const clean = cleanVid(vid);
        if (!clean) return;
        const map = read();
        map[clean] = Date.now();
        write(map);
      },
      forget(vid) {
        const clean = cleanVid(vid);
        const map = read();
        if (!clean || !(clean in map)) return;
        delete map[clean];
        write(map);
      },
      ids() {
        const now = Date.now();
        return new Set(Object.entries(read())
          .filter(([, ts]) => now - Number(ts) < ttl)
          .map(([vid]) => vid));
      }
    };
  }

  const appliedHistory = createVidHistory(KEYS.appliedHistory);
  function rememberApplied(vid) { appliedHistory.remember(vid); }
  function forgetApplied(vid) { appliedHistory.forget(vid); }
  function getAppliedHistorySet() { return appliedHistory.ids(); }

  // Vacancies queued for a reason a new attempt cannot change: a questionnaire, a response
  // on another site, a promo page, no apply button. "Очистить всё" empties the queue, and
  // without this the next run would open all of them again only to queue them again.
  // Passing failures (a submit or a relocation not confirmed) are not kept: for them a
  // new attempt is the point of removing them from the queue.
  const queuedHistory = createVidHistory(KEYS.queuedHistory);
  const LASTING_QUEUE_REASONS = new Set(['test_required', 'test-questionnaire', 'queued_external_site', 'queued_promo', 'no-apply-button']);

  // Vacancies skipped for a reason the next session would find again: hh.ru says the
  // resume does not fit, the resume is hidden, the vacancy is closed. The processed list
  // lives in sessionStorage, so without this every new tab opened them and pressed the
  // apply button again. A week, not 30 days: a reworked resume may fit next time.
  const SKIPPED_HISTORY_TTL = 7 * 24 * 60 * 60 * 1000;
  const skippedHistory = createVidHistory(KEYS.skippedHistory, SKIPPED_HISTORY_TTL);
  const LASTING_SKIP_REASONS = new Set(['skip_reject_warning', 'skip_reject_regex', 'resume_hidden', 'access_denied', 'skip_inaccessible']);

  // A response the script started: the apply button or a submit was pressed and hh.ru has
  // not confirmed it yet. It lives in sessionStorage, so a Stop or a reload in between
  // still counts the response once the page shows it, instead of losing it or taking it
  // for a skip "already applied".
  const INFLIGHT_TTL = 2 * 60 * 1000;
  // hh.ru may answer a submit with a captcha and send the response once the user solves it,
  // which takes minutes when the tab is in the background.
  const CAPTCHA_INFLIGHT_TTL = 30 * 60 * 1000;
  function markInflight(vid) {
    const clean = cleanVid(vid);
    if (clean) storage.sessionSet(KEYS.inflight, JSON.stringify({ vid: clean, ts: Date.now() }));
  }
  function readInflightEntry() {
    const p = parseJson(storage.sessionGet(KEYS.inflight), null);
    if (!p || typeof p.vid !== 'string') return null;
    return Date.now() - Number(p.ts) < (p.captcha ? CAPTCHA_INFLIGHT_TTL : INFLIGHT_TTL) ? p : null;
  }
  function readInflight() {
    return readInflightEntry()?.vid || null;
  }

  // A response counted after the run stopped. The next run on that page does not count it
  // again as a skip "already applied", and attaches the letter if the submit went without it.
  function takeLateApplied(vid) {
    const p = parseJson(storage.sessionGet(KEYS.lateApplied), null);
    if (!p || p.vid !== cleanVid(vid)) return null;
    storage.sessionRemove(KEYS.lateApplied);
    return Date.now() - Number(p.ts) < CAPTCHA_INFLIGHT_TTL ? p : null;
  }
  function clearInflight(vid) {
    const raw = storage.sessionGet(KEYS.inflight);
    if (!raw) return;
    const p = parseJson(raw, null);
    if (!vid || !p || p.vid === cleanVid(vid)) storage.sessionRemove(KEYS.inflight);
  }

  function flushStorageCaches() {
    flushVacancyAttempts();
    flushBlacklist();
  }

  const onPageHide = () => {
    flushLogBuffer();
    flushStorageCaches();
  };
  window.addEventListener('pagehide', onPageHide, { capture: true });
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      onPageHide();
    }
  }, { capture: true });

  // Every page change of a run goes through here. The log is written before leaving:
  // in a live run the write on pagehide did not reach storage, and the entries of the
  // last seconds on a vacancy page (the decision and the outcome) were lost.
  function leavePage(url) {
    onPageHide();
    const loc = globalThis.location;
    if (!loc) return;
    if (!url) {
      loc.reload();
      return;
    }
    try { loc.assign(url); } catch (_) { loc.href = url; }
  }

  function handleVacancyFailure(vid, reason = 'apply_failed', runId = currentRunId, meta = null) {
    if (!vid) return returnToList(null, { markProcessed: false, runId });
    const clean = cleanVid(vid);
    const attempts = recordVacancyAttempt(clean);

    if (attempts >= MAX_VACANCY_ATTEMPTS) {
      addToBlacklist(clean, reason);
      markVacancyProcessed(clean, runId);
      saveCurrentForManual(
        clean,
        reason || 'apply_failed',
        runId,
        meta?.title || '',
        meta?.employer || '',
        meta?.salary || '',
        meta?.url || ''
      );
      reportWarning(`Вакансия #${clean} превысила лимит попыток (${attempts}/${MAX_VACANCY_ATTEMPTS}). Отправлена в ручную очередь и заблокирована на 24ч.`, 'MAX_ATTEMPTS_EXCEEDED', { vid: clean, attempts, reason });
      return returnToList(vid, { markProcessed: true, runId });
    } else {
      reportWarning(`Сбой при отклике на вакансию #${clean} (попытка ${attempts}/${MAX_VACANCY_ATTEMPTS}). Возврат к списку.`, 'VACANCY_ATTEMPT_FAILED', { vid: clean, attempts, reason });
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

  // The current step of a run, for the HUD status line. `until` is set for timed
  // pauses so the HUD can count them down: a pause should not look like a hang.
  let currentActivity = null;
  function setActivity(code, { vid = null, durationMs = 0 } = {}) {
    currentActivity = code
      ? { code, vid: cleanVid(vid) || null, durationMs: durationMs > 0 ? durationMs : 0, until: durationMs > 0 ? Date.now() + durationMs : null }
      : null;
    events.emit('activity', currentActivity);
  }

  // --- 9. Concurrency & Instance Locks ---
  const INSTANCE_LOCK_TTL = 30000;
  // After a navigation the previous page can hold the lock for another 1-1.6 s on live
  // hh.ru. A timeout means "another tab runs the script" and stops the run, so it has to
  // leave a wide margin; a real second tab is still caught, just a few seconds later.
  const WEBLOCK_ACQUIRE_TIMEOUT = 5000;
  // A wait longer than this is logged as a warning, to see how close it gets to the timeout.
  const WEBLOCK_SLOW_WAIT = 1000;
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
    } else if (webLockAbortController) {
      try { webLockAbortController.abort(); } catch (_) {}
    }
    webLockAbortController = null;
    hasActiveWebLock = false;
    if (webLockPendingPromise) {
      try { await webLockPendingPromise; } catch (e) { hhaLog('debug', 'weblock_pending_error', { error: String(e && e.message || e) }); }
      webLockPendingPromise = null;
    }
    await new Promise(r => setTimeout(r, 10));
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
    // On search pages the acquisition sometimes takes 1-1.6 s. waitMs is the time
    // until the browser granted the lock, totalMs until this code ran again: a long wait
    // means another document held the lock, a short wait with a long total means the
    // page's own scripts kept the main thread busy.
    let grantedAt = null;

    // Web Locks acquisition (native browser mutual exclusion across tabs/workers)
    const nav = globalThis.navigator;
    if (nav?.locks?.request) {
      let webLockAcquired = false;
      const lockController = new AbortController();
      // Set before the grant, so a stop while the request still waits aborts it instead
      // of waiting for the lock and taking it after the stop.
      webLockAbortController = lockController;
      try {
        let lockResolver;
        const lockPromise = new Promise(res => { lockResolver = res; });

        webLockPendingPromise = nav.locks.request(
          KEYS.instanceLock,
          { mode: 'exclusive', signal: lockController.signal },
          (lock) => {
            if (!lock) {
              lockResolver(false);
              return;
            }
            webLockAcquired = true;
            grantedAt = Date.now();
            hasActiveWebLock = true;
            webLockAbortController = lockController;
            lockResolver(true);
            return new Promise(resRelease => {
              webLockReleaseResolver = resRelease;
            });
          }
        ).catch(() => {
          hasActiveWebLock = false;
          if (!webLockAcquired) lockResolver(false);
        });

        let timeoutId;
        const timeoutPromise = new Promise(resolve => {
          timeoutId = setTimeout(() => resolve('TIMEOUT'), WEBLOCK_ACQUIRE_TIMEOUT);
        });
        const acquired = await Promise.race([lockPromise, timeoutPromise]);
        clearTimeout(timeoutId);

        if (acquired === 'TIMEOUT') {
          try { lockController.abort(); } catch (_) {}
        }
        if (acquired !== true) {
          instanceLeaseVerified = false;
          return false;
        }
      } catch (_) {
        hasActiveWebLock = false;
        instanceLeaseVerified = false;
        return false;
      }
    } else {
      // Fallback for environments without Web Locks API
      const existing = readInstanceLock();
      if (existing && isLiveLock(existing, now) && existing.tabId !== tabId) {
        instanceLeaseVerified = false;
        return false;
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
    const waitMs = grantedAt !== null ? grantedAt - now : undefined;
    hhaLog(waitMs > WEBLOCK_SLOW_WAIT ? 'warn' : 'info', 'lock_acquire', {
      tabId,
      leaseId,
      waitMs,
      totalMs: Date.now() - now
    });
    return true;
  }

  async function releaseInstanceLock(tabId) {
    const cur = readInstanceLock();
    const ownsStoredLock = Boolean(cur && cur.tabId === tabId);
    const held = ownsStoredLock || hasActiveWebLock || Boolean(webLockPendingPromise);
    if (ownsStoredLock) {
      storage.localRemove(KEYS.instanceLock);
    }
    currentLeaseId = null;
    instanceLeaseVerified = false;
    await releaseWebLock();
    if (held) hhaLog('info', 'lock_release', { tabId });
    return true;
  }

  function touchInstanceLock(tabId) {
    const now = Date.now();
    const cur = readInstanceLock();
    // Only consider lock lost if another tab holds an active (live) lock
    if (cur && cur.tabId !== tabId && isLiveLock(cur, now)) {
      instanceLeaseVerified = false;
      return 'LOST';
    }
    const leaseId = currentLeaseId || (cur && cur.tabId === tabId ? cur.leaseId : null) || `${tabId}_${now.toString(36)}`;
    currentLeaseId = leaseId;
    if (!storage.localSet(KEYS.instanceLock, JSON.stringify({ tabId, leaseId, ts: now }))) {
      instanceLeaseVerified = false;
      return 'LOST';
    }
    instanceLeaseVerified = true;
    return 'OWNED';
  }

  // --- 10. Run Lifecycle & Guards ---
  let isLoopActive = false;
  let stopSignal = false;
  let currentRunId = 0;
  let resumeTimer = null;
  let activeAbortController = null;
  let handlingResponsePage = false;
  let isNavigating = false;

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
    setActivity(null);
    releaseInstanceLock(TAB_ID);
    const statusKey = (code === 'DAILY_LIMIT_REACHED' || code === 'DONE') ? 'done' : (isError ? 'error' : (code === 'STOPPED_BY_USER' ? 'stopped' : code.toLowerCase()));
    closeRunStats(code);
    setStatus(statusKey, code, details);
    hhaLog(isError ? 'error' : 'info', 'stop', { code, logMsg: logMsg || undefined, isError });
    if (logMsg && isError) reportError(logMsg, code, details);
    const pending = readInflight();
    if (pending) watchLateResponse(pending);
    flushLogBuffer();
    flushStorageCaches();
  }

  // A response that hh.ru confirms after the run stopped (Stop pressed while the script
  // waited for hh.ru) or after a reload. It went through and counts toward hh.ru's limit,
  // so it counts here too. Only the page is read, nothing is pressed.
  const LATE_RESPONSE_WATCH_MS = 20000;
  let lateWatchId = null;

  function recordLateResponse(vid, source) {
    const pending = readInflightEntry();
    storage.sessionSet(KEYS.lateApplied, JSON.stringify({ vid, ts: Date.now(), letterOwed: Boolean(pending && pending.vid === vid && pending.letterOwed) }));
    rememberApplied(vid);
    recordOutcome(vid, 'applied', `applied_${source}`);
    // The run already has its summary; the response goes into it as well.
    const last = parseJson(storage.sessionGet(KEYS.lastRun), null);
    if (last && typeof last === 'object') {
      last.applied = (Number(last.applied) || 0) + 1;
      storage.sessionSet(KEYS.lastRun, JSON.stringify(last));
      events.emit('runSummary', last);
    }
    emitProgress();
  }

  function watchLateResponse(vid) {
    if (lateWatchId !== null) clearInterval(lateWatchId);
    lateWatchId = null;
    // Only on the page of that vacancy: its own page or its response form.
    if (cleanVid(getVacancyIDFromHref(globalThis.location?.href) || '') !== vid) return;
    const startedAt = Date.now();
    const watchMs = readInflightEntry()?.captcha ? CAPTCHA_INFLIGHT_TTL : LATE_RESPONSE_WATCH_MS;
    const stop = () => {
      if (lateWatchId !== null) clearInterval(lateWatchId);
      lateWatchId = null;
    };
    const check = () => {
      if (isRunning() || readInflight() !== vid || Date.now() - startedAt > watchMs) return stop();
      if (detectAlreadyApplied() || isResponseConfirmed({ allowDocumentStrongText: true })) {
        stop();
        hhaLog('info', 'late_response', { vid, afterMs: Date.now() - startedAt });
        recordLateResponse(vid, 'after_stop');
      }
    };
    lateWatchId = setInterval(check, 500);
  }

  function finalizeRun(runId, statusKey, msg = '') {
    if (runId !== currentRunId) return;
    terminateRun(statusKey.toUpperCase(), msg, { message: msg }, statusKey === 'error');
  }

  function haltEngine(code, logMsg, details = {}) {
    terminateRun(code, logMsg, details, true);
  }

  // A captcha on the submit of a response: once the user solves it, hh.ru sends the response.
  // The error outcome used to drop the mark of the response in flight, and after Продолжить
  // the response counted as a skip "already applied", without the letter it was sent without.
  // Now the mark stays, longer than usual, and says whether the letter is still owed.
  const haltForCaptcha = () => {
    const vid = resolveCurrentVid();
    const pending = readInflightEntry();
    noteCaptcha();
    recordOutcome(vid, 'error', 'error_captcha');
    if (pending && pending.vid === cleanVid(vid)) {
      storage.sessionSet(KEYS.inflight, JSON.stringify({ ...pending, captcha: true, letterOwed: config.useCover && letterFilledVid !== pending.vid }));
    }
    haltEngine('CAPTCHA_DETECTED', 'hh.ru показал капчу, автоматизация остановлена.');
  };
  const haltForRateLimit = () => {
    const vid = resolveCurrentVid();
    recordOutcome(vid, 'error', 'error_rate_limit');
    haltEngine('RATE_LIMITED', 'hh.ru ограничил частоту запросов, автоматизация остановлена.');
  };
  const haltForDailyLimit = (msg = `Достигнут суточный лимит HeadHunter: не более ${MAX_DAILY_LIMIT} откликов за 24 часа. Автоматизация остановлена.`) => {
    hhaLog('warn', 'hh_limit_reached', { source: 'hh_ui' });
    terminateRun('DAILY_LIMIT_REACHED', msg, { limit: MAX_DAILY_LIMIT, period: '24h' }, false);
  };
  const haltForLostInstanceLock = () => {
    const isBlocked = storage.isLocalBlocked();
    haltEngine(isBlocked ? 'STORAGE_BLOCKED' : 'TAB_LOCK_LOST', isBlocked ? 'Браузер запретил сайту хранить данные, скрипт потерял блокировку вкладки.' : 'Блокировку вкладки перехватила другая вкладка.');
  };

  // --- 11. DOM Queries & Form Automation ---
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

  // The detectors read textContent of the same nodes many times per check and on every
  // watchdog tick, often of the whole body. The text only changes with the DOM, so it
  // is cached until the next mutation. The HUD lives in a shadow root, so its own
  // updates do not reset the cache.
  const textCache = new Map();
  let textCacheObserver = null;

  function textOf(node) {
    if (!node) return '';
    if (!textCacheObserver) {
      const root = globalThis.document?.documentElement;
      if (typeof MutationObserver === 'undefined' || !root) return readPageText(node);
      textCacheObserver = new MutationObserver(() => textCache.clear());
      textCacheObserver.observe(root, { childList: true, subtree: true, characterData: true });
    }
    let text = textCache.get(node);
    if (text === undefined) {
      text = readPageText(node);
      textCache.set(node, text);
    }
    return text;
  }

  // The text of a node as the page shows it in its markup, without the code inside
  // <script>, <style>, <noscript> and <template>. textContent includes them, and the
  // detectors took hh.ru's UI strings in an inline script ("Вы уже откликались",
  // "Вакансия в архиве") for the state of the vacancy.
  const NON_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  function readPageText(node) {
    if (node.nodeType === 3) return node.data;
    if (node.nodeType === 1 && NON_TEXT_TAGS.has(node.nodeName)) return '';
    if (typeof node.querySelector !== 'function' || !node.querySelector('script, style, noscript, template')) {
      return node.textContent || '';
    }
    const doc = node.ownerDocument || globalThis.document;
    const parts = [];
    try {
      const walker = doc.createTreeWalker(node, 4 /* NodeFilter.SHOW_TEXT */);
      // The content of these tags is raw text right inside them (a template's is not in
      // the tree at all), so the parent is enough.
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        if (!NON_TEXT_TAGS.has(t.parentNode?.nodeName)) parts.push(t.data);
      }
    } catch (_) {
      return node.textContent || '';
    }
    return parts.join('');
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
    const direct = q(SELECTORS.relocationBtn, scope);
    if (direct && isVisible(direct) && !isReviewOrFeedbackElement(direct)) return direct;

    const alert = q('[data-qa="magritte-alert"], [role="dialog"]', scope);
    if (alert && isVisible(alert) && !isReviewOrFeedbackElement(alert)) {
      const confirmBtn = q(SELECTORS.relocationBtn, alert)
        || findPatternElement(alert, 'button, [role="button"]', TEXT_RULES.relocationConfirm, 35);
      if (confirmBtn && isVisible(confirmBtn)) return confirmBtn;
    }

    // The text scan below reads innerText of every block on the page and is the most
    // expensive check. innerText only adds line breaks and changes case, never letters,
    // so without "стран" in the page text no element can match and the scan is skipped.
    const scopeText = textOf(scope.nodeType === 9 ? scope.documentElement : scope);
    const title = q('[data-qa="relocation-warning-title"]', scope)
      || (/стран/i.test(scopeText)
        ? findPatternElement(scope, 'h1, h2, h3, div, p, span', TEXT_RULES.relocationText, 80)
        : null);
    if (title && isVisible(title)) {
      const container = title.closest?.('[data-qa="magritte-alert"], [role="dialog"]') || title.parentElement;
      if (container && !isReviewOrFeedbackElement(container)) {
        const confirmBtn = q(SELECTORS.relocationBtn, container)
          || findPatternElement(container, 'button, [role="button"]', TEXT_RULES.relocationConfirm, 35)
          || findPatternElement(container, 'button, [role="button"]', TEXT_RULES.relocationConfirmPlain, 35);
        if (confirmBtn && isVisible(confirmBtn)) return confirmBtn;
      }
    }
    return null;
  }

  const coverBtnHeuristic = (r) => findPatternElement(r, 'button, a, [role="button"], span', /сопроводительное|письмо|cover letter|add cover/i, 60);

  // The apply buttons have no text fallback on purpose: on a vacancy page the first visible
  // "Откликнуться" may belong to the similar vacancies block, and in the search it hid a
  // markup change that should stop the run.
  const HEURISTIC_RESOLVERS = {
    attachCoverBtn: coverBtnHeuristic,
    attachCoverInModal: coverBtnHeuristic,
    letterSubmit: (r) => {
      const el = findPatternElement(r, 'button, [role="button"], input[type="submit"]', /^(отправить|сохранить|отправить отклик|откликнуться|продолжить|выбрать|send|submit|apply)$/i, 50)
        || findPatternElement(r, 'button, [role="button"], input[type="submit"]', /отправить|сохранить|откликнуться|send|submit|apply/i, 50);
      if (el && !el.closest?.('[data-qa*="vacancy-response-link"], [data-qa*="vacancy-serp"]')) return el;
      return null;
    },
    relocationBtn: (r) => detectRelocationWarning(r),
    rejectWarning: (r) => {
      const scope = (r && r !== globalThis.document && r !== globalThis.document?.body) ? r : q(SELECTORS.modal + ', [role="alert"]');
      if (!scope) return null;
      return findPatternElement(scope, 'div, p, span, section', TEXT_RULES.reject, 250);
    },
    // The last results page has no pager-next, so a loose match here would pick
    // any link like "Читать дальше" or a vacancy titled "Next.js".
    pagerNext: (r) => {
      const link = findPatternElement(r, 'a[href]', /^(?:дальше|впер[её]д|следующая|next)$/i, 20);
      return link && toSearchListUrl(link.href) ? link : null;
    }
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

  function getVisibleModals(root = globalThis.document) {
    if (!root) return [];
    return qa(SELECTORS.modal, root).filter(m => isVisible(m) && !isReviewOrFeedbackElement(m));
  }

  async function closeModal(modal = null) {
    const targetModal = modal || pickResponseModal();
    if (!targetModal) return false;
    const closeBtn = q(SELECTORS.modalClose, targetModal);
    if (!closeBtn) return false;
    await clickElement(closeBtn);
    return true;
  }

  // Fallback for a submit button without data-qa. It is searched only inside the
  // response form: page-wide, button[type="submit"] can be the header search form.
  function findResponseFormSubmit(scope = null) {
    const doc = globalThis.document;
    const isPageScope = !scope || scope === doc || scope === doc?.body;
    const field = query('letterTextarea', scope) || q('input[type="radio"][name*="resume" i]', scope);
    const form = field?.closest?.('form')
      || q('[data-qa="vacancy-response-popup-form"]', scope)
      || (isPageScope ? null : scope);
    return form ? q('button[type="submit"]', form) : null;
  }

  // Details for an error report about a missing element: what was expected and
  // the start of the HTML where it was looked for.
  function describeSelectorFailure(key, scope = null, extra = {}) {
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

    return {
      selector: key,
      selectorName: SELECTOR_METADATA[key]?.name || key,
      expectedCss: SELECTORS[key] || '',
      snippet,
      url: globalThis.location?.href || '',
      ...extra
    };
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
    const pathMatch = str.match(/\/vacancy\/(\d+)/i);
    return pathMatch ? pathMatch[1] : null;
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

  function resolveCurrentVid() {
    const last = getLastAttemptID();
    if (last) return last.startsWith('v_') ? last : 'v_' + last;
    const locHref = globalThis.location?.href || '';
    const hrefVid = getVacancyIDFromHref(locHref);
    if (hrefVid) return 'v_' + cleanVid(hrefVid);
    return null;
  }

  function getVacancyID(node) {
    const card = getVacancyCard(node);
    const link = card ? query('vacancyLink', card) : null;
    const id = getVacancyIDFromHref(link?.href) || getVacancyIDFromHref(node?.href || node?.getAttribute?.('href'));
    if (id) return 'v_' + id;
    const cardId = card?.dataset?.id || (card?.innerText ? card.innerText.slice(0, 80).trim() : '') || String(node?.className || 'unknown');
    return 'v_' + hashString(cardId);
  }

  // --- Form Input Dispatch ---
  // inputType says how the text came: insertText for typing, insertFromPaste for a paste,
  // which has no data of its own (the text is in the clipboard).
  function fillTextarea(el, value, inputType = 'insertText') {
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
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, cancelable: true, data: inputType === 'insertText' ? value : null, inputType }));
      } catch (_) {
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true, cancelable: true }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true, cancelable: true }));
      if (typeof el.blur === 'function') el.blur();
    } catch (_) {
      el.value = value;
    }
  }

  function isExternalLink(el) {
    if (el?.tagName !== 'A' || !el.href) return false;
    try {
      const { protocol } = new URL(el.href);
      return (protocol === 'http:' || protocol === 'https:') && !toSafeHhUrl(el.href);
    } catch (_) {
      return false;
    }
  }

  // --- Direct element click ---
  function clickElement(el) {
    if (!el || stopSignal) return false;
    // The script does not run outside hh.ru, so following such a link would leave
    // the run stuck on a foreign page.
    if (isExternalLink(el)) {
      hhaLog('warn', 'click_external_blocked', { url: el.href });
      return false;
    }
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
    } catch (e) {
      hhaLog('debug', 'wait_condition_init_error', { error: String(e && e.message || e) });
    }

    return new Promise((resolve) => {
      let timer = null, pollTimer = null, observer = null, throttleTimer = null;
      let lastCheckTime = 0;
      let hasLoggedError = false;

      const cleanup = (res) => {
        if (timer) clearTimeout(timer);
        if (pollTimer) clearInterval(pollTimer);
        if (throttleTimer) clearTimeout(throttleTimer);
        if (observer) observer.disconnect();
        if (signal) signal.removeEventListener('abort', onAbort);

        // A finished wait is a step forward, as in wait(): the page watchdog
        // measures time between steps, not the length of the whole flow.
        markProgress();
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
        } catch (e) {
          if (!hasLoggedError) {
            hasLoggedError = true;
            hhaLog('debug', 'wait_condition_poll_error', { error: String(e && e.message || e) });
          }
        }
      };

      const throttledCheck = () => {
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const elapsed = now - lastCheckTime;
        if (elapsed >= 150) {
          lastCheckTime = now;
          if (throttleTimer) {
            clearTimeout(throttleTimer);
            throttleTimer = null;
          }
          check();
        } else if (!throttleTimer) {
          throttleTimer = setTimeout(() => {
            throttleTimer = null;
            lastCheckTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            check();
          }, 150 - elapsed);
        }
      };

      const doc = globalThis.document;
      if (typeof MutationObserver !== 'undefined' && doc) {
        try {
          observer = new MutationObserver(throttledCheck);
          const targetNode = doc.body || doc.documentElement || doc;
          observer.observe(targetNode, { childList: true, subtree: true });
        } catch (_) {}
      }

      pollTimer = setInterval(check, 400);

      timer = setTimeout(() => cleanup(false), timeout);
    });
  }

  function waitForElement(keyOrSelector, timeout = 8000, signal = null) {
    return waitForCondition(() => query(keyOrSelector), timeout, signal);
  }

  // --- 12. Page Classification & Security Anomalies ---
  const Page = {
    isVacancy: () => Boolean(globalThis.location?.pathname?.startsWith('/vacancy/')),
    isResponseForm: () => Boolean(globalThis.location?.pathname?.startsWith('/applicant/vacancy_response')),
    isSearchList: () => Boolean(globalThis.location?.pathname?.startsWith('/search/vacancy')),
    isSearch: () => Boolean(globalThis.location?.pathname?.startsWith('/search')),
    // Promo pages of employers: an article, or a survey hh.ru sends a vacancy to at once
    // (/vrsurvey/iteko_drivers?...utm_redirect_vacancy_id=..., 2026-10-18).
    isArticle: () => /^\/(?:article|vrsurvey)\//.test(globalThis.location?.pathname || '')
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
    const lastAttempt = getLastAttemptID();
    if (lastAttempt) return lastAttempt;
    const hrefId = getVacancyIDFromHref(globalThis.location.href);
    return hrefId ? 'v_' + hrefId : null;
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
      const cleanDoc = docTitle.replace(/\s*\u2014\s*hh\.ru.*$/i, '').replace(/\s*-\s*hh\.ru.*$/i, '').trim();
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

  function detectInaccessibleVacancy(root = globalThis.document, text = null) {
    if (!root || Page.isSearch()) return false;
    if (text !== null) {
      return TEXT_RULES.inaccessible.test(text.slice(0, 4000));
    }
    const body = root.body || (root.nodeType === 9 ? root.body : root);
    if (!body) return false;
    const bodyText = textOf(body).slice(0, 4000);
    return TEXT_RULES.inaccessible.test(bodyText);
  }

  function detectCaptcha(root = globalThis.document, text = null) {
    const doc = root?.nodeType === 9 ? root : (root?.ownerDocument || globalThis.document);
    const loc = globalThis.location;
    if (!doc) return false;
    if (detectInaccessibleVacancy(doc, text)) return false;
    if (loc && /\/captcha|\/checkpoint|\/nocaptcha/i.test(loc.pathname)) return true;
    // Only a captcha on screen: a hidden element with "captcha" in its class (a login
    // form, a lazy widget) stopped normal runs.
    if (qa('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="captcha" i], iframe[src*="smartcaptcha" i], [data-qa*="captcha" i], .g-recaptcha, .h-captcha, .smart-captcha, [class*="captcha" i], [id*="captcha" i]', doc).some(isVisible)) {
      return true;
    }
    const bodyText = (text !== null ? text : (textOf(doc.body) || textOf(doc.documentElement))).slice(0, 3000);
    return TEXT_RULES.captcha.test(bodyText);
  }

  function detectDailyLimit(root = globalThis.document) {
    if (!root) return false;

    // Check notification, toast, alert, snackbar and modal scopes
    const notificationSelectors = [
      '[role="alert"]',
      '[role="status"]',
      '[data-qa*="notification" i]',
      '[class*="notification" i]',
      '[data-qa*="toast" i]',
      '[class*="toast" i]',
      '[data-qa*="snackbar" i]',
      '[class*="snackbar" i]',
      '[data-qa*="bloko-notification" i]',
      SELECTORS.modal
    ].join(', ');

    const candidates = qa(notificationSelectors, root);
    for (const el of candidates) {
      if (isVisible(el)) {
        const text = (textOf(el) || el.innerText || '').trim();
        if (text && TEXT_RULES.dailyLimit.test(text)) {
          return true;
        }
      }
    }

    // Check top-level overlay containers and trailing body elements
    const body = root.body || (root.nodeType === 9 ? root.body : root);
    if (body && body.children) {
      const children = Array.from(body.children);
      const startIdx = Math.max(0, children.length - 20);
      for (let i = children.length - 1; i >= startIdx; i--) {
        const child = children[i];
        if (isVisible(child)) {
          const txt = textOf(child).trim();
          if (txt && TEXT_RULES.dailyLimit.test(txt)) {
            return true;
          }
        }
      }

      // Fallback check across the text of the page
      const fullText = textOf(body).slice(0, 3000);
      if (TEXT_RULES.dailyLimit.test(fullText)) {
        return true;
      }
    }

    return false;
  }

  function detectRateLimit(root = globalThis.document, text = null) {
    const doc = root?.nodeType === 9 ? root : (root?.ownerDocument || globalThis.document);
    const loc = globalThis.location;
    if (!doc) return false;
    if (loc && /\/error|\/blocked|\/forbidden|\/denied|\/rate-limit/i.test(loc.pathname)) return true;
    // The title holds the vacancy name, so a bare 429/503 would also match "смена 4290 ₽".
    if (doc.title && TEXT_RULES.rateLimitTitle.test(doc.title)) return true;
    if (qa('[data-qa="error-429"], [data-qa="error-503"], .error-429, .error-503, [data-qa="error-page-title"], [data-qa="error-page"], .error-page, .cf-browser-verification, #challenge-running, #cf-challenge-running, .qrator-challenge, #qrator-clean-page, [data-qa="bloko-notification--error"]', doc).some(isVisible)) {
      return true;
    }
    // The text rule is for hh.ru's own error pages. A page with a vacancy or search results
    // on it is not one, and there the same words belong to the content: "Доступ ограничен:
    // нужен допуск к гостайне" in a vacancy stopped the run as a rate limit.
    if (q('[data-qa="vacancy-title"], [data-qa="vacancy-description"], [data-qa="vacancy-serp__vacancy"], [data-qa="serp-item__title"]', doc)) return false;
    const bodyText = (text !== null ? text : (textOf(doc.body) || textOf(doc.documentElement))).slice(0, 3000);
    return TEXT_RULES.rateLimitPage.test(bodyText);
  }

  // What the last text-based skip or queue decision relied on: the rule and a short
  // fragment of the text it matched. Detectors set it when they match, decision points
  // write it to the log. The regexes are broad, and this is the data to narrow them.
  let lastEvidence = null;

  function noteEvidence(rule, text, regex = null, element = null) {
    const source = String(text || '');
    const found = regex ? regex.exec(source) : null;
    const start = found ? Math.max(0, found.index - 60) : 0;
    lastEvidence = { rule, match: collapseSpaces(source.slice(start, start + 160)) };
    if (element) lastEvidence.element = element;
  }

  function takeEvidence() {
    const evidence = lastEvidence || { rule: 'unknown' };
    lastEvidence = null;
    return evidence;
  }

  function logDecision(vid, decision) {
    hhaLog('info', 'decision', { vid: cleanVid(vid) || undefined, decision, ...takeEvidence() });
  }

  // A submit that was clicked but not confirmed. On a live run such a response had in
  // fact gone through, so the page state is recorded to see what the check missed: the
  // visible modal, the chat link, where a success phrase is on the page, and which
  // element the text check took as "the modal".
  function noteUnconfirmedSubmit() {
    const doc = globalThis.document;
    const modal = getVisibleModals()[0] || null;
    const checkScope = q(SELECTORS.modal);
    // Visible text: textContent would also find these phrases inside page scripts.
    const bodyText = doc?.body?.innerText || '';
    const success = TEXT_RULES.sentAnyVisible.exec(bodyText);
    const parts = [
      `modal=${modal ? 'visible' : 'none'}`,
      `chat_link=${queryExact('responseChat') ? 'yes' : 'no'}`,
      `success_text_at=${success ? success.index : -1}`,
      `check_scope=${checkScope ? `${checkScope.tagName.toLowerCase()}.${checkScope.getAttribute('class') || ''}[${isVisible(checkScope) ? 'visible' : 'hidden'}]` : 'none'}`,
      success ? `near="${bodyText.slice(Math.max(0, success.index - 40), success.index + 80)}"` : '',
      modal ? `modal_text="${modalTextWithoutLetter(modal).slice(0, 120)}"` : ''
    ];
    lastEvidence = { rule: 'submit_unconfirmed', match: collapseSpaces(parts.join(' ')) };
  }

  // The modal text for the log, without the letter: fillTextarea also copies it into the
  // autosize mirror, a pre next to the textarea, and textContent would pick it up there.
  function modalTextWithoutLetter(modal) {
    const copy = modal.cloneNode(true);
    for (const ta of copy.querySelectorAll('textarea')) {
      const wrapper = ta.closest(SELECTORS.nativeWrapper) || ta.parentElement;
      if (wrapper) wrapper.querySelectorAll('pre').forEach(pre => pre.remove());
      ta.remove();
    }
    return copy.textContent || '';
  }

  // The matched element as a selector, e.g. div[data-qa="task-question"].g-user-content,
  // so the log shows which part of the broad selector list fired.
  const describeElement = (el) => {
    const qa = el.getAttribute('data-qa');
    const classes = collapseSpaces(el.getAttribute('class') || '').split(' ').filter(Boolean).map(c => '.' + c).join('');
    return el.tagName.toLowerCase() + (qa ? `[data-qa="${qa}"]` : '') + classes;
  };

  const pageLooksLikeTest = () => {
    const doc = globalThis.document;
    if (!doc) return false;
    const marker = q('[data-qa*="question" i], [data-qa*="test-task" i], [data-qa*="questionnaire" i], [class*="questionnaire" i], [class*="response-test" i]');
    if (marker) {
      noteEvidence('page_test_selector', textOf(marker), null, describeElement(marker));
      return true;
    }
    const form = q('[data-qa*="response-form" i], [data-qa*="vacancy-response" i], form');
    const text = textOf(form || doc.body || doc.documentElement).slice(0, 4000);
    if (!TEXT_RULES.testPage.test(text)) return false;
    noteEvidence('page_test_regex', text, TEXT_RULES.testPage);
    return true;
  };

  const detectAlreadyApplied = () => {
    const doc = globalThis.document;
    if (!doc) return false;
    if (queryExact('responseChat')) return true;
    const bodyText = textOf(doc.body || doc.documentElement).slice(0, 3000);
    return TEXT_RULES.alreadyApplied.test(bodyText);
  };

  const getResponseDetectionScope = () => q(SELECTORS.modal) || globalThis.document?.body || globalThis.document?.documentElement;
  const hasReliableRejectWarning = (root) => {
    const scope = (root && root !== globalThis.document && root !== globalThis.document?.body) ? root : q(SELECTORS.modal + ', [role="alert"]');
    if (!scope) return false;
    const el = query('rejectWarning', scope);
    if (!el || !isVisible(el)) return false;
    noteEvidence(el.matches(SELECTORS.rejectWarning) ? 'reject_selector' : 'reject_heuristic', textOf(el), TEXT_RULES.reject);
    return true;
  };
  const hasResponseTextConfirmation = (root) => TEXT_RULES.sentInModal.test(textOf(root || getResponseDetectionScope()).slice(0, 4000));
  const hasExactResponseConfirmation = (root) => {
    const scope = root || getResponseDetectionScope();
    return Boolean(scope && (queryExact('responseChat', scope) || (!config.useCover && queryExact('attachCoverBtn', scope))));
  };

  function isResponseConfirmed({ allowDocumentStrongText = false } = {}) {
    if (hasExactResponseConfirmation() || hasResponseTextConfirmation()) return true;
    const loc = globalThis.location;
    if (loc && (/\/success/i.test(loc.pathname) || /[?&]success\b/i.test(loc.search))) return true;
    if (detectAlreadyApplied()) return true;
    const doc = globalThis.document;
    return Boolean((allowDocumentStrongText || Page.isVacancy()) && doc && TEXT_RULES.sentOnPage.test((doc.body?.innerText || textOf(doc.body)).slice(0, 4000)));
  }

  function detectModalBlockReason(modalScope = null) {
    const modal = modalScope || getVisibleModals()[0] || null;
    if (!modal) return null;
    if (detectDailyLimit(modal) || detectDailyLimit()) return 'DAILY_LIMIT';
    const text = (textOf(modal) || modal.innerText || '').slice(0, 3000);
    if (TEXT_RULES.resumeHidden.test(text)) {
      noteEvidence('modal_resume_hidden', text, TEXT_RULES.resumeHidden);
      return 'RESUME_HIDDEN';
    }
    const warning = q(SELECTORS.rejectWarning, modal);
    if (warning) {
      noteEvidence('modal_reject_selector', textOf(warning));
      return 'REJECT_WARNING';
    }
    if (TEXT_RULES.reject.test(text)) {
      noteEvidence('modal_reject_regex', text, TEXT_RULES.reject);
      return 'REJECT_REGEX';
    }
    if (TEXT_RULES.modalTest.test(text)) {
      noteEvidence('modal_test_regex', text, TEXT_RULES.modalTest);
      return 'TEST_REQUIRED';
    }
    if (detectCaptcha() || TEXT_RULES.modalCaptcha.test(text)) return 'CAPTCHA';
    if (detectRateLimit() || TEXT_RULES.modalRateLimit.test(text)) return 'RATE_LIMIT';
    return null;
  }

  function isAttachCoverAvailable(root = null) {
    if (!config.useCover) return false;
    const btn = root ? queryExact('attachCoverBtn', root) : queryExact('attachCoverBtn');
    return Boolean(btn && isVisible(btn) && !isReviewOrFeedbackElement(btn));
  }

  // Checks scoped to one modal. The page-wide ones (daily limit, relocation, captcha,
  // rate limit) are done by detectResponseOutcomeOnce, once per check and not per modal.
  function detectResponseOutcomeInRoot(root, includeExactSelectors) {
    if (!root || isReviewOrFeedbackElement(root)) return null;
    if (detectDailyLimit(root)) return 'DAILY_LIMIT';
    const warningEl = q(SELECTORS.rejectWarning, root);
    if (warningEl && isVisible(warningEl)) {
      noteEvidence('reject_selector', textOf(warningEl));
      return 'REJECT_WARNING';
    }
    if (hasReliableRejectWarning(root)) return 'REJECT_REGEX';

    const isResumeModal = Boolean(
      q('input[type="radio"][name*="resume" i], [data-qa*="select-resume" i], [data-qa*="resume-item" i]', root) ||
      TEXT_RULES.resumeChoice.test(textOf(root))
    );

    if (includeExactSelectors && isAttachCoverAvailable(root)) {
      return 'ATTACH_COVER';
    }
    if (includeExactSelectors && (queryExact('responseChat', root) || hasResponseTextConfirmation(root) || (!config.useCover && queryExact('attachCoverBtn', root)))) {
      return 'SUCCESS';
    }
    // A button found only by its text ("Продолжить", "Отправить") counts inside a form:
    // a promo popup or a banner with such a button is not the response dialog.
    const textSubmitInForm = Boolean(q('form', root)) && Boolean(query('letterSubmit', root));
    if (query('letterTextarea', root) || query('attachCoverInModal', root) || queryExact('letterSubmit', root) || textSubmitInForm || q('[data-qa="vacancy-response-popup-form"]', root) || isResumeModal) {
      return 'MODAL_OPEN';
    }
    return null;
  }

  // The response dialog among the visible "modals". The selector is broad and also takes
  // promo popups and banners; the first visible one used to be taken, and the script
  // pressed "Продолжить" in a promo popup instead of sending the response. The dialog
  // with the response form scores highest; on a tie the first one wins, as before.
  function pickResponseModal() {
    let best = null;
    let bestScore = -1;
    for (const m of getVisibleModals()) {
      let score = 0;
      if (q(SELECTORS.letterTextarea, m)) score += 4;
      if (q('[data-qa="vacancy-response-popup-form"], input[type="radio"][name*="resume" i], [data-qa*="resume-item" i]', m)) score += 4;
      if (queryExact('letterSubmit', m) || q('form button[type="submit"], form input[type="submit"], button[type="submit"][form]', m)) score += 2;
      if (m.matches?.('[role="dialog"], [aria-modal="true"], [data-qa="bottom-sheet-content"]')) score += 1;
      if (score > bestScore) {
        best = m;
        bestScore = score;
      }
    }
    return best;
  }

  function detectResponseOutcomeOnce({ allowDocumentStrongText = false } = {}) {
    if (detectDailyLimit()) return 'DAILY_LIMIT';
    if (detectRelocationWarning()) return 'RELOCATION_WARNING';
    if (isAttachCoverAvailable()) return 'ATTACH_COVER';

    // The selector also matches nested blocks (.modal-header, .modal-content), so there
    // are often several "modals". Captcha and rate limit are checked once, before the
    // first one that is not a review widget, as the per-modal loop used to do.
    let pageChecked = false;
    for (const modal of getVisibleModals()) {
      if (isReviewOrFeedbackElement(modal)) continue;
      if (!pageChecked) {
        pageChecked = true;
        if (detectCaptcha()) return 'CAPTCHA';
        if (detectRateLimit()) return 'RATE_LIMIT';
      }
      const outcome = detectResponseOutcomeInRoot(modal, true);
      if (outcome) return outcome;
    }

    if (hasExactResponseConfirmation() || isResponseConfirmed({ allowDocumentStrongText })) return 'SUCCESS';

    return null;
  }

  // --- 13. Application Flow & Scenarios ---
  function markVacancyProcessed(vid, runId = currentRunId) {
    if (runId !== undefined && runId !== null && !guardOwnedCommit(runId)) return false;
    return vid ? addProcessedID(vid) : true;
  }

  function commitSuccess(vid, runId = currentRunId) {
    if (runId !== undefined && runId !== null && !guardOwnedCommit(runId)) return false;
    markVacancyProcessed(vid, runId);
    rememberApplied(vid);
    if (vid) {
      lastCommittedVid = cleanVid(vid);
      storage.sessionSet(KEYS.lastCommittedVid, lastCommittedVid);
    }
    recordOutcome(vid, 'applied', 'applied_success');
    const cur = getSentCount();
    events.emit('progress', {
      sent: cur,
      percentage: Math.min(100, Math.round((cur / MAX_DAILY_LIMIT) * 100))
    });
    return true;
  }

  function revertCommittedApplied(vid) {
    const lastCommitted = lastCommittedVid || storage.sessionGet(KEYS.lastCommittedVid);
    const cleanTarget = cleanVid(vid || lastCommitted || '');
    if (lastCommitted && cleanTarget && lastCommitted === cleanTarget) {
      const counters = getDailyCounters();
      if (counters.applied > 0) {
        counters.applied--;
        saveDailyCounters(counters);
        const cur = getSentCount();
        events.emit('progress', {
          sent: cur,
          percentage: Math.min(100, Math.round((cur / MAX_DAILY_LIMIT) * 100))
        });
      }
      forgetApplied(cleanTarget);
      lastCommittedVid = null;
      storage.sessionRemove(KEYS.lastCommittedVid);
      return true;
    }
    return false;
  }

  // A queued vacancy the user applied to by hand. It leaves the queue and counts toward
  // today's responses: hh.ru counts it toward the same daily limit.
  function markManualApplied(vid, source) {
    const clean = cleanVid(vid);
    if (!clean || !ManualQueue.has(clean)) return false;
    ManualQueue.remove(clean);
    rememberApplied(clean);
    const counters = getDailyCounters();
    counters.applied++;
    saveDailyCounters(counters);
    hhaLog('info', 'manual_applied', { vid: clean, source });
    const cur = getSentCount();
    events.emit('progress', {
      sent: cur,
      percentage: Math.min(100, Math.round((cur / MAX_DAILY_LIMIT) * 100))
    });
    return true;
  }

  // The page shows that a response to this vacancy exists: the chat link, the offer to
  // attach a cover letter, or a success message in a visible modal.
  const isManualResponseDone = () => detectAlreadyApplied() ||
    Boolean(queryExact('attachCoverBtn')) ||
    getVisibleModals().some(modal => hasResponseTextConfirmation(modal));

  // A vacancy opened from the queue in its own tab. The user often answers the questions
  // in a modal, and then the page does not reload, so the page is checked for a while.
  const MANUAL_WATCH_MS = 10 * 60 * 1000;
  let manualWatchId = null;

  function stopManualWatch() {
    if (manualWatchId !== null) {
      clearInterval(manualWatchId);
      manualWatchId = null;
    }
  }

  function watchManualResponse(vid) {
    stopManualWatch();
    const startedAt = Date.now();
    const check = () => {
      if (isRunning() || !ManualQueue.has(vid) || Date.now() - startedAt > MANUAL_WATCH_MS) return stopManualWatch();
      if (isManualResponseDone()) {
        markManualApplied(vid, 'page');
        stopManualWatch();
      }
    };
    manualWatchId = setInterval(check, 1500);
    check();
  }

  function skipVacancy(vid, reason = 'skip_reject_warning', runId = currentRunId) {
    if (runId !== undefined && runId !== null && !guardOwnedCommit(runId)) return false;
    markVacancyProcessed(vid, runId);
    if (LASTING_SKIP_REASONS.has(reason)) skippedHistory.remember(vid);
    recordOutcome(vid, 'skipped', reason);
  }

  // Vacancies in a row with no apply button on their page. One is a vacancy without a
  // response; several in a row mean hh.ru changed the markup. Then the whole search went
  // to the queue and was remembered for 30 days, hidden from every later run. Now the
  // run stops, and those vacancies leave the queue and its memory.
  const NO_BUTTON_STOP = 3;
  function noteNoApplyButton(vid) {
    if (!isRunning()) return false;
    const stored = parseJson(storage.sessionGet(KEYS.noButtonStreak), []);
    const streak = (Array.isArray(stored) ? stored.filter((v) => typeof v === 'string') : [])
      .concat(cleanVid(vid)).slice(-NO_BUTTON_STOP);
    if (streak.length < NO_BUTTON_STOP) {
      storage.sessionSet(KEYS.noButtonStreak, JSON.stringify(streak));
      return false;
    }
    storage.sessionRemove(KEYS.noButtonStreak);
    const inQueue = streak.filter((v) => ManualQueue.has(v));
    for (const v of streak) {
      queuedHistory.forget(v);
      ManualQueue.remove(v);
    }
    if (inQueue.length) {
      const counters = getDailyCounters();
      counters.queued = Math.max(0, counters.queued - inQueue.length);
      saveDailyCounters(counters);
    }
    haltEngine('APPLY_BUTTON_NOT_FOUND', `На ${NO_BUTTON_STOP} вакансиях подряд не нашлась кнопка отклика, автоматизация остановлена.`,
      describeSelectorFailure('vacancyApply', globalThis.document?.body, { vids: streak.join(',') }));
    return true;
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
      const links = qa(`${SELECTORS.vacancyLink}, a[href*="/vacancy/"]`);
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
      salary,
      questions: readTaskQuestions()
    };
    const res = ManualQueue.add(entry);
    if (res.success) {
      if (clean && LASTING_QUEUE_REASONS.has(note)) queuedHistory.remember(clean);
      if (res.isNew) {
        recordOutcome(clean, 'queued', note || 'manual');
      }
      return true;
    }
    // The storage is full even after the log gave way: every next queued vacancy would be
    // lost the same way, silently, so the run stops and says why.
    if (isRunning()) {
      haltEngine('STORAGE_FULL', 'Хранилище браузера переполнено: вакансию не удалось сохранить в очередь.', { vid: clean });
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
    // The stored address is checked like the next results page: hh.ru search only. Any
    // address on http used to pass, and session storage is open to the page's scripts.
    const origin = globalThis.location?.origin || 'https://hh.ru';
    const returnUrl = toSearchListUrl(getReturnUrl()) || `${origin}/search/vacancy`;
    const loc = globalThis.location;
    if (loc && !Page.isSearchList() && loc.href !== returnUrl) {
      isNavigating = true;
      setActivity('returning');
      setTimeout(() => { isNavigating = false; }, 7000);
      leavePage(returnUrl);
    }
    return true;
  }

  // The vacancy title and employer for the letter variables. The vacancy page saved them
  // in the pending meta before the click; the response form page only links back to it.
  function letterValues(vid) {
    const meta = getPendingVacancyMeta(vid) || {};
    let title = collapseSpaces(meta.title);
    if (!title || isGenericVacancyTitle(title)) title = parseVacancyTitle(vid);
    title = (isGenericVacancyTitle(title) || /^Вакансия #/.test(title)) ? '' : cleanVacancyTitle(title);
    const employerEl = q('[data-qa="vacancy-company-name"], [data-qa="vacancy-response-company-name"]');
    const employer = cleanEmployerName((employerEl && (employerEl.innerText || employerEl.textContent)) || meta.employer || '');
    return { title, employer };
  }

  // The letter for this vacancy, or null when none should go: sending is off, or a
  // variable has neither a value on the page nor a fallback. A letter with a bare
  // {компания} in it would be worse than no letter.
  function coverLetterFor(vid) {
    if (!config.useCover) return null;
    const { text, missing } = renderLetter(config.coverText, letterValues(vid));
    if (missing.length) {
      hhaLog('warn', 'letter_skipped', { vid: cleanVid(vid), missing: missing.join(',') });
      return null;
    }
    if (text.length > MAX_COVER_LENGTH) {
      // The template fits, the names made it longer. Cut whole: no half of an emoji at the end.
      hhaLog('warn', 'letter_truncated', { vid: cleanVid(vid), length: text.length, limit: MAX_COVER_LENGTH });
    }
    return sliceSafe(text, MAX_COVER_LENGTH);
  }

  async function submitCoverLetterForm(scope = null, runId = currentRunId, letter = null) {
    if (!isRunCurrent(runId)) return false;
    const ta = query('letterTextarea', scope);
    // A letter to send and no field for it here: never silent, the log says where it looked.
    if (!ta && letter !== null) {
      hhaLog('warn', 'letter_field_missing', { vid: cleanVid(resolveCurrentVid()), scope: scope && scope.nodeType === 1 ? describeElement(scope) : 'document' });
    }
    if (ta && letter !== null) {
      // Nobody types the same letter for every vacancy: it is pasted, a moment after the
      // field is clicked, and read over before the submit.
      if (PACE.on) {
        try { ta.focus(); } catch (_) {}
        await wait(randIn(PACE.letterBeforeMs));
        if (!isRunCurrent(runId)) return false;
      }
      fillTextarea(ta, letter, PACE.on ? 'insertFromPaste' : 'insertText');
      letterFilledVid = cleanVid(resolveCurrentVid());
      hhaLog('info', 'letter_filled', { vid: letterFilledVid, page: Page.isResponseForm() ? 'response_form' : 'vacancy' });
      await (PACE.on ? wait(randIn(PACE.letterAfterMs)) : actionPause());
      if (!isRunCurrent(runId)) return false;
    }
    const submit = query('letterSubmit', scope) || findResponseFormSubmit(scope);
    if (!submit) {
      reportWarning('Кнопка отправки формы не найдена', 'SUBMIT_BTN_NOT_FOUND', describeSelectorFailure('letterSubmit', scope || globalThis.document?.body));
      return false;
    }

    if (submit.disabled || submit.getAttribute?.('aria-disabled') === 'true') {
      await waitForCondition(() => !submit.disabled && submit.getAttribute?.('aria-disabled') !== 'true', 1500, activeAbortController?.signal);
      if (submit.disabled || submit.getAttribute?.('aria-disabled') === 'true') {
        // A Stop during the wait ends it at once: no warning, and no submit below.
        if (!isRunCurrent(runId)) return false;
        reportWarning('Кнопка отправки остаётся неактивной после ожидания, нажимаем всё равно', 'SUBMIT_BTN_STILL_DISABLED');
      }
    }
    // requestSubmit below does not go through clickElement and its stop check.
    if (!isRunCurrent(runId)) return false;
    markInflight(resolveCurrentVid());

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
    const letter = coverLetterFor(resolveCurrentVid());
    if (letter === null) return 'OK';
    setActivity('attaching_letter');
    await actionPause();
    if (!isRunCurrent(runId)) return 'STOPPED';

    const attachBtn = btn || query('attachCoverBtn');
    if (attachBtn) {
      await clickElement(attachBtn);
    } else {
      reportError('Отклик отправлен без письма: не нашлась кнопка, которая прикрепляет письмо.', 'ATTACH_BTN_NOT_FOUND', describeSelectorFailure('attachCoverBtn', globalThis.document?.body));
      return isRunCurrent(runId) ? 'OK' : 'STOPPED';
    }

    await actionPause();
    if (!isRunCurrent(runId)) return 'STOPPED';
    const ta = await waitForElement('letterTextarea', 5000, activeAbortController?.signal);
    if (!ta) {
      reportError('Отклик отправлен без письма: поле для письма не появилось за 5 секунд.', 'LETTER_FORM_TIMEOUT', describeSelectorFailure('letterTextarea', globalThis.document?.body));
      return isRunCurrent(runId) ? 'OK' : 'STOPPED';
    }

    // The dialog that holds this field: the first visible "modal" on the page can be another
    // popup of hh.ru (the selector is broad), with no field in it. The submit button of the
    // letter dialog sits in its footer, outside the form, so the scope is the whole dialog.
    const modalScope = ta.closest?.('[role="dialog"]') || ta.closest?.(SELECTORS.modal) || ta.form || getVisibleModals()[0] || globalThis.document?.body;
    const letterSent = await submitCoverLetterForm(modalScope, runId, letter);
    if (!isRunCurrent(runId)) return 'STOPPED';
    if (!letterSent) {
      reportError('Отклик отправлен без письма: не нашлась кнопка отправки письма.', 'SUBMIT_BTN_NOT_FOUND', describeSelectorFailure('letterSubmit', modalScope));
      return 'OK';
    }
    await waitForCondition(() => {
      const isSheetClosed = !modalScope.isConnected || !isVisible(modalScope);
      return isSheetClosed || isResponseConfirmed({ allowDocumentStrongText: true });
    }, 5000, activeAbortController?.signal);
    return isRunCurrent(runId) ? 'OK' : 'STOPPED';
  }

  async function checkAndHandleRejectWarning(modal) {
    if (!modal) return null;
    const blockReason = detectModalBlockReason(modal);
    if (blockReason === 'REJECT_WARNING' || blockReason === 'REJECT_REGEX') {
      await closeModal(modal);
      return blockReason === 'REJECT_REGEX' ? 'SKIP_REJECT_REGEX' : 'SKIP_REJECT_WARNING';
    }
    if (hasReliableRejectWarning(modal)) {
      const isWarningSelector = Boolean(q(SELECTORS.rejectWarning, modal));
      await closeModal(modal);
      return isWarningSelector ? 'SKIP_REJECT_WARNING' : 'SKIP_REJECT_REGEX';
    }
    return null;
  }

  async function handleScenarioB(modal, runId = currentRunId) {
    if (detectDailyLimit(modal) || detectDailyLimit()) { haltForDailyLimit(); return 'BLOCKED'; }
    const blockReason = detectModalBlockReason(modal);
    if (blockReason === 'DAILY_LIMIT') { haltForDailyLimit(); return 'BLOCKED'; }
    if (blockReason === 'CAPTCHA') { haltForCaptcha(); return 'CAPTCHA'; }
    if (blockReason === 'RATE_LIMIT') { haltForRateLimit(); return 'BLOCKED'; }
    if (blockReason === 'TEST_REQUIRED' || blockReason === 'RESUME_HIDDEN') return blockReason;

    const rejectOutcome = await checkAndHandleRejectWarning(modal);
    if (rejectOutcome) return rejectOutcome;

    const resumeOk = await selectResumeIfRequired(modal, runId);
    if (!resumeOk || !isRunCurrent(runId)) return 'STOPPED';

    const letter = coverLetterFor(resolveCurrentVid());
    const attachCoverToggle = query('attachCoverInModal', modal)
      || findPatternElement(modal, 'button, [role="button"], a', /добавить\s+сопроводительное|написать\s+письмо/i, 35);
    if (attachCoverToggle && letter !== null) {
      await clickElement(attachCoverToggle);
      await actionPause();
      if (!isRunCurrent(runId)) return 'STOPPED';
    }

    const submitted = await submitCoverLetterForm(modal, runId, letter);
    if (!submitted) {
      if (!isRunCurrent(runId)) return 'STOPPED';
      noteEvidence('submit_not_clicked', '');
      return 'FAIL';
    }

    const confirmed = await waitForCondition(
      () => {
        if (detectDailyLimit(modal) || detectDailyLimit()) return 'DAILY_LIMIT';
        return isResponseConfirmed();
      },
      6000,
      activeAbortController?.signal
    );
    // A stop meanwhile (a captcha, Стоп): no failed submit and no attempt to count.
    if (!isRunCurrent(runId)) return 'STOPPED';
    if (confirmed === 'DAILY_LIMIT' || detectDailyLimit()) {
      haltForDailyLimit();
      return 'BLOCKED';
    }
    if (!confirmed) noteUnconfirmedSubmit();
    return confirmed ? 'OK' : 'FAIL';
  }

  // A response form with no letter field (hh.ru shows one, for example, to pick a resume)
  // sends the response without the letter; the "Приложить сопроводительное письмо"
  // button that comes after it is the only way to add one. The response counts either way.
  async function attachLetterAfterResponse(vid, runId) {
    if (!config.useCover || letterFilledVid === cleanVid(vid) || Page.isResponseForm()) return;
    // A variable with no value: letter_skipped is already in the log, there is nothing to attach.
    if (renderLetter(config.coverText, letterValues(vid)).missing.length) return;
    const btn = await waitForCondition(() => isAttachCoverAvailable() && queryExact('attachCoverBtn'), 3000, activeAbortController?.signal);
    if (!isRunCurrent(runId)) return;
    if (!btn) {
      hhaLog('warn', 'letter_not_attached', { vid, reason: 'form_without_letter', seen: describeLetterControls() });
      return;
    }
    await handleScenarioA(btn, runId);
  }

  async function handleModalOutcome(vid, runId) {
    const modal = pickResponseModal();
    setActivity('submitting', { vid });
    const res = await handleScenarioB(modal, runId);
    if (res === 'OK' && vid) {
      await attachLetterAfterResponse(vid, runId);
      commitSuccess(vid, runId);
    } else if ((res === 'SKIP' || res === 'SKIP_REJECT_WARNING' || res === 'SKIP_REJECT_REGEX') && vid) {
      logDecision(vid, 'skip_reject');
      skipVacancy(vid, res === 'SKIP_REJECT_REGEX' ? 'skip_reject_regex' : 'skip_reject_warning', runId);
    } else if (res === 'TEST_REQUIRED') {
      logDecision(vid, 'queue_test');
      if (vid) {
        saveCurrentForManual(vid, 'test_required', runId);
        markVacancyProcessed(vid, runId);
      }
      await closeModal(modal);
    } else if (res === 'RESUME_HIDDEN') {
      logDecision(vid, 'skip_resume_hidden');
      if (vid) skipVacancy(vid, 'resume_hidden', runId);
      await closeModal(modal);
    } else if (res === 'FAIL') {
      logDecision(vid, 'queue_submit_failed');
      if (vid) {
        saveCurrentForManual(vid, 'modal_submit_failed', runId);
        markVacancyProcessed(vid, runId);
      }
      await closeModal(modal);
    }
    return res;
  }

  async function handleRelocationOutcome(vid, runId, relocAttempts) {
    if (relocAttempts >= 2) {
      reportWarning('Предупреждение о релокации повторяется, вакансия отправлена в очередь', 'RELOCATION_LOOP_GUARD', { vid, relocAttempts });
      if (vid) {
        saveCurrentForManual(vid, 'relocation_loop', runId);
        markVacancyProcessed(vid, runId);
      }
      return 'FAIL';
    }
    setActivity('relocation', { vid });
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
        if (vid && !Page.isResponseForm() && !pageLooksLikeTest()) commitSuccess(vid, runId);
        return 'OK';
      }
      reportWarning('Таймаут подтверждения релокации', 'RELOCATION_TIMEOUT', { vid });
      if (vid) {
        saveCurrentForManual(vid, 'relocation_timeout', runId);
        markVacancyProcessed(vid, runId);
      }
      return 'FAIL';
    }
    reportWarning('Не удалось подтвердить предупреждение о релокации', 'RELOCATION_BTN_NOT_FOUND', { vid });
    if (vid) {
      saveCurrentForManual(vid, 'relocation_unconfirmed', runId);
      markVacancyProcessed(vid, runId);
    }
    return 'FAIL';
  }

  // Short visible controls that mention a letter, e.g. `a[data-qa="..."] "Добавить
  // сопроводительное"`: for the log when the known attach button is not on the page.
  function describeLetterControls() {
    const found = [];
    for (const el of qa('button, a, [role="button"]')) {
      if (found.length >= 3) break;
      const txt = collapseSpaces(el.innerText || el.textContent || '');
      if (!txt || txt.length > 80 || !/сопроводительн|письм/i.test(txt) || !isVisible(el)) continue;
      const box = el.closest?.('[data-qa]');
      found.push(`${describeElement(el)}${box && box !== el ? ' in ' + describeElement(box) : ''} "${txt.slice(0, 60)}"`);
    }
    return found.join(' | ') || 'none';
  }

  async function dispatchOutcome(outcome, vid, runId, relocAttempts = 0) {
    if (!outcome) return 'FAIL';
    if (outcome === 'DAILY_LIMIT') { haltForDailyLimit(); return 'BLOCKED'; }
    if (outcome === 'RESPONSE_FORM') return 'RESPONSE_PAGE';
    if (outcome === 'CAPTCHA') { haltForCaptcha(); return 'CAPTCHA'; }
    if (outcome === 'RATE_LIMIT') { haltForRateLimit(); return 'BLOCKED'; }

    if (outcome === 'ATTACH_COVER') {
      const res = await handleScenarioA(query('attachCoverBtn'), runId);
      if (res === 'OK' && vid) {
        if (!Page.isResponseForm() && !pageLooksLikeTest()) {
          commitSuccess(vid, runId);
        } else {
          hhaLog('warn', 'commit_skipped', { vid, ...(Page.isResponseForm() ? { reason: 'response_form' } : { reason: 'page_looks_like_test', ...takeEvidence() }) });
        }
      }
      return res;
    }

    if (outcome === 'MODAL_OPEN') {
      return await handleModalOutcome(vid, runId);
    }

    if (outcome === 'SUCCESS') {
      // hh.ru sent the response at once, with no form. A letter can then go only through
      // the attach button, which may show up a moment after the confirmation; without it
      // the response stays without a letter, and the log names what the page offered.
      // A letter with a variable that has no value would not go anyway: no wait for it.
      if (config.useCover && !Page.isResponseForm() && !renderLetter(config.coverText, letterValues(vid)).missing.length) {
        const late = await waitForCondition(() => isAttachCoverAvailable(), 3000, activeAbortController?.signal);
        if (!isRunCurrent(runId)) return 'STOPPED';
        if (late) return dispatchOutcome('ATTACH_COVER', vid, runId, relocAttempts);
        hhaLog('warn', 'letter_not_attached', { vid, reason: 'no_attach_button', seen: describeLetterControls() });
      }
      if (vid) {
        if (!Page.isResponseForm() && !pageLooksLikeTest()) {
          commitSuccess(vid, runId);
        } else {
          hhaLog('warn', 'commit_skipped', { vid, ...(Page.isResponseForm() ? { reason: 'response_form' } : { reason: 'page_looks_like_test', ...takeEvidence() }) });
        }
      }
      return 'OK';
    }

    if (outcome === 'REJECT_WARNING' || outcome === 'REJECT_REGEX') {
      logDecision(vid, 'skip_reject');
      await closeModal();
      if (vid) skipVacancy(vid, outcome === 'REJECT_REGEX' ? 'skip_reject_regex' : 'skip_reject_warning', runId);
      return 'SKIP';
    }

    if (outcome === 'RELOCATION_WARNING') {
      return await handleRelocationOutcome(vid, runId, relocAttempts);
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
    const t = ACTION_TIMINGS;
    const minDelay = Math.max(2000, Math.round(t.delay[0] * 0.7));
    const maxDelay = Math.round(t.delay[1] * 0.85);
    const totalDuration = randBetween(minDelay, maxDelay) * paceFactor();
    const stepDelay = Math.round(totalDuration / steps);
    setActivity('reading', { vid, durationMs: stepDelay * steps });

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

  async function waitForVacancyApplyOutcome(applyBtn, vid, runId) {
    let outcome = await waitForCondition(
      () => {
        if (detectDailyLimit()) return 'DAILY_LIMIT';
        if (Page.isResponseForm()) return 'RESPONSE_FORM';
        return detectResponseOutcomeOnce();
      },
      3500,
      activeAbortController?.signal
    );

    if (outcome === 'DAILY_LIMIT' || detectDailyLimit()) {
      haltForDailyLimit();
      return 'BLOCKED';
    }

    if (!outcome && !Page.isResponseForm()) {
      const directHref = applyBtn.getAttribute?.('href') || applyBtn.href;
      if (directHref && (directHref.includes('/applicant/vacancy_response') || directHref.includes('vacancy_response'))) {
        const fullTarget = directHref.startsWith('http') ? directHref : (new URL(directHref, globalThis.location?.origin || 'https://hh.ru').href);
        setTrapLock(45000, runId);
        setLastAttemptID(vid);
        leavePage(fullTarget);
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
        activeAbortController?.signal
      );
    }

    if (!outcome) {
      reportWarning(`Таймаут ожидания исхода отклика на вакансию #${vid}`, 'OUTCOME_TIMEOUT', { vid });
    }
    return outcome;
  }

  async function handleVacancyPage(vid, runId = currentRunId) {
    lastEvidence = null;
    try {
      const pageUrl = globalThis.location?.href || '';
      if (detectInaccessibleVacancy()) {
        if (vid) skipVacancy(vid, 'access_denied', runId);
        returnToList(vid, { markProcessed: true, runId });
        return 'SKIP';
      }
      if (detectDailyLimit()) { haltForDailyLimit(); return 'BLOCKED'; }
      if (detectAlreadyApplied()) {
        const pending = readInflightEntry();
        const late = vid ? takeLateApplied(vid) : null;
        let letterOwed = false;
        if (vid && pending && pending.vid === cleanVid(vid)) {
          // This run pressed the button here, and the page reloaded (or a captcha stopped the
          // run) before the response was recorded: it is this run's response, not an old one.
          hhaLog('info', 'late_response', { vid: cleanVid(vid), source: pending.captcha ? 'captcha' : 'reload' });
          letterOwed = Boolean(pending.letterOwed);
          commitSuccess(vid, runId);
        } else if (late) {
          // Counted while the run was stopped, when the page showed it.
          markVacancyProcessed(vid, runId);
          letterOwed = Boolean(late.letterOwed);
        } else if (vid && getAppliedHistorySet().has(cleanVid(vid))) {
          // A response the script has already counted: the page came again, for one by the
          // browser's Back button during a run. Not a skip "already applied" a second time.
          markVacancyProcessed(vid, runId);
          hhaLog('info', 'already_counted', { vid: cleanVid(vid) });
        } else if (vid) {
          rememberApplied(vid);
          skipVacancy(vid, 'already_applied', runId);
        }
        if (letterOwed) {
          setActivity('attaching_letter', { vid });
          await attachLetterAfterResponse(vid, runId);
          if (!isRunCurrent(runId)) return 'STOPPED';
        }
        returnToList(vid, { markProcessed: true, runId });
        return 'OK';
      }

      await simulateHumanReading(vid, runId);
      if (!isRunCurrent(runId)) return 'STOPPED';
      setActivity('applying', { vid });
      const applyBtn = await waitForCondition(() => query('vacancyApply'), 4000, activeAbortController?.signal);
      if (!applyBtn) {
        reportWarning(`Кнопка "Откликнуться" не найдена на странице вакансии #${vid}`, 'NO_APPLY_BUTTON', describeSelectorFailure('vacancyApply', globalThis.document?.body, { vid, url: pageUrl }));
        if (vid) saveCurrentForManual(vid, 'no-apply-button', runId);
        if (vid && noteNoApplyButton(vid)) return 'BLOCKED';
        returnToList(vid, { markProcessed: true, runId });
        return 'FAIL';
      }
      if (isExternalLink(applyBtn)) {
        if (vid) saveCurrentForManual(vid, 'queued_external_site', runId);
        returnToList(vid, { markProcessed: true, runId });
        return 'OK';
      }
      await actionPause();
      if (!isRunCurrent(runId)) return 'STOPPED';
      markInflight(vid);
      await clickElement(applyBtn);
      await actionPause();
      if (!isRunCurrent(runId)) return 'STOPPED';

      setActivity('waiting_outcome', { vid });
      const outcome = await waitForVacancyApplyOutcome(applyBtn, vid, runId);
      if (outcome === 'BLOCKED' || outcome === 'RESPONSE_PAGE') return outcome;

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
    setActivity('submitting', { vid });
    handlingResponsePage = true;
    try {
      if (pageLooksLikeTest()) {
        logDecision(vid, 'queue_test');
        revertCommittedApplied(lastCommittedVid || vid);
        saveCurrentForManual(vid, 'test-questionnaire', runId);
        return returnToList(vid, { markProcessed: true, runId });
      }

      const resumeOk = await selectResumeIfRequired(globalThis.document?.body, runId);
      if (!resumeOk || !isRunCurrent(runId)) return;

      // Cover letter toggle support
      const letter = coverLetterFor(vid);
      const coverToggle = query('attachCoverInModal')
        || findPatternElement(globalThis.document?.body, 'button, [role="button"], a', /добавить\s+сопроводительное|написать\s+письмо/i, 35);
      if (coverToggle && letter !== null) {
        await clickElement(coverToggle);
        await actionPause();
        if (!isRunCurrent(runId)) return;
      }

      const submitBtn = await waitForCondition(
        () => query('letterSubmit') || findResponseFormSubmit(),
        4000,
        activeAbortController?.signal
      );
      if (!isRunCurrent(runId)) return;
      if (!submitBtn) {
        reportWarning('Кнопка отправки формы отклика не найдена', 'SUBMIT_BTN_NOT_FOUND', describeSelectorFailure('letterSubmit', globalThis.document?.body, { vid }));
        saveCurrentForManual(vid, 'no-submit-button', runId);
        if (vid && noteNoApplyButton(vid)) return;
        return returnToList(vid, { markProcessed: true, runId });
      }
      const submitted = await submitCoverLetterForm(null, runId, letter);
      if (!isRunCurrent(runId)) return;
      if (!submitted) {
        if (detectDailyLimit()) {
          haltForDailyLimit();
          return;
        }
        reportWarning('Не удалось нажать кнопку отправки формы отклика', 'SUBMIT_FAILED', { vid });
        return handleVacancyFailure(vid, 'submit-form-failed', runId);
      }
      const confirmed = await waitForCondition(
        () => {
          if (detectDailyLimit()) return 'DAILY_LIMIT';
          return isResponseConfirmed({ allowDocumentStrongText: true });
        },
        6000,
        activeAbortController?.signal
      );
      if (!isRunCurrent(runId)) return;
      if (confirmed === 'DAILY_LIMIT' || detectDailyLimit()) {
        haltForDailyLimit();
        return;
      }
      if (!confirmed) {
        noteUnconfirmedSubmit();
        logDecision(vid, 'retry_submit_unconfirmed');
        reportWarning(`Не удалось подтвердить отправку отклика #${vid}`, 'SUBMIT_UNCONFIRMED', { vid });
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
    return resolveCurrentVid();
  }

  async function navigateToNextSearchPage(nextBtn, runId) {
    if (!nextBtn) return;
    setActivity('next_page');
    await actionPause();
    if (!isRunCurrent(runId)) return;
    const href = toSearchListUrl(nextBtn.getAttribute?.('href') || nextBtn.href);
    if (href && globalThis.location) {
      setReturnUrl(href);
      leavePage(href);
    } else {
      onPageHide();
      clickElement(nextBtn);
    }
  }

  // --- 14. Main Execution Loop ---
  async function initLoopSession() {
    if (isLoopActive || isNavigating) return null;
    if (Page.isResponseForm() && handlingResponsePage) return null;

    if (activeAbortController) {
      try { activeAbortController.abort(); } catch (_) {}
      activeAbortController = null;
    }

    isLoopActive = true;
    stopSignal = false;
    currentRunId++;
    const runId = currentRunId;
    activeAbortController = new AbortController();

    // The run flag is still set when a page of an ongoing run loads, so this is a
    // resume of the same run, not a new start.
    const isResume = isRunning();
    if (!isResume || !readRunStats()) startRunStats();
    if (!isResume) {
      storage.sessionRemove(KEYS.runVisits);
      storage.sessionRemove(KEYS.runPages);
      storage.sessionRemove(KEYS.noButtonStreak);
      storage.sessionRemove(KEYS.paceState);
    }
    setRunning(true);
    // The run flag lives in sessionStorage. When the browser does not keep it, the run
    // cannot get past one page; it used to hang at "Запуск" with no reason shown.
    if (!isRunning()) {
      terminateRun('STORAGE_BLOCKED', 'Браузер не даёт сайту хранить данные, запуск невозможен.', {}, true);
      return null;
    }
    markProgress();
    const cooldown = paceFactor();
    hhaLog('info', isResume ? 'resume' : 'start', { runId, limit: MAX_DAILY_LIMIT, cooldown: cooldown > 1 ? cooldown : undefined });
    setStatus('running', 'LOOP_STARTING');

    setActivity('locking');
    const acquired = await acquireInstanceLock(TAB_ID);
    if (runId !== currentRunId || stopSignal || !isRunning()) {
      if (acquired) await releaseInstanceLock(TAB_ID);
      isLoopActive = false;
      return null;
    }
    if (!acquired) {
      // An error stop, like the other reasons: the pill, the status line and the tab title
      // name it. As an idle status it was seen only in the error card.
      const isBlocked = storage.isLocalBlocked();
      const code = isBlocked ? 'STORAGE_BLOCKED' : 'TAB_BUSY';
      const msg = isBlocked ? 'Доступ к хранилищу заблокирован.' : 'Другая вкладка уже выполняет отклики. Запуск в текущей вкладке отменен.';
      terminateRun(code, msg, { message: msg }, true);
      return null;
    }
    return runId;
  }

  async function handleResponsePageRoute(runId) {
    if (handlingResponsePage) {
      isLoopActive = false;
      return;
    }
    handlingResponsePage = true;
    setTrapLock(45000, runId);
    const vid = resolveCurrentVid();
    try {
      await submitResponsePage(vid, runId);
    } finally {
      isLoopActive = false;
    }
  }

  async function handleVacancyPageRoute(runId) {
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
      const targetVid = resolveCurrentVid();
      if (Page.isResponseForm() && !handlingResponsePage) {
        handlingResponsePage = true;
        setTrapLock(45000, runId);
        try {
          await submitResponsePage(targetVid, runId);
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
        const targetVid = resolveCurrentVid();
        if (isRunning()) returnToList(targetVid, { markProcessed: true, runId });
      }, 2500);
    }
  }

  function handleArticleOrPromoPage(runId) {
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
  }

  // Returns true once navigation to the vacancy has started.
  async function navigateToVacancyFromSearch(btn, runId) {
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
      reportWarning(`Не удалось определить URL для вакансии #${vid}`, 'VACANCY_URL_NOT_FOUND', { vid });
      recordOutcome(vid, 'error', 'error_selector_missing');
      handleVacancyFailure(vid, 'no_url', runId, { title, employer, salary });
      return false;
    }

    if (!safeTargetUrl) {
      reportWarning(`Вакансия #${vid} ведёт на внешний сайт (${rawTargetUrl}). Сохранена в ручную очередь.`, 'EXTERNAL_VACANCY_URL', { vid, targetUrl: rawTargetUrl });
      saveCurrentForManual(vid, 'queued_external_site', runId, title, employer, salary, rawTargetUrl);
      addToBlacklist(vid, 'external_site');
      markVacancyProcessed(vid, runId);
      return false;
    }

    await breakIfDue();
    if (stopSignal || runId !== currentRunId) return false;
    setLastAttemptID(vid);
    if (globalThis.location) setReturnUrl(globalThis.location.href);
    const pauseMs = vacancyPauseMs();
    hhaLog('info', 'navigate_vacancy', { vid, url: safeTargetUrl, pauseMs });
    setActivity('pause_before_vacancy', { vid, durationMs: pauseMs });
    // The list scrolls to the card, as it does for a person who is about to click it.
    if (PACE.on && card) {
      try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
    }
    await rest(pauseMs);
    if (stopSignal || runId !== currentRunId) return false;
    countRunVisit(vid);
    notePaceOpened();
    leavePage(safeTargetUrl);
    return true;
  }

  async function handleSearchPage(runId) {
    if (globalThis.location) setReturnUrl(globalThis.location.href);
    setActivity('scanning');

    // The known selector only. The text fallback found the first "Откликнуться" on the
    // page, so after a markup change the run went on with one vacancy per page and ended
    // as "Готово" instead of stopping with "Вёрстка" as README says.
    const findApplyButtons = () => qa(SELECTORS.applyBtn);
    let allBtns = findApplyButtons();
    if (!allBtns.length) {
      await waitForCondition(() => stopSignal || runId !== currentRunId || findApplyButtons().length > 0 || q('[data-qa*="empty" i], [class*="empty" i]'), 2000, activeAbortController?.signal);
      if (!stopSignal && runId === currentRunId) allBtns = findApplyButtons();
    }
    if (stopSignal || runId !== currentRunId) return;

    if (!allBtns.length) {
      const cards = qa(SELECTORS.vacancyCard);
      // Cards that already have a response show no apply button. Then the code below finds
      // nothing to open and goes to the next page, or finishes the run on the last one.
      const anyAlreadyApplied = cards.some(c => TEXT_RULES.serpCardApplied.test(textOf(c)));
      if (cards.length > 0 && !anyAlreadyApplied) {
        recordOutcome(null, 'error', 'error_selector_missing');
        if (runId !== currentRunId) return;
        return haltEngine('DOM_SELECTOR_NOT_FOUND', 'В выдаче не нашлась кнопка отклика, автоматизация остановлена.', describeSelectorFailure('applyBtn', cards[0], { cardsCount: cards.length }));
      }
    }

    const visits = readRunVisits();
    // The processed list lives in sessionStorage and starts empty in every new tab, so a
    // vacancy already waiting in the manual queue would be opened again each session.
    const queued = new Set(ManualQueue.get().map(item => cleanVid(item.vid)));
    const applied = getAppliedHistorySet();
    const queuedBefore = queuedHistory.ids();
    const skippedBefore = skippedHistory.ids();
    const targets = [];
    for (const b of allBtns) {
      const vid = getVacancyID(b);
      const clean = cleanVid(vid);
      if (isProcessedID(vid) || isBlacklisted(vid) || queued.has(clean) || applied.has(clean) || queuedBefore.has(clean) || skippedBefore.has(clean)) continue;
      if ((Number(visits[clean]) || 0) >= MAX_VACANCY_ATTEMPTS) {
        hhaLog('warn', 'vacancy_repeat_blocked', { vid, visits: Number(visits[clean]) });
        markVacancyProcessed(vid, runId);
        continue;
      }
      if (config.skipHidden && !isVisible(b)) {
        markVacancyProcessed(vid, runId);
        recordOutcome(vid, 'skipped', 'skip_hidden_employer');
        continue;
      }
      targets.push(b);
    }

    // Not strictly top to bottom: now and then the second or third vacancy comes first.
    if (PACE.on && targets.length > 1) {
      const r = Math.random();
      const i = Math.min(targets.length - 1, r < 0.65 ? 0 : (r < 0.88 ? 1 : 2));
      targets.unshift(targets.splice(i, 1)[0]);
    }
    for (const target of targets) {
      if (await navigateToVacancyFromSearch(target, runId)) return;
      if (stopSignal || runId !== currentRunId) return;
    }

    const nextBtn = query('pagerNext');
    if (nextBtn) {
      const loop = searchPagesGoRound();
      if (loop) return finalizeRun(runId, 'done', `${loop} Всего отправлено: ${getSentCount()}`);
      await navigateToNextSearchPage(nextBtn, runId);
      return;
    }
    const finalSent = getSentCount();
    return finalizeRun(runId, 'done', `Все вакансии в выдаче обработаны. Всего отправлено: ${finalSent}`);
  }

  // The results pages this run left for the next one, by the vacancies on them. A page
  // that comes again (hh.ru shows the last page for every number past the end) means the
  // results go round; the run used to page on forever. hh.ru shows at most 2000 vacancies,
  // so more pages than MAX_RUN_PAGES are a loop as well.
  const MAX_RUN_PAGES = 150;
  function searchPagesGoRound() {
    const ids = qa(SELECTORS.vacancyCard)
      .map((c) => getVacancyIDFromHref(q('a[href*="/vacancy/"]', c)?.href))
      .filter(Boolean);
    if (!ids.length) return '';
    const sig = hashString(ids.sort().join(','));
    const stored = parseJson(storage.sessionGet(KEYS.runPages), []);
    const pages = Array.isArray(stored) ? stored.filter((v) => typeof v === 'string') : [];
    if (pages.includes(sig)) {
      hhaLog('warn', 'search_loop', { page: globalThis.location?.search || '', pages: pages.length });
      return 'Выдача пошла по кругу: страница повторяет уже пройденную.';
    }
    if (pages.length >= MAX_RUN_PAGES) {
      hhaLog('warn', 'search_loop', { page: globalThis.location?.search || '', pages: pages.length });
      return `Пройдено ${MAX_RUN_PAGES} страниц выдачи, дальше hh.ru вакансий не показывает.`;
    }
    pages.push(sig);
    storage.sessionSet(KEYS.runPages, JSON.stringify(pages));
    return '';
  }

  async function processCurrentPage(runId) {
    if (Page.isResponseForm()) {
      await handleResponsePageRoute(runId);
      return;
    }
    if (Page.isVacancy()) {
      await handleVacancyPageRoute(runId);
      return;
    }
    if (Page.isArticle() || isLeadGenRedirect()) {
      handleArticleOrPromoPage(runId);
      return;
    }
    if (!Page.isSearch()) {
      const vid = resolveCurrentVid();
      if (vid) skipVacancy(vid, 'skip_unknown_page', runId);
      returnToList(vid, { markProcessed: true, runId });
      return;
    }
    await handleSearchPage(runId);
  }

  async function startLoop() {
    const runId = await initLoopSession();
    if (!runId) return;

    try {
      if (detectDailyLimit()) return haltForDailyLimit();
      if (detectRateLimit()) return haltForRateLimit();
      if (detectCaptcha()) return haltForCaptcha();

      await processCurrentPage(runId);
    } catch (e) {
      finalizeRun(runId, 'error', `Сбой основного цикла: ${(e && e.message) || e}`);
    }
  }
  // --- 15. Watchdog & Recovery ---
  function checkRateLimitAnomaly(doc, bodyText) {
    if (detectInaccessibleVacancy(doc, bodyText)) {
      // Already leaving the page: without this the skip is recorded on every tick.
      if (isNavigating) return true;
      const vid = resolveCurrentVid();
      if (vid) skipVacancy(vid, 'skip_inaccessible', currentRunId);
      returnToList(vid, { markProcessed: true, runId: currentRunId });
      return true;
    }
    if (detectCaptcha(doc, bodyText)) { haltForCaptcha(); return true; }
    if (detectRateLimit(doc, bodyText)) { haltForRateLimit(); return true; }
    return false;
  }

  function checkHang(now) {
    // A break or a long pause: nothing to wait for, and nothing hangs.
    if (restingUntil > now) {
      lastProgressTs = now;
      return false;
    }
    if ((now - lastProgressTs) > WATCHDOG_STALL_TIMEOUT) {
      const currentVid = cleanVid(resolveCurrentVid() || '');
      // With no vacancy in flight (a search page) the count is kept per page address,
      // otherwise it starts over after every reload and the run never gives up.
      const stallKey = currentVid || `page:${globalThis.location?.pathname || ''}${globalThis.location?.search || ''}`;
      const storedKey = cleanVid(storage.sessionGet(KEYS.watchdogStallVid) || '');
      let stallCount = storedKey === stallKey ? toNum(storage.sessionGet(KEYS.watchdogStallCount), 0) : 0;
      const elapsedMs = now - lastProgressTs;

      if (stallCount < 2) {
        stallCount++;
        storage.sessionSet(KEYS.watchdogStallVid, stallKey);
        storage.sessionSet(KEYS.watchdogStallCount, String(stallCount));
        lastProgressTs = now;
        hhaLog('warn', 'watchdog_stall', { vid: currentVid || undefined, stallCount, elapsedMs });
        try { leavePage(); } catch (e) {
          hhaLog('warn', 'watchdog_reload_failed', { error: String(e && e.message || e) });
        }
        return true;
      } else {
        storage.sessionRemove(KEYS.watchdogStallVid);
        storage.sessionRemove(KEYS.watchdogStallCount);
        hhaLog('error', 'watchdog_giveup', { vid: currentVid || undefined, stallCount, elapsedMs });
        recordOutcome(currentVid, 'error', 'error_timeout');
        terminateRun('WATCHDOG_GIVEUP', 'Страница не отвечала и после двух перезагрузок, автоматизация остановлена.', { vid: currentVid || undefined }, true);
        return true;
      }
    }

    if (handlingResponsePage || (isLoopActive && Page.isResponseForm())) return false;

    if (!Page.isSearch() && !isNavigating && (now - lastProgressTs) > PAGE_WATCHDOG_TIMEOUT) {
      const vid = resolveCurrentVid();
      reportWarning(`Страница не ответила за ${PAGE_WATCHDOG_TIMEOUT / 1000} секунд. Принудительный возврат к поиску.`, 'PAGE_HANG_TIMEOUT', { vid, url: globalThis.location?.href });
      markProgress();
      handleVacancyFailure(vid, 'error_timeout', currentRunId);
      return true;
    }
    return false;
  }

  function watchdogTick() {
    if (!isRunning()) return;
    if (detectDailyLimit()) return haltForDailyLimit();

    const doc = globalThis.document;
    const bodyText = textOf(doc?.body).slice(0, 4000);

    if (checkRateLimitAnomaly(doc, bodyText)) return;
    // Until the lock is acquired there is nothing to lose: a busy lock is reported
    // by initLoopSession as TAB_BUSY, not as a lost lock.
    if (!isLoopActive || isNavigating || resumeTimer || !instanceLeaseVerified) return;
    if (touchInstanceLock(TAB_ID) !== 'OWNED') return haltForLostInstanceLock();

    if (checkHang(Date.now())) return;

    if (Page.isArticle() || isLeadGenRedirect()) {
      if (!isNavigating) {
        const vid = getLeadGenRedirectVacancyId();
        const currentUrl = globalThis.location?.href || '';
        if (vid) {
          saveCurrentForManual(vid, 'queued_promo', currentRunId, '', '', '', currentUrl);
          markVacancyProcessed(vid, currentRunId);
        }
        returnToList(vid, { markProcessed: true, runId: currentRunId });
      }
      return;
    }

    if (!Page.isResponseForm()) {
      clearTrapLock();
      handlingResponsePage = false;
    }
  }
  let watchdogIntervalId = null;

  function addGlobalListener(target, type, handler, options) {
    if (!target?.addEventListener) return;
    try {
      target.addEventListener(type, handler, options);
    } catch (e) {
      hhaLog('warn', 'add_global_listener_failed', { type, error: String(e && e.message || e) });
    }
  }

  // How long a run spent in a background tab. The start time lives in sessionStorage,
  // because every vacancy is a new page: one pair of entries covers the whole stay in the
  // background, however many pages were loaded meanwhile.
  function watchBackgroundTime() {
    const doc = globalThis.document;
    if (!doc) return;
    const markHidden = (since = Date.now()) => {
      if (!doc.hidden || !isRunning() || storage.sessionGet(KEYS.hiddenSince)) return;
      storage.sessionSet(KEYS.hiddenSince, String(since));
      hhaLog('info', 'tab_hidden');
      flushLogBuffer();
    };
    if (doc.hidden) markHidden();
    addGlobalListener(doc, 'visibilitychange', () => {
      // Leaving the page for the next vacancy also turns it hidden. Such a page is gone
      // a second later and its timer never fires; a tab really sent to the background is
      // still there. The wait also drops a glance at another window shorter than a
      // second. If the page leaves meanwhile, the next one loads hidden and is marked above.
      if (doc.hidden) {
        const at = Date.now();
        return void setTimeout(() => markHidden(at), 1000);
      }
      const since = toNum(storage.sessionGet(KEYS.hiddenSince), 0);
      if (!since) return;
      storage.sessionRemove(KEYS.hiddenSince);
      hhaLog('info', 'tab_visible', { hiddenMs: Date.now() - since });
    });
    // Chrome may freeze a background tab to save power; nothing runs until it resumes.
    // A page left for the next one is frozen too, into the back-forward cache, right
    // after pagehide: that freeze is not logged.
    let frozenAt = 0;
    let leaving = false;
    addGlobalListener(globalThis.window, 'pagehide', () => { leaving = true; });
    addGlobalListener(globalThis.window, 'pageshow', () => { leaving = false; });
    addGlobalListener(doc, 'freeze', () => {
      if (leaving || !isRunning()) return;
      frozenAt = Date.now();
      hhaLog('warn', 'page_frozen');
      flushLogBuffer();
    });
    addGlobalListener(doc, 'resume', () => {
      if (!frozenAt) return;
      hhaLog('warn', 'page_resumed', { frozenMs: Date.now() - frozenAt });
      frozenAt = 0;
    });
  }

  function resetSessionCounters() {
    storage.sessionRemove(KEYS.sessionProcessedTotal);
    storage.sessionRemove(KEYS.sessionAnomalousSkips);
    storage.sessionRemove(KEYS.skipAlertShown);
  }

  // --- 16. Engine API ---
  // The full interface is for the HUD only and stays inside the script. Page scripts of
  // hh.ru share the window with this one (@grant none), so the global object below gets
  // only what is needed from the console.
  const engine = {
    start: () => startLoop(),
    stop: (code = 'STOPPED_BY_USER', reason = '') => terminateRun(code, reason || (code === 'STOPPED_BY_USER' ? 'Automation stopped by user' : code), {}, false),
    getState: () => ({
      version: VERSION,
      tabId: TAB_ID,
      isRunning: isRunning(),
      runId: currentRunId,
      status: currentStatus.statusKey,
      statusCode: currentStatus.code,
      statusDetails: currentStatus.details,
      activity: currentActivity,
      sentCount: getSentCount(),
      hasInstanceLock: instanceLeaseVerified,
      hasTrapLock: Boolean(getActiveTrapLock()),
      lastRun: parseJson(storage.sessionGet(KEYS.lastRun), null),
      lastAttemptId: getLastAttemptID(),
      returnUrl: getReturnUrl(),
      // cooldown is 1.5 or 2 for 12 hours after a captcha: every pause is that much longer.
      pace: { on: PACE.on, cooldown: paceFactor(), ...readPaceState() }
    }),
    getConfig: () => ({ ...config }),
    setConfig: (p) => persistSettings(p),
    // What the letter variables would get now: on a vacancy page its own names, on the
    // search page the last vacancy this tab opened.
    getLetterValues: () => letterValues((Page.isVacancy() && getStableVacancyId()) || resolveCurrentVid()),
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
      // The search address stays: Продолжить after a stop on a vacancy page went back to
      // /search/vacancy without the user's filters and went on with every vacancy there.
      clearPendingVacancyMeta();
      resetSessionCounters();
      setActivity(null);
      setStatus('idle', 'IDLE');
      flushLogBuffer();
      flushStorageCaches();
      return true;
    },
    getManualQueue: () => ManualQueue.get(),
    markManualItemViewed: (vid, viewed) => ManualQueue.markViewed(vid, viewed),
    removeManualItem: (vid) => ManualQueue.remove(vid),
    restoreManualItem: (item) => ManualQueue.add(item),
    clearManualQueue: () => ManualQueue.clear(),
    on: (evt, fn) => events.on(evt, fn),
    off: (evt, fn) => events.off(evt, fn),
    dumpLog: () => hhaDumpLog(),
    // The first entry after a clear says so, or a log sent later would seem cut off.
    clearLog: () => {
      hhaClearLog();
      hhaLog('info', 'log_cleared', { version: VERSION });
      return true;
    }
  };

  const publicApi = Object.freeze({
    start: () => engine.start(),
    stop: () => engine.stop(),
    getState: () => engine.getState(),
    getManualQueue: () => engine.getManualQueue(),
    on: (evt, fn) => engine.on(evt, fn),
    off: (evt, fn) => engine.off(evt, fn),
    hhaDumpLog: () => hhaDumpLog(),
    hhaClearLog: () => hhaClearLog()
  });

  // --- 17. Bootstrap & Global Binding ---
  function bootstrap() {
    if (watchdogIntervalId === null) {
      let lastTickTs = Date.now();
      let lastDateKey = getLocalDateKey();
      watchdogIntervalId = setInterval(() => {
        const now = Date.now();
        const gap = now - lastTickTs;
        // Logged before the tick, so a stall reload right after a sleep shows its cause.
        if (gap > TIMER_GAP_MS && isRunning()) {
          hhaLog('warn', 'timer_gap', { gapMs: gap, hidden: Boolean(globalThis.document?.hidden) });
        }
        // A tick seconds late means no timer of the page ran meanwhile: a background tab
        // that Chrome throttles to one timer a minute, or a sleep. The run's own waits were
        // just as late, so that time is not a hang: counted as one, it failed vacancies in a
        // background tab and sent them to the queue.
        if (gap > TICK_LATE_MS) markProgress();
        lastTickTs = now;
        // The counter is per day: at midnight the HUD shows the new day's count at once.
        const dateKey = getLocalDateKey();
        if (dateKey !== lastDateKey) {
          lastDateKey = dateKey;
          emitProgress();
        }
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
    markProgress();

    if (isRunning()) {
      if (detectDailyLimit()) {
        haltForDailyLimit();
        return;
      }
      const nav = globalThis.navigator;
      if (!nav?.locks?.request) {
        const lock = readInstanceLock();
        const now = Date.now();
        if (lock && isLiveLock(lock, now) && lock.tabId !== TAB_ID) {
          setRunning(false);
          setStatus('error', 'TAB_BUSY', { message: 'Другая вкладка уже активна' });
          reportError('Другая вкладка уже выполняет отклики. Запуск в текущей вкладке отменен.', 'TAB_BUSY');
          return;
        }
      }
      setStatus('running', 'AUTO_STARTING');
      // A person does not act the same 1.5 s after every page load.
      const resumeMs = PACE.on ? randIn(PACE.resumeMs) : 1500;
      setActivity('resuming', { durationMs: resumeMs });
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        if (isRunning()) startLoop();
      }, resumeMs);
    }
    if (!Page.isResponseForm()) clearTrapLock();
    // Stopped while waiting for hh.ru, then reloaded: the response may show up now.
    if (!isRunning()) {
      const pending = readInflight();
      if (pending) watchLateResponse(pending);
    }

    // A vacancy from the manual queue: mark it viewed, and take it off the queue once
    // the page shows a response. A run in this tab skips queued vacancies by itself.
    if (Page.isVacancy() || Page.isResponseForm()) {
      const currentVid = getStableVacancyId() || getLastAttemptID();
      if (currentVid && ManualQueue.has(currentVid)) {
        ManualQueue.markViewed(currentVid, true);
        if (!isRunning()) watchManualResponse(currentVid);
      }
    }

    const win = globalThis.window;
    if (win) {
      win.hhaDumpLog = hhaDumpLog;
      win.hhaClearLog = hhaClearLog;
    }
    if (typeof globalThis.hhaDumpLog === 'undefined') globalThis.hhaDumpLog = hhaDumpLog;
    if (typeof globalThis.hhaClearLog === 'undefined') globalThis.hhaClearLog = hhaClearLog;
  }

  const doc = globalThis.document;
  if (doc?.body) {
    bootstrap();
  }

  const win = globalThis.window;
  if (win && typeof win.addEventListener === 'function') {
    // An error is this script's when its stack goes through this script's file. Names of
    // functions like queryAll or startLoop also turned up in errors of the page and of
    // other extensions, and the HUD showed them as its own failure.
    function isUserscriptOrigin(filename, stack) {
      if (!filename && !stack) return false;
      const combined = `${filename || ''}\n${stack || ''}`;
      if (OWN_SCRIPT_URL && combined.includes(OWN_SCRIPT_URL)) return true;
      return /hh-apply-assistant|HHApplyAssistant|HhaHudElement/.test(combined);
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
      try { watchdogTick(); } catch (e) {
        hhaLog('debug', 'popstate_watchdog_error', { error: String(e && e.message || e) });
      }
    });
    addGlobalListener(win, 'beforeunload', () => {
      if (!isRunning()) releaseInstanceLock(TAB_ID);
    });
    watchBackgroundTime();
    // The queue and the counters are shared by all hh.ru tabs: a vacancy answered in
    // another tab updates the HUD here without a reload.
    addGlobalListener(win, 'storage', (e) => {
      if (e.key === KEYS.manualList) {
        events.emit('manualQueue', { action: 'sync', queue: ManualQueue.get() });
      } else if (e.key === KEYS.dailyCounters) {
        const cur = getSentCount();
        events.emit('progress', {
          sent: cur,
          percentage: Math.min(100, Math.round((cur / MAX_DAILY_LIMIT) * 100))
        });
      }
    });
  }

  hhaEngine = engine;
  globalThis.HHApplyAssistant = publicApi;
})();

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

(function () {
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

  const ERROR_TITLES = {
    GLOBAL_UNCAUGHT_ERROR: 'Внутренний сбой интерфейса',
    GLOBAL_UNHANDLED_REJECTION: 'Сбой асинхронной операции',
    DOM_SELECTOR_NOT_FOUND: 'Элемент страницы не найден',
    SUBMIT_BTN_NOT_FOUND: 'Кнопка отправки не найдена',
    SUBMIT_BTN_STILL_DISABLED: 'Кнопка отправки неактивна',
    ATTACH_BTN_NOT_FOUND: 'Кнопка прикрепления письма не найдена',
    LETTER_FORM_TIMEOUT: 'Форма письма не открылась вовремя',
    RELOCATION_LOOP_GUARD: 'Зацикливание предупреждения о релокации',
    RELOCATION_TIMEOUT: 'Таймаут подтверждения релокации',
    RELOCATION_BTN_NOT_FOUND: 'Кнопка релокации не найдена',
    NO_APPLY_BUTTON: 'Кнопка отклика недоступна',
    OUTCOME_TIMEOUT: 'Превышено время ожидания отклика',
    VACANCY_PAGE_ERROR: 'Ошибка на странице вакансии',
    SUBMIT_FAILED: 'Сбой при отправке отклика',
    SUBMIT_UNCONFIRMED: 'Отправка отклика не подтвердилась',
    RESPONSE_PAGE_ERROR: 'Сбой на странице отклика',
    STORAGE_BLOCKED: 'Доступ к хранилищу заблокирован',
    STORAGE_FULL: 'Хранилище браузера переполнено',
    APPLY_BUTTON_NOT_FOUND: 'Кнопка отклика не найдена на вакансиях',
    TAB_BUSY: 'Скрипт уже запущен в другой вкладке',
    TAB_LOCK_LOST: 'Потеряна блокировка вкладки',
    VACANCY_URL_NOT_FOUND: 'Не удалось определить ссылку вакансии',
    MAX_ATTEMPTS_EXCEEDED: 'Превышен лимит попыток отклика',
    VACANCY_ATTEMPT_FAILED: 'Сбой отклика (повторим позже)',
    PAGE_HANG_TIMEOUT: 'Страница вакансии зависла',
    EXTERNAL_VACANCY_URL: 'Вакансия ведёт на внешний сайт',
    CAPTCHA_DETECTED: 'Обнаружена капча: решите её вручную',
    RATE_LIMITED: 'Слишком частые запросы (Rate Limit)',
    SKIP_RATE_ALERT: 'Аномально много пропусков вакансий',
    WATCHDOG_GIVEUP: 'Страница перестала отвечать',
  };

  const REPORT_HINT = 'Если ошибка повторяется, скопируйте отчёт и приложите его к issue на GitHub.';
  const LETTER_HINT = 'Отклики продолжают отправляться, но без письма. ' + REPORT_HINT;
  const ERROR_HINTS = {
    CAPTCHA_DETECTED: 'Решите капчу на странице, затем нажмите кнопку Продолжить.',
    RATE_LIMITED: 'Подождите 10-15 минут, затем нажмите кнопку Продолжить.',
    TAB_BUSY: 'Остановите скрипт в другой вкладке или закройте её.',
    TAB_LOCK_LOST: 'Проверьте, что скрипт не запущен в другой вкладке, затем нажмите кнопку Продолжить.',
    STORAGE_BLOCKED: 'Разрешите сайту hh.ru сохранять данные (cookies и данные сайтов) и обновите страницу.',
    WATCHDOG_GIVEUP: 'Обновите страницу и нажмите кнопку Продолжить. ' + REPORT_HINT,
    DOM_SELECTOR_NOT_FOUND: 'Скорее всего, hh.ru поменял вёрстку. Скопируйте отчёт и приложите его к issue на GitHub.',
    APPLY_BUTTON_NOT_FOUND: 'Скорее всего, hh.ru поменял вёрстку страницы вакансии. Эти вакансии не остались в очереди, следующий запуск откроет их снова. Скопируйте отчёт и приложите его к issue на GitHub.',
    STORAGE_FULL: 'Освободите место: очистите лог кнопкой Очистить внизу панели и нажмите Продолжить. Если не помогло, удалите в браузере данные других сайтов.',
    ATTACH_BTN_NOT_FOUND: LETTER_HINT,
    LETTER_FORM_TIMEOUT: LETTER_HINT,
    SUBMIT_BTN_NOT_FOUND: LETTER_HINT,
    SKIP_RATE_ALERT: 'Проверьте фильтры поиска. Если вакансии пропускаются зря, скопируйте отчёт и приложите его к issue на GitHub.',
  };

  // Why a run stopped with an error: one word for the pill and the tab title,
  // a short phrase for the panel header. Codes not listed here get the default.
  const STOP_REASONS = {
    CAPTCHA_DETECTED: { short: 'Капча', line: 'Остановлено: капча' },
    RATE_LIMITED: { short: 'Доступ', line: 'Остановлено: hh.ru ограничил доступ' },
    WATCHDOG_GIVEUP: { short: 'Зависла', line: 'Остановлено: страница не отвечает' },
    DOM_SELECTOR_NOT_FOUND: { short: 'Вёрстка', line: 'Остановлено: в выдаче нет кнопки отклика' },
    APPLY_BUTTON_NOT_FOUND: { short: 'Вёрстка', line: 'Остановлено: на вакансиях нет кнопки отклика' },
    TAB_LOCK_LOST: { short: 'Вкладка', line: 'Остановлено: работает другая вкладка' },
    TAB_BUSY: { short: 'Вкладка', line: 'Остановлено: работает другая вкладка' },
    STORAGE_BLOCKED: { short: 'Хранилище', line: 'Остановлено: хранилище недоступно' },
    STORAGE_FULL: { short: 'Хранилище', line: 'Остановлено: хранилище переполнено' },
  };
  const STOP_REASON_DEFAULT = { short: 'Сбой', line: 'Остановлено из-за ошибки' };

  const ACTIVITY_TEXT = {
    resuming: 'Продолжаю на новой странице',
    locking: 'Проверяю, не запущен ли скрипт в другой вкладке',
    scanning: 'Ищу следующую вакансию в выдаче',
    pause_before_vacancy: 'Пауза перед вакансией',
    reading: 'Читаю вакансию',
    applying: 'Нажимаю Откликнуться',
    waiting_outcome: 'Жду ответа hh.ru',
    relocation: 'Подтверждаю релокацию',
    submitting: 'Отправляю отклик',
    attaching_letter: 'Прикрепляю письмо',
    returning: 'Возвращаюсь в поиск',
    next_page: 'Перехожу на следующую страницу',
    break: 'Перерыв между вакансиями',
  };

  // One-word versions for the collapsed pill; the full text is in its tooltip.
  const ACTIVITY_SHORT = {
    resuming: 'Загрузка',
    locking: 'Запуск',
    scanning: 'Поиск',
    pause_before_vacancy: 'Пауза',
    reading: 'Читаю',
    applying: 'Отклик',
    waiting_outcome: 'Жду hh.ru',
    relocation: 'Релокация',
    submitting: 'Отправка',
    attaching_letter: 'Письмо',
    returning: 'В поиск',
    next_page: 'Дальше',
    break: 'Отдых',
  };

  function parseErrorDetails(code, rawMessage) {
    const defaultTitle = ERROR_TITLES[code] || 'Произошла ошибка при выполнении';
    let cleanMsg = String(rawMessage || '').trim();
    cleanMsg = cleanMsg.replace(/^\[(?:Глобальная ошибка|Необработанный Promise rejection)\]\s*/i, '');
    cleanMsg = cleanMsg.replace(/\s*\([^)]*(?:userscript\.html|chrome-extension:)[^)]*\)\s*$/i, '');
    cleanMsg = cleanMsg.replace(/^Uncaught\s+/i, '');
    cleanMsg = cleanMsg.replace(/^ReferenceError:\s*/i, 'Сбой выполнения: ');
    cleanMsg = cleanMsg.replace(/^TypeError:\s*/i, 'Ошибка типа данных: ');
    cleanMsg = collapseSpaces(cleanMsg);

    let title = defaultTitle;
    let desc = '';

    if (!cleanMsg || cleanMsg === defaultTitle || cleanMsg.toUpperCase() === String(code || '').toUpperCase()) {
      return { title, desc: '' };
    }

    if (cleanMsg.toLowerCase().startsWith(defaultTitle.toLowerCase())) {
      desc = cleanMsg.slice(defaultTitle.length).replace(/^[\s:\u2013\u2014-]+/, '').trim();
    } else {
      desc = cleanMsg;
    }

    return { title, desc };
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

  // The saved url goes first: for a promo page it is the only working link, while
  // the id there can be an article number or a hash of the card text.
  function toVacancyUrl(vid, url) {
    if (url && !url.includes('/applicant/vacancy_response')) return url;
    const clean = cleanVid(vid);
    const origin = globalThis.location?.origin || 'https://hh.ru';
    return /^\d+$/.test(clean) ? `${origin}/vacancy/${clean}` : (url || '');
  }

  // --- 2. SVG Icons ---

  const ICONS = {
    close: (size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`,
    // The counter icons are drawn on a 14x14 pixel grid: at 100% scale every stroke is
    // exactly two device pixels, so they stay sharp on a Full HD monitor.
    send: `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M1 1.5 13.5 7 1 12.5 3 7z"/></svg>`,
    list: `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true"><rect x="1" y="2" width="2" height="2"/><rect x="5" y="2" width="8" height="2"/><rect x="1" y="6" width="2" height="2"/><rect x="5" y="6" width="8" height="2"/><rect x="1" y="10" width="2" height="2"/><rect x="5" y="10" width="8" height="2"/></svg>`,
    copy: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`,
    trash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM8 9h8v10H8V9zm7.5-5-1-1h-5l-1 1H5v2h14V4z"/></svg>`,
    inboxEmpty: `<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v3.01c0 .72.43 1.34 1.04 1.63L3 20c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2l-.04-11.36c.61-.29 1.04-.91 1.04-1.63V4c0-1.1-.9-2-2-2zm-1 18H5l.04-11H19l-.04 11zM19 7H5V4h14v3zm-3 5H8v-2h8v2z"/></svg>`
  };

  // The ring of the round Стоп (see .hha-btn-sweep in the stylesheet).
  const BTN_SWEEP = '<svg class="hha-btn-sweep" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><circle class="hha-ring-track" cx="16" cy="16" r="15"></circle><circle class="hha-ring-arc" cx="16" cy="16" r="15" pathLength="100" transform="rotate(-90 16 16)"></circle></svg>';

  // --- 3. Shadow DOM Stylesheet ---

  const STYLES = `
    /* Design Tokens */
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

      /* Color System */
      --md-sys-color-primary: #006A60;
      --md-sys-color-on-primary: #FFFFFF;
      --md-sys-color-primary-container: #BCECE3;
      --md-sys-color-on-primary-container: #00201D;
      --md-sys-color-secondary-container: #CCE8E2;
      --md-sys-color-tertiary-container: #CCE5FF;
      --md-sys-color-on-tertiary-container: #001D31;

      --md-sys-color-error: #BA1A1A;
      --md-sys-color-on-error: #FFFFFF;
      --md-sys-color-error-container: #FFDAD6;
      --md-sys-color-on-error-container: #410002;
      --md-sys-color-surface: #FAFDFB;
      --md-sys-color-on-surface: #191C1B;
      --md-sys-color-on-surface-variant: #3F4946;

      --md-sys-color-outline: #66706D;
      --md-sys-color-outline-variant: #E2E7E5;

      /* Surface Colors */
      --md-sys-color-surface-container-lowest: #FFFFFF;
      --md-sys-color-surface-container-low: #F6F8F7;
      --md-sys-color-surface-container: #F0F4F2;
      --md-sys-color-surface-container-high: #EEF1EF;
      --md-sys-color-surface-container-highest: #E4E8E6;

      --md-sys-color-inverse-surface: #2E3130;
      --md-sys-color-inverse-on-surface: #EFF1EF;

      /* Shape Scale */
      --md-sys-shape-corner-extra-small: 4px;
      --md-sys-shape-corner-small: 8px;
      --md-sys-shape-corner-medium: 12px;
      --md-sys-shape-corner-extra-large: 22px;
      --md-sys-shape-corner-full: 9999px;

      /* Elevation */
      --md-sys-elevation-level1: 0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.04);
      --md-sys-elevation-level2: 0 4px 14px -1px rgba(0, 0, 0, 0.07), 0 2px 5px -1px rgba(0, 0, 0, 0.04);
      --md-sys-elevation-level3: 0 12px 28px -4px rgba(0, 0, 0, 0.08), 0 4px 10px -2px rgba(0, 0, 0, 0.03);
      /* Quick button shadows: the same three-part list in every state, so they interpolate. */
      --hha-btn-shadow-raised: 0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.04), inset 0 0 0 1px transparent;
      --hha-btn-shadow-hover: 0 4px 14px -1px rgba(0, 0, 0, 0.07), 0 2px 5px -1px rgba(0, 0, 0, 0.04), inset 0 0 0 1px transparent;
      --hha-btn-shadow-flat: 0 1px 3px transparent, 0 1px 2px transparent, inset 0 0 0 1px transparent;

      /* State Layer Opacities */
      --md-sys-state-hover: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);

      /* Typography Scale */
      --md-sys-typescale-font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;

      --md-sys-typescale-body-medium-size: 13px;
      --md-sys-typescale-body-medium-line-height: 18px;
      --md-sys-typescale-body-medium-tracking: -0.05px;

      --md-sys-typescale-body-small-size: 12px;
      --md-sys-typescale-body-small-line-height: 16px;

      --md-sys-typescale-label-large-size: 14px;
      --md-sys-typescale-label-large-weight: 600;

      --md-sys-typescale-label-medium-size: 12px;
      --md-sys-typescale-label-medium-weight: 600;
      --md-sys-typescale-label-medium-tracking: -0.05px;

      --md-sys-typescale-label-small-size: 11px;

      /* Control Height (Compact Standard) */
      --md-comp-control-height: 32px;

      /* Motion: Easing */
      --md-sys-motion-easing-standard: cubic-bezier(0.2, 0, 0, 1);
      --md-sys-motion-easing-emphasized-decelerate: cubic-bezier(0.05, 0.7, 0.1, 1);

      /* Motion: Duration */
      --md-sys-motion-duration-short2: 100ms;
      --md-sys-motion-duration-short3: 150ms;
      --md-sys-motion-duration-short4: 200ms;
      --md-sys-motion-duration-medium1: 250ms;
      --md-sys-motion-duration-medium2: 300ms;
      --md-sys-motion-duration-medium4: 400ms;

      /* HUD Motion Specification */
      --hha-motion-expand-duration: 500ms;
      --hha-motion-spring-easing: cubic-bezier(0.34, 1.15, 0.64, 1);
      /* Leaving is quicker than arriving and accelerates out, with no spring: the panel
         does not linger after Esc or the close button. */
      --hha-motion-collapse-duration: 260ms;
      --hha-motion-collapse-easing: cubic-bezier(0.3, 0, 0.8, 0.15);
      --hha-motion-tab-duration: 200ms;
      --hha-motion-tab-easing: cubic-bezier(0.2, 0, 0, 1);
      --hha-motion-indicator-duration: 250ms;
      --hha-motion-indicator-easing: cubic-bezier(0.2, 0, 0, 1);

      /* Centralized Layout Padding Token */
      --hha-content-padding-x: 12px;

      /* Layout Tokens */
      --pill-width: 166px;
      --flyout-width: min(390px, calc(100vw - 16px));
      --shared-counter-offset: calc((var(--flyout-width, 390px) - var(--pill-width, 166px)) / 2 - var(--hha-content-padding-x, 12px));
      --shared-btn-offset: calc(-1 * var(--shared-counter-offset));
    }

    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    /* 2. Root Positioning */
    .hha-root {
      position: fixed;
      left: 0;
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
      transition: transform 240ms cubic-bezier(0.05, 0.7, 0.1, 1) !important;
    }

    .hha-root.dir-up {
      place-items: end center;
    }

    /* 3. Pill */
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
      user-select: none;
      -webkit-user-select: none;
      -webkit-user-drag: none;
      white-space: nowrap;
      position: relative;
      z-index: 2;
      opacity: 1;
      visibility: visible;
      transform: scale(1) translate3d(0, 0, 0);
      transform-origin: center bottom;
      will-change: transform, opacity;
      transition:
        opacity 180ms ease-out 90ms,
        transform 320ms var(--md-sys-motion-easing-emphasized-decelerate) 40ms,
        visibility 0s linear 0s,
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
      transform: scale(0.92) translate3d(0, 12px, 0);
      transition:
        opacity 110ms linear 0s,
        transform 300ms var(--md-sys-motion-easing-standard),
        visibility 0s linear 110ms;
    }

    .hha-pill-status-group {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      /* A click here opens the panel; dragging still works, the hand shows while it does. */
      cursor: pointer;
      user-select: none;
      position: relative;
      overflow: hidden;
      isolation: isolate;
      border-radius: var(--md-sys-shape-corner-full);
      height: var(--md-comp-control-height);
      min-height: var(--md-comp-control-height);
      padding: 0 10px 0 12px;
      background: var(--md-sys-color-surface-container-high);
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
      background: var(--md-sys-color-surface-container-highest);
    }

    .hha-pill-status-group:active {
      background: var(--md-sys-color-surface-container-highest);
    }

    .hha-root.is-dragging .hha-pill-status-group {
      background: var(--md-sys-color-surface-container-highest);
      cursor: grabbing;
    }

    /* Sized to the text; _setPillStepText() animates between measured widths.
       The countdown keeps the width thanks to tabular digits. */
    .hha-pill-step {
      display: inline-block;
      width: 0;
      max-width: 96px;
      margin-left: -6px;
      opacity: 0;
      transition:
        width 280ms var(--md-sys-motion-easing-standard),
        margin-left 280ms var(--md-sys-motion-easing-standard),
        opacity 160ms var(--md-sys-motion-easing-standard);
      font-size: var(--md-sys-typescale-label-medium-size);
      font-weight: 500;
      line-height: var(--md-comp-control-height);
      color: var(--md-sys-color-on-surface-variant);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-variant-numeric: tabular-nums;
      pointer-events: none;
    }

    .hha-root.is-running .hha-pill-step,
    .hha-root.is-stopped-error .hha-pill-step {
      margin-left: 0;
      opacity: 1;
      transition:
        width 280ms var(--md-sys-motion-easing-standard),
        margin-left 280ms var(--md-sys-motion-easing-standard),
        opacity 200ms var(--md-sys-motion-easing-standard) 80ms;
    }

    /* Wide enough for the longest step while running ("Загрузка 2 с", about 68px): the
       pill keeps one width for the whole run and Стоп does not move under the pointer. */
    .hha-root.is-running .hha-pill-step {
      width: 72px;
      text-align: center;
    }

    .hha-root.is-stopped-error .hha-pill-step {
      color: var(--md-sys-color-error);
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
      padding: 0 4px;
      border-radius: 0;
      overflow: visible;
      z-index: 2;
      border: none;
      cursor: pointer;
      user-select: none;
    }

    .hha-pill-progress {
      font-size: var(--md-sys-typescale-label-medium-size);
      font-weight: var(--md-sys-typescale-label-medium-weight);
      letter-spacing: var(--md-sys-typescale-label-medium-tracking);
      color: var(--md-sys-color-on-surface-variant);
      font-variant-numeric: tabular-nums;
      position: relative;
      z-index: 2;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .hha-current-count {
      font-weight: 700;
      color: var(--md-sys-color-primary);
      transition: color var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-standard);
    }

    .hha-count-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .hha-count-item + .hha-count-item {
      margin-left: 8px;
    }

    .hha-count-item svg {
      flex-shrink: 0;
    }

    .hha-count-item.is-sent {
      color: var(--md-sys-color-primary);
    }

    .hha-count-item.is-queue {
      color: var(--md-sys-color-on-surface-variant);
    }

    .hha-queue-count {
      font-weight: 700;
      color: var(--md-sys-color-on-surface);
      transition: color var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-standard);
    }

    .hha-pill-status-group.has-error .hha-current-count,
    .hha-pill-status-group.has-error .hha-count-item.is-sent {
      color: var(--md-sys-color-error);
    }

    /* 4. Quick Action Button */
    .hha-btn-start,
    .hha-btn-stop,
    .hha-btn-done,
    .hha-btn-limit,
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
        width 280ms var(--md-sys-motion-easing-standard),
        min-width 280ms var(--md-sys-motion-easing-standard),
        max-width 280ms var(--md-sys-motion-easing-standard),
        flex-basis 280ms var(--md-sys-motion-easing-standard),
        background-color 180ms var(--md-sys-motion-easing-standard),
        color 180ms var(--md-sys-motion-easing-standard),
        box-shadow 180ms var(--md-sys-motion-easing-standard),
        transform var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
    }

    .hha-btn-label {
      position: relative;
      z-index: 1;
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
      transition:
        transform 110ms var(--md-sys-motion-easing-standard),
        opacity 110ms var(--md-sys-motion-easing-standard);
    }

    .hha-pill .hha-btn-quick {
      opacity: 1;
      transition:
        width 280ms var(--md-sys-motion-easing-standard),
        min-width 280ms var(--md-sys-motion-easing-standard),
        max-width 280ms var(--md-sys-motion-easing-standard),
        flex-basis 280ms var(--md-sys-motion-easing-standard),
        opacity 140ms ease-out 60ms,
        background-color 180ms var(--md-sys-motion-easing-standard),
        color 180ms var(--md-sys-motion-easing-standard),
        box-shadow 180ms var(--md-sys-motion-easing-standard),
        transform var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
    }

    .hha-root.is-expanded .hha-pill .hha-btn-quick {
      opacity: 0;
      transition: opacity 50ms ease-out 0s;
    }

    /* Filled Button for Start (Primary Role) */
    .hha-btn-start {
      background: var(--md-sys-color-primary);
      color: var(--md-sys-color-on-primary);
      box-shadow: var(--hha-btn-shadow-raised);
    }

    .hha-btn-start:hover {
      background: color-mix(in srgb, var(--md-sys-color-primary) 92%, var(--md-sys-color-on-primary));
      box-shadow: var(--hha-btn-shadow-hover);
      color: var(--md-sys-color-on-primary);
    }

    .hha-btn-start:active {
      background: color-mix(in srgb, var(--md-sys-color-primary) 88%, var(--md-sys-color-on-primary));
      box-shadow: var(--hha-btn-shadow-raised);
      transform: scale(0.97);
    }

    /* Стоп while a run goes: a round button with a stop square and a ring round it, on the
       same grey as the counters. A run is a process, and the ring reads as one: a short teal
       arc goes round a faint track, one lap in 2.4 s. The word is kept for screen readers and
       for the title, the square says it to the eye. Under the pointer the button turns red and
       the ring gives way to it: red is kept for stopping and for an error stop. The pill's
       button shrinks from 76 px to 32 and the step takes the room; in the panel footer the
       slot keeps 76 px, so the tabs do not move, and the circle sits at its right edge. */
    .hha-btn-stop {
      background: var(--md-sys-color-surface-container-high);
      color: var(--md-sys-color-on-surface);
      box-shadow: var(--hha-btn-shadow-flat);
    }

    /* Size and colour follow the run at once, the class of the button only after its word
       has faded (120 ms). With the size on the class, the step came in while Старт was still
       wide and the pill grew past its new width and shrank back, and on a stop it shrank and
       grew again. Now the step and the button change together and the pill moves once. */
    .hha-root.is-running .hha-btn-quick {
      width: 32px;
      min-width: 32px;
      max-width: 32px;
      flex: 0 0 32px;
      padding: 0;
    }

    .hha-root.is-running .hha-btn-start {
      background: var(--md-sys-color-surface-container-high);
      color: transparent;
      box-shadow: var(--hha-btn-shadow-flat);
    }

    /* The red of the hover turns teal quickly: halfway through 180 ms it was a muddy grey. */
    .hha-root:not(.is-running) .hha-btn-stop {
      background: var(--md-sys-color-primary);
      color: transparent;
      transition:
        width 280ms var(--md-sys-motion-easing-standard),
        min-width 280ms var(--md-sys-motion-easing-standard),
        max-width 280ms var(--md-sys-motion-easing-standard),
        flex-basis 280ms var(--md-sys-motion-easing-standard),
        background-color 60ms linear,
        color 60ms linear,
        box-shadow 180ms var(--md-sys-motion-easing-standard);
    }

    /* Gone at once: fading, it showed as a dull spot on the button turning teal. */
    .hha-root:not(.is-running) .hha-btn-stop::after {
      display: none;
    }

    .hha-root.is-stopped-error .hha-btn-stop {
      background: var(--md-sys-color-error);
    }

    .hha-btn-stop .hha-btn-label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }

    .hha-btn-stop::after {
      content: '';
      position: relative;
      z-index: 1;
      width: 10px;
      height: 10px;
      border-radius: 2.5px;
      background: currentColor;
      /* After the button has mostly shrunk: a square in a still wide button looked lost. */
      animation: hhaStopIn 200ms var(--md-sys-motion-easing-emphasized-decelerate) 60ms backwards;
    }

    .hha-root.is-running .hha-btn-stop:hover {
      background: var(--md-sys-color-error-container);
      color: var(--md-sys-color-error);
    }

    .hha-root.is-running .hha-btn-stop.is-arriving:hover {
      background: var(--md-sys-color-surface-container-high);
      color: var(--md-sys-color-on-surface);
    }

    .hha-root.is-running .hha-btn-stop:active {
      background: color-mix(in srgb, var(--md-sys-color-error-container) 85%, var(--md-sys-color-error));
      color: var(--md-sys-color-error);
      transform: scale(0.92);
    }

    @keyframes hhaStopIn {
      from {
        opacity: 0;
        transform: scale(0.4);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }

    /* The ring: an SVG circle the size of the button; pathLength 100 makes the arc a share of
       the circle, and moving its dash offset runs it round with rounded ends. */
    .hha-btn-sweep {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
      pointer-events: none;
      transition: opacity 160ms ease-out;
    }

    .hha-btn-sweep circle {
      fill: none;
      stroke-width: 2;
    }

    .hha-btn-sweep .hha-ring-track {
      stroke: color-mix(in srgb, var(--md-sys-color-primary) 16%, transparent);
    }

    .hha-btn-sweep .hha-ring-arc {
      stroke: var(--md-sys-color-primary);
      stroke-linecap: round;
      stroke-dasharray: 22 78;
    }

    /* The ring comes once the button is nearly round: a circle in a still wide button
       did not match it. */
    .hha-root.is-running .hha-btn-stop .hha-btn-sweep {
      opacity: 1;
      transition: opacity 200ms ease-out 60ms;
    }

    .hha-root.is-running .hha-btn-stop .hha-ring-arc {
      animation: hhaStopSweep 2.4s linear infinite;
    }

    .hha-root.is-running .hha-btn-stop:hover:not(.is-arriving) .hha-btn-sweep {
      opacity: 0;
    }

    /* The pill's copy of the button is hidden while the panel is open: no lap there. */
    .hha-root.is-expanded .hha-pill .hha-ring-arc {
      animation: none;
    }

    @keyframes hhaStopSweep {
      from {
        stroke-dashoffset: 0;
      }
      to {
        stroke-dashoffset: -100;
      }
    }

    /* Filled Success Button for Done / Limit Reached */
    .hha-btn-done {
      background: var(--md-sys-color-primary);
      color: var(--md-sys-color-on-primary);
      border: none;
      box-shadow: var(--hha-btn-shadow-raised);
    }

    .hha-btn-done:hover {
      background: color-mix(in srgb, var(--md-sys-color-primary) 92%, var(--md-sys-color-on-primary));
      box-shadow: var(--hha-btn-shadow-hover);
      color: var(--md-sys-color-on-primary);
    }

    .hha-btn-done:active {
      background: color-mix(in srgb, var(--md-sys-color-primary) 88%, var(--md-sys-color-on-primary));
      box-shadow: var(--hha-btn-shadow-raised);
      transform: scale(0.97);
    }

    /* Neutral Tonal Button for Daily Limit Reached */
    .hha-btn-limit {
      background: var(--md-sys-color-surface-container-highest);
      color: var(--md-sys-color-on-surface-variant);
      border: 1px solid var(--md-sys-color-outline-variant);
      box-shadow: var(--hha-btn-shadow-flat);
    }

    .hha-btn-limit:hover {
      background: color-mix(in srgb, var(--md-sys-color-surface-container-highest) 85%, var(--md-sys-color-on-surface-variant));
      color: var(--md-sys-color-on-surface);
      border-color: var(--md-sys-color-outline);
    }

    .hha-btn-limit:active {
      transform: scale(0.97);
    }

    /* Filled Error Button for Error / Reset State */
    .hha-btn-error {
      background: var(--md-sys-color-error);
      color: var(--md-sys-color-on-error);
      box-shadow: var(--hha-btn-shadow-raised);
    }

    .hha-btn-error:hover {
      background: color-mix(in srgb, var(--md-sys-color-error) 92%, var(--md-sys-color-on-error));
      box-shadow: var(--hha-btn-shadow-hover);
      color: var(--md-sys-color-on-error);
    }

    .hha-btn-error:active,
    .hha-btn-error:focus-visible {
      background: color-mix(in srgb, var(--md-sys-color-error) 88%, var(--md-sys-color-on-error));
      box-shadow: var(--hha-btn-shadow-raised);
      transform: scale(0.97);
      color: var(--md-sys-color-on-error);
    }

    /* 5. Flyout Panel */
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
      z-index: 3;
      transform-origin: center bottom;
      transform: scale(0.92) translate3d(0, 12px, 0);
      will-change: transform, opacity;
      backface-visibility: hidden;
      transition:
        height 400ms var(--hha-motion-collapse-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        min-height 400ms var(--hha-motion-collapse-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        max-height 400ms var(--hha-motion-collapse-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        transform var(--hha-motion-collapse-duration, 500ms) var(--hha-motion-collapse-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        opacity 200ms ease-in 30ms,
        border-radius var(--hha-motion-collapse-duration, 500ms) var(--hha-motion-collapse-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        box-shadow var(--hha-motion-collapse-duration, 500ms) var(--hha-motion-collapse-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        visibility var(--hha-motion-collapse-duration, 500ms) linear;
    }

    .hha-root.dir-up .hha-flyout {
      transform-origin: center bottom;
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
        height 400ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        min-height 400ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        max-height 400ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        transform var(--hha-motion-expand-duration, 500ms) var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        opacity 400ms cubic-bezier(0.2, 0, 0, 1) 0s,
        border-radius var(--hha-motion-expand-duration, 500ms) var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        box-shadow var(--hha-motion-expand-duration, 500ms) var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)),
        visibility var(--hha-motion-expand-duration, 500ms) linear 0s;
    }

    /* Inner Elements Unified Synchronous Transitions */
    .hha-flyout .hha-island-header {
      flex-shrink: 0;
      opacity: 0;
      transform: translate3d(0, -8px, 0) scale(0.96);
      transition:
        opacity 120ms ease-out 0s,
        transform var(--hha-motion-collapse-duration, 260ms) var(--hha-motion-collapse-easing, cubic-bezier(0.3, 0, 0.8, 0.15));
    }

    .hha-root.is-expanded .hha-island-header {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
      transition: opacity 260ms ease-out 50ms, transform 420ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)) 50ms;
    }

    .hha-flyout .hha-panels,
    .hha-flyout .hha-log-row {
      opacity: 0;
      transform: translate3d(0, 10px, 0) scale(0.94);
      transition:
        opacity 120ms ease-out 0s,
        transform var(--hha-motion-collapse-duration, 260ms) var(--hha-motion-collapse-easing, cubic-bezier(0.3, 0, 0.8, 0.15));
    }

    .hha-root.is-expanded .hha-panels,
    .hha-root.is-expanded .hha-log-row {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
      transition: opacity 280ms ease-out 70ms, transform 440ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)) 70ms;
    }

    .hha-flyout .hha-island-footer {
      opacity: 0;
      transform: translate3d(0, 0, 0);
      transition:
        opacity 120ms ease-out 0s,
        transform var(--hha-motion-collapse-duration, 260ms) var(--hha-motion-collapse-easing, cubic-bezier(0.3, 0, 0.8, 0.15));
    }

    .hha-root.is-expanded .hha-island-footer {
      opacity: 1;
      transform: translate3d(0, 0, 0);
      transition: opacity 240ms ease-out 40ms, transform 420ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)) 40ms;
    }

    /* 5.1 Island Header */
    .hha-island-header {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      height: 42px;
      min-height: 42px;
      /* 7px on top leaves 34px above the bottom border, so the 28px close button is
         centred on a whole pixel and does not shimmer while the panel resizes. */
      padding: 7px 12px 0 16px;
      background: var(--md-sys-color-surface-container-low);
      border-bottom: 1px solid var(--md-sys-color-outline-variant);
      border-radius: var(--md-sys-shape-corner-extra-large) var(--md-sys-shape-corner-extra-large) 0 0;
      gap: 8px;
      user-select: none;
      -webkit-user-select: none;
      -webkit-user-drag: none;
      cursor: grab;
      touch-action: none;
      box-sizing: border-box;
      flex-shrink: 0;
      position: relative;
    }

    .hha-island-header:active,
    .hha-root.is-dragging .hha-island-header {
      cursor: grabbing;
    }

    .hha-header-drag-handle {
      position: absolute;
      left: 50%;
      top: 6px;
      transform: translateX(-50%);
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

    .hha-status-line {
      flex: 1;
      min-width: 0;
      font-size: var(--md-sys-typescale-label-medium-size);
      font-weight: 500;
      line-height: 16px;
      color: var(--md-sys-color-on-surface-variant);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-variant-numeric: tabular-nums;
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

    /* 6. Bottom Navigation & Action Dock */
    .hha-log-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      /* 1px border plus 32px of content: the 26px button and its 14px icon are then
         centred on whole pixels. At 32px they sat half a pixel off and jumped by one
         pixel while the panel height animated on a tab switch. */
      min-height: 33px;
      padding: 0 8px 0 16px;
      border-top: 1px solid var(--md-sys-color-outline-variant);
      flex-shrink: 0;
      box-sizing: border-box;
      font-size: var(--md-sys-typescale-body-small-size);
      color: var(--md-sys-color-on-surface-variant);
    }

    .hha-log-row-text {
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .hha-btn-copy-log {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 26px;
      padding: 0 8px;
      border: none;
      border-radius: var(--md-sys-shape-corner-full);
      background: transparent;
      color: var(--md-sys-color-primary);
      font-family: var(--md-sys-typescale-font-family);
      font-size: var(--md-sys-typescale-label-medium-size);
      font-weight: 600;
      white-space: nowrap;
      cursor: pointer;
      flex-shrink: 0;
      transition: background-color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard);
    }

    .hha-btn-copy-log:hover {
      background: color-mix(in srgb, var(--md-sys-color-primary) 8%, transparent);
    }

    .hha-btn-copy-log:active {
      background: color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent);
    }

    .hha-btn-copy-log:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--md-sys-color-surface), 0 0 0 4px var(--md-sys-color-primary);
    }

    .hha-log-row-actions {
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }

    /* A rare action: grey at rest, red only under the pointer and when it asks to confirm. */
    .hha-btn-clear-log {
      color: var(--md-sys-color-on-surface-variant);
      transition:
        background-color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard),
        color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard);
    }

    .hha-btn-clear-log[hidden] {
      display: none;
    }

    .hha-btn-clear-log:hover,
    .hha-btn-clear-log.is-confirming {
      background: var(--md-sys-color-error-container);
      color: var(--md-sys-color-error);
    }

    .hha-btn-clear-log:active {
      background: color-mix(in srgb, var(--md-sys-color-error-container) 85%, var(--md-sys-color-error));
    }

    .hha-btn-clear-log.is-confirming svg {
      display: none;
    }

    .hha-btn-clear-log:focus-visible {
      box-shadow: 0 0 0 2px var(--md-sys-color-surface), 0 0 0 4px var(--md-sys-color-error);
    }

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
      padding: 0 6px;
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
        transform var(--hha-motion-collapse-duration, 260ms) var(--hha-motion-collapse-easing, cubic-bezier(0.3, 0, 0.8, 0.15)),
        opacity 140ms ease-out,
        background-color var(--md-sys-motion-duration-medium1) var(--md-sys-motion-easing-standard),
        box-shadow var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard);
    }

    .hha-root.is-expanded .hha-footer-status-group {
      opacity: 1;
      transform: translate3d(0, 0, 0);
      transition:
        transform 420ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)) 0ms,
        opacity 160ms ease-out 20ms,
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
      min-width: 176px;
      max-width: 204px;
      box-sizing: border-box;
      /* Shrinks when the counter on the left grows, e.g. 200 sent and 31 queued. */
      flex: 0 1 204px;
      position: relative;
      opacity: 0;
      transform: scale(0.85);
      will-change: transform, opacity;
      transition:
        width 280ms var(--md-sys-motion-easing-standard),
        max-width 280ms var(--md-sys-motion-easing-standard),
        flex-basis 280ms var(--md-sys-motion-easing-standard),
        transform var(--hha-motion-collapse-duration, 260ms) var(--hha-motion-collapse-easing, cubic-bezier(0.3, 0, 0.8, 0.15)),
        opacity 140ms ease-out;
    }

    /* A window under 422 px makes the panel narrower than 390 px: the bottom bar gives up
       its spacing and the tabs their minimum width, so the Start button stays inside. */
    @media (max-width: 421px) {
      .hha-island-footer {
        padding: 8px;
        gap: 4px;
      }

      .hha-island-footer .hha-tabs {
        width: auto;
        min-width: 0;
        flex: 1 1 auto;
      }

      .hha-root.is-running .hha-island-footer .hha-tabs {
        width: auto;
        max-width: none;
        flex: 1 1 auto;
      }

      .hha-tab-btn {
        padding: 0 4px;
      }
    }

    .hha-root.is-expanded .hha-island-footer .hha-tabs {
      opacity: 1;
      transform: scale(1);
      transition:
        width 280ms var(--md-sys-motion-easing-standard),
        max-width 280ms var(--md-sys-motion-easing-standard),
        flex-basis 280ms var(--md-sys-motion-easing-standard),
        transform 420ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)) 40ms,
        opacity 220ms ease-out 50ms;
    }

    /* Follows the tabs while they widen or narrow, with no lag of its own. */
    .hha-tab-indicator.is-tracking {
      transition: none;
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

    .hha-footer-actions {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      flex-shrink: 0;
      width: 76px;
      margin-left: 0;
      transition: width 280ms var(--md-sys-motion-easing-standard);
    }

    /* While a run goes the round Стоп needs 32 px of the 76: the tabs take the other 44,
       together with the button, so the footer has no gap at its right end. */
    .hha-root.is-running .hha-footer-actions {
      width: 32px;
    }

    .hha-root.is-running .hha-island-footer .hha-tabs {
      width: 248px;
      max-width: 248px;
      flex-basis: 248px;
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
        transform var(--hha-motion-collapse-duration, 260ms) var(--hha-motion-collapse-easing, cubic-bezier(0.3, 0, 0.8, 0.15)),
        opacity 140ms ease-out;
    }

    .hha-root.is-expanded .hha-footer-actions .hha-btn-quick {
      opacity: 1;
      transform: translate3d(0, 0, 0);
      transition:
        width 280ms var(--md-sys-motion-easing-standard),
        min-width 280ms var(--md-sys-motion-easing-standard),
        max-width 280ms var(--md-sys-motion-easing-standard),
        flex-basis 280ms var(--md-sys-motion-easing-standard),
        transform 420ms var(--hha-motion-spring-easing, cubic-bezier(0.34, 1.15, 0.64, 1)) 0ms,
        opacity 160ms ease-out 20ms;
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

    /* Active Tab Indicator */
    .hha-tab-btn.active {
      background: transparent !important;
      border: none !important;
      box-shadow: none !important;
      color: var(--md-sys-color-primary) !important;
      font-weight: 600;
    }

    .hha-tab-btn.active:active {
      transform: scale(0.98);
    }

    /* Focus Rings (Dual Focus Indicators) */
    /* Drawn inside: the insert buttons sit flush with the card edge, an outer ring would be cut. */
    .hha-btn-letter-var:focus-visible {
      outline: none;
      box-shadow: inset 0 0 0 2px var(--md-sys-color-primary);
    }

    .hha-pill-status-group:focus-visible,
    .hha-tab-btn:focus-visible,
    .hha-btn-quick:focus-visible,
    .hha-queue-title-link:focus-visible,
    .hha-btn-dismiss-error:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--md-sys-color-surface), 0 0 0 4px var(--md-sys-color-primary);
    }

    .hha-log-item-delete:focus-visible,
    .hha-btn-clear-all:focus-visible,
    .hha-btn-copy-error:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--md-sys-color-surface), 0 0 0 4px var(--md-sys-color-error);
    }

    /* 7. Tab Panels */
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

    /* Tabs switch by a crossfade only. The old 6 px sideways slide drew the two cards of
       the same width over each other with an offset while both faded: their edges doubled
       and the inner box looked wider for as long as the panel grew in height. */

    /* 8. Queue & Log Containers */
    /* Tab 2: Queue Container */
    [data-panel="queue"] {
      overflow: hidden !important;
    }

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

    /* Queue Toolbar (Secondary List Header) */
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

    /* Queue List Items */
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
      /* The card slides out and fades first, then its place closes: collapsing the height
         while the text was still opaque squeezed and clipped the lines on screen. */
      transition:
        opacity 140ms ease-out,
        transform 160ms cubic-bezier(0.3, 0, 0.8, 0.15),
        max-height 200ms cubic-bezier(0.2, 0, 0, 1) 90ms,
        padding 200ms cubic-bezier(0.2, 0, 0, 1) 90ms,
        border-color 140ms ease !important;
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

    /* Viewed Queue Card state (Accessible Subdued State) */
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
      color: var(--md-sys-color-outline);
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

    /* Block, not inline-flex: a flex container clips its text without the ellipsis. */
    .hha-queue-employer {
      font-size: var(--md-sys-typescale-body-small-size);
      font-weight: 400;
      color: var(--md-sys-color-on-surface-variant);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      height: 16px;
      line-height: 16px;
      display: block;
      min-width: 0;
    }

    .hha-queue-card.is-viewed .hha-queue-employer {
      color: var(--md-sys-color-outline);
    }

    /* The first question of the employer's form, quoted with a bar on the left. */
    .hha-queue-question {
      font-size: var(--md-sys-typescale-body-small-size);
      line-height: 16px;
      color: var(--md-sys-color-on-surface);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      padding: 1px 0 1px 8px;
      border-left: 2px solid var(--md-sys-color-primary-container);
    }

    .hha-queue-card.is-viewed .hha-queue-question {
      color: var(--md-sys-color-outline);
      border-left-color: var(--md-sys-color-outline-variant);
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

    /* Assist Chips / Badges */
    .hha-queue-badge {
      display: inline-flex;
      align-items: center;
      height: 18px;
      line-height: 18px;
      padding: 0 7px;
      box-sizing: border-box;
      border-radius: var(--md-sys-shape-corner-small);
      font-size: var(--md-sys-typescale-label-small-size);
      font-weight: 500;
      letter-spacing: -0.05px;
      flex-shrink: 0;
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
      display: block;
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

    /* Delete item button with Icon Button state layers */
    .hha-log-item-delete {
      width: 28px;
      height: 28px;
      min-width: 28px;
      min-height: 28px;
      margin: -4px -6px -4px 0;
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

    /* 9. Error Card */
    .hha-error-slot {
      flex-shrink: 0;
      padding: 10px var(--hha-content-padding-x, 12px) 0;
      box-sizing: border-box;
    }

    .hha-error-slot[hidden] {
      display: none;
    }

    .hha-card-error {
      max-height: 230px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 8px;
      box-sizing: border-box;
      padding: 12px 14px;
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
      align-items: flex-start;
      gap: 6px;
      min-height: 0;
      flex: 1 1 auto;
      overflow-y: auto;
      overflow-x: hidden;
      scrollbar-width: thin;
      scrollbar-color: color-mix(in srgb, var(--md-sys-color-error) 30%, transparent) transparent;
      padding-right: 4px;
    }

    .hha-card-error-body::-webkit-scrollbar {
      width: 4px;
    }

    .hha-card-error-body::-webkit-scrollbar-track {
      background: transparent;
    }

    .hha-card-error-body::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--md-sys-color-error) 30%, transparent);
      border-radius: var(--md-sys-shape-corner-full);
    }

    .hha-card-error-body::-webkit-scrollbar-thumb:hover {
      background: color-mix(in srgb, var(--md-sys-color-error) 50%, transparent);
    }

    .hha-card-error-title {
      font-size: var(--md-sys-typescale-body-medium-size);
      font-weight: 700;
      line-height: 1.35;
      color: var(--md-sys-color-on-error-container);
      word-break: break-word;
      user-select: text;
      flex-shrink: 0;
    }

    .hha-card-error-desc {
      font-size: var(--md-sys-typescale-body-small-size);
      font-weight: 400;
      line-height: 1.45;
      color: color-mix(in srgb, var(--md-sys-color-on-error-container) 90%, transparent);
      word-break: break-word;
      user-select: text;
      white-space: pre-wrap;
    }

    .hha-card-error-hint {
      font-size: var(--md-sys-typescale-body-small-size);
      font-weight: 600;
      line-height: 1.45;
      color: var(--md-sys-color-on-error-container);
      word-break: break-word;
      user-select: text;
    }

    .hha-card-error-code {
      display: inline-block;
      align-self: flex-start;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: var(--md-sys-typescale-label-small-size);
      font-weight: 500;
      line-height: 1.4;
      color: color-mix(in srgb, var(--md-sys-color-on-error-container) 85%, transparent);
      background: color-mix(in srgb, var(--md-sys-color-error) 12%, transparent);
      padding: 4px 8px;
      border-radius: var(--md-sys-shape-corner-small);
      word-break: break-all;
      user-select: text;
      margin-top: 2px;
      flex-shrink: 0;
    }

    .hha-card-error-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 4px;
      padding-top: 8px;
      border-top: 1px solid color-mix(in srgb, var(--md-sys-color-error) 15%, transparent);
      flex-shrink: 0;
    }

    .hha-card-error-actions .hha-btn-copy-error {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 32px;
      padding: 0 14px;
      border-radius: var(--md-sys-shape-corner-full);
      /* White on the tinted banner: a transparent button read as plain text there. */
      background: var(--md-sys-color-surface-container-lowest);
      color: var(--md-sys-color-on-surface-variant);
      border: 1px solid color-mix(in srgb, var(--md-sys-color-error) 25%, transparent);
      font-family: var(--md-sys-typescale-font-family);
      font-size: var(--md-sys-typescale-label-medium-size);
      font-weight: 500;
      line-height: 1;
      cursor: pointer;
      box-sizing: border-box;
      transition: background-color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard),
                  border-color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard),
                  color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard),
                  transform var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
    }

    .hha-card-error-actions .hha-btn-copy-error:hover {
      background: var(--md-sys-color-surface-container-high);
      border-color: var(--md-sys-color-outline);
      color: var(--md-sys-color-on-surface);
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
      padding: 0 18px;
      border-radius: var(--md-sys-shape-corner-full);
      /* The same role as Старт: it starts the run again. */
      background: var(--md-sys-color-primary);
      color: var(--md-sys-color-on-primary);
      box-shadow: var(--md-sys-elevation-level1);
      border: none;
      font-family: var(--md-sys-typescale-font-family);
      font-size: var(--md-sys-typescale-label-medium-size);
      font-weight: 600;
      line-height: 1;
      cursor: pointer;
      box-sizing: border-box;
      transition: background-color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard),
                  box-shadow var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard),
                  transform var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
    }

    .hha-card-error-actions .hha-btn-dismiss-error:hover {
      background: color-mix(in srgb, var(--md-sys-color-primary) 92%, var(--md-sys-color-on-primary));
      box-shadow: var(--md-sys-elevation-level2);
    }

    .hha-card-error-actions .hha-btn-dismiss-error:active {
      transform: scale(0.96);
    }

    /* Clear all in queue: Text Button (Error role) */
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
      background: var(--md-sys-color-error-container) !important;
      border: none !important;
      color: var(--md-sys-color-error) !important;
      font-weight: 600 !important;
    }

    .hha-btn-clear-all.is-confirming:hover {
      background: color-mix(in srgb, var(--md-sys-color-error-container) 85%, var(--md-sys-color-error)) !important;
      color: var(--md-sys-color-error) !important;
    }

    .hha-btn-clear-all.is-confirming:active {
      transform: scale(0.96);
      background: color-mix(in srgb, var(--md-sys-color-error-container) 75%, var(--md-sys-color-error)) !important;
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

    /* 10. Tooltip */
    .hha-tooltip {
      position: absolute;
      background: var(--md-sys-color-inverse-surface);
      color: var(--md-sys-color-inverse-on-surface);
      font-family: var(--md-sys-typescale-font-family);
      font-size: var(--md-sys-typescale-body-small-size);
      font-weight: 400;
      line-height: var(--md-sys-typescale-body-small-line-height);
      padding: 6px 10px;
      border-radius: var(--md-sys-shape-corner-small);
      max-width: 260px;
      width: max-content;
      white-space: pre-line;
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

    /* The arrow points at the element: below the tooltip when it sits above the element,
       on top when it sits below. _showTooltip() sets its x and the side. */
    .hha-tooltip::after {
      content: '';
      position: absolute;
      left: var(--hha-arrow-x, 50%);
      bottom: -4px;
      width: 9px;
      height: 9px;
      background: inherit;
      border-radius: 1px;
      transform: translateX(-50%) rotate(45deg);
    }

    .hha-tooltip.is-below::after {
      bottom: auto;
      top: -4px;
    }

    /* Undo after removing from the queue */
    .hha-snackbar {
      position: absolute;
      left: 8px;
      right: 8px;
      bottom: 8px;
      z-index: 5;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 38px;
      padding: 0 6px 0 14px;
      box-sizing: border-box;
      background: var(--md-sys-color-inverse-surface);
      color: var(--md-sys-color-inverse-on-surface);
      border-radius: var(--md-sys-shape-corner-small);
      box-shadow: var(--md-sys-elevation-level3);
      font-size: var(--md-sys-typescale-body-small-size);
      line-height: 16px;
      animation: hhaSnackIn 220ms var(--md-sys-motion-easing-emphasized-decelerate);
    }

    .hha-snackbar[hidden] {
      display: none;
    }

    @keyframes hhaSnackIn {
      from { opacity: 0; transform: translate3d(0, 8px, 0); }
      to { opacity: 1; transform: none; }
    }

    .hha-snackbar-action {
      height: 28px;
      padding: 0 12px;
      border: none;
      border-radius: var(--md-sys-shape-corner-full);
      background: transparent;
      color: var(--md-sys-color-primary-container);
      font-family: var(--md-sys-typescale-font-family);
      font-size: var(--md-sys-typescale-label-medium-size);
      font-weight: 600;
      cursor: pointer;
      flex-shrink: 0;
      transition: background-color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard);
    }

    .hha-snackbar-action:hover {
      background: color-mix(in srgb, var(--md-sys-color-inverse-on-surface) 12%, transparent);
    }

    .hha-snackbar-action:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--md-sys-color-primary-container);
    }

    .hha-sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
      border: 0;
    }

    /* 11. Settings Controls */
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

    /* 12. Switch & Cover Letter */
    /* No shorter than the switch row, three lines of the letter and the row of variable
       buttons (44 + 58 + 28 px and the borders): in a short panel the panel scrolls, and
       the buttons are not cut off. */
    .hha-card-cover {
      flex: 1;
      min-height: 132px;
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

    /* Switch */
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
      border: none;
      box-sizing: border-box;
      transition: background-color var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard);
    }

    .hha-switch:hover .hha-switch-slider {
      background-color: color-mix(in srgb, var(--md-sys-color-surface-container-highest) 88%, var(--md-sys-color-on-surface));
    }

    .hha-switch-slider::before {
      position: absolute;
      content: "";
      top: 50%;
      left: 4px;
      height: 16px;
      width: 16px;
      transform: translateY(-50%);
      background-color: var(--md-sys-color-outline);
      border-radius: var(--md-sys-shape-corner-full);
      transition: transform var(--md-sys-motion-duration-medium1) var(--md-sys-motion-easing-emphasized-decelerate), background-color var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard);
    }

    .hha-switch:hover .hha-switch-slider::before {
      background-color: var(--md-sys-color-on-surface);
    }

    /* Checked Switch */
    .hha-switch-input:checked + .hha-switch-slider {
      background-color: var(--md-sys-color-primary);
      border: none;
    }

    .hha-switch-input:checked + .hha-switch-slider:hover {
      background-color: color-mix(in srgb, var(--md-sys-color-primary) 92%, var(--md-sys-color-on-primary));
    }

    .hha-switch-input:checked + .hha-switch-slider::before {
      transform: translateY(-50%) translateX(20px);
      height: 16px;
      width: 16px;
      background-color: var(--md-sys-color-on-primary);
    }

    /* Squish Transition on Active/Press */
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

    /* Three lines of the letter at least; a shorter panel (a 175-200 % zoom on a laptop)
       scrolls instead of laying the field over the variable buttons below it. */
    .hha-cover-container {
      flex: 1;
      min-height: 58px;
      display: flex;
      flex-direction: column;
      padding: 0;
      box-sizing: border-box;
      position: relative;
      background: transparent;
    }

    .hha-cover-textarea {
      position: relative;
      z-index: 1;
      width: 100%;
      flex: 1;
      height: 100%;
      min-height: 0;
      background: transparent;
      border: none;
      border-radius: 0;
      color: var(--md-sys-color-on-surface);
      font-size: 13px;
      line-height: 19px;
      letter-spacing: -0.05px;
      font-family: var(--md-sys-typescale-font-family);
      padding: 10px 12px;
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

    .hha-cover-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 28px;
      padding: 0 12px;
      border-top: 1px solid var(--md-sys-color-outline-variant);
      font-size: var(--md-sys-typescale-label-small-size);
      line-height: 16px;
      color: var(--md-sys-color-outline);
      flex-shrink: 0;
    }

    .hha-cover-status.is-error,
    .hha-cover-counter.is-near-limit {
      color: var(--md-sys-color-error);
    }

    /* Sending is off: the letter stays editable, but reads as inactive until focused. */
    .hha-card-cover.is-off .hha-cover-textarea:not(:focus),
    .hha-card-cover.is-off .hha-btn-letter-var {
      color: var(--md-sys-color-outline);
    }

    .hha-cover-status {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* The two insert buttons as one strip: no outline or rounding, a hairline between
       them and one after the second, setting them apart from the status text. */
    .hha-cover-vars {
      display: inline-flex;
      align-items: stretch;
      align-self: stretch;
      flex-shrink: 0;
      /* Flush with the card's left edge and the full row height, so the hover tint fills
         the cell; the card's rounded corner clips it. */
      margin-left: -12px;
    }

    .hha-btn-letter-var {
      height: auto;
      min-height: 28px;
      padding: 0 10px;
      border: none;
      border-right: 1px solid var(--md-sys-color-outline-variant);
      border-radius: 0;
      background: transparent;
      color: var(--md-sys-color-primary);
      font-family: var(--md-sys-typescale-font-family);
      font-size: var(--md-sys-typescale-label-small-size);
      line-height: 22px;
      white-space: nowrap;
      cursor: pointer;
      transition:
        background-color var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard),
        color var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard);
    }

    .hha-btn-letter-var:hover {
      background: color-mix(in srgb, var(--md-sys-color-primary) 8%, transparent);
    }

    .hha-btn-letter-var:active {
      background: color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent);
    }

    /* The first label lines up with the letter text above it. */
    .hha-btn-letter-var:first-child {
      padding-left: 12px;
    }

    /* Variables in the letter: a layer under the transparent textarea repeats its text with
       the same metrics and paints a tint behind each {variable}. The marks have no padding,
       which would shift the lines; a sideways box-shadow widens the tint without moving
       text, and not up or down, where marks on next lines would overlap. */
    .hha-cover-backdrop {
      position: absolute;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
    }

    .hha-cover-highlights {
      box-sizing: border-box;
      padding: 10px 12px;
      font-family: var(--md-sys-typescale-font-family);
      font-size: 13px;
      line-height: 19px;
      letter-spacing: -0.05px;
      white-space: pre-wrap;
      overflow-wrap: break-word;
      word-break: normal;
      color: transparent;
    }

    .hha-cover-highlights mark {
      color: transparent;
      background: color-mix(in srgb, var(--md-sys-color-primary) 14%, transparent);
      box-shadow: 2px 0 0 color-mix(in srgb, var(--md-sys-color-primary) 14%, transparent), -2px 0 0 color-mix(in srgb, var(--md-sys-color-primary) 14%, transparent);
      border-radius: 3px;
    }

    .hha-cover-highlights mark.is-unknown {
      background: color-mix(in srgb, var(--md-sys-color-error) 16%, transparent);
      box-shadow: 2px 0 0 color-mix(in srgb, var(--md-sys-color-error) 16%, transparent), -2px 0 0 color-mix(in srgb, var(--md-sys-color-error) 16%, transparent);
    }

    .hha-card-cover.is-off .hha-cover-highlights mark:not(.is-unknown) {
      background: color-mix(in srgb, var(--md-sys-color-outline) 12%, transparent);
      box-shadow: 2px 0 0 color-mix(in srgb, var(--md-sys-color-outline) 12%, transparent), -2px 0 0 color-mix(in srgb, var(--md-sys-color-outline) 12%, transparent);
    }

    .hha-cover-counter {
      margin-left: auto;
      font-variant-numeric: tabular-nums;
    }

    /* Accessibility: Motion Reduction (opacity only, <= 100ms, no transforms or growth) */
    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        transition-duration: 100ms !important;
        transition-delay: 0s !important;
        animation: none !important;
      }

      /* An arc standing still on the ring would look like a flaw: only the faint track
         stays, and the step text and its countdown show the run. */
      .hha-btn-sweep .hha-ring-arc {
        display: none !important;
      }

      .hha-pill,
      .hha-flyout,
      .hha-panel,
      .hha-panels,
      .hha-island-header,
      .hha-island-footer,
      .hha-footer-status-group,
      .hha-tabs,
      .hha-btn-quick,
      .hha-btn-label.is-swapping,
      .hha-queue-card.is-removing {
        transform: none !important;
      }
    }
  `;

  // --- 4. Web Component Implementation (Closed Shadow DOM) ---

  // Panel height per tab: header, content, the log row and the footer. The letter tab
  // shows about ten lines of the letter; an error banner adds its own height on top.
  const FLYOUT_HEIGHT = { settings: 452, queue: 552 };

  class HhaHudElement extends HTMLElement {
    // Private, so page scripts cannot reach the engine or the closed shadow root through
    // the <hha-hud> element.
    #shadow = null;
    #assistant = null;
    // What "Вернуть" puts back into the queue: private as well, or a page script could
    // slip its own items into the queue through the next click on that button.
    #undoItems = [];

    constructor() {
      super();
      this.#shadow = (typeof this.attachShadow === 'function')
        ? this.attachShadow({ mode: 'closed' })
        : null;
      this.#assistant = null;
      this._unsubscribers = [];

      this._isExpanded = false;
      this._activeTab = 'settings'; // 'settings' | 'queue'
      const initWinW = window.innerWidth || 1024;
      const initWinH = window.innerHeight || 768;
      this._pillPos = { x: Math.max(8, initWinW - 220), y: Math.max(8, initWinH - 36 - 24) };
      this._collapsedPillWidth = 166;
      this._isAnimating = false;
      this._queue = [];
      this._removingVids = new Set();
      this._lastErrorPayload = null;
      this._config = {
        useCover: false,
        coverText: '',
        skipHidden: true
      };
      this._status = { status: 'idle', code: 'IDLE' };
      this._progress = { sent: 0, percentage: 0 };
      this._activity = null;
      this._lastRun = null;
      this._statusLineTimer = null;

      this._isPointerDown = false;
      this._dragMoved = false;
      this._pointerId = null;
      this._dragTarget = null;
      this._dragStartPointer = { x: 0, y: 0 };
      this._dragStartPillPos = { x: 0, y: 0 };
      this._dragRafId = null;
      this._justDragged = false;
      this._coverDebounceTimer = null;
      this._coverStatusTimer = null;
      this._animTimer = null;
      this._domEventsBound = false;
      this._onDocClick = null;
      this._onDocKeyDown = null;
      this._queueConfirmTimer = null;
      this._windowListeners = [];
      this._dragWindowRemovers = [];
      this._resizeRemover = null;
      this._snapTimer = null;
      this._copyErrorTimer = null;
      this._lastToggleTime = 0;
      this._lastBtnLabel = null;
      this._hasSyncedStatus = false;

      this._onResize = this._onResize.bind(this);
      this._onPointerDown = this._onPointerDown.bind(this);
      this._onPointerMove = this._onPointerMove.bind(this);
      this._onPointerUp = this._onPointerUp.bind(this);
    }

    _addWindowListener(type, handler, options) {
      window.addEventListener(type, handler, options);
      const entry = { type, handler, options };
      this._windowListeners.push(entry);
      return () => {
        const i = this._windowListeners.indexOf(entry);
        if (i >= 0) this._windowListeners.splice(i, 1);
        try { window.removeEventListener(type, handler, options); } catch (_) {}
      };
    }

    _removeAllWindowListeners() {
      if (!Array.isArray(this._windowListeners)) return;
      for (const { type, handler, options } of this._windowListeners) {
        try { window.removeEventListener(type, handler, options); } catch (_) {}
      }
      this._windowListeners = [];
    }

    connectedCallback() {

      // Restore expanded state and active tab from localStorage across page navigations
      try {
        const savedExpanded = localStorage.getItem('hha_hud_expanded_v2');
        if (savedExpanded !== null) {
          this._isExpanded = savedExpanded === 'true';
        }
        const savedTab = localStorage.getItem('hha_hud_active_tab_v2');
        if (savedTab && ['settings', 'queue'].includes(savedTab)) {
          this._activeTab = savedTab;
        }
      } catch (_) {}

      this._render();
      this._restorePosition();
      this._bindDomEvents();

      // Apply restored tab and expansion state to DOM
      if (this.#shadow) {
        if (this._activeTab !== 'settings') {
          this.setActiveTab(this._activeTab);
        }
        if (this._isExpanded) {
          const root = this.#shadow.querySelector('[data-el="root"]') || this.#shadow.querySelector('.hha-root');
          const statusGroup = this.#shadow.querySelector('[data-el="pill-status-group"]');
          if (root) root.classList.add('is-expanded');
          if (statusGroup) {
            statusGroup.setAttribute('aria-expanded', 'true');
          }
          this._updatePosition();
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => this._updateTabIndicator());
          }
        }
      }

      this._syncAll();

      if (this._resizeRemover) {
        try { this._resizeRemover(); } catch (_) {}
      }
      this._resizeRemover = this._addWindowListener('resize', this._onResize, { passive: true });

      if (hhaEngine && !this.#assistant) {
        this.bindAssistant(hhaEngine);
      }
    }

    disconnectedCallback() {
      if (this._dragRafId) {
        cancelAnimationFrame(this._dragRafId);
        this._dragRafId = null;
      }
      if (this._snapTimer) {
        clearTimeout(this._snapTimer);
        this._snapTimer = null;
      }
      this._removeAllWindowListeners();
      this._dragWindowRemovers = [];
      this._resizeRemover = null;

      if (this._isPointerDown) {
        this._isPointerDown = false;
        this._pointerId = null;
        this._dragTarget = null;
        this._dragMoved = false;
      }

      this._domEventsBound = false;
      this._syncDocTitle(true);
      this.unbindAssistant();
      if (this._onDocClick) {
        document.removeEventListener('click', this._onDocClick);
      }
      if (this._onDocKeyDown) {
        document.removeEventListener('keydown', this._onDocKeyDown);
      }
      if (this._coverDebounceTimer) { clearTimeout(this._coverDebounceTimer); this._coverDebounceTimer = null; }
      if (this._coverStatusTimer) { clearTimeout(this._coverStatusTimer); this._coverStatusTimer = null; }
      if (this._statusLineTimer) { clearTimeout(this._statusLineTimer); this._statusLineTimer = null; }
      if (this._animTimer) { clearTimeout(this._animTimer); this._animTimer = null; }
      if (this._queueConfirmTimer) { clearTimeout(this._queueConfirmTimer); this._queueConfirmTimer = null; }
      if (this._undoTimer) { clearTimeout(this._undoTimer); this._undoTimer = null; }
      if (this._tabsResize) { this._tabsResize.disconnect(); this._tabsResize = null; }
    }

    // --- Public API ---

    bindAssistant(assistant) {
      if (!assistant || this.#assistant === assistant) return;
      this.unbindAssistant();
      this.#assistant = assistant;

      if (typeof assistant.getState === 'function') {
        const s = assistant.getState();
        if (s) {
          const sent = s.sentCount !== undefined ? s.sentCount : 0;
          this._activity = s.activity || null;
          this._lastRun = s.lastRun || null;
          this.updateStatus(s.status, s.statusCode || s.code);
          this.updateProgress(sent);
        }
      }

      if (typeof assistant.getConfig === 'function') {
        const c = assistant.getConfig();
        if (c) {
          this._config = { ...this._config, ...c };
        }
      }

      if (typeof assistant.getManualQueue === 'function') {
        const q = assistant.getManualQueue();
        if (Array.isArray(q)) this._queue = q;
      }

      if (typeof assistant.on === 'function') {
        this._unsubscribers.push(
          // The log row is read when the panel opens; with the panel open during a run it
          // follows each outcome and status change, not every log line.
          assistant.on('status', (payload) => {
            if (payload) this.updateStatus(payload.status, payload.code || payload.statusCode);
            if (this._isExpanded) this._syncLogRow();
          }),
          assistant.on('progress', (payload) => {
            if (payload) this.updateProgress(payload.sent);
          }),
          assistant.on('outcome', () => {
            if (this._isExpanded) this._syncLogRow();
          }),
          assistant.on('activity', (activity) => {
            this._activity = activity || null;
            this._syncStatusLine();
          }),
          assistant.on('error', (payload) => this._showError(payload)),
          assistant.on('manualQueue', (payload) => {
            const q = payload && Array.isArray(payload.queue) ? payload.queue : payload;
            this.updateQueue(q);
          }),
          assistant.on('config', (payload) => {
            const current = payload?.current || payload;
            this.#updateConfig(current);
          }),
          assistant.on('runSummary', (summary) => {
            this._lastRun = summary || null;
            this._syncStatusLine();
          })
        );
      }

      this._syncAll();
      this._countsReady = true;
    }

    unbindAssistant() {
      for (const unsub of this._unsubscribers) {
        try { if (typeof unsub === 'function') unsub(); } catch (_) {}
      }
      this._unsubscribers = [];
      this.#assistant = null;

      if (this._copyErrorTimer) {
        clearTimeout(this._copyErrorTimer);
        this._copyErrorTimer = null;
      }
    }

    updateStatus(status, code) {
      let nextStatus = status || 'idle';
      let nextCode = code || 'IDLE';
      if (code === 'DAILY_LIMIT_REACHED') {
        nextStatus = 'done';
        nextCode = 'DAILY_LIMIT_REACHED';
      }
      this._status = { status: nextStatus, code: nextCode };
      this._syncStatus();
    }

    updateProgress(sent) {
      const s = Number(sent) || 0;
      this._progress = { sent: s, displayCurrent: s };
      this._syncProgress();
    }

    updateQueue(queue) {
      if (queue && Array.isArray(queue.queue)) queue = queue.queue;
      this._queue = Array.isArray(queue) ? queue : [];
      this._syncQueue();
    }

    #updateConfig(config) {
      if (!config) return;
      // A copy: the payload is the engine's own config object.
      config = { ...config };
      if (typeof config.coverText === 'string') config.coverText = sliceSafe(config.coverText, MAX_COVER_LENGTH);
      this._config = { ...this._config, ...config };
      this.updateProgress(this._progress ? this._progress.sent : 0);
      this._syncConfig();
    }

    toggleExpand(force) {
      const next = typeof force === 'boolean' ? force : !this._isExpanded;
      if (this._isExpanded === next) return;
      this._isExpanded = next;
      this._isAnimating = true;
      if (next) this._syncLogRow();

      try {
        localStorage.setItem('hha_hud_expanded_v2', String(this._isExpanded));
      } catch (_) {}

      this._hideTooltip();

      if (this.#shadow) {
        const flyout = this.#shadow.querySelector('.hha-flyout');
        const root = this.#shadow.querySelector('[data-el="root"]') || this.#shadow.querySelector('.hha-root');
        const pill = this.#shadow.querySelector('[data-el="pill"]');
        const statusGroup = this.#shadow.querySelector('[data-el="pill-status-group"]');
        if (statusGroup) {
          statusGroup.setAttribute('aria-expanded', String(this._isExpanded));
        }
        if (pill && typeof pill.offsetWidth === 'number' && pill.offsetWidth > 0 && pill.offsetWidth < 300) {
          this._collapsedPillWidth = pill.offsetWidth;
        }
        if (root && typeof root.style.setProperty === 'function') {
          root.style.setProperty('--pill-width', `${this._collapsedPillWidth || 166}px`);
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

        // The switch hides the focused control (the pill counter when the panel opens,
        // anything in the panel when it closes); focus moves to its counterpart, or a
        // keyboard user is left on the page body. The counterpart stays hidden for a few
        // frames of its visibility transition and cannot take focus until then.
        const focused = this.#shadow.activeElement;
        let focusTarget = null;
        if (focused && next && pill && pill.contains(focused)) {
          focusTarget = this.#shadow.querySelector('.hha-tab-btn.active');
        } else if (focused && !next && flyout && flyout.contains(focused)) {
          focusTarget = statusGroup;
        }
        if (focusTarget && typeof requestAnimationFrame === 'function') {
          const until = Date.now() + 600;
          const tryFocus = () => {
            if (this._isExpanded !== next) return;
            if (getComputedStyle(focusTarget).visibility === 'visible') {
              focusTarget.focus({ preventScroll: true });
            } else if (Date.now() < until) {
              requestAnimationFrame(tryFocus);
            }
          };
          requestAnimationFrame(tryFocus);
        }

        if (this._animTimer) clearTimeout(this._animTimer);
        if (this._isExpanded && this._activeTab === 'queue') {
          const stream = this.#shadow.querySelector('[data-el="queue-stream"]');
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
          if (!this._isExpanded && this.#shadow) {
            const pillEl = this.#shadow.querySelector('[data-el="pill"]');
            if (pillEl && typeof pillEl.offsetWidth === 'number' && pillEl.offsetWidth > 0 && pillEl.offsetWidth < 300) {
              this._collapsedPillWidth = pillEl.offsetWidth;
              if (root && typeof root.style.setProperty === 'function') {
                root.style.setProperty('--pill-width', `${this._collapsedPillWidth}px`);
              }
            }
          }
        }, 520);
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

    setActiveTab(tabName) {
      if (!['settings', 'queue'].includes(tabName)) {
        tabName = 'settings';
      }
      this._activeTab = tabName;
      this._resetClearQueueBtn();
      this._hideTooltip();

      try {
        localStorage.setItem('hha_hud_active_tab_v2', this._activeTab);
      } catch (_) {}

      if (!this.#shadow) return;

      const root = this.#shadow.querySelector('[data-el="root"]') || this.#shadow.querySelector('.hha-root');
      if (root) {
        root.dataset.activeTab = tabName;
      }
      // The queue flyout is taller: the pill moves down while that flyout would leave the
      // window, and back to its stored place on the letter tab.
      const pos = this._placePill();
      if (pos.x !== this._pillPos.x || pos.y !== this._pillPos.y) {
        this._pillPos = pos;
        if (root) this._animateSnap(root);
      }
      this._updatePosition();

      const tabs = this.#shadow.querySelectorAll('.hha-tab-btn');
      tabs.forEach(t => {
        const isActive = t.dataset.tab === tabName;
        t.classList.toggle('active', isActive);
        t.setAttribute('aria-selected', isActive ? 'true' : 'false');
        t.tabIndex = isActive ? 0 : -1;
      });

      const panels = this.#shadow.querySelectorAll('.hha-panel');
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

      const tabsContainer = this.#shadow.querySelector('.hha-tabs');
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
        const stream = this.#shadow.querySelector('[data-el="queue-stream"]');
        if (!stream || !stream.children.length) {
          this._syncQueue();
        }
      }
    }

    _updateTabIndicator() {
      if (!this.#shadow) return;
      const indicator = this.#shadow.querySelector('[data-el="tab-indicator"]');
      const tabs = this.#shadow.querySelector('.hha-tabs');
      if (!indicator || !tabs) return;

      tabs.dataset.active = this._activeTab;

      // Measured, not hardcoded: the tab widths follow the footer layout.
      const activeTab = tabs.querySelector(`.hha-tab-btn[data-tab="${this._activeTab}"]`);
      if (!activeTab || !activeTab.offsetWidth) return;
      indicator.style.left = `${activeTab.offsetLeft}px`;
      indicator.style.width = `${activeTab.offsetWidth}px`;
    }

    _resetClearQueueBtn() {
      if (this._queueConfirmTimer) {
        clearTimeout(this._queueConfirmTimer);
        this._queueConfirmTimer = null;
      }
      if (!this.#shadow) return;
      const btn = this.#shadow.querySelector('[data-action="clear-queue"]') || this.#shadow.querySelector('[data-el="clear-queue-btn"]');
      if (btn) {
        btn.classList.remove('is-confirming');
        btn.innerHTML = `<span class="hha-btn-clear-all-text">Очистить всё</span>`;
      }
    }

    _syncQueueActions() {
      if (!this.#shadow) return;
      const count = this._queue ? this._queue.length : 0;
      if (count === 0) {
        this._resetClearQueueBtn();
      }

      const clearBtn = this.#shadow.querySelector('[data-action="clear-queue"]') || this.#shadow.querySelector('[data-el="clear-queue-btn"]');
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

    _getPillWidth() {
      if (!this._isExpanded && !this._isAnimating && this.#shadow) {
        const pill = this.#shadow.querySelector('[data-el="pill"]');
        if (pill && typeof pill.offsetWidth === 'number' && pill.offsetWidth > 0 && pill.offsetWidth < 300) {
          this._collapsedPillWidth = pill.offsetWidth;
          return pill.offsetWidth;
        }
      }
      return this._collapsedPillWidth || 166;
    }

    // The panel's real width, min(390px, 100vw - 16px) as in CSS, and the margin around it.
    // With a fixed 390 a window under 422 px put the panel's right part, the Start button
    // with it, out of the window.
    _flyoutBox(winW) {
      const width = Math.min(390, winW - 16);
      return { halfW: width / 2, padding: Math.min(16, Math.max(0, (winW - width) / 2)) };
    }

    _clampPillCoordinates(centerX, y, winW, winH) {
      const padding = 16;
      const box = this._flyoutBox(winW);
      const minX = box.padding + box.halfW;
      const maxX = Math.max(minX, winW - box.padding - box.halfW);

      const baseH = this._flyoutHeight();
      const gap = 8;
      const pillH = 36;
      const maxFlyoutH = Math.max(120, winH - 100);
      const finalH = Math.min(baseH, maxFlyoutH);

      const maxY = Math.max(padding, winH - pillH - padding);
      const minY = Math.min(maxY, finalH + gap + padding);

      return {
        x: Math.round(clamp(centerX, minX, maxX)),
        y: Math.round(clamp(y, minY, maxY))
      };
    }

    // --- DOM Assembly ---

    // The error card is filled in by _syncErrorCard().
    _render() {
      this.#shadow.innerHTML = `
        <style>${STYLES}</style>
        <div class="hha-root" data-el="root" data-active-tab="${this._activeTab}">
          <div class="hha-pill" data-el="pill">
            <div class="hha-pill-status-group" data-action="toggle-expand" data-el="pill-status-group" tabindex="0" role="button" aria-expanded="false" aria-label="Открыть настройки и очередь">
              <div class="hha-pill-status">
                <span class="hha-pill-progress" data-el="pill-progress"><span class="hha-count-item is-sent">${ICONS.send}<span class="hha-current-count" data-el="pill-current-count">0</span></span><span class="hha-count-item is-queue">${ICONS.list}<span class="hha-queue-count" data-el="pill-queue-count">0</span></span></span>
              </div>
            </div>
            <div class="hha-pill-step" data-el="pill-step" aria-hidden="true"></div>
            <button type="button" class="hha-btn-quick hha-btn-start" data-action="quick-toggle" data-el="pill-quick-btn">
              ${BTN_SWEEP}
              <span class="hha-btn-label" data-el="pill-quick-label">Старт</span>
            </button>
          </div>

          <!-- Flyout Overlay (390px wide, max 352px/552px height) -->
          <div class="hha-flyout" data-el="flyout" role="dialog" aria-modal="false" aria-label="Панель управления откликами">
            <!-- Top Header: Drag Handle & Collapse Button -->
            <header class="hha-island-header" data-el="island-header">
              <div class="hha-header-drag-handle">
                <span class="hha-header-grip"></span>
              </div>
              <div class="hha-status-line" data-el="status-line"></div>
              <button type="button" class="hha-btn-collapse" data-action="collapse-island" aria-label="Свернуть панель" data-tooltip="Свернуть (Esc)">${ICONS.close(18)}</button>
            </header>

            <!-- Error banner: above both tabs, it does not hide the letter or switch the tab -->
            <div class="hha-error-slot" data-el="error-slot" hidden>
              <div class="hha-card-error" data-el="error-card">
                <div class="hha-card-error-body" data-el="error-card-body">
                  <div class="hha-card-error-title" data-el="error-card-title"></div>
                  <div class="hha-card-error-desc" data-el="error-card-desc"></div>
                  <div class="hha-card-error-hint" data-el="error-card-hint"></div>
                  <div class="hha-card-error-code" data-el="error-card-code"></div>
                </div>
                <div class="hha-card-error-actions">
                  <button type="button" class="hha-btn-copy-error" data-action="copy-last-error" data-el="error-copy-btn" data-tooltip="Скопировать отчёт об ошибке для issue на GitHub">Скопировать</button>
                  <button type="button" class="hha-btn-dismiss-error" data-action="resolve-error" data-el="error-resolve-btn">Понятно</button>
                </div>
              </div>
            </div>

            <!-- Screen reader announcements: stops, limits, the end of the results -->
            <div class="hha-sr-only" data-el="announcer" role="status" aria-live="polite"></div>

            <!-- Floating Tooltip -->
            <div class="hha-tooltip" data-el="tooltip"></div>

            <!-- Panels -->
            <div class="hha-panels">
              <!-- Tab 1: Settings / Cover (Письмо) -->
              <div class="hha-panel ${this._activeTab === 'settings' ? 'active' : ''}" data-panel="settings" id="hha-panel-settings" role="tabpanel" aria-labelledby="hha-tab-settings"${this._activeTab === 'settings' ? '' : ' aria-hidden="true" inert'}>
                <div class="hha-card hha-card-cover" data-el="cover-card">
                  <div class="hha-switch-row">
                    <label class="hha-switch-label" for="hha-use-cover-input">
                      <span class="hha-row-label">Отправлять сопроводительное письмо</span>
                      <span class="hha-switch">
                        <input type="checkbox" role="switch" id="hha-use-cover-input" class="hha-switch-input" data-el="setting-use-cover"${this._config.useCover ? ' checked' : ''}>
                        <span class="hha-switch-slider"></span>
                      </span>
                    </label>
                  </div>
                  <div class="hha-cover-container" data-el="setting-cover-container">
                    <div class="hha-cover-backdrop" aria-hidden="true"><div class="hha-cover-highlights" data-el="cover-highlights"></div></div>
                    <textarea class="hha-cover-textarea" data-el="setting-cover-text" maxlength="${MAX_COVER_LENGTH}" placeholder="Текст сопроводительного письма..."></textarea>
                  </div>
                  <div class="hha-cover-meta">
                    <span class="hha-cover-vars" role="group" aria-label="Вставить в письмо">
                      <button type="button" class="hha-btn-letter-var" data-action="insert-letter-var" data-var="должность" data-tooltip="Название вакансии">{должность}</button>
                      <button type="button" class="hha-btn-letter-var" data-action="insert-letter-var" data-var="компания" data-tooltip="Название компании">{компания}</button>
                    </span>
                    <span class="hha-cover-status" data-el="cover-status" aria-live="polite"></span>
                    <span class="hha-cover-counter" data-el="cover-counter"></span>
                  </div>
                </div>

              </div>

              <!-- Tab 2: Queue (Очередь) -->
              <div class="hha-panel ${this._activeTab === 'queue' ? 'active' : ''}" data-panel="queue" id="hha-panel-queue" role="tabpanel" aria-labelledby="hha-tab-queue"${this._activeTab === 'queue' ? '' : ' aria-hidden="true" inert'}>
                <div class="hha-log-card">
                  <div class="hha-queue-toolbar">
                    <span class="hha-queue-toolbar-title" data-el="queue-toolbar-title">Ручной отклик</span>
                    <button type="button" class="hha-btn-clear-all" data-action="clear-queue" data-el="clear-queue-btn">
                      <span class="hha-btn-clear-all-text">Очистить всё</span>
                    </button>
                  </div>
                  <div class="hha-log-stream" data-el="queue-stream">
                    <div class="hha-log-empty">
                      <div class="hha-log-empty-icon">${ICONS.inboxEmpty}</div>
                      <div class="hha-log-empty-text">Очередь пуста</div>
                      <div class="hha-log-empty-subtext">Сюда попадают вакансии с тестами, анкетами и внешними ссылками</div>
                    </div>
                  </div>
                  <div class="hha-overlay-scrollbar" data-el="queue-scrollbar">
                    <div class="hha-overlay-thumb" data-el="queue-scroll-thumb"></div>
                  </div>
                  <!-- Undo for a removal: a misclick on the cross would lose the vacancy for 30 days -->
                  <div class="hha-snackbar" data-el="undo-bar" role="status" aria-live="polite" hidden>
                    <span class="hha-snackbar-text" data-el="undo-text"></span>
                    <button type="button" class="hha-snackbar-action" data-action="undo-remove">Вернуть</button>
                  </div>
                </div>
              </div>
            </div>

            <div class="hha-log-row" data-el="log-row">
              <span class="hha-log-row-text" data-el="log-row-text" data-tooltip="Текст письма в лог не попадает">Лог</span>
              <span class="hha-log-row-actions">
                <button type="button" class="hha-btn-copy-log" data-action="copy-log" data-el="copy-log-btn">${ICONS.copy}<span data-el="copy-log-label">Скопировать</span></button>
                <button type="button" class="hha-btn-copy-log hha-btn-clear-log" data-action="clear-log" data-el="clear-log-btn">${ICONS.trash}<span data-el="clear-log-label">Очистить</span></button>
              </span>
            </div>

            <!-- Bottom Dock: Counter on the Left + Tabs in Center + Quick Action Button on the Right -->
            <footer class="hha-island-footer">
              <div class="hha-footer-status-group" data-action="toggle-expand" data-el="footer-status-group" tabindex="0" role="button" aria-expanded="true" aria-label="Свернуть панель">
                <div class="hha-footer-status">
                  <span class="hha-footer-progress" data-el="footer-progress"><span class="hha-count-item is-sent">${ICONS.send}<span class="hha-current-count" data-el="footer-current-count">0</span></span><span class="hha-count-item is-queue">${ICONS.list}<span class="hha-queue-count" data-el="footer-queue-count">0</span></span></span>
                </div>
              </div>
              <div class="hha-tabs" data-active="${this._activeTab}" role="tablist" aria-label="Разделы панели">
                <div class="hha-tab-indicator" data-el="tab-indicator" aria-hidden="true"></div>
                <button type="button" class="hha-tab-btn ${this._activeTab === 'settings' ? 'active' : ''}" id="hha-tab-settings" role="tab" aria-controls="hha-panel-settings" aria-selected="${this._activeTab === 'settings' ? 'true' : 'false'}" tabindex="${this._activeTab === 'settings' ? '0' : '-1'}" data-action="switch-tab" data-tab="settings"><span>Письмо</span></button>
                <button type="button" class="hha-tab-btn ${this._activeTab === 'queue' ? 'active' : ''}" id="hha-tab-queue" role="tab" aria-controls="hha-panel-queue" aria-selected="${this._activeTab === 'queue' ? 'true' : 'false'}" tabindex="${this._activeTab === 'queue' ? '0' : '-1'}" data-action="switch-tab" data-tab="queue"><span>Очередь</span></button>
              </div>
              <div class="hha-footer-actions">
                <button type="button" class="hha-btn-quick hha-btn-start" data-action="quick-toggle" data-el="footer-quick-btn">
                  ${BTN_SWEEP}
                  <span class="hha-btn-label" data-el="footer-quick-label">Старт</span>
                </button>
              </div>
            </footer>
          </div>
        </div>
      `;
    }

    _bindFormEvents() {
      const useCoverCb = this.#shadow.querySelector('[data-el="setting-use-cover"]');
      const coverTextarea = this.#shadow.querySelector('[data-el="setting-cover-text"]');

      // The switch only decides whether the letter is sent; the text stays editable
      // either way, so it can be prepared before sending is turned on.
      if (useCoverCb) {
        useCoverCb.addEventListener('change', () => this.#applyConfig({ useCover: useCoverCb.checked }));
      }

      if (coverTextarea) {
        const flushCoverText = () => {
          if (this._coverDebounceTimer) {
            clearTimeout(this._coverDebounceTimer);
            this._coverDebounceTimer = null;
          }
          if (coverTextarea.value === (this._config.coverText || '')) return;
          const saved = this.#applyConfig({ coverText: coverTextarea.value });
          this._showCoverStatus(saved ? 'Сохранено' : 'Не удалось сохранить', !saved);
        };
        coverTextarea.addEventListener('scroll', () => this._syncCoverHighlights());
        coverTextarea.addEventListener('input', () => {
          this._updateCoverCounter(coverTextarea.value.length);
          this._syncCoverHighlights();
          this._syncCoverWarning(coverTextarea.value);
          if (this._coverDebounceTimer) clearTimeout(this._coverDebounceTimer);
          this._coverDebounceTimer = setTimeout(flushCoverText, 300);
        });
        coverTextarea.addEventListener('blur', flushCoverText);
        coverTextarea.addEventListener('change', flushCoverText);
      }
    }

    _updateCoverCounter(length) {
      const counter = this.#shadow?.querySelector('[data-el="cover-counter"]');
      if (!counter) return;
      counter.textContent = `${length} / ${MAX_COVER_LENGTH}`;
      counter.classList.toggle('is-near-limit', length >= MAX_COVER_LENGTH * 0.95);
    }

    _showCoverStatus(text, isError) {
      const status = this.#shadow?.querySelector('[data-el="cover-status"]');
      if (!status) return;
      if (this._coverStatusTimer) clearTimeout(this._coverStatusTimer);
      this._coverStatusTimer = null;
      status.textContent = text;
      status.classList.toggle('is-error', isError);
      status.removeAttribute('data-tooltip');
      // A save error stays until the next save; "saved" fades out and gives the place
      // back to a warning about the text, if there is one.
      if (!isError) {
        this._coverStatusTimer = setTimeout(() => {
          this._coverStatusTimer = null;
          this._renderCoverWarning();
        }, 2000);
      }
    }

    // A name in braces that is not a variable, e.g. a typo, goes into the letter as
    // written; the status line says so while the text has one.
    _syncCoverWarning(text) {
      const unknown = unknownLetterVars(text);
      this._coverWarning = unknown.length ? unknown[0] : '';
      if (!this._coverStatusTimer) this._renderCoverWarning();
    }

    _renderCoverWarning() {
      const status = this.#shadow?.querySelector('[data-el="cover-status"]');
      if (!status || (status.classList.contains('is-error') && !status.hasAttribute('data-tooltip') && status.textContent)) return;
      const name = this._coverWarning || '';
      // With sending off the text is greyed out, and the free status slot says why.
      status.textContent = name ? `${name} не подставится` : (this._config.useCover ? '' : 'Не отправляется');
      status.classList.toggle('is-error', Boolean(name));
      if (name) {
        status.setAttribute('data-tooltip', `${name} уйдёт в письме как есть: такой переменной нет. Есть {должность} и {компания}`);
      } else {
        status.removeAttribute('data-tooltip');
      }
    }

    // The tint layer under the letter: the same text with each {variable} in a mark, as
    // wide as the textarea's text area (without its scrollbar) and scrolled with it.
    _syncCoverHighlights() {
      const ta = this.#shadow?.querySelector('[data-el="setting-cover-text"]');
      const layer = this.#shadow?.querySelector('[data-el="cover-highlights"]');
      if (!ta || !layer) return;
      const text = ta.value;
      let html = '';
      let last = 0;
      for (const m of text.matchAll(LETTER_VAR_RE)) {
        html += escapeHtml(text.slice(last, m.index));
        html += `<mark${letterVarKey(m[1]) ? '' : ' class="is-unknown"'}>${escapeHtml(m[0])}</mark>`;
        last = m.index + m[0].length;
      }
      // A trailing line break needs a character after it to take its line.
      html += escapeHtml(text.slice(last)) + '\u200B';
      if (layer.innerHTML !== html) layer.innerHTML = html;
      if (ta.clientWidth) layer.style.width = `${ta.clientWidth}px`;
      layer.style.transform = `translate3d(0, ${-ta.scrollTop}px, 0)`;
    }

    #insertLetterVar(name) {
      const ta = this.#shadow?.querySelector('[data-el="setting-cover-text"]');
      if (!ta || !letterVarKey(name)) return;
      const token = `{${name}}`;
      const start = Number.isInteger(ta.selectionStart) ? ta.selectionStart : ta.value.length;
      const end = Number.isInteger(ta.selectionEnd) ? ta.selectionEnd : start;
      if (ta.value.length - (end - start) + token.length > MAX_COVER_LENGTH) return;
      ta.focus();
      ta.setSelectionRange(start, end);
      // insertText goes through the browser's edit history, so Ctrl+Z takes the variable
      // back like typed text; setRangeText bypassed it and left Ctrl+Z doing nothing.
      let done = false;
      try { done = document.execCommand('insertText', false, token); } catch (_) {}
      if (!done) {
        ta.setRangeText(token, start, end, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    // The tooltip of a variable button shows what it would get right now.
    _letterVarHint(name) {
      const key = letterVarKey(name);
      const values = this.#assistant && typeof this.#assistant.getLetterValues === 'function'
        ? this.#assistant.getLetterValues() || {}
        : {};
      // What goes in, with a real example when there is one, and what happens when the
      // page has no such name.
      const what = key === 'title' ? 'Название вакансии' : 'Название компании';
      const first = values[key] ? `${what}, например:\n${values[key]}` : `${what} со страницы hh.ru`;
      const fallback = key === 'title' ? 'вашу вакансию' : 'вашей компании';
      return `${first}\n\nЕсли названия нет, письмо не уйдёт.\nЧтобы уходило всегда, допишите запасные слова после черты: {${name}|${fallback}}`;
    }

    _bindDocumentEvents() {
      this._onDocClick = (e) => {
        // The script itself clicks buttons on the page; only a real click outside
        // the HUD should collapse it, otherwise the panel closes on every step.
        if (!e?.isTrusted) return;
        if (this._isExpanded) {
          const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
          if (!path.includes(this) && (!e.target || (typeof this.contains === 'function' && !this.contains(e.target)))) {
            this.toggleExpand(false);
          }
        }
      };
      document.addEventListener('click', this._onDocClick);

      this._onDocKeyDown = (e) => {
        if (e && e.key === 'Escape' && this._isExpanded) {
          e.preventDefault();
          this.toggleExpand(false);
        }
      };
      document.addEventListener('keydown', this._onDocKeyDown);
    }

    _bindDomEvents() {
      if (!this.#shadow || this._domEventsBound) return;
      this._domEventsBound = true;

      const root = this.#shadow.querySelector('[data-el="root"]');
      const pill = this.#shadow.querySelector('[data-el="pill"]');
      const header = this.#shadow.querySelector('[data-el="island-header"]');
      if (!root || !pill) return;

      pill.addEventListener('pointerdown', (e) => this._onPointerDown(e));
      pill.addEventListener('pointerup', this._onPointerUp);
      pill.addEventListener('pointercancel', this._onPointerUp);

      if (header) {
        header.addEventListener('pointerdown', (e) => this._onPointerDown(e));
        header.addEventListener('pointerup', this._onPointerUp);
        header.addEventListener('pointercancel', this._onPointerUp);
      }

      root.addEventListener('click', (e) => this.#handleRootClick(e));
      root.addEventListener('pointerover', (e) => {
        const target = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-tooltip]') : null;
        if (target && target.getAttribute('data-tooltip')) this._showTooltip(target);
      });
      root.addEventListener('pointerout', (e) => {
        const fromTarget = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-tooltip]') : null;
        const toTarget = e.relatedTarget && typeof e.relatedTarget.closest === 'function' ? e.relatedTarget.closest('[data-tooltip]') : null;
        if (fromTarget && fromTarget !== toTarget) this._hideTooltip();
      });
      root.addEventListener('scroll', () => this._hideTooltip(), { capture: true, passive: true });

      root.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          const target = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-action], [role="button"]') : null;
          if (target) {
            const tag = target.tagName.toLowerCase();
            if (tag !== 'button' && tag !== 'a' && tag !== 'input' && tag !== 'textarea') {
              if (e.key === ' ' || e.key === 'Spacebar') e.preventDefault();
              target.click();
            }
          }
        }
      });

      const statusGroup = this.#shadow.querySelector('[data-el="pill-status-group"]');
      if (statusGroup) {
        statusGroup.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            e.stopPropagation();
            this.toggleExpand();
          }
        });
      }

      const tablist = this.#shadow.querySelector('[role="tablist"]');
      if (tablist) {
        tablist.addEventListener('keydown', (e) => {
          const order = ['settings', 'queue'];
          const idx = order.indexOf(this._activeTab);
          const next = { ArrowRight: idx + 1, ArrowLeft: idx - 1, Home: 0, End: order.length - 1 }[e.key];
          if (next === undefined) return;
          e.preventDefault();
          const tab = order[(next + order.length) % order.length];
          this.setActiveTab(tab);
          this.#shadow.querySelector(`.hha-tab-btn[data-tab="${tab}"]`)?.focus({ preventScroll: true });
        });
      }

      // Tooltips also for the keyboard: shown on focus that came from the keyboard.
      root.addEventListener('focusin', (e) => {
        const target = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-tooltip]') : null;
        if (target && typeof target.matches === 'function' && target.matches(':focus-visible')) this._showTooltip(target);
      });
      root.addEventListener('focusout', () => this._hideTooltip());

      this._bindFormEvents();
      this._bindDocumentEvents();
      this._initOverlayScrollbar();

      // The tabs change width when a run starts or stops (the footer gives them the room of
      // the round Стоп): the indicator under the active tab is measured again every frame.
      const tabsEl = this.#shadow.querySelector('.hha-tabs');
      const indicatorEl = this.#shadow.querySelector('[data-el="tab-indicator"]');
      if (tabsEl && indicatorEl && typeof ResizeObserver === 'function') {
        this._tabsResize = new ResizeObserver(() => {
          indicatorEl.classList.add('is-tracking');
          this._updateTabIndicator();
          clearTimeout(this._tabsTrackTimer);
          this._tabsTrackTimer = setTimeout(() => indicatorEl.classList.remove('is-tracking'), 120);
        });
        this._tabsResize.observe(tabsEl);
      }
    }

    _setupThumbDrag(thumb, stream, scrollbar, onDragEnd) {
      let isDragging = false;
      let startY = 0;
      let startScrollTop = 0;
      let scrollbarRemovers = [];

      const onPointerMove = (e) => {
        if (!isDragging) return;
        const deltaY = e.clientY - startY;
        const maxThumbTop = scrollbar.clientHeight - (thumb.offsetHeight || 24);
        const maxScrollTop = stream.scrollHeight - stream.clientHeight;
        if (maxThumbTop > 0 && maxScrollTop > 0) {
          stream.scrollTop = startScrollTop + (deltaY / maxThumbTop) * maxScrollTop;
        }
      };

      const onPointerUp = (e) => {
        if (!isDragging) return;
        isDragging = false;
        thumb.classList.remove('is-dragging');
        try { thumb.releasePointerCapture(e.pointerId); } catch (_) {}
        for (const rm of scrollbarRemovers) { try { rm(); } catch (_) {} }
        scrollbarRemovers = [];
        if (typeof onDragEnd === 'function') onDragEnd();
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
        scrollbarRemovers = [
          this._addWindowListener('pointermove', onPointerMove),
          this._addWindowListener('pointerup', onPointerUp),
          this._addWindowListener('pointercancel', onPointerUp)
        ];
      });
    }

    _setupTrackClick(scrollbar, stream, thumb) {
      scrollbar.addEventListener('pointerdown', (e) => {
        if (e.target === thumb) return;
        e.preventDefault();
        const rect = scrollbar.getBoundingClientRect();
        const clickY = e.clientY - rect.top;
        const thumbH = thumb.offsetHeight || 24;
        const maxThumbTop = scrollbar.clientHeight - thumbH;
        const maxScrollTop = stream.scrollHeight - stream.clientHeight;
        if (maxThumbTop > 0) {
          const targetThumbTop = Math.max(0, Math.min(maxThumbTop, clickY - thumbH / 2));
          stream.scrollTop = (targetThumbTop / maxThumbTop) * maxScrollTop;
        }
      });
    }

    _attachOverlayScrollbar(streamSel, scrollbarSel, thumbSel) {
      const stream = this.#shadow.querySelector(streamSel);
      const scrollbar = this.#shadow.querySelector(scrollbarSel);
      const thumb = this.#shadow.querySelector(thumbSel);
      const logCard = stream ? stream.closest('.hha-log-card') : null;
      if (!stream || !logCard || !scrollbar || !thumb) return;

      let isHovered = false;
      let hideTimer = null;

      const scheduleHide = (delay = 800) => {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          if (!isHovered) scrollbar.classList.remove('is-visible');
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
        if (!isHovered) scheduleHide(800);
      }, { passive: true });

      logCard.addEventListener('mouseenter', () => {
        isHovered = true;
        if (hideTimer) clearTimeout(hideTimer);
        showScrollbar();
      });

      logCard.addEventListener('mouseleave', () => {
        isHovered = false;
        scheduleHide(300);
      });

      this._setupThumbDrag(thumb, stream, scrollbar, () => {
        if (!isHovered) scheduleHide(800);
      });

      this._setupTrackClick(scrollbar, stream, thumb);
    }

    _initOverlayScrollbar() {
      this._attachOverlayScrollbar('[data-el="queue-stream"]', '[data-el="queue-scrollbar"]', '[data-el="queue-scroll-thumb"]');
      this._updateTabIndicator();
    }
    _updateOverlayScrollbar() {
      if (!this.#shadow) return;
      const update = (streamSel, scrollbarSel, thumbSel) => {
        const stream = this.#shadow.querySelector(streamSel);
        const scrollbar = this.#shadow.querySelector(scrollbarSel);
        const thumb = this.#shadow.querySelector(thumbSel);
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

    _showError(errPayload) {
      if (!errPayload) return;
      const code = errPayload.code || 'ERROR';
      const details = errPayload.details || {};
      this._lastErrorPayload = {
        time: formatTime(),
        code,
        message: String(errPayload.message || 'Произошла непредвиденная ошибка'),
        details,
        url: details.url || window.location.href
      };

      // The banner sits above both tabs: the tab the user is on stays, the letter stays editable.
      this._syncErrorCard();
      const errorBody = this.#shadow?.querySelector('[data-el="error-card-body"]');
      if (errorBody) errorBody.scrollTop = 0;
    }

    // The panel height for the open tab, plus the error banner while it is shown.
    _flyoutHeight() {
      const base = FLYOUT_HEIGHT[this._activeTab] || FLYOUT_HEIGHT.settings;
      return base + (this._lastErrorPayload ? (this._errorSlotHeight || 0) : 0);
    }

    _syncErrorCard() {
      if (!this.#shadow) return;
      const el = (name) => this.#shadow.querySelector(`[data-el="${name}"]`);
      const err = this._lastErrorPayload;

      el('root')?.classList.toggle('has-error', Boolean(err));
      el('pill-status-group')?.classList.toggle('has-error', Boolean(err));
      const slot = el('error-slot');
      const wasShown = slot && !slot.hidden;
      if (slot) slot.hidden = !err;
      if (!err) {
        if (wasShown) this._relayout();
        return;
      }

      const { title, desc } = parseErrorDetails(err.code, err.message);
      const hint = ERROR_HINTS[err.code] || REPORT_HINT;
      el('error-card-title').textContent = title;
      el('error-card-desc').textContent = desc;
      el('error-card-desc').style.display = desc ? '' : 'none';
      el('error-card-hint').textContent = hint;
      el('error-card-code').textContent = `Код: ${err.code}` + (err.details?.vid ? ` [вакансия #${err.details.vid}]` : '');
      // A stopped run is restarted from the card in one click; otherwise the card only closes.
      el('error-resolve-btn').textContent = this._status.status === 'error' ? 'Продолжить' : 'Понятно';
      // The panel grows by the banner, so the letter and the queue keep their room.
      const h = slot ? slot.offsetHeight : 0;
      if (h !== this._errorSlotHeight || !wasShown) {
        this._errorSlotHeight = h;
        this._relayout();
      }
    }

    // After a panel height change: the pill moves if the taller panel would leave the
    // window, back to its place otherwise, and the panel takes the new height.
    _relayout() {
      const pos = this._placePill();
      if (pos.x !== this._pillPos.x || pos.y !== this._pillPos.y) {
        this._pillPos = pos;
        const root = this.#shadow?.querySelector('[data-el="root"]');
        if (root) this._animateSnap(root);
      }
      this._updatePosition();
    }

    #resolveError() {
      if (this._status.status === 'error') {
        this.#resetAfterError({ restart: true });
      } else {
        this._dismissError();
      }
    }

    async #resetAfterError({ restart = false } = {}) {
      this._dismissError();
      if (!this.#assistant) return;
      await this.#assistant.resetState();
      if (restart) this.#assistant.start();
    }

    _dismissError() {
      if (this._copyErrorTimer) {
        clearTimeout(this._copyErrorTimer);
        this._copyErrorTimer = null;
      }
      this._lastErrorPayload = null;
      if (!this.#shadow) return;
      this._syncErrorCard();

      const copyBtn = this.#shadow.querySelector('[data-el="error-copy-btn"]');
      if (copyBtn) {
        copyBtn.classList.remove('is-copied');
        if (copyBtn.dataset && copyBtn.dataset.origText) {
          copyBtn.textContent = copyBtn.dataset.origText;
          delete copyBtn.dataset.origText;
        } else {
          copyBtn.textContent = 'Скопировать';
        }
      }
    }

    #handleClearQueueAction(target) {
      if (target.disabled || (typeof target.hasAttribute === 'function' && target.hasAttribute('disabled')) || this._queue.length === 0) {
        return;
      }
      if (this._queueConfirmTimer) {
        clearTimeout(this._queueConfirmTimer);
        this._queueConfirmTimer = null;
        this._resetClearQueueBtn();
        const removed = [...(this._queue || [])];
        if (this.#assistant && typeof this.#assistant.clearManualQueue === 'function') {
          this.#assistant.clearManualQueue();
          this.#offerUndo(removed);
        } else {
          this._queue = [];
          this._syncQueue();
        }
      } else {
        target.classList.add('is-confirming');
        target.innerHTML = '<span class="hha-btn-confirm-text">Точно очистить?</span>';
        this._queueConfirmTimer = setTimeout(() => {
          this._queueConfirmTimer = null;
          this._resetClearQueueBtn();
        }, 3000);
      }
    }

    // "Убрано из очереди. Вернуть" for a few seconds after a removal. A vacancy with a
    // questionnaire is remembered for 30 days once queued, so the script would not bring
    // it back by itself: a misclick on the cross would lose it. Removals in a row add up.
    #offerUndo(items) {
      const bar = this.#shadow?.querySelector('[data-el="undo-bar"]');
      if (!bar || !items.length) return;
      this.#undoItems = (this._undoTimer ? this.#undoItems : []).concat(items);
      const n = this.#undoItems.length;
      bar.querySelector('[data-el="undo-text"]').textContent = n === 1 ? 'Убрано из очереди' : `Убрано из очереди: ${n}`;
      bar.hidden = false;
      this._armUndoTimer();
      if (!bar.dataset.bound) {
        bar.dataset.bound = '1';
        // The bar waits while the pointer or the keyboard is on it.
        bar.addEventListener('pointerenter', () => { clearTimeout(this._undoTimer); this._undoTimer = 1; });
        bar.addEventListener('pointerleave', () => this._armUndoTimer());
        bar.addEventListener('focusin', () => { clearTimeout(this._undoTimer); this._undoTimer = 1; });
        bar.addEventListener('focusout', () => this._armUndoTimer());
      }
    }

    _armUndoTimer() {
      if (this.#shadow?.querySelector('[data-el="undo-bar"]')?.hidden) return;
      if (this._undoTimer) clearTimeout(this._undoTimer);
      this._undoTimer = setTimeout(() => this._hideUndo(), 6000);
    }

    _hideUndo() {
      if (this._undoTimer) clearTimeout(this._undoTimer);
      this._undoTimer = null;
      this.#undoItems = [];
      const bar = this.#shadow?.querySelector('[data-el="undo-bar"]');
      if (bar) bar.hidden = true;
    }

    #undoRemove() {
      const items = this.#undoItems || [];
      this._hideUndo();
      for (const item of items) {
        if (this.#assistant && typeof this.#assistant.restoreManualItem === 'function') {
          this.#assistant.restoreManualItem(item);
        } else if (!this._queue.some(it => cleanVid(it.vid) === cleanVid(item.vid))) {
          this._queue = [item, ...this._queue];
        }
      }
      if (!this.#assistant) this._syncQueue();
    }

    #handleOpenVacancyAction(target, e) {
      const vid = target.dataset.vid || target.dataset.cleanVid;
      const cVid = cleanVid(target.dataset.cleanVid || vid);
      const targetCard = target.closest('.hha-queue-card') || target;
      const url = targetCard.dataset.url || target.getAttribute('href') || targetCard.getAttribute('href');
      if (url && url !== '#' && !e.target.closest('a')) {
        try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (_) {}
      }
      if (cVid) {
        if (this.#assistant && typeof this.#assistant.markManualItemViewed === 'function') {
          this.#assistant.markManualItemViewed(cVid, true);
        } else {
          const item = (this._queue || []).find(it => cleanVid(it.vid) === cVid);
          if (item) {
            item.viewed = true;
            item.viewedAt = Date.now();
            this._syncQueue();
          }
        }
      }
    }

    #handleDeleteQueueItemAction(target) {
      const vid = target.dataset.vid || target.dataset.cleanVid;
      const cVid = cleanVid(target.dataset.cleanVid || vid);
      if (!vid) return;
      const card = target.closest('.hha-queue-card');
      const removed = (this._queue || []).find(it => cleanVid(it.vid) === cVid);
      const executeRemove = () => {
        if (this.#assistant && typeof this.#assistant.removeManualItem === 'function') {
          this.#assistant.removeManualItem(vid);
        } else {
          this._queue = this._queue.filter(it => cleanVid(it.vid) !== cVid);
          this._syncQueue();
        }
        this._removingVids.delete(cVid);
        if (removed) this.#offerUndo([removed]);
      };
      if (card && !card.classList.contains('is-removing')) {
        // The list is rebuilt when another card goes; the set keeps this one collapsed
        // in the new markup instead of showing it again for the rest of its animation.
        this._removingVids.add(cVid);
        card.style.maxHeight = `${card.offsetHeight}px`;
        void card.offsetHeight;
        card.classList.add('is-removing');
        setTimeout(executeRemove, 290);
      } else {
        executeRemove();
      }
    }

    #handleRootClick(e) {
      if (this._justDragged) {
        e.stopPropagation();
        e.preventDefault();
        return;
      }

      this._hideTooltip();

      const pillTarget = e.target.closest('[data-el="pill"]');
      const isInteractive = e.target.closest('button, input, textarea, a, select') || (e.target.closest('[data-action]') && e.target.closest('[data-action]').dataset.action !== 'toggle-expand');
      const actionTarget = e.target.closest('[data-action]');

      if (pillTarget && !isInteractive && !actionTarget && !this._dragMoved) {
        this.toggleExpand();
        return;
      }

      if (!actionTarget) return;

      const action = actionTarget.dataset.action;
      const actionMap = {
        'quick-toggle': (_, ev) => { ev.stopPropagation(); this.#handleToggleAutomation(); },
        'toggle-expand': (_, ev) => { ev.stopPropagation(); this.toggleExpand(); },
        'collapse-island': (_, ev) => { ev.stopPropagation(); this.toggleExpand(false); },
        'switch-tab': (tgt, ev) => { ev.stopPropagation(); this.setActiveTab(tgt.dataset.tab); },
        'copy-last-error': (tgt, ev) => { ev.stopPropagation(); this._copyLastErrorToClipboard(tgt); },
        'resolve-error': (_, ev) => { ev.stopPropagation(); this.#resolveError(); },
        'clear-queue': (tgt, ev) => { ev.stopPropagation(); this.#handleClearQueueAction(tgt); },
        'open-vacancy': (tgt, ev) => { this.#handleOpenVacancyAction(tgt, ev); },
        'delete-queue-item': (tgt, ev) => { ev.stopPropagation(); this.#handleDeleteQueueItemAction(tgt); },
        'undo-remove': (_, ev) => { ev.stopPropagation(); this.#undoRemove(); },
        'insert-letter-var': (tgt, ev) => { ev.stopPropagation(); this.#insertLetterVar(tgt.dataset.var); },
        'copy-log': (tgt, ev) => { ev.stopPropagation(); this._copyLog(tgt); },
        'clear-log': (tgt, ev) => { ev.stopPropagation(); this.#handleClearLogAction(tgt); }
      };

      const handler = actionMap[action];
      if (handler) handler(actionTarget, e);
    }

    _fallbackCopyText(text) {
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
        `URL: ${err.url || (window.location ? window.location.href : (typeof location !== 'undefined' ? location.href : ''))}`,
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
      // As with the log: when the browser refuses the clipboard, the report goes to the
      // console and the button says so. It used to say "Скопировано" over an empty clipboard.
      this._copyText(text).then((ok) => {
        const copied = ok !== false;
        if (!copied) console.info(text);
        if (!btnEl) return;
        if (this._copyErrorTimer) {
          clearTimeout(this._copyErrorTimer);
          this._copyErrorTimer = null;
        }
        if (!btnEl.dataset || !btnEl.dataset.origText) {
          if (!btnEl.dataset) btnEl.dataset = {};
          btnEl.dataset.origText = btnEl.textContent || 'Скопировать';
        }
        btnEl.classList.toggle('is-copied', copied);
        btnEl.textContent = copied ? 'Скопировано' : 'Не вышло, отчёт в консоли';
        this._copyErrorTimer = setTimeout(() => {
          btnEl.classList.remove('is-copied');
          btnEl.textContent = (btnEl.dataset && btnEl.dataset.origText) || 'Скопировать';
          if (btnEl.dataset) delete btnEl.dataset.origText;
          this._copyErrorTimer = null;
        }, 1800);
      });
    }

    // The entry count is read when the panel opens, not on every log write.
    _syncLogRow() {
      const textEl = this.#shadow?.querySelector('[data-el="log-row-text"]');
      if (!textEl || typeof this.#assistant?.dumpLog !== 'function') return;
      const lines = this.#assistant.dumpLog().split('\n').filter(Boolean);
      const count = lines.length;
      textEl.textContent = `Лог: ${count} ${pluralRu(count, 'запись', 'записи', 'записей')}`;
      // Nothing to clear when the log holds only the mark of the last clear.
      const clearBtn = this.#shadow.querySelector('[data-el="clear-log-btn"]');
      if (clearBtn) clearBtn.hidden = !lines.some(l => !l.includes('"event":"log_cleared"'));
    }

    _resetClearLogBtn() {
      if (this._logConfirmTimer) {
        clearTimeout(this._logConfirmTimer);
        this._logConfirmTimer = null;
      }
      const btn = this.#shadow?.querySelector('[data-el="clear-log-btn"]');
      if (!btn) return;
      btn.classList.remove('is-confirming');
      const label = btn.querySelector('[data-el="clear-log-label"]');
      if (label) label.textContent = 'Очистить';
    }

    // Two clicks, like "Очистить всё" in the queue: the first asks, the second clears.
    #handleClearLogAction(btn) {
      if (typeof this.#assistant?.clearLog !== 'function') return;
      if (this._logConfirmTimer) {
        this._resetClearLogBtn();
        this.#assistant.clearLog();
        this._syncLogRow();
        return;
      }
      btn.classList.add('is-confirming');
      const label = btn.querySelector('[data-el="clear-log-label"]');
      if (label) label.textContent = 'Точно очистить?';
      this._logConfirmTimer = setTimeout(() => this._resetClearLogBtn(), 3000);
    }

    _copyLog(btnEl) {
      if (typeof this.#assistant?.dumpLog !== 'function') return;
      const text = this.#assistant.dumpLog();
      const label = btnEl?.querySelector('[data-el="copy-log-label"]');
      const show = (msg) => {
        if (!label) return;
        if (this._copyLogTimer) clearTimeout(this._copyLogTimer);
        label.textContent = msg;
        this._copyLogTimer = setTimeout(() => {
          label.textContent = 'Скопировать';
          this._copyLogTimer = null;
        }, 2000);
      };
      this._copyText(text).then((ok) => {
        if (ok === false) {
          console.info(text);
          show('Не вышло, лог в консоли');
        } else {
          show('Скопировано');
        }
      });
    }

    #handleToggleAutomation() {
      if (!this.#assistant) return;
      const now = Date.now();
      if (this._lastToggleTime && (now - this._lastToggleTime) < 250) return;
      this._lastToggleTime = now;

      if (this._status.status === 'running') {
        if (typeof this.#assistant.stop === 'function') this.#assistant.stop();
      } else if (this._status.status === 'done') {
        if (this._status.code === 'DAILY_LIMIT_REACHED') {
          this.open();
          return;
        }
        const lim = MAX_DAILY_LIMIT;
        const sent = this._progress ? this._progress.sent : 0;
        if (sent < lim) {
          this.updateStatus('idle', 'IDLE');
          this._dismissError();
          if (typeof this.#assistant.start === 'function') this.#assistant.start();
        } else {
          this.open();
          this.setActiveTab('settings');
        }
      } else if (this._status.status === 'error') {
        this.#resetAfterError();
      } else {
        const lim = MAX_DAILY_LIMIT;
        const sent = this._progress ? this._progress.sent : 0;
        if (sent >= lim && lim > 0) {
          this.updateStatus('done', 'COMPLETED');
          return;
        }
        this._dismissError();
        if (typeof this.#assistant.start === 'function') this.#assistant.start();
      }
    }

    #applyConfig(partial) {
      if (partial && typeof partial.coverText === 'string') {
        partial = { ...partial, coverText: sliceSafe(partial.coverText, MAX_COVER_LENGTH) };
      }
      this._config = { ...this._config, ...partial };
      this.updateProgress(this._progress ? this._progress.sent : 0);
      const saved = Boolean(this.#assistant?.setConfig?.(partial));
      this._syncConfig();
      return saved;
    }

    _showTooltip(target) {
      if (!this.#shadow || !target || !this._isExpanded) return;
      const text = target.dataset.var ? this._letterVarHint(target.dataset.var) : target.getAttribute('data-tooltip');
      if (!text) return;
      const tooltip = this.#shadow.querySelector('[data-el="tooltip"]');
      const flyout = this.#shadow.querySelector('[data-el="flyout"]');
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

      // 9px between the element and the tooltip leaves room for the arrow.
      const spaceAbove = targetRect.top - flyoutRect.top;
      const below = spaceAbove < tipH + 12;
      let y = below
        ? (targetRect.bottom - flyoutRect.top) + 9
        : (targetRect.top - flyoutRect.top) - tipH - 9;
      const maxY = Math.max(8, flyoutRect.height - tipH - 8);
      y = clamp(y, 8, maxY);

      tooltip.classList.toggle('is-below', below);
      tooltip.style.setProperty('--hha-arrow-x', `${Math.round(clamp(targetCenterX - x, 12, tipW - 12))}px`);
      tooltip.style.left = `${Math.round(x)}px`;
      tooltip.style.top = `${Math.round(y)}px`;
    }

    _hideTooltip() {
      if (!this.#shadow) return;
      const tooltip = this.#shadow.querySelector('[data-el="tooltip"]');
      if (tooltip) {
        tooltip.classList.remove('is-visible');
      }
    }

    // --- Drag & Drop with Pointer Capture API ---

    _onPointerDown(e) {
      if (e.target && typeof e.target.closest === 'function') {
        if (e.target.closest('button, input, textarea, a, select, [data-action="collapse-island"]')) {
          return; // Let interactive controls handle their own events
        }
      }

      // If pointer was left in a down state from a prior interrupted gesture, cleanly reset it
      if (this._isPointerDown) {
        this._isPointerDown = false;
        this._pointerId = null;
        this._dragTarget = null;
        this._dragMoved = false;
          if (this._dragWindowRemovers && this._dragWindowRemovers.length > 0) {
          for (const rm of this._dragWindowRemovers) { try { rm(); } catch (_) {} }
          this._dragWindowRemovers = [];
        }
      }

      const root = this.#shadow ? (this.#shadow.querySelector('[data-el="root"]') || this.#shadow.querySelector('.hha-root')) : null;
      if (root) {
        root.classList.add('is-dragging');
      }

      const target = e.currentTarget;
      this._isPointerDown = true;
      this._dragMoved = false;
      this._pointerId = e.pointerId;
      this._dragTarget = target;
      this._dragStartPointer = { x: e.clientX, y: e.clientY };
      this._dragStartPillPos = { ...this._pillPos };

      // Prevent native text selection and HTML5 drag-and-drop gestures from aborting the pointer capture
      if (typeof e.preventDefault === 'function') {
        e.preventDefault();
      }

      this._dragWindowRemovers = [
          this._addWindowListener('pointermove', this._onPointerMove, { capture: true }),
          this._addWindowListener('pointerup', this._onPointerUp, { capture: true }),
          this._addWindowListener('pointercancel', this._onPointerUp, { capture: true }),
          this._addWindowListener('blur', this._onPointerUp, { capture: true })
        ];

      try {
        if (target && typeof target.setPointerCapture === 'function') {
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

        const winW = window.innerWidth || 1024;
        const winH = window.innerHeight || 768;

        this._pillPos = this._clampPillCoordinates(rawCenterX, rawY, winW, winH);
        if (!this._dragRafId) {
          this._dragRafId = requestAnimationFrame(() => {
            this._dragRafId = null;
            if (this._isPointerDown) {
              this._updatePosition();
            }
          });
        }
      }
    }

    _calculateSnapping(winW, winH, root) {
      const flyoutMaxW = 390;
      const halfW = flyoutMaxW / 2;
      const padding = 16;
      const flyoutH = this._flyoutHeight();
      const gap = 8;
      const pillH = 36;
      const maxFlyoutH = Math.max(120, winH - 100);
      const finalH = Math.min(flyoutH, maxFlyoutH);
      const maxY = Math.max(padding, winH - pillH - padding);
      const minY = Math.min(maxY, finalH + gap + padding);

      let snappedX = this._pillPos.x;
      let snappedY = this._pillPos.y;
      let didSnap = false;

      if ((this._pillPos.x - halfW) < 36) {
        snappedX = 16 + halfW;
        didSnap = true;
      } else if ((winW - (this._pillPos.x + halfW)) < 36) {
        snappedX = winW - 16 - halfW;
        didSnap = true;
      }

      if ((this._pillPos.y - minY) < 36) {
        snappedY = minY;
        didSnap = true;
      } else if ((maxY - this._pillPos.y) < 36) {
        snappedY = maxY;
        didSnap = true;
      }

      if (didSnap) {
        this._pillPos = this._clampPillCoordinates(snappedX, snappedY, winW, winH);
        if (root) this._animateSnap(root);
      }
    }

    _animateSnap(root) {
      root.classList.add('is-snapping');
      if (this._snapTimer) clearTimeout(this._snapTimer);
      this._snapTimer = setTimeout(() => {
        root.classList.remove('is-snapping');
        this._snapTimer = null;
      }, 260);
    }

    _onPointerUp(e) {
      if (!this._isPointerDown) return;
      if (e && e.pointerId !== undefined && this._pointerId !== null && e.pointerId !== this._pointerId) return;
      const target = this._dragTarget || (e ? e.currentTarget : null);
      if (this._dragRafId) {
        cancelAnimationFrame(this._dragRafId);
        this._dragRafId = null;
      }
      if (this._dragWindowRemovers && this._dragWindowRemovers.length > 0) {
        for (const rm of this._dragWindowRemovers) { try { rm(); } catch (_) {} }
        this._dragWindowRemovers = [];
      }
      try {
        if (target && typeof target.releasePointerCapture === 'function' && e && e.pointerId !== undefined) {
          target.releasePointerCapture(e.pointerId);
        }
      } catch (_) {}

      const root = this.#shadow ? (this.#shadow.querySelector('[data-el="root"]') || this.#shadow.querySelector('.hha-root')) : null;
      if (root) root.classList.remove('is-dragging');

      const wasDragging = this._dragMoved;
      this._isPointerDown = false;
      this._pointerId = null;
      this._dragTarget = null;

      if (wasDragging) {
        const winW = window.innerWidth || 1024;
        const winH = window.innerHeight || 768;
        this._calculateSnapping(winW, winH, root);
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
      if (this.#shadow && typeof this.#shadow.addEventListener === 'function') {
        this.#shadow.addEventListener('click', suppress, { capture: true, once: true });
        setTimeout(() => {
          try { this.#shadow.removeEventListener('click', suppress, { capture: true }); } catch (_) {}
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

    // A smaller window only moves the pill on screen; the stored place is kept, so it
    // comes back once the window does (DevTools docked at the bottom, a split screen).
    _onResize() {
      this._pillPos = this._placePill();
      this._updatePosition();
      this._syncCoverHighlights();
    }

    // Where the pill should be in the current window: the stored distances to the nearer
    // edges, clamped so it and the panel above it fit.
    _placePill() {
      const winW = window.innerWidth || 1024;
      const winH = window.innerHeight || 768;
      const a = this._pillAnchor || { ax: 'r', dx: 219, ay: 'b', dy: 60 };
      const x = a.ax === 'r' ? winW - a.dx : a.dx;
      const y = a.ay === 'b' ? winH - a.dy : a.dy;
      return this._clampPillCoordinates(x, y, winW, winH);
    }

    _updatePosition() {
      if (!this.#shadow) return;
      const root = this.#shadow.querySelector('[data-el="root"]') || this.#shadow.querySelector('.hha-root');
      if (!root) return;

      const winW = window.innerWidth || 1024;
      const winH = window.innerHeight || 768;

      // Pill is ALWAYS at the bottom, flyout is ALWAYS above the pill
      root.classList.add('dir-up');
      root.classList.toggle('is-expanded', this._isExpanded);

      // Strict Center Anchor positioning: Center X stays stable regardless of pill width expansions
      const box = this._flyoutBox(winW);
      const minX = box.padding + box.halfW;
      const maxX = Math.max(minX, winW - box.padding - box.halfW);
      const clampedCenterX = Math.round(clamp(this._pillPos.x, minX, maxX));
      const bottomDist = Math.max(8, winH - (this._pillPos.y + 36));

      if (root.style.left !== '0px') {
        root.style.left = '0px';
        root.style.bottom = '0px';
        root.style.top = 'auto';
        root.style.right = 'auto';
        root.style.alignItems = 'end';
      }
      root.style.transform = `translate3d(${clampedCenterX}px, -${bottomDist}px, 0) translateX(-50%)`;

      if (!this._isPointerDown && typeof root.style.setProperty === 'function') {
        const pillWidth = this._getPillWidth();
        root.style.setProperty('--pill-width', `${pillWidth}px`);
        const baseH = this._flyoutHeight();
        const maxFlyoutH = Math.max(120, winH - 100);
        const finalH = Math.min(baseH, maxFlyoutH);
        root.style.setProperty('--flyout-height', `${finalH}px`);
      }

      const flyout = this.#shadow.querySelector('.hha-flyout');
      if (flyout) {
        flyout.style.maxHeight = '';
        flyout.style.height = '';
      }
    }

    // No stored place: bottom right, 24 px from the bottom edge (the default anchor).
    _restorePosition() {
      const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
      let anchor = null;
      let legacy = null;
      try {
        const v4 = JSON.parse(localStorage.getItem('hha_hud_pos_v4') || 'null');
        if (v4 && (v4.ax === 'l' || v4.ax === 'r') && (v4.ay === 't' || v4.ay === 'b') && isNum(v4.dx) && isNum(v4.dy)) {
          anchor = v4;
        } else {
          // Older versions kept window coordinates: v3 the pill centre, v2 its left edge.
          const v3 = JSON.parse(localStorage.getItem('hha_hud_pos_v3') || 'null');
          const v2 = JSON.parse(localStorage.getItem('hha_hud_pos_v2') || 'null');
          if (v3 && isNum(v3.x) && isNum(v3.y)) legacy = v3;
          else if (v2 && isNum(v2.x) && isNum(v2.y)) legacy = { x: v2.x + 83, y: v2.y };
        }
      } catch (_) {}

      this._pillAnchor = anchor;
      if (legacy) {
        this._pillPos = legacy;
        this._persistPosition();
      }
      this._pillPos = this._placePill();
      this._updatePosition();
    }

    // Keeps the place the user chose as distances to the nearer left/right and top/bottom
    // edges of the window it was chosen in.
    _persistPosition() {
      const winW = window.innerWidth || 1024;
      const winH = window.innerHeight || 768;
      const { x, y } = this._pillPos;
      this._pillAnchor = {
        ax: x > winW / 2 ? 'r' : 'l', dx: Math.round(x > winW / 2 ? winW - x : x),
        ay: y > winH / 2 ? 'b' : 't', dy: Math.round(y > winH / 2 ? winH - y : y)
      };
      try {
        localStorage.setItem('hha_hud_pos_v4', JSON.stringify(this._pillAnchor));
      } catch (_) {}
    }

    // --- State Synchronizers ---

    _syncAll() {
      this._syncStatus();
      this._syncProgress();
      this._syncConfig();
      this._syncQueue();
      this._syncLogRow();
    }

    _syncStatus() {
      if (!this.#shadow) return;
      const { status = 'idle' } = this._status || {};
      const isRunning = status === 'running';
      const isStoppedError = status === 'error';

      const root = this.#shadow.querySelector('[data-el="root"]') || this.#shadow.querySelector('.hha-root');
      if (root && (root.classList.contains('is-running') !== isRunning || root.classList.contains('is-stopped-error') !== isStoppedError)) {
        root.classList.toggle('is-running', isRunning);
        root.classList.toggle('is-stopped-error', isStoppedError);
        // The step segment appears only while running or after an error stop, so the pill changes width.
        this._updatePosition();
      }

      const quickBtns = this.#shadow.querySelectorAll('.hha-btn-quick');
      if (quickBtns.length > 0) {
        let targetClass = 'hha-btn-start';
        let targetLabel = 'Старт';
        let targetTitle = 'Запустить автоматизацию';

        if (isRunning) {
          targetClass = 'hha-btn-stop';
          targetLabel = 'Стоп';
          targetTitle = 'Остановить автоматизацию';
        } else if (status === 'done' || (this._status && this._status.code === 'DAILY_LIMIT_REACHED')) {
          // Both limits get the grey button: there is nothing to start until the limit frees.
          const code = this._status && this._status.code;
          const isLimit = code === 'DAILY_LIMIT_REACHED' || code === 'COMPLETED';
          targetClass = isLimit ? 'hha-btn-limit' : 'hha-btn-done';
          targetLabel = isLimit ? 'Лимит' : 'Готово';
          if (code === 'DAILY_LIMIT_REACHED') {
            targetTitle = `Достигнут суточный лимит HeadHunter (${MAX_DAILY_LIMIT} откликов за 24 часа)`;
          } else if (code === 'COMPLETED') {
            targetTitle = `Сегодня отправлено ${MAX_DAILY_LIMIT} откликов, это лимит скрипта. Счётчик обнулится в полночь`;
          } else {
            targetTitle = 'Вакансии в выдаче закончились. Нажмите, чтобы пройти выдачу ещё раз';
          }
        } else if (status === 'error') {
          targetClass = 'hha-btn-error';
          targetLabel = 'Сброс';
          targetTitle = `${this._stopReason().line}. Нажмите, чтобы сбросить`;
        }

        const labelChanged = this._lastBtnLabel !== targetLabel;
        this._lastBtnLabel = targetLabel;

        quickBtns.forEach(quickBtn => {
          if (quickBtn.dataset.el === 'pill-quick-btn') quickBtn.title = targetTitle;
          else quickBtn.dataset.tooltip = targetTitle;
          const desiredClassName = `hha-btn-quick ${targetClass}`;
          let labelEl = quickBtn.querySelector('.hha-btn-label');
          if (!labelEl) {
            quickBtn.innerHTML = `${BTN_SWEEP}<span class="hha-btn-label">${targetLabel}</span>`;
            labelEl = quickBtn.querySelector('.hha-btn-label');
          }
          // A newer status cancels a swap still in flight.
          if (quickBtn._swapTimer) {
            clearTimeout(quickBtn._swapTimer);
            quickBtn._swapTimer = null;
          }
          const apply = () => {
            if (quickBtn.className !== desiredClassName) quickBtn.className = desiredClassName;
            labelEl.textContent = targetLabel;
            labelEl.classList.remove('is-swapping');
            // Старт shrinks into the round Стоп under the pointer that pressed it: for a moment
            // the pointer is not a hover, or the new button flashes red at every start.
            if (labelChanged && isRunning) {
              quickBtn.classList.add('is-arriving');
              clearTimeout(quickBtn._arriveTimer);
              quickBtn._arriveTimer = setTimeout(() => quickBtn.classList.remove('is-arriving'), 700);
            }
          };
          if (this._hasSyncedStatus && labelChanged) {
            labelEl.classList.add('is-swapping');
            quickBtn._swapTimer = setTimeout(() => {
              quickBtn._swapTimer = null;
              apply();
            }, 120);
          } else {
            apply();
          }
        });
        this._hasSyncedStatus = true;
      }
      if (this._lastErrorPayload) this._syncErrorCard();
      this._syncStatusLine();
      this._announceStatus();
    }

    // Screen readers hear a run start and stop, not each step: the step line changes every
    // second during a pause. Values a page gets on load are not announced.
    _announceStatus() {
      const { status, code } = this._status;
      const key = `${status}/${code}`;
      if (key === this._announcedKey) return;
      const prev = this._announcedKey;
      this._announcedKey = key;
      if (!this._countsReady || !prev) return;
      let text = '';
      if (status === 'running') text = prev.startsWith('running/') ? '' : 'Автоматизация запущена';
      else if (status === 'error') text = this._stopReason().line;
      else if (code === 'DAILY_LIMIT_REACHED') text = 'Лимит hh.ru исчерпан, автоматизация остановлена';
      else if (code === 'COMPLETED') text = `Отправлено ${MAX_DAILY_LIMIT} откликов, дневной лимит скрипта`;
      else if (status === 'done') text = 'Вакансии в выдаче закончились';
      else if (status === 'stopped') text = 'Автоматизация остановлена';
      const box = this.#shadow?.querySelector('[data-el="announcer"]');
      if (!text || !box) return;
      box.textContent = '';
      setTimeout(() => { box.textContent = text; }, 50);
    }

    _syncProgress() {
      if (!this.#shadow) return;
      const { sent = 0, displayCurrent } = this._progress || {};
      const cur = displayCurrent !== undefined ? displayCurrent : Math.max(0, sent);

      const currentEls = this.#shadow.querySelectorAll('.hha-current-count');
      this._setCount(currentEls, cur);
      this._syncStatusLine();
    }

    // Writes a counter; when it grows (a new response, a new queued vacancy) the number
    // gives a short nudge, so a collapsed pill still shows that the run is moving.
    _setCount(els, value) {
      const text = String(value);
      els.forEach(el => {
        const prev = Number(el.textContent);
        if (el.textContent === text) return;
        el.textContent = text;
        // Not on the first values a page gets from the engine, or every load would nudge.
        if (this._countsReady && value > prev && typeof el.animate === 'function' &&
            !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
          el.animate(
            [{ transform: 'scale(1)' }, { transform: 'scale(1.25)', offset: 0.35 }, { transform: 'scale(1)' }],
            { duration: 380, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
          );
        }
      });
    }

    _summaryText() {
      const sent = this._progress ? this._progress.sent : 0;
      const queued = this._queue ? this._queue.length : 0;
      return `Отправлено сегодня: ${sent} из ${MAX_DAILY_LIMIT}, в очереди: ${queued}`;
    }

    _statusLineText() {
      const { status, code } = this._status;
      if (status === 'running') {
        const a = this._activity;
        if (!a) return 'Работаю';
        let text = ACTIVITY_TEXT[a.code] || 'Работаю';
        const secondsLeft = a.until ? Math.ceil((a.until - Date.now()) / 1000) : 0;
        if (secondsLeft > 0) text += `, ${formatSeconds(secondsLeft)}`;
        return text;
      }
      // The full limit, 200 in 24 hours, is in the button tooltip; here the line must fit.
      if (code === 'DAILY_LIMIT_REACHED') return 'Лимит hh.ru исчерпан, продолжить можно позже';
      if (code === 'COMPLETED') return `Дневной лимит скрипта: ${MAX_DAILY_LIMIT} откликов`;
      if (status === 'error') return this._stopReason().line;
      const run = this._runSummaryText();
      if (run) return run;
      if (status === 'done') return 'Вакансии в выдаче закончились';
      return this._summaryText();
    }

    // What the last run did, e.g. "За 12 мин: 27 откликов, 9 в очередь, 1 пропуск".
    // The header fits about 50 characters, so the reason it stopped goes to the
    // tooltip; the button label (Старт, Готово) shows it as well.
    _runSummaryText() {
      const r = this._lastRun;
      if (!r || !r.startedAt || !r.endedAt) return '';
      const n = (v) => Math.max(0, Number(v) || 0);
      const durationMs = r.endedAt - r.startedAt;
      const minutes = Math.round(durationMs / 60000);
      let when = 'Меньше минуты';
      if (durationMs >= 60000) {
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        when = h === 0 ? `За ${m} мин` : (m === 0 ? `За ${h} ч` : `За ${h} ч ${m} мин`);
      }
      const parts = [`${n(r.applied)} ${pluralRu(n(r.applied), 'отклик', 'отклика', 'откликов')}`];
      if (n(r.queued)) parts.push(`${n(r.queued)} в очередь`);
      if (n(r.skipped)) parts.push(`${n(r.skipped)} ${pluralRu(n(r.skipped), 'пропуск', 'пропуска', 'пропусков')}`);
      if (n(r.error)) parts.push(`${n(r.error)} ${pluralRu(n(r.error), 'ошибка', 'ошибки', 'ошибок')}`);
      return `${when}: ${parts.join(', ')}`;
    }

    _runStopReason() {
      const code = this._lastRun?.code;
      if (code === 'STOPPED_BY_USER') return 'Остановлено вручную';
      if (code === 'DONE') return 'Вакансии в выдаче закончились';
      return 'Запуск завершен';
    }

    _stopReason() {
      return STOP_REASONS[this._status.code] || STOP_REASON_DEFAULT;
    }

    _pillStepText() {
      if (this._status.status === 'error') return this._stopReason().short;
      if (this._status.status !== 'running') return '';
      const a = this._activity;
      if (!a) return 'Работаю';
      const secondsLeft = a.until ? Math.ceil((a.until - Date.now()) / 1000) : 0;
      return (ACTIVITY_SHORT[a.code] || 'Работаю') + (secondsLeft > 0 ? ` ${formatSeconds(secondsLeft)}` : '');
    }

    // While running the step has a fixed width (CSS), so the pill and its Стоп button stay
    // put through Поиск, Пауза 5 с, Жду hh.ru; a new word fades in, the countdown just
    // ticks. After an error stop the width follows the word: a width transition does not
    // run when `auto` changes with the text, so the new width is measured and the element
    // moves between two pixel values.
    _setPillStepText(text) {
      const step = this.#shadow?.querySelector('[data-el="pill-step"]');
      if (!step || step.textContent === text) return;
      const word = (t) => String(t || '').replace(/\s*\d.*$/, '');
      const isNewWord = word(step.textContent) !== word(text);
      if (this._status.status === 'running') {
        step.style.width = '';
        step.textContent = text;
        if (isNewWord && text && typeof step.animate === 'function' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
          step.animate([{ opacity: 0, transform: 'translate3d(0, 3px, 0)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
        }
        return;
      }
      const from = step.offsetWidth;
      step.textContent = text;
      step.style.width = 'auto';
      const to = step.offsetWidth;
      if (from === to) return;
      step.style.width = `${from}px`;
      void step.offsetWidth;
      step.style.width = `${to}px`;
    }

    _syncStatusLine() {
      if (this._statusLineTimer) {
        clearTimeout(this._statusLineTimer);
        this._statusLineTimer = null;
      }
      if (!this.#shadow) return;
      const text = this._statusLineText();
      const summary = this._summaryText();
      const line = this.#shadow.querySelector('[data-el="status-line"]');
      if (line) {
        line.textContent = text;
        if (this._status.status === 'error') {
          line.dataset.tooltip = ERROR_TITLES[this._status.code] || text;
        } else {
          line.dataset.tooltip = text === this._runSummaryText() ? `${this._runStopReason()}. ${text}` : text;
        }
      }
      const hover = text === summary ? summary : `${summary}\n${text}`;
      const pillGroup = this.#shadow.querySelector('[data-el="pill-status-group"]');
      if (pillGroup) {
        pillGroup.title = hover;
        pillGroup.setAttribute('aria-label', `${hover.replace(/\n/g, '. ')}. Открыть панель`);
      }
      const footerGroup = this.#shadow.querySelector('[data-el="footer-status-group"]');
      if (footerGroup) footerGroup.dataset.tooltip = hover;

      this._setPillStepText(this._pillStepText());
      this._syncDocTitle();

      const until = this._status.status === 'running' ? this._activity?.until : null;
      if (until && until > Date.now()) {
        this._statusLineTimer = setTimeout(() => this._syncStatusLine(), 1000);
      }
    }

    // The tab title gets a prefix only when the run needs attention: an error
    // stop, the daily limit or the end of the results. The prefix goes away on
    // the next start or reset.
    _docTitlePrefix() {
      const { status, code } = this._status;
      if (status === 'error') return this._stopReason().short;
      if (code === 'DAILY_LIMIT_REACHED' || code === 'COMPLETED') return 'Лимит';
      if (status === 'done') {
        return this._lastRun ? `Готово: ${Math.max(0, Number(this._lastRun.applied) || 0)}` : 'Готово';
      }
      return '';
    }

    // hh.ru can rewrite the title after the page loads, so while a prefix is
    // set an observer puts it back.
    _syncDocTitle(clear = false) {
      const prefix = clear ? '' : this._docTitlePrefix();
      const mark = prefix ? `${prefix} | ` : '';
      const prev = this._titleMark || '';
      let base = document.title;
      if (prev && base.startsWith(prev)) base = base.slice(prev.length);
      this._titleMark = mark;
      if (document.title !== mark + base) document.title = mark + base;

      if (mark && !this._titleObserver && document.head && typeof MutationObserver === 'function') {
        this._titleObserver = new MutationObserver(() => {
          const m = this._titleMark;
          if (m && !document.title.startsWith(m)) document.title = m + document.title;
        });
        this._titleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
      } else if (!mark && this._titleObserver) {
        this._titleObserver.disconnect();
        this._titleObserver = null;
      }
    }

    _renderQueueCard(item) {
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
      const isRemoving = this._removingVids.has(cVid);
      // A questionnaire the script saw: the badge counts the questions and the first one
      // is shown, so a one-line "Telegram nick" is told apart from a long test at a glance.
      const questions = item.questions && item.questions.count ? item.questions : null;
      const badgeText = questions ? `${questions.count} ${pluralRu(questions.count, 'вопрос', 'вопроса', 'вопросов')}` : reasonInfo.text;
      const badgeType = questions ? 'info' : reasonInfo.type;

      return `
        <div class="hha-queue-card ${isViewed ? 'is-viewed' : ''}${isRemoving ? ' is-removing' : ''}" data-action="open-vacancy" data-vid="${escapeHtml(rawVid || cVid)}" data-clean-vid="${escapeHtml(cVid)}" data-url="${escapeHtml(targetUrl || '#')}">
          <div class="hha-queue-card-top">
            <a href="${escapeHtml(targetUrl || '#')}" target="_blank" rel="noopener noreferrer" class="hha-queue-title-link" data-action="open-vacancy" data-vid="${escapeHtml(rawVid || cVid)}" data-clean-vid="${escapeHtml(cVid)}" data-tooltip="${escapeHtml(displayTitle)}. Откроется в новой вкладке">
              <span class="hha-queue-title-text">${escapeHtml(displayTitle)}</span>
            </a>
            <button type="button" class="hha-log-item-delete" data-action="delete-queue-item" data-vid="${escapeHtml(rawVid || cVid)}" data-clean-vid="${escapeHtml(cVid)}" data-tooltip="Убрать из очереди" aria-label="Убрать из очереди: ${escapeHtml(displayTitle)}">${ICONS.close(14)}</button>
          </div>
          ${displayEmployer ? `
          <div class="hha-queue-card-mid">
            <span class="hha-queue-employer" data-tooltip="${escapeHtml(displayEmployer)}">${escapeHtml(displayEmployer)}</span>
          </div>` : ''}
          ${questions && questions.first ? `
          <div class="hha-queue-question" data-tooltip="${escapeHtml(questions.first)}">${escapeHtml(questions.first)}</div>` : ''}
          <div class="hha-queue-card-bottom">
            ${isViewed ? `<span class="hha-queue-badge badge-viewed">Просмотрено</span>` : ''}
            <span class="hha-queue-badge badge-${escapeHtml(badgeType)}">${escapeHtml(badgeText)}</span>
            ${cleanSalary ? `<span class="hha-queue-salary" data-tooltip="${escapeHtml(item.salary || cleanSalary)}">${escapeHtml(cleanSalary)}</span>` : ''}
          </div>
        </div>
      `;
    }

    _syncQueue() {
      if (!this.#shadow) return;
      this._hideTooltip();
      this._syncQueueActions();
      const count = this._queue ? this._queue.length : 0;

      this._setCount(this.#shadow.querySelectorAll('.hha-queue-count'), count);
      const toolbarTitle = this.#shadow.querySelector('[data-el="queue-toolbar-title"]');
      if (toolbarTitle) toolbarTitle.textContent = count ? `Ждут ручного отклика: ${count}` : 'Ручной отклик';

      const queueStream = this.#shadow.querySelector('[data-el="queue-stream"]');
      if (queueStream) {
        if (this._queue && this._queue.length > 0) {
          const sorted = [...this._queue].sort((a, b) => {
            const aViewed = a.viewed ? 1 : 0;
            const bViewed = b.viewed ? 1 : 0;
            if (aViewed !== bViewed) return aViewed - bViewed;
            return (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0);
          });
          queueStream.innerHTML = sorted.map(item => this._renderQueueCard(item)).join('');
        } else {
          queueStream.innerHTML = `
            <div class="hha-log-empty">
              <div class="hha-log-empty-icon">${ICONS.inboxEmpty}</div>
              <div class="hha-log-empty-text">Очередь пуста</div>
              <div class="hha-log-empty-subtext">Сюда попадают вакансии с тестами, анкетами и внешними ссылками</div>
            </div>
          `;
        }
      }

      if (this._isExpanded && this._activeTab === 'queue' && !this._isAnimating) {
        this._updateOverlayScrollbar();
      }
      this._syncStatusLine();
    }

    _syncConfig() {
      if (!this.#shadow) return;
      const c = this._config || {};

      const useCoverCb = this.#shadow.querySelector('[data-el="setting-use-cover"]');
      const coverTextarea = this.#shadow.querySelector('[data-el="setting-cover-text"]');

      const isCoverActive = Boolean(c.useCover);
      if (useCoverCb) useCoverCb.checked = isCoverActive;
      this.#shadow.querySelector('[data-el="cover-card"]')?.classList.toggle('is-off', !isCoverActive);
      if (coverTextarea) {
        const isFocused = this.#shadow.activeElement === coverTextarea;
        if (!isFocused && coverTextarea.value !== (c.coverText || '')) {
          coverTextarea.value = c.coverText || '';
        }
        this._updateCoverCounter(coverTextarea.value.length);
        this._syncCoverWarning(coverTextarea.value);
        this._syncCoverHighlights();
      }
    }
  }

  // --- 5. Custom Element Registration & Mounting Helper ---

  if (typeof customElements !== 'undefined' && !customElements.get('hha-hud')) {
    customElements.define('hha-hud', HhaHudElement);
  }

  function mountHud() {
    if (!document.body) return null;
    let hud = document.querySelector('hha-hud');
    if (!hud) {
      hud = document.createElement('hha-hud');
      document.body.appendChild(hud);
    }
    if (hhaEngine && typeof hud.bindAssistant === 'function') {
      hud.bindAssistant(hhaEngine);
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
  }
})();
