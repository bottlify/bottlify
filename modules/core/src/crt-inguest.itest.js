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

/**
 * @typedef {Object} Call
 * @property {string} name
 * @property {(at: (name: string) => number, comparator: number) => number[]} args
 *     The stack slots, first first; `comparator` the address of COMPARATOR.
 * @property {'eax' | 'st0'} returns
 * @property {number[] | ((at: (name: string) => number) => number[])} expected
 *     EAX, or the double's two halves, low first.
 */

/** @param {number} value */
const halves = value=>{
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return [view.getUint32(0, true), view.getUint32(4, true)];
};

/** @param {string} text */
const cString = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

/** Where the comparator sits in the code of a program that calls the runtime. */
const COMPARATOR_AT = 0x780;

/**
 * compare(a, b): the signed dwords at a and b, as -1, 0 or 1.
 *
 * mov eax, [esp+4]; mov eax, [eax]; mov ecx, [esp+8]; mov ecx, [ecx]; xor edx, edx;
 * cmp eax, ecx; setg dl; setl al; movzx eax, al; sub edx, eax; mov eax, edx; ret
 */
const COMPARATOR = [0x8b, 0x44, 0x24, 0x04, 0x8b, 0x00, 0x8b, 0x4c, 0x24, 0x08, 0x8b, 0x09,
    0x31, 0xd2, 0x39, 0xc8, 0x0f, 0x9f, 0xc2, 0x0f, 0x9c, 0xc0, 0x0f, 0xb6, 0xc0, 0x29, 0xc2,
    0x89, 0xd0, 0xc3];

/**
 * Calls each import in turn with ESI and EDI holding marks of the program's
 * own, then checks what came back -- EAX, or the double stored from ST0 --
 * and that the marks are still there; exits 0, or with the number of the
 * first call that answered wrong.
 *
 * @param {Call[]} calls @param {Record<string, number[]>} data
 */
function buildCallsExe(calls, data){
    const names = [...new Set(calls.map(call=>call.name))];
    return buildExe({
        imports: { 'msvcrt.dll': names, 'KERNEL32.dll': ['ExitProcess'] },
        data: { out: new Array(8).fill(0), ...data },
        codeSize: 0x800,
        code: ({ iat, at, code })=>[...assemble([
            [0xbe, ...u32(0x5e5e5e5e), 0xbf, ...u32(0xd1d1d1d1)],        // esi, edi: marks
            ...calls.flatMap((call, i)=>{
                const args = call.args(at, code(COMPARATOR_AT));
                const expected = typeof call.expected === 'function'
                    ? call.expected(at) : call.expected;
                return [
                    [0xbb, ...u32(i + 1)],                                // mov ebx, i+1
                    ...[...args].reverse().map(arg=>[0x68, ...u32(arg)]), // push each, last first
                    [0xff, 0x15, ...u32(iat(call.name))],                 // call [import]
                    [0x83, 0xc4, args.length * 4],                        // add esp, 4n
                    ...(call.returns === 'st0' ? [
                        [0xdd, 0x1d, ...u32(at('out'))],                  // fstp qword [out]
                        [0xa1, ...u32(at('out'))],                        // mov eax, [out]
                        [0x3d, ...u32(expected[0])],                      // cmp eax, low
                        { jump: [0x0f, 0x85], to: 'fail' },
                        [0xa1, ...u32(at('out') + 4)],                    // mov eax, [out+4]
                        [0x3d, ...u32(expected[1])],                      // cmp eax, high
                    ] : [
                        [0x3d, ...u32(expected[0])],                      // cmp eax, expected
                    ]),
                    { jump: [0x0f, 0x85], to: 'fail' },
                    [0x81, 0xfe, ...u32(0x5e5e5e5e)],                     // cmp esi, mark
                    { jump: [0x0f, 0x85], to: 'fail' },
                    [0x81, 0xff, ...u32(0xd1d1d1d1)],                     // cmp edi, mark
                    { jump: [0x0f, 0x85], to: 'fail' },
                ];
            }),
            [0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess'))],         // exit 0
            'fail',
            [0x53, 0xff, 0x15, ...u32(iat('ExitProcess'))],               // exit ebx
        ])].concat(new Array(COMPARATOR_AT).fill(0xcc)).slice(0, COMPARATOR_AT)
            .concat(COMPARATOR),
    });
}

/** floor, toupper and strncmp through the import, with what the handlers answered. */
function buildPrototypeExe(){
    /** @type {Call[]} */
    const calls = [];
    for (const value of [2.5, -2.5, -0.5, 1e300, -3.75, 2 ** 52 - 0.5, 0.49999999999999994])
    {
        calls.push({ name: 'floor', args: ()=>halves(value), returns: 'st0',
            expected: halves(Math.floor(value)) });
    }
    for (const [c, upper] of [[0x61, 0x41], [0x7a, 0x5a], [0x7b, 0x7b], [0x41, 0x41],
        [0xe9, 0xe9], [0xffffffff, 0xffffffff], [0x161, 0x161]])
    {
        calls.push({ name: 'toupper', args: ()=>[c], returns: 'eax', expected: [upper] });
    }
    for (const [left, right, count, answer] of /** @type {[string, string, number, number][]} */ ([
        ['abcX', 'abcY', 3, 0], ['abcX', 'abcY', 4, -1], ['abcY', 'abcX', 4, 1],
        ['euro', 'yen', 1, 1], ['ab', 'abc', 99, -1], ['abc', 'abd', 0, 0],
    ]))
    {
        calls.push({ name: 'strncmp', args: at=>[at(left), at(right), count], returns: 'eax',
            expected: [answer >>> 0] });
    }
    return buildCallsExe(calls, {
        abcX: cString('abcX'), abcY: cString('abcY'), ab: cString('ab'), abc: cString('abc'),
        abd: cString('abd'),
        // 0x80, the euro sign, sorts above 0xff: the order the handlers compared in.
        euro: [0x80, 0], yen: [0xa5, 0],
    });
}

/**
 * The classifiers, the case functions, the case-blind comparisons, atoi and
 * bsearch through the import, with what the handlers answered.
 */
function buildLibraryExe(){
    /** @type {Call[]} */
    const calls = [];
    /** @param {string} name @param {number[]} args @param {number} answer */
    const plain = (name, args, answer)=>calls.push({ name, args: ()=>args, returns: 'eax',
        expected: [answer >>> 0] });
    plain('tolower', [0x41], 0x61);
    plain('tolower', [0xc9], 0xc9);
    plain('isdigit', [0x37], 1);
    plain('isdigit', [0x61], 0);
    plain('isspace', [0x0b], 1);
    plain('isspace', [0xa0], 0);
    plain('isalpha', [0xffffffff], 0);
    plain('iswspace', [0xa0], 1);
    plain('iswspace', [0x3000], 0);
    plain('iswalpha', [0xe9], 1);
    plain('towupper', [0x10061], 0x41);
    /**
     * @param {string} name @param {string[]} texts @param {number[]} rest
     * @param {number} answer
     */
    const strings = (name, texts, rest, answer)=>calls.push({ name, returns: 'eax',
        args: at=>[...texts.map(text=>at(text)), ...rest], expected: [answer >>> 0] });
    strings('_strnicmp', ['HeLLo', 'hello'], [5], 0);
    strings('_strnicmp', ['abc', 'ABD'], [3], -1);
    strings('_strnicmp', ['abc', 'ABD'], [2], 0);
    strings('_stricmp', ['Zeta', 'zetA'], [], 0);
    strings('_stricmp', ['Zeta', 'zetB'], [], -1);
    strings('atoi', ['  -123x'], [], -123);
    strings('atoi', ['99999999999'], [], 0x7fffffff);
    strings('atol', ['+42'], [], 42);
    const sorted = [-7, -3, 0, 4, 4, 9, 12, 30];
    for (const [wanted, index] of [[9, 5], [-7, 0], [30, 7], [5, -1]])
    {
        calls.push({
            name: 'bsearch',
            args: (at, comparator)=>[at(`key${wanted}`), at('sorted'), sorted.length, 4,
                comparator],
            returns: 'eax',
            // The element's address, or null for a key that is not there.
            expected: at=>[index < 0 ? 0 : at('sorted') + index * 4],
        });
    }
    const data = Object.fromEntries(['HeLLo', 'hello', 'abc', 'ABD', 'Zeta', 'zetA', 'zetB',
        '  -123x', '99999999999', '+42'].map(text=>[text, cString(text)]));
    for (const wanted of [9, -7, 30, 5])
    {
        data[`key${wanted}`] = u32(wanted >>> 0);
    }
    data.sorted = sorted.flatMap(key=>u32(key >>> 0));
    return buildCallsExe(calls, data);
}

/**
 * The memory and string functions through the import: each copy, fill or
 * move read back by a comparison after it.
 */
function buildMemoryExe(){
    /** @type {Call[]} */
    const calls = [];
    /**
     * @param {string} name @param {(at: (name: string) => number) => number[]} args
     * @param {number | ((at: (name: string) => number) => number)} answer
     */
    const call = (name, args, answer)=>calls.push({ name, args, returns: 'eax',
        expected: at=>[(typeof answer === 'function' ? answer(at) : answer) >>> 0] });
    call('strlen', at=>[at('hello')], 5);
    call('strlen', at=>[at('empty')], 0);
    call('strcpy', at=>[at('buffer'), at('hello')], at=>at('buffer'));
    call('strcmp', at=>[at('buffer'), at('hello')], 0);
    call('strcmp', at=>[at('hello'), at('help')], -1);
    call('strcmp', at=>[at('euro'), at('yen')], 1);
    call('memset', at=>[at('buffer'), 0x178, 3], at=>at('buffer'));
    call('strcmp', at=>[at('buffer'), at('xxxlo')], 0);
    call('memcpy', at=>[at('buffer'), at('abcdef'), 7], at=>at('buffer'));
    call('memmove', at=>[at('buffer') + 1, at('buffer'), 4], at=>at('buffer') + 1);
    call('strcmp', at=>[at('buffer'), at('aabcdf')], 0);
    call('memmove', at=>[at('buffer'), at('buffer') + 2, 4], at=>at('buffer'));
    call('strcmp', at=>[at('buffer'), at('bcdfdf')], 0);
    call('memcmp', at=>[at('hello'), at('help'), 3], 0);
    call('memcmp', at=>[at('hello'), at('help'), 4], -1);
    call('memcmp', at=>[at('euro'), at('yen'), 1], -1);
    return buildCallsExe(calls, {
        hello: cString('hello'), help: cString('help'), empty: [0], xxxlo: cString('xxxlo'),
        abcdef: cString('abcdef'), aabcdf: cString('aabcdf'), bcdfdf: cString('bcdfdf'),
        buffer: new Array(16).fill(0),
        // strcmp orders 0x80 after 0xa5, as the handlers did; memcmp, as bytes.
        euro: [0x80, 0], yen: [0xa5, 0],
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

    test(`floor, toupper and strncmp answer through the import, in the guest, under ${engine}`,
        { timeout: 60000 }, async()=>{
            assert.equal(await exitCodeOf(buildPrototypeExe(), engine), 0,
                'the number of the first call that came back wrong');
        });

    test(`the classifiers, the case-blind comparisons, atoi and bsearch, in the guest, under `
        + `${engine}`, { timeout: 60000 }, async()=>{
        assert.equal(await exitCodeOf(buildLibraryExe(), engine), 0,
            'the number of the first call that came back wrong');
    });

    test(`the memory and string functions, in the guest, under ${engine}`, { timeout: 60000 },
        async()=>{
            assert.equal(await exitCodeOf(buildMemoryExe(), engine), 0,
                'the number of the first call that came back wrong');
        });

    test(`qsort sorts through the program's comparator, in the guest, under ${engine}`,
        { timeout: 60000 }, async()=>{
            assert.equal(await exitCodeOf(buildSortExe(200, 4), engine), 0, 'two hundred keys');
            assert.equal(await exitCodeOf(buildSortExe(60, 12), engine), 0,
                'sixty records of twelve bytes, each moved whole');
        });
}
