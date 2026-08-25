export function deepFreeze<T>(obj: T): T {
    if (!obj || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
    Object.freeze(obj);
    for (const key of Object.getOwnPropertyNames(obj)) {
        const val = (obj as Record<string, unknown>)[key];
        if (val && typeof val === 'object') {
            deepFreeze(val);
        }
    }
    return obj;
}

export const HHA_PREFERRED_PANEL_WIDTH = 410;
export const HHA_MIN_PANEL_WIDTH = 340;
// Minimum practical width reserved for hh.ru desktop layout before compact assistant mode is used.
export const HHA_MIN_HOST_WIDTH = 980;

export const TUNING = deepFreeze({
    scrollStepMs: 200,        // шаг человеческого скролла
    waitForModalMs: 8000,     // ожидание реакции после клика Откликнуться
    confirmWaitMs: 6000,      // ожидание подтверждения после отправки формы
    responsePagePendingMs: 16000, // обычный full-page submit ждём без повторного клика
    instanceLockTtl: 30000,   // TTL кросс-вкладочной блокировки
    forceSubmitAttempts: 3    // попыток повторных отправок при предупреждении об отказе
});

export const DIAG_LOG_MAX = 1000;
export const DOM_SNAPSHOT_MAX = 15;

export const SELECTORS = deepFreeze({
    // Кнопка "Откликнуться" в карточке результатов поиска
    applyBtn: '[data-qa="vacancy-serp__vacancy_response"], button[data-qa="vacancy-serp__vacancy_response"]',
    // Кнопки "Откликнуться" на странице самой вакансии (верхняя/нижняя)
    vacancyApply: '[data-qa="vacancy-response-link-top"], a[data-qa="vacancy-response-link-top"], [data-qa="vacancy-response-link-bottom"], a[data-qa="vacancy-response-link-bottom"]',
    // Сценарий А: резюме уже отправлено, предлагается прикрепить сопроводительное
    attachCoverBtn: '[data-qa="responded-success-attach-cover-letter"]',
    // Кнопка/переключатель "прикрепить сопроводительное" ВНУТРИ формы отклика (до отправки):
    // раскрывает скрытое поле письма. Модалка и полностраничная форма, новая и legacy-вёрстка.
    attachCoverInModal: '[data-qa="responded-success-attach-cover-letter"], [data-qa="add-cover-letter"], button[data-qa="add-cover-letter"], [data-qa="vacancy-response-letter-toggle"]',
    // Поле ввода сопроводительного письма (новая вёрстка + фоллбек на старую)
    letterTextarea: 'textarea[name="text"], textarea[data-qa="vacancy-response-popup-form-letter-input"], textarea[name="coverLetter"]',
    // Кнопка отправки формы сопроводительного (новая вёрстка + фоллбек)
    letterSubmit: '[data-qa="vacancy-response-letter-submit"], button[data-qa="vacancy-response-letter-submit"], button[data-qa="vacancy-response-submit-popup"], [data-qa="vacancy-response-submit-popup"]',
    // Подтверждение успешной отправки отклика (кнопка перехода в чат)
    responseChat: '[data-qa="vacancy-response-link-view-topic"]',
    nativeWrapper: '[data-qa="textarea-native-wrapper"]',
    relocationBtn: '[data-qa="relocation-warning-confirm"]',
    rejectWarning: '[data-qa="response-reject-warning"]',
    vacancyLink: 'a[data-qa="serp-item__title"], a[data-qa="vacancy-serp__vacancy-title"]',
    vacancyCard: 'div[data-qa="vacancy-serp__vacancy"], .vacancy-serp-item'
});
