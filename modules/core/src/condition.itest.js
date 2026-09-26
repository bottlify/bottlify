/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A sleep on a condition variable, run as the guest runs it: the wait is the
 * host's, and taking the lock back afterwards is a few guest instructions
 * calling the lock's own acquire. The fixture sleeps with a timeout nobody
 * wakes it before, on an SRW lock and then on a critical section, and checks
 * one property per bit of its exit code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const IMPORTS = [
    'InitializeSRWLock', 'AcquireSRWLockExclusive', 'ReleaseSRWLockExclusive',
    'TryAcquireSRWLockExclusive', 'TryAcquireSRWLockShared', 'ReleaseSRWLockShared',
    'InitializeConditionVariable', 'SleepConditionVariableSRW', 'SleepConditionVariableCS',
    'InitializeCriticalSection', 'EnterCriticalSection', 'LeaveCriticalSection', 'ExitProcess',
];

/**
 * Exit code bits: the SRW sleep answered FALSE (1), the lock was held again
 * after it (2), and free once released (4); the critical-section sleep
 * answered FALSE (8), and the section was held again, once (16).
 */
function buildConditionExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': IMPORTS },
        data: { lock: [0, 0, 0, 0], variable: [0, 0, 0, 0], section: new Array(24).fill(0) },
        codeSize: 0x100,
        code: ({ iat, at })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** @param {string} name */
            const push = name=>[0x68, ...u32(at(name))];
            /** @param {number} bit */
            const setIfZero = bit=>[0x85, 0xc0, 0x75, 0x03, 0x80, 0xcb, bit];
            return [
                0x31, 0xdb, //                              xor ebx, ebx
                ...push('lock'), ...call('InitializeSRWLock'),
                ...push('variable'), ...call('InitializeConditionVariable'),
                ...push('lock'), ...call('AcquireSRWLockExclusive'),
                0x6a, 0x00, 0x6a, 0x0a, //                  push 0; push 10
                ...push('lock'), ...push('variable'), ...call('SleepConditionVariableSRW'),
                ...setIfZero(1),
                ...push('lock'), ...call('TryAcquireSRWLockExclusive'),
                0x84, 0xc0, 0x75, 0x03, 0x80, 0xcb, 2, //   test al, al; jnz; or bl, 2
                ...push('lock'), ...call('ReleaseSRWLockExclusive'),
                ...push('lock'), ...call('TryAcquireSRWLockShared'),
                0x84, 0xc0, 0x74, 0x03, 0x80, 0xcb, 4, //   test al, al; jz; or bl, 4
                ...push('lock'), ...call('ReleaseSRWLockShared'),
                ...push('section'), ...call('InitializeCriticalSection'),
                ...push('section'), ...call('EnterCriticalSection'),
                0x6a, 0x0a, //                              push 10
                ...push('section'), ...push('variable'), ...call('SleepConditionVariableCS'),
                ...setIfZero(8),
                0xa1, ...u32(at('section') + 8), //         mov eax, [RecursionCount]
                0x83, 0xf8, 0x01, 0x75, 0x03, 0x80, 0xcb, 16, // cmp eax, 1; jne; or bl, 16
                ...push('section'), ...call('LeaveCriticalSection'),
                0x53, //                                    push ebx
                ...call('ExitProcess'),
            ];
        },
    });
}

/**
 * Runs InitOnceExecuteOnce twice with a guest function that counts its calls
 * and leaves a context. Exit code bits: both answered TRUE (1, 2), the
 * function ran once (4), the context came back (8), and the INIT_ONCE holds it
 * above the done state (16).
 */
function buildOnceExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['InitOnceExecuteOnce', 'ExitProcess'] },
        data: { once: [0, 0, 0, 0], context: [0, 0, 0, 0], calls: [0, 0, 0, 0] },
        codeSize: 0x100,
        code: ({ iat, at, code })=>{
            /** @param {number} callback */
            const execute = callback=>[
                0x68, ...u32(at('context')), //            push &context
                0x68, ...u32(0x1234), //                   push parameter
                0x68, ...u32(callback), //                 push callback
                0x68, ...u32(at('once')), //               push &once
                0xff, 0x15, ...u32(iat('InitOnceExecuteOnce')),
            ];
            /** @param {string} name @param {number} value @param {number} bit */
            const expect = (name, value, bit)=>[
                0xa1, ...u32(at(name)), //                 mov eax, [name]
                0x3d, ...u32(value), //                    cmp eax, value
                0x75, 0x03, 0x80, 0xcb, bit, //            jne; or bl, bit
            ];
            /** @param {number} callback */
            const main = callback=>[
                0x31, 0xdb, //                             xor ebx, ebx
                ...execute(callback),
                0x85, 0xc0, 0x74, 0x03, 0x80, 0xcb, 1, //  test eax, eax; jz; or bl, 1
                ...execute(callback),
                0x85, 0xc0, 0x74, 0x03, 0x80, 0xcb, 2,
                ...expect('calls', 1, 4),
                ...expect('context', 0x50, 8),
                ...expect('once', 0x52, 16),
                0x53, //                                   push ebx
                0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
            const callback = [
                0xff, 0x05, ...u32(at('calls')), //        inc dword [calls]
                0x8b, 0x44, 0x24, 0x0c, //                 mov eax, [esp+12]   Context
                0xc7, 0x00, ...u32(0x50), //               mov dword [eax], 0x50
                0xb8, ...u32(1), //                        mov eax, 1
                0xc2, 0x0c, 0x00, //                       ret 12
            ];
            return [...main(code(main(0).length)), ...callback];
        },
    });
}

test('InitOnceExecuteOnce runs the program\'s function once and hands back its context',
    { timeout: 30000 }, async t=>{
        const wasm = await readFile(new URL('v86.wasm', PREBUILT));
        const app = await createApp({
            executable: buildOnceExe(),
            v86: {
                moduleUrl: new URL('libv86.mjs', PREBUILT).href,
                wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
            },
        });
        t.after(()=>app.dispose());

        assert.equal(await app.run({ timeoutMs: 20000 }), 1 | 2 | 4 | 8 | 16);
    });

test('a timed sleep on a condition variable answers FALSE and holds the lock again',
    { timeout: 30000 }, async t=>{
        const wasm = await readFile(new URL('v86.wasm', PREBUILT));
        const app = await createApp({
            executable: buildConditionExe(),
            v86: {
                moduleUrl: new URL('libv86.mjs', PREBUILT).href,
                wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
            },
        });
        t.after(()=>app.dispose());

        assert.equal(await app.run({ timeoutMs: 20000 }), 1 | 2 | 4 | 8 | 16);
    });
