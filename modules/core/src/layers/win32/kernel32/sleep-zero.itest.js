/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Sleep's guest code (`sleepCode`), run by the real processor: Sleep(0) with
 * the kernel's word saying no thread waits to run returns there, and every
 * other call goes to the host as it was made. Then two threads handing a
 * token back and forth, each spinning on Sleep(0) until it is its turn, on one
 * executor and on three, built with Sleep and with SleepEx(0, FALSE), which
 * only the host answers: the token's work comes out the same, and with
 * executors to spare the guest answers the spins.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import { runToHalt } from '../../cpu/internal/halt.fixture.js';
import * as cork from '../../../../../cork/src/index.js';
import { createApp } from '../../../app.js';
import { assemble, buildExe } from '../../../../../../tools/make-pe.mjs';
import { sleepCode } from './process.js';

const PROGRAM = 0x8000;
const SLEEP = 0x8200;
/** Where the routine leaves for the host: a halt, so the test can see it got there. */
const TRAP = 0x8400;
const WORD = 0x100000;
const STACK = 0x300000;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

test('Sleep(0) with no thread waiting to run returns in the guest; every other call is the'
    + ' host\'s', async()=>{
    const host = createCorkHost({
        engine: cork,
        memorySize: 64 * 1024 * 1024,
        trapPort: 0xb077,
        entryVector: 0x7000,
        initialStack: STACK,
        cork: { sliceMs: Infinity },
    });
    host.writePhysical(SLEEP, sleepCode(SLEEP, TRAP, WORD));
    host.writePhysical(TRAP, new Uint8Array([0xf4]));
    host.writePhysical(PROGRAM, new Uint8Array([0xf4]));
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    runToHalt(host, 1000);

    /**
     * Calls the routine with the kernel's word at `waiting`, from a fresh
     * stack, and says whether it answered or left for the host.
     *
     * @param {number} milliseconds @param {number} waiting
     */
    const sleep = (milliseconds, waiting)=>{
        host.writePhysical(WORD, new Uint8Array(u32(waiting)));
        const code = [0x68, ...u32(milliseconds), 0xe8, ...u32((SLEEP - (PROGRAM + 10)) | 0), 0xf4];
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

    assert.equal(sleep(0, 0), 0, 'no thread waiting: back at once');
    assert.equal(sleep(0, 1), 'host', 'a thread waiting to run is given the turn by the host');
    assert.equal(sleep(0, 7), 'host');
    assert.equal(sleep(1, 0), 'host', 'a time to sleep is the host\'s');
    assert.equal(sleep(0xffffffff, 0), 'host');
    host.stop();
});

const ROUNDS = 2000;
const WORKER_AT = 0x200;

/**
 * Two threads handing a token: the main thread's turn multiplies the count by
 * five and adds two, the worker's by three and adds one, each spinning on a
 * zero sleep -- Sleep(0), or SleepEx(0, FALSE) when `host` -- until the token
 * is its own. The program exits with the count, which only the right order of
 * turns gives.
 *
 * @param {boolean} host
 */
function tokenProgram(host){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'ExitProcess',
            'Sleep', 'SleepEx'] },
        codeSize: WORKER_AT + 0x100,
        data: { token: u32(0), count: u32(0), handle: u32(0) },
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            const zeroSleep = host ? [0x6a, 0x00, 0x6a, 0x00, ...call('SleepEx')]
                : [0x6a, 0x00, ...call('Sleep')];
            /**
             * ROUNDS turns: wait for the token to be `mine`, the count times
             * `times` plus `plus`, the token to the other.
             * @param {number} mine @param {number} times @param {number} plus
             * @returns {any[]}
             */
            const turns = (mine, times, plus)=>[
                0xbe, ...u32(ROUNDS), //                                  mov esi, ROUNDS
                { label: 'round' },
                { label: 'wait' },
                0x83, 0x3d, ...u32(at('token')), mine, //               cmp dword [token], mine
                { jump: 'jz', to: 'go' },
                ...zeroSleep,
                { jump: 'jmp', to: 'wait' },
                { label: 'go' },
                0xa1, ...u32(at('count')), //                            mov eax, [count]
                0x6b, 0xc0, times, //                                    imul eax, eax, times
                0x83, 0xc0, plus, //                                     add eax, plus
                0xa3, ...u32(at('count')), //                            mov [count], eax
                0xc7, 0x05, ...u32(at('token')), ...u32(1 - mine), //    mov dword [token], other
                0x4e, //                                                 dec esi
                { jump: 'jnz', to: 'round' },
            ];
            const main = assemble([
                // CreateThread(NULL, 0, worker, NULL, 0, NULL)
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(code(WORKER_AT)),
                0x6a, 0x00, 0x6a, 0x00, ...call('CreateThread'), 0xa3, ...u32(at('handle')),
                ...turns(0, 5, 2),
                0x6a, 0xff, 0xff, 0x35, ...u32(at('handle')), ...call('WaitForSingleObject'),
                0xff, 0x35, ...u32(at('count')), ...call('ExitProcess'),
            ]);
            const worker = assemble([...turns(1, 3, 1), 0x31, 0xc0, 0xc2, 0x04, 0x00]);
            if (main.length > WORKER_AT)
            {
                throw new Error(`main is ${main.length} bytes`);
            }
            return [...main, ...new Array(WORKER_AT - main.length).fill(0xcc), ...worker];
        },
    });
}

/** What the token's turns leave in the count. */
const expected = (()=>{
    let count = 0;
    for (let round = 0; round < ROUNDS; round++)
    {
        count = (Math.imul(count, 5) + 2) >>> 0;
        count = (Math.imul(count, 3) + 1) >>> 0;
    }
    return count;
})();

/**
 * The exit code and how many times Sleep crossed into the host.
 *
 * @param {Uint8Array} executable @param {number} cores
 */
async function run(executable, cores){
    const app = await createApp({ executable, cpu: { cores } });
    try
    {
        const code = await app.run({ timeoutMs: 300_000 });
        const tables = await app.diagnostics();
        const bridge = (Array.isArray(tables) ? tables : []).find(table=>table.name === 'bridge');
        const line = (bridge?.metrics?.byFunction ?? [])
            .find((/** @type {string} */ one)=>one.startsWith('KERNEL32.dll!Sleep '));
        return { code: code >>> 0, crossings: line ? Number(line.split(' ')[1]) : 0 };
    }
    finally
    {
        await app.dispose();
    }
}

test('two threads spinning on Sleep(0) for a token hand it alike with the guest\'s Sleep and the'
    + ' host\'s, on one executor and on three', { timeout: 300_000 }, async()=>{
    for (const cores of [1, 3])
    {
        const host = await run(tokenProgram(true), cores);
        assert.equal(host.code, expected, `${cores} executor(s), the host's SleepEx`);
        const guest = await run(tokenProgram(false), cores);
        assert.equal(guest.code, expected, `${cores} executor(s), the guest's Sleep`);
        if (cores === 1)
        {
            // Each spin finds the other thread waiting for the one executor:
            // the host gives it the turn, as before.
            assert.ok(guest.crossings >= ROUNDS, `${guest.crossings} crossings on one executor`);
        }
        else
        {
            // Each thread on an executor of its own, nothing waits to run.
            assert.ok(guest.crossings < ROUNDS / 10,
                `${guest.crossings} crossings with an executor each`);
        }
    }
});
