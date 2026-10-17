/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/** Part 2 of msvcrt's guest code against its x86; see `inguest.test.js`. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPILED } from './inguest.x86.js';
import * as sources from './inguest.js';
import { createConversionFunctions } from './convert.js';
import { decodeAnsi } from '../kernel32/locale.js';
import { DATA, DATA_END, doubleWords, equivalence, random } from
    '../../../../scripts/guest-code/equivalence.mjs';

const { same } = equivalence(COMPILED, sources);

/** The control words a call is made under: the default, double, single, and two roundings. */
const CONTROLS = [0x37f, 0x27f, 0x07f, 0x77f, 0xf7f];

/**
 * The handlers strtol and strtoul hand calls to -- the conversions without
 * the guest's memory, which are the handlers alone -- over a case's memory,
 * reading a string as the engine's memory does.
 */
function conversionHandlers(){
    /** @type {Uint8Array} */
    let memory = new Uint8Array(0);
    /** @type {number[]} */
    const errno = [];
    const table = /** @type {Record<string, { handler: (args: number[]) => number }>} */ (
        createConversionFunctions({
            readCString: (address, limit)=>{
                const end = memory.indexOf(0, address);
                if (end === -1 || end - address >= limit)
                {
                    throw new Error(`No NUL within ${limit} bytes`);
                }
                return decodeAnsi(memory.subarray(address, end));
            },
            writeMemory: (address, bytes)=>memory.set(bytes, address),
            allocate: ()=>{
                throw new Error('nothing here allocates');
            },
            errno: code=>void errno.push(code),
        }));
    /** @param {string} name */
    const host = name=>(/** @type {Uint8Array} */ at, /** @type {number[]} */ args)=>{
        memory = at;
        return table[name].handler(args);
    };
    return { host, errno };
}

test('strtol and strtoul: signs, prefixes, bases, the end pointer, and the host at the limits',
    ()=>{
        const next = random(14);
        const { host } = conversionHandlers();
        const texts = ['', ' ', '0', '-0', '+0', '42', '  -42', '\t\n\v\f\r 42', '+', '-', '- 5',
            '+-5', '007', '08', '0x', '0X1f', '0x1F', '-0x', '0xg', '0x0x1', '12abc', 'zz', 'Zz',
            '2147483647', '2147483648', '-2147483648', '-2147483649', '4294967295', '4294967296',
            '-4294967295', '-4294967296', '99999999999999999999', '0000000000000000000000000001',
            'ffffffff', '7fffffff', '80000000', '100000000', '0x7FFFFFFF', '0x80000000',
            '0xFFFFFFFF', '0x100000000', 'zzzzzz', 'zzzzzzz', '-1', '1z', '\u0085 42',
            '\u00a042', 'x42', '4\u00002', '11111111111111111111111111111111',
            '100000000000000000000000000000000', '37777777777', '40000000000', '1y2p0ij32e8e7',
            // One digit past the largest magnitude that takes one without carrying out.
            '4294967300', '-4294967300', '0x1000000000', '0x10000000f', '1z141z4', '1z141z5'];
        const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFXYZ .+-';
        for (let i = 0; i < 80; i++)
        {
            const digits = Array.from({ length: next() % 14 },
                ()=>alphabet[next() % alphabet.length]).join('');
            const sign = ['', '-', '+'][next() % 3];
            const prefix = ['', '', '0', '0x', '0X'][next() % 5];
            texts.push(`${' '.repeat(next() % 3)}${sign}${prefix}${digits}`);
        }
        // The prefixes' bases and ten for every text; one it takes and one it
        // leaves to the host, of each kind, by turns.
        const others = [2, 8, 36, 2 + next() % 35];
        const refused = [1, 37, 0xffffffff, 0x80000000, 100];
        for (const [i, text] of texts.entries())
        {
            const bytes = [...text].map(c=>c.charCodeAt(0) & 0xff);
            for (const base of [0, 10, 16, others[i % others.length],
                refused[i % refused.length]])
            {
                for (const name of ['strtol', 'strtoul'])
                {
                    const end = base === 10 ? 0 : DATA + 0x800;
                    /** @type {import('../../../../scripts/guest-code/equivalence.mjs').Case} */
                    const input = { stack: [DATA, end, base], memory: [[DATA, [...bytes, 0]]] };
                    const js = same(name, input, { host: host(name) });
                    // And the JavaScript answers as the handler it stands for,
                    // result and end pointer, on the host's side of it too.
                    const memory = new Uint8Array(1 << 20);
                    memory.set([...bytes, 0], DATA);
                    const eax = host(name)(memory, [DATA, end, base]) >>> 0;
                    const what = `${name}(${JSON.stringify(text)}, ${base | 0})`;
                    assert.equal(js.eax, eax, `${what}: the handler's answer`);
                    assert.deepEqual(js.data, memory.slice(DATA, DATA_END),
                        `${what}: the handler's end pointer`);
                }
            }
        }
    });

test('strtol and strtoul hand the host a value out of range and a base they do not take, '
    + 'and nothing else', ()=>{
    const { host, errno } = conversionHandlers();
    /** @type {[string, number, boolean, boolean][]} the text, the base, handed over by each */
    const cases = [
        ['2147483647', 10, false, false],
        ['2147483648', 10, true, false],
        ['-2147483648', 10, false, false],
        ['-2147483649', 0, true, false],
        ['4294967295', 10, true, false],
        ['4294967296', 10, true, true],
        ['0xffffffff', 0, true, false],
        ['0x100000000', 16, true, true],
        ['zzzzzzz', 36, true, true],
        ['12', 1, true, true],
        ['12', 37, true, true],
        ['12', -1, true, true],
        ['-1', 10, false, false],
    ];
    for (const [text, base, toHostSigned, toHostUnsigned] of cases)
    {
        const bytes = [...text].map(c=>c.charCodeAt(0));
        /** @type {import('../../../../scripts/guest-code/equivalence.mjs').Case} */
        const input = { stack: [DATA, DATA + 0x800, base >>> 0], memory: [[DATA, [...bytes, 0]]] };
        assert.equal(same('strtol', input, { host: host('strtol') }).handedOver, toHostSigned,
            `strtol("${text}", ${base})`);
        assert.equal(same('strtoul', input, { host: host('strtoul') }).handedOver,
            toHostUnsigned, `strtoul("${text}", ${base})`);
    }
    assert.ok(errno.length > 0, 'the host set errno for what it clamped');
});

test('abs: both signs, zero, and INT_MIN, which stays itself', ()=>{
    const next = random(15);
    for (const value of [0, 1, 0xffffffff, 0x7fffffff, 0x80000000, 0x80000001, 12345,
        ...Array.from({ length: 60 }, ()=>next())])
    {
        same('abs', { stack: [value] });
    }
});

test('ceil and fabs: rounded up and made positive as JavaScript does, under any control word',
    ()=>{
        const next = random(16);
        const values = [0, -0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 0.9999999999999999,
            -0.9999999999999999, 2 ** 52 - 0.5, -(2 ** 52) + 0.5, 2 ** 53, 1e300, -1e300, 5e-324,
            -5e-324, Infinity, -Infinity, NaN];
        for (let i = 0; i < 40; i++)
        {
            values.push((next() - 2 ** 31) / 256);
        }
        for (const control of CONTROLS)
        {
            for (const value of values)
            {
                same('ceil', { stack: doubleWords(value), control });
                same('fabs', { stack: doubleWords(value), control });
            }
        }
    });

/** Bytes from a small alphabet, so searches find what they look for. @param {() => number} next */
const letters = next=>(/** @type {number} */ length)=>Array.from({ length },
    ()=>[0x41, 0x42, 0x61, 0x62, 0x5a, 0x7a, 0x40, 0x5b, 0x80, 0x9f, 0xc0, 0xff][next() % 12]);

test('strchr and strrchr: the first and last of a byte, the terminator, and none', ()=>{
    const next = random(17);
    const text = letters(next);
    for (let i = 0; i < 150; i++)
    {
        const bytes = [...text(next() % 24), 0];
        for (const c of [0, 0x41, 0x61, 0xff, 0x80, 0x1241, 0xffffff61,
            bytes[next() % bytes.length]])
        {
            same('strchr', { stack: [DATA, c], memory: [[DATA, bytes]] });
            same('strrchr', { stack: [DATA, c], memory: [[DATA, bytes]] });
        }
    }
});

test('strspn, strcspn and strpbrk: spans of a set and of its complement, empty sets, high bytes',
    ()=>{
        const next = random(19);
        const text = letters(next);
        for (let i = 0; i < 200; i++)
        {
            const bytes = [...text(next() % 24), 0];
            const set = [...text(next() % 5), 0];
            const memory = /** @type {[number, number[]][]} */ ([[DATA, bytes],
                [DATA + 0x100, set]]);
            same('strspn', { stack: [DATA, DATA + 0x100], memory });
            same('strcspn', { stack: [DATA, DATA + 0x100], memory });
            same('strpbrk', { stack: [DATA, DATA + 0x100], memory });
        }
    });

test('strstr: found at the start, inside, at the end, overlapping itself, empty, and not', ()=>{
    const next = random(18);
    const text = letters(next);
    for (let i = 0; i < 200; i++)
    {
        const haystack = text(next() % 30);
        const from = next() % (haystack.length + 1);
        const needle = next() % 3 === 0 ? text(next() % 4)
            : haystack.slice(from, from + next() % 6);
        same('strstr', { stack: [DATA, DATA + 0x100],
            memory: [[DATA, [...haystack, 0]], [DATA + 0x100, [...needle, 0]]] });
    }
    for (const [haystack, needle] of [['aaab', 'aab'], ['abab', 'bab'], ['', ''], ['', 'a'],
        ['a', ''], ['abc', 'abcd'], ['abcabd', 'abd']])
    {
        same('strstr', { stack: [DATA, DATA + 0x100], memory: [[DATA,
            [...haystack].map(c=>c.charCodeAt(0)).concat(0)], [DATA + 0x100,
            [...needle].map(c=>c.charCodeAt(0)).concat(0)]] });
    }
});

test('strcat and strncpy: apart, over themselves either way, padded and cut short', ()=>{
    const next = random(19);
    const text = letters(next);
    for (let i = 0; i < 70; i++)
    {
        // The first string a little way in, so that one just below it is in the area too.
        const at = DATA + 0x10;
        const a = [...text(next() % 20), 0];
        const b = [...text(next() % 20), 0];
        const memory = /** @type {[number, number[]][]} */ ([[at, a], [at + 0x40, b]]);
        const near = at + [1, 2, 3, 4, 7, -1, -3][i % 7];
        same('strcat', { stack: [at, at + 0x40], memory });
        same('strcat', { stack: [at, near], memory });
        same('strcat', { stack: [near + 8, at], memory });
        for (const count of [0, 1, a.length - 1, a.length, a.length + 5])
        {
            same('strncpy', { stack: [at + 0x80, at, count], memory });
            same('strncpy', { stack: [near, at, count], memory });
            same('strncpy', { stack: [at, near, count], memory });
        }
    }
});

test('_strlwr and _strupr: the ASCII letters in place, and nothing else', ()=>{
    const next = random(20);
    for (let i = 0; i < 100; i++)
    {
        const bytes = [...Array.from({ length: next() % 40 }, ()=>1 + next() % 255), 0];
        same('_strlwr', { stack: [DATA], memory: [[DATA, bytes]] });
        same('_strupr', { stack: [DATA], memory: [[DATA, bytes]] });
    }
});

test('wcslen, wcscmp and wcscpy: units past a byte and past 0x7fff, and copies over themselves',
    ()=>{
        const next = random(21);
        const units = (/** @type {number} */ length)=>Array.from({ length },
            ()=>[0x41, 0x61, 0xe9, 0x100, 0x3000, 0x7fff, 0x8000, 0xffff][next() % 8]);
        const bytes = (/** @type {number[]} */ list)=>[...list, 0].flatMap(u=>[u & 0xff, u >>> 8]);
        for (let i = 0; i < 150; i++)
        {
            const a = units(next() % 16);
            const b = next() % 3 === 0 ? [...a] : units(next() % 16);
            if (b.length > 0 && next() % 2 === 0)
            {
                b[next() % b.length] = units(1)[0];
            }
            const at = DATA + 0x10;
            const memory = /** @type {[number, number[]][]} */ ([[at, bytes(a)],
                [at + 0x80, bytes(b)]]);
            same('wcslen', { stack: [at], memory });
            same('wcscmp', { stack: [at, at + 0x80], memory });
            for (const to of [at + 0x100, at + 2, at + 4, at - 2, at + 1])
            {
                same('wcscpy', { stack: [to, at], memory });
            }
        }
    });

