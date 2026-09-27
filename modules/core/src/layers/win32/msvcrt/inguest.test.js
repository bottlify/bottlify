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
import assert from 'node:assert/strict';
import { COMPILED } from './inguest.x86.js';
import * as sources from './inguest.js';
import { createConversionFunctions } from './convert.js';
import { decodeAnsi } from '../kernel32/locale.js';
import {
    CALLBACK, DATA, DATA_END, doubleWords, equivalence, random,
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
    // Letters, the terminator, and the upper half, whose bytes compare as unsigned chars.
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

test('atoi: white space, signs, digits, the wrap past 32 bits, and what is not a number', ()=>{
    const next = random(8);
    const texts = ['', '0', '-0', '+0', '42', '  42', '\t\n\v\f\r 42', '+', '-', '- 5', '+-5',
        '007', '12abc', '2147483647', '2147483648', '-2147483648', '-2147483649',
        '99999999999999999999', '-99999999999999999999', '214748364', '2147483646', '21474836470',
        ' 42', '\u008542', 'x42', '4\u00002', '4294967296', '-4294967297',
        '4294967295', '12345678901234567890123'];
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

test('memmove and memcpy: apart, overlapping either way, onto themselves, and nothing', ()=>{
    const next = random(10);
    for (let i = 0; i < 200; i++)
    {
        const bytes = Array.from({ length: 256 }, ()=>next() & 0xff);
        const source = DATA + next() % 96;
        const destination = DATA + [next() % 96, source - DATA, source - DATA + 1,
            source - DATA - 1, source - DATA + 2, source - DATA - 3, source - DATA + 4][next() % 7];
        const count = [0, 1, 2, 3, 5, 7, 64, next() % 128][next() % 8];
        same('memmove', { stack: [destination, source, count], memory: [[DATA, bytes]] });
    }
});

test('memset: a byte from the low bits of the value, over counts from none up', ()=>{
    const next = random(11);
    for (let i = 0; i < 100; i++)
    {
        const count = [0, 1, 3, 100, next() % 300][i % 5];
        same('memset', { stack: [DATA + next() % 64, next(), count] });
    }
});

test('memcmp: unsigned bytes, the first difference, and a count of none', ()=>{
    const next = random(12);
    for (let i = 0; i < 200; i++)
    {
        const a = Array.from({ length: 32 }, ()=>(next() % 4 === 0 ? 0x80 + next() % 0x80 : 0x41));
        const b = next() % 3 === 0 ? [...a] : a.map(byte=>(next() % 16 === 0 ? next() & 0xff
            : byte));
        same('memcmp', { stack: [DATA, DATA + 0x100, [0, 1, 16, 32, next() % 33][i % 5]],
            memory: [[DATA, a], [DATA + 0x100, b]] });
    }
});

test('strlen, strcpy and strcmp: empty strings, long ones, overlap, the upper half', ()=>{
    const next = random(13);
    const alphabet = [0x41, 0x61, 0x7f, 0x80, 0x9f, 0xa0, 0xff, 0x20];
    for (let i = 0; i < 150; i++)
    {
        const a = Array.from({ length: [0, 1, 5, 40, 200][i % 5] + next() % 3 },
            ()=>alphabet[next() % alphabet.length]);
        const b = next() % 3 === 0 ? [...a] : Array.from({ length: next() % 12 },
            ()=>alphabet[next() % alphabet.length]);
        const memory = /** @type {[number, number[]][]} */ ([[DATA, [...a, 0]],
            [DATA + 0x400, [...b, 0]]]);
        same('strlen', { stack: [DATA], memory });
        same('strcmp', { stack: [DATA, DATA + 0x400], memory });
        const destination = DATA + [0x800, 1, 3, 0x400][next() % 4];
        same('strcpy', { stack: [destination, DATA], memory });
    }
});

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

/**
 * The host's handler, as a multibyte function's case sees it: an answer no
 * guest code gives, and the memory untouched, so a call answered on one side
 * and handed over on the other differs.
 */
const HANDED = { host: ()=>0x5a5a5a5a };

/**
 * ASCII -- letters of both cases, the bytes beside them, a space -- and
 * the bytes past 0x7f a double-byte page leads or trails with.
 *
 * @param {() => number} next
 */
const multiBytes = next=>(/** @type {number} */ length, high = 4)=>Array.from({ length },
    ()=>(next() % 16 < high
        ? [0x80, 0x81, 0x9f, 0xb0, 0xe0, 0xff][next() % 6]
        : [0x41, 0x42, 0x5a, 0x61, 0x62, 0x7a, 0x40, 0x5b, 0x20, 0x31][next() % 10]));

test('the multibyte family answers a string of ASCII itself, and hands the host the calls '
    + 'with a byte past it', ()=>{
    const next = random(22);
    const text = multiBytes(next);
    for (let i = 0; i < 120; i++)
    {
        const ascii = i % 3 === 0;
        /**
         * @param {string} name
         * @param {import('../../../../scripts/guest-code/equivalence.mjs').Case} input
         */
        const check = (name, input)=>{
            const { handedOver } = same(name, input, HANDED);
            assert.ok(!ascii || !handedOver, `${name} answers ASCII itself`);
        };
        const a = [...text(next() % 20, ascii ? 0 : 4), 0];
        const b = next() % 3 === 0 ? [...a] : [...text(next() % 20, ascii ? 0 : 4), 0];
        const memory = /** @type {[number, number[]][]} */ ([[DATA + 0x10, a],
            [DATA + 0x80, b]]);
        for (const name of ['_mbslen', '_mbclen', '_mbsinc', '_mbslwr', '_mbsupr'])
        {
            check(name, { stack: [DATA + 0x10], memory });
        }
        for (const name of ['_mbscmp', '_mbsicmp', '_mbsstr'])
        {
            check(name, { stack: [DATA + 0x10, DATA + 0x80], memory });
        }
        for (const count of [0, 1, 3, a.length, 0xffffffff])
        {
            check('_mbsncmp', { stack: [DATA + 0x10, DATA + 0x80, count], memory });
            check('_mbsnicmp', { stack: [DATA + 0x10, DATA + 0x80, count], memory });
        }
        for (const c of [0, 0x41, 0x61, 0x7f, 0x80, 0xb0, 0x8140, a[next() % a.length]])
        {
            // A character past 0x7f is the host's however plain the string.
            for (const name of ['_mbschr', '_mbsrchr'])
            {
                if (c > 0x7f)
                {
                    same(name, { stack: [DATA + 0x10, c], memory }, HANDED);
                }
                else
                {
                    check(name, { stack: [DATA + 0x10, c], memory });
                }
            }
        }
        for (const [start, at] of [[0x10, 0x10], [0x10, 0x11], [0x10, 0x12],
            [0x10, 0x10 + a.length - 1], [0x11, 0x10]])
        {
            check('_mbsdec', { stack: [DATA + start, DATA + at], memory });
        }
        for (const count of [0, 1, 2, a.length - 1, a.length + 4])
        {
            check('_mbsncpy', { stack: [DATA + 0x100, DATA + 0x10, count], memory });
            check('_mbsncpy', { stack: [DATA + 0x12, DATA + 0x10, count], memory });
            check('_mbsncpy', { stack: [DATA + 0x10, DATA + 0x12, count], memory });
        }
    }
    for (const c of [0, 0x41, 0x7f, 0x80, 0x81, 0xff, 0x1234b0, 0x123420, 0xffffffff])
    {
        same('_ismbblead', { stack: [c] }, HANDED);
    }
    for (const [destination, source] of [[0, DATA], [DATA, 0], [0, 0]])
    {
        same('_mbsncpy', { stack: [destination, source, 1], memory: [[DATA, [0x41, 0]]] },
            HANDED);
        same('_mbsncpy', { stack: [destination, source, 0], memory: [[DATA, [0x41, 0]]] },
            HANDED);
    }
});
