import assert from 'node:assert/strict';
import test from 'node:test';

import { createDomainGate, createLimiter } from '../src/domainGate.js';
import { isDisposableDomain, loadDisposableDomains } from '../src/disposable.js';
import { createMxLookup, isReservedDomain, lookupMx, resolveMxRecords } from '../src/mx.js';
import { isRoleLocalPart } from '../src/role.js';
import { parseEmail } from '../src/syntax.js';

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test('parseEmail accepts a normal address and plus tags', () => {
    const parsed = parseEmail(' User.Name+tag@Sub.Example.co ');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.email, 'User.Name+tag@Sub.Example.co');
    assert.equal(parsed.local, 'user.name+tag');
    assert.equal(parsed.domain, 'sub.example.co');
});

test('parseEmail rejects malformed addresses', () => {
    const rejected = [
        '',
        '   ',
        'not-an-email',
        'a@b',
        'a@b.c',
        'a@@b.com',
        '@b.com',
        'a@',
        '.a@b.com',
        'a.@b.com',
        'a..b@c.com',
        'a@b..com',
        'a b@c.com',
        'user@-example.com',
        `${'a'.repeat(65)}@example.com`,
    ];
    for (const email of rejected) {
        assert.equal(parseEmail(email).ok, false, email);
    }
});

test('role detection matches shared mailboxes and ignores people', () => {
    assert.equal(isRoleLocalPart('info'), true);
    assert.equal(isRoleLocalPart('admin'), true);
    assert.equal(isRoleLocalPart('support'), true);
    assert.equal(isRoleLocalPart('no-reply'), true);
    assert.equal(isRoleLocalPart('support+ticket'), true);
    assert.equal(isRoleLocalPart('jane'), false);
    assert.equal(isRoleLocalPart('support.team'), false);
});

test('disposable match includes parent domains and ignores lookalikes', () => {
    const domains = new Set(['mailinator.com']);
    assert.equal(isDisposableDomain('mailinator.com', domains), true);
    assert.equal(isDisposableDomain('mail.mailinator.com', domains), true);
    assert.equal(isDisposableDomain('notmailinator.com', domains), false);
    assert.equal(isDisposableDomain('mailinator.com.invalid', domains), false);
});

test('vendored disposable list includes well-known domains', () => {
    const domains = loadDisposableDomains();
    assert.ok(domains.size > 1000);
    assert.equal(domains.has('mailinator.com'), true);
    assert.equal(domains.has('guerrillamail.com'), true);
    assert.equal(domains.has('yopmail.com'), true);
});

test('reserved domains are not looked up', async () => {
    assert.equal(isReservedDomain('mailbox-check.invalid'), true);
    assert.equal(isReservedDomain('foo.example'), true);
    assert.equal(isReservedDomain('foo.test'), true);
    assert.equal(isReservedDomain('foo.localhost'), true);
    assert.equal(isReservedDomain('example.com'), false);

    let calls = 0;
    const result = await lookupMx('mailbox-check.invalid', {
        timeoutMs: 1000,
        resolveMx: async () => {
            calls += 1;
            return [{ exchange: 'mx.example.com', priority: 1 }];
        },
    });
    assert.equal(calls, 0);
    assert.equal(result.found, false);
    assert.equal(result.unreachable, false);
});

test('lookupMx classifies records, null MX, and DNS failures', async () => {
    const found = await lookupMx('example.com', {
        timeoutMs: 1000,
        resolveMx: async () => [
            { exchange: 'b.example.com.', priority: 20 },
            { exchange: '.', priority: 0 },
            { exchange: 'A.Example.com', priority: 10 },
        ],
    });
    assert.equal(found.found, true);
    assert.deepEqual(found.hosts, ['a.example.com', 'b.example.com']);

    const nullMx = await lookupMx('example.com', {
        timeoutMs: 1000,
        resolveMx: async () => [{ exchange: '.', priority: 0 }],
    });
    assert.equal(nullMx.found, false);
    assert.equal(nullMx.nullMx, true);

    const missing = await lookupMx('example.com', {
        timeoutMs: 1000,
        resolveMx: async () => {
            const error = new Error('not found');
            error.code = 'ENOTFOUND';
            throw error;
        },
    });
    assert.equal(missing.found, false);
    assert.equal(missing.unreachable, false);

    const failed = await lookupMx('example.com', {
        timeoutMs: 1000,
        resolveMx: async () => {
            const error = new Error('servfail');
            error.code = 'ESERVFAIL';
            throw error;
        },
    });
    assert.equal(failed.unreachable, true);
    assert.equal(failed.timedOut, false);

    const refused = await lookupMx('example.com', {
        timeoutMs: 1000,
        resolveMx: async () => {
            const error = new Error('refused');
            error.code = 'ECONNREFUSED';
            throw error;
        },
    });
    assert.equal(refused.found, false);
    assert.equal(refused.unreachable, true);
});

test('a refused system resolver falls through, and a real answer does not', async () => {
    const found = await resolveMxRecords('example.com', [
        async () => {
            const error = new Error('refused');
            error.code = 'ECONNREFUSED';
            throw error;
        },
        async () => [{ exchange: 'mx.example.com', priority: 1 }],
    ]);
    assert.deepEqual(found, [{ exchange: 'mx.example.com', priority: 1 }]);

    await assert.rejects(
        resolveMxRecords('example.com', [
            async () => {
                const error = new Error('not found');
                error.code = 'ENOTFOUND';
                throw error;
            },
            async () => {
                throw new Error('fallback should not run');
            },
        ]),
        (error) => error.code === 'ENOTFOUND',
    );
});

test('lookupMx reports a timeout without hanging', async () => {
    const result = await lookupMx('example.com', {
        timeoutMs: 20,
        resolveMx: () => new Promise(() => {}),
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.unreachable, true);
    assert.equal(result.found, false);
});

test('MX lookups for one domain are shared', async () => {
    let calls = 0;
    const lookup = createMxLookup({
        timeoutMs: 1000,
        resolveMx: async () => {
            calls += 1;
            await delay(30);
            return [{ exchange: 'mx.example.com', priority: 10 }];
        },
    });
    const [first, second] = await Promise.all([
        lookup('Example.com'),
        lookup('example.com'),
    ]);
    assert.equal(calls, 1);
    assert.equal(first, second);
    await lookup('example.com');
    assert.equal(calls, 1);
});

test('domain gate keeps a per-domain cap and still overlaps other domains', async () => {
    const gate = createDomainGate(2);
    let active = 0;
    let max = 0;
    const job = (domain) => gate(domain, async () => {
        active += 1;
        max = Math.max(max, active);
        await delay(40);
        active -= 1;
    });

    max = 0;
    await Promise.all([
        job('a.com'),
        job('a.com'),
        job('a.com'),
        job('a.com'),
    ]);
    assert.equal(max, 2);

    let overlap = 0;
    let maxOverlap = 0;
    const single = createDomainGate(1);
    const cross = (domain) => single(domain, async () => {
        overlap += 1;
        maxOverlap = Math.max(maxOverlap, overlap);
        await delay(40);
        overlap -= 1;
    });
    await Promise.all([cross('a.com'), cross('b.com')]);
    assert.equal(maxOverlap, 2);
});

test('domain gate refuses more than 3 concurrent checks even if asked', async () => {
    const gate = createDomainGate(10);
    let active = 0;
    let max = 0;
    await Promise.all(Array.from({ length: 8 }, () => gate('a.com', async () => {
        active += 1;
        max = Math.max(max, active);
        await delay(30);
        active -= 1;
    })));
    assert.equal(max, 3);
});

test('limiter releases a slot after a failure', async () => {
    const limit = createLimiter(1);
    await assert.rejects(limit(async () => {
        throw new Error('boom');
    }));
    const value = await limit(async () => 'ok');
    assert.equal(value, 'ok');
});
