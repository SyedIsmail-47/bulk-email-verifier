import { loadDisposableDomains } from './disposable.js';
import { loadEmails } from './loadEmails.js';
import { createMxLookup } from './mx.js';
import { STATUS, shouldChargeForStatus } from './result.js';
import { verifyEmails } from './verify.js';

/** Pay-per-event name. Create this event when pricing the Actor on Apify. */
export const EMAIL_CHECKED_EVENT = 'email-checked';

const silentLog = {
    info() {},
    warning() {},
    error() {},
};

/**
 * @param {ReturnType<import('./input.js').normalizeInput>} input
 * @param {{
 *   pushResult: (item: Record<string, unknown>) => Promise<{ eventChargeLimitReached?: boolean, chargedCount?: number } | void>,
 *   openDataset?: Parameters<typeof loadEmails>[1]['openDataset'],
 *   openKeyValueStore?: Parameters<typeof loadEmails>[1]['openKeyValueStore'],
 *   disposableDomains?: Set<string>,
 *   resolveMx?: (domain: string) => Promise<Array<{ exchange: string, priority: number }>>,
 *   lookupMx?: (domain: string) => Promise<import('./mx.js').MxLookup>,
 *   probeMailbox?: typeof import('./smtp.js').probeMailbox,
 *   maxParallelDomains?: number,
 *   log?: { info: (...args: unknown[]) => void, warning: (...args: unknown[]) => void, error: (...args: unknown[]) => void },
 * }} deps
 */
export async function runVerification(input, deps) {
    const log = deps.log ?? silentLog;
    const emails = await loadEmails(input.emails, deps);
    if (emails.length === 0) {
        throw new Error('Input emails must contain at least one email address.');
    }

    log.info(`Checking ${emails.length} email address${emails.length === 1 ? '' : 'es'}`);
    log.info(`At most ${input.maxConcurrentPerDomain} checks run at once per domain. Network timeout is ${input.smtpTimeoutMs}ms.`);
    log.info(input.checkCatchAll
        ? 'Catch-all detection runs on the same SMTP connection as the mailbox check.'
        : 'Catch-all detection is off.');

    const lookupMx = deps.lookupMx ?? createMxLookup({
        timeoutMs: input.smtpTimeoutMs,
        resolveMx: deps.resolveMx,
    });
    const results = await verifyEmails(emails, {
        lookupMx,
        disposableDomains: deps.disposableDomains ?? loadDisposableDomains(),
        checkRoleAccounts: input.checkRoleAccounts,
        checkCatchAll: input.checkCatchAll,
        smtpTimeoutMs: input.smtpTimeoutMs,
        probeMailbox: deps.probeMailbox,
        maxConcurrentPerDomain: input.maxConcurrentPerDomain,
        maxParallelDomains: deps.maxParallelDomains,
    });

    const counts = {
        [STATUS.valid]: 0,
        [STATUS.invalid]: 0,
        [STATUS.risky]: 0,
        [STATUS.disposable]: 0,
        [STATUS.unknown]: 0,
    };

    /** @type {typeof results} */
    const stored = [];
    for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        const charge = await deps.pushResult(result, {
            charge: shouldChargeForStatus(result.status),
        });
        const reachedLimit = charge?.eventChargeLimitReached === true;
        const storedThisOne = !(reachedLimit && charge?.chargedCount === 0);
        if (storedThisOne) {
            stored.push(result);
            counts[result.status] += 1;
            log.info(`${result.email} → ${result.status} (${result.reason})`);
        }
        if (reachedLimit) {
            const unsaved = results.length - stored.length;
            if (unsaved > 0) {
                log.warning(`Spending limit reached. ${unsaved} checked ${unsaved === 1 ? 'email was' : 'emails were'} not saved.`);
            }
            break;
        }
    }

    log.info(
        `Finished ${stored.length} of ${results.length}. `
        + `valid=${counts[STATUS.valid]} invalid=${counts[STATUS.invalid]} `
        + `risky=${counts[STATUS.risky]} disposable=${counts[STATUS.disposable]} `
        + `unknown=${counts[STATUS.unknown]}`,
    );
    return stored;
}
