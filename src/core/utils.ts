// Безусловная пауза для системной инфраструктуры (например, instance lock 60ms race window, UI)
export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

export const randBetween = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1)) + min;

export const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

export const toNum = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
};

// Нормализация пробелов в тексте DOM/заголовка.
export const collapseSpaces = (s: unknown): string => String(s || '').replace(/\s+/g, ' ').trim();

// Простой стабильный хеш (FNV-1a 32) - запасной вариант генерации ID
export function fnv1a32(str: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
        h >>>= 0;
    }
    return h >>> 0;
}

// Разрешаем только http(s)-ссылки на домены hh.ru - защита от подстановки мусора в хранилище.
export const toSafeHhUrl = (rawUrl: unknown): string => {
    if (!rawUrl) return '';
    try {
        const u = new URL(String(rawUrl), typeof location !== 'undefined' ? location.href : 'https://hh.ru');
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
        if (!/(^|\.)(hh\.ru|localhost|127\.0\.0\.1)$/i.test(u.hostname)) return '';
        return u.href;
    } catch (e) {
        return '';
    }
};

export const parseJson = <T>(raw: string | null | undefined, fallback: T): T => {
    if (raw === null || raw === undefined) return fallback;
    try {
        const v = JSON.parse(raw);
        return v === null || v === undefined ? fallback : v;
    } catch (e) {
        return fallback;
    }
};

export const safeJsonStringify = (value: unknown, fallback = '{}'): string => {
    try {
        return JSON.stringify(value);
    } catch (e) {
        return fallback;
    }
};

const ESC_MAP: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
};

export const escHtml = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (ch) => ESC_MAP[ch] || ch);

// Приводим любое сырое имя вакансии к читаемому виду: снимаем счётчик непрочитанных
// из заголовка вкладки, разбираем SEO-обёртку hh.ru и служебные хвосты сайта.
// Используется и при парсинге со страницы, и при рендере уже сохранённых записей.
export function prettifyTitle(raw: unknown): string {
    let t = collapseSpaces(raw);
    if (!t) return '';
    // 1. Счётчик непрочитанных из вкладки: "(99+)", "(5)", "99+ · ", "12 • "
    t = t.replace(/^\(\s*\d+\+?\s*\)\s*/, '');
    t = t.replace(/^\d+\+?\s*[\u00b7\u2022\u2024\u2027\u30fb|]\s*/g, '');
    // 2. Английская SEO-обёртка hh.ru: "Vacancy {X} in {city}, job in {company}"
    //    Граница между должностью и городом: последнее " in " перед ", job in "
    let m = t.match(/^Vacancy\s+(.+),\s*job\s+in\s+(.+?)\s*$/i);
    if (m) {
        let titlePart = m[1];
        // Убираем " in {city}" с конца titlePart (последнее вхождение)
        const lastIn = titlePart.lastIndexOf(' in ');
        if (lastIn > 0) titlePart = titlePart.substring(0, lastIn);
        const pos = collapseSpaces(titlePart);
        const comp = collapseSpaces(m[2]).replace(/\s*[\u2014\u2013|-]\s*hh\.ru.*$/i, '');
        return [pos, comp].filter(Boolean).join(' \u00b7 ').slice(0, 300);
    }
    // 3. Английская SEO-обёртка без компании: "Vacancy {X} in {city}"
    m = t.match(/^Vacancy\s+(.+?)\s+in\s+[^,]+?\s*$/i);
    if (m) {
        // Аналогично: последнее " in " - это город, всё до него - должность
        let titlePart = m[1];
        const lastIn = titlePart.lastIndexOf(' in ');
        if (lastIn > 0) titlePart = titlePart.substring(0, lastIn);
        return collapseSpaces(titlePart).slice(0, 300);
    }
    // 4. Русский SEO-хвост: "... - работа в ...", "... - вакансия ...".
    t = t.replace(/\s*[\u2014\u2013-]\s*(работа|вакансия)(?![а-яё]).*$/i, '');
    // 5. Общий хвост сайта: "- hh.ru", "на hh.ru"
    t = t.replace(/\s*(?:[\u2014\u2013|-]\s*)?(?:на\s+)?hh\.ru\s*$/i, '');
    // 6. Ведущее "Вакансия "/"Vacancy "
    t = t.replace(/^(вакансия|vacancy)\s+/i, '');
    return t.replace(/[\u00b7\u2022|,\s]+$/, '').trim().slice(0, 300);
}
