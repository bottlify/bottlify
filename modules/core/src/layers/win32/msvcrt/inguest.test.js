/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Every `@guestCode` function of msvcrt answers the same as its x86, input by
 * input, on cork's test machine (`scripts/guest-code/equivalence.mjs` says
 * what is held equal): boundary values, and random ones from a fixed seed.
 */

import { test } from 'node:test';
import { COMPILED } from './inguest.x86.js';
import * as sources from './inguest.js';
import {
    CALLBACK, DATA, doubleWords, equivalence, random,
} from '../../../../scripts/guest-code/equivalence.mjs';

const { same } = equivalence(COMPILED, sources);

/** The control words a call is made under: the default, double, single, and two roundings. */
const CONTROLS = [0x37f, 0x27f, 0x07f, 0x77f, 0xf7f];

test('floor: the x86 rounds down as Math.floor does, under any control word', ()=>{
    const next = random(1);
    const values = [0, -0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 0.9999999999999999,
        -0.9999999999999999, 2 ** 52 - 0.5, -(2 ** 52) + 0.5, 2 ** 53, -(2 ** 53), 1e300,
        -1e300, 5e-324, -5e-324, Infinity, -Infinity, NaN, 123456.75, -123456.75];
    for (let i = 0; i < 60; i++)
    {
        const view = new DataView(new ArrayBuffer(8));
        view.setUint32(0, next(), true);
        view.setUint32(4, next(), true);
        values.push(view.getFloat64(0, true));
        values.push((next() - 2 ** 31) / 256);
    }
    for (const control of CONTROLS)
    {
        for (const value of values)
        {
            same('floor', { stack: doubleWords(value), control });
        }
    }
});

test('toupper: every byte, EOF and values past a byte', ()=>{
    const next = random(2);
    const inputs = [...Array.from({ length: 300 }, (_, i)=>i), 0xffffffff, 0x80000000,
        0x7fffffff, 0x161, 0x17a];
    for (let i = 0; i < 50; i++)
    {
        inputs.push(next());
    }
    for (const c of inputs)
    {
        same('toupper', { stack: [c] });
    }
});

test('strncmp: prefixes, counts, terminators and the upper half of the page', ()=>{
    const next = random(3);
    // Letters, the terminator, and bytes whose order in the page is not their value's.
    const alphabet = [0x41, 0x61, 0x7a, 0x7f, 0x80, 0x81, 0x9f, 0xa0, 0xe9, 0xff, 0x00];
    const left = DATA;
    const right = DATA + 0x1000;
    /** @param {number} length */
    const text = length=>Array.from({ length }, ()=>alphabet[next() % alphabet.length]);
    const pairs = [
        [[0x61, 0x62, 0x63, 0], [0x61, 0x62, 0x63, 0]],
        [[0x61, 0x62, 0], [0x61, 0x62, 0x63, 0]],
        [[0x61, 0x62, 0x63, 0], [0x61, 0x62, 0]],
        [[0x80, 0], [0xff, 0]],
        [[0xff, 0], [0x80, 0]],
        [[0x9f, 0], [0xa0, 0]],
        [[0], [0]],
        [[0], [0x41, 0]],
    ];
    for (let i = 0; i < 120; i++)
    {
        const a = text(next() % 12);
        const b = next() % 3 === 0 ? [...a] : text(next() % 12);
        if (b.length > 0 && next() % 2 === 0)
        {
            b[next() % b.length] = alphabet[next() % alphabet.length];
        }
        pairs.push([[...a, 0], [...b, 0]]);
    }
    for (const [a, b] of pairs)
    {
        for (const count of [0, 1, 2, 3, a.length, b.length, 40, 0xffffffff, next() % 16])
        {
            same('strncmp', { stack: [left, right, count], memory: [[left, a], [right, b]] });
        }
    }
});

test('_ftol: truncated into EDX:EAX, the argument popped, under any control word', ()=>{
    const values = [0, -0, 0.5, -0.5, 3.75, -3.75, 2 ** 31, -(2 ** 31) - 0.5, 2 ** 32 + 7.25,
        2 ** 40 + 0.5, -(2 ** 52) + 0.5, 2 ** 63, -(2 ** 63), 2 ** 62 * 1.5, 1e20, -1e20, NaN,
        Infinity, -Infinity, 5e-324];
    const next = random(4);
    for (let i = 0; i < 40; i++)
    {
        values.push((next() - 2 ** 31) * 2 ** (next() % 40) / 7);
    }
    for (const control of CONTROLS)
    {
        for (const value of values)
        {
            same('_ftol', { x87: [value], control });
        }
    }
});

/**
 * compare(a, b): the signed dwords at a and b, as -1, 0 or 1.
 *
 * mov eax, [esp+4]; mov eax, [eax]; mov ecx, [esp+8]; mov ecx, [ecx]; xor edx, edx;
 * cmp eax, ecx; setg dl; setl al; movzx eax, al; sub edx, eax; mov eax, edx; ret
 */
const COMPARE = [0x8b, 0x44, 0x24, 0x04, 0x8b, 0x00, 0x8b, 0x4c, 0x24, 0x08, 0x8b, 0x09,
    0x31, 0xd2, 0x39, 0xc8, 0x0f, 0x9f, 0xc2, 0x0f, 0x9c, 0xc0, 0x0f, 0xb6, 0xc0, 0x29, 0xc2,
    0x89, 0xd0, 0xc3];

/** @type {(memory: Uint8Array, fn: number, args: number[]) => number} */
const compareJs = (memory, fn, [a, b])=>{
    if (fn !== CALLBACK)
    {
        throw new Error(`called 0x${fn.toString(16)}`);
    }
    const view = new DataView(memory.buffer);
    const left = view.getInt32(a, true);
    const right = view.getInt32(b, true);
    return left < right ? -1 : left > right ? 1 : 0;
};

test('qsort: the same order, through the same comparator calls, for any width', ()=>{
    const next = random(5);
    for (const [count, width] of [[0, 4], [1, 4], [2, 4], [5, 0], [7, 1], [40, 4], [33, 12],
        [64, 8], [200, 4], [17, 6]])
    {
        const bytes = new Uint8Array(count * width + 16);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i + 4 <= bytes.length; i += 4)
        {
            // Keys with repeats and both signs.
            view.setInt32(i, (next() % 50) - 25, true);
        }
        same('qsort', { stack: [DATA, count, width, CALLBACK], memory: [[DATA, bytes]] },
            { callback: COMPARE, call: compareJs });
    }
});

/**
 * Every byte and EOF, units past a byte and past sixteen bits, and random values.
 *
 * @param {number} seed
 */
function characters(seed){
    const next = random(seed);
    const values = [...Array.from({ length: 300 }, (_, i)=>i), 0xffffffff, 0xffff, 0xfffe,
        0x10000, 0x10041, 0x100e9, 0x80000000, 0x7fffffff, 0x161, 0x17a, 0x2028, 0x3000];
    for (let i = 0; i < 40; i++)
    {
        values.push(next());
    }
    return values;
}

test('the classifiers and the case functions, narrow and wide', ()=>{
    const names = ['tolower', 'isalpha', 'isdigit', 'isalnum', 'isspace', 'isupper', 'islower',
        'ispunct', 'isxdigit', 'isprint', 'iscntrl', 'iswalpha', 'iswdigit', 'iswalnum',
        'iswspace', 'iswupper', 'iswlower', 'iswpunct', 'iswxdigit', 'iswcntrl', 'iswprint',
        'iswgraph', 'iswascii', 'towupper', 'towlower'];
    const values = characters(6);
    for (const name of names)
    {
        for (const c of values)
        {
            same(name, { stack: [c] });
        }
    }
});

test('_strnicmp and _stricmp: case folded, counts, terminators, the upper half', ()=>{
    const next = random(7);
    const alphabet = [0x41, 0x61, 0x5a, 0x7a, 0x5b, 0x60, 0x40, 0x80, 0x9f, 0xc9, 0xe9, 0xff, 0];
    const left = DATA;
    const right = DATA + 0x1000;
    /** @param {number} length */
    const text = length=>Array.from({ length }, ()=>alphabet[next() % alphabet.length]);
    /** Each ASCII letter's case flipped at random. @param {number[]} bytes */
    const recase = bytes=>bytes.map(byte=>(/[A-Za-z]/.test(String.fromCharCode(byte))
        && next() % 2 === 0 ? byte ^ 0x20 : byte));
    for (let i = 0; i < 150; i++)
    {
        const a = text(next() % 12);
        const b = next() % 2 === 0 ? recase(a) : text(next() % 12);
        const memory = /** @type {[number, number[]][]} */ ([[left, [...a, 0]],
            [right, [...b, 0]]]);
        same('_stricmp', { stack: [left, right], memory });
        for (const count of [0, 1, a.length, b.length + 1, 0xffffffff, next() % 14])
        {
            same('_strnicmp', { stack: [left, right, count], memory });
        }
    }
});

test('atoi: white space, signs, digits, the clamp at both ends, and what is not a number', ()=>{
    const next = random(8);
    const texts = ['', '0', '-0', '+0', '42', '  42', '\t\n\v\f\r 42', '+', '-', '- 5', '+-5',
        '007', '12abc', '2147483647', '2147483648', '-2147483648', '-2147483649',
        '99999999999999999999', '-99999999999999999999', '214748364', '2147483646', '21474836470',
        ' 42', '\u008542', 'x42', '4\u00002'];
    for (let i = 0; i < 80; i++)
    {
        const digits = Array.from({ length: next() % 14 }, ()=>String(next() % 10)).join('');
        const sign = ['', '-', '+'][next() % 3];
        const space = [' ', '\t', ''][next() % 3].repeat(next() % 3);
        texts.push(`${space}${sign}${digits}${next() % 2 ? 'z' : ''}`);
    }
    for (const text of texts)
    {
        const bytes = [...text].map(c=>c.charCodeAt(0) & 0xff);
        same('atoi', { stack: [DATA], memory: [[DATA, [...bytes, 0]]] });
    }
});

test('bsearch: the key found, missed, at either end, among repeats, and in nothing', ()=>{
    const next = random(9);
    for (const [count, width] of [[0, 4], [1, 4], [2, 4], [3, 8], [16, 4], [100, 4], [37, 12]])
    {
        const keys = Array.from({ length: count }, ()=>(next() % 60) - 30).sort((a, b)=>a - b);
        const bytes = new Uint8Array(count * width + 4);
        const view = new DataView(bytes.buffer);
        keys.forEach((key, i)=>view.setInt32(i * width, key, true));
        for (const wanted of [-31, -30, 0, 7, 29, 30, ...keys.slice(0, 5), next() % 60 - 30])
        {
            const key = new Uint8Array(4);
            new DataView(key.buffer).setInt32(0, wanted, true);
            same('bsearch', {
                stack: [DATA + 0x2000, DATA, count, width, CALLBACK],
                memory: [[DATA, bytes], [DATA + 0x2000, key]],
            }, { callback: COMPARE, call: compareJs });
        }
    }
});
