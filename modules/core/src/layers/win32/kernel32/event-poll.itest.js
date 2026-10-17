/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * WaitForSingleObject's guest poll, run by the real processor: it answers
 * WAIT_TIMEOUT for a poll of an event whose word says it is not signalled,
 * pops its two arguments, and leaves every other call to the host untouched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import { runToHalt } from '../../cpu/internal/halt.fixture.js';
import * as cork from '../../../../../cork/src/index.js';
import { MIRROR } from '../../kernel/internal/event-mirror.js';
import { EVENT_SLOTS, eventPollCode } from './event-poll.js';

const PROGRAM = 0x8000;
const POLL = 0x8200;
/** Where the routine leaves for the host: a halt, so the test can see it got there. */
const TRAP = 0x8400;
const TABLE = 0x100000;
const STACK = 0x300000;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

test('the guest poll times out an unsignalled event and leaves every other wait to the host',
    async()=>{
        const host = createCorkHost({
            engine: cork,
            memorySize: 64 * 1024 * 1024,
            trapPort: 0xb077,
            entryVector: 0x7000,
            initialStack: STACK,
            cork: {},
        });
        host.writePhysical(POLL, eventPollCode(POLL, TRAP, TABLE, MIRROR.CLEAR));
        host.writePhysical(TRAP, new Uint8Array([0xf4]));
        /** @param {number} handle @param {number} value */
        const word = (handle, value)=>host.writePhysical(TABLE + (handle >>> 2) * 4,
            new Uint8Array(u32(value)));
        word(0x154, MIRROR.CLEAR);
        word(0x158, MIRROR.SET);
        word(0x15c, MIRROR.NONE);
        host.writePhysical(PROGRAM, new Uint8Array([0xf4]));
        host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
        runToHalt(host, 1000);

        /**
         * Calls the routine with a handle and a timeout, from a fresh stack, and
         * says whether it answered or left for the host. An answer must leave the
         * stack where the call found it: a routine popping too few arguments
         * leaves its caller to return into one.
         *
         * @param {number} handle @param {number} timeout
         */
        const poll = (handle, timeout)=>{
            const code = [0x68, ...u32(timeout), 0x68, ...u32(handle),
                0xe8, ...u32((POLL - (PROGRAM + 15)) | 0), 0xf4];
            host.writePhysical(PROGRAM, new Uint8Array(code));
            host.writeReg32('eip', PROGRAM);
            host.writeReg32('esp', STACK);
            host.writeReg32('eax', 0x5a5a5a5a);
            host.wake();
            runToHalt(host, 1000);
            if (host.readReg32('eip') === TRAP + 1)
            {
                assert.equal(host.readReg32('esp'), STACK - 12,
                    'the host is reached with the call as it was made');
                return 'host';
            }
            assert.equal(host.readReg32('eip'), PROGRAM + code.length);
            assert.equal(host.readReg32('esp'), STACK, 'both arguments popped');
            return host.readReg32('eax');
        };

        assert.equal(poll(0x154, 0), 0x102, 'an unsignalled event times out here');
        assert.equal(poll(0x155, 0), 0x102, 'whatever the program keeps in the low two bits');
        assert.equal(poll(0x157, 0), 0x102);
        assert.equal(poll(0x154, 1), 'host', 'a wait that may wait is the host\'s');
        assert.equal(poll(0x154, 0xffffffff), 'host');
        assert.equal(poll(0x158, 0), 'host', 'a signalled event is taken by the host');
        assert.equal(poll(0x15c, 0), 'host', 'a handle with no word is the host\'s');
        assert.equal(poll(EVENT_SLOTS * 4, 0), 'host', 'past the table');
        assert.equal(poll(0xffffffff, 0), 'host', 'a pseudo-handle');
        assert.equal(poll(0xfffffff6, 0), 'host', 'a standard-handle number');

        host.stop();
    });

/**
 * Seeded random programs over four event slots, built twice: polling and
 * waiting through WaitForSingleObject, whose polls of an unsignalled event the
 * guest answers, and through WaitForSingleObjectEx(..., FALSE), which only the
 * host does. Every answer and the last error after it fold into the exit code,
 * so the two must end alike.
 */

/** @param {number} seed */
const random = seed=>{
    let state = seed >>> 0;
    return (/** @type {number} */ n)=>{
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state % n;
    };
};

const OPS = ['create', 'set', 'reset', 'pulse', 'poll', 'poll', 'poll', 'wait', 'close', 'dup'];

/**
 * @param {number} seed @param {number} count @param {boolean} guest
 * @param {typeof import('../../../../../../tools/make-pe.mjs').buildExe} buildExe
 */
function eventProgram(seed, count, guest, buildExe){
    const pick = random(seed);
    /** @type {{ op: string, slot: number, other: number, manual: number, initial: number }[]} */
    const ops = [{ op: 'create', slot: 0, other: 0, manual: 0, initial: 0 }];
    for (let i = 0; i < count; i++)
    {
        ops.push({ op: OPS[pick(OPS.length)], slot: pick(4), other: pick(4), manual: pick(2),
            initial: pick(2) });
    }
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateEventA', 'SetEvent', 'ResetEvent', 'PulseEvent',
            'WaitForSingleObject', 'WaitForSingleObjectEx', 'CloseHandle', 'DuplicateHandle',
            'GetLastError', 'ExitProcess'] },
        codeSize: 0x10000,
        data: { events: new Array(16).fill(0) },
        code: ({ iat, at })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** @param {number} slot */
            const handle = slot=>[0xff, 0x35, ...u32(at('events') + slot * 4)];
            /** @param {number} slot @param {number} timeout */
            const wait = (slot, timeout)=>(guest
                ? [0x68, ...u32(timeout), ...handle(slot), ...call('WaitForSingleObject')]
                : [0x6a, 0x00, 0x68, ...u32(timeout), ...handle(slot),
                    ...call('WaitForSingleObjectEx')]);
            // imul edi, edi, 31; add edi, eax
            const fold = [0x6b, 0xff, 0x1f, 0x01, 0xc7];
            /** @type {number[]} */
            const code = [0x31, 0xff]; // xor edi, edi
            for (const { op, slot, other, manual, initial } of ops)
            {
                if (op === 'create')
                {
                    code.push(0x6a, 0x00, 0x6a, initial, 0x6a, manual, 0x6a, 0x00,
                        ...call('CreateEventA'), 0xa3, ...u32(at('events') + slot * 4));
                    continue;
                }
                code.push(...op === 'set' ? [...handle(slot), ...call('SetEvent')]
                    : op === 'reset' ? [...handle(slot), ...call('ResetEvent')]
                        : op === 'pulse' ? [...handle(slot), ...call('PulseEvent')]
                            : op === 'poll' ? wait(slot, 0)
                                : op === 'wait' ? wait(slot, 1)
                                    : op === 'close' ? [...handle(slot), ...call('CloseHandle')]
                                    // DuplicateHandle(-1, events[slot], -1, &events[other],
                                    // 0, FALSE, DUPLICATE_SAME_ACCESS)
                                        : [0x6a, 0x02, 0x6a, 0x00, 0x6a, 0x00,
                                            0x68, ...u32(at('events') + other * 4),
                                            0x6a, 0xff, ...handle(slot), 0x6a, 0xff,
                                            ...call('DuplicateHandle')],
                ...fold, ...call('GetLastError'), ...fold);
            }
            code.push(0x57, ...call('ExitProcess')); // push edi
            return code;
        },
    });
}

test('seeded event programs answer alike with polls in the guest and with every wait in the'
    + ' host', async()=>{
    const { createApp } = await import('../../../app.js');
    const { buildExe } = await import('../../../../../../tools/make-pe.mjs');
    /** @param {Uint8Array} executable */
    const run = async executable=>{
        const app = await createApp({ executable });
        try
        {
            const code = (await app.run({ timeoutMs: 60_000 })) >>> 0;
            const tables = await app.diagnostics();
            const bridge = (Array.isArray(tables) ? tables : [])
                .find(table=>table.name === 'bridge');
            const calls = (bridge?.metrics?.byFunction ?? [])
                .map((/** @type {string} */ line)=>line.split(' '))
                .filter((/** @type {string[]} */ parts)=>parts[0].includes('WaitForSingleObject'))
                .reduce((/** @type {number} */ sum, /** @type {string[]} */ parts)=>
                    sum + Number(parts[1]), 0);
            return { code, calls };
        }
        finally
        {
            await app.dispose();
        }
    };
    for (const seed of [1, 2, 3, 4, 5, 6])
    {
        const inGuest = await run(eventProgram(seed, 300, true, buildExe));
        const inHost = await run(eventProgram(seed, 300, false, buildExe));
        assert.equal(inGuest.code, inHost.code, `seed ${seed}: the answers differ`);
        assert.ok(inGuest.calls < inHost.calls, `seed ${seed}: ${inGuest.calls} waits crossed`
            + ` with polls in the guest, ${inHost.calls} without`);
    }
});
