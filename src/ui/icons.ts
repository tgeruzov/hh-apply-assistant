export const UI_ICONS = Object.freeze({
    chevronDown: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.75 8 10 12.25 14.25 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    help: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.55"/><path d="M8.65 7.7a1.9 1.9 0 1 1 2.42 2.82c-.7.29-1.07.8-1.07 1.45" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="14.35" r=".85" fill="currentColor"/></svg>',
    arrowLeft: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11.75 5.5 7.25 10l4.5 4.5M7.6 10H15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    search: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8.6" cy="8.6" r="4.55" stroke="currentColor" stroke-width="1.65"/><path d="m12.05 12.05 3.7 3.7" stroke="currentColor" stroke-width="1.65" stroke-linecap="round"/></svg>',
    close: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="m6.25 6.25 7.5 7.5m0-7.5-7.5 7.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>',
    trash: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7.25 4.75h5.5M8 4.75v-.5A1.25 1.25 0 0 1 9.25 3h1.5A1.25 1.25 0 0 1 12 4.25v.5m-6 1.5h8l-.52 8.06A1.5 1.5 0 0 1 11.98 16H8.02a1.5 1.5 0 0 1-1.5-1.69L6 6.25Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.85 8.75v4.1M11.15 8.75v4.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    inbox: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 6.5a1.5 1.5 0 0 1 1.5-1.5h9A1.5 1.5 0 0 1 16 6.5v8a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 14.5v-8Z" stroke="currentColor" stroke-width="1.5"/><path d="M4 11.5h3.25a1.25 1.25 0 0 0 1.2 0.9h3.1a1.25 1.25 0 0 0 1.2-.9H16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
} as const);

export const uiIcon = (name: keyof typeof UI_ICONS | string, modifier = ''): string => {
    const svg = (UI_ICONS as any)[name] || '';
    const modifierClass = modifier ? ` ar-icon-svg--${modifier}` : '';
    return `<span class="ar-icon-svg${modifierClass}" aria-hidden="true">${svg}</span>`;
};
