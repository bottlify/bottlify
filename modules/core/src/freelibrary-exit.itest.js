/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * FreeLibraryAndExitThread from a worker whose library has a DllMain: the
 * detach runs on the worker, and only then does the worker end -- the worker,
 * and with the code it named, whichever thread holds the processor when the
 * detach is done. The main thread spins on the worker's exit code meanwhile
 * rather than waiting, so that it is runnable, and at times the thread on the
 * processor, when the detach finishes; and it goes on to the next round.
 *
 * More rounds than the stack pool holds stacks, one worker alive at a time:
 * a worker that ends this way ends itself and gives its stack back, so the
 * next one always has a stack to be made on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { assemble, buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** Where the worker starts, into the program's code. */
const WORKER_AT = 0x100;
const CODE_SIZE = 0x140;
/** Past the pool's 64 one-megabyte stacks. */
const ROUNDS = 80;
const EXIT_CODE = 42;
const STILL_ACTIVE = 259;
/** DllMain's reasons, newest in the low nibble: DLL_PROCESS_ATTACH, then DLL_PROCESS_DETACH. */
const ATTACHED_THEN_DETACHED = 0x10;

/**
 * The program, and where in its data the library writes.
 *
 * Each round clears what the library writes, starts a worker, spins on
 * GetExitCodeThread until the worker has ended, joins it, and counts the
 * round when the worker's code is the one it gave, its library heard attach
 * and then detach, the detach ran on the worker, and the library is gone.
 * The exit code is how many rounds counted; a CreateThread refused ends the
 * count there.
 *
 * The worker loads probe.dll and gives it back with FreeLibraryAndExitThread;
 * if that ever returns, the worker returns 7.
 */
function buildProgram(){
    const where = { reasons: 0, detachedOn: 0 };
    const executable = buildExe({
        imports: { 'KERNEL32.dll': ['CreateThread', 'GetExitCodeThread', 'WaitForSingleObject',
            'CloseHandle', 'GetModuleHandleA', 'LoadLibraryA', 'FreeLibraryAndExitThread',
            'ExitProcess'] },
        data: {
            name: [...'probe.dll'].map(c=>c.charCodeAt(0)).concat(0),
            reasons: u32(0), detachedOn: u32(0), id: u32(0), handle: u32(0), code: u32(0),
        },
        codeSize: CODE_SIZE,
        code: ({ iat, at, code })=>{
            where.reasons = at('reasons');
            where.detachedOn = at('detachedOn');
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** @param {string} name @param {number} value */
            const clear = (name, value)=>[0xc7, 0x05, ...u32(at(name)), ...u32(value)];
            const main = assemble([
                0x31, 0xff, //                                     xor edi, edi   rounds counted
                0xbe, ...u32(ROUNDS), //                           mov esi, ROUNDS
                { label: 'round' },
                ...clear('reasons', 0), ...clear('detachedOn', 0),
                // CreateThread(NULL, 0, worker, NULL, 0, &id)
                0x68, ...u32(at('id')), 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(code(WORKER_AT)),
                0x6a, 0x00, 0x6a, 0x00, ...call('CreateThread'),
                0xa3, ...u32(at('handle')), //                     mov [handle], eax
                0x85, 0xc0, { jump: 'jz', to: 'out' }, //          test eax, eax
                { label: 'spin' },
                0x68, ...u32(at('code')), 0xff, 0x35, ...u32(at('handle')),
                ...call('GetExitCodeThread'),
                0x81, 0x3d, ...u32(at('code')), ...u32(STILL_ACTIVE), // cmp [code], STILL_ACTIVE
                { jump: 'jz', to: 'spin' },
                0x6a, 0xff, 0xff, 0x35, ...u32(at('handle')), ...call('WaitForSingleObject'),
                0xff, 0x35, ...u32(at('handle')), ...call('CloseHandle'),
                0x83, 0x3d, ...u32(at('code')), EXIT_CODE, //      cmp dword [code], 42
                { jump: 'jnz', to: 'next' },
                0x83, 0x3d, ...u32(at('reasons')), ATTACHED_THEN_DETACHED,
                { jump: 'jnz', to: 'next' },
                0xa1, ...u32(at('detachedOn')), //                 mov eax, [detachedOn]
                0x3b, 0x05, ...u32(at('id')), //                   cmp eax, [id]
                { jump: 'jnz', to: 'next' },
                0x68, ...u32(at('name')), ...call('GetModuleHandleA'),
                0x85, 0xc0, { jump: 'jnz', to: 'next' }, //        test eax, eax
                0x47, //                                           inc edi
                { label: 'next' },
                0x4e, { jump: 'jnz', to: 'round' }, //             dec esi
                { label: 'out' },
                0x57, ...call('ExitProcess'), //                   push edi
            ]);
            if (main.length > WORKER_AT)
            {
                throw new Error(`main is ${main.length} bytes`);
            }
            const worker = [
                0x68, ...u32(at('name')), ...call('LoadLibraryA'),
                0x85, 0xc0, 0x74, 0x09, //                         test eax, eax; jz back
                0x6a, EXIT_CODE, 0x50, ...call('FreeLibraryAndExitThread'), // push 42; push eax
                0xb8, ...u32(7), //                                back: mov eax, 7
                0xc2, 0x04, 0x00, //                               ret 4
            ];
            return [...main, ...new Array(WORKER_AT - main.length).fill(0xcc), ...worker];
        },
    });
    return { executable, ...where };
}

/**
 * DllMain(hinst, reason, reserved): shifts the reasons so far up a nibble and
 * puts this one below them; on DLL_PROCESS_DETACH also notes the thread it
 * runs on. Answers TRUE.
 *
 * @param {{ reasons: number, detachedOn: number }} where  In the program's data.
 */
function buildProbe({ reasons, detachedOn }){
    return buildExe({
        dll: true,
        // No relocations, and a base in the heap's arena: each round's load
        // takes that span from the heap, and each round's unload gives it back.
        imageBase: 0x10000000,
        imports: { 'KERNEL32.dll': ['GetCurrentThreadId'] },
        code: ({ iat })=>assemble([
            0x8b, 0x44, 0x24, 0x08, //                             mov eax, [esp+8]  reason
            0x8b, 0x0d, ...u32(reasons), //                        mov ecx, [reasons]
            0xc1, 0xe1, 0x04, //                                   shl ecx, 4
            0x09, 0xc1, //                                         or ecx, eax
            0x89, 0x0d, ...u32(reasons), //                        mov [reasons], ecx
            0x85, 0xc0, { jump: 'jnz', to: 'done' }, //            test eax, eax
            0xff, 0x15, ...u32(iat('GetCurrentThreadId')),
            0xa3, ...u32(detachedOn), //                           mov [detachedOn], eax
            { label: 'done' },
            0xb8, ...u32(1), //                                    mov eax, TRUE
            0xc2, 0x0c, 0x00, //                                   ret 12
        ]),
    });
}

/**
 * The program's exit code on `cores` executors, and how many slices the
 * executors past the process's own ran.
 *
 * @param {number} cores
 */
async function run(cores){
    const { executable, ...where } = buildProgram();
    const app = await createApp({
        executable,
        imagePath: 'C:\\App\\FreeExit.exe',
        files: [{ path: 'C:\\App\\probe.dll', bytes: buildProbe(where) }],
        // Open from the start, so that on two the worker runs beside the main
        // thread from its first instruction.
        cpu: { cores, eager: true },
    });
    try
    {
        const code = await app.run({ timeoutMs: 150_000 });
        const tables = await app.diagnostics();
        const kernel = (Array.isArray(tables) ? tables : []).find(table=>table.name === 'kernel');
        return { code, elsewhere: kernel?.metrics?.executorSlices ?? 0 };
    }
    finally
    {
        await app.dispose();
    }
}

test('FreeLibraryAndExitThread detaches the library, then ends the worker that called it',
    { timeout: 150_000 }, async()=>{
        assert.equal((await run(1)).code, ROUNDS, 'one executor');
        const two = await run(2);
        assert.equal(two.code, ROUNDS, 'two executors');
        assert.ok(two.elsewhere > 0, 'two: the workers ran on the other executor');
    });
