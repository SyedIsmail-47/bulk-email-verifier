import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { stringsFrom, loadEmails } from '../src/loadEmails.js';
import { normalizeInput } from '../src/input.js';
import { createMxLookup } from '../src/mx.js';
import { REASON, STATUS, shouldChargeForStatus } from '../src/result.js';
import { runVerification } from '../src/run.js';
import { verifyEmail, verifyEmails } from '../src/verify.js';

const FOUND = {
    found: true,
    nullMx: false,
    unreachable: false,
    timedOut: false,
    hosts: ['mx.example.com'],
};

const MISSING = {
    found: false,
    nullMx: false,
    unreachable: false,
    timedOut: false,
    hosts: [],
};

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertRecord(record) {
    assert.deepEqual(Object.keys(record), [
        'email',
        'status',
        'reason',
        'isDisposable',
        'isRoleAccount',
        'isCatchAll',
        'possibleBlanketReject',
        'mxRecordFound',
        'checkedAt',
    ]);
    assert.ok(new Set(Object.values(STATUS)).has(record.status));
    assert.equal(typeof record.reason, 'string');
    assert.equal(record.reason.length > 0, true);
    assert.equal(typeof record.isDisposable, 'boolean');
    assert.equal(typeof record.isRoleAccount, 'boolean');
    assert.equal(typeof record.isCatchAll, 'boolean');
    assert.equal(typeof record.possibleBlanketReject, 'boolean');
    assert.equal(typeof record.mxRecordFound, 'boolean');
    assert.equal(Number.isNaN(Date.parse(record.checkedAt)), false);
}

function options(lookupMx, extra = {}) {
    return {
        lookupMx,
        disposableDomains: new Set(['mailinator.com']),
        checkRoleAccounts: true,
        checkCatchAll: true,
        smtpTimeoutMs: 1000,
        maxConcurrentPerDomain: 2,
        probeMailbox: async () => ({ outcome: 'unreachable', timedOut: false, catchAll: false }),
        ...extra,
    };
}

test('default input stays on synthetic addresses', () => {
    const schema = JSON.parse(readFileSync(new URL('../.actor/input_schema.json', import.meta.url), 'utf8'));
    const emails = schema.properties.emails;
    assert.deepEqual(emails.default, emails.prefill);
    assert.ok(emails.prefill.length >= 2 && emails.prefill.length <= 3);
    for (const email of emails.prefill) {
        const domain = email.split('@')[1];
        assert.ok(!domain || domain.endsWith('.invalid'), email);
    }
    assert.equal(schema.properties.smtpTimeoutMs.default, 10000);
    assert.equal(schema.properties.maxConcurrentPerDomain.default, 2);
    assert.equal(schema.properties.maxConcurrentPerDomain.maximum, 3);
    assert.equal(schema.properties.checkCatchAll.default, true);
    assert.equal(schema.properties.checkRoleAccounts.default, true);
});

test('normalizeInput applies defaults and clamps per-domain concurrency', () => {
    assert.deepEqual(normalizeInput(null), {
        emails: [],
        smtpTimeoutMs: 10000,
        maxConcurrentPerDomain: 2,
        checkCatchAll: true,
        checkRoleAccounts: true,
    });
    const clamped = normalizeInput({
        emails: 'person@mailbox-check.invalid',
        maxConcurrentPerDomain: 50,
        smtpTimeoutMs: 50,
        checkCatchAll: false,
        checkRoleAccounts: false,
    });
    assert.equal(clamped.maxConcurrentPerDomain, 3);
    assert.equal(clamped.smtpTimeoutMs, 1000);
    assert.equal(clamped.checkCatchAll, false);
    assert.equal(clamped.checkRoleAccounts, false);
    assert.deepEqual(clamped.emails, ['person@mailbox-check.invalid']);
});

test('syntax, missing MX, and role flags short-circuit before any mailbox claim', async () => {
    let lookups = 0;
    const lookupMx = async () => {
        lookups += 1;
        return FOUND;
    };
    const malformed = await verifyEmail('not-an-email', options(lookupMx));
    assertRecord(malformed);
    assert.equal(malformed.status, STATUS.invalid);
    assert.equal(malformed.reason, REASON.malformed);
    assert.equal(malformed.isRoleAccount, false);
    assert.equal(malformed.mxRecordFound, false);
    assert.equal(lookups, 0);

    let dnsQueries = 0;
    const reservedLookup = createMxLookup({
        timeoutMs: 1000,
        resolveMx: async () => {
            dnsQueries += 1;
            return [{ exchange: 'mx.example.com', priority: 1 }];
        },
    });
    let smtpCalls = 0;
    const probeMailbox = async () => {
        smtpCalls += 1;
        return { outcome: 'accepted', timedOut: false, catchAll: false };
    };
    const reserved = await verifyEmail('person@mailbox-check.invalid', options(reservedLookup, { probeMailbox }));
    assert.equal(reserved.status, STATUS.invalid);
    assert.equal(reserved.reason, REASON.noMx);
    assert.equal(reserved.isRoleAccount, false);
    assert.equal(dnsQueries, 0);
    assert.equal(smtpCalls, 0);

    const role = await verifyEmail('info@mailbox-check.invalid', options(reservedLookup, { probeMailbox }));
    assert.equal(role.status, STATUS.invalid);
    assert.equal(role.reason, REASON.noMx);
    assert.equal(role.isRoleAccount, true);
    assert.equal(role.isCatchAll, false);
    assert.equal(smtpCalls, 0);
});

test('disposable status requires an MX record; the flag is still set without one', async () => {
    let smtpCalls = 0;
    const accepted = await verifyEmail('info@mailinator.com', options(async () => FOUND, {
        probeMailbox: async () => {
            smtpCalls += 1;
            return { outcome: 'accepted', timedOut: false, catchAll: false };
        },
    }));
    assert.equal(smtpCalls, 0);
    assertRecord(accepted);
    assert.equal(accepted.status, STATUS.disposable);
    assert.equal(accepted.reason, REASON.disposable);
    assert.equal(accepted.isDisposable, true);
    assert.equal(accepted.isRoleAccount, true);
    assert.equal(accepted.mxRecordFound, true);
    assert.notEqual(accepted.status, STATUS.valid);

    const noMail = await verifyEmail('person@mailinator.com', options(async () => MISSING));
    assert.equal(noMail.status, STATUS.invalid);
    assert.equal(noMail.reason, REASON.noMx);
    assert.equal(noMail.isDisposable, true);
    assert.equal(noMail.mxRecordFound, false);
});

test('a domain that passed the cheap checks is unknown, not valid', async () => {
    const result = await verifyEmail('jane@company.example.com', options(async () => FOUND, {
        checkRoleAccounts: false,
    }));
    assert.equal(result.status, STATUS.unknown);
    assert.equal(result.reason, REASON.smtpUnreachable);
    assert.equal(result.mxRecordFound, true);
    assert.equal(result.isRoleAccount, false);
    assert.equal(result.isDisposable, false);
    assert.equal(result.isCatchAll, false);
    assert.notEqual(result.status, STATUS.valid);
    assert.notEqual(result.status, STATUS.risky);
});

test('DNS failures are unknown and a null MX is invalid', async () => {
    const timedOut = await verifyEmail('jane@company.example.com', options(async () => ({
        found: false,
        nullMx: false,
        unreachable: true,
        timedOut: true,
        hosts: [],
    })));
    assert.equal(timedOut.status, STATUS.unknown);
    assert.equal(timedOut.reason, REASON.dnsTimeout);

    const failed = await verifyEmail('jane@company.example.com', options(async () => ({
        found: false,
        nullMx: false,
        unreachable: true,
        timedOut: false,
        hosts: [],
    })));
    assert.equal(failed.status, STATUS.unknown);
    assert.equal(failed.reason, REASON.dnsFailed);

    const nullMx = await verifyEmail('jane@company.example.com', options(async () => ({
        found: false,
        nullMx: true,
        unreachable: false,
        timedOut: false,
        hosts: [],
    })));
    assert.equal(nullMx.status, STATUS.invalid);
    assert.equal(nullMx.reason, REASON.nullMx);
});

test('one failed address does not drop the others, and order is kept', async () => {
    const results = await verifyEmails(
        ['slow@one.example.com', 'not-an-email', 'fast@two.example.com'],
        options(async (domain) => {
            if (domain === 'one.example.com') throw new Error('lookup blew up');
            if (domain === 'slow.unused') await delay(20);
            return FOUND;
        }),
    );
    assert.equal(results.length, 3);
    results.forEach(assertRecord);
    assert.equal(results[0].status, STATUS.unknown);
    assert.equal(results[0].reason, REASON.checkFailed);
    assert.equal(results[1].status, STATUS.invalid);
    assert.equal(results[2].email, 'fast@two.example.com');
    assert.equal(results[2].status, STATUS.unknown);
    assert.equal(results[2].reason, REASON.smtpUnreachable);
});

test('checks for one domain stay capped while other domains overlap', async () => {
    let active = 0;
    let maxSame = 0;
    let inFlight = 0;
    let maxInFlight = 0;

    await verifyEmails(
        ['a1@same.example.com', 'a2@same.example.com', 'a3@same.example.com', 'a4@same.example.com', 'b1@other.example.com'],
        options(async (domain) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            if (domain === 'same.example.com') {
                active += 1;
                maxSame = Math.max(maxSame, active);
            }
            await delay(50);
            if (domain === 'same.example.com') active -= 1;
            inFlight -= 1;
            return FOUND;
        }, { maxConcurrentPerDomain: 2, maxParallelDomains: 10 }),
    );

    assert.equal(maxSame, 2);
    assert.ok(maxInFlight >= 3);
});

test('a busy domain does not hold the slots other domains need', async () => {
    const startedAt = new Map();
    const origin = Date.now();
    await verifyEmails(
        [
            'b1@blocked.example.com',
            'b2@blocked.example.com',
            'b3@blocked.example.com',
            'f1@free.example.com',
        ],
        options(async (domain) => {
            if (!startedAt.has(domain)) startedAt.set(domain, Date.now() - origin);
            await delay(80);
            return FOUND;
        }, { maxConcurrentPerDomain: 1, maxParallelDomains: 2 }),
    );

    assert.ok(startedAt.get('blocked.example.com') < 40);
    assert.ok(startedAt.get('free.example.com') < 40);
});

test('stringsFrom keeps an explicit blank and skips separator lines', () => {
    assert.deepEqual(stringsFrom(''), ['']);
    assert.deepEqual(stringsFrom('a@b.invalid, c@d.invalid\n\ne@f.invalid'), [
        'a@b.invalid',
        'c@d.invalid',
        'e@f.invalid',
    ]);
});

test('loadEmails reads dataset pages and key-value records', async () => {
    const emails = await loadEmails([
        'plain@mailbox-check.invalid',
        'dataset:set-1#address',
        'kv:store-1/EMAILS',
        { datasetId: 'set-2', field: 'email' },
    ], {
        async openDataset(id) {
            if (id === 'set-1') {
                return {
                    async getData({ offset }) {
                        if (offset === 0) {
                            return { items: Array.from({ length: 1000 }, () => ({ address: 'page@mailbox-check.invalid' })) };
                        }
                        return { items: [{ address: 'tail@mailbox-check.invalid' }, { address: '' }] };
                    },
                };
            }
            assert.equal(id, 'set-2');
            return {
                async getData() {
                    return { items: [{ email: 'object@mailbox-check.invalid' }] };
                },
            };
        },
        async openKeyValueStore(id) {
            assert.equal(id, 'store-1');
            return {
                async getValue(key) {
                    assert.equal(key, 'EMAILS');
                    return 'first@mailbox-check.invalid\n\nsecond@mailbox-check.invalid';
                },
            };
        },
    });

    assert.equal(emails[0], 'plain@mailbox-check.invalid');
    assert.equal(emails.filter((email) => email === 'page@mailbox-check.invalid').length, 1000);
    assert.ok(emails.includes('tail@mailbox-check.invalid'));
    assert.ok(emails.includes(''));
    assert.ok(emails.includes('first@mailbox-check.invalid'));
    assert.ok(emails.includes('second@mailbox-check.invalid'));
    assert.ok(emails.includes('object@mailbox-check.invalid'));
    assert.equal(emails.includes(''), true);
});

test('a missing key-value record fails the input instead of returning nothing', async () => {
    await assert.rejects(
        loadEmails(['kv:store-1/MISSING'], {
            async openKeyValueStore() {
                return { async getValue() { return null; } };
            },
        }),
        /has no record/,
    );
});

test('default sample run finishes with one invalid row per address and no DNS', async () => {
    const schema = JSON.parse(readFileSync(new URL('../.actor/input_schema.json', import.meta.url), 'utf8'));
    const input = normalizeInput({ emails: schema.properties.emails.default });
    let lookups = 0;
    /** @type {string[]} */
    const warnings = [];
    const pushed = [];
    const results = await runVerification(input, {
        disposableDomains: new Set(['mailinator.com']),
        resolveMx: async () => {
            lookups += 1;
            return [];
        },
        log: {
            info() {},
            warning(message) { warnings.push(String(message)); },
            error() {},
        },
        async pushResult(item) {
            pushed.push(item);
            return { eventChargeLimitReached: false };
        },
    });

    assert.equal(lookups, 0);
    assert.equal(warnings.length, 0);
    assert.equal(results.length, 3);
    assert.equal(pushed.length, 3);
    assert.deepEqual(results.map((result) => result.email), schema.properties.emails.default);
    for (const result of results) {
        assertRecord(result);
        assert.equal(result.status, STATUS.invalid);
    }
    assert.equal(results[0].reason, REASON.malformed);
    assert.equal(results[1].reason, REASON.noMx);
    assert.equal(results[1].isRoleAccount, false);
    assert.equal(results[2].email, 'info@mailbox-check.invalid');
    assert.equal(results[2].isRoleAccount, true);
    assert.equal(results[2].mxRecordFound, false);
});

test('an empty list is an input error', async () => {
    await assert.rejects(
        runVerification(normalizeInput({ emails: [] }), {
            disposableDomains: new Set(),
            async pushResult() {},
        }),
        /at least one email address/,
    );
});

test('spending limit stops saving and says how many rows were left out', async () => {
    const warnings = [];
    const results = await runVerification(normalizeInput({
        emails: [
            'one@mailbox-check.invalid',
            'two@mailbox-check.invalid',
            'three@mailbox-check.invalid',
        ],
    }), {
        disposableDomains: new Set(),
        log: {
            info() {},
            warning(message) { warnings.push(String(message)); },
            error() {},
        },
        async pushResult(item) {
            if (item.email === 'two@mailbox-check.invalid') {
                return { eventChargeLimitReached: true, chargedCount: 0 };
            }
            return { eventChargeLimitReached: false, chargedCount: 1 };
        },
    });

    assert.deepEqual(results.map((result) => result.email), ['one@mailbox-check.invalid']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /2 checked emails were not saved/);
});

test('unknown results are not charged, determined statuses are', async () => {
    assert.equal(shouldChargeForStatus(STATUS.valid), true);
    assert.equal(shouldChargeForStatus(STATUS.invalid), true);
    assert.equal(shouldChargeForStatus(STATUS.risky), true);
    assert.equal(shouldChargeForStatus(STATUS.disposable), true);
    assert.equal(shouldChargeForStatus(STATUS.unknown), false);

    /** @type {Array<{ status: string, charge: boolean }>} */
    const seen = [];
    await runVerification(normalizeInput({
        emails: [
            'not-an-email',
            'dns@timeout.example.com',
            'jane@company.example.com',
            'person@mailinator.com',
        ],
    }), {
        disposableDomains: new Set(['mailinator.com']),
        lookupMx: async (domain) => {
            if (domain === 'timeout.example.com') {
                return {
                    found: false,
                    nullMx: false,
                    unreachable: true,
                    timedOut: true,
                    hosts: [],
                };
            }
            return FOUND;
        },
        probeMailbox: async () => ({ outcome: 'unreachable', timedOut: true, catchAll: false }),
        async pushResult(item, meta) {
            seen.push({ status: item.status, charge: meta.charge });
            return { eventChargeLimitReached: false };
        },
    });

    assert.deepEqual(seen, [
        { status: STATUS.invalid, charge: true },
        { status: STATUS.unknown, charge: false },
        { status: STATUS.unknown, charge: false },
        { status: STATUS.disposable, charge: true },
    ]);
});
