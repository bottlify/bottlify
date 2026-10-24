/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fibers in a real program on the translator: a stack switched under the
 * guest's feet, and back.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from '../../../app.js';
import { buildExe } from '../../../../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24 & 0xff];

const FIBER_ROUTINE = 0x100;
const PARAMETER = 0x22;
const KEPT = 0x5a5a5a5a;
const BAD = 0xdead;

test('a thread made a fiber switches to a fiber it made and back, each on its own stack', async()=>{
    const executable = buildExe({
        imports: { 'KERNEL32.dll': ['ConvertThreadToFiber', 'CreateFiberEx', 'SwitchToFiber',
            'ExitProcess'] },
        codeSize: FIBER_ROUTINE + 0x40,
        data: { home: [0, 0, 0, 0], fiber: [0, 0, 0, 0], data: [0, 0, 0, 0], passed: [0, 0, 0, 0] },
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            const main = [
                0x6a, 0x00, ...call('ConvertThreadToFiber'), //  ConvertThreadToFiber(NULL)
                0xa3, ...u32(at('home')), //                      mov [home], eax
                0x68, ...u32(PARAMETER), //                       CreateFiberEx(0, 0, 0, routine,
                //                                                    PARAMETER)
                0x68, ...u32(code(FIBER_ROUTINE)),
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, ...call('CreateFiberEx'),
                0xa3, ...u32(at('fiber')), //                     mov [fiber], eax
                0xbe, ...u32(KEPT), //                            mov esi, KEPT
                0xff, 0x35, ...u32(at('fiber')), ...call('SwitchToFiber'),
                // Back on the thread's own stack, with its own ESI.
                0x81, 0xfe, ...u32(KEPT), //                      cmp esi, KEPT
                0x75, 0x0d, //                                    jne bad
                0xa1, ...u32(at('data')), //                      mov eax, [data]
                0x3b, 0x05, ...u32(at('passed')), //              cmp eax, [passed]
                0x74, 0x05, //                                    je done
                0xb8, ...u32(BAD), //                             bad: mov eax, BAD
                0x50, ...call('ExitProcess'), //                  done: push eax; ExitProcess(eax)
            ];
            // The fiber's routine: its parameter on its stack and in its
            // record, and ESI clobbered for main to find its own again.
            const routine = [
                0x8b, 0x44, 0x24, 0x04, //                        mov eax, [esp+4]
                0xa3, ...u32(at('passed')), //                    mov [passed], eax
                0x64, 0x8b, 0x0d, 0x10, 0x00, 0x00, 0x00, //      mov ecx, fs:[0x10]
                0x8b, 0x09, //                                    mov ecx, [ecx]
                0x89, 0x0d, ...u32(at('data')), //                mov [data], ecx
                0x31, 0xf6, //                                    xor esi, esi
                0xff, 0x35, ...u32(at('home')), ...call('SwitchToFiber'),
                0xeb, 0xfe, //                                    never back here: spin
            ];
            return [...main, ...new Array(FIBER_ROUTINE - main.length).fill(0x90), ...routine];
        },
    });
    const app = await createApp({ executable });
    try
    {
        const code = await app.run({ timeoutMs: 60_000 });
        assert.notEqual(code >>> 0, BAD,
            'main came back with its ESI and the fiber saw its parameter');
        assert.equal(code >>> 0, PARAMETER);
    }
    finally
    {
        await app.dispose();
    }
});
