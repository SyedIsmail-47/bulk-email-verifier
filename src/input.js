/**
 * Apply the same defaults as `.actor/input_schema.json` for local runs.
 * Per-domain concurrency is clamped to 1–3 so a raw API call cannot
 * open a pile of connections to one mail server.
 * @param {Record<string, unknown> | null | undefined} raw
 */
export function normalizeInput(raw = {}) {
    const input = raw ?? {};
    return {
        emails: normalizeEmailSources(input.emails),
        smtpTimeoutMs: clampInt(input.smtpTimeoutMs, 10_000, 1_000, 120_000),
        maxConcurrentPerDomain: clampInt(input.maxConcurrentPerDomain, 2, 1, 3),
        checkCatchAll: input.checkCatchAll !== false,
        checkRoleAccounts: input.checkRoleAccounts !== false,
    };
}

/**
 * @param {unknown} emails
 */
function normalizeEmailSources(emails) {
    if (emails == null) return [];
    if (typeof emails === 'string' || (typeof emails === 'object' && !Array.isArray(emails))) {
        return [emails];
    }
    if (Array.isArray(emails)) return emails;
    return [];
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function clampInt(value, fallback, min, max) {
    const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
    return Math.min(max, Math.max(min, number));
}
