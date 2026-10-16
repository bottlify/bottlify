/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An exception raised by a thread other than the first is dispatched along
 * that thread's own frame chain, whichever executor the thread runs on: a
 * program that names its threads the Visual C++ way -- RaiseException of
 * 0x406D1388 inside its own handler -- goes on past the raise on every one.
 *
 * The worker puts a frame handler on its chain, raises 0x406D1388, and counts
 * the instruction after the raise; the handler counts itself and answers
 * ExceptionContinueExecution. Exit: the handler's count, and the worker's
 * past the raise times 16 -- 0x11 when each happened once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const WORKER_AT = 0x80;
const HANDLER_AT = 0xc0;

function buildProgram(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'RaiseException',
            'ExitProcess'] },
        codeSize: 0x100,
        data: { calls: u32(0), after: u32(0), info: new Array(16).fill(0) },
        code: ({ iat, at, code })=>{
            const main = [
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, //       no id, flags, parameter
                0x68, ...u32(code(WORKER_AT)), //            the worker
                0x6a, 0x00, 0x6a, 0x00, //                   default stack, no attributes
                0xff, 0x15, ...u32(iat('CreateThread')),
                0x6a, 0xff, 0x50, //                         INFINITE, the thread
                0xff, 0x15, ...u32(iat('WaitForSingleObject')),
                0xa1, ...u32(at('after')), //                mov eax, [after]
                0xc1, 0xe0, 0x04, //                         shl eax, 4
                0x0b, 0x05, ...u32(at('calls')), //          or eax, [calls]
                0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
            const worker = [
                0x68, ...u32(code(HANDLER_AT)), //           push handler
                0x64, 0xff, 0x35, ...u32(0), //              push fs:[0]
                0x64, 0x89, 0x25, ...u32(0), //              mov fs:[0], esp
                0x68, ...u32(at('info')), 0x6a, 0x04, 0x6a, 0x00, // the name's record, 4 words
                0x68, ...u32(0x406d1388),
                0xff, 0x15, ...u32(iat('RaiseException')),
                0xff, 0x05, ...u32(at('after')), //          inc dword [after]
                0x8b, 0x04, 0x24, //                         mov eax, [esp]
                0x64, 0xa3, ...u32(0), //                    mov fs:[0], eax
                0x83, 0xc4, 0x08, //                         add esp, 8
                0x31, 0xc0, 0xc2, 0x04, 0x00, //             xor eax, eax; ret 4
            ];
            const handler = [
                0xff, 0x05, ...u32(at('calls')), //          inc dword [calls]
                0x31, 0xc0, 0xc3, //                         ExceptionContinueExecution
            ];
            return [...main, ...new Array(WORKER_AT - main.length).fill(0xcc),
                ...worker, ...new Array(HANDLER_AT - WORKER_AT - worker.length).fill(0xcc),
                ...handler];
        },
    });
}

test('a second thread\'s exception reaches its own handler on one executor and on three',
    { timeout: 60_000 }, async()=>{
        for (const executors of [1, 3])
        {
            const app = await createApp({ executable: buildProgram(),
                cpu: { cores: executors, eager: true } });
            try
            {
                assert.equal(await app.run({ timeoutMs: 30_000 }), 0x11,
                    `${executors} executor(s)`);
            }
            finally
            {
                await app.dispose();
            }
        }
    });

const SPINNER_AT = 0xa0;
const SPIN_HANDLER_AT = 0xd0;

/**
 * The first thread raises while a second one runs: the context its handler
 * continued from is the first thread's to take back, whichever thread is on
 * a processor when the dispatch is done. The second thread spins until told
 * to stop, calling the host as it goes, and the handler sleeps: so on several
 * executors the second thread's calls are answered while the dispatch is
 * still under way. Exit: whether
 * the raiser's stack pointer came back as it left (16), and the handler's
 * count -- 0x11.
 */
function buildRaiserBesideSpinner(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'RaiseException',
            'ExitProcess', 'Sleep', 'GetCurrentThreadId'] },
        codeSize: 0x100,
        data: { calls: u32(0), saved: u32(0), same: u32(0), stop: u32(0), spins: u32(0),
            handle: u32(0), info: new Array(16).fill(0) },
        code: ({ iat, at, code })=>{
            const main = [
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                0x68, ...u32(code(SPINNER_AT)),
                0x6a, 0x00, 0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateThread')),
                0xa3, ...u32(at('handle')), //               mov [handle], eax
                0x68, ...u32(code(SPIN_HANDLER_AT)), //      push handler
                0x64, 0xff, 0x35, ...u32(0), //              push fs:[0]
                0x64, 0x89, 0x25, ...u32(0), //              mov fs:[0], esp
                0x89, 0x25, ...u32(at('saved')), //          mov [saved], esp
                0x68, ...u32(at('info')), 0x6a, 0x04, 0x6a, 0x00,
                0x68, ...u32(0x406d1388),
                0xff, 0x15, ...u32(iat('RaiseException')),
                0x31, 0xc9, //                               xor ecx, ecx
                0x3b, 0x25, ...u32(at('saved')), //          cmp esp, [saved]
                0x0f, 0x94, 0xc1, //                         sete cl
                0x89, 0x0d, ...u32(at('same')), //           mov [same], ecx
                0x8b, 0x04, 0x24, //                         mov eax, [esp]
                0x64, 0xa3, ...u32(0), //                    mov fs:[0], eax
                0x83, 0xc4, 0x08, //                         add esp, 8
                0xc7, 0x05, ...u32(at('stop')), ...u32(1), // mov dword [stop], 1
                0x6a, 0xff, 0xff, 0x35, ...u32(at('handle')),
                0xff, 0x15, ...u32(iat('WaitForSingleObject')),
                0xa1, ...u32(at('same')), //                 mov eax, [same]
                0xc1, 0xe0, 0x04, //                         shl eax, 4
                0x0b, 0x05, ...u32(at('calls')), //          or eax, [calls]
                0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
            const spinner = [
                0xff, 0x05, ...u32(at('spins')), //          inc dword [spins]
                0xff, 0x15, ...u32(iat('GetCurrentThreadId')),
                0x83, 0x3d, ...u32(at('stop')), 0x00, //     cmp dword [stop], 0
                0x74, 0xeb, //                               je back to the inc
                0x31, 0xc0, 0xc2, 0x04, 0x00, //             xor eax, eax; ret 4
            ];
            const handler = [
                0xff, 0x05, ...u32(at('calls')), //          inc dword [calls]
                0x6a, 0x01, 0xff, 0x15, ...u32(iat('Sleep')),
                0x31, 0xc0, 0xc3, //                         ExceptionContinueExecution
            ];
            if (main.length > SPINNER_AT)
            {
                throw new Error(`the first thread's code is ${main.length} bytes`);
            }
            return [...main, ...new Array(SPINNER_AT - main.length).fill(0xcc),
                ...spinner, ...new Array(SPIN_HANDLER_AT - SPINNER_AT - spinner.length).fill(0xcc),
                ...handler];
        },
    });
}

test('a raiser continues on its own stack while another thread runs beside it',
    { timeout: 60_000 }, async()=>{
        for (const executors of [1, 3])
        {
            const app = await createApp({ executable: buildRaiserBesideSpinner(),
                cpu: { cores: executors, eager: true } });
            try
            {
                assert.equal(await app.run({ timeoutMs: 30_000 }), 0x11,
                    `${executors} executor(s)`);
            }
            finally
            {
                await app.dispose();
            }
        }
    });
