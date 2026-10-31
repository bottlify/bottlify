/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Semaphores released and taken in the guest (`semaphore-guest.js`, the
 * kernel's `semaphore-words.js`) against the host's own: the gate of the
 * second path.
 *
 * Seeded random programs of creates (counts at and past their maximum, a
 * maximum of zero), releases (of one, of several, of zero, negative, past the
 * maximum, with and without a previous count), polls, timed waits, waits on
 * several objects mixing semaphores with an event and a mutex (any and all),
 * closes, duplicates, a named semaphore opened again with fewer rights, waits
 * and releases on NULL, with
 * events set and a mutex taken and given back between: every answer, every
 * last error and every previous count folds into the exit code, which must be
 * the same with the guest's answers and with every call in the host
 * (`win32.handleWords: false`), and the guest's crossing fewer. Then threads:
 * a main thread handing jobs to workers through two semaphores on three
 * executors, blocking and polling, every job done once; and threads queued on
 * one semaphore woken one a release in the order they queued.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../app.js';
import { assemble, buildExe } from '../../../../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {number} seed */
const random = seed=>{
    let state = seed >>> 0;
    return (/** @type {number} */ n)=>{
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state % n;
    };
};

/** Slots 0 to 3 hold semaphores, 4 an auto-reset event, 5 a mutex, 6 a named semaphore opened again. */
const EVENT = 4;
const MUTEX = 5;
const OPENED = 6;
const OPS = ['create', 'release', 'release', 'release', 'poll', 'poll', 'poll', 'wait', 'any',
    'all', 'close', 'dup', 'set', 'take', 'give', 'open', 'null'];
/** A release's counts: ordinary, several, none, negative, the most a LONG holds. */
const COUNTS = [1, 1, 1, 2, 3, 0, -1, 0x7fffffff];
const MAXIMA = [1, 2, 3, 5, 0x7fffffff, 0];
/** SEMAPHORE_MODIFY_STATE | SYNCHRONIZE: a handle the host checks its rights on. */
const FEWER_RIGHTS = 0x100002;

/**
 * @param {number} seed @param {number} count
 * @param {number} [rounds]  how many times the calls are made, one after the other
 */
function semaphoreProgram(seed, count, rounds = 1){
    const pick = random(seed);
    const ops = Array.from({ length: count }, ()=>({
        op: OPS[pick(OPS.length)], slot: pick(4), other: pick(7), third: pick(7),
        initial: pick(4), maximum: MAXIMA[pick(MAXIMA.length)], count: COUNTS[pick(COUNTS.length)],
        previous: pick(3) !== 0, timeout: pick(2),
    }));
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateSemaphoreA', 'OpenSemaphoreA', 'ReleaseSemaphore',
            'CreateEventA', 'SetEvent', 'CreateMutexA', 'ReleaseMutex', 'WaitForSingleObject',
            'WaitForMultipleObjects', 'CloseHandle', 'DuplicateHandle', 'GetLastError',
            'SetLastError', 'ExitProcess'] },
        codeSize: 0x10000,
        data: { slots: new Array(32).fill(0), previous: u32(0), set: new Array(12).fill(0),
            name: [...Buffer.from('gate-semaphore'), 0] },
        code: ({ iat, at })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** @param {number} slot */
            const handle = slot=>[0xff, 0x35, ...u32(at('slots') + slot * 4)];
            /** mov [slot], eax */
            const keep = (/** @type {number} */ slot)=>[0xa3, ...u32(at('slots') + slot * 4)];
            // imul edi, edi, 31; add edi, eax
            const fold = [0x6b, 0xff, 0x1f, 0x01, 0xc7];
            // test eax, eax; setnz al; movzx eax, al: whether a handle came back
            const made = [0x85, 0xc0, 0x0f, 0x95, 0xc0, 0x0f, 0xb6, 0xc0];
            /** The handles of three slots in `set`, the count pushed after. */
            const set = (/** @type {number[]} */ slots)=>slots.flatMap((slot, i)=>[
                0xa1, ...u32(at('slots') + slot * 4), 0xa3, ...u32(at('set') + i * 4)]);
            /** @type {number[]} */
            const code = [
                0x31, 0xff, //                                            xor edi, edi
                // CreateEventA(NULL, FALSE, FALSE, NULL), CreateMutexA(NULL, FALSE, NULL)
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, ...call('CreateEventA'),
                ...keep(EVENT),
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, ...call('CreateMutexA'), ...keep(MUTEX),
                // CreateSemaphoreA(NULL, 1, 4, "gate-semaphore") into slot 3, opened again
                // into OPENED with fewer rights.
                0x68, ...u32(at('name')), 0x6a, 0x04, 0x6a, 0x01, 0x6a, 0x00,
                ...call('CreateSemaphoreA'), ...keep(3),
                0x68, ...u32(at('name')), 0x6a, 0x00, 0x68, ...u32(FEWER_RIGHTS),
                ...call('OpenSemaphoreA'), ...keep(OPENED),
            ];
            for (const slot of [0, 1, 2])
            {
                code.push(0x6a, 0x00, 0x6a, 0x08, 0x6a, slot, 0x6a, 0x00,
                    ...call('CreateSemaphoreA'), ...keep(slot));
            }
            code.push(0xbe, ...u32(rounds)); //                          mov esi, rounds
            const top = code.length;
            for (const { op, slot, other, third, initial, maximum, count: released, previous,
                timeout } of ops)
            {
                // The last error cleared first: an answer that leaves it alone leaves 0.
                code.push(0x6a, 0x00, ...call('SetLastError'));
                if (op === 'create')
                {
                    code.push(0x6a, 0x00, 0x68, ...u32(maximum), 0x6a, initial, 0x6a, 0x00,
                        ...call('CreateSemaphoreA'), ...keep(slot), ...made);
                }
                else if (op === 'release')
                {
                    // The previous count's word marked, so a write that should not
                    // happen shows.
                    const target = pick(5) === 0 ? OPENED : slot;
                    code.push(0xc7, 0x05, ...u32(at('previous')), ...u32(0x5a5a5a5a),
                        ...previous ? [0x68, ...u32(at('previous'))] : [0x6a, 0x00],
                        0x68, ...u32(released), ...handle(target), ...call('ReleaseSemaphore'),
                        ...fold, 0xa1, ...u32(at('previous')));
                }
                else if (op === 'poll' || op === 'wait')
                {
                    const target = pick(6) === 0 ? OPENED : slot;
                    code.push(0x6a, op === 'poll' ? 0 : timeout + 1, ...handle(target),
                        ...call('WaitForSingleObject'));
                }
                else if (op === 'any' || op === 'all')
                {
                    code.push(...set([slot, other, third]),
                        0x6a, timeout, 0x6a, op === 'all' ? 1 : 0, 0x68, ...u32(at('set')),
                        0x6a, other === slot || third === slot || other === third ? 2 : 3,
                        ...call('WaitForMultipleObjects'));
                }
                else if (op === 'null')
                {
                    // A wait on NULL, or on NULL with the program's low bits:
                    // what a create that failed leaves a program holding.
                    code.push(0x6a, timeout === 0 ? 0 : 0xff, 0x6a, slot,
                        ...call('WaitForSingleObject'), ...fold,
                        0x6a, 0x00, 0x6a, 0x01, 0x6a, 0x00, ...call('ReleaseSemaphore'));
                }
                else if (op === 'close')
                {
                    code.push(...handle(slot), ...call('CloseHandle'));
                }
                else if (op === 'dup')
                {
                    // DuplicateHandle(-1, slots[other], -1, &slots[slot], 0, FALSE,
                    // DUPLICATE_SAME_ACCESS): a semaphore under a second handle, or
                    // an event or a mutex in a semaphore's slot.
                    code.push(0x6a, 0x02, 0x6a, 0x00, 0x6a, 0x00,
                        0x68, ...u32(at('slots') + slot * 4),
                        0x6a, 0xff, ...handle(other), 0x6a, 0xff, ...call('DuplicateHandle'));
                }
                else if (op === 'set')
                {
                    code.push(...handle(EVENT), ...call('SetEvent'));
                }
                else if (op === 'take')
                {
                    code.push(0x6a, 0x00, ...handle(MUTEX), ...call('WaitForSingleObject'));
                }
                else if (op === 'give')
                {
                    code.push(...handle(MUTEX), ...call('ReleaseMutex'));
                }
                else
                {
                    // OpenSemaphoreA(SEMAPHORE_ALL_ACCESS, FALSE, name): a second
                    // handle with every right, in a semaphore's slot.
                    code.push(0x68, ...u32(at('name')), 0x6a, 0x00, 0x68, ...u32(0x1f0003),
                        ...call('OpenSemaphoreA'), ...keep(slot), ...made);
                }
                code.push(...fold, ...call('GetLastError'), ...fold);
            }
            // dec esi; jnz top
            code.push(0x4e, 0x0f, 0x85, ...u32(top - (code.length + 7)));
            code.push(0x57, ...call('ExitProcess')); //                  push edi
            return code;
        },
    });
}

/**
 * The exit code of a run, and how many of its calls to the functions `crossed`
 * names reached the host.
 *
 * @param {Uint8Array} executable @param {RegExp} crossed @param {Record<string, any>} [options]
 */
async function run(executable, crossed, options = {}){
    const app = await createApp({ executable, ...options });
    try
    {
        const code = (await app.run({ timeoutMs: 150_000 })) >>> 0;
        const tables = await app.diagnostics();
        const bridge = (Array.isArray(tables) ? tables : []).find(table=>table.name === 'bridge');
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
}

const SEMAPHORE_CALLS = /!(ReleaseSemaphore|WaitForSingleObject)$/;

test('seeded semaphore programs answer alike with the guest\'s releases and waits and with every'
    + ' call in the host', { timeout: 600_000 }, async()=>{
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8])
    {
        const executable = semaphoreProgram(seed, 400);
        const inGuest = await run(executable, SEMAPHORE_CALLS);
        const inHost = await run(executable, SEMAPHORE_CALLS, { win32: { handleWords: false } });
        assert.equal(inGuest.code, inHost.code, `seed ${seed}: the answers differ`);
        assert.ok(inGuest.calls < inHost.calls, `seed ${seed}: ${inGuest.calls} calls crossed`
            + ` with the guest's answers, ${inHost.calls} without`);
    }
});

test('seeded semaphore programs answer alike with the guest\'s answers switched off and on as'
    + ' they run', { timeout: 600_000 }, async()=>{
    for (const seed of [11, 12, 13])
    {
        const executable = semaphoreProgram(seed, 600, 30);
        const inHost = await run(executable, /./, { win32: { handleWords: false } });
        let switches = 0;
        const app = await createApp({ executable });
        try
        {
            const running = app.run({ timeoutMs: 150_000 });
            const ran = { done: false };
            running.finally(()=>{
                ran.done = true;
            });
            while (!ran.done)
            {
                await app.debug.handleWords(switches % 2 === 1);
                switches++;
                await new Promise(resolve=>setImmediate(resolve));
            }
            assert.equal((await running) >>> 0, inHost.code, `seed ${seed}: the answers differ`);
        }
        finally
        {
            await app.dispose();
        }
        assert.ok(switches >= 4, `seed ${seed}: switched ${switches} times while it ran`);
    }
});

const WORKER_AT = 0x400;

/**
 * A main thread handing `frames` rounds of `jobs` jobs to two workers through
 * `jobs` and `done` semaphores, the workers counting each job with
 * `lock inc`: blocking or polling for each count. The exit code is the count,
 * frames * jobs when no count was lost or taken twice, and a release that
 * woke nobody it should have never ends.
 *
 * @param {number} frames @param {number} jobs @param {boolean} poll
 */
function handoff(frames, jobs, poll){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateSemaphoreA', 'ReleaseSemaphore', 'CreateThread',
            'WaitForSingleObject', 'ExitProcess'] },
        codeSize: 0x1000,
        data: { jobs: u32(0), done: u32(0), quit: u32(0), counter: u32(0),
            threads: new Array(8).fill(0) },
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            const release = (/** @type {string} */ slot, /** @type {number} */ n)=>[
                0x6a, 0x00, 0x6a, n, 0xff, 0x35, ...u32(at(slot)), ...call('ReleaseSemaphore')];
            const take = (/** @type {string} */ slot, /** @type {string} */ label)=>(poll
                ? [{ label }, 0x6a, 0x00, 0xff, 0x35, ...u32(at(slot)),
                    ...call('WaitForSingleObject'), 0x85, 0xc0, { jump: 'jnz', to: label }]
                : [0x6a, 0xff, 0xff, 0x35, ...u32(at(slot)), ...call('WaitForSingleObject')]);
            const semaphore = (/** @type {string} */ slot)=>[0x6a, 0x00, 0x68, ...u32(1000),
                0x6a, 0x00, 0x6a, 0x00, ...call('CreateSemaphoreA'), 0xa3, ...u32(at(slot))];
            /** @type {any[]} */
            const main = [...semaphore('jobs'), ...semaphore('done')];
            for (const index of [0, 1])
            {
                main.push(0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(code(WORKER_AT)),
                    0x6a, 0x00, 0x6a, 0x00, ...call('CreateThread'),
                    0xa3, ...u32(at('threads') + 4 * index));
            }
            main.push(0xbe, ...u32(frames), { label: 'frame' },
                0xbb, ...u32(jobs), { label: 'handout' }, ...release('jobs', 1),
                0x4b, { jump: 'jnz', to: 'handout' },
                0xbb, ...u32(jobs), { label: 'collect' }, ...take('done', 'poll'),
                0x4b, { jump: 'jnz', to: 'collect' },
                0x4e, { jump: 'jnz', to: 'frame' },
                0xc7, 0x05, ...u32(at('quit')), ...u32(1), ...release('jobs', 2));
            for (const index of [0, 1])
            {
                main.push(0x6a, 0xff, 0xff, 0x35, ...u32(at('threads') + 4 * index),
                    ...call('WaitForSingleObject'));
            }
            main.push(0xff, 0x35, ...u32(at('counter')), ...call('ExitProcess'));
            const worker = assemble(/** @type {any[]} */ ([
                { label: 'next' }, ...take('jobs', 'wait'),
                0x83, 0x3d, ...u32(at('quit')), 0x00, { jump: 'jnz', to: 'out' },
                0xb9, ...u32(200), { label: 'work' }, 0x49, { jump: 'jnz', to: 'work' },
                0xf0, 0xff, 0x05, ...u32(at('counter')), ...release('done', 1),
                { jump: 'jmp', to: 'next' },
                { label: 'out' }, 0x31, 0xc0, 0xc2, 0x04, 0x00,
            ]));
            const head = assemble(main);
            return [...head, ...new Array(WORKER_AT - head.length).fill(0x90), ...worker];
        },
    });
}

test('jobs handed to workers on three executors through semaphores are each done once, blocking'
    + ' and polling, with the guest\'s answers and with every call in the host',
{ timeout: 600_000 }, async()=>{
    const cpu = { cores: 3, eager: true };
    for (const poll of [false, true])
    {
        const executable = handoff(150, 12, poll);
        const inGuest = await run(executable, SEMAPHORE_CALLS, { cpu });
        const inHost = await run(executable, SEMAPHORE_CALLS,
            { cpu, win32: { handleWords: false } });
        const how = poll ? 'polling' : 'blocking';
        assert.equal(inHost.code, 150 * 12, `${how}, every call in the host`);
        assert.equal(inGuest.code, 150 * 12, `${how}, with the guest's answers`);
        assert.ok(inGuest.calls < inHost.calls, `${how}: ${inGuest.calls} calls crossed with the`
            + ` guest's answers, ${inHost.calls} without`);
    }
});

test('threads queued on a semaphore are woken one a release in the order they queued, with the'
    + ' guest\'s answers and with every call in the host', { timeout: 300_000 }, async()=>{
    // Each of four threads waits on the semaphore, then writes its index into
    // the next place of `order`; the main thread sleeps until all are queued,
    // then releases one count at a time, polling between to see none is left.
    const executable = buildExe({
        imports: { 'KERNEL32.dll': ['CreateSemaphoreA', 'ReleaseSemaphore', 'CreateThread',
            'WaitForSingleObject', 'Sleep', 'ExitProcess'] },
        codeSize: 0x1000,
        data: { semaphore: u32(0), next: u32(0), order: new Array(16).fill(0),
            threads: new Array(16).fill(0) },
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** @type {any[]} */
            const main = [
                0x31, 0xff, //                                            xor edi, edi
                0x6a, 0x00, 0x6a, 0x10, 0x6a, 0x00, 0x6a, 0x00, ...call('CreateSemaphoreA'),
                0xa3, ...u32(at('semaphore')),
            ];
            for (let index = 0; index < 4; index++)
            {
                main.push(0x6a, 0x00, 0x6a, 0x00, 0x6a, index, 0x68, ...u32(code(WORKER_AT)),
                    0x6a, 0x00, 0x6a, 0x00, ...call('CreateThread'),
                    0xa3, ...u32(at('threads') + 4 * index),
                    0x6a, 0x14, ...call('Sleep'));
            }
            for (let index = 0; index < 4; index++)
            {
                main.push(0x6a, 0x00, 0x6a, 0x01, 0xff, 0x35, ...u32(at('semaphore')),
                    ...call('ReleaseSemaphore'),
                    // Until the woken thread has written its place: on several
                    // executors the next one woken could write first.
                    0x6a, 0x01, ...call('Sleep'), //                  wait: Sleep(1)
                    0x83, 0x3d, ...u32(at('next')), index + 1, //      cmp dword [next], index+1
                    0x72, 0xef, //                                    jb wait
                    // A poll: nothing is left for it once the count went to a waiter.
                    0x6a, 0x00, 0xff, 0x35, ...u32(at('semaphore')), ...call('WaitForSingleObject'),
                    0x6b, 0xff, 0x1f, 0x01, 0xc7);
            }
            for (let index = 0; index < 4; index++)
            {
                main.push(0x6a, 0xff, 0xff, 0x35, ...u32(at('threads') + 4 * index),
                    ...call('WaitForSingleObject'));
                // imul edi, edi, 31; add edi, [order + index*4]
                main.push(0x6b, 0xff, 0x1f, 0x03, 0x3d, ...u32(at('order') + 4 * index));
            }
            main.push(0x57, ...call('ExitProcess'));
            const worker = [
                0x6a, 0xff, 0xff, 0x35, ...u32(at('semaphore')), ...call('WaitForSingleObject'),
                0xb8, ...u32(1), //                                    mov eax, 1
                0xf0, 0x0f, 0xc1, 0x05, ...u32(at('next')), //         lock xadd [next], eax
                0x8b, 0x4c, 0x24, 0x04, //                             mov ecx, [esp+4]
                0x89, 0x0c, 0x85, ...u32(at('order')), //              mov [order+eax*4], ecx
                0x31, 0xc0, 0xc2, 0x04, 0x00,
            ];
            return [...main, ...new Array(WORKER_AT - main.length).fill(0x90), ...worker];
        },
    });
    const expected = [0x102, 0x102, 0x102, 0x102, 0, 1, 2, 3]
        .reduce((sum, value)=>(Math.imul(sum, 31) + value) >>> 0, 0);
    for (const cores of [1, 3])
    {
        const inGuest = await run(executable, SEMAPHORE_CALLS, { cpu: { cores, eager: true } });
        const inHost = await run(executable, SEMAPHORE_CALLS,
            { cpu: { cores, eager: true }, win32: { handleWords: false } });
        assert.equal(inHost.code, expected, `${cores} executor(s), every call in the host`);
        assert.equal(inGuest.code, expected, `${cores} executor(s), with the guest's answers`);
    }
});
