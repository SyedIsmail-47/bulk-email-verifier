import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { REASON, STATUS, shouldChargeForStatus } from '../src/result.js';
import { probeMailbox, repliesLookUniform } from '../src/smtp.js';
import { verifyEmail } from '../src/verify.js';

const FOUND = {
    found: true,
    nullMx: false,
    unreachable: false,
    timedOut: false,
    hosts: ['127.0.0.1'],
};

/**
 * @param {(socket: import('node:net').Socket, state: { connections: number, commands: string[] }) => void} onConnection
 * @param {(port: number, state: { connections: number, commands: string[] }) => Promise<void>} fn
 */
async function withServer(onConnection, fn) {
    /** @type {Set<import('node:net').Socket>} */
    const sockets = new Set();
    const state = { connections: 0, commands: [] };
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        state.connections += 1;
        onConnection(socket, state);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const port = server.address().port;
    try {
        await fn(port, state);
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
}

/**
 * @param {(line: string, commands: string[]) => string | null} replyFor
 */
function scripted(replyFor) {
    return (socket, state) => {
        socket.setEncoding('utf8');
        let buffer = '';
        const send = (line) => {
            if (line != null) socket.write(`${line}\r\n`);
        };
        send('220 mx.test ESMTP');
        socket.on('data', (chunk) => {
            buffer += chunk;
            let newline = buffer.indexOf('\n');
            while (newline !== -1) {
                const line = buffer.slice(0, newline).replace(/\r$/, '');
                buffer = buffer.slice(newline + 1);
                state.commands.push(line);
                const reply = replyFor(line, state.commands);
                if (reply == null) return;
                send(reply);
                if (line.toUpperCase().startsWith('QUIT')) socket.end();
                newline = buffer.indexOf('\n');
            }
        });
    };
}

/**
 * @param {number} port
 * @param {{ checkCatchAll?: boolean, smtpTimeoutMs?: number }} [extra]
 */
function check(port, extra = {}) {
    return verifyEmail('jane@company.example.com', {
        lookupMx: async () => FOUND,
        disposableDomains: new Set(),
        checkRoleAccounts: false,
        checkCatchAll: extra.checkCatchAll !== false,
        smtpTimeoutMs: extra.smtpTimeoutMs ?? 2000,
        probeMailbox: (args) => probeMailbox({ ...args, port }),
    });
}

test('an accepted mailbox is valid when the catch-all probe is rejected', async () => {
    await withServer(scripted((line, commands) => {
        const command = line.toUpperCase();
        if (command.startsWith('DATA')) return '550 no mail is accepted';
        if (command.startsWith('RCPT')) {
            const recipients = commands.filter((entry) => entry.toUpperCase().startsWith('RCPT')).length;
            return recipients === 1 ? '250 ok' : '550 no such user';
        }
        if (command.startsWith('QUIT')) return '221 bye';
        return '250 ok';
    }), async (port, state) => {
        const result = await check(port);
        assert.equal(result.status, STATUS.valid);
        assert.equal(result.reason, REASON.mailboxAccepted);
        assert.equal(result.isCatchAll, false);
        assert.equal(result.mxRecordFound, true);
        assert.equal(state.connections, 1);
        const commands = state.commands.map((line) => line.toUpperCase());
        assert.ok(commands.some((line) => line.startsWith('HELO ')));
        assert.ok(commands.some((line) => line.startsWith('MAIL FROM:')));
        assert.equal(commands.filter((line) => line.startsWith('RCPT TO:')).length, 2);
        assert.ok(commands.some((line) => line.startsWith('QUIT')));
        assert.equal(commands.some((line) => line.startsWith('DATA')), false);
    });
});

test('different 5xx replies still mark the mailbox invalid', async () => {
    let recipients = 0;
    await withServer(scripted((line) => {
        const command = line.toUpperCase();
        if (command.startsWith('RCPT')) {
            recipients += 1;
            return recipients === 1
                ? '550 5.1.1 User unknown'
                : '553 5.7.1 Relay access denied';
        }
        if (command.startsWith('QUIT')) return '221 bye';
        return '250 ok';
    }), async (port, state) => {
        const result = await check(port);
        assert.equal(result.status, STATUS.invalid);
        assert.equal(result.reason, REASON.mailboxRejected);
        assert.equal(result.possibleBlanketReject, false);
        assert.equal(result.isCatchAll, false);
        assert.equal(shouldChargeForStatus(result.status), true);
        assert.equal(state.connections, 1);
        assert.equal(state.commands.filter((line) => line.toUpperCase().startsWith('RCPT')).length, 2);
    });
});

test('identical 554 replies are an indeterminate blanket rejection', async () => {
    const real = '554 5.1.1 <jane@company.example.com>: Recipient address rejected: undeliverable address: Mailbox might be disabled, full, or may not exist on the server. Reason: JFE030050';
    const fake = '554 5.1.1 <no-such-mailbox-abc@company.example.com>: Recipient address rejected: undeliverable address: Mailbox might be disabled, full, or may not exist on the server. Reason: JFE030050';
    assert.equal(repliesLookUniform(
        { code: 554, lines: [real] },
        { code: 554, lines: [fake] },
    ), true);
    assert.equal(repliesLookUniform(
        { code: 550, lines: ['550 5.1.1 User unknown'] },
        { code: 553, lines: ['553 5.7.1 Relay access denied'] },
    ), false);

    await withServer(scripted((line) => {
        const command = line.toUpperCase();
        if (command.startsWith('RCPT')) {
            const recipient = line.slice(line.indexOf('<') + 1, line.indexOf('>'));
            return `554 5.1.1 <${recipient}>: Recipient address rejected: undeliverable address: Mailbox might be disabled, full, or may not exist on the server. Reason: JFE030050`;
        }
        if (command.startsWith('QUIT')) return '221 bye';
        return '250 ok';
    }), async (port, state) => {
        const result = await check(port);
        assert.equal(result.status, STATUS.unknown);
        assert.equal(result.reason, REASON.blanketReject);
        assert.equal(result.possibleBlanketReject, true);
        assert.equal(result.isCatchAll, false);
        assert.equal(shouldChargeForStatus(result.status), false);
        assert.equal(state.connections, 1);
        assert.equal(state.commands.filter((line) => line.toUpperCase().startsWith('RCPT')).length, 2);
        assert.equal(state.commands.some((line) => line.toUpperCase().startsWith('DATA')), false);
    });
});

test('a temporary SMTP response is unknown, not a rejection', async () => {
    await withServer(scripted((line) => {
        const command = line.toUpperCase();
        if (command.startsWith('RCPT')) return '450 greylisted, try again later';
        if (command.startsWith('QUIT')) return '221 bye';
        return '250 ok';
    }), async (port, state) => {
        const result = await check(port);
        assert.equal(result.status, STATUS.unknown);
        assert.equal(result.reason, REASON.smtpTemporary);
        assert.match(result.reason, /temporary/i);
        assert.match(result.reason, /not a real rejection/i);
        assert.equal(result.isCatchAll, false);
        assert.equal(result.possibleBlanketReject, false);
        assert.notEqual(result.status, STATUS.invalid);
        assert.equal(state.commands.filter((line) => line.toUpperCase().startsWith('RCPT')).length, 1);
    });
});

test('no SMTP response becomes unknown after the timeout', async () => {
    await withServer((socket) => {
        socket.on('error', () => {});
    }, async (port) => {
        const started = Date.now();
        const result = await check(port, { smtpTimeoutMs: 300 });
        const elapsed = Date.now() - started;
        assert.equal(result.status, STATUS.unknown);
        assert.equal(result.reason, REASON.smtpTimeout);
        assert.equal(result.isCatchAll, false);
        assert.ok(elapsed >= 250);
        assert.ok(elapsed < 2000);
    });
});

test('a catch-all domain downgrades an accepted mailbox to risky on one connection', async () => {
    await withServer(scripted((line) => {
        const command = line.toUpperCase();
        if (command.startsWith('DATA')) return '550 no mail is accepted';
        if (command.startsWith('QUIT')) return '221 bye';
        return '250 ok';
    }), async (port, state) => {
        const result = await check(port);
        assert.equal(result.status, STATUS.risky);
        assert.equal(result.reason, REASON.catchAll);
        assert.equal(result.isCatchAll, true);
        assert.equal(result.mxRecordFound, true);
        assert.equal(state.connections, 1);
        const recipients = state.commands.filter((line) => line.toUpperCase().startsWith('RCPT TO:'));
        assert.equal(recipients.length, 2);
        assert.match(recipients[1], /no-such-mailbox-[0-9a-f]+@company\.example\.com/i);
        assert.equal(state.commands.some((line) => line.toUpperCase().startsWith('DATA')), false);
    });
});
