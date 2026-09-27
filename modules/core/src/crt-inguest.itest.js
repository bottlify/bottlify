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
import { ERANGE } from './layers/win32/msvcrt/globals.js';

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

/** A wide string's bytes, terminated. @param {string} text */
const wString = text=>[...text].flatMap(c=>[c.charCodeAt(0) & 0xff, c.charCodeAt(0) >>> 8])
    .concat(0, 0);

/**
 * abs, ceil, fabs, the searches, the concatenation and bounded copy, the case
 * changes in place and the wide length, comparison and copy through the
 * import, each change read back by a comparison.
 */
function buildMoreExe(){
    /** @type {Call[]} */
    const calls = [];
    /**
     * @param {string} name @param {(at: (name: string) => number) => number[]} args
     * @param {number | ((at: (name: string) => number) => number)} answer
     */
    const call = (name, args, answer)=>calls.push({ name, args, returns: 'eax',
        expected: at=>[(typeof answer === 'function' ? answer(at) : answer) >>> 0] });
    call('abs', ()=>[-5 >>> 0], 5);
    call('abs', ()=>[0x80000000], 0x80000000);
    call('labs', ()=>[7], 7);
    for (const [name, value, answer] of /** @type {[string, number, number][]} */ ([
        ['ceil', 2.5, 3], ['ceil', -2.5, -2], ['fabs', -3.75, 3.75], ['fabs', 0, 0]]))
    {
        calls.push({ name, args: ()=>halves(value), returns: 'st0', expected: halves(answer) });
    }
    call('strchr', at=>[at('hello'), 0x6c], at=>at('hello') + 2);
    call('strchr', at=>[at('hello'), 0x7a], 0);
    call('strchr', at=>[at('hello'), 0], at=>at('hello') + 5);
    call('strrchr', at=>[at('hello'), 0x6c], at=>at('hello') + 3);
    call('strstr', at=>[at('hello'), at('ll')], at=>at('hello') + 2);
    call('strstr', at=>[at('hello'), at('lx')], 0);
    call('strcpy', at=>[at('buffer'), at('ab')], at=>at('buffer'));
    call('strcat', at=>[at('buffer'), at('cd')], at=>at('buffer'));
    call('strcmp', at=>[at('buffer'), at('abcd')], 0);
    call('strncpy', at=>[at('buffer'), at('hello'), 3], at=>at('buffer'));
    call('strcmp', at=>[at('buffer'), at('held')], 0);
    call('strncpy', at=>[at('buffer'), at('ab'), 6], at=>at('buffer'));
    call('memcmp', at=>[at('buffer'), at('padded'), 7], 0);
    call('_strupr', at=>[at('buffer')], at=>at('buffer'));
    call('strcmp', at=>[at('buffer'), at('AB')], 0);
    call('_strlwr', at=>[at('buffer')], at=>at('buffer'));
    call('strcmp', at=>[at('buffer'), at('ab')], 0);
    call('wcslen', at=>[at('wide')], 3);
    call('wcscmp', at=>[at('wide'), at('wider')], -1);
    call('wcscmp', at=>[at('wider'), at('wide')], 1);
    call('wcscpy', at=>[at('wbuffer'), at('wide')], at=>at('wbuffer'));
    call('wcscmp', at=>[at('wbuffer'), at('wide')], 0);
    return buildCallsExe(calls, {
        hello: cString('hello'), ll: cString('ll'), lx: cString('lx'), ab: cString('ab'),
        cd: cString('cd'), abcd: cString('abcd'), held: cString('held'), AB: cString('AB'),
        // strncpy's padding, and the byte after it the copy leaves alone.
        padded: [0x61, 0x62, 0, 0, 0, 0, 0x78], buffer: [...new Array(6).fill(0), 0x78, 0],
        wide: wString('h\u00e9\u8000'), wider: wString('h\u00e9\u8001'),
        wbuffer: new Array(12).fill(0),
    });
}

/**
 * Each conversion the program below makes: the function, the text, the base,
 * the answer, how far into the text the end pointer points, errno after, and
 * whether the guest's code hands the call to the host.
 */
const CONVERSIONS = /** @type {[string, string, number, number, number, number, boolean][]} */ ([
    ['strtol', '  -123x', 10, -123, 6, 0, false],
    ['strtol', '0x1fZ', 0, 31, 4, 0, false],
    ['strtol', 'zz', 10, 0, 0, 0, false],
    ['strtol', '2147483647', 0, 0x7fffffff, 10, 0, false],
    ['strtol', '2147483648', 10, 0x7fffffff, 10, ERANGE, true],
    ['strtol', '-99999999999', 10, -0x80000000, 12, ERANGE, true],
    ['strtol', '12', 1, 0, 0, 0, true],
    ['strtoul', '-1', 10, 0xffffffff, 2, 0, false],
    ['strtoul', '4294967295', 0, 0xffffffff, 10, 0, false],
    ['strtoul', '4294967296', 10, 0xffffffff, 10, ERANGE, true],
    ['strtoul', '0777', 0, 511, 4, 0, false],
]);

/** What EBX, ESI, EDI and EBP hold across every conversion, to be found there after. */
const KEPT = { ebx: 0x42424242, esi: 0x51515151, edi: 0x7e7e7e7e, ebp: 0x3c3c3c3c };

/**
 * strtol and strtoul through the import, errno cleared through `_errno()`
 * before each and read through it after: the answer, the end pointer, errno,
 * the stack and the kept registers checked; exits 0, or with the number of
 * the first check that failed.
 */
function buildConversionExe(){
    /** @type {Record<string, number[]>} */
    const data = { end: u32(0), sp: u32(0) };
    CONVERSIONS.forEach(([, text], i)=>{
        data[`text${i}`] = cString(text);
    });
    return buildExe({
        imports: {
            'msvcrt.dll': ['strtol', 'strtoul', '_errno'],
            'KERNEL32.dll': ['ExitProcess'],
        },
        data,
        codeSize: 0x1000,
        code: ({ iat, at })=>{
            const call = (/** @type {string} */ name)=>[0xff, 0x15, ...u32(iat(name))];
            /** @type {(number[] | { check: number })[]} */
            const pieces = [];
            let check = 0;
            /** A `jne` to the exit that pushes the next check's number. */
            const failIfNot = ()=>pieces.push({ check: ++check });
            pieces.push([0xbb, ...u32(KEPT.ebx), 0xbe, ...u32(KEPT.esi),
                0xbf, ...u32(KEPT.edi), 0xbd, ...u32(KEPT.ebp)]);
            pieces.push([0x89, 0x25, ...u32(at('sp'))]);                  // mov [sp], esp
            CONVERSIONS.forEach(([name, , base, answer, stop, errno], i)=>{
                const text = at(`text${i}`);
                pieces.push(call('_errno'), [0xc7, 0x00, ...u32(0)]);     // mov dword [eax], 0
                pieces.push([0x68, ...u32(base >>> 0), 0x68, ...u32(at('end'))]);
                pieces.push([0x68, ...u32(text)], call(name), [0x83, 0xc4, 0x0c]);
                pieces.push([0x3d, ...u32(answer >>> 0)]);                // cmp eax, answer
                failIfNot();
                pieces.push([0xa1, ...u32(at('end')), 0x3d, ...u32(text + stop)]);
                failIfNot();
                pieces.push([0x3b, 0x25, ...u32(at('sp'))]);              // cmp esp, [sp]
                failIfNot();
                pieces.push([0x81, 0xfb, ...u32(KEPT.ebx)]);
                failIfNot();
                pieces.push([0x81, 0xfe, ...u32(KEPT.esi)]);
                failIfNot();
                pieces.push([0x81, 0xff, ...u32(KEPT.edi)]);
                failIfNot();
                pieces.push([0x81, 0xfd, ...u32(KEPT.ebp)]);
                failIfNot();
                pieces.push(call('_errno'), [0x81, 0x38, ...u32(errno)]); // cmp dword [eax], errno
                failIfNot();
            });
            pieces.push([0x6a, 0x00], call('ExitProcess'));
            /** @type {number[]} */
            const body = [];
            /** @type {{ from: number, check: number }[]} */
            const fixups = [];
            for (const piece of pieces)
            {
                if (Array.isArray(piece))
                {
                    body.push(...piece);
                    continue;
                }
                body.push(0x0f, 0x85, 0, 0, 0, 0);                        // jne exit
                fixups.push({ from: body.length - 4, check: piece.check });
            }
            for (const { from, check: number } of fixups)
            {
                const exit = body.length;
                body.push(0x6a, number, ...call('ExitProcess'));
                body.splice(from, 4, ...u32(exit - (from + 4)));
            }
            return body;
        },
    });
}

/** How many times the program below calls floor and writes stdout's record. */
const TURNS = 100000;

/**
 * Calls floor, then `_flsbuf('.', stdout)`, TURNS times: the runtime writes
 * stdout's record in `_iob` from the host at every turn, a variable of the
 * library whose code floor is. A write from the host moves its page on, and
 * a translation formed from a page that moved is dropped when it lands: with
 * floor on `_iob`'s page it was never translated, and ran in the interpreter
 * to the end.
 */
function buildNeighbourExe(){
    const [low, high] = halves(2.5);
    return buildExe({
        imports: { 'msvcrt.dll': ['floor', '_flsbuf', '_iob'], 'KERNEL32.dll': ['ExitProcess'] },
        codeSize: 0x80,
        code: ({ iat })=>[...assemble([
            [0xbe, ...u32(TURNS)],                                        // mov esi, TURNS
            'turn',
            [0x68, ...u32(high), 0x68, ...u32(low)],                      // push 2.5
            [0xff, 0x15, ...u32(iat('floor')), 0x83, 0xc4, 0x08],         // call [floor]
            [0xdd, 0xd8],                                                 // fstp st0
            [0xa1, ...u32(iat('_iob')), 0x83, 0xc0, 0x20, 0x50],          // push &_iob[1]
            [0x6a, 0x2e, 0xff, 0x15, ...u32(iat('_flsbuf'))],             // _flsbuf('.', ...)
            [0x83, 0xc4, 0x08, 0x4e],                                     // add esp, 8; dec esi
            { jump: [0x0f, 0x85], to: 'turn' },
            [0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess'))],
        ])],
    });
}

/**
 * Runs a program to its exit and reads, before the machine goes, the host's
 * calls by name.
 *
 * @param {Uint8Array} executable @param {'emulator' | 'cork'} engine
 */
async function runCounting(executable, engine){
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
        const code = await app.run({ timeoutMs: 30000 });
        const bridge = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'bridge');
        return {
            code,
            crossed: new Map(/** @type {[string, number][]} */ (bridge?.metrics?.hot ?? [])),
        };
    }
    finally
    {
        await app.dispose();
    }
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

test('a host write into the runtime\'s variables keeps none of its code from translation',
    { timeout: 120000 }, async()=>{
        const app = await createApp({ executable: buildNeighbourExe(), engine: 'cork' });
        try
        {
            assert.equal(await app.run({ timeoutMs: 60000 }), 0);
            const cpu = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'cpu');
            const cork = /** @type {any} */ (cpu).metrics.cork;
            assert.ok(cork.translatedShare > 0.9, `${TURNS} writes to stdout's record left `
                + `${(100 * (1 - cork.translatedShare)).toFixed(0)} % of the run untranslated, `
                + `${cork.invalidations} translations dropped`);
        }
        finally
        {
            await app.dispose();
        }
    });

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

    test(`abs, ceil, fabs, the searches, strcat, strncpy, the case changes and the wide `
        + `functions answer in the guest, under ${engine}`, { timeout: 60000 }, async()=>{
        const { code, crossed } = await runCounting(buildMoreExe(), engine);
        assert.equal(code, 0, 'the number of the first call that came back wrong');
        const inGuest = new Set(['abs', 'labs', 'ceil', 'fabs', 'strchr', 'strrchr', 'strstr',
            'strcat', 'strncpy', '_strupr', '_strlwr', 'wcslen', 'wcscmp', 'wcscpy']);
        assert.deepEqual([...crossed.keys()].filter(name=>inGuest.has(name.split('!')[1])), [],
            'none of them crossed into the host');
    });

    test(`strtol and strtoul answer in the guest, and hand the host what sets errno, under `
        + `${engine}`, { timeout: 60000 }, async()=>{
        const { code, crossed } = await runCounting(buildConversionExe(), engine);
        assert.equal(code, 0, 'the number of the first check that failed');
        for (const name of ['strtol', 'strtoul'])
        {
            const handed = CONVERSIONS.filter(([fn, , , , , , host])=>fn === name && host).length;
            assert.equal(crossed.get(`msvcrt.dll!${name}`) ?? 0, handed,
                `${name}: only the calls it hands over crossed into the host`);
        }
    });

    test(`qsort sorts through the program's comparator, in the guest, under ${engine}`,
        { timeout: 60000 }, async()=>{
            assert.equal(await exitCodeOf(buildSortExe(200, 4), engine), 0, 'two hundred keys');
            assert.equal(await exitCodeOf(buildSortExe(60, 12), engine), 0,
                'sixty records of twelve bytes, each moved whole');
        });
}
