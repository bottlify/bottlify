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
import { MIRROR, MUTEX_TAG } from '../../kernel/internal/event-mirror.js';
import { MUTEX_WORD } from '../../kernel/internal/mutex-words.js';
import { EVENT_SLOTS, eventStateCode, releaseMutexCode, waitOneCode } from './wait-one.js';

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
        host.writePhysical(POLL, waitOneCode(POLL, TRAP, TABLE, MIRROR.CLEAR, MUTEX_TAG));
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
    host.writePhysical(POLL, waitOneCode(POLL, TRAP, TABLE, MIRROR.CLEAR, MUTEX_TAG));
    host.writePhysical(RELEASE, releaseMutexCode(RELEASE, TRAP, TABLE, MUTEX_TAG));
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
    host.writePhysical(SET, eventStateCode(SET, TRAP, TABLE, MIRROR.SET));
    host.writePhysical(RESET, eventStateCode(RESET, TRAP, TABLE, MIRROR.CLEAR));
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
