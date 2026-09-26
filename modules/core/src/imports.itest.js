/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a program gets when it calls an import nothing implements.
 *
 * The answers, in one executable: a decorated stdcall name is answered with
 * zero and its arguments popped; a name from the C runtime is answered with
 * zero and nothing popped, because its caller cleans up -- unless it is a C++
 * member, whose decorated type says thiscall and how much it pops; an
 * undecorated name from a Win32 library stops the process with a fault naming
 * the import and its caller, because no stub can return from it with the
 * stack right. The guest checks the returning ones itself -- ESP after the
 * call is the whole question -- and only reaches the last when they were
 * right.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);

/** Names no library will ever export, so the test cannot be overtaken by an implementation. */
const DECORATED = '_BottlifyNoSuchStdcall@8';
const CDECL = '__bottlify_no_such_cdecl';
const STDCALL = 'BottlifyNoSuchStdcall';
/** void Thing::Nothing(int), a thiscall member of a C runtime class: it pops four bytes. */
const MEMBER = '?Nothing@BottlifyNoSuchThing@@QAEXH@Z';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/**
 * ESP is kept in ESI across each call and compared afterwards; a mismatch or a
 * non-zero answer exits with code 1, so the fault at the end is only reached
 * when the stubs before it behaved.
 */
function buildImportsExe(){
    return buildExe({
        imports: {
            'KERNEL32.dll': [DECORATED, STDCALL, 'ExitProcess'],
            'msvcrt.dll': [CDECL, MEMBER],
        },
        codeSize: 0x80,
        code: ({ iat })=>{
            const body = [
                0x89, 0xe6, //                            mov esi, esp
                0x6a, 0x02, 0x6a, 0x01, //                push 2; push 1
                0xff, 0x15, ...u32(iat(DECORATED)), //    call [DECORATED]   (pops 8)
                0x85, 0xc0, 0x75, 0x00, //                test eax, eax; jnz fail
                0x39, 0xf4, 0x75, 0x00, //                cmp esp, esi; jne fail
                0x6a, 0x03, //                            push 3
                0xff, 0x15, ...u32(iat(CDECL)), //        call [CDECL]       (pops nothing)
                0x83, 0xc4, 0x04, //                      add esp, 4
                0x85, 0xc0, 0x75, 0x00, //                test eax, eax; jnz fail
                0x39, 0xf4, 0x75, 0x00, //                cmp esp, esi; jne fail
                0xb9, ...u32(0x1234), //                  mov ecx, this
                0x6a, 0x04, //                            push 4
                0xff, 0x15, ...u32(iat(MEMBER)), //       call [MEMBER]      (pops 4)
                0x85, 0xc0, 0x75, 0x00, //                test eax, eax; jnz fail
                0x39, 0xf4, 0x75, 0x00, //                cmp esp, esi; jne fail
                0x6a, 0x22, 0x6a, 0x11, //                push 0x22; push 0x11
                0xff, 0x15, ...u32(iat(STDCALL)), //      call [STDCALL]     (faults)
            ];
            const fail = body.length;
            // Every `jnz fail` above is a two-byte short jump whose displacement
            // is from the byte after it.
            for (let at = 0; at + 1 < body.length; at++)
            {
                if (body[at] === 0x75 && body[at + 1] === 0x00)
                {
                    body[at + 1] = fail - (at + 2);
                }
            }
            return [
                ...body,
                0x6a, 0x01, //                            fail: push 1
                0xff, 0x15, ...u32(iat('ExitProcess')), // call [ExitProcess]
            ];
        },
    });
}

/** @param {import('node:test').TestContext} t */
async function startApp(t){
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const app = await createApp({
        executable: buildImportsExe(),
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
    });
    t.after(()=>app.dispose());
    return app;
}

test('every import nothing claims is reported at load, before anything runs',
    { timeout: 15000 }, async t=>{
        const app = await startApp(t);
        assert.deepEqual(app.image.unresolved, [
            `KERNEL32.dll!${DECORATED}`, `KERNEL32.dll!${STDCALL}`, `msvcrt.dll!${CDECL}`,
            `msvcrt.dll!${MEMBER}`,
        ]);
    });

test('a decorated and a cdecl stub answer zero, stack intact; a stdcall one stops',
    { timeout: 15000 }, async t=>{
        const app = await startApp(t);
        /** @type {string[]} */
        const called = [];
        app.on('unimplemented', (/** @type {any} */ e)=>called.push(`${e.origin}:${e.import}`));

        await assert.rejects(app.run({ timeoutMs: 8000 }), (/** @type {any} */ e)=>{
            assert.equal(e.reason, 'guest-fault', e.message);
            assert.match(e.message, new RegExp(
                `^unimplemented import KERNEL32\\.dll!${STDCALL}, called from 0x004010[0-9a-f]{2}`
            + ' image\\+0x000010[0-9a-f]{2} \\(rva 0x000010[0-9a-f]{2}\\);'
            + ' argument bytes unknown, the stack holds 0x00000011 0x00000022 '));
            assert.match(e.traceText, /^at 0x004010[0-9a-f]{2} image\+/, 'the report is at the caller');
            return true;
        });
        // The two that returned were reached and answered; the guest's own checks
        // passed, or the run would have ended in ExitProcess(1) instead of here.
        assert.deepEqual(called, [
            `system:KERNEL32.dll!${DECORATED}`,
            `system:msvcrt.dll!${CDECL}`,
            `system:msvcrt.dll!${MEMBER}`,
            `system:KERNEL32.dll!${STDCALL}`,
        ]);
    });
