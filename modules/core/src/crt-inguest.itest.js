/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime's float-to-integer conversion is code in the guest's own msvcrt,
 * not a call out to the host: a program that casts in its hottest loops pays
 * for an instruction rather than a crossing, and gets the whole __int64 back
 * in EDX:EAX, where the host's handler set EAX alone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** Each value, and the __int64 _ftol answers for it: truncated, or the integer indefinite. */
const CASES = /** @type {[number, bigint][]} */ ([
    [-3.75, -3n],
    [2 ** 40 + 0.5, 2n ** 40n],
    [1e20, -0x8000000000000000n],
    [-0.5, 0n],
]);

/** Casts each value through the import and exits 0, or with the number of the first one wrong. */
function buildCastExe(){
    const values = new Uint8Array(CASES.length * 8);
    const expected = new Uint8Array(CASES.length * 8);
    CASES.forEach(([value, answer], i)=>{
        new DataView(values.buffer).setFloat64(i * 8, value, true);
        new DataView(expected.buffer).setBigInt64(i * 8, answer, true);
    });
    return buildExe({
        imports: { 'msvcrt.dll': ['_ftol'], 'KERNEL32.dll': ['ExitProcess'] },
        data: { values: [...values], expected: [...expected] },
        codeSize: 0xa0,
        code: ({ iat, at })=>{
            /** @type {number[]} */
            const bytes = [];
            /** @type {number[]} */
            const fails = [];
            CASES.forEach((_, i)=>{
                bytes.push(0xbb, ...u32(i + 1));                        // mov ebx, i+1
                bytes.push(0xdd, 0x05, ...u32(at('values') + i * 8));   // fld qword [value]
                bytes.push(0xff, 0x15, ...u32(iat('_ftol')));           // call [_ftol]
                bytes.push(0x3b, 0x05, ...u32(at('expected') + i * 8)); // cmp eax, [low]
                fails.push(bytes.length);
                bytes.push(0x75, 0);                                    // jne fail
                bytes.push(0x3b, 0x15, ...u32(at('expected') + i * 8 + 4)); // cmp edx, [hi]
                fails.push(bytes.length);
                bytes.push(0x75, 0);                                    // jne fail
            });
            bytes.push(0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess')));  // exit 0
            const fail = bytes.length;
            bytes.push(0x53, 0xff, 0x15, ...u32(iat('ExitProcess')));        // exit ebx
            for (const jump of fails)
            {
                bytes[jump + 1] = fail - (jump + 2);
            }
            return bytes;
        },
    });
}

/** @param {'emulator' | 'cork'} engine */
async function exitCodeOn(engine){
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const app = await createApp({
        executable: buildCastExe(),
        engine,
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
    });
    try
    {
        return await app.run({ timeoutMs: 30000 });
    }
    finally
    {
        await app.dispose();
    }
}

for (const engine of /** @type {const} */ (['cork', 'emulator']))
{
    test(`_ftol answers the whole __int64 in EDX:EAX under ${engine}`, { timeout: 60000 },
        async()=>{
            assert.equal(await exitCodeOn(engine), 0,
                'the number of the first cast that came back wrong');
        });
}
