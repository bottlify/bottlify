/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime's float-to-integer conversion is code in the guest's own msvcrt,
 * not a call out to the host: a program that casts in its hottest loops pays
 * for an instruction rather than a crossing, and gets the whole __int64 back
 * in EDX:EAX, where the host's handler set EAX alone. And qsort calls the
 * program's comparator itself, with a `call`, where a sort on the host ran the
 * guest from the host once a comparison.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';
import { assemble } from './layers/win32/msvcrt/guest-code.js';

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

/**
 * Sorts `count` elements of `width` bytes -- a key, and for a wider element
 * the key doubled and tripled -- through qsort with a comparator of its own,
 * then exits 0 when the keys are in order, each element whole, and the keys'
 * sum what it was; 1 otherwise.
 *
 * @param {number} count @param {4 | 12} width
 */
function buildSortExe(count, width){
    const elements = new Uint8Array(count * width);
    const view = new DataView(elements.buffer);
    let sum = 0;
    for (let i = 0; i < count; i++)
    {
        const key = i * 37 % 97;   // repeats, out of order
        sum += key;
        view.setInt32(i * width, key, true);
        if (width === 12)
        {
            view.setInt32(i * width + 4, key * 2, true);
            view.setInt32(i * width + 8, key * 3, true);
        }
    }
    return buildExe({
        imports: { 'msvcrt.dll': ['qsort'], 'KERNEL32.dll': ['ExitProcess'] },
        data: { elements: [...elements] },
        codeSize: 0x120,
        code: ({ iat, at, code })=>{
            const compare = code(0x100);
            const base = at('elements');
            return [...assemble([
                [0x68, ...u32(compare), 0x6a, width],                    // push compare; push w
                [0x68, ...u32(count), 0x68, ...u32(base)],               // push n; push base
                [0xff, 0x15, ...u32(iat('qsort')), 0x83, 0xc4, 0x10],     // call [qsort]
                [0xbe, ...u32(base), 0xb9, ...u32(count - 1)],           // esi, ecx = n-1
                'order',
                [0x8b, 0x06, 0x3b, 0x46, width],                         // cmp [esi], [esi+w]
                { jump: [0x0f, 0x8f], to: 'fail' },                      // jg fail
                [0x83, 0xc6, width, 0x49],                               // add esi, w; dec ecx
                { jump: [0x75], to: 'order', short: true },
                [0xbe, ...u32(base), 0xb9, ...u32(count), 0x31, 0xd2],  // esi, ecx; edx = 0
                'whole',
                [0x8b, 0x06, 0x01, 0xc2],                                // edx += [esi]
                ...(width === 12 ? [
                    [0x01, 0xc0, 0x3b, 0x46, 0x04],                      // 2 * key = [esi+4]
                    { jump: [0x0f, 0x85], to: 'fail' },
                    [0x8b, 0x06, 0x8d, 0x04, 0x40, 0x3b, 0x46, 0x08],    // 3 * key = [esi+8]
                    { jump: [0x0f, 0x85], to: 'fail' },
                ] : []),
                [0x83, 0xc6, width, 0x49],                               // add esi, w; dec ecx
                { jump: [0x75], to: 'whole', short: true },
                [0x81, 0xfa, ...u32(sum)],                               // cmp edx, sum
                { jump: [0x0f, 0x85], to: 'fail' },
                [0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess'))],     // exit 0
                'fail',
                [0x6a, 0x01, 0xff, 0x15, ...u32(iat('ExitProcess'))],     // exit 1
            ])].concat(new Array(0x100).fill(0x90)).slice(0, 0x100).concat([
                // compare(a, b): *a - *b, the keys being small
                0x8b, 0x44, 0x24, 0x04, 0x8b, 0x00, 0x8b, 0x4c, 0x24, 0x08, 0x2b, 0x01, 0xc3,
            ]);
        },
    });
}

/** @param {Uint8Array} executable @param {'emulator' | 'cork'} engine */
async function exitCodeOf(executable, engine){
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const app = await createApp({
        executable,
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
            assert.equal(await exitCodeOf(buildCastExe(), engine), 0,
                'the number of the first cast that came back wrong');
        });

    test(`qsort sorts through the program's comparator, in the guest, under ${engine}`,
        { timeout: 60000 }, async()=>{
            assert.equal(await exitCodeOf(buildSortExe(200, 4), engine), 0, 'two hundred keys');
            assert.equal(await exitCodeOf(buildSortExe(60, 12), engine), 0,
                'sixty records of twelve bytes, each moved whole');
        });
}
