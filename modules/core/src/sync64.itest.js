/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One-time initialisation and condition variables in a 64-bit process,
 * through `createApp`: InitOnceExecuteOnce, SleepConditionVariableSRW and
 * SleepConditionVariableCS are guest code around host traps, and at 64 bits
 * that is their x86-64 (`slimsync.js`). The program checks each answer itself
 * and exits with the number of the first check that failed, 0 when none did.
 * A context is a pointer, eight bytes, written whole over a word of 0xff.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * x86-64 code whose RIP-relative operands are given by target, as
 * `x64-libraries.itest.js` writes it.
 *
 * @param {number} base @param {(number[] | { rip: number[], to: number })[]} parts
 */
function x64(base, parts){
    /** @type {number[]} */
    const bytes = [];
    for (const part of parts)
    {
        if (Array.isArray(part))
        {
            bytes.push(...part);
            continue;
        }
        const end = base + bytes.length + part.rip.length + 4;
        bytes.push(...part.rip, ...u32(part.to - end));
    }
    return bytes;
}

const CONTEXT = 0x1230;
const PARAMETER = 0x77;
const ERROR_TIMEOUT = 1460;
/** Where the exit is, and the program's InitFn, in the code. */
const EXIT = 0x2c0;
const INIT_FN = 0x2e0;
const RECURSION_COUNT = 12;

test('a 64-bit program initialises once and sleeps on condition variables, SRW and section',
    { timeout: 60000 }, async t=>{
        const program = buildExe({
            bits: 64, codeSize: 0x300,
            imports: { 'KERNEL32.dll': ['InitOnceExecuteOnce', 'AcquireSRWLockExclusive',
                'SleepConditionVariableSRW', 'GetLastError', 'TryAcquireSRWLockShared',
                'ReleaseSRWLockExclusive', 'InitializeCriticalSection', 'EnterCriticalSection',
                'SleepConditionVariableCS', 'LeaveCriticalSection', 'ExitProcess'] },
            data: {
                once: new Array(8).fill(0), context: new Array(8).fill(0xff),
                again: new Array(8).fill(0xff), count: new Array(8).fill(0),
                lock: new Array(8).fill(0), variable: new Array(8).fill(0),
                section: new Array(40).fill(0),
            },
            code: ({ iat, at, code })=>{
                const call = (/** @type {string} */ name)=>({ rip: [0xff, 0x15], to: iat(name) });
                const lea = (/** @type {number[]} */ op, /** @type {string} */ name)=>
                    ({ rip: op, to: at(name) });
                const RCX = [0x48, 0x8d, 0x0d];
                const RDX = [0x48, 0x8d, 0x15];
                const R9 = [0x4c, 0x8d, 0x0d];
                let checks = 0;
                /** cmp eax, expected; mov ecx, check; jne exit */
                const check = (/** @type {number} */ expected)=>[
                    [0x3d, ...u32(expected), 0xb9, ...u32(++checks)],
                    { rip: [0x0f, 0x85], to: code(EXIT) },
                ];
                /** The same of the quadword at `name`, its upper half zero. */
                const checkQuad = (/** @type {string} */ name, /** @type {number} */ expected)=>[
                    { rip: [0x48, 0x8b, 0x05], to: at(name) }, // mov rax, [name]
                    [0x48, 0x3d, ...u32(expected), 0xb9, ...u32(++checks)],
                    { rip: [0x0f, 0x85], to: code(EXIT) },
                ];
                /** @param {string} context */
                const executeOnce = context=>[
                    lea(RCX, 'once'),
                    { rip: RDX, to: code(INIT_FN) },
                    [0x41, 0xb8, ...u32(PARAMETER)], // mov r8d, PARAMETER
                    lea(R9, context),
                    call('InitOnceExecuteOnce'),
                ];
                const main = x64(code(0), [
                    [0x48, 0x83, 0xec, 0x28], // sub rsp, 40
                    ...executeOnce('context'), ...check(1),
                    ...checkQuad('context', CONTEXT),
                    ...executeOnce('again'), ...check(1),
                    ...checkQuad('again', CONTEXT),
                    { rip: [0x8b, 0x05], to: at('count') }, ...check(PARAMETER), // ran once

                    lea(RCX, 'lock'), call('AcquireSRWLockExclusive'),
                    lea(RCX, 'variable'), lea(RDX, 'lock'),
                    [0x41, 0xb8, ...u32(1), 0x45, 0x31, 0xc9], // mov r8d, 1; xor r9d, r9d
                    call('SleepConditionVariableSRW'), ...check(0),
                    call('GetLastError'), ...check(ERROR_TIMEOUT),
                    lea(RCX, 'lock'), call('TryAcquireSRWLockShared'), ...check(0), // held again
                    lea(RCX, 'lock'), call('ReleaseSRWLockExclusive'),

                    lea(RCX, 'section'), call('InitializeCriticalSection'),
                    lea(RCX, 'section'), call('EnterCriticalSection'),
                    lea(RCX, 'variable'), lea(RDX, 'section'),
                    [0x41, 0xb8, ...u32(1)], // mov r8d, 1
                    call('SleepConditionVariableCS'), ...check(0),
                    { rip: [0x8b, 0x05], to: at('section') + RECURSION_COUNT },
                    ...check(1), // entered again
                    lea(RCX, 'section'), call('LeaveCriticalSection'),
                    [0x31, 0xc9], // xor ecx, ecx
                ]);
                assert.ok(main.length <= EXIT);
                return [
                    ...main, ...new Array(EXIT - main.length).fill(0x90),
                    ...x64(code(EXIT), [call('ExitProcess')]),
                    ...new Array(INIT_FN - EXIT - 6).fill(0xcc),
                    // InitFn(InitOnce, Parameter, Context): count += Parameter;
                    // *Context = CONTEXT; TRUE
                    ...x64(code(INIT_FN), [
                        { rip: [0x01, 0x15], to: at('count') },
                        [0x49, 0xc7, 0x00, ...u32(CONTEXT)], // mov qword [r8], CONTEXT
                        [0xb8, ...u32(1), 0xc3],
                    ]),
                ];
            },
        });
        const app = await createApp({ executable: program, engine: 'cork' });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 50000 }), 0, 'every check held');
    });
