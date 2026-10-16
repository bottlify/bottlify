/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The two xinput1_4 functions a program takes by number.
 *
 * XInputGetStateEx and XInputGetCapabilitiesEx are undocumented, and a
 * program reaches them with GetProcAddress on ordinal 100 and 108 -- the
 * numbers xinput1_4.spec gives them. The library is synthesised with the
 * numbers its layer declares, so a number this engine picked for itself would
 * hand the program some other function or nothing at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {string} text */
const ansi = text=>[...new TextEncoder().encode(text), 0];

const ERROR_DEVICE_NOT_CONNECTED = 1167;

/**
 * Exits 0 when both ordinals answer the address the name does, and the
 * function behind 100 answers as XInputGetStateEx does with no pad; 1
 * otherwise.
 */
function buildOrdinalsExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['LoadLibraryA', 'GetProcAddress', 'ExitProcess'] },
        data: {
            library: ansi('xinput1_4.dll'),
            stateEx: ansi('XInputGetStateEx'),
            capabilitiesEx: ansi('XInputGetCapabilitiesEx'),
            state: new Array(16).fill(0),
        },
        codeSize: 0x100,
        code: ({ iat, at })=>{
            /** @type {number[]} */
            const body = [];
            /** @type {number[]} */
            const toFail = [];
            /** A short jump to the failure exit, placed once its offset is known. */
            const jump = (/** @type {number} */ opcode)=>{
                body.push(opcode, 0);
                toFail.push(body.length - 1);
            };
            /** Both lookups of one function, which must agree. */
            const sameBothWays = (/** @type {number} */ ordinal, /** @type {string} */ name)=>{
                body.push(
                    0x6a, ordinal, //                     push ordinal
                    0x53, //                              push ebx
                    0xff, 0x15, ...u32(iat('GetProcAddress')), // call [GetProcAddress]
                    0x85, 0xc0); //                       test eax, eax
                jump(0x74); //                            jz fail
                body.push(
                    0x89, 0xc6, //                        mov esi, eax
                    0x68, ...u32(at(name)), //            push name
                    0x53, //                              push ebx
                    0xff, 0x15, ...u32(iat('GetProcAddress')), // call [GetProcAddress]
                    0x39, 0xf0); //                       cmp eax, esi
                jump(0x75); //                            jne fail
            };

            body.push(
                0x68, ...u32(at('library')), //           push "xinput1_4.dll"
                0xff, 0x15, ...u32(iat('LoadLibraryA')), // call [LoadLibraryA]
                0x85, 0xc0); //                           test eax, eax
            jump(0x74); //                                jz fail
            body.push(0x89, 0xc3); //                     mov ebx, eax

            sameBothWays(100, 'stateEx');
            body.push(
                0x68, ...u32(at('state')), //             push &state
                0x6a, 0x00, //                            push 0
                0xff, 0xd6, //                            call esi
                0x3d, ...u32(ERROR_DEVICE_NOT_CONNECTED)); // cmp eax, 1167
            jump(0x75); //                                jne fail

            sameBothWays(108, 'capabilitiesEx');
            body.push(
                0x6a, 0x00, //                            push 0
                0xff, 0x15, ...u32(iat('ExitProcess'))); // call [ExitProcess]

            const fail = body.length;
            for (const offset of toFail)
            {
                body[offset] = fail - (offset + 1);
            }
            return [
                ...body,
                0x6a, 0x01, //                            fail: push 1
                0xff, 0x15, ...u32(iat('ExitProcess')), // call [ExitProcess]
            ];
        },
    });
}

test('xinput1_4 answers ordinals 100 and 108 with the functions its .spec gives them',
    { timeout: 60000 }, async t=>{
        const app = await createApp({
            executable: buildOrdinalsExe(),
            imagePath: 'C:\\App\\Pad.exe',
        });
        t.after(()=>app.dispose());
        const code = await app.run({ timeoutMs: 30000 });
        assert.equal(code, 0, 'each number reached the function of that name');
    });
