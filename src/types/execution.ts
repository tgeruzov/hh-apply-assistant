export const EXECUTION_STATUS = {
    SUCCESS: 'SUCCESS',
    SKIPPED: 'SKIPPED',
    NAVIGATED: 'NAVIGATED',
    STOPPED: 'STOPPED',
    CAPTCHA: 'CAPTCHA'
} as const;

export type ExecutionStatus = (typeof EXECUTION_STATUS)[keyof typeof EXECUTION_STATUS];

export const EXECUTION_REASON = {
    APPLIED: 'APPLIED',
    RETURNING_TO_LIST: 'RETURNING_TO_LIST',
    VACANCY_PAGE: 'VACANCY_PAGE',
    RESPONSE_PAGE: 'RESPONSE_PAGE',
    NO_LINK: 'NO_LINK',
    NO_HREF: 'NO_HREF',
    UNKNOWN: 'UNKNOWN',
    UNRECOGNIZED_CODE: 'UNRECOGNIZED_CODE'
} as const;

export type ExecutionReason = (typeof EXECUTION_REASON)[keyof typeof EXECUTION_REASON];

export interface ExecutionResultData {
    status: string;
    reason: string;
    code: string;
}

export type TerminalCode =
    | 'OK'
    | 'RETURNED'
    | 'NAVIGATED'
    | 'REDIRECT'
    | 'STOPPED'
    | 'CAPTCHA'
    | 'ERROR_NO_LINK'
    | 'ERROR_NO_HREF'
    | 'ERROR_UNKNOWN'
    | string;

export type ResponseOutcomeKind =
    | 'SUCCESS'
    | 'SUBMITTED'
    | 'ATTACH_COVER'
    | 'MODAL_OPEN'
    | 'REJECT_WARNING'
    | 'RELOCATION_WARNING'
    | 'QUESTIONNAIRE'
    | 'DIRECT_CHAT'
    | 'CAPTCHA'
    | 'NO_LINK'
    | 'UNKNOWN'
    | 'ERROR';

export interface ResponseOutcome {
    kind: ResponseOutcomeKind;
    details?: string;
    error?: unknown;
}
