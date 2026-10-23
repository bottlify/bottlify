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
import { EVENT_TAG, MIRROR, MUTEX_TAG } from '../../kernel/internal/event-mirror.js';
import { EVENT_WORD } from '../../kernel/internal/event-words.js';
import { MUTEX_WORD } from '../../kernel/internal/mutex-words.js';
import { EVENT_SLOTS, eventStateCode, releaseMutexCode, waitOneCode } from './wait-one.js';

const PROGRAM = 0x8000;
const POLL = 0x8200;
/** Where the routine leaves for the host: a halt, so the test can see it got there. */
const TRAP = 0x8400;
const TABLE = 0x100000;
const STACK = 0x300000;
/** What the kernel's words say, as the routines are handed it. */
const VALUES = { clear: MIRROR.CLEAR, set: MIRROR.SET, mutexTag: MUTEX_TAG, eventTag: EVENT_TAG };

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
        host.writePhysical(POLL, waitOneCode(POLL, TRAP, TABLE, VALUES));
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

test('the guest takes a free mutex or its own again, gives back its own, and leaves every other'
    + ' mutex call to the host', async()=>{
    const RELEASE = 0x8600;
    const MUTEX = 0x110000;
    const HANDLE = 0x160;
    const ME = 0x2c;
    const host = createCorkHost({
        engine: cork,
        memorySize: 64 * 1024 * 1024,
        trapPort: 0xb077,
        entryVector: 0x7000,
        initialStack: STACK,
        cork: {},
    });
    host.writePhysical(POLL, waitOneCode(POLL, TRAP, TABLE, VALUES));
    host.writePhysical(RELEASE, releaseMutexCode(RELEASE, TRAP, TABLE, VALUES));
    host.writePhysical(TRAP, new Uint8Array([0xf4]));
    // FS's base is zero here: FS:[0x24], the caller's id, is linear 0x24.
    host.writePhysical(0x24, new Uint8Array(u32(ME)));
    host.writePhysical(TABLE + (HANDLE >>> 2) * 4, new Uint8Array(u32((MUTEX | MUTEX_TAG) >>> 0)));
    host.writePhysical(PROGRAM, new Uint8Array([0xf4]));
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    runToHalt(host, 1000);

    /** @param {number} value */
    const setWord = value=>host.writePhysical(MUTEX, new Uint8Array(u32(value)));
    const word = ()=>{
        const bytes = host.readPhysical(MUTEX, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /**
     * Calls a routine with `args` pushed, from a fresh stack: its answer, or
     * 'host' where it left for the host with the call as it was made.
     *
     * @param {number} routine @param {number[]} args
     */
    const call = (routine, args)=>{
        const pushes = args.slice().reverse().flatMap(value=>[0x68, ...u32(value)]);
        const at = PROGRAM + pushes.length;
        const code = [...pushes, 0xe8, ...u32((routine - (at + 5)) | 0), 0xf4];
        host.writePhysical(PROGRAM, new Uint8Array(code));
        host.writeReg32('eip', PROGRAM);
        host.writeReg32('esp', STACK);
        host.writeReg32('eax', 0x5a5a5a5a);
        host.wake();
        runToHalt(host, 1000);
        if (host.readReg32('eip') === TRAP + 1)
        {
            assert.equal(host.readReg32('esp'), STACK - 4 - 4 * args.length,
                'the host is reached with the call as it was made');
            return 'host';
        }
        assert.equal(host.readReg32('eip'), PROGRAM + code.length);
        assert.equal(host.readReg32('esp'), STACK, 'its arguments popped');
        return host.readReg32('eax');
    };
    const mine = (/** @type {number} */ count)=>((ME << MUTEX_WORD.OWNER_SHIFT) | count) >>> 0;
    const theirs = ((0x30 << MUTEX_WORD.OWNER_SHIFT) | 1) >>> 0;

    setWord(0);
    assert.equal(call(POLL, [HANDLE, 0xffffffff]), 0, 'a free mutex is taken');
    assert.equal(word(), mine(1));
    assert.equal(call(POLL, [HANDLE | 3, 0]), 0, 'taken again by its owner, the low bits aside');
    assert.equal(word(), mine(2));
    assert.equal(call(RELEASE, [HANDLE]), 1, 'given back once');
    assert.equal(word(), mine(1));
    assert.equal(call(RELEASE, [HANDLE]), 1, 'and freed');
    assert.equal(word(), 0);
    assert.equal(call(RELEASE, [HANDLE]), 'host', 'a free mutex released: the host\'s error');
    assert.equal(word(), 0);

    setWord(theirs);
    assert.equal(call(POLL, [HANDLE, 0xffffffff]), 'host', 'another thread\'s: the host waits');
    assert.equal(call(POLL, [HANDLE, 0]), 'host');
    assert.equal(call(RELEASE, [HANDLE]), 'host', 'not the caller\'s to release');
    assert.equal(word(), theirs, 'untouched');

    for (const kept of [MUTEX_WORD.HOST, mine(1) | MUTEX_WORD.HOST, theirs | MUTEX_WORD.HOST])
    {
        setWord(kept);
        assert.equal(call(POLL, [HANDLE, 0xffffffff]), 'host', 'the host keeps it');
        assert.equal(call(RELEASE, [HANDLE]), 'host');
        assert.equal(word(), kept >>> 0, 'untouched');
    }

    setWord(mine(MUTEX_WORD.RECURSION));
    assert.equal(call(POLL, [HANDLE, 0]), 'host', 'a count the word cannot carry one more of');
    assert.equal(call(RELEASE, [HANDLE]), 1, 'but it is given back');
    assert.equal(word(), mine(MUTEX_WORD.RECURSION - 1));

    host.writePhysical(TABLE + (HANDLE >>> 2) * 4, new Uint8Array(u32(MIRROR.CLEAR)));
    assert.equal(call(RELEASE, [HANDLE]), 'host', 'an event\'s handle is the host\'s to refuse');
    host.writePhysical(TABLE + (HANDLE >>> 2) * 4, new Uint8Array(u32(MIRROR.NONE)));
    assert.equal(call(RELEASE, [HANDLE]), 'host');
    assert.equal(call(RELEASE, [EVENT_SLOTS * 4]), 'host', 'past the table');
    host.stop();
});

test('the guest answers SetEvent of a signalled event and ResetEvent of a clear one, and leaves'
    + ' every change to the host', async()=>{
    const SET = 0x8600;
    const RESET = 0x8700;
    const host = createCorkHost({
        engine: cork,
        memorySize: 64 * 1024 * 1024,
        trapPort: 0xb077,
        entryVector: 0x7000,
        initialStack: STACK,
        cork: {},
    });
    host.writePhysical(SET, eventStateCode(SET, TRAP, TABLE, VALUES, true));
    host.writePhysical(RESET, eventStateCode(RESET, TRAP, TABLE, VALUES, false));
    host.writePhysical(TRAP, new Uint8Array([0xf4]));
    host.writePhysical(PROGRAM, new Uint8Array([0xf4]));
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    runToHalt(host, 1000);
    /** @param {number} handle @param {number} value */
    const word = (handle, value)=>host.writePhysical(TABLE + (handle >>> 2) * 4,
        new Uint8Array(u32(value)));
    /**
     * Calls a routine with its handle, from a fresh stack: its answer, or
     * 'host' where it left for the host with the call as it was made.
     *
     * @param {number} routine @param {number} handle
     */
    const call = (routine, handle)=>{
        const code = [0x68, ...u32(handle), 0xe8, ...u32((routine - (PROGRAM + 10)) | 0), 0xf4];
        host.writePhysical(PROGRAM, new Uint8Array(code));
        host.writeReg32('eip', PROGRAM);
        host.writeReg32('esp', STACK);
        host.writeReg32('eax', 0x5a5a5a5a);
        host.wake();
        runToHalt(host, 1000);
        if (host.readReg32('eip') === TRAP + 1)
        {
            assert.equal(host.readReg32('esp'), STACK - 8,
                'the host is reached with the call as it was made');
            return 'host';
        }
        assert.equal(host.readReg32('eip'), PROGRAM + code.length);
        assert.equal(host.readReg32('esp'), STACK, 'its argument popped');
        return host.readReg32('eax');
    };

    word(0x154, MIRROR.SET);
    word(0x158, MIRROR.CLEAR);
    word(0x15c, MIRROR.NONE);
    word(0x160, (0x110000 | MUTEX_TAG) >>> 0);
    assert.equal(call(SET, 0x154), 1, 'a signalled event set again: TRUE, nothing to change');
    assert.equal(call(SET, 0x157), 1, 'whatever the program keeps in the low two bits');
    assert.equal(call(SET, 0x158), 'host', 'an event to signal is the host\'s');
    assert.equal(call(RESET, 0x158), 1, 'a clear event reset: TRUE, nothing to change');
    assert.equal(call(RESET, 0x154), 'host', 'an event to clear is the host\'s');
    for (const routine of [SET, RESET])
    {
        assert.equal(call(routine, 0x15c), 'host', 'a handle with no word is the host\'s');
        assert.equal(call(routine, 0x160), 'host', 'a mutex\'s word: the host refuses it');
        assert.equal(call(routine, EVENT_SLOTS * 4), 'host', 'past the table');
        assert.equal(call(routine, 0xffffffff), 'host', 'a pseudo-handle');
    }
    host.stop();
});

test('the guest takes, sets and resets an event by its own word, and answers what changes nothing'
    + ' of one the host keeps', async()=>{
    const SET = 0x8600;
    const RESET = 0x8700;
    const RELEASE = 0x8800;
    const EVENT = 0x120000;
    const HANDLE = 0x170;
    const host = createCorkHost({
        engine: cork,
        memorySize: 64 * 1024 * 1024,
        trapPort: 0xb077,
        entryVector: 0x7000,
        initialStack: STACK,
        cork: {},
    });
    host.writePhysical(POLL, waitOneCode(POLL, TRAP, TABLE, VALUES));
    host.writePhysical(SET, eventStateCode(SET, TRAP, TABLE, VALUES, true));
    host.writePhysical(RESET, eventStateCode(RESET, TRAP, TABLE, VALUES, false));
    host.writePhysical(RELEASE, releaseMutexCode(RELEASE, TRAP, TABLE, VALUES));
    host.writePhysical(TRAP, new Uint8Array([0xf4]));
    host.writePhysical(TABLE + (HANDLE >>> 2) * 4, new Uint8Array(u32((EVENT | EVENT_TAG) >>> 0)));
    host.writePhysical(PROGRAM, new Uint8Array([0xf4]));
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    runToHalt(host, 1000);

    /** @param {number} value */
    const setWord = value=>host.writePhysical(EVENT, new Uint8Array(u32(value)));
    const word = ()=>{
        const bytes = host.readPhysical(EVENT, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /**
     * Calls a routine with `args` pushed, from a fresh stack: its answer, or
     * 'host' where it left for the host with the call as it was made.
     *
     * @param {number} routine @param {number[]} args
     */
    const call = (routine, args)=>{
        const pushes = args.slice().reverse().flatMap(value=>[0x68, ...u32(value)]);
        const at = PROGRAM + pushes.length;
        const code = [...pushes, 0xe8, ...u32((routine - (at + 5)) | 0), 0xf4];
        host.writePhysical(PROGRAM, new Uint8Array(code));
        host.writeReg32('eip', PROGRAM);
        host.writeReg32('esp', STACK);
        host.writeReg32('eax', 0x5a5a5a5a);
        host.wake();
        runToHalt(host, 1000);
        if (host.readReg32('eip') === TRAP + 1)
        {
            assert.equal(host.readReg32('esp'), STACK - 4 - 4 * args.length,
                'the host is reached with the call as it was made');
            return 'host';
        }
        assert.equal(host.readReg32('eip'), PROGRAM + code.length);
        assert.equal(host.readReg32('esp'), STACK, 'its arguments popped');
        return host.readReg32('eax');
    };
    const { SIGNALLED, MANUAL, HOST } = EVENT_WORD;

    setWord(0);
    assert.equal(call(POLL, [HANDLE, 0]), 0x102,
        'an auto-reset event not signalled: a poll times out');
    assert.equal(call(POLL, [HANDLE, 5]), 'host', 'a wait that may wait is the host\'s');
    assert.equal(call(SET, [HANDLE]), 1, 'set here');
    assert.equal(word(), SIGNALLED);
    assert.equal(call(SET, [HANDLE | 3]), 1, 'and again, the low bits aside');
    assert.equal(word(), SIGNALLED);
    assert.equal(call(POLL, [HANDLE, 0xffffffff]), 0, 'taken here');
    assert.equal(word(), 0, 'an auto-reset event taken goes clear');
    assert.equal(call(POLL, [HANDLE, 0]), 0x102);
    assert.equal(call(SET, [HANDLE]), 1);
    assert.equal(call(RESET, [HANDLE]), 1, 'reset here');
    assert.equal(word(), 0);
    assert.equal(call(RESET, [HANDLE]), 1, 'and again');
    assert.equal(word(), 0);

    setWord(MANUAL);
    assert.equal(call(POLL, [HANDLE, 0]), 0x102, 'a manual-reset event not signalled');
    assert.equal(call(SET, [HANDLE]), 1);
    assert.equal(word(), SIGNALLED | MANUAL);
    assert.equal(call(POLL, [HANDLE, 0xffffffff]), 0, 'taken here...');
    assert.equal(call(POLL, [HANDLE, 0]), 0, '...and again: a manual-reset event stays signalled');
    assert.equal(word(), SIGNALLED | MANUAL);
    assert.equal(call(RESET, [HANDLE]), 1);
    assert.equal(word(), MANUAL);

    // The host keeps the word while a thread waits on the event, and still
    // says there whether it is signalled: what changes nothing is answered.
    for (const kept of [HOST, HOST | MANUAL])
    {
        setWord(kept);
        assert.equal(call(POLL, [HANDLE, 0xffffffff]), 'host', 'a wait is the host\'s');
        assert.equal(call(POLL, [HANDLE, 0]), 0x102, 'a poll of an event not signalled');
        assert.equal(call(SET, [HANDLE]), 'host', 'a set may release a waiter');
        assert.equal(call(RESET, [HANDLE]), 1, 'a reset of an event not signalled');
        assert.equal(word(), kept, 'untouched');
    }
    for (const kept of [HOST | SIGNALLED, HOST | SIGNALLED | MANUAL])
    {
        setWord(kept);
        assert.equal(call(POLL, [HANDLE, 0xffffffff]), 'host', 'a signalled event is the host\'s'
            + ' to take');
        assert.equal(call(POLL, [HANDLE, 0]), 'host');
        assert.equal(call(SET, [HANDLE]), 1, 'a set of a signalled event');
        assert.equal(call(RESET, [HANDLE]), 'host', 'a reset of one');
        assert.equal(word(), kept, 'untouched');
    }
    setWord(SIGNALLED);
    assert.equal(call(RELEASE, [HANDLE]), 'host', 'an event\'s handle is the host\'s to refuse');
    assert.equal(word(), SIGNALLED, 'untouched');
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
/** With a mutex beside the events: taken and given back, by its owner or past its count. */
const MUTEX_OPS = [...OPS, 'take', 'take', 'give', 'give', 'give'];
/** The slot of the events' array the mutex is kept in, past the events'. */
const MUTEX_SLOT = 15;

/**
 * @param {number} seed @param {number} count @param {boolean} guest
 * @param {typeof import('../../../../../../tools/make-pe.mjs').buildExe} buildExe
 * @param {boolean} [mutex]  a mutex taken and given back among the events' calls
 * @param {number} [rounds]  how many times the calls are made, one after the other
 */
function eventProgram(seed, count, guest, buildExe, mutex = false, rounds = 1){
    const pick = random(seed);
    const kinds = mutex ? MUTEX_OPS : OPS;
    /** @type {{ op: string, slot: number, other: number, manual: number, initial: number }[]} */
    const ops = [{ op: 'create', slot: 0, other: 0, manual: 0, initial: 0 }];
    if (mutex)
    {
        ops.push({ op: 'mutex', slot: MUTEX_SLOT, other: 0, manual: 0, initial: 0 });
    }
    for (let i = 0; i < count; i++)
    {
        ops.push({ op: kinds[pick(kinds.length)], slot: pick(4), other: pick(4), manual: pick(2),
            initial: pick(2) });
    }
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateEventA', 'SetEvent', 'ResetEvent', 'PulseEvent',
            'WaitForSingleObject', 'WaitForSingleObjectEx', 'CloseHandle', 'DuplicateHandle',
            'CreateMutexA', 'ReleaseMutex', 'GetLastError', 'ExitProcess'] },
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
            code.push(0xbe, ...u32(rounds)); // mov esi, rounds
            const top = code.length;
            for (const { op, slot, other, manual, initial } of ops)
            {
                if (op === 'create')
                {
                    code.push(0x6a, 0x00, 0x6a, initial, 0x6a, manual, 0x6a, 0x00,
                        ...call('CreateEventA'), 0xa3, ...u32(at('events') + slot * 4));
                    continue;
                }
                if (op === 'mutex')
                {
                    code.push(0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, ...call('CreateMutexA'),
                        0xa3, ...u32(at('events') + slot * 4));
                    continue;
                }
                if (op === 'take' || op === 'give')
                {
                    code.push(...op === 'take' ? wait(MUTEX_SLOT, 0)
                        : [...handle(MUTEX_SLOT), ...call('ReleaseMutex')],
                    ...fold, ...call('GetLastError'), ...fold);
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
            // dec esi; jnz top
            code.push(0x4e, 0x0f, 0x85, ...u32(top - (code.length + 7)));
            code.push(0x57, ...call('ExitProcess')); // push edi
            return code;
        },
    });
}

/**
 * The exit code of a run, and how many of its calls to functions `crossed`
 * names reached the host.
 *
 * @param {Uint8Array} executable @param {RegExp} crossed @param {Record<string, any>} [options]
 * @param {((app: any, running: Promise<number>) => Promise<void>) | null} [during]
 *     what is done to the machine while the program runs
 */
const runEvents = async(executable, crossed, options = {}, during = null)=>{
    const { createApp } = await import('../../../app.js');
    const app = await createApp({ executable, ...options });
    try
    {
        const running = app.run({ timeoutMs: 60_000 });
        await during?.(app, running);
        const code = (await running) >>> 0;
        const tables = await app.diagnostics();
        const bridge = (Array.isArray(tables) ? tables : [])
            .find(table=>table.name === 'bridge');
        const calls = (bridge?.metrics?.byFunction ?? [])
            .map((/** @type {string} */ line)=>line.split(' '))
            .filter((/** @type {string[]} */ parts)=>crossed.test(parts[0]))
            .reduce((/** @type {number} */ sum, /** @type {string[]} */ parts)=>
                sum + Number(parts[1]), 0);
        return { code, calls };
    }
    finally
    {
        await app.dispose();
    }
};

const SET_OR_RESET = /!(Set|Reset)Event$/;

test('seeded event programs answer alike with sets and resets in the guest and with every call'
    + ' in the host', async()=>{
    const { buildExe } = await import('../../../../../../tools/make-pe.mjs');
    for (const seed of [11, 12, 13, 14, 15, 16])
    {
        const executable = eventProgram(seed, 300, true, buildExe);
        const inGuest = await runEvents(executable, SET_OR_RESET);
        const inHost = await runEvents(executable, SET_OR_RESET,
            { win32: { handleWords: false } });
        assert.equal(inGuest.code, inHost.code, `seed ${seed}: the answers differ`);
        assert.ok(inGuest.calls < inHost.calls, `seed ${seed}: ${inGuest.calls} sets and resets`
            + ` crossed with the guest's answers, ${inHost.calls} without`);
    }
});

test('seeded event programs answer alike with polls in the guest and with every wait in the'
    + ' host', async()=>{
    const { buildExe } = await import('../../../../../../tools/make-pe.mjs');
    /** @param {Uint8Array} executable */
    const run = executable=>runEvents(executable, /WaitForSingleObject/);
    for (const seed of [1, 2, 3, 4, 5, 6])
    {
        const inGuest = await run(eventProgram(seed, 300, true, buildExe));
        const inHost = await run(eventProgram(seed, 300, false, buildExe));
        assert.equal(inGuest.code, inHost.code, `seed ${seed}: the answers differ`);
        assert.ok(inGuest.calls < inHost.calls, `seed ${seed}: ${inGuest.calls} waits crossed`
            + ` with polls in the guest, ${inHost.calls} without`);
    }
});

test('seeded event and mutex programs answer alike with the guest\'s answers switched off and on as'
    + ' they run and with every call in the host', async()=>{
    // `app.debug.handleWords`, switched while a program runs to see whether a
    // fault goes with the guest's own answers: a mutex the guest holds at the
    // switch keeps its owner and count in the host's hands, and back.
    const { buildExe } = await import('../../../../../../tools/make-pe.mjs');
    for (const seed of [21, 22, 23, 24])
    {
        const executable = eventProgram(seed, 600, true, buildExe, true, 40);
        const inHost = await runEvents(executable, /./, { win32: { handleWords: false } });
        let switches = 0;
        const switched = await runEvents(executable, /./, {}, async(app, running)=>{
            const ran = { done: false };
            running.finally(()=>{
                ran.done = true;
            });
            while (!ran.done)
            {
                const on = await app.debug.handleWords(switches % 2 === 1);
                assert.equal(on, switches % 2 === 1, 'the switch answers where it stands');
                switches++;
                await new Promise(resolve=>setImmediate(resolve));
            }
        });
        assert.equal(switched.code, inHost.code, `seed ${seed}: the answers differ`);
        assert.ok(switches >= 4, `seed ${seed}: switched ${switches} times while it ran`);
    }
});

/**
 * Code with labels: `jump` leaves room for a jump to a label placed later.
 */
function assembler(){
    /** @type {number[]} */
    const bytes = [];
    /** @type {Record<string, number>} */
    const labels = {};
    /** @type {{ at: number, label: string, size: number }[]} */
    const jumps = [];
    return {
        /** @param {...number} values */
        emit: (...values)=>void bytes.push(...values),
        /** @param {string} name */
        label: name=>void (labels[name] = bytes.length),
        /**
         * A short jcc (one opcode byte), a long one (two), or `jmp rel32` (0xe9).
         *
         * @param {number[]} opcode @param {string} label
         */
        jump: (opcode, label)=>{
            const size = opcode.length === 1 && opcode[0] !== 0xe9 ? 1 : 4;
            bytes.push(...opcode, ...new Array(size).fill(0));
            jumps.push({ at: bytes.length - size, label, size });
        },
        done: ()=>{
            for (const { at, label, size } of jumps)
            {
                const distance = labels[label] - (at + size);
                if (size === 1 && (distance < -128 || distance > 127))
                {
                    throw new Error(`${label} is ${distance} bytes away`);
                }
                bytes.splice(at, size, ...(size === 1 ? [distance & 0xff] : u32(distance | 0)));
            }
            return bytes;
        },
    };
}

/**
 * A ring of `count` threads passing one token through auto-reset events, a
 * thread's own each, `rounds` times round: the holder reads a counter, works
 * a while, and writes it back one more, so a token two threads held at once
 * (an event taken twice) loses a count on executors running at once, and a
 * set that woke nobody it should have (a waiter left queued) never ends.
 * Odd threads poll for the token, even ones wait; between, each sets, resets
 * or polls an event all of them share, whose answers go nowhere.
 *
 * @param {typeof import('../../../../../../tools/make-pe.mjs').buildExe} buildExe
 * @param {number} count @param {number} rounds
 */
function tokenRing(buildExe, count, rounds){
    const WORKER = 0x400;
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateEventA', 'SetEvent', 'ResetEvent', 'CreateThread',
            'WaitForSingleObject', 'ExitProcess'] },
        codeSize: WORKER + 0x200,
        data: { events: new Array(count * 4).fill(0), threads: new Array(count * 4).fill(0),
            side: [0, 0, 0, 0], counter: [0, 0, 0, 0] },
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** @type {number[]} */
            const main = [];
            /** CreateEventA(NULL, manual, FALSE, NULL), the handle to `slot`. */
            const event = (/** @type {number} */ slot, /** @type {number} */ manual)=>main.push(
                0x6a, 0x00, 0x6a, 0x00, 0x6a, manual, 0x6a, 0x00, ...call('CreateEventA'),
                0xa3, ...u32(slot));
            for (let index = 0; index < count; index++)
            {
                event(at('events') + index * 4, 0);
            }
            event(at('side'), 1);
            for (let index = 0; index < count; index++)
            {
                // CreateThread(NULL, 0, worker, index, 0, NULL)
                main.push(0x6a, 0x00, 0x6a, 0x00, 0x6a, index, 0x68, ...u32(code(WORKER)),
                    0x6a, 0x00, 0x6a, 0x00, ...call('CreateThread'),
                    0xa3, ...u32(at('threads') + index * 4));
            }
            main.push(0xff, 0x35, ...u32(at('events')), ...call('SetEvent'));
            for (let index = 0; index < count; index++)
            {
                main.push(0x6a, 0xff, 0xff, 0x35, ...u32(at('threads') + index * 4),
                    ...call('WaitForSingleObject'));
            }
            main.push(0xff, 0x35, ...u32(at('counter')), ...call('ExitProcess'));

            const w = assembler();
            /** push dword [events + register*4], ebx's (0x9d) or eax's (0x85) */
            const ownEvent = (/** @type {number} */ sib)=>[0xff, 0x34, sib, ...u32(at('events'))];
            w.emit(0x8b, 0x5c, 0x24, 0x04); //             mov ebx, [esp+4]
            w.emit(0xbe, ...u32(rounds)); //               mov esi, rounds
            w.label('top');
            w.emit(0xf6, 0xc3, 0x01); //                   test bl, 1
            w.jump([0x75], 'polling');
            w.emit(0x6a, 0xff, ...ownEvent(0x9d), ...call('WaitForSingleObject'));
            w.jump([0xeb], 'got');
            w.label('polling');
            w.emit(0x6a, 0x00, ...ownEvent(0x9d), ...call('WaitForSingleObject'));
            w.emit(0x85, 0xc0); //                         test eax, eax
            w.jump([0x75], 'polling');
            w.label('got');
            w.emit(0xa1, ...u32(at('counter'))); //        mov eax, [counter]
            w.emit(0x6b, 0xcb, 0x61, 0x83, 0xc1, 0x32); // imul ecx, ebx, 97; add ecx, 50
            w.label('work');
            w.emit(0x49); //                               dec ecx
            w.jump([0x75], 'work');
            w.emit(0x40, 0xa3, ...u32(at('counter'))); //  inc eax; mov [counter], eax
            w.emit(0x89, 0xf0, 0x83, 0xe0, 0x03); //       mov eax, esi; and eax, 3
            w.jump([0x74], 'set');
            w.emit(0x48); //                               dec eax
            w.jump([0x74], 'reset');
            w.emit(0x48);
            w.jump([0x74], 'poll');
            w.jump([0xeb], 'next');
            w.label('set');
            w.emit(0xff, 0x35, ...u32(at('side')), ...call('SetEvent'));
            w.jump([0xeb], 'next');
            w.label('reset');
            w.emit(0xff, 0x35, ...u32(at('side')), ...call('ResetEvent'));
            w.jump([0xeb], 'next');
            w.label('poll');
            w.emit(0x6a, 0x00, 0xff, 0x35, ...u32(at('side')), ...call('WaitForSingleObject'));
            w.label('next');
            w.emit(0x8d, 0x43, 0x01, 0x83, 0xf8, count); // lea eax, [ebx+1]; cmp eax, count
            w.jump([0x72], 'wrap');
            w.emit(0x31, 0xc0); //                         xor eax, eax
            w.label('wrap');
            w.emit(...ownEvent(0x85), ...call('SetEvent'));
            w.emit(0x4e); //                               dec esi
            w.jump([0x0f, 0x85], 'top');
            w.emit(0x31, 0xc0, 0xc2, 0x04, 0x00); //       xor eax, eax; ret 4
            return [...main, ...new Array(WORKER - main.length).fill(0x90), ...w.done()];
        },
    });
}

test('a token passed round a ring of threads on several executors through auto-reset events is'
    + ' held by one thread at a time, and every set wakes its waiter, with the guest\'s answers'
    + ' and with every call in the host', async()=>{
    const { buildExe } = await import('../../../../../../tools/make-pe.mjs');
    const COUNT = 4;
    const ROUNDS = 150;
    const executable = tokenRing(buildExe, COUNT, ROUNDS);
    const cpu = { cores: 3, eager: true };
    const inGuest = await runEvents(executable, /!(SetEvent|ResetEvent|WaitForSingleObject)$/,
        { cpu });
    const inHost = await runEvents(executable, /!(SetEvent|ResetEvent|WaitForSingleObject)$/,
        { cpu, win32: { handleWords: false } });
    assert.equal(inHost.code, COUNT * ROUNDS, 'every round counted once, every call in the host');
    assert.equal(inGuest.code, COUNT * ROUNDS,
        'every round counted once with the guest\'s answers');
    assert.ok(inGuest.calls < inHost.calls, `${inGuest.calls} calls crossed with the guest's`
        + ` answers, ${inHost.calls} without`);
});

test('an event a thread waits on together with another is set and not taken: the guest reads it'
    + ' signalled while the host keeps it', async()=>{
    // The worker waits for both A and B; A set, it cannot go, and A stays
    // signalled with a thread queued on it, its word the host's. The main
    // thread's poll takes A, a second times out, a reset of A set again
    // clears it: each read from the word the host writes the state into.
    const { buildExe } = await import('../../../../../../tools/make-pe.mjs');
    const WORKER = 0x300;
    const executable = buildExe({
        imports: { 'KERNEL32.dll': ['CreateEventA', 'SetEvent', 'ResetEvent', 'CreateThread',
            'WaitForSingleObject', 'WaitForMultipleObjects', 'Sleep', 'ExitProcess'] },
        codeSize: WORKER + 0x40,
        data: { both: [0, 0, 0, 0, 0, 0, 0, 0], thread: [0, 0, 0, 0] },
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            const a = at('both');
            const b = at('both') + 4;
            // imul edi, edi, 31; add edi, eax
            const fold = [0x6b, 0xff, 0x1f, 0x01, 0xc7];
            /** @param {number} slot */
            const push = slot=>[0xff, 0x35, ...u32(slot)];
            /** @param {number} slot */
            const poll = slot=>[0x6a, 0x00, ...push(slot), ...call('WaitForSingleObject'), ...fold];
            /** CreateEventA(NULL, FALSE, FALSE, NULL), the handle to `slot`. @param {number} slot */
            const event = slot=>[0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                ...call('CreateEventA'), 0xa3, ...u32(slot)];
            const main = [
                0x31, 0xff, //                                     xor edi, edi
                ...event(a), ...event(b),
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(code(WORKER)), 0x6a, 0x00,
                0x6a, 0x00, ...call('CreateThread'), 0xa3, ...u32(at('thread')),
                0x6a, 0x64, ...call('Sleep'), //                  the worker queued on both
                ...push(a), ...call('SetEvent'), ...fold,
                ...poll(a), //                                     WAIT_OBJECT_0: taken here
                ...poll(a), //                                     WAIT_TIMEOUT
                ...push(a), ...call('SetEvent'), ...fold,
                ...push(a), ...call('ResetEvent'), ...fold,
                ...poll(a), //                                     WAIT_TIMEOUT
                ...push(a), ...call('SetEvent'), ...fold,
                ...push(b), ...call('SetEvent'), ...fold, //       the worker goes
                0x6a, 0xff, ...push(at('thread')), ...call('WaitForSingleObject'), ...fold,
                ...poll(a), //                                     taken by the worker
                0x57, ...call('ExitProcess'), //                   push edi
            ];
            // WaitForMultipleObjects(2, both, TRUE, INFINITE); ret 4
            const worker = [0x6a, 0xff, 0x6a, 0x01, 0x68, ...u32(at('both')), 0x6a, 0x02,
                ...call('WaitForMultipleObjects'), 0xc2, 0x04, 0x00];
            return [...main, ...new Array(WORKER - main.length).fill(0x90), ...worker];
        },
    });
    const expected = [1, 0, 0x102, 1, 1, 0x102, 1, 1, 0, 0x102]
        .reduce((sum, answer)=>(Math.imul(sum, 31) + answer) >>> 0, 0);
    for (const cores of [1, 2])
    {
        const inGuest = await runEvents(executable, /!(SetEvent|ResetEvent|WaitForSingleObject)$/,
            { cpu: { cores, eager: true } });
        const inHost = await runEvents(executable, /!(SetEvent|ResetEvent|WaitForSingleObject)$/,
            { cpu: { cores, eager: true }, win32: { handleWords: false } });
        assert.equal(inHost.code, expected, `${cores} executors: every call in the host`);
        assert.equal(inGuest.code, expected, `${cores} executors: with the guest's answers`);
    }
});
